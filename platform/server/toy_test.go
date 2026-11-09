package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"jannie/platform/cards"
	"jannie/platform/server"
	"jannie/platform/server/servertest"
)

// The toy game, hoogste kaart, proves the API of package server without
// any real game, and is the template for one: everyone gets one card a
// round, lays it in turn from the round's first player, and the highest
// card (by rank, then suit) takes a point. After the option rounds (1–3)
// the most points win.

type toy struct{}

var toyPersonas = []server.Persona{
	{ID: "aap", Name: "Aap", Emoji: "🐒", Color: "#8a5a2b", Bio: "Aap.", Chattiness: 1, Speed: 1},
	{ID: "noot", Name: "Noot", Emoji: "🌰", Color: "#c2477a", Bio: "Noot.", Chattiness: 1, Speed: 1},
	{ID: "mies", Name: "Mies", Emoji: "🐈", Color: "#e07b24", Bio: "Mies.", Chattiness: 1, Speed: 1},
}

func (toy) Name() string                        { return "hoogste kaart" }
func (toy) Seats() (int, int, int)              { return 2, 3, 2 }
func (toy) Personas() []server.Persona          { return slices.Clone(toyPersonas) }
func (toy) NewOptions() server.GameOptions      { return &toyOpts{Rounds: 2} }
func (toy) NewBrain(string, string, uint64) any { return toyBrain{} }
func (toy) New(t *server.Table) server.Play     { return &toyPlay{t: t} }

func (toy) Chat(id string, ev server.ChatEvent, rng *rand.Rand) string {
	if ev.Kind == "greet" {
		return "Hallo, ik ben " + id + "."
	}
	return ""
}

type toyOpts struct{ Rounds int }

func (o *toyOpts) Set(fields map[string]json.RawMessage, lenient bool) error {
	v, ok := fields["rounds"]
	if !ok {
		return nil
	}
	var n int
	if json.Unmarshal(v, &n) != nil || n < 1 || n > 3 {
		if lenient {
			return nil
		}
		return errors.New("Speel 1, 2 of 3 rondes.")
	}
	o.Rounds = n
	return nil
}

type toyWire struct {
	Players int    `json:"players"`
	AI      string `json:"ai"`
	Tempo   string `json:"tempo"`
	Seed    int    `json:"seed"`
	Rounds  int    `json:"rounds"`
}

func (o *toyOpts) Wire(t server.TableOpts) any {
	return toyWire{Players: t.Players, AI: t.AI, Tempo: t.Tempo, Seed: t.Seed, Rounds: o.Rounds}
}

// toyBrain lays its card: there is nothing else to do.
type toyBrain struct{}

func (toyBrain) play(c cards.Card) cards.Card { return c }

const stepShow server.Step = 1 // the round's cards lie open

type toyPlay struct {
	t      *server.Table
	round  int
	hands  []cards.Card // this round's card per seat
	table  []cards.Played
	turn   cards.Seat
	points []int
}

type toyState struct {
	server.Shared
	Round  int            `json:"round"`
	Hand   []cards.Card   `json:"hand"`
	Table  []cards.Played `json:"table"`
	Points []int          `json:"points"`
	Winner int            `json:"winner"`
}

type toyEv struct {
	Type   string     `json:"type"`
	Seat   cards.Seat `json:"seat"`
	Card   cards.Card `json:"card"`
	Winner cards.Seat `json:"winner"`
}

func (p *toyPlay) rounds() int { return p.t.Options().(*toyOpts).Rounds }

func (p *toyPlay) Start() {
	p.points = make([]int, p.t.Players())
	p.t.SysChat("Hoogste kaart begint: %d rondes.", p.rounds())
	p.t.Later(p.t.Pace().Deal, func() { p.t.SysChat("Succes!") })
	p.deal()
}

func (p *toyPlay) deal() {
	n := p.t.Players()
	p.round++
	p.t.SetHand(p.round)
	deck := cards.NewDeck()
	p.t.Deals().Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })
	p.hands, p.table = deck[:n], []cards.Played{}
	p.turn = cards.Seat((p.round - 1) % n)
	p.t.SetPhase("play")
	p.t.OpenTurn()
	p.t.Emit(toyEv{Type: "deal", Seat: p.turn})
}

func (p *toyPlay) Turn() cards.Seat {
	if p.hands == nil || len(p.table) == len(p.hands) {
		return cards.NoSeat
	}
	return p.turn
}

func (p *toyPlay) laid(i cards.Seat) bool {
	return slices.ContainsFunc(p.table, func(c cards.Played) bool { return c.Seat == i })
}

func (p *toyPlay) HandLen(i cards.Seat) int {
	if p.hands == nil || p.laid(i) {
		return 0
	}
	return 1
}

func (p *toyPlay) State(i cards.Seat) any {
	s := toyState{Shared: p.t.Shared(i), Round: p.round, Hand: []cards.Card{}, Table: p.table, Points: p.points, Winner: -1}
	if s.Table == nil {
		s.Table = []cards.Played{}
	}
	if s.Points == nil {
		s.Points = make([]int, p.t.Players())
	}
	if p.t.InHand() && !p.laid(i) {
		s.Hand = []cards.Card{p.hands[i]}
	}
	if s.Phase == "gameOver" {
		s.Winner = top(p.points)
	}
	return s
}

func (p *toyPlay) Move(i cards.Seat, m server.Msg) error {
	if m.T != "play" {
		return server.ErrUnknownMsg
	}
	var b struct{ Card string }
	json.Unmarshal(m.Raw, &b)
	c, err := cards.ParseCard(b.Card)
	if err != nil {
		return errors.New("Die kaart bestaat niet.")
	}
	return p.Apply(i, c)
}

