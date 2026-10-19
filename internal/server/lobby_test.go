package server

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"klaverjas/internal/game"
)

// botSeats lists the seats holding bots.
func botSeats(s *state) []int {
	var out []int
	for i, p := range s.Players {
		if p != nil && p.Bot {
			out = append(out, i)
		}
	}
	return out
}

func TestCreateDefaults(t *testing.T) {
	_, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.create("  Piet\u0007  ", nil, false, false)
	s := c.s
	if s.Phase != phaseLobby || s.You != 0 || s.Host != 0 || s.HandNo != 0 || s.Training {
		t.Fatalf("state: phase %s you %d host %d hand %d", s.Phase, s.You, s.Host, s.HandNo)
	}
	if s.Opts != defaultOptions() {
		t.Errorf("opts %+v, want defaults", s.Opts)
	}
	if len(s.Roster) != len(fakePersonas) || s.Roster[0].ID != "henk" || s.Roster[0].Bio == "" {
		t.Errorf("roster %+v", s.Roster)
	}
	if p := s.Players[0]; p == nil || p.Name != "Piet" || p.Bot || !p.Connected {
		t.Errorf("creator %+v", p)
	}
	for i := 1; i < 4; i++ {
		if s.Players[i] != nil {
			t.Errorf("seat %d not empty: %+v", i, s.Players[i])
		}
	}
	if len(c.code) != 4 || normCode(strings.ToLower(c.code)) != c.code || len(c.token) != 32 {
		t.Errorf("code %q token %q", c.code, c.token)
	}
}

func TestPrefillBots(t *testing.T) {
	_, ts, _ := newTestServer(t)
	for humans, want := range map[int][]int{1: {1, 2, 3}, 2: {1, 3}, 3: {3}, 4: nil} {
		c := dial(t, ts)
		c.create("Host", map[string]any{"humans": humans}, false, false)
		if got := botSeats(c.s); !slices.Equal(got, want) {
			t.Errorf("humans %d: bots at %v, want %v", humans, got, want)
		}
		ids := map[string]bool{}
		for _, i := range want {
			ids[c.s.Players[i].BotID] = true
		}
		if len(ids) != len(want) {
			t.Errorf("humans %d: bots not distinct", humans)
		}
	}
}

func TestOptsChangesBots(t *testing.T) {
	_, ts, _ := newTestServer(t)
	h := dial(t, ts)
	h.create("Host", nil, false, false)
	g := dial(t, ts)
	g.join(h.code, "Gast", "")
	if g.seat != 1 {
		t.Fatalf("guest at seat %d, want the first empty seat 1", g.seat)
	}
	h.waitEvent("join")
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"humans": 2, "hands": 8, "trumpMode": "gedraaid"}})
	s := h.waitState("bots for 2", func(s *state) bool { return s.Opts.Humans == 2 })
	if got := botSeats(s); !slices.Equal(got, []int{2, 3}) {
		t.Errorf("humans 2 with people at 0 and 1: bots at %v", got)
	}
	if s.Opts.Hands != 8 || s.Opts.TrumpMode != game.Gedraaid {
		t.Errorf("opts %+v", s.Opts)
	}
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"humans": 1}})
	if e := h.waitError(errInvalid); e.errMsg() != "Er zitten al 2 mensen aan tafel." {
		t.Errorf("msg %q", e.errMsg())
	}
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"humans": 3}})
	s = h.waitState("bots for 3", func(s *state) bool { return s.Opts.Humans == 3 })
	if got := botSeats(s); !slices.Equal(got, []int{3}) {
		t.Errorf("humans 3: bots at %v, want [3]", got)
	}
	for _, bad := range []map[string]any{{"hands": 5}, {"ai": "goddelijk"}, {"tempo": 3}, {"rules": "haags"}, {"humans": 0}} {
		h.send(map[string]any{"t": "opts", "opts": bad})
		h.waitError(errInvalid)
	}
	g.send(map[string]any{"t": "opts", "opts": map[string]any{"hands": 4}})
	g.waitError(errNotHost)
}

