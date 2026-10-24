package server

import (
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"klaverjas/internal/game"
)

// gradeAI is the fake AI that remembers every grade it gives, per seat.
// With a gate, every grade waits until the gate is closed.
type gradeAI struct {
	fakeAI
	gate   chan struct{}
	mu     sync.Mutex
	grades map[game.Seat][]gradeRec
}

type gradeRec struct {
	v game.View
	c Choice
	g Grade
}

func newGradeAI(gated bool) *gradeAI {
	a := &gradeAI{grades: make(map[game.Seat][]gradeRec)}
	if gated {
		a.gate = make(chan struct{})
	}
	return a
}

func (a *gradeAI) Grade(v game.View, c Choice) Grade {
	if a.gate != nil {
		<-a.gate
	}
	g := a.fakeAI.Grade(v, c)
	a.mu.Lock()
	a.grades[v.Seat] = append(a.grades[v.Seat], gradeRec{v, c, g})
	a.mu.Unlock()
	return g
}

// wantReview is the review the grades of seat i add up to.
func (a *gradeAI) wantReview(i game.Seat) reviewState {
	a.mu.Lock()
	defer a.mu.Unlock()
	var w reviewState
	var stake, lost float64
	for _, r := range a.grades[i] {
		w.Choices++
		stake += r.g.Stake
		lost += r.g.Lost
		best := 0
		if r.g.Lost == 0 {
			best = 1
		}
		switch {
		case r.c.Card != nil && len(r.v.Current.Cards) == 0:
			w.Leads[0] += best
			w.Leads[1]++
		case r.c.Card == nil:
			w.Trumps[0] += best
			w.Trumps[1]++
		}
		if r.g.Lost > 0 {
			w.LostN++
		}
		if r.g.Gain > 0 {
			w.StrongN++
		}
		if r.c.Play != nil && *r.c.Play && r.g.Nat > riskyNat {
			w.Risky[0]++
		}
	}
	w.Pct = int(math.Round(100 * (1 - lost/stake)))
	w.Lost = int(math.Round(lost))
	return w
}

// TestReviewAtGameOver plays matches with two humans and checks that each
// gets the review of their own decisions, and nobody else's, only at game
// over.
func TestReviewAtGameOver(t *testing.T) {
	for _, mode := range []string{"utrechts", "gedraaid"} {
		t.Run(mode, func(t *testing.T) {
			ai := newGradeAI(false)
			_, ts := newTestServerWith(t, ai)
			host := dial(t, ts)
			host.create("Host", map[string]any{"hands": 4, "trumpMode": mode}, false, false)
			guest := dial(t, ts)
			guest.join(host.code, "Gast", "")
			host.waitState("both seated", func(s *state) bool { return s.Players[guest.seat] != nil && !s.Players[guest.seat].Bot })
			host.send(map[string]any{"t": "start"})
			playGame(t, rand.New(rand.NewPCG(11, 12)), 4, host, guest)
			for _, c := range []*tclient{host, guest} {
				s := c.waitState("the review", func(s *state) bool { return s.Review != nil && !s.Review.Pending })
				got, want := *s.Review, ai.wantReview(game.Seat(c.seat))
				if want.Choices == 0 {
					t.Fatalf("seat %d made no graded decision", c.seat)
				}
				if got.Hands != 4 || got.Luck != 3 {
					t.Errorf("seat %d: %d hands, luck %d; want 4 hands, luck 3", c.seat, got.Hands, got.Luck)
				}
				if got.Choices != want.Choices || got.Pct != want.Pct || got.Lost != want.Lost || got.LostN != want.LostN ||
					got.StrongN != want.StrongN || got.Leads != want.Leads || got.Trumps != want.Trumps || got.Risky[0] != want.Risky[0] {
					t.Errorf("seat %d review\n got  %+v\n want %+v", c.seat, got, want)
				}
				if mode == "utrechts" && got.Risky != [2]int{} {
					t.Errorf("seat %d: risky bids %v in utrechts", c.seat, got.Risky)
				}
				checkMoments(t, c.seat, got.Missed, min(got.LostN, reviewListed), true)
				checkMoments(t, c.seat, got.Strong, min(got.StrongN, reviewListed), false)
				checkReplay(t, c.seat, got.Replay, 4)
				// Every decision is timed, also a lone legal card; the
				// other human is the comparison.
				if sp := got.Speed; sp == nil || sp.N < got.Choices || sp.Others == nil || sp.Others.N == 0 ||
					sp.Median > sp.Slowest.Ms || sp.Slowest.Ms > sp.Total || sp.Slowest.Hand < 1 || sp.Slowest.Hand > 4 {
					t.Errorf("seat %d speed %+v (others %+v) for %d choices", c.seat, sp, sp.Others, got.Choices)
				}
			}
			if a, b := host.s.Review.Speed, guest.s.Review.Speed; a.Others.N != b.N || b.Others.N != a.N || a.Others.Total != b.Total {
				t.Errorf("the speeds do not mirror: %+v %+v / %+v %+v", a, a.Others, b, b.Others)
			}
		})
	}
}