func (p *toyPlay) Decision(i cards.Seat, brain any) (func() any, any) {
	c := p.hands[i]
	return func() any { return brain.(toyBrain).play(c) }, c
}

func (p *toyPlay) Apply(i cards.Seat, a any) error {
	c, _ := a.(cards.Card)
	switch {
	case !p.t.InHand() || p.hands == nil:
		return errors.New("Dat kan nu niet.")
	case p.t.Pending() != 0:
		return server.ErrPaused
	case i != p.Turn():
		return server.NotYourTurn(errors.New("Wacht op je beurt."))
	case c != p.hands[i]:
		return errors.New("Die kaart heb je niet.")
	}
	p.table = append(p.table, cards.Played{Seat: i, Card: c})
	ev := toyEv{Type: "play", Seat: i, Card: c, Winner: cards.NoSeat}
	if len(p.table) < len(p.hands) {
		p.turn = (p.turn + 1) % cards.Seat(len(p.hands))
		p.t.OpenTurn()
		p.t.Emit(ev)
		return nil
	}
	p.t.Trick()
	p.t.Pause(stepShow, p.t.Pace().Trick)
	p.t.Emit(ev)
	return nil
}

func (p *toyPlay) Single() bool { return true }

func (p *toyPlay) Resume(s server.Step) {
	if s != stepShow {
		return
	}
	w := p.table[0]
	for _, c := range p.table[1:] {
		if c.Card.Rank > w.Card.Rank || c.Card.Rank == w.Card.Rank && c.Card.Suit > w.Card.Suit {
			w = c
		}
	}
	p.points[w.Seat]++
	p.t.BotSay(w.Seat, server.ChatEvent{Kind: "wonRound", Mine: true}, time.Millisecond)
	p.t.Summary(toyEv{Type: "handEnd", Seat: w.Seat, Card: w.Card, Winner: w.Seat}, p.t.Pace().Summary)
}

func (p *toyPlay) Next() {
	if p.round < p.rounds() {
		p.deal()
		return
	}
	p.t.GameOver(p.points, top(p.points))
}

func (p *toyPlay) Variant() string { return "hoogste kaart" }

// top is the seat with the most points, -1 for a draw.
func top(points []int) int {
	best, shared := -1, false
	for k, n := range points {
		switch {
		case best < 0 || n > points[best]:
			best, shared = k, false
		case n == points[best]:
			shared = true
		}
	}
	if shared {
		return -1
	}
	return best
}

var toyKeys = append(slices.Clone(servertest.SharedKeys), "round", "hand", "table", "points", "winner")

// decodeToy decodes the toy state of an update.
func decodeToy(t *testing.T, m *servertest.Msg) toyState {
	t.Helper()
	var s toyState
	if err := json.Unmarshal(m.S, &s); err != nil {
		t.Fatalf("bad state %s: %v", m.S, err)
	}
	return s
}

// playToy plays the started match of h (and g, another human at the
// table, or nil) to game over, checking every state of h; it returns the
// last one and the events seen.
func playToy(t *testing.T, h, g *servertest.Client) (toyState, map[string]int) {
	t.Helper()
	events := map[string]int{}
	acted := map[int]int{} // seat → the seq of the update it last played on
	for {
		m := h.Next(5 * time.Second)
		if m.T == "error" {
			t.Fatalf("error %s: %s", m.Code, m.ErrMsg())
		}
		if _, _, text, _, sys := m.Chat(); m.T == "chat" && sys && text == "Succes!" {
			events["later"]++ // Table.Later
		}
		if m.T != "update" {
			continue
		}
		events[m.EvType()]++
		s := decodeToy(t, m)
		if want := slices.Clone(toyKeys); s.Phase == "lobby" {
			servertest.WantKeys(t, s.Phase, m.S, append(want, "roster"))
		} else {
			servertest.WantKeys(t, s.Phase, m.S, want)
		}
		if s.Phase == "gameOver" {
			if g != nil {
				g.Until(5*time.Second, "game over", func(m *servertest.Msg) bool {
					return m.T == "update" && decodeToy(t, m).Phase == "gameOver"
				})
			}
			return s, events
		}
		switch {
		case s.Turn == s.You && len(s.Hand) == 1 && acted[s.You] < m.Seq:
			acted[s.You] = m.Seq
			h.Send(map[string]any{"t": "play", "card": s.Hand[0].String()})
		case g != nil && s.Turn == g.Seat && acted[g.Seat] < m.Seq:
			gm := g.Until(5*time.Second, "Kees's turn", func(gm *servertest.Msg) bool {
				if gm.T != "update" || gm.Seq < m.Seq {
					return false
				}
				gs := decodeToy(t, gm)
				return gs.Turn == gs.You && len(gs.Hand) == 1
			})
			acted[g.Seat] = gm.Seq
			g.Send(map[string]any{"t": "play", "card": decodeToy(t, gm).Hand[0].String()})
		}
	}
}

// TestToyGame plays a match of the toy game: two humans and a bot.
func TestToyGame(t *testing.T) {
	srv := servertest.Start(t, toy{})
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3, "rounds": 3, "hands": 8, "seed": 7}, false)
	servertest.WantKeys(t, "lobby", h.State, append(slices.Clone(toyKeys), "roster"))
	servertest.WantKeys(t, "opts", servertest.Field(t, h.State, "opts"), []string{"players", "ai", "tempo", "seed", "rounds"})
	var s toyState
	json.Unmarshal(h.State, &s)
	if len(s.Players) != 3 || s.Phase != "lobby" || len(s.Roster) != 3 || s.Turn != -1 {
		t.Fatalf("lobby: %s", h.State)
	}
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	h.Send(map[string]any{"t": "start"})
	over, events := playToy(t, h, g)
	if sum(over.Points) != 3 || over.Round != 3 || over.Winner != top(over.Points) {
		t.Errorf("game over: %+v", over)
	}
	for _, ev := range []string{"deal", "play", "handEnd", "gameOver", "later"} {
		if events[ev] == 0 {
			t.Errorf("no event %s: %v", ev, events)
		}
	}
	// A rematch is a new match: points from 0.
	h.Send(map[string]any{"t": "rematch"})
	m := h.WaitEvent("deal")
	if s := decodeToy(t, m); s.Round != 1 || sum(s.Points) != 0 {
		t.Errorf("rematch: %s", m.S)
	}
}