func TestLobbyCommands(t *testing.T) {
	_, ts, _ := newTestServer(t)
	h := dial(t, ts)
	h.create("Host", map[string]any{"humans": 4}, false, false)
	g := dial(t, ts)
	g.join(h.code, "Gast", "")
	h.waitEvent("join")

	for _, m := range []map[string]any{
		{"t": "bot", "seat": 2, "id": ""}, {"t": "unbot", "seat": 2}, {"t": "start"},
	} {
		g.send(m)
		g.waitError(errNotHost)
	}
	h.send(map[string]any{"t": "bot", "seat": 1, "id": "henk"})
	h.waitError(errInvalid) // a human sits there
	h.send(map[string]any{"t": "bot", "seat": 2, "id": "nobody"})
	h.waitError(errInvalid)
	h.send(map[string]any{"t": "bot", "seat": 2, "id": "henk"})
	s := h.waitState("henk at 2", func(s *state) bool { return s.Players[2] != nil })
	if p := s.Players[2]; p.BotID != "henk" || p.Name != "Opa Henk (AI)" || p.Emoji != "👴" || p.Color == "" || !p.Bot {
		t.Errorf("bot %+v", p)
	}
	h.send(map[string]any{"t": "bot", "seat": 3, "id": "henk"})
	if e := h.waitError(errInvalid); e.errMsg() != "Opa Henk (AI) zit al aan tafel." {
		t.Errorf("msg %q", e.errMsg())
	}
	h.send(map[string]any{"t": "bot", "seat": 2, "id": ""}) // replace with someone else
	s = h.waitState("replaced", func(s *state) bool { return s.Players[2] != nil && s.Players[2].BotID != "henk" })
	h.send(map[string]any{"t": "unbot", "seat": 1})
	h.waitError(errInvalid)
	h.send(map[string]any{"t": "unbot", "seat": 2})
	h.waitState("seat 2 empty", func(s *state) bool { return s.Players[2] == nil })

	// Humans may move to an empty seat; the host role moves along.
	g.send(map[string]any{"t": "sit", "seat": 2})
	s = g.waitState("guest at 2", func(s *state) bool { return s.You == 2 })
	if s.Players[1] != nil || s.Players[2].Name != "Gast" {
		t.Errorf("after sit: %+v %+v", s.Players[1], s.Players[2])
	}
	g.send(map[string]any{"t": "sit", "seat": 0})
	g.waitError(errInvalid)
	h.send(map[string]any{"t": "sit", "seat": 3})
	s = h.waitState("host at 3", func(s *state) bool { return s.You == 3 })
	if s.Host != 3 {
		t.Errorf("host %d after the host moved to 3", s.Host)
	}

	// Start fills both empty seats with distinct bots.
	h.send(map[string]any{"t": "start"})
	s = h.waitEvent("deal").state
	if got := botSeats(s); !slices.Equal(got, []int{0, 1}) || s.Players[0].BotID == s.Players[1].BotID {
		t.Errorf("after start: bots at %v", got)
	}
	h.send(map[string]any{"t": "sit", "seat": 0})
	h.waitError(errStarted)
}

func TestJoinErrors(t *testing.T) {
	_, ts, _ := newTestServer(t)
	h := dial(t, ts)
	h.create("Host", map[string]any{"humans": 2}, false, false)

	x := dial(t, ts)
	x.send(map[string]any{"t": "join", "code": "ZZZZ", "name": "X"})
	x.waitError(errUnknown)
	x.send(map[string]any{"t": "join", "code": "A1", "name": "X"})
	x.waitError(errUnknown)
	x.send(map[string]any{"t": "chat", "text": "hallo"})
	x.waitError(errUnknown)

	g := dial(t, ts)
	g.join(strings.ToLower(h.code), "Gast", "") // codes are case-insensitive
	if g.seat != 2 {
		t.Errorf("guest at seat %d, want the partner seat 2", g.seat)
	}
	y := dial(t, ts)
	y.send(map[string]any{"t": "join", "code": h.code, "name": "Y"})
	y.waitError(errFull)

	h.send(map[string]any{"t": "start"})
	h.waitEvent("deal")
	y.send(map[string]any{"t": "join", "code": h.code, "name": "Y"})
	y.waitError(errStarted)
	y.send(map[string]any{"t": "join", "code": h.code, "name": "Y", "token": "verkeerd"})
	y.waitError(errStarted)
}

