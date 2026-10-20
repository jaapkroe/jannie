package server

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

// TestRefusedJoin: a join turned away from a full lobby tells the joiner
// what to ask for, and the host (a system line for the table, a refused
// message for the host only), at most once per refusedGap per room. Back
// in the lobby with every human seat taken, nobody is invited to join.
func TestRefusedJoin(t *testing.T) {
	s, ts, _ := newTestServer(t, func(s *Server) { s.scale = 0.01 })
	h := dial(t, ts)
	h.create("Host", map[string]any{"humans": 2, "hands": 4}, false, false)
	g := dial(t, ts)
	g.join(h.code, "Gast", "")
	h.waitEvent("join")
	r := roomOf(t, s, h.code)

	y := dial(t, ts)
	y.send(map[string]any{"t": "join", "code": h.code, "name": "Yara"})
	if m := y.waitError(errFull); !strings.Contains(m.errMsg(), "bij Spelers een plaats vrij te maken") {
		t.Errorf("refusal text %q", m.errMsg())
	}
	if m := h.waitType("refused"); m.Name != "Yara" {
		t.Errorf("refused notice for %q", m.Name)
	}
	line := "Yara wilde aanschuiven, maar de tafel is vol."
	g.until(5*time.Second, "refusal line", func(m *msg) bool {
		return m.T == "chat" && slices.ContainsFunc(g.chats, func(c chatMsg) bool { return c.Sys && c.Text == line })
	})
	if !slices.ContainsFunc(h.chats, func(c chatMsg) bool { return c.Sys && c.Text == line }) {
		t.Errorf("host has no refusal line: %+v", h.chats)
	}

	// Within the gap: refused again, but nobody is told.
	call(r, func() { r.refusedAt = time.Now() })
	y.send(map[string]any{"t": "join", "code": h.code, "name": "Zeno"})
	y.waitError(errFull)
	call(r, func() {}) // the join is handled: a notice would be queued before the pong
	h.send(map[string]any{"t": "ping"})
	h.until(5*time.Second, "pong", func(m *msg) bool {
		if m.T == "refused" {
			t.Errorf("second notice within the gap: %q", m.Name)
		}
		return m.T == "pong"
	})

	// A free seat taken by a bot: the host can remove it.
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"humans": 3}})
	h.waitState("humans 3, seat 1 free", func(s *state) bool { return s.Opts.Humans == 3 && s.Players[1] == nil })
	h.send(map[string]any{"t": "bot", "seat": 1, "id": ""})
	h.waitState("bot at 1", func(s *state) bool { return s.Players[1] != nil && s.Players[1].Bot })
	call(r, func() { r.refusedAt = time.Time{} })
	y.send(map[string]any{"t": "join", "code": h.code, "name": "Yara"})
	if m := y.waitError(errFull); !strings.Contains(m.errMsg(), "AI-speler weg te halen") {
		t.Errorf("refusal text with every seat taken: %q", m.errMsg())
	}
	h.waitType("refused")

	// Game over, back to the lobby with 2 of 3 humans: room for one more.
	// With the third seat for humans gone again, no invitation.
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"humans": 2}})
	h.waitState("humans 2", func(s *state) bool { return s.Opts.Humans == 2 })
	h.send(map[string]any{"t": "start"})
	h.waitEvent("deal")
	call(r, func() {
		r.pending = stepNone
		r.handNo = r.opts.Hands
		r.nextHand()
	})
	h.waitEvent("gameOver")
	h.send(map[string]any{"t": "lobby"})
	h.waitState("lobby", func(s *state) bool { return s.Phase == phaseLobby }) // the line comes first
	if !slices.ContainsFunc(h.chats, func(c chatMsg) bool { return c.Sys && c.Text == "Host zet de tafel opnieuw klaar." }) {
		t.Errorf("lobby line with a full table: %+v", h.chats)
	}
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
	if !slices.Contains(fakeGreetings, cm.Text) || !strings.HasSuffix(cm.Name, " (AI)") || cm.Seat < 1 || cm.Sys {
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

		// No fake "(AI)": not recreated by the cut to 20, not hidden by
		// invisible or look-alike characters, nowhere in the name.
		"Opa Henk Jansen (AI)X":        "Opa Henk Jansen X",
		"Opa Henk (AI)\u200b":          "Opa Henk",
		"Opa Henk (AI)\u00ad":          "Opa Henk",
		"Opa Henk （ＡＩ）":                "Opa Henk",
		"Opa Henk (\u0410\u0406)":      "Opa Henk", // Cyrillic А and І
		"Opa Henk (A\u200dI)":          "Opa Henk",
		"Opa Henk ( a . i )":           "Opa Henk",
		"Opa Henk (Al)":                "Opa Henk",
		"Opa (AI) Henk":                "Opa Henk",
		"((AI)AI)":                     "Speler",
		"Piet\u3164(AI)":               "Piet",
		"Ali (Alice)":                  "Ali (Alice)",
		"AI Bram":                      "AI Bram",
		"Opa Henk\U000E0041\U000E0049": "Opa Henk",

		// Invisible names become Speler.
		"\u200b\u200b":             "Speler",
		"\u200d":                   "Speler",
		"\ufeff":                   "Speler",
		"\u3164":                   "Speler",
		"\u2800":                   "Speler",
		"\U000E0041":               "Speler",
		"\u0301\u0301":             "Speler",
		"\u115f\u1160 \uffa0":      "Speler",
		"\u2065\ufff0\ufdd0\uffff": "Speler",

		// Marks: at most three on a letter; real text keeps them.
		"H" + strings.Repeat("\u0301", 199): "H\u0301\u0301\u0301",
		"Zoe\u0308":                         "Zoe\u0308",
		"Nguyê\u0303n":                      "Nguyê\u0303n",

		// Joiners stay between visible characters only.
		"🏳️‍🌈 Kim":         "🏳️‍🌈 Kim",
		"👨‍👩‍👧 Fam":        "👨‍👩‍👧 Fam",
		"1️⃣ Eva":          "1️⃣ Eva",
		"Ans\u200d":        "Ans",
		"\u200dAns":        "Ans",
		"An\u200d\u200ds":  "An\u200ds",
		"An\u200d s":       "An s",
		"می\u200cخواهم":    "می\u200cخواهم",
		"Kees\u202e\u2066": "Kees",
	} {
		if got := cleanName(in); got != want {
			t.Errorf("cleanName(%q) = %q, want %q", in, got, want)
		}
	}
	// The cut to 20 characters keeps whole characters and no joiner at the end.
	long := strings.Repeat("a", 19) + "👩‍🏫"
	if got := cleanName(long); got != strings.Repeat("a", 19)+"👩" {
		t.Errorf("cleanName(%q) = %q", long, got)
	}
}

