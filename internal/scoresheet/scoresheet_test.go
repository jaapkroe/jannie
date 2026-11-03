package scoresheet

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// client is a test's connection to a service.
type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(url, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return &client{t: t, ws: ws}
}

func (c *client) send(m map[string]any) {
	c.t.Helper()
	b, _ := json.Marshal(m)
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) next() out {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Fatal(err)
	}
	var o out
	if err := json.Unmarshal(b, &o); err != nil {
		c.t.Fatal(err)
	}
	return o
}

// sheet waits for a sheet, failing on an error.
func (c *client) sheet() out {
	c.t.Helper()
	o := c.next()
	if o.T != "sheet" || o.Sheet == nil {
		c.t.Fatalf("want a sheet, got %+v", o)
	}
	return o
}

func (c *client) error() string {
	c.t.Helper()
	o := c.next()
	if o.T != "error" {
		c.t.Fatalf("want an error, got %+v", o)
	}
	return o.Msg
}

func start(t *testing.T, cfg Config) (*Service, *httptest.Server) {
	t.Helper()
	s := New(cfg)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Shutdown(context.Background()); srv.Close() })
	return s, srv
}

func TestHostAndWatcher(t *testing.T) {
	_, srv := start(t, Config{})
	host := dial(t, srv.URL)
	host.send(map[string]any{"t": "new", "limit": 10, "names": []string{" Jaap ", "Kees", "Truus"}})
	o := host.sheet()
	if !o.Host || o.Token == "" || len(o.Sheet.Code) != 4 || o.Sheet.Names[0] != "Jaap" || o.Sheet.Limit != 10 || len(o.Sheet.Rounds) != 0 {
		t.Fatalf("new: %+v", o)
	}
	code, token := o.Sheet.Code, o.Token

	watcher := dial(t, srv.URL)
	watcher.send(map[string]any{"t": "open", "code": strings.ToLower(code)})
	if w := watcher.sheet(); w.Host || w.Token != "" || w.Sheet.Code != code {
		t.Fatalf("watcher: %+v", w)
	}

	// A round: everyone watching sees it.
	host.send(map[string]any{"t": "round", "winner": 0, "gains": []int{-1, 2, 1}, "passed": []bool{false, false, true}, "stake": 2})
	for _, c := range []*client{host, watcher} {
		s := c.sheet().Sheet
		if len(s.Rounds) != 1 || s.Version != 2 || s.Points()[1] != 2 || !s.Rounds[0].Passed[2] || s.Rounds[0].Stake != 2 {
			t.Fatalf("after a round: %+v", s)
		}
	}
	// Only the host changes the sheet.
	watcher.send(map[string]any{"t": "delete", "i": 0})
	if msg := watcher.error(); msg != "Alleen wie de scorelijst bijhoudt, kan hem aanpassen." {
		t.Errorf("watcher changed: %q", msg)
	}
	// Bad rounds are refused.
	for _, bad := range []map[string]any{
		{"t": "round", "winner": 3, "gains": []int{0, 1, 1}, "passed": []bool{false, false, false}},
		{"t": "round", "winner": 0, "gains": []int{0, 1}, "passed": []bool{false, false}},
		{"t": "round", "winner": 0, "gains": []int{0, 99, 1}, "passed": []bool{false, false, false}},
		{"t": "round", "winner": 0, "gains": []int{0, 1, 1}, "passed": []bool{true, false, false}},
		{"t": "round", "winner": 0, "gains": []int{0, 1, 1}, "passed": []bool{false, false, false}, "stake": 31},
	} {
		host.send(bad)
		if msg := host.error(); msg != ErrRound.Error() {
			t.Errorf("%v: %q", bad, msg)
		}
	}
	// Edit, add a player, change the limit, delete.
	host.send(map[string]any{"t": "edit", "i": 0, "winner": 1, "gains": []int{2, 0, 1}, "passed": []bool{false, false, false}})
	if s := host.sheet().Sheet; s.Rounds[0].Winner != 1 || s.Points()[0] != 2 {
		t.Errorf("edit: %+v", s.Rounds)
	}
	watcher.sheet()
	host.send(map[string]any{"t": "names", "names": []string{"Jaap", "Kees", "Truus", "Bram"}})
	if s := host.sheet().Sheet; len(s.Names) != 4 || len(s.Rounds[0].Gains) != 4 || s.Points()[3] != 0 {
		t.Errorf("a player added: %+v", s)
	}
	watcher.sheet()
	host.send(map[string]any{"t": "names", "names": []string{"Jaap", "Kees"}})
	if msg := host.error(); msg != ErrShrink.Error() {
		t.Errorf("shrink: %q", msg)
	}
	host.send(map[string]any{"t": "limit", "limit": 15})
	if s := host.sheet().Sheet; s.Limit != 15 {
		t.Errorf("limit %d", s.Limit)
	}
	watcher.sheet()
	host.send(map[string]any{"t": "delete", "i": 0})
	if s := host.sheet().Sheet; len(s.Rounds) != 0 {
		t.Errorf("delete: %+v", s.Rounds)
	}
	watcher.sheet()
	// A new match: the rounds go, the players and the limit stay.
	host.send(map[string]any{"t": "round", "winner": 1, "gains": []int{1, 0, 1, 1}, "passed": []bool{false, false, false, false}})
	host.sheet()
	watcher.sheet()
	host.send(map[string]any{"t": "restart"})
	if s := host.sheet().Sheet; len(s.Rounds) != 0 || s.Rounds == nil || len(s.Names) != 4 || s.Limit != 15 {
		t.Errorf("restart: %+v", s)
	}
	// The host again, from another connection, with its token.
	again := dial(t, srv.URL)
	again.send(map[string]any{"t": "open", "code": code, "token": token})
	if o := again.sheet(); !o.Host {
		t.Error("the token makes the host")
	}
	// Unknown codes, names and messages.
	again.send(map[string]any{"t": "open", "code": "ZZZZ"})
	if msg := again.error(); msg != "Die scorelijst bestaat niet (meer)." {
		t.Errorf("unknown: %q", msg)
	}
	again.send(map[string]any{"t": "new", "limit": 10, "names": []string{"Jaap", "jaap"}})
	if msg := again.error(); msg != ErrNames.Error() {
		t.Errorf("names alike: %q", msg)
	}
	again.send(map[string]any{"t": "new", "limit": 10, "names": []string{"A", "B", "C", "D", "E", "F", "G", "H", "I"}})
	if msg := again.error(); msg != ErrNames.Error() {
		t.Errorf("nine players: %q", msg)
	}
	again.send(map[string]any{"t": "new", "limit": 12, "names": []string{"A", "B"}})
	if msg := again.error(); msg != ErrLimit.Error() {
		t.Errorf("limit: %q", msg)
	}
	again.send(map[string]any{"t": "dans"})
	if msg := again.error(); msg != errUnknown.Error() {
		t.Errorf("unknown message: %q", msg)
	}
	again.send(map[string]any{"t": "ping"})
	if o := again.next(); o.T != "pong" {
		t.Errorf("ping: %+v", o)
	}
}