func sum(xs []int) (n int) {
	for _, x := range xs {
		n += x
	}
	return n
}

// TestToyMessages: the table's messages and options around the toy game,
// and the errors of its own.
func TestToyMessages(t *testing.T) {
	srv := servertest.Start(t, toy{})
	h := srv.Dial()
	// Training is klaverjas's: the ordinary game; bad values are skipped.
	h.Create("Jaap", map[string]any{"players": 9, "rounds": 9, "tempo": "snel"}, false, map[string]any{"training": true})
	var s toyState
	json.Unmarshal(h.State, &s)
	if len(s.Players) != 2 || string(servertest.Field(t, h.State, "opts")) != `{"players":2,"ai":"normaal","tempo":"snel","seed":0,"rounds":2}` {
		t.Fatalf("lenient create: %s", servertest.Field(t, h.State, "opts"))
	}
	for _, tc := range []struct {
		opts map[string]any
		want string
	}{
		{map[string]any{"players": 4}, "Kies 2 tot en met 3 spelers."},
		{map[string]any{"players": 1}, "Kies 2 tot en met 3 spelers."},
		{map[string]any{"rounds": 0, "players": 3}, "Speel 1, 2 of 3 rondes."}, // all or nothing
		{map[string]any{"ai": "geweldig", "rounds": 1}, "Onbekend niveau voor de AI."},
	} {
		h.Send(map[string]any{"t": "opts", "opts": tc.opts})
		if m := h.WaitError("ongeldig"); m.ErrMsg() != tc.want {
			t.Errorf("opts %v: %q, want %q", tc.opts, m.ErrMsg(), tc.want)
		}
	}
	h.Send(map[string]any{"t": "play", "card": "AS"})
	if m := h.WaitError("ongeldig"); m.ErrMsg() != "Dat kan nu niet." {
		t.Errorf("play in the lobby: %q", m.ErrMsg())
	}
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 3, "rounds": 1, "trumpMode": "gedraaid"}})
	m := h.WaitEvent("lobby")
	if string(servertest.Field(t, m.S, "opts")) != `{"players":3,"ai":"normaal","tempo":"snel","seed":0,"rounds":1}` {
		t.Errorf("opts: %s", servertest.Field(t, m.S, "opts"))
	}
	for _, typ := range []string{"trump", "why", "handReview", "tipRead", "feedback", "toep"} {
		h.Send(map[string]any{"t": typ, "suit": "H"})
		if m := h.WaitError("ongeldig"); m.ErrMsg() != "Dat bericht ken ik niet." {
			t.Errorf("%s: %q", typ, m.ErrMsg())
		}
	}
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	h.Send(map[string]any{"t": "start"})
	m = g.WaitEvent("deal")
	s = decodeToy(t, m)
	if s.Phase != "play" || len(s.Hand) != 1 || !s.Players[2].Bot || s.Turn != 0 {
		t.Fatalf("started: %s", m.S)
	}
	g.Send(map[string]any{"t": "play", "card": s.Hand[0].String()})
	if m := g.WaitError("niet-jouw-beurt"); m.ErrMsg() != "Wacht op je beurt." {
		t.Errorf("not my turn: %q", m.ErrMsg())
	}
	g.Send(map[string]any{"t": "play", "card": "nee"})
	if m := g.WaitError("ongeldig"); m.ErrMsg() != "Die kaart bestaat niet." {
		t.Errorf("no card: %q", m.ErrMsg())
	}
	over, _ := playToy(t, h, g)
	if sum(over.Points) != 1 {
		t.Errorf("one round, points %v", over.Points)
	}
}

// toyTable is the toy game with tables of its own kind (server.Opener),
// chosen by the create message's "tafel": "oefen" opens a fixed table of
// three, the creator at seat 1 between Mies and Noot, and starts at once;
// "vast" is the same table with a lobby; "open" starts at once with Mies
// at a table that is not fixed; "mis" is an Opening the table must partly
// leave out; anything else an ordinary room. Its Play also asks for coach
// lines and messages to one seat.
type toyTable struct{ toy }

var toyOpens atomic.Int32 // calls of toyTable.Open

// toyLocked is the toy's text for a joiner of a fixed table, with the
// number of rounds: Open sees the options create set.
const toyLocked = "Dit is een oefentafel van %d rondes; daar kun je niet aan meedoen."

func (toyTable) Open(m server.Msg, o server.GameOptions) server.Opening {
	toyOpens.Add(1)
	var c struct{ Tafel string }
	json.Unmarshal(m.Raw, &c)
	locked := fmt.Sprintf(toyLocked, o.(*toyOpts).Rounds)
	switch c.Tafel {
	case "oefen": // seat 3 is off the table
		return server.Opening{Seat: 1, Bots: []string{"mies", "", "noot", "aap"}, Start: true, Locked: locked}
	case "vast":
		return server.Opening{Seat: 1, Bots: []string{"mies", "", "noot"}, Locked: locked}
	case "open":
		return server.Opening{Seat: 1, Bots: []string{"mies"}, Start: true}
	case "mis": // a seat off the table, a bot on the creator's seat, a bot twice
		return server.Opening{Seat: 5, Bots: []string{"noot", "aap", "aap", "mies"}}
	}
	return server.Opening{}
}