func TestCleanChat(t *testing.T) {
	for in, want := range map[string]string{
		"  hallo\n\tdaar  ":                 "hallo daar",
		"\u200b\u200b\u200b":                "",
		"\u3164":                            "",
		"\u2800 \u2800":                     "",
		"\u0301\u0301":                      "",
		"hoi 👋\u200d":                       "hoi 👋",
		"gg\U000E0067\U000E0062":            "gg",
		"(AI) mag in de chat":               "(AI) mag in de chat",
		"H" + strings.Repeat("\u0300", 199): "H\u0300\u0300\u0300",
	} {
		if got := cleanChat(in); got != want {
			t.Errorf("cleanChat(%q) = %q, want %q", in, got, want)
		}
	}
	if got := cleanChat(strings.Repeat("ab ", 100)); utf8.RuneCountInString(got) != 200 || strings.HasSuffix(got, " ") {
		t.Errorf("long line: %d characters %q", utf8.RuneCountInString(got), got[len(got)-4:])
	}
}

// TestBotChatNoRepeats: a bot does not say one of its latest lines for an
// event again (numbers aside), and stays silent rather than repeat itself.
func TestBotChatNoRepeats(t *testing.T) {
	s, _, _ := newTestServer(t, func(s *Server) { s.scale = 1 })
	r := newRoom(s, "ECHO")
	t.Cleanup(r.stop) // lines are posted to a room loop that does not run
	r.seats[1] = r.newBot(fakePersonas[1])
	var said []string
	for k := range 300 {
		st := &r.seats[1]
		st.lastChat = time.Now().Add(-time.Minute)
		r.trickNo++
		if r.botSay(1, ChatEvent{Kind: "roem", Mine: true, Points: 20 + 30*(k%2)}, 0) {
			lines := st.said["roem"]
			said = append(said, lines[len(lines)-1])
		}
	}
	if len(said) < 250 {
		t.Errorf("the bot spoke %d times out of 300 with lines left to say", len(said))
	}
	for k := range said {
		for back := 1; back <= botChatMemory && back <= k; back++ {
			if said[k] == said[k-back] {
				t.Fatalf("line %d %q repeats line %d", k, said[k], k-back)
			}
		}
	}
	if !slices.Contains(said, "# roem. Niet slecht.") {
		t.Errorf("numbers not folded: %q", said[:8])
	}
	// A new persona on the seat starts afresh.
	r.seats[1] = r.newBot(fakePersonas[2])
	if r.seats[1].said != nil {
		t.Errorf("new bot remembers %v", r.seats[1].said)
	}
	// With only lines said lately to choose from (the fake has one answer
	// to "hoi"), the bot keeps quiet.
	hoi := ChatEvent{Kind: "reply", Text: "hoi"}
	if !r.botSay(1, hoi, 0) {
		t.Fatal("no answer to hoi")
	}
	r.seats[1].lastChat = time.Now().Add(-time.Minute)
	r.trickNo++
	if r.botSay(1, hoi, 0) {
		t.Error("the bot repeated itself instead of keeping quiet")
	}
}