// checkMoments checks the listed moments of seat: n of them, in the order
// played, each with the trick or hand it was decided on.
func checkMoments(t *testing.T, seat int, ms []moment, n int, missed bool) {
	t.Helper()
	if len(ms) != n {
		t.Errorf("seat %d: %d moments listed, want %d", seat, len(ms), n)
	}
	for k, m := range ms {
		if k > 0 && (m.Hand < ms[k-1].Hand || m.Hand == ms[k-1].Hand && m.Trick <= ms[k-1].Trick) {
			t.Errorf("seat %d: moments out of order: %+v after %+v", seat, m, ms[k-1])
		}
		if missed != (m.Better != nil) || m.Points != map[bool]int{true: 10, false: 12}[missed] {
			t.Errorf("seat %d: moment %+v", seat, m)
		}
		// The outcomes of the fake grades (fakeLost, fakeGain), weaker
		// option first.
		want := moment{Us: 6, Them: -4, Nat: [2]int{42, 25}, NatThem: [2]int{0, 5}}
		if !missed {
			want = moment{Us: 6, Them: -6, NatThem: [2]int{10, 0}}
		}
		if m.Us != want.Us || m.Them != want.Them || m.Nat != want.Nat || m.NatThem != want.NatThem || m.Us-m.Them != m.Points {
			t.Errorf("seat %d: moment %+v, want us %d them %d nat %v %v", seat, m, want.Us, want.Them, want.Nat, want.NatThem)
		}
		if missed == (m.Alt != nil) || !missed && (m.Alt.Card == nil || *m.Alt.Card == *m.Played.Card) {
			t.Errorf("seat %d: moment %+v with alternative %+v", seat, m, m.Alt)
		}
		switch {
		case m.Played.Card != nil:
			if m.Table == nil || len(m.Table.Cards) != 4 || !slices.Contains(m.Table.Cards, game.Played{Seat: game.Seat(seat), Card: *m.Played.Card}) {
				t.Errorf("seat %d: card moment %+v without its trick", seat, m)
			}
			if m.Why != "de eerste kaart die mag." {
				t.Errorf("seat %d: reason %q, from %q", seat, m.Why, m.Text)
			}
		case len(m.Cards) != 8 || m.Trick != 0:
			t.Errorf("seat %d: trump or bid moment %+v without the hand", seat, m)
		}
	}
}

// checkReplay checks the replay of seat's review: every hand, each seat's
// eight cards as dealt, every card played once in its eight tricks.
func checkReplay(t *testing.T, seat int, hands []replayHand, n int) {
	t.Helper()
	if len(hands) != n {
		t.Fatalf("seat %d: %d hands in the replay, want %d", seat, len(hands), n)
	}
	for h, rh := range hands {
		var dealt, played []game.Card
		for s, cards := range rh.Cards {
			if len(cards) != 8 {
				t.Errorf("seat %d, hand %d: seat %d was dealt %v", seat, h+1, s, cards)
			}
			dealt = append(dealt, cards...)
		}
		for _, tr := range rh.Tricks {
			for _, p := range tr.Cards {
				if !slices.Contains(rh.Cards[p.Seat], p.Card) {
					t.Errorf("seat %d, hand %d: seat %d played %v, not dealt to it", seat, h+1, p.Seat, p.Card)
				}
				played = append(played, p.Card)
			}
		}
		if len(rh.Tricks) != 8 || len(played) != 32 || distinct(dealt) != 32 {
			t.Errorf("seat %d, hand %d: %d tricks, %d cards played, %d dealt", seat, h+1, len(rh.Tricks), len(played), len(dealt))
		}
	}
}

// distinct counts the different cards in cards.
func distinct(cards []game.Card) int {
	seen := map[game.Card]bool{}
	for _, c := range cards {
		seen[c] = true
	}
	return len(seen)
}

// TestReviewPending: grades still out at game over show as pending, and
// the review follows when the last one is in.
func TestReviewPending(t *testing.T) {
	ai := newGradeAI(true)
	_, ts := newTestServerWith(t, ai)
	c := dial(t, ts)
	c.create("Piet", map[string]any{"hands": 4}, false, true)
	playGame(t, rand.New(rand.NewPCG(13, 14)), 4, c)
	if r := c.s.Review; r == nil || !r.Pending {
		t.Fatalf("review at game over with every grade held back: %+v", r)
	}
	close(ai.gate)
	s := c.waitState("the review", func(s *state) bool { return s.Review != nil && !s.Review.Pending })
	if want := ai.wantReview(0); s.Review.Choices != want.Choices || s.Review.Pct != want.Pct {
		t.Errorf("review %+v, want %+v", *s.Review, want)
	}
}

