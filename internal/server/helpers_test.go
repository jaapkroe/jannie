package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"klaverjas/internal/game"
)

// fakeAI plays the first legal card and says little.
type fakeAI struct {
	advised   atomic.Int64
	explained atomic.Int64
}

var fakePersonas = []Persona{
	{ID: "henk", Name: "Opa Henk", Emoji: "👴", Color: "#8a5a2b", Bio: "Henk.", Chattiness: 0.5, Speed: 1},
	{ID: "truus", Name: "Tante Truus", Emoji: "👵", Color: "#c2477a", Bio: "Truus.", Chattiness: 1, Speed: 1},
	{ID: "sjaak", Name: "Sjaak", Emoji: "🎲", Color: "#e07b24", Bio: "Sjaak.", Chattiness: 0.5, Speed: 0.8},
	{ID: "fatima", Name: "Fatima", Emoji: "🧠", Color: "#5b6ee1", Bio: "Fatima.", Chattiness: 0.2, Speed: 0.9},
	{ID: "kees", Name: "Kees de Visser", Emoji: "🎣", Color: "#2a8c9c", Bio: "Kees.", Chattiness: 0.5, Speed: 1},
	{ID: "ans", Name: "Juf Ans", Emoji: "👩‍🏫", Color: "#3f9b5a", Bio: "Ans.", Chattiness: 0.5, Speed: 1.2},
	{ID: "bram", Name: "Bram", Emoji: "🛹", Color: "#9b59b6", Bio: "Bram.", Chattiness: 0.7, Speed: 0.6},
	{ID: "lies", Name: "Bakker Lies", Emoji: "🥐", Color: "#c9a227", Bio: "Lies.", Chattiness: 0.4, Speed: 0.85},
}

func (*fakeAI) Personas() []Persona { return slices.Clone(fakePersonas) }

func (*fakeAI) NewBrain(id, level string, seed uint64) Brain { return fakeBrain{} }

func (a *fakeAI) Advise(v game.View) Advice {
	a.advised.Add(1)
	switch v.Phase {
	case game.PhaseTrump:
		s := firstSuit(v)
		return Advice{Suit: &s, Text: "Kies " + game.SuitNameNL(s) + "."}
	case game.PhaseBid:
		p := false
		return Advice{Play: &p, Text: "Passen."}
	}
	c := v.Legal[0]
	return Advice{Card: &c, Text: "Speel " + game.CardShortNL(c) + "."}
}

func (a *fakeAI) ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string {
	a.explained.Add(1)
	return names[t.Winner] + " wint de slag."
}

func (*fakeAI) Chat(id string, ev ChatEvent, rng *rand.Rand) string {
	switch ev.Kind {
	case "greet":
		return "Hallo allemaal!"
	case "reply":
		if strings.HasPrefix(strings.ToLower(ev.Text), "hoi") {
			return "Hoi!"
		}
	}
	return ""
}

type fakeBrain struct{}

func firstSuit(v game.View) game.Suit {
	if v.Forced && v.Turned == game.Clubs {
		return game.Diamonds
	}
	return game.Clubs
}

func (fakeBrain) ChooseTrump(v game.View) game.Suit { return firstSuit(v) }

// Bid plays with the turned jack, so both bidding paths occur.
func (fakeBrain) Bid(v game.View) bool {
	return slices.Contains(v.Hand, game.Card{Rank: game.Jack, Suit: v.Turned})
}

func (fakeBrain) Play(v game.View) game.Card { return v.Legal[0] }

// newTestServer returns a server at a very fast pace behind httptest.
func newTestServer(t *testing.T, tweak ...func(*Server)) (*Server, *httptest.Server, *fakeAI) {
	t.Helper()
	ai := &fakeAI{}
	s := New(Config{AI: ai, Fast: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s.scale = 0.005
	s.msgRate = 1000 // the test clients act at 200 times the normal pace
	for _, f := range tweak {
		f(s)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s.Shutdown(ctx)
		ts.Close()
	})
	return s, ts, ai
}

// msg is any server message as the tests see it.
type msg struct {
	T     string          `json:"t"`
	Code  string          `json:"code"`
	Seat  int             `json:"seat"`
	Token string          `json:"token"`
	Seq   int             `json:"seq"`
	Ev    json.RawMessage `json:"ev"`
	S     json.RawMessage `json:"s"`
	Msg   json.RawMessage `json:"msg"`
	Msgs  []chatMsg       `json:"msgs"`
	Text  string          `json:"text"`

	ev    map[string]any
	state *state
}

func (m *msg) evType() string {
	if m.ev == nil {
		return ""
	}
	s, _ := m.ev["type"].(string)
	return s
}

func (m *msg) errMsg() string {
	var s string
	json.Unmarshal(m.Msg, &s)
	return s
}

// tclient is a test websocket client that remembers the latest state.
type tclient struct {
	t    *testing.T
	conn *websocket.Conn
	in   chan *msg
	errc chan error

	s      *state // latest state
	seq    int
	code   string
	seat   int
	token  string
	tips   int
	chats  []chatMsg
	events []string
}

var ipCounter atomic.Int64

// dial connects with a fresh client address.
func dial(t *testing.T, ts *httptest.Server) *tclient {
	t.Helper()
	n := ipCounter.Add(1)
	return dialIP(t, ts, fmt.Sprintf("10.0.%d.%d", n/250, n%250+1))
}

func dialIP(t *testing.T, ts *httptest.Server, ip string) *tclient {
	t.Helper()
	c, err := dialErr(ts, ip)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c.t = t
	t.Cleanup(func() { c.conn.CloseNow() })
	return c
}

func dialErr(ts *httptest.Server, ip string) (*tclient, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Real-Ip": {ip}},
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	c := &tclient{conn: conn, in: make(chan *msg, 1024), errc: make(chan error, 1), seat: -1}
	go func() {
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				c.errc <- err
				close(c.in)
				return
			}
			m := &msg{}
			if err := json.Unmarshal(data, m); err != nil {
				c.errc <- fmt.Errorf("bad message %s: %w", data, err)
				close(c.in)
				return
			}
			if len(m.Ev) > 0 && string(m.Ev) != "null" {
				json.Unmarshal(m.Ev, &m.ev)
			}
			if len(m.S) > 0 {
				m.state = &state{}
				if err := json.Unmarshal(m.S, m.state); err != nil {
					c.errc <- fmt.Errorf("bad state %s: %w", m.S, err)
					close(c.in)
					return
				}
			}
			c.in <- m
		}
	}()
	return c, nil
}

