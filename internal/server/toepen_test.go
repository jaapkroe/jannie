package server

import (
	"encoding/json"
	"math/rand/v2"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

// testToep is a ToepAI whose brains decide at random (seeded), so the
// bots toep, pass, claim and check now and then, and chat on every event.
type testToep struct {
	mu    sync.Mutex
	kinds map[string]int
}

func (a *testToep) NewToepBrain(id, level string, seed uint64) ToepBrain {
	return &testToepBrain{rng: rand.New(rand.NewPCG(seed, 1))}
}

func (a *testToep) ToepChat(id string, ev ChatEvent, rng *rand.Rand) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.kinds == nil {
		a.kinds = map[string]int{}
	}
	a.kinds[ev.Kind]++
	return "" // silent: the chat limits are klaverjas's tests' business
}

type testToepBrain struct {
	mu  sync.Mutex
	rng *rand.Rand
}

func (b *testToepBrain) chance(p float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rng.Float64() < p
}

func (b *testToepBrain) Was(v toepen.View) bool    { return b.chance(0.2) }
func (b *testToepBrain) Check(v toepen.View) bool  { return b.chance(0.4) }
func (b *testToepBrain) Toep(v toepen.View) bool   { return b.chance(0.15) }
func (b *testToepBrain) Answer(v toepen.View) bool { return b.chance(0.7) }
func (b *testToepBrain) Play(v toepen.View) game.Card {
	b.mu.Lock()
	defer b.mu.Unlock()
	return v.Legal[b.rng.IntN(len(v.Legal))]
}

func newToepServer(t *testing.T, tweak ...func(*Server)) (*Server, *testToep, *httptest.Server) {
	t.Helper()
	ai := &testToep{}
	s, ts := newTestServerWith(t, &fakeAI{}, append([]func(*Server){func(s *Server) { s.cfg.Toepen = ai }}, tweak...)...)
	return s, ai, ts
}

// toepS is the toepen state of an update.
func toepS(t *testing.T, m *msg) *toepState {
	t.Helper()
	var s toepState
	if err := json.Unmarshal(m.S, &s); err != nil {
		t.Fatalf("bad toepen state %s: %v", m.S, err)
	}
	return &s
}

// toepTurn makes a random decision for c when the state awaits one of
// it, and reports whether it did.
func toepTurn(c *tclient, s *toepState, rng *rand.Rand) bool {
	me := s.You
	switch {
	case s.Phase == phaseWas && s.NextAt != 0 && s.Status[me] == toepen.StatusIn && !s.Answered[me]:
		c.send(map[string]any{"t": "was", "play": s.CanClaim && rng.IntN(4) == 0})
	case s.Turn != me:
		return false
	case s.Phase == phaseCheck:
		c.send(map[string]any{"t": "check", "play": rng.IntN(2) == 0})
	case s.Phase == phaseToep:
		c.send(map[string]any{"t": "answer", "play": rng.IntN(4) != 0})
	case s.Phase == phasePlay && s.CanToep && rng.IntN(5) == 0:
		c.send(map[string]any{"t": "toep"})
	case s.Phase == phasePlay:
		c.send(map[string]any{"t": "play", "card": s.Legal[rng.IntN(len(s.Legal))].String()})
	default:
		return false
	}
	return true
}

var toepKeys = []string{
	"game", "code", "phase", "opts", "training", "expert", "you", "host", "players", "turn", "takeover",
	"nextAt", "winner", "handNo", "dealer", "voorhand", "stake", "toeper", "armoedeToep", "points",
	"status", "armoede", "washed", "answered", "claims", "canClaim", "claimant", "asking", "checks",
	"stock", "hand", "canToep", "trick", "lastTrick", "tricks", "rounds",
}

