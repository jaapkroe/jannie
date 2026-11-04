package scoresheet

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Limits of the service.
const (
	MaxSheets   = 5000
	MaxWatchers = 40 // connections to one sheet
	MaxConns    = 2000
	MaxPerIP    = 20
	Idle        = 7 * 24 * time.Hour // a sheet untouched this long is gone
	maxMsg      = 8 << 10
	pingEvery   = 25 * time.Second // well within any proxy's idle timeout
	sendQueue   = 16
	// burst and refill bound the messages of one connection: 20 at once,
	// one more every 200 ms.
	burst  = 20
	refill = 200 * time.Millisecond
)

var errUnknown = errors.New("Dat bericht ken ik niet.")

// Config is a service's.
type Config struct {
	Dir     string       // where sheets are kept across restarts; "": in memory only
	Origins []string     // websocket Origin patterns besides the request host
	Logger  *slog.Logger // nil: slog.Default()
	Now     func() time.Time
}

// Service holds the sheets and their connections.
type Service struct {
	cfg    Config
	log    *slog.Logger
	mu     sync.Mutex
	sheets map[string]*entry
	conns  map[*conn]bool
	perIP  map[string]int
	closed bool
	stop   chan struct{}
}

type entry struct {
	sheet Sheet
	token string // the host's: whoever holds it may change the sheet
	subs  map[*conn]bool
}

// stored is a sheet on disk, with its host's token.
type stored struct {
	Sheet
	Token string `json:"token"`
}

// New starts a service; with cfg.Dir it reads the sheets kept there.
func New(cfg Config) *Service {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Service{cfg: cfg, log: cfg.Logger, sheets: map[string]*entry{}, conns: map[*conn]bool{},
		perIP: map[string]int{}, stop: make(chan struct{})}
	s.load()
	go s.janitor()
	return s
}

// Handler is the websocket of the score sheets (mount it at /api/score).
func (s *Service) Handler() http.Handler { return http.HandlerFunc(s.serve) }

// Shutdown closes every connection; the sheets stay on disk.
func (s *Service) Shutdown(context.Context) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.stop)
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.ws.Close(websocket.StatusGoingAway, "De server wordt herstart.")
	}
}

// ---- connections ----

type conn struct {
	ws     *websocket.Conn
	ip     string
	send   chan []byte
	code   string // the sheet it watches, "" before open or new
	host   bool
	tokens float64
	last   time.Time
}

// msg is a message of a client: t says which.
type msg struct {
	T      string   `json:"t"`
	Code   string   `json:"code,omitempty"`
	Token  string   `json:"token,omitempty"`
	Limit  int      `json:"limit,omitempty"`
	Names  []string `json:"names,omitempty"`
	Index  int      `json:"i,omitempty"`
	Winner int      `json:"winner"`
	Gains  []int    `json:"gains,omitempty"`
	Passed []bool   `json:"passed,omitempty"`
	Stake  int      `json:"stake,omitempty"`
}

// out is a message to a client.
type out struct {
	T     string `json:"t"` // "sheet", "error", "pong"
	Sheet *Sheet `json:"sheet,omitempty"`
	Host  bool   `json:"host,omitempty"`  // the receiver may change the sheet
	Token string `json:"token,omitempty"` // to the host that made it: keep it to change the sheet later
	Msg   string `json:"msg,omitempty"`
}

func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Service) serve(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		http.Error(w, "De server wordt herstart.", http.StatusServiceUnavailable)
		return
	case len(s.conns) >= MaxConns || s.perIP[ip] >= MaxPerIP:
		s.mu.Unlock()
		http.Error(w, "Te veel verbindingen.", http.StatusTooManyRequests)
		return
	}
	s.perIP[ip]++
	s.mu.Unlock()
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.cfg.Origins})
	if err != nil {
		s.mu.Lock()
		s.perIP[ip]--
		s.mu.Unlock()
		return
	}
	ws.SetReadLimit(maxMsg)
	c := &conn{ws: ws, ip: ip, send: make(chan []byte, sendQueue), tokens: burst, last: s.cfg.Now()}
	s.mu.Lock()
	s.conns[c] = true
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.write(ctx, c)
	s.read(ctx, c)
	s.drop(c)
}