func TestLeaveAndTakeOver(t *testing.T) {
	_, ts, _ := newTestServer(t)
	h := dial(t, ts)
	h.create("Host", map[string]any{"humans": 2, "hands": 4}, false, false)
	g := dial(t, ts)
	g.join(h.code, "Gast", "")
	h.send(map[string]any{"t": "start"})
	h.waitEvent("deal")

	// The host leaves mid-game: a bot takes the seat, the guest becomes host.
	h.send(map[string]any{"t": "leave"})
	m := g.until(5*time.Second, "leave", func(m *msg) bool { return m.T == "update" && m.evType() == "leave" })
	s := m.state
	if p := s.Players[0]; p == nil || !p.Bot {
		t.Fatalf("seat 0 after leave: %+v", p)
	}
	if s.Host != 2 {
		t.Errorf("host %d, want 2", s.Host)
	}
	if !slices.ContainsFunc(g.chats, func(c chatMsg) bool { return c.Sys && strings.HasPrefix(c.Text, "Host is vertrokken; ") }) {
		t.Errorf("no leave line in %+v", g.chats)
	}
	// The old token no longer works, but a newcomer takes over the seat.
	n := dial(t, ts)
	n.join(h.code, "Nieuw", h.token)
	if n.seat != 0 {
		t.Fatalf("newcomer at seat %d, want 0", n.seat)
	}
	if p := n.s.Players[0]; p.Bot || p.Name != "Nieuw" {
		t.Errorf("seat 0 after takeover: %+v", p)
	}
	g.waitEvent("join")
	x := dial(t, ts)
	x.send(map[string]any{"t": "join", "code": h.code, "name": "X"})
	x.waitError(errStarted)
}

func TestHostHandover(t *testing.T) {
	_, ts, _ := newTestServer(t, func(s *Server) { s.scale = 0.01 })
	h := dial(t, ts)
	h.create("Host", nil, false, false)
	g := dial(t, ts)
	g.join(h.code, "Gast", "")
	h.waitEvent("join")

	// A disconnected host hands over after the grace period (30 s scaled).
	h.conn.CloseNow()
	s := g.waitState("host handover", func(s *state) bool { return s.Host == g.seat })
	if s.Players[0] == nil || s.Players[0].Connected {
		t.Errorf("old host: %+v", s.Players[0])
	}
	if !slices.ContainsFunc(g.chats, func(c chatMsg) bool { return c.Sys && c.Text == "Gast is nu de host." }) {
		t.Errorf("no host line in %+v", g.chats)
	}
	// The new host leaves the lobby: nobody connected remains but the old
	// host's seat, who becomes host again.
	g.send(map[string]any{"t": "leave"})
	h2 := dial(t, ts)
	h2.join(h.code, "Host", h.token)
	if h2.s.Host != 0 || h2.s.Players[1] != nil {
		t.Errorf("after rejoin: host %d, seat 1 %+v", h2.s.Host, h2.s.Players[1])
	}
	// The last human leaving the lobby removes the room.
	h2.send(map[string]any{"t": "leave"})
	x := dial(t, ts)
	deadline := time.Now().Add(2 * time.Second)
	for {
		x.send(map[string]any{"t": "join", "code": h.code, "name": "X"})
		m := x.until(2*time.Second, "answer", func(m *msg) bool { return m.T == "error" || m.T == "joined" })
		if m.T == "error" && m.Code == errUnknown {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("room still there: %s %s", m.T, m.errMsg())
		}
		x.send(map[string]any{"t": "leave"})
	}
}

func TestChat(t *testing.T) {
	_, ts, _ := newTestServer(t)
	h := dial(t, ts)
	h.create("Host", nil, false, false)
	g := dial(t, ts)
	g.join(h.code, "Gast", "")

	long := strings.Repeat("é", 250)
	h.send(map[string]any{"t": "chat", "text": "  hallo\n\tdaar‮  "})
	h.send(map[string]any{"t": "chat", "text": "   "}) // ignored
	h.send(map[string]any{"t": "chat", "text": long})
	got := []string{}
	for len(got) < 2 {
		m := g.waitType("chat")
		var cm chatMsg
		json.Unmarshal(m.Msg, &cm)
		if cm.Sys {
			continue
		}
		if cm.Seat != 0 || cm.Name != "Host" || cm.Bot || cm.TS == 0 {
			t.Errorf("chat %+v", cm)
		}
		got = append(got, cm.Text)
	}
	if got[0] != "hallo daar" || got[1] != strings.Repeat("é", 200) {
		t.Errorf("chat texts %q", got)
	}
	// Burst of 5, then 1 per second: two lines are used, so a quick run of
	// eight more hits the limit.
	for range 8 {
		h.send(map[string]any{"t": "chat", "text": "spam"})
	}
	h.waitError(errLimit)

	// A newcomer gets the log, at most 50 lines.
	n := dial(t, ts)
	n.send(map[string]any{"t": "join", "code": h.code, "name": "Nieuw"})
	n.waitType("joined")
	log := n.waitType("chatlog")
	if len(log.Msgs) == 0 || len(log.Msgs) > 50 {
		t.Errorf("chatlog has %d lines", len(log.Msgs))
	}
}

