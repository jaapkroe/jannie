package server

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestMessageTooBig(t *testing.T) {
	_, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.send(map[string]any{"t": "chat", "text": strings.Repeat("x", maxMessageBytes)})
	select {
	case _, ok := <-c.in:
		if ok {
			t.Fatal("got a message instead of a close")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connection not closed")
	}
	if err := <-c.errc; websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Errorf("close: %v", err)
	}
}

func TestMessageRate(t *testing.T) {
	_, ts, _ := newTestServer(t, func(s *Server) { s.msgRate = 20 })
	c := dial(t, ts)
	for range 30 {
		c.send(map[string]any{"t": "ping"})
	}
	pongs := 0
	for {
		m := c.next(5 * time.Second)
		if m.T == "pong" {
			pongs++
			continue
		}
		if m.T != "error" || m.Code != errLimit {
			t.Fatalf("got %s %s", m.T, m.Code)
		}
		break
	}
	if pongs < 19 || pongs >= 30 { // 20 at once, plus whatever refilled meanwhile
		t.Errorf("%d pongs before the limit", pongs)
	}
	select {
	case _, ok := <-c.in:
		if ok {
			t.Error("still open after the rate limit")
		}
	case <-time.After(5 * time.Second):
		t.Error("not closed after the rate limit")
	}
	if err := <-c.errc; websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("close: %v", err)
	}
}

func TestBadMessages(t *testing.T) {
	_, ts, _ := newTestServer(t)
	c := dial(t, ts)
	ctx := context.Background()
	c.conn.Write(ctx, websocket.MessageText, []byte("{niet json"))
	c.waitError(errInvalid)
	c.create("Piet", nil, false, false)
	for _, m := range []map[string]any{
		{"t": "vliegen"}, {"t": "play", "card": "ZZ"}, {"t": "trump", "suit": "X"}, {"t": "bid"},
		{"t": "sit", "seat": 9}, {"t": "ready"}, {"t": "rematch"},
	} {
		c.send(m)
		c.waitError(errInvalid)
	}
	c.send(map[string]any{"t": "play", "card": "JH"})
	if e := c.waitError(errInvalid); e.errMsg() != "Dat kan nu niet." {
		t.Errorf("play in the lobby: %q", e.errMsg())
	}
	c.send(map[string]any{"t": "ping"})
	c.waitType("pong")
}

func TestPerIPLimits(t *testing.T) {
	s, ts, _ := newTestServer(t, func(s *Server) { s.createMax = 3 })
	for range s.maxPerIP {
		dialIP(t, ts, "192.0.2.1")
	}
	if _, err := dialErr(ts, "192.0.2.1"); err == nil {
		t.Error("17th connection from one address accepted")
	}
	dialIP(t, ts, "192.0.2.2") // another address is fine

	c := dialIP(t, ts, "192.0.2.3")
	for range 3 {
		c.create("Piet", nil, false, false)
	}
	c.send(map[string]any{"t": "create", "name": "Piet"})
	c.waitError(errTooMany)
	// The limit is per address.
	d := dialIP(t, ts, "192.0.2.4")
	d.create("Piet", nil, false, false)
}

func TestMaxRooms(t *testing.T) {
	_, ts, _ := newTestServer(t, func(s *Server) { s.cfg.MaxRooms = 2 })
	for range 2 {
		dial(t, ts).create("Piet", nil, false, false)
	}
	c := dial(t, ts)
	c.send(map[string]any{"t": "create", "name": "Piet"})
	if e := c.waitError(errTooMany); !strings.Contains(e.errMsg(), "te veel spellen") {
		t.Errorf("msg %q", e.errMsg())
	}
}

func TestOriginCheck(t *testing.T) {
	_, ts, _ := newTestServer(t, func(s *Server) { s.cfg.AllowedOrigins = []string{"*.kroes.dev"} })
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	try := func(origin string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		if err == nil {
			c.CloseNow()
		}
		return err
	}
	if err := try("https://evil.example"); err == nil {
		t.Error("foreign origin accepted")
	}
	if err := try(ts.URL); err != nil {
		t.Errorf("same origin refused: %v", err)
	}
	if err := try("https://klaverjas.kroes.dev"); err != nil {
		t.Errorf("allowed pattern refused: %v", err)
	}
}

func TestShutdown(t *testing.T) {
	s, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1}, false, true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go s.Shutdown(ctx)
	e := c.waitError(errRestarting)
	if e.errMsg() != msgRestarting {
		t.Errorf("msg %q", e.errMsg())
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-c.in:
			if !ok {
				if err := <-c.errc; websocket.CloseStatus(err) != websocket.StatusServiceRestart {
					t.Errorf("close: %v", err)
				}
				if _, err := dialErr(ts, "198.51.100.1"); err == nil {
					t.Error("new connection accepted while shutting down")
				}
				return
			}
		case <-deadline:
			t.Fatal("connection not closed at shutdown")
		}
	}
}

func TestJanitor(t *testing.T) {
	s, ts, _ := newTestServer(t, func(s *Server) {
		s.idleTimeout = 100 * time.Millisecond
		s.overTimeout = 100 * time.Millisecond
		s.janitorEvery = 20 * time.Millisecond
	})
	rooms := func() int {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.rooms)
	}
	// A room nobody is connected to goes.
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1}, false, true)
	c.conn.CloseNow()
	waitFor(t, "idle room removed", func() bool { return rooms() == 0 })
	if n := s.players.Load(); n != 0 {
		t.Errorf("%d players counted after the room went", n)
	}

	// A finished game goes too, even with players connected; they hear so.
	d := dial(t, ts)
	d.create("Piet", map[string]any{"humans": 1, "hands": 4}, false, true)
	s.mu.Lock()
	r := s.rooms[d.code]
	s.mu.Unlock()
	call(r, func() {
		r.pending = stepNone
		r.handNo = r.opts.Hands
		r.nextHand()
	})
	d.waitEvent("gameOver")
	e := d.waitError(errUnknown)
	if !strings.Contains(e.errMsg(), "opgeruimd") {
		t.Errorf("msg %q", e.errMsg())
	}
	waitFor(t, "finished room removed", func() bool { return rooms() == 0 })
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