// drop forgets c.
func (s *Service) drop(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.conns[c] {
		return
	}
	delete(s.conns, c)
	if s.perIP[c.ip]--; s.perIP[c.ip] <= 0 {
		delete(s.perIP, c.ip)
	}
	if e := s.sheets[c.code]; e != nil {
		delete(e.subs, c)
	}
	close(c.send)
}

func (s *Service) write(ctx context.Context, c *conn) {
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	for {
		select {
		case b, ok := <-c.send:
			if !ok {
				c.ws.Close(websocket.StatusNormalClosure, "")
				return
			}
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.ws.CloseNow()
				return
			}
		case <-tick.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.ws.CloseNow()
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (s *Service) read(ctx context.Context, c *conn) {
	for {
		_, b, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		now := s.cfg.Now()
		c.tokens = min(burst, c.tokens+float64(now.Sub(c.last))/float64(refill))
		c.last = now
		if c.tokens < 1 {
			s.reply(c, out{T: "error", Msg: "Rustig aan: even wachten."})
			continue
		}
		c.tokens--
		var m msg
		if json.Unmarshal(b, &m) != nil {
			s.reply(c, out{T: "error", Msg: errUnknown.Error()})
			continue
		}
		s.handle(c, &m)
	}
}

// reply queues o to c alone; a client too slow to take it is dropped.
func (s *Service) reply(c *conn, o out) {
	b, _ := json.Marshal(o)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queue(c, b)
}

// queue sends b to c; the caller holds s.mu.
func (s *Service) queue(c *conn, b []byte) {
	if !s.conns[c] {
		return
	}
	select {
	case c.send <- b:
	default:
		c.ws.CloseNow() // too slow: it reconnects and gets the sheet anew
	}
}

func (s *Service) handle(c *conn, m *msg) {
	switch m.T {
	case "ping":
		s.reply(c, out{T: "pong"})
	case "new":
		s.create(c, m)
	case "open":
		s.open(c, m)
	default:
		s.change(c, m)
	}
}

// create makes a sheet with c as its host.
func (s *Service) create(c *conn, m *msg) {
	names, err := cleanNames(m.Names)
	if err == nil {
		err = validLimit(m.Limit)
	}
	if err != nil {
		s.reply(c, out{T: "error", Msg: err.Error()})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sheets) >= MaxSheets {
		b, _ := json.Marshal(out{T: "error", Msg: "Er worden nu te veel scorelijsten bijgehouden. Probeer het later nog eens."})
		s.queue(c, b)
		return
	}
	code := s.newCode()
	e := &entry{sheet: Sheet{Code: code, Limit: m.Limit, Names: names, Rounds: []Round{}, Version: 1, Updated: s.cfg.Now().UTC()},
		token: newToken(), subs: map[*conn]bool{}}
	s.sheets[code] = e
	s.watch(c, e, true)
	s.save(e)
	b, _ := json.Marshal(out{T: "sheet", Sheet: &e.sheet, Host: true, Token: e.token})
	s.queue(c, b)
	s.log.Info("score sheet made", "code", code, "players", len(names))
}

// open lets c watch the sheet of m.Code; with its token, as the host.
func (s *Service) open(c *conn, m *msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.sheets[strings.ToUpper(strings.TrimSpace(m.Code))]
	if e == nil {
		b, _ := json.Marshal(out{T: "error", Msg: "Die scorelijst bestaat niet (meer)."})
		s.queue(c, b)
		return
	}
	if len(e.subs) >= MaxWatchers && !e.subs[c] {
		b, _ := json.Marshal(out{T: "error", Msg: "Er kijken al te veel mensen mee."})
		s.queue(c, b)
		return
	}
	host := m.Token != "" && m.Token == e.token
	s.watch(c, e, host)
	b, _ := json.Marshal(out{T: "sheet", Sheet: &e.sheet, Host: host})
	s.queue(c, b)
}

// watch moves c to sheet e; the caller holds s.mu.
func (s *Service) watch(c *conn, e *entry, host bool) {
	if old := s.sheets[c.code]; old != nil {
		delete(old.subs, c)
	}
	c.code, c.host = e.sheet.Code, host
	e.subs[c] = true
}

// change applies a change of the host to its sheet and sends the sheet to
// everyone watching.
func (s *Service) change(c *conn, m *msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fail := func(err error) {
		b, _ := json.Marshal(out{T: "error", Msg: err.Error()})
		s.queue(c, b)
	}
	e := s.sheets[c.code]
	switch {
	case e == nil:
		fail(errors.New("Open eerst een scorelijst."))
		return
	case !c.host:
		fail(errors.New("Alleen wie de scorelijst bijhoudt, kan hem aanpassen."))
		return
	}
	next := e.sheet
	next.Names = append([]string(nil), e.sheet.Names...)
	next.Rounds = slices.Clone(e.sheet.Rounds)
	if err := next.apply(m); err != nil {
		fail(err)
		return
	}
	next.Version++
	next.Updated = s.cfg.Now().UTC()
	e.sheet = next
	s.save(e)
	b, _ := json.Marshal(out{T: "sheet", Sheet: &e.sheet})
	for w := range e.subs {
		s.queue(w, b)
	}
}

// ---- codes and tokens ----

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"

// newCode is a free code of four letters; the caller holds s.mu.
func (s *Service) newCode() string {
	for {
		b := make([]byte, 4)
		for k := range b {
			n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(codeAlphabet))))
			b[k] = codeAlphabet[n.Int64()]
		}
		if code := string(b); s.sheets[code] == nil {
			return code
		}
	}
}