func (toyTable) New(t *server.Table) server.Play { return &toyTablePlay{&toyPlay{t: t}} }

type toyTablePlay struct{ *toyPlay }

// Move handles two messages besides play: uitleg, three coach lines of the
// bot after the asking seat (and one each for the asking seat and a seat
// off the table, which the table drops); stuur, a
// message of type text to seat (three texts send something else: "los" a
// bare string, "kanaal" what does not marshal, "veld" a struct whose
// field T has no tag, so its key is "T").
func (p *toyTablePlay) Move(i cards.Seat, m server.Msg) error {
	var b struct {
		Seat int
		Text string
	}
	json.Unmarshal(m.Raw, &b)
	switch m.T {
	case "uitleg":
		n := cards.Seat(p.t.Players())
		for k := range 3 {
			p.t.CoachChat((i+1)%n, fmt.Sprintf("Uitleg %d.", k+1))
		}
		p.t.CoachChat(i, "Ikzelf.")
		p.t.CoachChat(n, "Niemand.")
		return nil
	case "stuur":
		var msg any = map[string]any{"t": b.Text, "from": i}
		switch b.Text {
		case "los":
			msg = "los"
		case "kanaal":
			msg = map[string]any{"t": "kanaal", "c": make(chan int)}
		case "veld":
			msg = struct {
				T    string
				From cards.Seat `json:"from"`
			}{"veld", i}
		}
		if !p.t.Send(cards.Seat(b.Seat), msg) {
			return errors.New("Niet verstuurd.")
		}
		return nil
	}
	return p.toyPlay.Move(i, m)
}

// toyThree is the toy game at one table size, three.
type toyThree struct{ toy }

func (toyThree) Seats() (int, int, int) { return 3, 3, 3 }

// toyLine is a chat line with its coach mark.
type toyLine struct {
	Seat            int
	Name, Text      string
	Bot, Sys, Coach bool
}

func decodeLine(t *testing.T, raw json.RawMessage) toyLine {
	t.Helper()
	var l toyLine
	if err := json.Unmarshal(raw, &l); err != nil {
		t.Fatalf("bad chat line %s: %v", raw, err)
	}
	return l
}

// wantBots checks the bots of the fixed toy table: Mies at seat 0, Noot
// at 2, and the human Jaap at 1.
func wantBots(t *testing.T, what string, s toyState) {
	t.Helper()
	p := s.Players
	if len(p) != 3 || p[0] == nil || p[0].BotID != "mies" || p[2] == nil || p[2].BotID != "noot" || p[1] == nil || p[1].Bot || p[1].Name != "Jaap" {
		t.Errorf("%s: players %+v %+v %+v", what, p[0], p[1], p[2])
	}
}

// TestToyOpener: a game opens a fixed table of its own (server.Opener):
// the creator's seat, bots on chosen seats, the match at once; nobody
// else joins, it never goes back to the lobby, a rematch keeps its bots,
// and its own player gets back in by the seat token and by name.
func TestToyOpener(t *testing.T) {
	srv := servertest.Start(t, toyTable{})
	opens := toyOpens.Load()
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3, "rounds": 1}, false, map[string]any{"tafel": "oefen"})
	if h.Seat != 1 {
		t.Fatalf("creator at seat %d", h.Seat)
	}
	m := h.WaitEvent("deal")
	s := decodeToy(t, m)
	wantBots(t, "opened", s)
	if s.Host != 1 || s.You != 1 || s.Phase != "play" {
		t.Errorf("opened: %s", m.S)
	}
	locked := fmt.Sprintf(toyLocked, 1)
	g := srv.Dial()
	if e := g.TryJoin(h.Code, "Kees", ""); e.T != "error" || e.Code != "vol" || e.ErrMsg() != locked {
		t.Errorf("join a fixed table: %s", e.Raw)
	}
	playToy(t, h, nil)
	// After game over too, and nobody is told: no refused for the host and
	// no line in the chat before the host's own line that follows.
	if e := srv.Dial().TryJoin(h.Code, "Kees", ""); e.T != "error" || e.Code != "vol" || e.ErrMsg() != locked {
		t.Errorf("join after game over: %s", e.Raw)
	}
	h.Send(map[string]any{"t": "chat", "text": "stuur"})
	h.Until(5*time.Second, "own chat", func(m *servertest.Msg) bool {
		_, _, text, _, sys := m.Chat()
		switch {
		case m.T == "refused":
			t.Errorf("the host is told of a refused joiner: %s", m.Raw)
		case m.T == "chat" && sys && strings.Contains(text, "wilde aanschuiven"):
			t.Errorf("a refused joiner in the chat: %q", text)
		}
		return m.T == "chat" && !sys && text == "stuur"
	})
	h.Send(map[string]any{"t": "lobby"})
	if e := h.WaitError("ongeldig"); e.ErrMsg() != "Deze tafel ligt vast." {
		t.Errorf("lobby: %q", e.ErrMsg())
	}
	h.Send(map[string]any{"t": "rematch"})
	wantBots(t, "rematch", decodeToy(t, h.WaitEvent("deal")))

	// Its player comes back with the seat token...
	h.Close()
	h2 := srv.Dial()
	h2.Join(h.Code, "Jaap", h.Token)
	if h2.Seat != 1 {
		t.Errorf("back by token at seat %d", h2.Seat)
	}
	// ...and by name once the seat has been empty for 3 minutes; not
	// before, and nobody else by another name.
	h2.Close()
	if e := srv.Dial().TryJoin(h.Code, "Jaap", ""); e.T != "error" || e.Code != "vol" {
		t.Errorf("by name at once: %s", e.Raw)
	}
	time.Sleep(time.Duration(float64(3*time.Minute) * servertest.Scale))
	if e := srv.Dial().TryJoin(h.Code, "Kees", ""); e.T != "error" || e.ErrMsg() != locked {
		t.Errorf("another name: %s", e.Raw)
	}
	// The 3 minutes count from when the server saw h2 go: try again for a
	// while rather than trust one sleep.
	var n *servertest.Client
	for deadline := time.Now().Add(5 * time.Second); ; {
		n = srv.Dial()
		e := n.TryJoin(h.Code, "Jaap", "")
		if e.T == "joined" {
			n.WaitType("chatlog")
			n.WaitType("update")
			break
		}
		if e.Code != "vol" || time.Now().After(deadline) {
			t.Fatalf("back by name: %s", e.Raw)
		}
		n.Close()
		time.Sleep(50 * time.Millisecond)
	}
	if n.Seat != 1 || n.Token == h.Token {
		t.Errorf("back by name at seat %d", n.Seat)
	}
	if e := srv.Dial().TryJoin(h.Code, "Jaap", h.Token); e.T != "error" || e.Code != "onbekend" {
		t.Errorf("the old token: %s", e.Raw)
	}
	// A seat its player left is no exception: not for the same name, which
	// an open table gives it back to, nor for another. The join on n's own
	// connection is handled after its leave.
	n.Send(map[string]any{"t": "leave"})
	if e := n.TryJoin(h.Code, "Jaap", ""); e.T != "error" || e.ErrMsg() != locked {
		t.Errorf("back after leave: %s", e.Raw)
	}
	if e := srv.Dial().TryJoin(h.Code, "Kees", ""); e.T != "error" || e.ErrMsg() != locked {
		t.Errorf("a seat its player left: %s", e.Raw)
	}
	if got := toyOpens.Load() - opens; got != 1 {
		t.Errorf("Open called %d times", got)
	}
}

