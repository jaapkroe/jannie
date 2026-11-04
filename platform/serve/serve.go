// Package serve is what the game servers' mains share (cmd/klaverjas,
// cmd/toepen): the flags, running the server and shutting it down
// gracefully, the health check the container runs, and, for development,
// the frontend (-static). One process serves one game at one address.
package serve

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"jannie/platform/server"
)

// Site is one game's site.
type Site struct {
	Game  string // the game: its directory under games/ (-static), and its name in the log ("klaverjas")
	Title string // the site's name, in the title of the 404 page ("Klaverjas")
	Verb  string // the 404 page's way back: "Terug naar klaverjassen"
	// Extras are services the site runs besides the game's table (toepen:
	// its score sheets), made from the flags when the server starts.
	Extras func(log *slog.Logger, f Flags) []Extra
}

// Extra is a service besides the table: its handler at Path (under /api/,
// which nginx passes on, websockets too), and its shutdown.
type Extra struct {
	Path     string
	Handler  http.Handler
	Shutdown func(context.Context)
}

// Flags are the command line of a game server.
type Flags struct {
	Addr        string   // listen address
	Static      string   // the repository, whose platform/web and games/<game>/web are served too (development); "": none
	Fast        bool     // scale every game delay by 0.05 (tests)
	Games       string   // the directory of the game log (design §6); "": none
	Origins     []string // websocket Origin patterns besides the request host
	Healthcheck bool     // check /api/health on Addr and exit
}

type origins []string

func (o *origins) String() string     { return strings.Join(*o, ",") }
func (o *origins) Set(s string) error { *o = append(*o, s); return nil }

// Parse reads the flags of args (os.Args[1:]).
func Parse(name string, args []string) (Flags, error) {
	var f Flags
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.StringVar(&f.Addr, "addr", "127.0.0.1:8081", "listen address")
	fs.StringVar(&f.Static, "static", "", "also serve the frontend from this repository: platform/web and games/<game>/web (development)")
	fs.BoolVar(&f.Fast, "fast", false, "scale all game delays by 0.05 (tests)")
	fs.BoolVar(&f.Healthcheck, "healthcheck", false, "check /api/health on -addr and exit 0 (healthy) or 1")
	fs.StringVar(&f.Games, "games", "", "keep the game log (design §6) in this directory; empty keeps none")
	fs.Var((*origins)(&f.Origins), "origin", "allowed websocket Origin host pattern besides the request host (repeatable)")
	err := fs.Parse(args)
	return f, err
}

// Main is a game server's main: it serves game for site as the command
// line says, version being the server's (set by -ldflags), and exits.
func Main(site Site, version string, game server.Game) {
	f, err := Parse(site.Game, os.Args[1:])
	switch {
	case errors.Is(err, flag.ErrHelp):
		os.Exit(0)
	case err != nil:
		os.Exit(2)
	}
	if f.Healthcheck {
		os.Exit(Healthcheck(f.Addr))
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	if err := Run(log, site, version, game, f); err != nil {
		log.Error("server failed", "err", err.Error())
		os.Exit(1)
	}
}

// Run serves game until SIGINT or SIGTERM, then shuts down: the players
// are told the server restarts, and connections get a few seconds to
// finish.
func Run(log *slog.Logger, site Site, version string, game server.Game, f Flags) error {
	var static http.Handler
	if f.Static != "" {
		h, err := StaticHandler(f.Static, site)
		if err != nil {
			return err
		}
		static = h
	}
	srv := server.New(server.Config{
		Game:           game,
		Fast:           f.Fast,
		AllowedOrigins: f.Origins,
		Version:        version,
		Logger:         log,
		GameLog:        f.Games,
	})
	api := srv.Handler()
	mux := http.NewServeMux()
	mux.Handle("/ws", api)
	mux.Handle("/api/", api)
	var extras []Extra
	if site.Extras != nil {
		extras = site.Extras(log, f)
	}
	for _, x := range extras {
		mux.Handle(x.Path, x.Handler)
	}
	if static != nil {
		mux.Handle("/", static)
	} else {
		mux.Handle("/", http.NotFoundHandler())
	}

	hs := &http.Server{
		Addr:              f.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", f.Addr)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() { errc <- hs.Serve(ln) }()
	log.Info(site.Game+" listening", "addr", ln.Addr().String(), "version", version, "fast", f.Fast, "static", f.Static != "")

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	srv.Shutdown(sctx)
	for _, x := range extras {
		if x.Shutdown != nil {
			x.Shutdown(sctx)
		}
	}
	if err := hs.Shutdown(sctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

// Healthcheck asks the running server at addr for /api/health (the image
// has no curl): 0 when healthy, else 1.
func Healthcheck(addr string) int {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort(host, port) + "/api/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	var h struct {
		OK bool `json:"ok"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&h) != nil || !h.OK {
		fmt.Fprintln(os.Stderr, "healthcheck: unhealthy, status", resp.StatusCode)
		return 1
	}
	return 0
}