func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- keeping sheets ----

func (s *Service) path(code string) string { return filepath.Join(s.cfg.Dir, code+".json") }

// save writes e to disk (if kept there); the caller holds s.mu.
func (s *Service) save(e *entry) {
	if s.cfg.Dir == "" {
		return
	}
	b, _ := json.Marshal(stored{Sheet: e.sheet, Token: e.token})
	tmp := s.path(e.sheet.Code) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		s.log.Error("score sheet not saved", "code", e.sheet.Code, "err", err.Error())
		return
	}
	if err := os.Rename(tmp, s.path(e.sheet.Code)); err != nil {
		s.log.Error("score sheet not saved", "code", e.sheet.Code, "err", err.Error())
	}
}

// load reads the sheets kept on disk, skipping and removing old ones.
func (s *Service) load() {
	if s.cfg.Dir == "" {
		return
	}
	if err := os.MkdirAll(s.cfg.Dir, 0o700); err != nil {
		s.log.Error("score sheets not kept", "dir", s.cfg.Dir, "err", err.Error())
		s.cfg.Dir = ""
		return
	}
	files, _ := filepath.Glob(filepath.Join(s.cfg.Dir, "*.json"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		var st stored
		if err != nil || json.Unmarshal(b, &st) != nil || st.Code == "" || st.Token == "" {
			continue
		}
		if s.cfg.Now().Sub(st.Updated) > Idle {
			os.Remove(f)
			continue
		}
		st.Sheet.grow()
		s.sheets[st.Code] = &entry{sheet: st.Sheet, token: st.Token, subs: map[*conn]bool{}}
	}
	if len(s.sheets) > 0 {
		s.log.Info("score sheets kept", "sheets", len(s.sheets))
	}
}

// janitor forgets sheets untouched for a week, every hour.
func (s *Service) janitor() {
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			s.expire()
		}
	}
}

func (s *Service) expire() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for code, e := range s.sheets {
		if len(e.subs) == 0 && s.cfg.Now().Sub(e.sheet.Updated) > Idle {
			delete(s.sheets, code)
			if s.cfg.Dir != "" {
				os.Remove(s.path(code))
			}
		}
	}
}