func TestRoemAdded(t *testing.T) {
	view := func(trump game.Suit, table, legal string) *game.View {
		v := &game.View{Trump: trump, Legal: game.MustParseCards(legal)}
		for k, c := range game.MustParseCards(table) {
			v.Current.Cards = append(v.Current.Cards, game.Played{Seat: game.Seat(k), Card: c})
		}
		return v
	}
	for _, tc := range []struct {
		trump        game.Suit
		table, legal string
		card         string
		want         int
	}{
		{game.Hearts, "7S 8S", "9S AS", "9S", 20}, // driekaart
		{game.Hearts, "7S 8S", "9S AS", "AS", 0},
		{game.Hearts, "7S 8S", "9S", "9S", 0},  // no choice
		{game.Hearts, "KH", "QH 7H", "QH", 20}, // stuk
		{game.Clubs, "KH", "QH 7H", "QH", 0},   // no trump: no stuk
		{game.Hearts, "", "QH 7H", "QH", 0},    // a lead adds nothing
	} {
		v := view(tc.trump, tc.table, tc.legal)
		if got := roemAdded(v, game.MustParseCards(tc.card)[0]); got != tc.want {
			t.Errorf("%v on %q (legal %q, trump %v): %d roem, want %d", tc.card, tc.table, tc.legal, tc.trump, got, tc.want)
		}
	}
}

// TestReviewTrick: roem a human's card gave counts once the opponents take
// the trick, and not when their own team does.
func TestReviewTrick(t *testing.T) {
	s, _, _ := newTestServer(t)
	r := newRoom(s, "TEST")
	r.seats[1] = newHuman("A")
	r.seats[3] = newHuman("B")
	r.reviewOf(1).roemAt = 20
	r.reviewOf(3).roemAt = 50
	r.reviewTrick(game.Trick{Winner: 0})
	if rv := r.seats[1].review; rv.roem != 20 || rv.roemTimes != 1 || rv.roemAt != 0 {
		t.Errorf("seat 1 after an opponent's trick: %+v", rv)
	}
	if rv := r.seats[3].review; rv.roem != 50 || rv.roemTimes != 1 {
		t.Errorf("seat 3 after an opponent's trick: %+v", rv)
	}
	r.reviewOf(1).roemAt = 20
	r.reviewTrick(game.Trick{Winner: 3})
	if rv := r.seats[1].review; rv.roem != 20 || rv.roemTimes != 1 || rv.roemAt != 0 {
		t.Errorf("seat 1 after its own team's trick: %+v", rv)
	}
}

// TestReviewJSON: a review without moments lists none, as [] on the wire.
func TestReviewJSON(t *testing.T) {
	s, _, _ := newTestServer(t)
	r := newRoom(s, "TEST")
	r.seats[0] = newHuman("A")
	rv := r.reviewOf(0)
	rv.choices, rv.stake = 1, 20
	r.phase = phaseGameOver
	b := string(mustJSON(r.reviewFor(0)))
	for _, want := range []string{`"strong":[]`, `"missed":[]`, `"pct":100`, `"pending":false`, `"speed":null`, `"replay":[]`} {
		if !strings.Contains(b, want) {
			t.Errorf("review %s lacks %s", b, want)
		}
	}
	r.phase = phasePlay
	if r.reviewFor(0) != nil {
		t.Error("a review before game over")
	}
}