// TestToyLockedLobby: a fixed table with a lobby refuses every command
// that changes the table, but not the other options.
func TestToyLockedLobby(t *testing.T) {
	srv := servertest.Start(t, toyTable{})
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3, "rounds": 2}, false, map[string]any{"tafel": "vast"})
	s := decodeToy(t, &servertest.Msg{S: h.State})
	wantBots(t, "lobby", s)
	if s.Phase != "lobby" || s.Host != 1 {
		t.Fatalf("lobby: %s", h.State)
	}
	if e := srv.Dial().TryJoin(h.Code, "Kees", ""); e.T != "error" || e.Code != "vol" || e.ErrMsg() != fmt.Sprintf(toyLocked, 2) {
		t.Errorf("join: %s", e.Raw)
	}
	for _, m := range []map[string]any{
		{"t": "sit", "seat": 0},
		{"t": "bot", "seat": 0, "id": "aap"},
		{"t": "bot", "seat": 2},
		{"t": "unbot", "seat": 2},
		{"t": "opts", "opts": map[string]any{"players": 2, "rounds": 3}},
	} {
		h.Send(m)
		if e := h.WaitError("ongeldig"); e.ErrMsg() != "Deze tafel ligt vast." {
			t.Errorf("%v: %q", m, e.ErrMsg())
		}
	}
	// The same number of players and other options do; the refused opts
	// changed nothing (rounds 2).
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 3, "tempo": "snel"}})
	m := h.WaitEvent("lobby")
	if string(servertest.Field(t, m.S, "opts")) != `{"players":3,"ai":"normaal","tempo":"snel","seed":0,"rounds":2}` {
		t.Errorf("opts: %s", servertest.Field(t, m.S, "opts"))
	}
	wantBots(t, "after opts", decodeToy(t, m))
	h.Send(map[string]any{"t": "start"})
	over, _ := playToy(t, h, nil)
	if over.Round != 2 {
		t.Errorf("rounds %d", over.Round)
	}
	h.Send(map[string]any{"t": "lobby"})
	if e := h.WaitError("ongeldig"); e.ErrMsg() != "Deze tafel ligt vast." {
		t.Errorf("lobby: %q", e.ErrMsg())
	}
	h.Send(map[string]any{"t": "rematch"})
	wantBots(t, "rematch", decodeToy(t, h.WaitEvent("deal")))
}

// TestToyOpening: the zero Opening is an ordinary room, and the table
// leaves out what of an Opening it cannot do (the creator then at seat
// 0).
func TestToyOpening(t *testing.T) {
	srv := servertest.Start(t, toyTable{})
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3}, false)
	s := decodeToy(t, &servertest.Msg{S: h.State})
	if h.Seat != 0 || s.Phase != "lobby" || s.Players[1] != nil || s.Players[2] != nil {
		t.Errorf("ordinary room: %s", h.State)
	}
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	h.Send(map[string]any{"t": "bot", "seat": 2})
	h.WaitEvent("lobby")

	h = srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3}, false, map[string]any{"tafel": "mis"})
	s = decodeToy(t, &servertest.Msg{S: h.State})
	if p := s.Players; h.Seat != 0 || p[0] == nil || p[0].Name != "Jaap" || p[1] == nil || p[1].BotID != "aap" || p[2] != nil {
		t.Errorf("partial opening: %s", h.State)
	}
	g = srv.Dial()
	g.Join(h.Code, "Kees", "")
	if g.Seat != 2 {
		t.Errorf("joined at seat %d", g.Seat)
	}

	// At a table that is not fixed, the Opening's bot stays in the lobby
	// after game over, as a bot placed there does; the seat a bot filled
	// at the start is free again.
	h = srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3, "rounds": 1}, false, map[string]any{"tafel": "open"})
	s = decodeToy(t, h.WaitEvent("deal"))
	if p := s.Players; h.Seat != 1 || p[0] == nil || p[0].BotID != "mies" || p[2] == nil || !p[2].Bot {
		t.Errorf("opened: %+v %+v %+v", p[0], p[1], p[2])
	}
	playToy(t, h, nil)
	h.Send(map[string]any{"t": "lobby"})
	s = decodeToy(t, h.WaitEvent("lobby"))
	if p := s.Players; p[0] == nil || p[0].BotID != "mies" || p[1] == nil || p[1].Name != "Jaap" || p[2] != nil {
		t.Errorf("back in the lobby: %+v %+v %+v", p[0], p[1], p[2])
	}
	g = srv.Dial()
	g.Join(h.Code, "Kees", "")
	if g.Seat != 2 {
		t.Errorf("joined the lobby at seat %d", g.Seat)
	}
}

