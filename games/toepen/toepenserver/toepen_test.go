package toepenserver

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"jannie/games/toepen/toepen"
	"jannie/platform/cards"
	"jannie/platform/persona"
	"jannie/platform/server"
	"jannie/platform/server/servertest"
)

// testAI's brains decide at random (seeded), so the bots toep, pass, claim
// and check now and then; it counts the chat events and says nothing (the
// chat limits are the table's tests' business). brain, when set, makes
// the brains instead.
type testAI struct {
	mu    sync.Mutex
	kinds map[string]int
	brain func(id string, seed uint64) Brain
}

func (a *testAI) Personas() []server.Persona {
	var out []server.Persona
	for _, p := range persona.All() {
		out = append(out, server.Persona{ID: p.ID, Name: p.Name, Emoji: p.Emoji, Color: p.Color, Bio: p.Name + ".",
			Chattiness: p.Chattiness, Speed: p.Speed})
	}
	return out
}

func (a *testAI) NewBrain(id, level string, seed uint64) Brain {
	if a.brain != nil {
		return a.brain(id, seed)
	}
	return &testBrain{rng: rand.New(rand.NewPCG(seed, 1))}
}

func (a *testAI) Chat(id string, ev server.ChatEvent, rng *rand.Rand) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.kinds == nil {
		a.kinds = map[string]int{}
	}
	a.kinds[ev.Kind]++
	return ""
}

func (a *testAI) said(kind string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.kinds[kind]
}

type testBrain struct {
	mu  sync.Mutex
	rng *rand.Rand
}

func (b *testBrain) chance(p float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rng.Float64() < p
}

func (b *testBrain) Was(v toepen.View) bool             { return b.chance(0.2) }
func (b *testBrain) Check(v toepen.View) bool           { return b.chance(0.4) }
func (b *testBrain) Toep(v toepen.View) bool            { return b.chance(0.15) }
func (b *testBrain) Overtoep(toepen.View) bool          { return b.chance(0.1) }
func (b *testBrain) Discard(v toepen.View) []cards.Card { return v.Hand[len(v.Hand)-v.Lay:] }
func (b *testBrain) Answer(v toepen.View) bool          { return b.chance(0.7) }
func (b *testBrain) Play(v toepen.View) cards.Card {
	b.mu.Lock()
	defer b.mu.Unlock()
	return v.Legal[b.rng.IntN(len(v.Legal))]
}

func newToepServer(t *testing.T, tweak ...func(*server.Config)) (*servertest.Server, *testAI) {
	t.Helper()
	ai := &testAI{}
	return servertest.Start(t, New(ai), tweak...), ai
}

// toepS is the toepen state of an update.
func toepS(t *testing.T, m *servertest.Msg) *state {
	t.Helper()
	var s state
	if err := json.Unmarshal(m.S, &s); err != nil {
		t.Fatalf("bad toepen state %s: %v", m.S, err)
	}
	return &s
}

// toepTurn makes a random decision for c when the state awaits one of
// it, and reports whether it did.
func toepTurn(c *servertest.Client, s *state, rng *rand.Rand) bool {
	me := s.You
	switch {
	case s.Phase == phaseWas && s.NextAt != 0 && s.Status[me] == toepen.StatusIn && !s.Answered[me]:
		c.Send(map[string]any{"t": "was", "play": s.CanClaim && rng.IntN(4) == 0})
	case s.Turn != me:
		return false
	case s.Phase == phaseCheck:
		c.Send(map[string]any{"t": "check", "play": rng.IntN(2) == 0})
	case s.Phase == phaseDiscard && s.Lay > 0:
		var cards []string
		for _, k := range rng.Perm(len(s.Hand))[:s.Lay] {
			cards = append(cards, s.Hand[k].String())
		}
		c.Send(map[string]any{"t": "discard", "cards": cards})
	case s.Phase == phaseToep && s.CanRaise && rng.IntN(6) == 0:
		c.Send(map[string]any{"t": "overtoep"})
	case s.Phase == phaseToep:
		c.Send(map[string]any{"t": "answer", "play": s.MustStay || rng.IntN(4) != 0})
	case s.Phase == phasePlay && s.CanToep && rng.IntN(5) == 0:
		c.Send(map[string]any{"t": "toep"})
	case s.Phase == phasePlay:
		c.Send(map[string]any{"t": "play", "card": s.Legal[rng.IntN(len(s.Legal))].String()})
	default:
		return false
	}
	return true
}

// toepKeys are the keys of toepen's state in every phase: the table's and
// toepen's, without klaverjas's game, training and expert.
var toepKeys = append(slices.Clone(servertest.SharedKeys),
	"winner", "handNo", "dealer", "voorhand", "stake", "toeper", "armoedeToep", "koning", "size", "wasRound",
	"canRaise", "mustStay", "passCost", "open", "lay", "laid", "points",
	"status", "armoede", "washed", "answered", "claims", "canClaim", "claimant", "asking", "checks",
	"stock", "hand", "canToep", "trick", "lastTrick", "tricks", "rounds",
)

