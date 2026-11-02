package toepen

import (
	"errors"
	"math/rand/v2"
	"slices"
	"testing"

	"klaverjas/internal/game"
)

var cards = game.MustParseCards

// deck lays out a deck for NewDeal: the hands in dealing order (from
// voorhand), then the stock; the stock is filled up with the cards not
// named, in deck order.
func deck(hands ...string) []game.Card {
	var out []game.Card
	for _, h := range hands {
		out = append(out, cards(h)...)
	}
	for _, c := range game.NewDeck() {
		if !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	return out
}

func noWas() Rules { return Rules{Limit: 10} }

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestOrder(t *testing.T) {
	order := cards("JH QH KH AH 7H 8H 9H TH")
	for i := range order {
		for j := range order {
			if got, want := Beats(order[i], order[j]), i > j; got != want {
				t.Errorf("Beats(%v, %v) = %v, want %v", order[i], order[j], got, want)
			}
		}
	}
	if Beats(cards("TS")[0], cards("JH")[0]) {
		t.Error("a card of another suit beats nothing")
	}
}

func TestWas(t *testing.T) {
	for _, tc := range []struct {
		hand string
		want WasKind
	}{
		{"JH QS KD AC", Witte},
		{"JH JS JD JC", Witte},
		{"JH QS KD 7C", Vuile},
		{"AH AS 7D AC", Vuile},
		{"JH QS 7D 7C", NoWas},
		{"JH QS KD 8C", NoWas},
		{"TH QS KD AC", NoWas},
		{"JH QS KD", NoWas},
	} {
		if got := Was(cards(tc.hand)); got != tc.want {
			t.Errorf("Was(%s) = %v, want %v", tc.hand, got, tc.want)
		}
	}
}

func TestLegal(t *testing.T) {
	hand := cards("7H TH JS 9C")
	led := Trick{Cards: []game.Played{{Seat: 0, Card: cards("8H")[0]}}}
	if got := Legal(hand, led); !slices.Equal(got, cards("7H TH")) {
		t.Errorf("following hearts: %v", got)
	}
	void := Trick{Cards: []game.Played{{Seat: 0, Card: cards("8D")[0]}}}
	if got := Legal(hand, void); !slices.Equal(got, hand) {
		t.Errorf("no diamonds: any card, got %v", got)
	}
	if got := Legal(hand, Trick{}); !slices.Equal(got, hand) {
		t.Errorf("leading: any card, got %v", got)
	}
	if why := ExplainIllegal(cards("JS")[0], hand, led); why != "Je moet bekennen (♥)." {
		t.Errorf("illegal reason %q", why)
	}
	if c := Constraint(hand, led); c != "Bekennen: speel ♥" {
		t.Errorf("constraint %q", c)
	}
}

// A round of four without toep or was: the last trick decides, the 10
// wins it, the three others take one point each.
func TestPlainRound(t *testing.T) {
	// Dealer 3: voorhand 0 leads.
	d := NewDeal(4, noWas(), 3, [MaxPlayers]int{}, deck("7H 8H 9H TS", "JH QH KH AH", "JS QS KS AS", "7C 8C 9C TC"))
	if d.Phase() != PhasePlay || d.Turn() != 0 || d.Voorhand() != 0 {
		t.Fatalf("phase %v turn %v", d.Phase(), d.Turn())
	}
	plays := [][4]string{
		{"7H", "JH", "JS", "7C"}, // 0 wins with 7H
		{"8H", "QH", "QS", "8C"}, // 0
		{"9H", "KH", "KS", "9C"}, // 0
		{"TS", "AH", "AS", "TC"}, // spades led: TS beats AS
	}
	for k, trick := range plays {
		for s, c := range trick {
			must(t, d.Play(game.Seat(s), cards(c)[0]))
		}
		if w := d.Tricks()[k].Winner; w != 0 {
			t.Fatalf("trick %d won by %d", k, w)
		}
	}
	r := d.Result()
	if d.Phase() != PhaseDone || r == nil || r.Winner != 0 || !r.Tricks || r.Stake != 1 {
		t.Fatalf("result %+v", r)
	}
	if !slices.Equal(r.Gains, []int{0, 1, 1, 1}) {
		t.Errorf("gains %v", r.Gains)
	}
}

func TestIllegalAndTurn(t *testing.T) {
	d := NewDeal(2, noWas(), 1, [MaxPlayers]int{}, deck("7H 8S JD QD", "9H TH KS AS"))
	if err := d.Play(1, cards("9H")[0]); !errors.Is(err, ErrNotYourTurn) {
		t.Errorf("out of turn: %v", err)
	}
	must(t, d.Play(0, cards("7H")[0]))
	err := d.Play(1, cards("KS")[0])
	if !errors.Is(err, ErrIllegal) || err.Error() != "Je moet bekennen (♥)." {
		t.Errorf("not following: %v", err)
	}
	if err := d.Play(1, cards("7C")[0]); !errors.Is(err, ErrNotInHand) {
		t.Errorf("not in hand: %v", err)
	}
}

func TestToep(t *testing.T) {
	d := NewDeal(3, noWas(), 2, [MaxPlayers]int{}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	if !d.CanToep(0) || d.CanToep(1) {
		t.Fatal("voorhand may toep on its turn, nobody else")
	}
	must(t, d.Toep(0))
	if d.Phase() != PhaseToep || d.Stake() != 2 || d.Turn() != 1 {
		t.Fatalf("after toep: %v stake %d turn %d", d.Phase(), d.Stake(), d.Turn())
	}
	if !slices.Equal(d.Asking(), []game.Seat{1, 2}) {
		t.Errorf("asking %v", d.Asking())
	}
	must(t, d.Answer(1, false)) // passes: 1 point
	must(t, d.Answer(2, true))
	if d.Phase() != PhasePlay || d.Turn() != 0 || d.Points(1) != 1 || d.Status(1) != StatusPassed {
		t.Fatalf("after answers: %v turn %d points %d", d.Phase(), d.Turn(), d.Points(1))
	}
	if d.CanToep(0) {
		t.Error("toeper toeps twice in a row")
	}
	if err := d.Toep(0); !errors.Is(err, ErrToepAgain) {
		t.Errorf("toep again: %v", err)
	}
	must(t, d.Play(0, cards("7H")[0]))
	// Seat 1 passed: seat 2 is next and may toep over it.
	if d.Turn() != 2 || !d.CanToep(2) {
		t.Fatalf("turn %d", d.Turn())
	}
	must(t, d.Toep(2))
	if d.Stake() != 3 || !slices.Equal(d.Asking(), []game.Seat{0}) {
		t.Fatalf("stake %d asking %v", d.Stake(), d.Asking())
	}
	must(t, d.Answer(0, true))
	if d.Turn() != 2 {
		t.Fatalf("the toeper plays on: turn %d", d.Turn())
	}
	must(t, d.Play(2, cards("7S")[0])) // 0 wins: 7H led
	for _, c := range []string{"8H", "8S", "9H", "9S", "TH", "TS"} {
		seat := d.Turn()
		must(t, d.Play(seat, cards(c)[0]))
	}
	r := d.Result()
	if r == nil || r.Winner != 0 || r.Stake != 3 || !slices.Equal(r.Gains, []int{0, 1, 3}) {
		t.Fatalf("result %+v", r)
	}
}

func TestAllPass(t *testing.T) {
	d := NewDeal(3, noWas(), 0, [MaxPlayers]int{4, 2, 0}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	// Voorhand is 1 (dealt first); it leads, seat 2 toeps on its turn.
	must(t, d.Play(1, cards("TH")[0]))
	must(t, d.Toep(2))
	must(t, d.Answer(0, false))
	must(t, d.Answer(1, false))
	r := d.Result()
	if r == nil || r.Winner != 2 || r.Tricks || !slices.Equal(r.Gains, []int{1, 1, 0}) || !slices.Equal(r.Points, []int{5, 3, 0}) {
		t.Fatalf("result %+v", r)
	}
}

// A passed leader's card stays in the trick but does not count.
func TestPassedLeader(t *testing.T) {
	d := NewDeal(3, noWas(), 2, [MaxPlayers]int{}, deck("TH 9H 8H 7H", "JS QS KS AS", "JH QH KH AH"))
	must(t, d.Play(0, cards("TH")[0]))
	must(t, d.Toep(1))
	must(t, d.Answer(2, true))
	must(t, d.Answer(0, false))
	must(t, d.Play(1, cards("AS")[0])) // no hearts: free
	must(t, d.Play(2, cards("JH")[0])) // follows hearts
	if w := d.Tricks()[0].Winner; w != 2 {
		t.Errorf("trick won by %d, want 2: the only heart still in", w)
	}
	if d.Turn() != 2 {
		t.Errorf("winner leads, turn %d", d.Turn())
	}
}

func TestWasLetThrough(t *testing.T) {
	d := NewDeal(3, DefaultRules, 2, [MaxPlayers]int{}, deck("JH QS KD 8C", "TH 9H 8H 7H", "TS 9S 8S 7S", "7D 8D 9D TD"))
	if d.Phase() != PhaseWas || d.Turn() != game.NoSeat {
		t.Fatalf("phase %v", d.Phase())
	}
	must(t, d.Was(0, true)) // a bluff: 8C is no 7
	if d.Claimed(0) {
		t.Error("a claim is secret while others answer")
	}
	if err := d.Was(0, false); !errors.Is(err, ErrAnswered) {
		t.Errorf("answer twice: %v", err)
	}
	must(t, d.Was(2, false))
	must(t, d.Was(1, false))
	if d.Phase() != PhaseCheck || d.Claimant() != 0 || d.Turn() != 1 || !d.Claimed(0) {
		t.Fatalf("phase %v claimant %d turn %d", d.Phase(), d.Claimant(), d.Turn())
	}
	res, err := d.Check(1, false)
	if err != nil || res != nil || d.Turn() != 2 {
		t.Fatalf("first declines: %v %v turn %d", res, err, d.Turn())
	}
	res, err = d.Check(2, false)
	if err != nil || res == nil || res.Checker != game.NoSeat || len(res.Cards) != 0 {
		t.Fatalf("let through: %+v %v", res, err)
	}
	if !slices.Equal(d.Hand(0), cards("7D 8D 9D TD")) || !d.Washed(0) || d.Stock() != 16 {
		t.Errorf("new hand %v", d.Hand(0))
	}
	if !slices.Equal(d.Dealt(0), cards("JH QS KD 8C")) {
		t.Errorf("dealt %v", d.Dealt(0))
	}
	if d.Phase() != PhasePlay || d.Turn() != 0 {
		t.Errorf("phase %v turn %d", d.Phase(), d.Turn())
	}
}

func TestWasChecked(t *testing.T) {
	for _, tc := range []struct {
		name    string
		hand    string
		genuine bool
	}{
		{"genuine", "JH QS KD 7C", true},
		{"bluff", "JH QS KD 8C", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDeal(3, DefaultRules, 2, [MaxPlayers]int{}, deck(tc.hand, "TH 9H 8H 7H", "TS 9S 8S 7S", "7D 8D 9D TD"))
			must(t, d.Was(0, true))
			must(t, d.Was(1, false))
			must(t, d.Was(2, false))
			res, err := d.Check(1, true)
			if err != nil || res == nil || res.Checker != 1 || res.Genuine() != tc.genuine || !slices.Equal(res.Cards, cards(tc.hand)) {
				t.Fatalf("check: %+v %v", res, err)
			}
			if tc.genuine {
				if d.Points(1) != 1 || d.Points(0) != 0 || d.Status(0) != StatusIn || !d.Washed(0) {
					t.Errorf("genuine: checker pays, claimant plays new cards")
				}
				if d.Turn() != 0 {
					t.Errorf("voorhand leads: %d", d.Turn())
				}
				return
			}
			if d.Points(0) != 1 || d.Status(0) != StatusCaught || d.HandLen(0) != 0 {
				t.Errorf("bluff: claimant pays and sits out")
			}
			if d.Phase() != PhasePlay || d.Turn() != 1 {
				t.Errorf("the next seat in leads: phase %v turn %d", d.Phase(), d.Turn())
			}
		})
	}
}

func TestWasStock(t *testing.T) {
	// Six players: 8 cards left, two claims at most.
	d := NewDeal(6, DefaultRules, 5, [MaxPlayers]int{}, game.NewDeck())
	if d.Stock() != 8 {
		t.Fatalf("stock %d", d.Stock())
	}
	must(t, d.Was(0, true))
	must(t, d.Was(1, true))
	if d.CanClaim(2) {
		t.Error("third claim allowed")
	}
	if err := d.Was(2, true); !errors.Is(err, ErrNoStock) {
		t.Errorf("third claim: %v", err)
	}
	d.CloseWas()
	if d.Phase() != PhaseCheck || d.Claimant() != 0 {
		t.Fatalf("phase %v claimant %d", d.Phase(), d.Claimant())
	}
	// Seven players: four cards left; eight: none, no time for a was.
	if d := NewDeal(8, DefaultRules, 7, [MaxPlayers]int{}, game.NewDeck()); d.Phase() != PhasePlay {
		t.Errorf("eight players: %v", d.Phase())
	}
}

func TestArmoede(t *testing.T) {
	rules := Rules{Limit: 10, Armoede: true}
	d := NewDeal(4, rules, 3, [MaxPlayers]int{0, 9, 3, 9}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S", "JS QS KS AS"))
	if d.Phase() != PhaseToep || d.Stake() != 2 || !d.ArmoedeToep() || d.Toeper() != game.NoSeat {
		t.Fatalf("phase %v stake %d", d.Phase(), d.Stake())
	}
	if !slices.Equal(d.Asking(), []game.Seat{0, 2}) {
		t.Fatalf("asking %v: those on armoede are not asked", d.Asking())
	}
	must(t, d.Answer(0, false))
	must(t, d.Answer(2, true))
	if d.Phase() != PhasePlay || d.Turn() != 1 || d.Points(0) != 1 {
		t.Fatalf("phase %v turn %d: the passed voorhand's lead goes on", d.Phase(), d.Turn())
	}
	if !d.CanToep(1) {
		t.Error("anyone may toep after armoede")
	}
}

func TestArmoedeAllPass(t *testing.T) {
	rules := Rules{Limit: 10, Armoede: true}
	d := NewDeal(3, rules, 2, [MaxPlayers]int{9, 0, 0}, game.NewDeck())
	must(t, d.Answer(1, false))
	must(t, d.Answer(2, false))
	r := d.Result()
	if r == nil || r.Winner != 0 || r.Tricks || !slices.Equal(r.Gains, []int{0, 1, 1}) {
		t.Fatalf("result %+v", r)
	}
}

// A player who reaches the limit during a round is out of it at once.
func TestDeadInRound(t *testing.T) {
	d := NewDeal(3, Rules{Limit: 10, Was: true}, 2, [MaxPlayers]int{0, 9, 0}, deck("JH QS KD 7C", "TH 9H 8H 7H", "TS 9S 8S 7S"))
	must(t, d.Was(0, true))
	must(t, d.Was(1, false))
	must(t, d.Was(2, false))
	if _, err := d.Check(1, true); err != nil { // genuine: seat 1 pays its last point
		t.Fatal(err)
	}
	if d.Status(1) != StatusDead || d.Points(1) != 10 {
		t.Fatalf("status %v points %d", d.Status(1), d.Points(1))
	}
	if d.Phase() != PhasePlay || d.Turn() != 0 {
		t.Fatalf("phase %v turn %d", d.Phase(), d.Turn())
	}
	// Two left: seat 0 leads, seat 2 follows.
	must(t, d.Play(0, d.Hand(0)[0]))
	if d.Turn() != 2 {
		t.Errorf("turn %d", d.Turn())
	}
}

func TestMatch(t *testing.T) {
	m := NewMatch(3, Rules{Limit: 10}, 1)
	d := m.Deal(game.NewDeck())
	if d.Dealer() != 1 || d.Voorhand() != 2 || m.Round != 1 {
		t.Fatalf("dealer %d voorhand %d", d.Dealer(), d.Voorhand())
	}
	m.Points = [MaxPlayers]int{0, 3, 10}
	d = m.Deal(game.NewDeck())
	if d.Dealer() != 0 || d.Voorhand() != 1 || d.Status(2) != StatusOut || d.HandLen(2) != 0 {
		t.Fatalf("dealer %d voorhand %d", d.Dealer(), d.Voorhand())
	}
	if m.Over() || m.Winner() != game.NoSeat {
		t.Error("two still in")
	}
	m.Points[1] = 12
	if !m.Over() || m.Winner() != 0 {
		t.Errorf("winner %d", m.Winner())
	}
}

// Random matches at every table size and rule set: every round ends, the
// winner of a round takes no points, points only grow, the cards add up,
// and the match ends with one player left.
func TestRandomMatches(t *testing.T) {
	rng := rand.New(rand.NewPCG(7, 11))
	n := 3000
	if testing.Short() {
		n = 600
	}
	for k := range n {
		players := 2 + k%7
		rules := Rules{Limit: []int{10, 15}[k%2], Was: k%3 != 0, Armoede: k%5 != 0}
		m := NewMatch(players, rules, game.Seat(rng.IntN(players)))
		for rounds := 0; !m.Over(); rounds++ {
			if rounds > players*rules.Limit {
				t.Fatalf("match %d does not end", k)
			}
			d := m.Deal(Shuffle(rng))
			before := m.Points
			playRandom(t, rng, d)
			r := d.Result()
			checked := 0 // a winner pays only for checking a genuine was
			for _, c := range d.Checks() {
				if c.Checker == r.Winner && c.Genuine() {
					checked++
				}
			}
			if r.Gains[r.Winner] != checked || r.Out[r.Winner] {
				t.Fatalf("match %d: the winner %d took points: %+v", k, r.Winner, r)
			}
			gained := 0
			for s := range players {
				if r.Points[s] < before[s] || r.Gains[s] != r.Points[s]-before[s] {
					t.Fatalf("match %d: points went down or gains wrong: %+v", k, r)
				}
				gained += r.Gains[s]
			}
			if gained == 0 {
				t.Fatalf("match %d: a round without points", k)
			}
			m.Settle(d)
		}
		if m.Winner() == game.NoSeat {
			t.Fatalf("match %d: no winner", k)
		}
	}
}

// playRandom plays d to the end with random legal decisions, checking the
// cards on the way.
func playRandom(t *testing.T, rng *rand.Rand, d *Deal) {
	t.Helper()
	for steps := 0; d.Phase() != PhaseDone; steps++ {
		if steps > 500 {
			t.Fatal("round does not end")
		}
		checkCards(t, d)
		switch d.Phase() {
		case PhaseWas:
			for s := range game.Seat(d.Players()) {
				if d.Status(s) == StatusIn && !d.Answered(s) {
					claim := rng.IntN(4) == 0 && d.CanClaim(s)
					must(t, d.Was(s, claim))
					break
				}
			}
			if d.Phase() == PhaseWas && rng.IntN(3) == 0 {
				d.CloseWas()
			}
		case PhaseCheck:
			if _, err := d.Check(d.Turn(), rng.IntN(3) == 0); err != nil {
				t.Fatal(err)
			}
		case PhaseToep:
			must(t, d.Answer(d.Turn(), rng.IntN(3) != 0))
		case PhasePlay:
			s := d.Turn()
			if d.CanToep(s) && rng.IntN(6) == 0 {
				must(t, d.Toep(s))
				continue
			}
			legal := d.Legal()
			if len(legal) == 0 {
				t.Fatalf("no legal card for %d: %v", s, d.Hand(s))
			}
			must(t, d.Play(s, legal[rng.IntN(len(legal))]))
		}
	}
}

// checkCards: the 32 cards are somewhere, each once: in a hand, on the
// table, in the stock or given back for a was (or held by a seat out of
// the round, in a hand).
func checkCards(t *testing.T, d *Deal) {
	t.Helper()
	seen := map[game.Card]int{}
	for s := range d.Players() {
		for _, c := range d.hands[s] {
			seen[c]++
		}
		for _, c := range d.old[s] {
			seen[c]++
		}
	}
	for _, c := range d.stock {
		seen[c]++
	}
	for _, tr := range d.tricks {
		for _, p := range tr.Cards {
			seen[p.Card]++
		}
	}
	for _, p := range d.current.Cards {
		seen[p.Card]++
	}
	if len(seen) != 32 {
		t.Fatalf("%d distinct cards", len(seen))
	}
	for c, n := range seen {
		if n != 1 {
			t.Fatalf("card %v %d times", c, n)
		}
	}
}

func TestClone(t *testing.T) {
	d := NewDeal(4, noWas(), 0, [MaxPlayers]int{}, game.NewDeck())
	c := d.Clone()
	must(t, c.Play(c.Turn(), c.Legal()[0]))
	if len(d.Current().Cards) != 0 || d.HandLen(1) != 4 {
		t.Error("clone shares state")
	}
}

func TestView(t *testing.T) {
	d := NewDeal(3, DefaultRules, 2, [MaxPlayers]int{}, deck("JH QS KD 7C", "TH 9H 8H 7H", "TS 9S 8S 7S"))
	must(t, d.Was(1, true))
	v := d.View(0)
	if v.Claimed[1] || v.Answered || !v.CanClaim || v.Turn != game.NoSeat {
		t.Errorf("was view %+v", v)
	}
	if v := d.View(1); !v.Answered || v.CanClaim {
		t.Error("seat 1 answered")
	}
	if len(v.Hand) != 4 || v.Cards[2] != 4 || v.Stake != 1 {
		t.Errorf("view %+v", v)
	}
}

func TestWireCodes(t *testing.T) {
	for _, s := range []Status{StatusOut, StatusIn, StatusPassed, StatusCaught, StatusDead} {
		b, _ := s.MarshalText()
		var back Status
		if err := back.UnmarshalText(b); err != nil || back != s {
			t.Errorf("status %v: %s → %v %v", s, b, back, err)
		}
	}
	for _, k := range []WasKind{NoWas, Witte, Vuile} {
		b, _ := k.MarshalText()
		var back WasKind
		if err := back.UnmarshalText(b); err != nil || back != k {
			t.Errorf("was %v: %s → %v %v", k, b, back, err)
		}
	}
}
