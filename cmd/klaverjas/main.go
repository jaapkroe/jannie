// Command klaverjas is the klaverjas game server: websocket rooms at /ws
// and a health check at /api/health. In production nginx serves the
// frontend; with -static it serves web/ itself (development).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"regexp"
	"strings"
	"syscall"
	"time"

	"klaverjas/internal/server"
)

// version is set at build time: -ldflags "-X main.version=<git sha>".
var version = "dev"

type origins []string

func (o *origins) String() string     { return strings.Join(*o, ",") }
func (o *origins) Set(s string) error { *o = append(*o, s); return nil }

func main() {
	addr := flag.String("addr", "127.0.0.1:8081", "listen address")
	static := flag.String("static", "", "also serve the frontend from this directory (development)")
	fast := flag.Bool("fast", false, "scale all game delays by 0.05 (tests)")
	health := flag.Bool("healthcheck", false, "check /api/health on -addr and exit 0 (healthy) or 1")
	games := flag.String("games", "", "keep the game log (design §6) in this directory; empty keeps none")
	var allowed origins
	flag.Var(&allowed, "origin", "allowed websocket Origin host pattern besides the request host (repeatable)")
	flag.Parse()

	if *health {
		os.Exit(healthcheck(*addr))
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	if err := run(log, *addr, *static, *games, *fast, allowed); err != nil {
		log.Error("server failed", "err", err.Error())
		os.Exit(1)
	}
}

func run(log *slog.Logger, addr, static, games string, fast bool, allowed []string) error {
	game := server.New(server.Config{
		AI:             botAI{},
		Fast:           fast,
		AllowedOrigins: allowed,
		Version:        version,
		Logger:         log,
		GameLog:        games,
	})
	api := game.Handler()
	mux := http.NewServeMux()
	mux.Handle("/ws", api)
	mux.Handle("/api/", api)
	if static != "" {
		mux.Handle("/", staticHandler(static))
	} else {
		mux.Handle("/", http.NotFoundHandler())
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	log.Info("klaverjas listening", "addr", ln.Addr().String(), "version", version, "fast", fast, "static", static != "")

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	game.Shutdown(sctx)
	if err := srv.Shutdown(sctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

// healthcheck asks the running server for /api/health (the image has no curl).
func healthcheck(addr string) int {
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

// joinLink is a game link, /ABCD: it serves index.html, like nginx.
var joinLink = regexp.MustCompile(`^/[A-Za-z]{4}$`)

// csp mirrors deploy/nginx.conf, so CSP mistakes show up in development.
const csp = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
	"script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
	"object-src 'none'; form-action 'none'"

const notFoundPage = `<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Niet gevonden - Klaverjas</title><h1>Deze pagina bestaat niet</h1><p>Zoek je een spel? Een spelcode heeft vier letters, zoals /KQXB.</p><p><a href="/">Terug naar klaverjassen</a></p></html>` + "\n"

// staticHandler serves the frontend for development: no directory
// listings, join links and / as index.html, and no caching so edits show
// at once.
func staticHandler(dir string) http.Handler {
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
	root := http.Dir(dir)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cache-Control", "no-cache")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			h.Set("Allow", "GET, HEAD")
			http.Error(w, "Methode niet toegestaan", http.StatusMethodNotAllowed)
			return
		}
		name := path.Clean("/" + r.URL.Path)
		if name == "/" || joinLink.MatchString(name) {
			name = "/index.html"
		}
		f, err := root.Open(name)
		if err != nil {
			notFound(w)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			notFound(w)
			return
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), f)
	})
}

func notFound(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	fmt.Fprint(w, notFoundPage)
}