// optsKeys are toepen's options on the wire.
var optsKeys = []string{"players", "ai", "tempo", "seed", "limit", "was", "armoede", "koning", "boer", "lijntoep", "bluf"}

// checkKeys checks the keys of the state of m, and of its options.
func checkKeys(t *testing.T, m *servertest.Msg, s *state) {
	t.Helper()
	want := slices.Clone(toepKeys)
	if len(s.Legal) > 0 {
		want = append(want, "legal", "rule")
	}
	if s.Phase == "lobby" {
		want = append(want, "roster")
	}
	servertest.WantKeys(t, s.Phase, m.S, want)
	servertest.WantKeys(t, s.Phase+" opts", servertest.Field(t, m.S, "opts"), optsKeys)
}

// playToepen plays c's decisions at random until game over and returns the
// toepen states seen, per phase, and the event types.
func playToepen(t *testing.T, c *servertest.Client, rng *rand.Rand) (map[string]*state, map[string]int) {
	t.Helper()
	phases := map[string]*state{}
	events := map[string]int{}
	var prev *state
	sent, wasIn := "", "" // the state last acted on, the time for a was we answered
	for {
		m := c.Next(10 * time.Second)
		if m.T == "error" && m.ErrMsg() != toepen.ErrNoStock.Error() { // a claim the bots' claims beat to the last cards
			t.Fatalf("error %s: %s", m.Code, m.ErrMsg())
		}
		if m.T != "update" {
			continue
		}
		s := toepS(t, m)
		if e := m.EvType(); e != "" {
			events[e]++
		}
		checkKeys(t, m, s)
		if prev != nil && prev.HandNo == s.HandNo {
			for k := range s.Points {
				// The boer takes a point off the winner of the last trick.
				boer := s.Tricks == s.Size && s.LastTrick != nil && s.LastTrick.Winner == cards.Seat(k)
				if s.Points[k] < prev.Points[k]-btoi(boer) {
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
		if s.Phase == "gameOver" {
			return phases, events
		}
		key := string(m.S) // decide once per state, and once on a was
		was := fmt.Sprint(s.HandNo, "/", s.WasRound)
		if s.Phase == phaseWas && wasIn == was {
			continue
		}
		if key != sent && toepTurn(c, s, rng) {
			sent = key
			if s.Phase == phaseWas {
				wasIn = was
			}
		}
	}
}

// checkOver checks a state at game over: one player left, the winner.
func checkOver(t *testing.T, over *state, players int) {
	t.Helper()
	limit := over.Opts.(map[string]any)["limit"].(float64)
	if over.Winner < 0 || float64(over.Points[over.Winner]) >= limit {
		t.Fatalf("winner %d with %v", over.Winner, over.Points)
	}
	left := 0
	for _, p := range over.Points {
		if float64(p) < limit {
			left++
		}
	}
	if left != 1 || len(over.Rounds) != over.HandNo || len(over.Players) != players {
		t.Errorf("left %d, rounds %d of %d", left, len(over.Rounds), over.HandNo)
	}
}

func TestToepenMatch(t *testing.T) {
	for _, players := range []int{2, 4, 6} {
		t.Run(fmt.Sprint(players, " spelers"), func(t *testing.T) {
			srv, ai := newToepServer(t)
			c := srv.Dial()
			c.Create("Jaap", map[string]any{"players": players, "seed": 4242}, true)
			phases, events := playToepen(t, c, rand.New(rand.NewPCG(uint64(players), 9)))
			checkOver(t, phases["gameOver"], players)
			for _, ph := range []string{phaseWas, phasePlay, "handEnd"} {
				if phases[ph] == nil {
					t.Errorf("never in phase %s", ph)
				}
			}
			for _, ev := range []string{"deal", "play", "trick", "collect", "handEnd", "gameOver"} {
				if events[ev] == 0 {
					t.Errorf("no event %s: %v", ev, events)
				}
			}
			// Six players leave a stock of eight: a short match may go without a claim.
			if players >= 4 && (events["toep"] == 0 || events["answer"] == 0 || players == 4 && events["claims"] == 0) {
				t.Errorf("no toep or was in a whole match: %v", events)
			}
			if ai.said("greet") == 0 {
				t.Errorf("bots never greeted")
			}
		})
	}
}

// A rematch starts a new match of toepen at the same table.
func TestToepenRematch(t *testing.T) {
	srv, _ := newToepServer(t)
	c := srv.Dial()
	c.Create("Jaap", map[string]any{"players": 3, "limit": 10}, true)
	playToepen(t, c, rand.New(rand.NewPCG(1, 2)))
	c.Send(map[string]any{"t": "rematch"})
	m := c.WaitEvent("deal")
	if s := toepS(t, m); s.HandNo != 1 || slices.Max(s.Points) != 0 || len(s.Rounds) != 0 {
		t.Errorf("rematch: round %d points %v", s.HandNo, s.Points)
	}
	// Back to the lobby after the match: a fresh table.
	playToepen(t, c, rand.New(rand.NewPCG(3, 4)))
	c.Send(map[string]any{"t": "lobby"})
	m = c.WaitEvent("lobby")
	if s := toepS(t, m); s.HandNo != 0 || slices.Max(s.Points) != 0 || len(s.Rounds) != 0 || s.Winner != -1 || len(s.Roster) == 0 {
		t.Errorf("lobby after a match: %s", m.S)
	}
}

// toepOpts is the options of a state.
func toepOpts(t *testing.T, m *servertest.Msg) map[string]any {
	t.Helper()
	var o map[string]any
	json.Unmarshal(servertest.Field(t, m.S, "opts"), &o)
	return o
}

func TestToepenLobby(t *testing.T) {
	srv, _ := newToepServer(t)
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 6}, false)
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"limit": 15, "was": false}})
	m := h.WaitEvent("lobby")
	s := toepS(t, m)
	checkKeys(t, m, s)
	if o := toepOpts(t, m); len(s.Players) != 6 || o["limit"] != 15.0 || o["was"] != false || o["armoede"] != true || len(s.Roster) != 8 {
		t.Fatalf("lobby %v", o)
	}
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	if g.Seat != 1 {
		t.Fatalf("guest at %d", g.Seat)
	}
	for _, tc := range []struct {
		opts map[string]any
		want string
	}{
		{map[string]any{"players": 7}, "Kies 2 tot en met 6 spelers."},
		{map[string]any{"players": 1}, "Kies 2 tot en met 6 spelers."},
		{map[string]any{"limit": 12}, "Speel tot 10 of tot 15 strafpunten."},
		{map[string]any{"was": nil}, "Ongeldige waarde voor was."},
		{map[string]any{"armoede": "ja"}, "Ongeldige waarde voor armoede."},
		{map[string]any{"tempo": "razend", "limit": 10}, "Onbekend tempo."},
		{map[string]any{"limit": 10, "players": 9}, "Kies 2 tot en met 6 spelers."},
	} {
		h.Send(map[string]any{"t": "opts", "opts": tc.opts})
		if m := h.WaitError("ongeldig"); m.ErrMsg() != tc.want {
			t.Errorf("opts %v: %q, want %q", tc.opts, m.ErrMsg(), tc.want)
		}
	}
	// All or nothing: the refused options changed nothing; klaverjas's
	// keys are none of toepen's.
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 5, "hands": 8, "trumpMode": "gedraaid", "game": "klaverjas", "lesson": "basis"}})
	m = h.WaitEvent("lobby")
	checkKeys(t, m, toepS(t, m))
	if o := toepOpts(t, m); o["players"] != 5.0 || o["limit"] != 15.0 || o["was"] != false || o["tempo"] != "normaal" {
		t.Errorf("opts after the refusals: %v", o)
	}
	h.Send(map[string]any{"t": "start"})
	m = h.WaitEvent("deal")
	if s := toepS(t, m); s.Phase != phaseWas && s.Phase != phasePlay || len(s.Hand) != 4 || s.Players[4] == nil || !s.Players[4].Bot {
		t.Errorf("started: phase %s hand %v", s.Phase, s.Hand)
	}
	// The messages of klaverjas are none of toepen's (discard and why are
	// toepen's too: the koningsspel, the reasoning of the AI).
	for _, typ := range []string{"trump", "handReview", "tipRead", "feedback", "bid", "auction"} {
		h.Send(map[string]any{"t": typ, "suit": "H", "hand": 1, "trick": 1})
		if m := h.WaitError("ongeldig"); m.ErrMsg() != "Dat bericht ken ik niet." {
			t.Errorf("%s in toepen: %q", typ, m.ErrMsg())
		}
	}
}