func (c *tclient) send(v any) {
	c.t.Helper()
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("send %s: %v", b, err)
	}
}

// next returns the next message, keeping track of state; it fails the test
// after timeout.
func (c *tclient) next(timeout time.Duration) *msg {
	c.t.Helper()
	select {
	case m, ok := <-c.in:
		if !ok {
			c.t.Fatalf("connection closed: %v", <-c.errc)
		}
		c.track(m)
		return m
	case <-time.After(timeout):
		c.t.Fatalf("no message within %v (seat %d, phase %s)", timeout, c.seat, c.phase())
	}
	return nil
}

func (c *tclient) track(m *msg) {
	switch m.T {
	case "joined":
		c.code, c.seat, c.token = m.Code, m.Seat, m.Token
	case "update":
		if m.ev != nil && m.Seq <= c.seq {
			c.t.Errorf("seq went from %d to %d", c.seq, m.Seq)
		}
		if m.Seq < c.seq {
			c.t.Errorf("resync seq went back from %d to %d", c.seq, m.Seq)
		}
		c.seq = m.Seq
		c.s = m.state
		if e := m.evType(); e != "" {
			c.events = append(c.events, e)
		}
	case "tip":
		c.tips++
	case "chat":
		var cm chatMsg
		json.Unmarshal(m.Msg, &cm)
		c.chats = append(c.chats, cm)
	}
}

func (c *tclient) phase() string {
	if c.s == nil {
		return ""
	}
	return c.s.Phase
}

// until reads messages until pred holds and returns that message.
func (c *tclient) until(timeout time.Duration, what string, pred func(*msg) bool) *msg {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			c.t.Fatalf("timeout waiting for %s (seat %d, phase %s)", what, c.seat, c.phase())
		}
		select {
		case m, ok := <-c.in:
			if !ok {
				c.t.Fatalf("connection closed while waiting for %s: %v", what, <-c.errc)
			}
			c.track(m)
			if pred(m) {
				return m
			}
		case <-time.After(left):
			c.t.Fatalf("timeout waiting for %s (seat %d, phase %s)", what, c.seat, c.phase())
		}
	}
}

func (c *tclient) waitType(t string) *msg {
	c.t.Helper()
	return c.until(5*time.Second, "message "+t, func(m *msg) bool { return m.T == t })
}

func (c *tclient) waitError(code string) *msg {
	c.t.Helper()
	m := c.until(5*time.Second, "error "+code, func(m *msg) bool { return m.T == "error" })
	if m.Code != code {
		c.t.Fatalf("error code %q (%s), want %q", m.Code, m.errMsg(), code)
	}
	return m
}

func (c *tclient) waitEvent(ev string) *msg {
	c.t.Helper()
	return c.until(5*time.Second, "event "+ev, func(m *msg) bool { return m.T == "update" && m.evType() == ev })
}

func (c *tclient) waitState(what string, pred func(*state) bool) *state {
	c.t.Helper()
	if c.s != nil && pred(c.s) {
		return c.s
	}
	c.until(10*time.Second, what, func(m *msg) bool { return m.T == "update" && pred(m.state) })
	return c.s
}

// create makes a room and waits for the first state.
func (c *tclient) create(name string, opts map[string]any, training, start bool) {
	c.t.Helper()
	c.send(map[string]any{"t": "create", "name": name, "opts": opts, "training": training, "start": start})
	c.waitType("joined")
	c.waitType("chatlog")
	c.waitType("update")
}

// join enters a room and waits for joined, the chat log and a state.
func (c *tclient) join(code, name, token string) {
	c.t.Helper()
	c.send(map[string]any{"t": "join", "code": code, "name": name, "token": token})
	m := c.until(5*time.Second, "joined", func(m *msg) bool { return m.T == "joined" || m.T == "error" })
	if m.T == "error" {
		c.t.Fatalf("join failed: %s %s", m.Code, m.errMsg())
	}
	c.waitType("chatlog")
	c.waitType("update")
}

// myTurn reports whether the latest state awaits this client's action.
func (c *tclient) myTurn() bool {
	s := c.s
	return s != nil && s.Turn == s.You && (s.Phase == phaseTrump || s.Phase == phaseBid || s.Phase == phasePlay)
}

// actRandom makes a random legal decision on the client's turn.
func (c *tclient) actRandom(rng *rand.Rand) {
	c.t.Helper()
	s := c.s
	switch s.Phase {
	case phaseTrump:
		for {
			su := game.Suit(rng.IntN(4))
			if s.Forced && s.Turned != nil && su == *s.Turned {
				continue
			}
			c.send(map[string]any{"t": "trump", "suit": su.String()})
			return
		}
	case phaseBid:
		c.send(map[string]any{"t": "bid", "play": rng.IntN(3) == 0})
	case phasePlay:
		c.send(map[string]any{"t": "play", "card": s.Legal[rng.IntN(len(s.Legal))].String()})
	}
}