// TestToyCoachChat: coach lines of a bot go out as many as the game says,
// marked coach, and stay so in the chat log; none goes in a human's name or
// for a seat off the table, and other lines have no coach key.
func TestToyCoachChat(t *testing.T) {
	srv := servertest.Start(t, toyTable{})
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3, "rounds": 1}, false, map[string]any{"tafel": "oefen"})
	h.WaitEvent("deal")
	h.Send(map[string]any{"t": "uitleg"})
	h.Send(map[string]any{"t": "stuur", "seat": 1, "text": "klaar"}) // after the room handled uitleg
	var coach []toyLine
	h.Until(5*time.Second, "klaar", func(m *servertest.Msg) bool {
		if m.T == "chat" {
			switch l := decodeLine(t, m.Msg); {
			case l.Coach:
				coach = append(coach, l)
			case strings.Contains(string(m.Msg), "coach"), l.Text == "Ikzelf." || l.Text == "Niemand.":
				t.Errorf("a line not of the coach: %s", m.Msg)
			}
		}
		return m.T == "klaar"
	})
	if len(coach) != 3 {
		t.Fatalf("coach lines %+v", coach)
	}
	for k, l := range coach {
		if want := (toyLine{Seat: 2, Name: "Noot (AI)", Text: fmt.Sprintf("Uitleg %d.", k+1), Bot: true, Coach: true}); l != want {
			t.Errorf("coach line %+v, want %+v", l, want)
		}
	}
	h2 := srv.Dial()
	h2.Keep = true
	h2.Join(h.Code, "Jaap", h.Token)
	n := 0
	for _, m := range h2.Kept {
		if m.T != "chatlog" {
			continue
		}
		var log struct{ Msgs []json.RawMessage }
		json.Unmarshal(m.Raw, &log)
		for _, raw := range log.Msgs {
			if decodeLine(t, raw).Coach {
				n++
			}
		}
	}
	if n != 3 {
		t.Errorf("%d coach lines in the chat log", n)
	}
}

// TestToySend: a message of the game's own goes to one seat's human only;
// to a bot, an empty seat, a seat off the table or a human who dropped out
// it does not go, nor a message with a type of the table's or none.
func TestToySend(t *testing.T) {
	srv := servertest.Start(t, toyTable{})
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 3}, false)
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	h.Send(map[string]any{"t": "stuur", "seat": 1, "text": "notitie"})
	if m := g.WaitType("notitie"); string(m.Raw) != `{"from":0,"t":"notitie"}` {
		t.Errorf("to Kees: %s", m.Raw)
	}
	h.Send(map[string]any{"t": "stuur", "seat": 0, "text": "zelf"})
	h.Until(5*time.Second, "own message", func(m *servertest.Msg) bool {
		if m.T == "notitie" {
			t.Errorf("Kees's message to Jaap: %s", m.Raw)
		}
		return m.T == "zelf"
	})
	refuse := func(seat int, typ string) {
		t.Helper()
		h.Send(map[string]any{"t": "stuur", "seat": seat, "text": typ})
		m := h.Until(5*time.Second, "refusal", func(m *servertest.Msg) bool {
			if strings.Contains(string(m.Raw), `"from"`) {
				t.Errorf("seat %d, %q sent: %s", seat, typ, m.Raw)
			}
			return m.T == "error"
		})
		if m.Code != "ongeldig" || m.ErrMsg() != "Niet verstuurd." {
			t.Errorf("seat %d, %q: %s", seat, typ, m.Raw)
		}
	}
	for _, typ := range []string{"joined", "update", "chat", "chatlog", "refused", "rtc", "error", "pong", "", "los", "kanaal", "veld"} {
		refuse(0, typ)
	}
	for _, seat := range []int{2, 3, -1} { // an empty seat, off the table
		refuse(seat, "notitie")
	}
	h.Send(map[string]any{"t": "bot", "seat": 2})
	h.WaitEvent("lobby")
	refuse(2, "notitie") // a bot
	g.Close()
	h.WaitEvent("away")
	refuse(1, "notitie")
}

// TestToySingleSize: a game of one table size says so when asked for
// another.
func TestToySingleSize(t *testing.T) {
	srv := servertest.Start(t, toyThree{})
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"players": 2}, false) // skipped
	if s := decodeToy(t, &servertest.Msg{S: h.State}); len(s.Players) != 3 {
		t.Fatalf("players %d", len(s.Players))
	}
	for _, n := range []int{2, 4} {
		h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": n}})
		if e := h.WaitError("ongeldig"); e.ErrMsg() != "Dit spel speel je met 3 spelers." {
			t.Errorf("players %d: %q", n, e.ErrMsg())
		}
	}
	h.Send(map[string]any{"t": "opts", "opts": map[string]any{"players": 3, "rounds": 1}})
	m := h.WaitEvent("lobby")
	if string(servertest.Field(t, m.S, "opts")) != `{"players":3,"ai":"normaal","tempo":"normaal","seed":0,"rounds":1}` {
		t.Errorf("opts: %s", servertest.Field(t, m.S, "opts"))
	}
}