// A create keeps what it can of stale options: bad values are skipped.
func TestToepenLenientCreate(t *testing.T) {
	srv, _ := newToepServer(t)
	c := srv.Dial()
	c.Send(map[string]any{"t": "create", "name": "Jaap", "opts": map[string]any{
		"players": 7, "limit": 12, "was": nil, "armoede": false, "tempo": "snel", "ai": "sterk", "hands": 8, "game": "klaverjas"}})
	c.WaitType("joined")
	c.WaitType("chatlog")
	m := c.WaitType("update")
	checkKeys(t, m, toepS(t, m))
	if got := string(servertest.Field(t, m.S, "opts")); got != `{"players":4,"ai":"sterk","tempo":"snel","seed":0,"limit":10,"was":true,"armoede":false,"koning":true,"boer":true,"lijntoep":false,"bluf":true}` {
		t.Errorf("opts %s", got)
	}
	c2 := srv.Dial()
	c2.Send(map[string]any{"t": "create", "name": "Kees", "opts": "geen object"})
	c2.WaitType("joined")
	c2.WaitType("chatlog")
	if m := c2.WaitType("update"); string(servertest.Field(t, m.S, "opts")) != `{"players":4,"ai":"normaal","tempo":"normaal","seed":0,"limit":10,"was":true,"armoede":true,"koning":true,"boer":true,"lijntoep":false,"bluf":true}` {
		t.Errorf("defaults %s", servertest.Field(t, m.S, "opts"))
	}
}

