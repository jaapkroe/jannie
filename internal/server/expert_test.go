package server

import (
	"encoding/json"
	"math/rand/v2"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"klaverjas/internal/game"
)

// TestParseAct: every kind of decision reads back from its token.
func TestParseAct(t *testing.T) {
	card := func(s string) game.Card { return game.MustParseCards(s)[0] }
	for _, tc := range []struct {
		seat game.Seat
		a    action
	}{
		{2, action{kind: actPlay, card: card("AS")}},
		{3, action{kind: actPlay, card: card("TH")}}, // a 10, not a trump choice
		{1, action{kind: actBid, play: true}},
		{3, action{kind: actBid}},
		{0, action{kind: actTrump, suit: game.Hearts}},
		{1, action{kind: actAuction, bid: 90}},
		{2, action{kind: actAuction}},
		{0, action{kind: actDiscard, cards: [2]game.Card{card("JS"), card("7H")}}},
	} {
		tok := actToken(tc.seat, tc.a)
		seat, a, err := parseAct(tok)
		if err != nil || seat != tc.seat || a != tc.a {
			t.Errorf("%q: seat %v, %+v, %v; want seat %v, %+v", tok, seat, a, err, tc.seat, tc.a)
		}
	}
	for _, bad := range []string{"", "0", "4AS", "0tX", "0b2", "0dAS", "0ZZ", "0a9x"} {
		if _, _, err := parseAct(bad); err == nil {
			t.Errorf("%q reads as a decision", bad)
		}
	}
}

// TestExpertFrom: option from deals that one hand of the seed, with its
// dealer, cards and turned suit, as the whole match deals it, numbered as
// in the whole match; the match is that hand alone. Outside the expert
// mode the option does not hold.
func TestExpertFrom(t *testing.T) {
	s, _, _ := newTestServer(t)
	whole := newRoom(s, "TEST")
	defer whole.stop()
	whole.seats[0] = newHuman("A")
	whole.opts.Seed = 77
	whole.opts.TrumpMode = game.Gedraaid
	whole.startMatch()
	whole.startHand()
	whole.startHand()

	one := newRoom(s, "TEST")
	defer one.stop()
	one.seats[0] = newHuman("A")
	one.expert = true
	one.opts.Seed, one.opts.From, one.opts.Hands = 77, 3, 4
	one.opts.TrumpMode = game.Gedraaid
	one.startMatch()
	if !slices.ContainsFunc(one.chat, func(m chatMsg) bool {
		return m.Sys && m.Text == "Spel (77) begint: potje 3, Gedraaid/Amsterdams. Veel plezier!"
	}) {
		t.Errorf("no start line in %+v", one.chat)
	}
	if one.handNo != 3 || one.lastHand() != 3 || whole.handNo != 3 || whole.lastHand() != 16 {
		t.Errorf("hand %d of %d, whole match: hand %d of %d", one.handNo, one.lastHand(), whole.handNo, whole.lastHand())
	}
	a, b := whole.dealt, one.dealt
	if a.dealer != b.dealer || a.turned != b.turned {
		t.Errorf("dealer %v, turned %v; with from: %v, %v", a.dealer, a.turned, b.dealer, b.turned)
	}
	for i := range a.hands {
		if !slices.Equal(a.hands[i], b.hands[i]) {
			t.Errorf("seat %d: %v, with from %v", i, a.hands[i], b.hands[i])
		}
	}

	one.opts.From, one.opts.Hands = 22, 16
	one.expertOpts()
	if one.opts.Hands != 24 {
		t.Errorf("hand 22 in a match of %d", one.opts.Hands)
	}
	whole.opts.From = 3
	whole.expertOpts()
	if whole.opts.From != 0 {
		t.Errorf("option from %d outside the expert mode", whole.opts.From)
	}
}