func TestBotChatLimits(t *testing.T) {
	s, _, _ := newTestServer(t, func(s *Server) { s.scale = 1 })
	r := newRoom(s, "CHAT")
	r.seats[1] = r.newBot(fakePersonas[1])
	if !r.botSay(1, ChatEvent{Kind: "greet"}, 0) {
		t.Fatal("bot did not greet")
	}
	if r.botSay(1, ChatEvent{Kind: "greet"}, 0) {
		t.Error("second line in the same trick")
	}
	r.trickNo++
	if r.botSay(1, ChatEvent{Kind: "greet"}, 0) {
		t.Error("second line within 8 s")
	}
	r.seats[1].lastChat = time.Now().Add(-9 * time.Second)
	if !r.botSay(1, ChatEvent{Kind: "greet"}, 0) {
		t.Error("no line after 9 s in a new trick")
	}
	r.trickNo++
	r.seats[1].lastChat = time.Now().Add(-9 * time.Second)
	if r.botSay(1, ChatEvent{Kind: "trump"}, 0) {
		t.Error("the fake AI has nothing to say about trump")
	}
	// A quiet bot (Chattiness 0.2) waits 40 s.
	r.seats[3] = r.newBot(fakePersonas[3])
	r.seats[3].lastChat = time.Now().Add(-20 * time.Second)
	if r.botSay(3, ChatEvent{Kind: "greet"}, 0) {
		t.Error("quiet bot spoke after 20 s")
	}
	if r.botSay(0, ChatEvent{Kind: "greet"}, 0) {
		t.Error("an empty seat spoke")
	}
}

func TestBotsGreetAndReply(t *testing.T) {
	_, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1}, false, true)
	m := c.until(5*time.Second, "bot greeting", func(m *msg) bool {
		if m.T != "chat" {
			return false
		}
		var cm chatMsg
		json.Unmarshal(m.Msg, &cm)
		return cm.Bot
	})
	var cm chatMsg
	json.Unmarshal(m.Msg, &cm)
	if cm.Text != "Hallo allemaal!" || !strings.HasSuffix(cm.Name, " (AI)") || cm.Seat < 1 || cm.Sys {
		t.Errorf("greeting %+v", cm)
	}
}

func TestHealth(t *testing.T) {
	_, ts, _ := newTestServer(t, func(s *Server) { s.cfg.Version = "abc123" })
	c := dial(t, ts)
	c.create("Piet", nil, false, false)
	resp, err := http.Get(ts.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var h map[string]any
	if err := json.Unmarshal(body, &h); err != nil {
		t.Fatalf("health %s: %v", body, err)
	}
	if h["ok"] != true || h["version"] != "abc123" || h["rooms"] != 1.0 || h["players"] != 1.0 || len(h) != 4 {
		t.Errorf("health %s", body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type %q", ct)
	}
	resp, err = http.Post(ts.URL+"/api/health", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST health: %d", resp.StatusCode)
	}
}

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{
		"  Piet  ":                    "Piet",
		"":                            "Speler",
		" \t\n ":                      "Speler",
		"Jan\u0000\u001b[31m Klaas":   "Jan[31m Klaas",
		"Opa Henk (AI)":               "Opa Henk",
		"(ai)":                        "Speler",
		"Een heel erg lange naam die": "Een heel erg lange n",
		"Ali‮ba":                      "Aliba",
		"👩‍🏫 Ans":                     "👩‍🏫 Ans",
		"a  \t b":                     "a b",
		"\xff\xfeMarie":               "Marie",
	} {
		if got := cleanName(in); got != want {
			t.Errorf("cleanName(%q) = %q, want %q", in, got, want)
		}
	}
}