// playToepen plays c's decisions at random until game over and returns the
// toepen states seen, per phase, and the event types.
func playToepen(t *testing.T, c *tclient, rng *rand.Rand) (map[string]*toepState, map[string]int) {
	t.Helper()
	phases := map[string]*toepState{}
	events := map[string]int{}
	var prev *toepState
	sent, wasIn := "", -1 // the state last acted on, the round whose was we answered
	for {
		m := c.next(10 * time.Second)
		if m.T == "error" {
			t.Fatalf("error %s: %s", m.Code, m.errMsg())
		}
		if m.T != "update" {
			continue
		}
		s := toepS(t, m)
		if e := m.evType(); e != "" {
			events[e]++
		}
		want := slices.Clone(toepKeys)
		if len(s.Legal) > 0 {
			want = append(want, "legal", "rule")
		}
		if s.Phase == phaseLobby {
			want = append(want, "roster")
		}
		wantKeys(t, s.Phase, m.S, want)
		if s.Game != gameToepen {
			t.Fatalf("game %q", s.Game)
		}
		if prev != nil && prev.HandNo == s.HandNo {
			for k := range s.Points {
				if s.Points[k] < prev.Points[k] {
					t.Fatalf("points went down: %v → %v", prev.Points, s.Points)
				}
			}
		}
		for _, l := range s.Legal {
			if !slices.Contains(s.Hand, l) {
				t.Fatalf("legal %v not in hand %v", l, s.Hand)
			}
		}
		if !slices.Equal(s.Hand, toepen.SortHand(s.Hand)) {
			t.Errorf("hand not sorted: %v", s.Hand)
		}
		prev = s
		if phases[s.Phase] == nil {
			phases[s.Phase] = s
		}
		if s.Phase == phaseGameOver {
			return phases, events
		}
		key := string(m.S) // decide once per state, and once on a was
		if s.Phase == phaseWas && wasIn == s.HandNo {
			continue
		}
		if key != sent && toepTurn(c, s, rng) {
			sent = key
			if s.Phase == phaseWas {
				wasIn = s.HandNo
			}
		}
	}
}

func TestToepenMatch(t *testing.T) {
	for _, players := range []int{2, 4, 6} {
		t.Run(string(rune('0'+players))+" spelers", func(t *testing.T) {
			_, ai, ts := newToepServer(t)
			c := dial(t, ts)
			c.create("Jaap", map[string]any{"game": "toepen", "players": players, "seed": 4242}, false, true)
			phases, events := playToepen(t, c, rand.New(rand.NewPCG(uint64(players), 9)))
			over := phases[phaseGameOver]
			if over.Winner < 0 || over.Points[over.Winner] >= over.Opts.Limit {
				t.Fatalf("winner %d with %v", over.Winner, over.Points)
			}
			left := 0
			for _, p := range over.Points {
				if p < over.Opts.Limit {
					left++
				}
			}
			if left != 1 || len(over.Rounds) != over.HandNo || len(over.Players) != players {
				t.Errorf("left %d, rounds %d of %d", left, len(over.Rounds), over.HandNo)
			}
			for _, ph := range []string{phaseWas, phasePlay, phaseHandEnd} {
				if phases[ph] == nil {
					t.Errorf("never in phase %s", ph)
				}
			}
			for _, ev := range []string{"deal", "play", "trick", "collect", "handEnd", "gameOver"} {
				if events[ev] == 0 {
					t.Errorf("no event %s: %v", ev, events)
				}
			}
			if players >= 4 && (events["toep"] == 0 || events["answer"] == 0 || events["claims"] == 0) {
				t.Errorf("no toep or was in a whole match: %v", events)
			}
			ai.mu.Lock()
			if ai.kinds["greet"] == 0 {
				t.Errorf("bots never greeted: %v", ai.kinds)
			}
			ai.mu.Unlock()
		})
	}
}

// A rematch starts a new match of toepen at the same table.
func TestToepenRematch(t *testing.T) {
	_, _, ts := newToepServer(t)
	c := dial(t, ts)
	c.create("Jaap", map[string]any{"game": "toepen", "players": 3, "limit": 10}, false, true)
	playToepen(t, c, rand.New(rand.NewPCG(1, 2)))
	c.send(map[string]any{"t": "rematch"})
	m := c.until(5*time.Second, "the new match", func(m *msg) bool { return m.T == "update" && m.evType() == "deal" })
	if s := toepS(t, m); s.HandNo != 1 || slices.Max(s.Points) != 0 || len(s.Rounds) != 0 {
		t.Errorf("rematch: round %d points %v", s.HandNo, s.Points)
	}
}