// Training and the expert are klaverjas's: a create with either sets up
// an ordinary table of toepen.
func TestToepenTrainingAndExpert(t *testing.T) {
	srv, _ := newToepServer(t)
	c := srv.Dial()
	c.Create("Jaap", map[string]any{"players": 6}, true, map[string]any{"training": true})
	m := c.Until(5*time.Second, "the deal", func(m *servertest.Msg) bool { return m.T == "update" && m.EvType() == "deal" })
	s := toepS(t, m)
	checkKeys(t, m, s)
	if len(s.Players) != 6 || s.Phase != phaseWas && s.Phase != phasePlay {
		t.Errorf("training plays %s at %d", s.Phase, len(s.Players))
	}
	c.Send(map[string]any{"t": "answer"}) // one of toepen's messages, without its answer
	if m := c.WaitError("ongeldig"); m.ErrMsg() != "Kies meegaan of passen." {
		t.Errorf("answer at a table made for training: %q", m.ErrMsg())
	}
	e := srv.Dial()
	e.Create("Fatima", map[string]any{"players": 3}, false, map[string]any{"expert": true, "seat": 2})
	var es state
	json.Unmarshal(e.State, &es)
	if e.Seat != 0 || es.Phase != "lobby" || len(es.Players) != 3 {
		t.Errorf("expert: seat %d phase %s at %d", e.Seat, es.Phase, len(es.Players))
	}
	// The lobby is a lobby: others may join.
	g := srv.Dial()
	g.Join(e.Code, "Kees", "")
}

// A full table of six says so in words, as one of fewer seats.
func TestToepenFullTable(t *testing.T) {
	srv, _ := newToepServer(t)
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 6}, false)
	for k := range 5 {
		srv.Dial().Join(h.Code, fmt.Sprint("Gast", k), "")
	}
	m := srv.Dial().TryJoin(h.Code, "Te laat", "")
	if m.T != "error" || m.Code != "vol" || m.ErrMsg() != "Deze tafel is vol: alle zes de plaatsen zijn bezet." {
		t.Errorf("seventh: %s %s", m.Code, m.ErrMsg())
	}
	h2 := srv.Dial()
	h2.Create("Kees", map[string]any{"players": 2}, false)
	srv.Dial().Join(h2.Code, "Bram", "")
	m = srv.Dial().TryJoin(h2.Code, "Te laat", "")
	if m.ErrMsg() != "Deze tafel is vol: alle twee plaatsen zijn bezet. Vraag de host om bij Spelers een plaats bij te zetten en probeer het dan opnieuw." {
		t.Errorf("third at two: %s %s", m.Code, m.ErrMsg())
	}
}

// The host takes a table of six back to two in the lobby: humans keep a
// seat, bots go with theirs; with more humans than seats nothing changes.
func TestToepenSeats(t *testing.T) {
	srv, _ := newToepServer(t)
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 6}, false)
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	g.Send(map[string]any{"t": "sit", "seat": 5})
	h.Until(5*time.Second, "Kees at seat 5", func(m *servertest.Msg) bool {
		return m.T == "update" && toepS(t, m).Players[5] != nil && toepS(t, m).Players[5].Name == "Kees"
	})
	h.Send(map[string]any{"t": "bot", "seat": 3, "id": "bram"})
	h.Until(5*time.Second, "the bot", func(m *servertest.Msg) bool {
		return m.T == "update" && len(toepS(t, m).Players) == 6 && toepS(t, m).Players[3] != nil && toepS(t, m).Players[3].Bot
	})
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 2}})
	m := g.Until(5*time.Second, "two seats", func(m *servertest.Msg) bool { return m.T == "update" && len(toepS(t, m).Players) == 2 })
	s := toepS(t, m)
	if s.You != 1 || s.Players[0].Name != "Jaap" || s.Players[1].Name != "Kees" || s.Players[1].Bot {
		t.Errorf("two seats: %s", m.S)
	}
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 6}})
	m = h.Until(5*time.Second, "six seats", func(m *servertest.Msg) bool { return m.T == "update" && len(toepS(t, m).Players) == 6 })
	for _, p := range toepS(t, m).Players[2:] {
		if p != nil {
			t.Errorf("six seats again: %s", m.S)
		}
	}
	srv.Dial().Join(h.Code, "Bram", "")
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 2, "limit": 15}})
	if m := h.WaitError("ongeldig"); m.ErrMsg() != "Er zitten al 3 mensen aan tafel." {
		t.Errorf("three at two: %q", m.ErrMsg())
	}
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"armoede": false}})
	m = h.WaitEvent("lobby")
	if o := toepOpts(t, m); o["limit"] != 10.0 || o["players"] != 6.0 {
		t.Errorf("after the refusal: %v", o)
	}
}