// TestExpertMatch plays an expert match: it starts at once, alone against
// three bots, with open cards, and nobody can join. The state shows the
// hand in play with the decisions before the first card and, per card,
// what its player could play. The expert asks the reasoning for a bot's
// card and for their own decision now, gives their own choice for the
// bot's card and comments on it; at game over the state has every hand,
// and the game log the match, the choice and the comment.
func TestExpertMatch(t *testing.T) {
	dir := t.TempDir()
	srv, ts, ai := newTestServer(t, func(s *Server) { s.games = newGameLog(dir, s.log) })
	c := dial(t, ts)
	c.send(map[string]any{"t": "create", "name": "Expert", "expert": true,
		"opts": map[string]any{"hands": 4, "seed": 4242, "open": true, "players": 2, "trumpMode": "gedraaid"}})
	c.waitType("joined")
	c.waitType("chatlog")
	s := c.waitState("the deal", func(s *state) bool { return s.Phase != phaseLobby })
	if s.Expert == nil || s.Training || len(s.Players) != 4 || !s.Opts.Open || s.Opts.Seed != 4242 {
		t.Fatalf("expert %+v, training %v, %d players, opts %+v", s.Expert, s.Training, len(s.Players), s.Opts)
	}
	for k := 1; k < 4; k++ {
		if !s.Players[k].Bot {
			t.Errorf("seat %d: %+v", k, s.Players[k])
		}
	}
	other := dial(t, ts)
	other.send(map[string]any{"t": "join", "code": c.code, "name": "Gast"})
	other.waitError(errFull)

	// On: until the expert's turn to play, after a bot's card in this hand.
	botCard := func(s *state) (int, game.Played, bool) {
		if s == nil || s.Expert == nil || len(s.Expert.Hands) != 1 {
			return 0, game.Played{}, false
		}
		for k, tr := range s.Expert.Hands[0].Tricks {
			for _, p := range tr.Cards {
				if p.Seat != 0 {
					return k + 1, p, true
				}
			}
		}
		return 0, game.Played{}, false
	}
	drive(t, func() bool {
		_, _, ok := botCard(c.s)
		return ok && c.s.Phase == phasePlay && c.myTurn()
	}, c)
	s = c.s
	hand := s.Expert.Hands[0]
	var played []game.Played
	for _, tr := range hand.Tricks {
		played = append(played, tr.Cards...)
	}
	if hand.Hand != s.HandNo || len(hand.Pre) == 0 || len(hand.Legal) != len(played) {
		t.Fatalf("hand %d (in play %d): %d decisions before play, %d legal sets for %d cards", hand.Hand, s.HandNo, len(hand.Pre), len(hand.Legal), len(played))
	}
	for k, p := range played {
		if !slices.Contains(hand.Legal[k], p.Card) || !slices.Contains(hand.Cards[p.Seat], p.Card) {
			t.Errorf("card %d: %v of seat %v, legal %v, dealt %v", k, p.Card, p.Seat, hand.Legal[k], hand.Cards[p.Seat])
		}
	}
	trick, bot, _ := botCard(s)
	legal := hand.Legal[slices.Index(played, bot)]

	why := func(args map[string]any) whyMsg {
		t.Helper()
		c.send(map[string]any{"t": "why", "hand": hand.Hand, "trick": args["trick"], "seat": args["seat"]})
		m := c.until(5*time.Second, "why", func(m *msg) bool { return m.T == "why" || m.T == "error" })
		if m.T == "error" {
			t.Fatalf("why %v: %s", args, m.errMsg())
		}
		var w whyMsg
		if err := json.Unmarshal(m.raw, &w); err != nil {
			t.Fatal(err)
		}
		return w
	}
	w := why(map[string]any{"trick": trick, "seat": int(bot.Seat)})
	if w.Played == nil || w.Played.Card == nil || *w.Played.Card != bot.Card || w.Seat != bot.Seat || w.Trick != trick ||
		len(w.Options) != len(legal) || w.Hint.Card == nil || *w.Hint.Card != legal[0] || w.Worlds != 1 {
		t.Errorf("why %v of seat %v in trick %d (legal %v): %+v", bot.Card, bot.Seat, trick, legal, w)
	}
	now := len(played)/4 + 1
	w = why(map[string]any{"trick": now})
	if w.Played != nil || w.Seat != 0 || len(w.Options) != len(s.Legal) || w.Rule == "" {
		t.Errorf("why now (trick %d, legal %v): %+v", now, s.Legal, w)
	}
	if n := ai.reasoned.Load(); n != 2 {
		t.Errorf("%d explanations, want 2", n)
	}
	c.send(map[string]any{"t": "why", "hand": hand.Hand, "trick": 8, "seat": 1})
	c.waitError(errInvalid)

	// The expert's own choice for the bot's card, and a card it could not play.
	own := legal[len(legal)-1]
	c.send(map[string]any{"t": "mark", "hand": hand.Hand, "trick": trick, "seat": int(bot.Seat), "card": own.String()})
	s = c.waitState("the mark", func(s *state) bool { return s.Expert != nil && len(s.Expert.Marks) == 1 })
	if m := s.Expert.Marks[0]; m.Hand != hand.Hand || m.Trick != trick || m.Seat != bot.Seat || m.Card == nil || *m.Card != own {
		t.Errorf("mark %+v, want %v for seat %v in trick %d", m, own, bot.Seat, trick)
	}
	for _, x := range hand.Cards[(bot.Seat+1)%4] {
		if !slices.Contains(legal, x) {
			c.send(map[string]any{"t": "mark", "hand": hand.Hand, "trick": trick, "seat": int(bot.Seat), "card": x.String()})
			c.waitError(errInvalid)
			break
		}
	}
	c.send(map[string]any{"t": "feedback", "text": "Waarom niet hoger?", "hand": hand.Hand, "trick": trick, "seat": int(bot.Seat)})
	c.waitType("saved")

	playGame(t, rand.New(rand.NewPCG(31, 32)), 4, c)
	s = c.s
	if len(s.Expert.Hands) != 4 || len(s.Expert.Marks) != 1 {
		t.Fatalf("game over: %d hands, marks %+v", len(s.Expert.Hands), s.Expert.Marks)
	}
	for k, rh := range s.Expert.Hands {
		if rh.Hand != k+1 || len(rh.Legal) != 32 || len(rh.Pre) == 0 || len(rh.Tricks) != 8 {
			t.Errorf("hand %d: number %d, %d legal sets, %d decisions before play, %d tricks", k+1, rh.Hand, len(rh.Legal), len(rh.Pre), len(rh.Tricks))
		}
	}

	srv.games.close()
	recs := readGameLog(t, filepath.Join(dir, "games-"+time.Now().UTC().Format("2006-01")+".jsonl"))
	kinds := map[string]int{}
	for _, r := range recs {
		kinds[r["t"].(string)]++
		switch r["t"] {
		case "match":
			var m logMatch
			remarshal(t, r, &m)
			if !m.Expert || m.Seed != 4242 {
				t.Errorf("match record %+v", m)
			}
		case "mark":
			var m logMark
			remarshal(t, r, &m)
			if m.Seat != 0 || m.By != int(bot.Seat) || m.Hand != hand.Hand || m.Trick != trick || m.Played == nil || *m.Played.Card != bot.Card || *m.Mark.Card != own {
				t.Errorf("mark record %+v", m)
			}
		case "feedback":
			var f logFeedback
			remarshal(t, r, &f)
			if f.By == nil || *f.By != int(bot.Seat) || f.Hand != hand.Hand || f.Trick != trick {
				t.Errorf("feedback record %+v", f)
			}
		}
	}
	if kinds["match"] != 1 || kinds["mark"] != 1 || kinds["feedback"] != 1 {
		t.Errorf("records %v", kinds)
	}
}