func TestToepenLobby(t *testing.T) {
	_, _, ts := newToepServer(t)
	h := dial(t, ts)
	h.create("Jaap", map[string]any{"game": "toepen", "players": 6}, false, false)
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"limit": 15, "was": false}})
	m := h.until(5*time.Second, "lobby", func(m *msg) bool { return m.T == "update" })
	s := toepS(t, m)
	if s.Game != gameToepen || len(s.Players) != 6 || s.Opts.Limit != 15 || s.Opts.Was || !s.Opts.Armoede || len(s.Roster) == 0 {
		t.Fatalf("lobby %+v", s.Opts)
	}
	g := dial(t, ts)
	g.join(h.code, "Kees", "")
	if g.seat != 1 {
		t.Fatalf("guest at %d", g.seat)
	}
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"players": 7}})
	if m := h.waitError(errInvalid); m.errMsg() != "Kies 2 tot en met 6 spelers." {
		t.Errorf("seven: %q", m.errMsg())
	}
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"limit": 12}})
	if m := h.waitError(errInvalid); m.errMsg() != "Speel tot 10 of tot 15 strafpunten." {
		t.Errorf("limit 12: %q", m.errMsg())
	}
	// Back to klaverjas: a table of six becomes one of four.
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"game": "klaverjas"}})
	st := h.waitState("klaverjas", func(s *state) bool { return s.Game == gameKlaverjas })
	if len(st.Players) != 4 || st.Opts.Players != 4 {
		t.Errorf("klaverjas at %d seats", len(st.Players))
	}
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"players": 5}})
	if m := h.waitError(errInvalid); m.errMsg() != "Kies 2, 3 of 4 spelers." {
		t.Errorf("klaverjas with five: %q", m.errMsg())
	}
	// And toepen again, with five.
	h.send(map[string]any{"t": "opts", "opts": map[string]any{"game": "toepen", "players": 5}})
	m = h.until(5*time.Second, "toepen for five", func(m *msg) bool {
		return m.T == "update" && toepS(t, m).Game == gameToepen && len(toepS(t, m).Players) == 5
	})
	h.send(map[string]any{"t": "start"})
	m = h.until(5*time.Second, "the deal", func(m *msg) bool { return m.T == "update" && m.evType() == "deal" })
	if s := toepS(t, m); s.Phase != phaseWas && s.Phase != phasePlay || len(s.Hand) != 4 || s.Players[4] == nil || !s.Players[4].Bot {
		t.Errorf("started: phase %s hand %v", s.Phase, s.Hand)
	}
	// A message of klaverjas is none of toepen's.
	h.send(map[string]any{"t": "trump", "suit": "H"})
	if m := h.waitError(errInvalid); m.errMsg() != "Dat bericht ken ik niet." {
		t.Errorf("trump in toepen: %q", m.errMsg())
	}
}

func TestToepenOnlyKlaverjasInTraining(t *testing.T) {
	_, _, ts := newToepServer(t)
	c := dial(t, ts)
	c.create("Jaap", map[string]any{"game": "toepen", "players": 6}, true, true)
	s := c.waitState("training", func(s *state) bool { return s.Phase != phaseLobby })
	if s.Game != gameKlaverjas || len(s.Players) != 4 {
		t.Errorf("training plays %s at %d", s.Game, len(s.Players))
	}
	c.send(map[string]any{"t": "toep"})
	if m := c.waitError(errInvalid); m.errMsg() != "Dat bericht ken ik niet." {
		t.Errorf("toep in klaverjas: %q", m.errMsg())
	}
}

// twoHumans seats Jaap and Kees at a table of two for toepen with opts and
// starts it; it returns both clients, the host first.
func twoHumans(t *testing.T, ts *httptest.Server, opts map[string]any) (*tclient, *tclient) {
	t.Helper()
	h := dial(t, ts)
	o := map[string]any{"game": "toepen", "players": 2}
	for k, v := range opts {
		o[k] = v
	}
	h.create("Jaap", o, false, false)
	g := dial(t, ts)
	g.join(h.code, "Kees", "")
	h.send(map[string]any{"t": "start"})
	return h, g
}