// twoHumans seats Jaap and Kees at a table of two for toepen with opts and
// starts it; it returns both clients, the host first.
func twoHumans(t *testing.T, srv *servertest.Server, opts map[string]any) (*servertest.Client, *servertest.Client) {
	t.Helper()
	h := srv.Dial()
	o := map[string]any{"players": 2}
	for k, v := range opts {
		o[k] = v
	}
	h.Create("Jaap", o, false)
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	h.Send(map[string]any{"t": "start"})
	return h, g
}

// untilToep reads c's messages until its toepen state satisfies pred.
func untilToep(t *testing.T, c *servertest.Client, what string, pred func(*state) bool) *state {
	t.Helper()
	m := c.Until(10*time.Second, what, func(m *servertest.Msg) bool { return m.T == "update" && pred(toepS(t, m)) })
	return toepS(t, m)
}

func TestToepenToepAndPass(t *testing.T) {
	srv, _ := newToepServer(t)
	h, g := twoHumans(t, srv, map[string]any{"was": false, "armoede": false, "seed": 77})
	clients := []*servertest.Client{h, g}
	s := untilToep(t, h, "a turn", func(s *state) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	toeper := clients[s.Turn]
	other := clients[1-s.Turn]
	untilToep(t, toeper, "my turn", func(s *state) bool { return s.Turn == s.You && s.CanToep })
	toeper.Send(map[string]any{"t": "toep"})
	untilToep(t, other, "asked", func(s *state) bool { return s.Phase == phaseToep && s.Turn == s.You && s.Stake == 2 })
	toeper.Send(map[string]any{"t": "answer", "play": true})
	if m := toeper.WaitError("niet-jouw-beurt"); m.ErrMsg() != toepen.ErrNotYourTurn.Error() {
		t.Errorf("toeper answers: %q", m.ErrMsg())
	}
	other.Send(map[string]any{"t": "answer"})
	if m := other.WaitError("ongeldig"); m.ErrMsg() != "Kies meegaan of passen." {
		t.Errorf("answer without play: %q", m.ErrMsg())
	}
	other.Send(map[string]any{"t": "answer", "play": false})
	m := other.WaitEvent("handEnd")
	var row round
	b, _ := json.Marshal(m.Event()["result"])
	json.Unmarshal(b, &row)
	if row.Winner != cards.Seat(toeper.Seat) || row.Tricks || row.Gains[other.Seat] != 1 || row.Gains[toeper.Seat] != 0 {
		t.Errorf("round %+v", row)
	}
	if s := toepS(t, m); s.Points[other.Seat] != 1 || len(s.Rounds) != 1 || s.NextAt == 0 {
		t.Errorf("after: points %v rounds %d next %d", s.Points, len(s.Rounds), s.NextAt)
	}
}

func TestToepenWasCheck(t *testing.T) {
	srv, _ := newToepServer(t)
	h, g := twoHumans(t, srv, map[string]any{"armoede": false, "seed": 5})
	s := untilToep(t, h, "the time for a was", func(s *state) bool { return s.Phase == phaseWas && s.CanClaim })
	if s.NextAt == 0 || s.Turn != -1 {
		t.Fatalf("was: next %d turn %d", s.NextAt, s.Turn)
	}
	hand := s.Hand
	h.Send(map[string]any{"t": "was", "play": true})
	untilToep(t, g, "Jaap answered", func(s *state) bool { return s.Answered[0] && !s.Claims[0] })
	g.Send(map[string]any{"t": "was", "play": false})
	m := g.WaitEvent("claims")
	if seats, _ := m.Event()["seats"].([]any); len(seats) != 1 || seats[0] != float64(0) {
		t.Fatalf("claims %v", m.Event())
	}
	untilToep(t, g, "asked to check", func(s *state) bool { return s.Phase == phaseCheck && s.Turn == s.You && s.Claimant == 0 })
	g.Send(map[string]any{"t": "check", "play": true})
	m = g.WaitEvent("wasDone")
	var done evWasDone
	b, _ := json.Marshal(m.Event())
	json.Unmarshal(b, &done)
	genuine := toepen.Was(hand) != toepen.NoWas
	if done.Checker != 1 || done.Claimant != 0 || done.Genuine != genuine || !slices.Equal(toepen.SortHand(done.Cards), hand) {
		t.Fatalf("wasDone %+v, hand %v", done, hand)
	}
	s = toepS(t, m)
	switch {
	case genuine && (s.Points[1] != 1 || !s.Washed[0] || s.Status[0] != toepen.StatusIn):
		t.Errorf("genuine: points %v washed %v", s.Points, s.Washed)
	case !genuine && (s.Points[0] != 1 || s.Status[0] != toepen.StatusIn || len(s.Open[0]) != 4 || len(s.Open[1]) != 0):
		// Caught (rule bluf, the default): a point, and play on face up.
		t.Errorf("bluff: points %v status %v open %v", s.Points, s.Status, s.Open)
	}
	if len(s.Checks) != 1 {
		t.Errorf("checks %v", s.Checks)
	}
	if !genuine {
		s = untilToep(t, g, "play", func(s *state) bool { return s.Phase == phasePlay })
		if !slices.Equal(s.Open[0], hand) {
			t.Errorf("the open hand %v, the claimed %v", s.Open[0], hand)
		}
	}
}

// Without rule bluf the caught bluffer sits the round out.
func TestToepenBlufOff(t *testing.T) {
	srv, _ := newToepServer(t)
	h, g := twoHumans(t, srv, map[string]any{"armoede": false, "bluf": false, "seed": 5})
	s := untilToep(t, h, "the time for a was", func(s *state) bool { return s.Phase == phaseWas && s.CanClaim })
	if toepen.Was(s.Hand) != toepen.NoWas {
		t.Skip("seed 5 deals a real was now")
	}
	h.Send(map[string]any{"t": "was", "play": true})
	g.Send(map[string]any{"t": "was", "play": false})
	untilToep(t, g, "asked to check", func(s *state) bool { return s.Phase == phaseCheck && s.Turn == s.You })
	g.Send(map[string]any{"t": "check", "play": true})
	m := g.WaitEvent("handEnd") // two players, one caught: the round is over
	if s := toepS(t, m); s.Status[0] != toepen.StatusCaught || len(s.Open[0]) != 0 {
		t.Errorf("caught: status %v open %v", s.Status, s.Open)
	}
}

// The time for a was runs out for whoever does not answer.
func TestToepenWasTimesOut(t *testing.T) {
	srv, _ := newToepServer(t)
	h, g := twoHumans(t, srv, map[string]any{"armoede": false})
	untilToep(t, h, "the time for a was", func(s *state) bool { return s.Phase == phaseWas })
	s := untilToep(t, g, "play", func(s *state) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	if slices.Contains(s.Claims, true) || s.Stock != 24 {
		t.Errorf("claims %v stock %d", s.Claims, s.Stock)
	}
}

// No AI plays a human's seat at toepen without the others' consent.
func TestToepenTakeover(t *testing.T) {
	srv, _ := newToepServer(t)
	h, g := twoHumans(t, srv, map[string]any{"was": false, "armoede": false, "seed": 3})
	s := untilToep(t, h, "a turn", func(s *state) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	gone, stay := g, h
	if s.Turn == 0 {
		gone, stay = h, g
	}
	gone.Close()
	s = untilToep(t, stay, "the question", func(s *state) bool { return s.Takeover != nil })
	if int(s.Takeover.Seat) != gone.Seat || s.Turn != gone.Seat {
		t.Fatalf("takeover %+v turn %d", s.Takeover, s.Turn)
	}
	stay.Send(map[string]any{"t": "vote", "seat": gone.Seat, "ai": true})
	stay.WaitEvent("takeover")
	untilToep(t, stay, "the AI played", func(s *state) bool { return s.Turn == stay.Seat || s.Phase == "handEnd" })
}

// An answer to the time for a was that comes after it ran out is a late
// tap: no reply. So is the answer again.
func TestToepenLateWas(t *testing.T) {
	srv, _ := newToepServer(t)
	h, g := twoHumans(t, srv, map[string]any{"armoede": false, "was": true})
	untilToep(t, g, "the time for a was", func(s *state) bool { return s.Phase == phaseWas && s.NextAt != 0 })
	g.Send(map[string]any{"t": "was", "play": false})
	g.Send(map[string]any{"t": "was", "play": true}) // again
	untilToep(t, h, "play", func(s *state) bool { return s.Phase == phasePlay })
	h.Send(map[string]any{"t": "was", "play": true})
	for _, c := range []*servertest.Client{h, g} {
		c.Send(map[string]any{"t": "chat", "text": "hoi"})
		m := c.Until(5*time.Second, "the chat line", func(m *servertest.Msg) bool { return m.T == "chat" || m.T == "error" })
		if m.T == "error" {
			t.Errorf("late was: %s %s", m.Code, m.ErrMsg())
		}
	}
}

// Bots that panic or play cards they do not hold play a safe move instead,
// and the match finishes.
func TestToepenBadBots(t *testing.T) {
	ai := &testAI{brain: func(id string, seed uint64) Brain {
		if seed%2 == 0 {
			return panicBrain{}
		}
		return illegalBrain{}
	}}
	srv := servertest.Start(t, New(ai))
	c := srv.Dial()
	c.Create("Jaap", map[string]any{"players": 5, "seed": 11}, true)
	phases, _ := playToepen(t, c, rand.New(rand.NewPCG(7, 7)))
	checkOver(t, phases["gameOver"], 5)
}

type panicBrain struct{}

func (panicBrain) Was(toepen.View) bool             { panic("was") }
func (panicBrain) Check(toepen.View) bool           { panic("check") }
func (panicBrain) Toep(toepen.View) bool            { panic("toep") }
func (panicBrain) Overtoep(toepen.View) bool        { panic("overtoep") }
func (panicBrain) Discard(toepen.View) []cards.Card { panic("discard") }
func (panicBrain) Answer(toepen.View) bool          { panic("answer") }
func (panicBrain) Play(v toepen.View) cards.Card    { panic("play") }

// illegalBrain claims every was it may, checks every claim, never toeps
// and plays a card it does not hold.
type illegalBrain struct{}

func (illegalBrain) Was(toepen.View) bool               { return true }
func (illegalBrain) Check(toepen.View) bool             { return true }
func (illegalBrain) Toep(toepen.View) bool              { return false }
func (illegalBrain) Overtoep(toepen.View) bool          { return true }
func (illegalBrain) Discard(v toepen.View) []cards.Card { return v.Hand[:1] }
func (illegalBrain) Answer(toepen.View) bool            { return true }
func (illegalBrain) Play(v toepen.View) cards.Card {
	for _, c := range cards.NewDeck() {
		if !slices.Contains(v.Hand, c) {
			return c
		}
	}
	return cards.Card{}
}

// Without an AI of its own, toepen plays with plain bots.
func TestToepenPlain(t *testing.T) {
	srv := servertest.Start(t, New(nil))
	c := srv.Dial()
	c.Create("Jaap", map[string]any{"players": 6, "seed": 8}, false)
	if m := toepS(t, &servertest.Msg{S: c.State}); len(m.Roster) != 8 {
		t.Errorf("roster %d", len(m.Roster))
	}
	c.Send(map[string]any{"t": "start"})
	phases, _ := playToepen(t, c, rand.New(rand.NewPCG(8, 8)))
	checkOver(t, phases["gameOver"], 6)
}

func TestToepenGameLog(t *testing.T) {
	dir := t.TempDir()
	srv, _ := newToepServer(t, func(c *server.Config) { c.GameLog = dir; c.Version = "v1" })
	c := srv.Dial()
	c.Create("Jaap", map[string]any{"players": 3, "seed": 99}, true)
	playToepen(t, c, rand.New(rand.NewPCG(5, 5)))
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
	kinds := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("bad line %s", line)
		}
		raw := json.RawMessage(line)
		kind, _ := rec["t"].(string)
		kinds[kind]++
		switch kind {
		case "match":
			servertest.WantKeys(t, "match", raw, []string{"t", "match", "room", "at", "version", "game", "seed", "opts", "players"})
			servertest.WantKeys(t, "match opts", servertest.Field(t, raw, "opts"), optsKeys)
			if rec["game"] != "toepen" || rec["seed"] != 99.0 || rec["version"] != "v1" || len(rec["players"].([]any)) != 3 {
				t.Errorf("match %s", line)
			}
		case "round":
			servertest.WantKeys(t, "round", raw, []string{"t", "match", "at", "hand", "dealer", "cards", "acts", "result"})
			servertest.WantKeys(t, "round result", servertest.Field(t, raw, "result"),
				[]string{"hand", "dealer", "winner", "stake", "tricks", "boer", "koning", "gains", "points", "out"})
			if cards, _ := rec["cards"].([]any); len(cards) != 3 {
				t.Errorf("round cards %v", rec["cards"])
			}
		case "end":
			servertest.WantKeys(t, "end", raw, []string{"t", "match", "at", "total", "winner"})
		default:
			t.Errorf("record %s", line)
		}
	}
	if kinds["match"] != 1 || kinds["round"] == 0 || kinds["end"] != 1 {
		t.Errorf("log: %v", kinds)
	}
}

// New panics without enough personas for a full table.
func TestToepenNeedsPersonas(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("no panic with four personas")
		}
	}()
	server.New(server.Config{Game: New(fewAI{})})
}