// TestExpertMarkBid: the expert gives their own choice for a bid (here
// passen, where seat 3 played); a seat that did not bid has no bid to give
// one for.
func TestExpertMarkBid(t *testing.T) {
	dir := t.TempDir()
	s, _, _ := newTestServer(t, func(s *Server) { s.games = newGameLog(dir, s.log) })
	r := newRoom(s, "TEST")
	defer r.stop()
	r.expert = true
	r.seats[0] = newHuman("A")
	r.opts.TrumpMode = game.Gedraaid
	r.phase = phaseGameOver
	r.matchID = "m1"
	r.firstHand = 1
	r.handDealt = []dealtCards{{dealer: 0, hands: game.Shuffle(rand.New(rand.NewPCG(3, 4))), turned: game.Hearts}}
	r.handActs = []string{"1b0 2b0 3b1"}
	c := newClient(s, nil, "1.2.3.4", "test")
	hand, trick, play := 1, 0, false
	for _, seat := range []int{3, 0} {
		r.cmdMark(c, 0, &inMsg{Hand: &hand, Trick: &trick, Seat: &seat, Play: &play})
	}
	got, ok := r.marks[markKey{hand: 1, trick: 0, seat: 3}]
	if !ok || got.Play == nil || *got.Play || len(r.marks) != 1 {
		t.Errorf("marks %+v", r.marks)
	}
	s.games.close()
	recs := readGameLog(t, filepath.Join(dir, "games-"+time.Now().UTC().Format("2006-01")+".jsonl"))
	if len(recs) != 1 || recs[0]["t"] != "mark" {
		t.Fatalf("log %v", recs)
	}
	var m logMark
	remarshal(t, recs[0], &m)
	if m.Seat != 0 || m.By != 3 || m.Played == nil || m.Played.Play == nil || !*m.Played.Play || m.Mark.Play == nil || *m.Mark.Play {
		t.Errorf("mark record %+v (played %+v)", m, m.Played)
	}
}