// untilToep reads c's messages until its toepen state satisfies pred.
func untilToep(t *testing.T, c *tclient, what string, pred func(*toepState) bool) *toepState {
	t.Helper()
	m := c.until(10*time.Second, what, func(m *msg) bool { return m.T == "update" && pred(toepS(t, m)) })
	return toepS(t, m)
}

func TestToepenToepAndPass(t *testing.T) {
	_, _, ts := newToepServer(t)
	h, g := twoHumans(t, ts, map[string]any{"was": false, "armoede": false, "seed": 77})
	clients := []*tclient{h, g}
	s := untilToep(t, h, "a turn", func(s *toepState) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	toeper := clients[s.Turn]
	other := clients[1-s.Turn]
	untilToep(t, toeper, "my turn", func(s *toepState) bool { return s.Turn == s.You && s.CanToep })
	toeper.send(map[string]any{"t": "toep"})
	untilToep(t, other, "asked", func(s *toepState) bool { return s.Phase == phaseToep && s.Turn == s.You && s.Stake == 2 })
	toeper.send(map[string]any{"t": "answer", "play": true})
	if m := toeper.waitError(errNotTurn); m.errMsg() != toepen.ErrNotYourTurn.Error() {
		t.Errorf("toeper answers: %q", m.errMsg())
	}
	other.send(map[string]any{"t": "answer", "play": false})
	m := other.waitEvent("handEnd")
	var row toepRound
	b, _ := json.Marshal(m.ev["result"])
	json.Unmarshal(b, &row)
	if row.Winner != game.Seat(toeper.seat) || row.Tricks || row.Gains[other.seat] != 1 || row.Gains[toeper.seat] != 0 {
		t.Errorf("round %+v", row)
	}
	if s := toepS(t, m); s.Points[other.seat] != 1 || len(s.Rounds) != 1 || s.NextAt == 0 {
		t.Errorf("after: points %v rounds %d next %d", s.Points, len(s.Rounds), s.NextAt)
	}
}

func TestToepenWasCheck(t *testing.T) {
	_, _, ts := newToepServer(t)
	h, g := twoHumans(t, ts, map[string]any{"armoede": false, "seed": 5})
	s := untilToep(t, h, "the time for a was", func(s *toepState) bool { return s.Phase == phaseWas && s.CanClaim })
	if s.NextAt == 0 || s.Turn != -1 {
		t.Fatalf("was: next %d turn %d", s.NextAt, s.Turn)
	}
	hand := s.Hand
	h.send(map[string]any{"t": "was", "play": true})
	untilToep(t, g, "Jaap answered", func(s *toepState) bool { return s.Answered[0] && !s.Claims[0] })
	g.send(map[string]any{"t": "was", "play": false})
	m := g.waitEvent("claims")
	if seats, _ := m.ev["seats"].([]any); len(seats) != 1 || seats[0] != float64(0) {
		t.Fatalf("claims %v", m.ev)
	}
	untilToep(t, g, "asked to check", func(s *toepState) bool { return s.Phase == phaseCheck && s.Turn == s.You && s.Claimant == 0 })
	g.send(map[string]any{"t": "check", "play": true})
	m = g.waitEvent("wasDone")
	var done evWasDone
	b, _ := json.Marshal(m.ev)
	json.Unmarshal(b, &done)
	genuine := toepen.Was(hand) != toepen.NoWas
	if done.Checker != 1 || done.Claimant != 0 || done.Genuine != genuine || !slices.Equal(toepen.SortHand(done.Cards), hand) {
		t.Fatalf("wasDone %+v, hand %v", done, hand)
	}
	s = toepS(t, m)
	switch {
	case genuine && (s.Points[1] != 1 || !s.Washed[0] || s.Status[0] != toepen.StatusIn):
		t.Errorf("genuine: points %v washed %v", s.Points, s.Washed)
	case !genuine && (s.Points[0] != 1 || s.Status[0] != toepen.StatusCaught):
		t.Errorf("bluff: points %v status %v", s.Points, s.Status)
	}
	if len(s.Checks) != 1 {
		t.Errorf("checks %v", s.Checks)
	}
	if !genuine { // two players, one caught: the round is over
		g.waitEvent("handEnd")
	}
}

// The time for a was runs out for whoever does not answer.
func TestToepenWasTimesOut(t *testing.T) {
	_, _, ts := newToepServer(t)
	h, g := twoHumans(t, ts, map[string]any{"armoede": false})
	untilToep(t, h, "the time for a was", func(s *toepState) bool { return s.Phase == phaseWas })
	s := untilToep(t, g, "play", func(s *toepState) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	if slices.Contains(s.Claims, true) || s.Stock != 24 {
		t.Errorf("claims %v stock %d", s.Claims, s.Stock)
	}
}

// No AI plays a human's seat at toepen either without the others' consent.
func TestToepenTakeover(t *testing.T) {
	_, _, ts := newToepServer(t)
	h, g := twoHumans(t, ts, map[string]any{"was": false, "armoede": false, "seed": 3})
	s := untilToep(t, h, "a turn", func(s *toepState) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	gone, stay := g, h
	if s.Turn == 0 {
		gone, stay = h, g
	}
	gone.conn.CloseNow()
	s = untilToep(t, stay, "the question", func(s *toepState) bool { return s.Takeover != nil })
	if int(s.Takeover.Seat) != gone.seat || s.Turn != gone.seat {
		t.Fatalf("takeover %+v turn %d", s.Takeover, s.Turn)
	}
	stay.send(map[string]any{"t": "vote", "seat": gone.seat, "ai": true})
	stay.waitEvent("takeover")
	untilToep(t, stay, "the AI played", func(s *toepState) bool { return s.Turn == stay.seat || s.Phase == phaseHandEnd })
}

func TestToepenGameLog(t *testing.T) {
	dir := t.TempDir()
	s, _, ts := newToepServer(t, func(s *Server) {
		s.cfg.GameLog = dir
		s.games = newGameLog(dir, s.log)
	})
	c := dial(t, ts)
	c.create("Jaap", map[string]any{"game": "toepen", "players": 3, "seed": 99}, false, true)
	playToepen(t, c, rand.New(rand.NewPCG(5, 5)))
	_ = s
	var text string
	for range 100 {
		files, _ := filepath.Glob(filepath.Join(dir, "games-*.jsonl"))
		if len(files) == 1 {
			b, _ := os.ReadFile(files[0])
			text = string(b)
			if strings.Contains(text, `"t":"end"`) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	var rounds, matches int
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("bad line %s", line)
		}
		switch rec["t"] {
		case "match":
			matches++
			if opts, _ := rec["opts"].(map[string]any); opts["game"] != gameToepen {
				t.Errorf("match opts %v", rec["opts"])
			}
		case "round":
			rounds++
			if cards, _ := rec["cards"].([]any); len(cards) != 3 {
				t.Errorf("round cards %v", rec["cards"])
			}
		}
	}
	if matches != 1 || rounds == 0 {
		t.Errorf("log: %d matches, %d rounds", matches, rounds)
	}
}

// An answer to the time for a was that comes after it ran out is a late
// tap: no error.
func TestToepenLateWas(t *testing.T) {
	_, _, ts := newToepServer(t)
	h, _ := twoHumans(t, ts, map[string]any{"armoede": false, "was": true})
	untilToep(t, h, "play", func(s *toepState) bool { return s.Phase == phasePlay })
	h.send(map[string]any{"t": "was", "play": true})
	h.send(map[string]any{"t": "chat", "text": "hoi"})
	m := h.until(5*time.Second, "the chat line", func(m *msg) bool { return m.T == "chat" || m.T == "error" })
	if m.T == "error" {
		t.Errorf("late was: %s %s", m.Code, m.errMsg())
	}
}