type fewAI struct{ plainAI }

func (fewAI) Personas() []server.Persona { return plainAI{}.Personas()[:4] }

// The options, as the game log and the state show them.
func TestToepenOptions(t *testing.T) {
	o := defaultOptions()
	if err := o.Set(map[string]json.RawMessage{"limit": []byte("15"), "was": []byte("false"), "hands": []byte("8"), "lijntoep": []byte("true"), "boer": []byte("false")}, false); err != nil || *o != (Options{15, false, true, true, false, true, true}) {
		t.Fatalf("set: %v %+v", err, *o)
	}
	if err := o.Set(map[string]json.RawMessage{"limit": []byte("10"), "armoede": []byte("null")}, false); err == nil || *o != (Options{15, false, true, true, false, true, true}) {
		t.Errorf("all or nothing: %v %+v", err, *o)
	}
	if err := o.Set(map[string]json.RawMessage{"limit": []byte("10"), "armoede": []byte("null")}, true); err != nil || *o != (Options{10, false, true, true, false, true, true}) {
		t.Errorf("lenient: %v %+v", err, *o)
	}
	b, _ := json.Marshal(o.Wire(server.TableOpts{Players: 3, AI: "sterk", Tempo: "snel", Seed: 5}))
	if string(b) != `{"players":3,"ai":"sterk","tempo":"snel","seed":5,"limit":10,"was":false,"armoede":true,"koning":true,"boer":false,"lijntoep":true,"bluf":true}` {
		t.Errorf("wire %s", b)
	}
	if v := o.variant(); v != "toepen tot 10 strafpunten, met armoede, koningsspel en anti-lijntoep" {
		t.Errorf("variant %q", v)
	}
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// explainAI explains every decision the same way, and counts the asks.
type explainAI struct {
	testAI
	asked atomic.Int32
}

// NewBrain gives plain bots: they never toep, so the test's own turn to
// play comes without a question first.
func (a *explainAI) NewBrain(string, string, uint64) Brain { return plainBrain{} }

func (a *explainAI) Explain(v toepen.View, seed uint64) Explanation {
	a.asked.Add(1)
	return Explanation{Decision: string(v.Phase), Advice: "Speel maar", Why: "Omdat het kan.", Chance: 0.5,
		Options: []WhyOption{{Label: "Iets", Value: 0.5, Best: true}}}
}

// The reasoning of the AI: for your own decision now, alone with bots,
// in your state only; never at a table with other people.
func TestToepenWhy(t *testing.T) {
	ai := &explainAI{}
	srv := servertest.Start(t, New(ai))
	c := srv.Dial()
	c.Create("Jaap", map[string]any{"players": 3, "was": false, "armoede": false, "seed": 12}, true)
	s := untilToep(t, c, "a turn of someone", func(s *state) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	if s.Turn != s.You {
		c.Send(map[string]any{"t": "why"})
		if m := c.WaitError("ongeldig"); m.ErrMsg() != "Je bent nu niet aan zet." {
			t.Errorf("not your turn: %q", m.ErrMsg())
		}
		s = untilToep(t, c, "my turn", func(s *state) bool { return s.Phase == phasePlay && s.Turn == s.You })
	}
	if s.Why != nil {
		t.Fatal("a why unasked")
	}
	c.Send(map[string]any{"t": "why"})
	s = untilToep(t, c, "the why", func(s *state) bool { return s.Why != nil })
	if s.Why.Advice != "Speel maar" || s.Why.Decision != "play" || len(s.Why.Options) != 1 || ai.asked.Load() != 1 {
		t.Errorf("why %+v", s.Why)
	}
	c.Send(map[string]any{"t": "play", "card": s.Legal[0].String()})
	if s = untilToep(t, c, "the card played", func(s *state) bool { return s.Turn != s.You || s.Tricks > 0 }); s.Why != nil {
		t.Error("the why outlives its decision")
	}
	// With another person at the table: no reasoning.
	h, g := twoHumans(t, srv, map[string]any{"was": false, "armoede": false})
	clients := []*servertest.Client{h, g}
	s = untilToep(t, h, "a turn", func(s *state) bool { return s.Phase == phasePlay && s.Turn >= 0 })
	clients[s.Turn].Send(map[string]any{"t": "why"})
	if m := clients[s.Turn].WaitError("ongeldig"); m.ErrMsg() != "De redenering van de AI kun je alleen opvragen als je zonder andere mensen speelt." {
		t.Errorf("with friends: %q", m.ErrMsg())
	}
	// Without an AI that explains.
	plain := servertest.Start(t, New(nil)).Dial()
	plain.Create("Jaap", map[string]any{"players": 2, "was": false}, true)
	untilToep(t, plain, "my turn", func(s *state) bool { return s.Phase == phasePlay && s.Turn == s.You })
	plain.Send(map[string]any{"t": "why"})
	if m := plain.WaitError("ongeldig"); m.ErrMsg() != "Aan deze tafel kan de AI geen redenering geven." {
		t.Errorf("plain: %q", m.ErrMsg())
	}
}