// gateAI is the fake AI whose explanations wait for the gate; it counts
// the most that ran at once.
type gateAI struct {
	fakeAI
	gate          chan struct{}
	mu            sync.Mutex
	running, most int
}

func (a *gateAI) Explain(v game.View) Explanation {
	a.mu.Lock()
	a.running++
	a.most = max(a.most, a.running)
	a.mu.Unlock()
	<-a.gate
	a.mu.Lock()
	a.running--
	a.mu.Unlock()
	return a.fakeAI.Explain(v)
}

// TestWhyOneAtATime: the expert's why runs one search at a time over all
// rooms, as each takes every core, and a room that asks again meanwhile
// gets limiet.
func TestWhyOneAtATime(t *testing.T) {
	ai := &gateAI{gate: make(chan struct{})}
	s, _ := newTestServerWith(t, ai)
	c := newClient(s, nil, "1.2.3.4", "test")
	hand, trick, seat := 1, 0, 3
	ask := func(r *room) { r.cmdWhy(c, 0, &inMsg{Hand: &hand, Trick: &trick, Seat: &seat}) }
	var rooms []*room
	for _, code := range []string{"WHYA", "WHYB"} {
		r := newRoom(s, code)
		defer r.stop()
		r.expert, r.phase = true, phaseGameOver
		r.seats[0] = newHuman("A")
		r.opts.TrumpMode = game.Gedraaid
		r.firstHand = 1
		r.handDealt = []dealtCards{{dealer: 0, hands: game.Shuffle(rand.New(rand.NewPCG(3, 4))), turned: game.Hearts}}
		r.handActs = []string{"1b0 2b0 3b1"}
		ask(r) // why seat 3 played
		rooms = append(rooms, r)
	}
	running := func() int {
		ai.mu.Lock()
		defer ai.mu.Unlock()
		return ai.running
	}
	waitFor(t, "a search", func() bool { return running() > 0 })
	time.Sleep(20 * time.Millisecond) // time for a second one to start, were it let in
	ask(rooms[0])
	var m struct{ T, Code string }
	if err := json.Unmarshal(<-c.out, &m); err != nil || m.Code != errLimit {
		t.Errorf("a second why in the room: %+v %v", m, err)
	}
	close(ai.gate)
	waitFor(t, "both explanations", func() bool { return ai.reasoned.Load() == 2 })
	ai.mu.Lock()
	defer ai.mu.Unlock()
	if ai.most != 1 {
		t.Errorf("%d searches at once", ai.most)
	}
}