// toyLate is the toy game with work that outlives its moment. Its Play
// handles four messages besides play, each answered with a message of
// the same type to the sender: werk starts a Background job named text
// that waits for its gate, which the test closes, and then says
// "Klaar: <text>." in the chat; denk lets the next seat's bot Think the
// same way and then says "Gedacht: <text>."; huidig keeps Table.Current
// under text for the test; schrijf answers with text cleaned by
// server.CleanText to at most 12 characters. Its last Next asks for a
// Later that speaks after GameOver.
type toyLate struct {
	toy
	gates *sync.Map // job name → chan struct{}: the job ends once it is closed
	live  *sync.Map // name → the func of Table.Current
}

func newToyLate() toyLate { return toyLate{gates: &sync.Map{}, live: &sync.Map{}} }

func (g toyLate) New(t *server.Table) server.Play { return &toyLatePlay{&toyPlay{t: t}, g} }

// gate is the gate of the job name.
func (g toyLate) gate(name string) chan struct{} {
	c, _ := g.gates.LoadOrStore(name, make(chan struct{}))
	return c.(chan struct{})
}

// current is the func of Table.Current that huidig kept under name.
func (g toyLate) current(t *testing.T, name string) func() bool {
	t.Helper()
	f, ok := g.live.Load(name)
	if !ok {
		t.Fatalf("no Current kept under %q", name)
	}
	return f.(func() bool)
}

type toyLatePlay struct {
	*toyPlay
	g toyLate
}

func (p *toyLatePlay) Move(i cards.Seat, m server.Msg) error {
	var b struct{ Text string }
	json.Unmarshal(m.Raw, &b)
	switch m.T {
	case "werk":
		gate := p.g.gate(b.Text)
		p.t.Background(func() any { <-gate; return b.Text }, func(a any) { p.t.SysChat("Klaar: %s.", a) })
	case "denk":
		gate, next := p.g.gate(b.Text), (i+1)%cards.Seat(p.t.Players())
		p.t.Think(next, func(any) any { <-gate; return b.Text }, func(a any) { p.t.SysChat("Gedacht: %s.", a) })
	case "huidig":
		p.g.live.Store(b.Text, p.t.Current())
	case "schrijf":
		b.Text = server.CleanText(b.Text, 12)
	default:
		return p.toyPlay.Move(i, m)
	}
	p.t.Send(i, map[string]any{"t": m.T, "text": b.Text})
	return nil
}

func (p *toyLatePlay) Next() {
	if p.round >= p.rounds() {
		p.t.Later(0, func() { p.t.SysChat("Na het spel.") })
	}
	p.toyPlay.Next()
}

// waitSys waits for the table's chat line text.
func waitSys(t *testing.T, c *servertest.Client, text string) {
	t.Helper()
	c.Until(5*time.Second, text, func(m *servertest.Msg) bool {
		_, _, got, _, sys := m.Chat()
		return m.T == "chat" && sys && got == text
	})
}

// TestToyAfterGameOver: Later, Background and Think call back after game
// over, which ends nothing for them; a rematch or the lobby does.
func TestToyAfterGameOver(t *testing.T) {
	g := newToyLate()
	srv := servertest.Start(t, g)
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"rounds": 1}, true)
	h.Keep = true
	// The room handles werk after create's start and before any card of
	// h: job A belongs to the match.
	h.Send(map[string]any{"t": "werk", "text": "A"})
	playToy(t, h, nil)
	// The Later the last Next asked for before GameOver comes after it.
	waitSys(t, h, "Na het spel.")
	close(g.gate("A"))
	waitSys(t, h, "Klaar: A.")
	// A thinking job holds the bot's brain until its gate closes, so each
	// denk comes once the bot has no card left to lay.
	h.Send(map[string]any{"t": "denk", "text": "D"})
	h.WaitType("denk")
	close(g.gate("D"))
	waitSys(t, h, "Gedacht: D.")

	// Jobs B and E of the match that a rematch replaced, and C and F of
	// the one the lobby replaced, get no answer.
	h.Send(map[string]any{"t": "werk", "text": "B"})
	h.WaitType("werk")
	h.Send(map[string]any{"t": "denk", "text": "E"})
	h.WaitType("denk")
	h.Send(map[string]any{"t": "rematch"})
	h.Send(map[string]any{"t": "werk", "text": "C"})
	playToy(t, h, nil)
	waitSys(t, h, "Na het spel.") // before lobby replaces the match
	h.Send(map[string]any{"t": "denk", "text": "F"})
	h.WaitType("denk")
	close(g.gate("B"))
	close(g.gate("E"))
	h.Send(map[string]any{"t": "lobby"})
	h.WaitEvent("lobby")
	close(g.gate("C"))
	close(g.gate("F"))
	// An answer that came would come at once (Think's after a think time
	// of a few milliseconds): B's and E's had the whole of the lobby's
	// round trip, C's and F's get this wait. The API has no hook for a
	// dropped answer, so on a slow machine this check can pass falsely,
	// never fail falsely.
	time.Sleep(250 * time.Millisecond)
	h.Send(map[string]any{"t": "chat", "text": "klaar"})
	h.Until(5*time.Second, "own chat", func(m *servertest.Msg) bool {
		_, _, text, _, sys := m.Chat()
		return m.T == "chat" && !sys && text == "klaar"
	})
	n := 0
	for _, m := range h.Kept {
		switch _, _, text, _, sys := m.Chat(); {
		case m.T != "chat" || !sys:
		case text == "Klaar: B." || text == "Klaar: C." || text == "Gedacht: E." || text == "Gedacht: F.":
			t.Errorf("an answer of a replaced match: %q", text)
		case text == "Na het spel.":
			n++
		}
	}
	if n != 2 {
		t.Errorf("%d Later lines after 2 matches", n)
	}
}