// Sheets survive a restart in their directory; a week untouched, they go.
func TestKeptAndExpired(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	now := time.Date(2026, 11, 3, 20, 0, 0, 0, time.UTC)
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	s1, srv1 := start(t, Config{Dir: dir, Now: clock})
	host := dial(t, srv1.URL)
	host.send(map[string]any{"t": "new", "limit": 10, "names": []string{"Jaap", "Kees"}})
	o := host.sheet()
	host.send(map[string]any{"t": "round", "winner": 0, "gains": []int{0, 1}, "passed": []bool{false, false}})
	host.sheet()
	s1.Shutdown(context.Background())

	_, srv2 := start(t, Config{Dir: dir, Now: clock})
	c := dial(t, srv2.URL)
	c.send(map[string]any{"t": "open", "code": o.Sheet.Code, "token": o.Token})
	if again := c.sheet(); !again.Host || len(again.Sheet.Rounds) != 1 || again.Sheet.Points()[1] != 1 {
		t.Fatalf("after a restart: %+v", again)
	}
	c.ws.CloseNow()

	mu.Lock()
	now = now.Add(Idle + time.Hour)
	mu.Unlock()
	s3, srv3 := start(t, Config{Dir: dir, Now: clock})
	c = dial(t, srv3.URL)
	c.send(map[string]any{"t": "open", "code": o.Sheet.Code})
	if msg := c.error(); msg != "Die scorelijst bestaat niet (meer)." {
		t.Errorf("an old sheet: %q", msg)
	}
	s3.expire() // nothing left to expire, and no panic
}