// TestReviewSpeed: the median and total of the player's think times, the
// slowest decision, the other people at the table; a turn that opened
// while the player was away, or in which their connection dropped, is not
// timed.
func TestReviewSpeed(t *testing.T) {
	s, _, _ := newTestServer(t)
	r := newRoom(s, "TEST")
	r.seats[0] = newHuman("A")
	r.seats[2] = newHuman("B")
	r.phase = phaseGameOver
	sec := func(f float64) time.Duration { return time.Duration(f * float64(time.Second)) }
	r.reviewOf(0).thinks = []think{{sec(2), 1, 1}, {sec(9), 2, 0}, {sec(3), 2, 4}, {sec(1), 3, 8}}
	r.reviewOf(2).thinks = []think{{sec(5), 1, 2}, {sec(7), 1, 3}, {sec(6), 2, 1}}
	sp := r.speedOf(0)
	if sp == nil || sp.speedSum != (speedSum{N: 4, Median: 2500, Total: 15000}) || sp.Slowest.Hand != 2 || sp.Slowest.Trick != 0 ||
		sp.Slowest.Ms != 9000 || sp.Others == nil || *sp.Others != (speedSum{N: 3, Median: 6000, Total: 18000}) {
		t.Errorf("speed %+v, others %+v", sp, sp.Others)
	}
	if sp := r.speedOf(2); sp.Others == nil || sp.Others.Total != 15000 {
		t.Errorf("B's speed %+v, others %+v", sp, sp.Others)
	}
	r.reviewOf(2).thinks = nil
	if sp := r.speedOf(0); sp.Others != nil {
		t.Errorf("others %+v without another timed decision", sp.Others)
	}
	if r.speedOf(2) != nil {
		t.Error("a speed without a timed decision")
	}
	v := &game.View{HandNo: 5, Phase: game.PhasePlay, Tricks: make([]game.Trick, 2)}
	opened := time.Now().Add(-sec(4))
	r.timeChoice(2, opened, true, v)
	if th := r.reviewOf(2).thinks; len(th) != 1 || th[0].hand != 5 || th[0].trick != 3 || th[0].d < sec(4) {
		t.Errorf("thinks %+v", th)
	}
	r.timeChoice(2, opened, false, v)
	if th := r.reviewOf(2).thinks; len(th) != 1 {
		t.Errorf("a turn that opened while the player was away was timed: %+v", th)
	}
	r.seats[2].leftAt = opened.Add(sec(1))
	r.timeChoice(2, opened, true, v)
	if th := r.reviewOf(2).thinks; len(th) != 1 {
		t.Errorf("a turn in which the connection dropped was timed: %+v", th)
	}
}

// TestReviewReset: a new match starts every human's review afresh; a grade
// of the old match that comes in late goes to the old review.
func TestReviewReset(t *testing.T) {
	s, _, _ := newTestServer(t)
	r := newRoom(s, "TEST")
	r.seats[0] = newHuman("A")
	old := r.reviewOf(0)
	old.choices = 5
	r.fillSeats()
	r.startReviews()
	rv := r.seats[0].review
	if rv == old || rv.choices != 0 {
		t.Errorf("review not started afresh: %+v", rv)
	}
	for i := 1; i < 4; i++ {
		if r.seats[i].review != nil {
			t.Errorf("bot seat %d has a review", i)
		}
	}
	hearts := game.Hearts
	old.add(&game.View{HandNo: 1}, Choice{Suit: &hearts}, Grade{Stake: 20, Lost: 10})
	if rv.choices != 0 || rv.lost != 0 {
		t.Errorf("a late grade of the old match counts: %+v", rv)
	}
	// The old match's analyses still waiting for a slot are skipped.
	ran := false
	s.analyse(old.staleIn(r), func() { ran = true })
	if ran {
		t.Error("an analysis of the old match ran")
	}
	s.analyse(rv.staleIn(r), func() { ran = true })
	if !ran {
		t.Error("an analysis of the new match was skipped")
	}
	r.stop()
	ran = false
	s.analyse(rv.staleIn(r), func() { ran = true })
	if ran {
		t.Error("an analysis ran after the room stopped")
	}
}

// TestReviewOnlyLuckPending: a player without graded choices gets no
// review, even while the luck of their last hand is still being measured.
func TestReviewOnlyLuckPending(t *testing.T) {
	s, _, _ := newTestServer(t)
	r := newRoom(s, "TEST")
	r.seats[0] = newHuman("A")
	r.phase = phaseGameOver
	rv := r.reviewOf(0)
	rv.pending = 1
	if got := r.reviewFor(0); got != nil {
		t.Errorf("review %+v with only a hand measurement out", got)
	}
	rv.pending, rv.grading = 2, 1
	if got := r.reviewFor(0); got == nil || !got.Pending {
		t.Errorf("review %+v with a grade out", got)
	}
}

// TestNoReviewAtSmallTables: the review grades with the search of the
// hints, which plays four players; a table of three or two has none.
func TestNoReviewAtSmallTables(t *testing.T) {
	for _, players := range []int{3, 2} {
		ai := newGradeAI(false)
		_, ts := newTestServerWith(t, ai)
		c := dial(t, ts)
		c.create("Piet", map[string]any{"players": players, "hands": 4}, false, true)
		playGame(t, rand.New(rand.NewPCG(5, uint64(players))), 4, c)
		c.settle()
		if c.s.Phase != phaseGameOver || c.s.Review != nil {
			t.Errorf("%d players: phase %s, review %+v", players, c.s.Phase, c.s.Review)
		}
	}
}