// TestToyCurrent: the func of Table.Current, called off the room
// goroutine, holds through game over and turns false once the match is
// replaced (by a new match, a rematch or the lobby) or the room closes.
func TestToyCurrent(t *testing.T) {
	g := newToyLate()
	srv := servertest.Start(t, g)
	h := srv.Dial()
	h.Create("Jaap", map[string]any{"rounds": 1}, false)
	h.Send(map[string]any{"t": "huidig", "text": "lobby"})
	h.WaitType("huidig")
	lobby := g.current(t, "lobby")
	if !lobby() {
		t.Fatal("the lobby is not current")
	}
	// Another goroutine asks all along; the race detector watches it.
	stop := make(chan struct{})
	var asked sync.WaitGroup
	asked.Go(func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				lobby()
			}
		}
	})
	defer func() { close(stop); asked.Wait() }()

	// Each huidig is handled after the command before it and before the
	// first card of h, so it belongs to the match that command started.
	h.Send(map[string]any{"t": "start"})
	h.Send(map[string]any{"t": "huidig", "text": "1"})
	playToy(t, h, nil)
	first := g.current(t, "1")
	if lobby() || !first() {
		t.Errorf("at game over: lobby %v, match %v", lobby(), first())
	}
	h.Send(map[string]any{"t": "rematch"})
	h.Send(map[string]any{"t": "huidig", "text": "2"})
	playToy(t, h, nil)
	second := g.current(t, "2")
	if first() || !second() {
		t.Errorf("after the rematch: first %v, second %v", first(), second())
	}
	h.Send(map[string]any{"t": "lobby"})
	h.WaitEvent("lobby")
	if second() {
		t.Error("the match is current in the lobby")
	}
	h.Send(map[string]any{"t": "huidig", "text": "terug"})
	h.WaitType("huidig")
	back := g.current(t, "terug")
	if !back() {
		t.Fatal("the lobby again is not current")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	if back() {
		t.Error("current after the room closed")
	}
}

// TestToyCleanText: server.CleanText cleans a game's own text line by line
// as the table cleans chat, at most limit characters in all.
func TestToyCleanText(t *testing.T) {
	for _, tc := range []struct {
		in    string
		limit int
		want  string
	}{
		{"  Mooi spel.\r\n\n\t Maar  ♠A\tdaar?  ", 2000, "Mooi spel.\nMaar ♠A daar?"},
		{"\u200b\n\u3164\n \u2800 \n\u0301", 100, ""},
		{"hoi 👋\u200d\nH" + strings.Repeat("\u0300", 9), 100, "hoi 👋\nH\u0300\u0300\u0300"},
		{"gg\U000E0067\U000E0062\n(AI) mag", 100, "gg\n(AI) mag"},
		{"abc\ndef", 5, "abc\nd"}, // the newline counts
		{"abc\ndef", 4, "abc"},
		{"abc\ndef", 3, "abc"},
		{"abc def", 5, "abc d"},
		{"👩\u200d🏫\nx", 2, "👩"}, // never a joiner without what it joins
		{"abc", 0, ""},
		{"abc", -1, ""},
	} {
		if got := server.CleanText(tc.in, tc.limit); got != tc.want {
			t.Errorf("CleanText(%q, %d) = %q, want %q", tc.in, tc.limit, got, tc.want)
		}
	}
	// Random text: within the limit, no empty or padded line, and clean
	// text stays as it is.
	parts := []string{"a", "é", " ", "\t", "\n", "\r\n", "\u200b", "\u200d", "\u0301", "👩", "\u3164", "\x00", "\xff"}
	rng := rand.New(rand.NewPCG(5, 6))
	for range 20000 {
		var b strings.Builder
		for range rng.IntN(30) {
			b.WriteString(parts[rng.IntN(len(parts))])
		}
		in, limit := b.String(), rng.IntN(25)
		out := server.CleanText(in, limit)
		if n := utf8.RuneCountInString(out); n > limit || !utf8.ValidString(out) {
			t.Fatalf("CleanText(%q, %d) = %q: %d characters", in, limit, out, n)
		}
		for _, l := range strings.Split(out, "\n") {
			if out != "" && (l == "" || strings.TrimSpace(l) != l) {
				t.Fatalf("CleanText(%q, %d) = %q: line %q", in, limit, out, l)
			}
		}
		if again := server.CleanText(out, limit); again != out {
			t.Fatalf("CleanText(%q, %d) = %q, then %q", in, limit, out, again)
		}
	}

	// One line is cleaned as the table cleans a chat line; a game's Move
	// cleans its own text with it.
	g := newToyLate()
	srv := servertest.Start(t, g)
	h := srv.Dial()
	h.Create("Jaap", nil, false)
	for _, in := range []string{"  hallo\tdaar  ", "hoi 👋\u200d", "gg\U000E0067\U000E0062", strings.Repeat("ab ", 100)} {
		h.Send(map[string]any{"t": "chat", "text": in})
		m := h.Until(5*time.Second, "own chat", func(m *servertest.Msg) bool {
			_, _, _, _, sys := m.Chat()
			return m.T == "chat" && !sys
		})
		if _, _, text, _, _ := m.Chat(); text != server.CleanText(in, 200) {
			t.Errorf("chat %q: %q, CleanText %q", in, text, server.CleanText(in, 200))
		}
	}
	h.Send(map[string]any{"t": "schrijf", "text": " Een\n\n\u200bzin  van\tvier woorden"})
	var got struct{ Text string }
	json.Unmarshal(h.WaitType("schrijf").Raw, &got)
	if got.Text != "Een\nzin van" { // 3 + 1 + 7: no space at the cut
		t.Errorf("schrijf: %q", got.Text)
	}
}
