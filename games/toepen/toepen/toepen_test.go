package toepen

import (
	"errors"
	"math/rand/v2"
	"slices"
	"testing"

	"jannie/platform/cards"
)

var parseCards = cards.MustParseCards

// deck lays out a deck for NewDeal: the hands in dealing order (from
// voorhand), then the stock; the stock is filled up with the cards not
// named, in deck order.
func deck(hands ...string) []cards.Card {
	var out []cards.Card
	for _, h := range hands {
		out = append(out, parseCards(h)...)
	}
	for _, c := range cards.NewDeck() {
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
	order := parseCards("JH QH KH AH 7H 8H 9H TH")
	for i := range order {
		for j := range order {
			if got, want := Beats(order[i], order[j]), i > j; got != want {
				t.Errorf("Beats(%v, %v) = %v, want %v", order[i], order[j], got, want)
			}
		}
	}
	if Beats(parseCards("TS")[0], parseCards("JH")[0]) {
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
		if got := Was(parseCards(tc.hand)); got != tc.want {
			t.Errorf("Was(%s) = %v, want %v", tc.hand, got, tc.want)
		}
	}
}

func TestLegal(t *testing.T) {
	hand := parseCards("7H TH JS 9C")
	led := Trick{Cards: []cards.Played{{Seat: 0, Card: parseCards("8H")[0]}}}
	if got := Legal(hand, led); !slices.Equal(got, parseCards("7H TH")) {
		t.Errorf("following hearts: %v", got)
	}
	void := Trick{Cards: []cards.Played{{Seat: 0, Card: parseCards("8D")[0]}}}
	if got := Legal(hand, void); !slices.Equal(got, hand) {
		t.Errorf("no diamonds: any card, got %v", got)
	}
	if got := Legal(hand, Trick{}); !slices.Equal(got, hand) {
		t.Errorf("leading: any card, got %v", got)
	}
	if why := ExplainIllegal(parseCards("JS")[0], hand, led); why != "Je moet bekennen (♥)." {
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
			must(t, d.Play(cards.Seat(s), parseCards(c)[0]))
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
	if err := d.Play(1, parseCards("9H")[0]); !errors.Is(err, ErrNotYourTurn) {
		t.Errorf("out of turn: %v", err)
	}
	must(t, d.Play(0, parseCards("7H")[0]))
	err := d.Play(1, parseCards("KS")[0])
	if !errors.Is(err, ErrIllegal) || err.Error() != "Je moet bekennen (♥)." {
		t.Errorf("not following: %v", err)
	}
	if err := d.Play(1, parseCards("7C")[0]); !errors.Is(err, ErrNotInHand) {
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
	if !slices.Equal(d.Asking(), []cards.Seat{1, 2}) {
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
	must(t, d.Play(0, parseCards("7H")[0]))
	// Seat 1 passed: seat 2 is next and may toep over it.
	if d.Turn() != 2 || !d.CanToep(2) {
		t.Fatalf("turn %d", d.Turn())
	}
	must(t, d.Toep(2))
	if d.Stake() != 3 || !slices.Equal(d.Asking(), []cards.Seat{0}) {
		t.Fatalf("stake %d asking %v", d.Stake(), d.Asking())
	}
	must(t, d.Answer(0, true))
	if d.Turn() != 2 {
		t.Fatalf("the toeper plays on: turn %d", d.Turn())
	}
	must(t, d.Play(2, parseCards("7S")[0])) // 0 wins: 7H led
	for _, c := range []string{"8H", "8S", "9H", "9S", "TH", "TS"} {
		seat := d.Turn()
		must(t, d.Play(seat, parseCards(c)[0]))
	}
	r := d.Result()
	if r == nil || r.Winner != 0 || r.Stake != 3 || !slices.Equal(r.Gains, []int{0, 1, 3}) {
		t.Fatalf("result %+v", r)
	}
}

func TestAllPass(t *testing.T) {
	d := NewDeal(3, noWas(), 0, [MaxPlayers]int{4, 2, 0}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	// Voorhand is 1 (dealt first); it leads, seat 2 toeps on its turn.
	must(t, d.Play(1, parseCards("TH")[0]))
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
	must(t, d.Play(0, parseCards("TH")[0]))
	must(t, d.Toep(1))
	must(t, d.Answer(2, true))
	must(t, d.Answer(0, false))
	must(t, d.Play(1, parseCards("AS")[0])) // no hearts: free
	must(t, d.Play(2, parseCards("JH")[0])) // follows hearts
	if w := d.Tricks()[0].Winner; w != 2 {
		t.Errorf("trick won by %d, want 2: the only heart still in", w)
	}
	if d.Turn() != 2 {
		t.Errorf("winner leads, turn %d", d.Turn())
	}
}

func TestWasLetThrough(t *testing.T) {
	d := NewDeal(3, DefaultRules, 2, [MaxPlayers]int{}, deck("JH QS KD 8C", "TH 9H 8H 7H", "TS 9S 8S 7S", "7D 8D 9D TD"))
	if d.Phase() != PhaseWas || d.Turn() != cards.NoSeat {
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
	if err != nil || res == nil || res.Checker != cards.NoSeat || len(res.Cards) != 0 {
		t.Fatalf("let through: %+v %v", res, err)
	}
	if !slices.Equal(d.Hand(0), parseCards("7D 8D 9D TD")) || !d.Washed(0) || d.Stock() != 16 {
		t.Errorf("new hand %v", d.Hand(0))
	}
	if !slices.Equal(d.Dealt(0), parseCards("JH QS KD 8C")) {
		t.Errorf("dealt %v", d.Dealt(0))
	}
	// New cards: seat 0 alone says again whether it has a was.
	if d.Phase() != PhaseWas || d.WasRound() != 2 || !d.CanClaim(0) || d.CanClaim(1) || !d.Answered(1) || d.Claimed(0) {
		t.Fatalf("again: phase %v round %d", d.Phase(), d.WasRound())
	}
	must(t, d.Was(0, false))
	if d.Phase() != PhasePlay || d.Turn() != 0 {
		t.Errorf("phase %v turn %d", d.Phase(), d.Turn())
	}
}

// A was may be handed in again with the new cards, and again, while the
// stock lasts; the hand as dealt stays the first one.
func TestWasAgain(t *testing.T) {
	d := NewDeal(5, DefaultRules, 4, [MaxPlayers]int{},
		deck("JH QS KD 7C", "TH 9H 8H 7H", "TS 9S 8S 7S", "KH QH AC 9C", "QC TC KS JS", "JD QD KC 7D", "AH AS AD JC", "8D 9D TD 8C"))
	letGo := func() {
		t.Helper()
		for _, s := range []cards.Seat{1, 2, 3, 4} {
			must2(t)(d.Check(s, false))
		}
	}
	must(t, d.Was(0, true))
	for s := range cards.Seat(4) {
		must(t, d.Was(s+1, false))
	}
	letGo()
	if d.Phase() != PhaseWas || d.WasRound() != 2 || !slices.Equal(d.Hand(0), parseCards("JD QD KC 7D")) || d.Stock() != 8 {
		t.Fatalf("round %d hand %v", d.WasRound(), d.Hand(0))
	}
	must(t, d.Was(0, true)) // another vuile was
	must2(t)(d.Check(1, false))
	res, err := d.Check(2, true)
	if err != nil || res == nil || !res.Genuine() || d.Points(2) != 1 {
		t.Fatalf("checked again: %+v %v", res, err)
	}
	if d.WasRound() != 3 || !slices.Equal(d.Hand(0), parseCards("AH AS AD JC")) || d.Stock() != 4 {
		t.Fatalf("round %d hand %v stock %d", d.WasRound(), d.Hand(0), d.Stock())
	}
	must(t, d.Was(0, true)) // a witte was
	letGo()
	// The stock is empty: no fourth time.
	if d.Phase() != PhasePlay || d.Stock() != 0 || !slices.Equal(d.Dealt(0), parseCards("JH QS KD 7C")) {
		t.Fatalf("phase %v stock %d dealt %v", d.Phase(), d.Stock(), d.Dealt(0))
	}
	if len(d.Checks()) != 3 {
		t.Errorf("checks %+v", d.Checks())
	}
	checkCards(t, d)
}

func must2(t *testing.T) func(*Check, error) {
	return func(_ *Check, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
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
			if err != nil || res == nil || res.Checker != 1 || res.Genuine() != tc.genuine || !slices.Equal(res.Cards, parseCards(tc.hand)) {
				t.Fatalf("check: %+v %v", res, err)
			}
			if tc.genuine {
				if d.Points(1) != 1 || d.Points(0) != 0 || d.Status(0) != StatusIn || !d.Washed(0) {
					t.Errorf("genuine: checker pays, claimant plays new cards")
				}
				must(t, d.Was(0, false)) // asked again about the new cards
				if d.Turn() != 0 {
					t.Errorf("voorhand leads: %d", d.Turn())
				}
				return
			}
			// Rule Bluf (the default): the claimant pays, takes the cards
			// back and plays on with them face up.
			if d.Points(0) != 1 || d.Status(0) != StatusIn || !d.Open(0) || !slices.Equal(d.Hand(0), parseCards(tc.hand)) {
				t.Errorf("bluff: claimant pays and plays open")
			}
			if v := d.View(1); !slices.Equal(v.Open[0], parseCards(tc.hand)) || len(v.Open[1]) != 0 {
				t.Errorf("the open hand in the view: %v", v.Open)
			}
			if d.Phase() != PhasePlay || d.Turn() != 0 {
				t.Errorf("voorhand leads: phase %v turn %d", d.Phase(), d.Turn())
			}
		})
	}
	// Without rule Bluf the caught claimant sits the round out.
	rules := DefaultRules
	rules.Bluf = false
	d := NewDeal(3, rules, 2, [MaxPlayers]int{}, deck("JH QS KD 8C", "TH 9H 8H 7H", "TS 9S 8S 7S"))
	must(t, d.Was(0, true))
	must(t, d.Was(1, false))
	must(t, d.Was(2, false))
	must2(t)(d.Check(1, true))
	if d.Points(0) != 1 || d.Status(0) != StatusCaught || d.HandLen(0) != 0 || d.Open(0) {
		t.Errorf("bluff: claimant pays and sits out")
	}
	if d.Phase() != PhasePlay || d.Turn() != 1 {
		t.Errorf("the next seat in leads: phase %v turn %d", d.Phase(), d.Turn())
	}
}

// On armoede only a real was may be handed in, and it is laid open on the
// table: nobody is asked to check it.
func TestWasOnArmoede(t *testing.T) {
	d := NewDeal(3, DefaultRules, 2, [MaxPlayers]int{9, 0, 0}, deck("JH QS KD 8C", "TH 9H 8H 7H", "TS 9S 8S 7S"))
	if d.CanClaim(0) || !errors.Is(d.Was(0, true), ErrPoorBluff) {
		t.Fatal("a bluff on armoede")
	}
	d = NewDeal(3, DefaultRules, 2, [MaxPlayers]int{9, 0, 0}, deck("JH QS KD 7C", "TH 9H 8H 7H", "TS 9S 8S 7S", "AH AS AD JC"))
	if !d.CanClaim(0) {
		t.Fatal("a real was on armoede")
	}
	must(t, d.Was(0, true))
	must(t, d.Was(1, false))
	must(t, d.Was(2, false))
	c := d.Checks()
	if len(c) != 1 || !c[0].Shown || c[0].Checker != cards.NoSeat || c[0].Kind != Vuile || !slices.Equal(c[0].Cards, parseCards("JH QS KD 7C")) || !c[0].Washed() {
		t.Fatalf("shown: %+v", c)
	}
	// New cards, a witte was again: asked again, shown again.
	if d.Phase() != PhaseWas || !d.CanClaim(0) || !slices.Equal(d.Hand(0), parseCards("AH AS AD JC")) {
		t.Fatalf("again: phase %v hand %v", d.Phase(), d.Hand(0))
	}
	must(t, d.Was(0, true))
	if c := d.Checks(); len(c) != 2 || c[1].Kind != Witte || !c[1].Shown {
		t.Fatalf("shown again: %+v", c)
	}
	must(t, d.Was(0, false))
	if d.Phase() != PhaseToep || !d.ArmoedeToep() {
		t.Errorf("then armoede's question: %v", d.Phase())
	}
}

func TestWasStock(t *testing.T) {
	// Six players: 8 cards left, two claims at most.
	d := NewDeal(6, DefaultRules, 5, [MaxPlayers]int{}, cards.NewDeck())
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
	if d := NewDeal(8, DefaultRules, 7, [MaxPlayers]int{}, cards.NewDeck()); d.Phase() != PhasePlay {
		t.Errorf("eight players: %v", d.Phase())
	}
}

func TestArmoede(t *testing.T) {
	rules := Rules{Limit: 10, Armoede: true}
	d := NewDeal(4, rules, 3, [MaxPlayers]int{0, 9, 3, 9}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S", "JS QS KS AS"))
	if d.Phase() != PhaseToep || d.Stake() != 2 || !d.ArmoedeToep() || d.Toeper() != cards.NoSeat {
		t.Fatalf("phase %v stake %d", d.Phase(), d.Stake())
	}
	if !slices.Equal(d.Asking(), []cards.Seat{2, 0}) {
		t.Fatalf("asking %v: from the left of seat 1, who leads; those on armoede are not asked", d.Asking())
	}
	must(t, d.Answer(2, true))
	must(t, d.Answer(0, false))
	if d.Phase() != PhasePlay || d.Turn() != 1 || d.Points(0) != 1 {
		t.Fatalf("phase %v turn %d: seat 1, the first on armoede after the dealer, leads", d.Phase(), d.Turn())
	}
	// On armoede nobody toeps; the others may.
	if d.CanToep(1) || !errors.Is(d.Toep(1), ErrToepArmoede) {
		t.Error("a toep on armoede")
	}
	must(t, d.Play(1, parseCards("JH")[0]))
	// The others still in are both on armoede: they go along with any toep,
	// so a toep would only put more at stake for seat 2 itself.
	if d.CanToep(2) || !errors.Is(d.Toep(2), ErrToepPointless) {
		t.Error("a pointless toep")
	}
	// With someone in who can pass, seat 2 may toep; armoede goes along.
	d = NewDeal(4, rules, 3, [MaxPlayers]int{0, 9, 3, 9}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S", "JS QS KS AS"))
	must(t, d.Answer(2, true))
	must(t, d.Answer(0, true))
	must(t, d.Play(1, parseCards("JH")[0]))
	if !d.CanToep(2) {
		t.Fatal("seat 2 may toep: seat 0 can pass")
	}
	must(t, d.Toep(2))
	if !slices.Equal(d.AutoStays(), []cards.Seat{3, 1}) || !slices.Equal(d.Asking(), []cards.Seat{0}) || d.PassCost(0) != 2 {
		t.Errorf("auto %v asking %v pass cost %d", d.AutoStays(), d.Asking(), d.PassCost(0))
	}
}

// Who would be out by losing at the stake may not raise it: no toep and
// no overtoep.
func TestToepDead(t *testing.T) {
	d := NewDeal(3, noWas(), 2, [MaxPlayers]int{8, 0, 0}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	if !d.CanToep(0) {
		t.Fatal("8 points at stake 1 may toep")
	}
	must(t, d.Toep(0))
	if !d.CanRaise(1) {
		t.Fatal("seat 1 may overtoep")
	}
	must(t, d.Overtoep(1)) // stake 3
	// Seat 0 agreed to 2: passing would put it out, so it goes along unasked.
	if !slices.Equal(d.AutoStays(), []cards.Seat{0}) || !slices.Equal(d.Asking(), []cards.Seat{2}) {
		t.Fatalf("auto %v asking %v", d.AutoStays(), d.Asking())
	}
	must(t, d.Answer(2, true))
	if d.Phase() != PhasePlay || d.Turn() != 0 || d.CanToep(0) || !errors.Is(d.Toep(0), ErrToepDead) {
		t.Fatal("8 points at stake 3 may not toep")
	}
}

// An overtoep raises the stake again and asks everyone else, the toeper
// too; who passes then pays the stake from before it. A toeper who passes
// before its card can complete the trick.
func TestOvertoep(t *testing.T) {
	d := NewDeal(3, noWas(), 2, [MaxPlayers]int{}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	must(t, d.Play(0, parseCards("TH")[0]))
	must(t, d.Play(1, parseCards("JH")[0]))
	must(t, d.Toep(2))
	if !slices.Equal(d.Asking(), []cards.Seat{0, 1}) || !d.CanRaise(0) {
		t.Fatalf("asking %v", d.Asking())
	}
	must(t, d.Overtoep(0))
	if d.Stake() != 3 || d.Toeper() != 0 || !slices.Equal(d.Asking(), []cards.Seat{1, 2}) || len(d.Toeps()) != 2 {
		t.Fatalf("stake %d toeper %d asking %v", d.Stake(), d.Toeper(), d.Asking())
	}
	must(t, d.Answer(1, true))
	must(t, d.Answer(2, false))
	if d.Points(2) != 2 || d.Status(2) != StatusPassed {
		t.Fatalf("the toeper passed: %d points", d.Points(2))
	}
	tr := d.Tricks()
	if len(tr) != 1 || tr[0].Winner != 0 || d.Phase() != PhasePlay || d.Turn() != 0 {
		t.Fatalf("the trick is complete: %+v turn %d", tr, d.Turn())
	}
	// Everyone passes on an overtoep: the one who made it wins.
	d = NewDeal(3, noWas(), 2, [MaxPlayers]int{}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	must(t, d.Toep(0))
	must(t, d.Overtoep(1))
	must(t, d.Answer(2, false))
	must(t, d.Answer(0, false))
	// Seat 2 never went along with seat 0's toep: passing costs it the
	// stake from before that, 1; seat 0 agreed to 2 with its toep.
	if r := d.Result(); r == nil || r.Winner != 1 || !slices.Equal(r.Gains, []int{2, 0, 1}) {
		t.Fatalf("result %+v", r)
	}
	// Not on armoede's question.
	d = NewDeal(3, Rules{Limit: 10, Armoede: true}, 2, [MaxPlayers]int{0, 9, 0}, cards.NewDeck())
	if d.Turn() != 2 || d.CanRaise(2) || !errors.Is(d.Overtoep(2), ErrNoRaise) {
		t.Error("an overtoep on armoede")
	}
}

// Anti-lijntoep: after two passes in a row on a toep, the third must go
// along; going along starts the count again, armoede does not count.
func TestLijntoep(t *testing.T) {
	rules := Rules{Limit: 10, Lijntoep: true, Armoede: true}
	hands := deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S")
	m := NewMatch(3, rules, 2)
	for want := 1; want <= 2; want++ {
		m.Dealer = 2
		m.Round = 0
		d := m.Deal(hands)
		must(t, d.Toep(0))
		if d.MustStay(1) {
			t.Fatalf("must stay after %d passes", want-1)
		}
		must(t, d.Answer(1, false))
		must(t, d.Answer(2, false))
		m.Settle(d)
		if m.Streak[1] != want || m.Streak[2] != want {
			t.Fatalf("streak %v", m.Streak)
		}
	}
	m.Dealer, m.Round = 2, 0
	d := m.Deal(hands)
	must(t, d.Toep(0))
	if !d.MustStay(1) || !errors.Is(d.Answer(1, false), ErrMustStay) {
		t.Fatal("a third pass")
	}
	must(t, d.Answer(1, true))
	if d.Streak(1) != 0 {
		t.Errorf("streak %d after going along", d.Streak(1))
	}
	// The rule off: no limit.
	d = NewDeal(3, Rules{Limit: 10}, 2, [MaxPlayers]int{}, hands)
	d.streak[1] = 5
	must(t, d.Toep(0))
	if d.MustStay(1) {
		t.Error("must stay without the rule")
	}
	// Armoede's question: passing is free of the rule, and does not count.
	m.Points = [MaxPlayers]int{0, 0, 9}
	m.Streak = [MaxPlayers]int{2, 2, 0}
	m.Dealer, m.Round = 2, 0
	d = m.Deal(hands)
	if d.Phase() != PhaseToep || d.MustStay(0) {
		t.Fatal("armoede")
	}
	must(t, d.Answer(0, false))
	if d.Streak(0) != 2 {
		t.Errorf("armoede counted: %d", d.Streak(0))
	}
}

// The last trick taken with a boer takes a penalty point off the winner.
func TestBoer(t *testing.T) {
	for _, on := range []bool{true, false} {
		d := NewDeal(2, Rules{Limit: 10, Boer: on}, 1, [MaxPlayers]int{3, 0}, deck("TS 9S 8S JH", "7S QS KS AC"))
		for range 4 {
			must(t, d.Play(0, d.Legal()[slices.IndexFunc(d.Legal(), func(c cards.Card) bool { return c.Rank != cards.Jack || len(d.Hand(0)) == 1 })]))
			must(t, d.Play(1, d.Legal()[0]))
		}
		r := d.Result()
		want := []int{-1, 1}
		if !on {
			want = []int{0, 1}
		}
		if r == nil || r.Winner != 0 || r.Boer != on || !slices.Equal(r.Gains, want) {
			t.Fatalf("boer %v: %+v", on, r)
		}
	}
	// No points to take off: none.
	d := NewDeal(2, Rules{Limit: 10, Boer: true}, 1, [MaxPlayers]int{}, deck("JH TS 9S 8S", "AC 7S QS KS"))
	must(t, d.Play(0, parseCards("TS")[0]))
	must(t, d.Play(1, parseCards("7S")[0]))
	must(t, d.Play(0, parseCards("9S")[0]))
	must(t, d.Play(1, parseCards("QS")[0]))
	must(t, d.Play(0, parseCards("8S")[0]))
	must(t, d.Play(1, parseCards("KS")[0]))
	must(t, d.Play(0, parseCards("JH")[0]))
	must(t, d.Play(1, parseCards("AC")[0]))
	if r := d.Result(); !r.Boer || r.Gains[0] != 0 || r.Points[0] != 0 {
		t.Fatalf("result %+v", r)
	}
}

// Everyone left one point from out: the koningsspel. Eleven cards each
// (as many as the deck holds for all), laid away down to eight in turn
// from voorhand; no was, no armoede, no toep; it ends the match.
func TestKoningsspel(t *testing.T) {
	rules := DefaultRules
	d := NewDeal(3, rules, 2, [MaxPlayers]int{9, 10, 9}, cards.NewDeck())
	if !d.Koning() || d.DealtSize() != 11 || d.Size() != 8 || d.HandLen(0) != 11 || d.HandLen(1) != 0 || d.Phase() != PhaseDiscard || d.Stake() != 1 {
		t.Fatalf("koningsspel: %v dealt %d size %d phase %v", d.Koning(), d.DealtSize(), d.Size(), d.Phase())
	}
	if d.Turn() != 0 || d.Lay(0) != 3 || d.Lay(2) != 0 || d.Stock() != 10 {
		t.Fatalf("turn %d lay %d stock %d", d.Turn(), d.Lay(0), d.Stock())
	}
	h := d.Hand(0)
	if err := d.Discard(0, h[:2]); err == nil || err.Error() != "Leg precies 3 kaarten weg." {
		t.Errorf("two: %v", err)
	}
	if !errors.Is(d.Discard(0, []cards.Card{h[0], h[0], h[1]}), ErrDiscardTwice) || !errors.Is(d.Discard(2, h[:3]), ErrNotYourTurn) {
		t.Error("a card twice, or out of turn")
	}
	if !errors.Is(d.Discard(0, append(h[:2:2], d.stock[0])), ErrNotInHand) {
		t.Error("a card not held")
	}
	must(t, d.Discard(0, h[:3]))
	if d.HandLen(0) != 8 || !slices.Equal(d.Laid(0), h[:3]) || d.Turn() != 2 || d.Phase() != PhaseDiscard {
		t.Fatalf("after seat 0: %d cards, turn %d", d.HandLen(0), d.Turn())
	}
	if v := d.View(0); !slices.Equal(v.Laid, h[:3]) || len(v.Seen()) != 3 {
		t.Errorf("own laid cards are seen: %v", v.Seen())
	}
	if v := d.View(2); v.Lay != 3 || len(v.Laid) != 0 {
		t.Errorf("seat 2 view: lay %d", v.Lay)
	}
	must(t, d.Discard(2, d.Hand(2)[5:8]))
	if d.Phase() != PhasePlay || d.Turn() != 0 || d.CanToep(0) {
		t.Fatalf("then voorhand leads, no toep: %v %d", d.Phase(), d.Turn())
	}
	if len(d.Dealt(0)) != 11 {
		t.Errorf("dealt %v", d.Dealt(0))
	}
	rng := rand.New(rand.NewPCG(1, 2))
	playRandom(t, rng, d)
	r := d.Result()
	if !r.Koning || len(d.Tricks()) != 8 {
		t.Fatalf("result %+v after %d tricks", r, len(d.Tricks()))
	}
	for s := range 3 {
		if out := r.Out[s]; out == (cards.Seat(s) == r.Winner) {
			t.Errorf("seat %d out %v", s, out)
		}
	}
	// Three left: ten each, two laid away; four: eight, none; six: five.
	for _, tc := range []struct{ n, dealt, size int }{{3, 10, 8}, {4, 8, 8}, {6, 5, 5}} {
		var pts [MaxPlayers]int
		for s := range tc.n {
			pts[s] = 9
		}
		d := NewDeal(tc.n, rules, cards.Seat(tc.n-1), pts, cards.NewDeck())
		discard := d.Phase() == PhaseDiscard
		if !d.Koning() || d.DealtSize() != tc.dealt || d.Size() != tc.size || discard != (tc.dealt > tc.size) {
			t.Errorf("%d on armoede: dealt %d size %d phase %v", tc.n, d.DealtSize(), d.Size(), d.Phase())
		}
	}
	if d := NewDeal(3, rules, 2, [MaxPlayers]int{9, 9, 8}, cards.NewDeck()); d.Koning() || d.Size() != 4 {
		t.Error("one not on armoede: no koningsspel")
	}
	rules.Koning = false
	if d := NewDeal(3, rules, 2, [MaxPlayers]int{9, 9, 9}, cards.NewDeck()); d.Koning() || d.Size() != 4 {
		t.Error("koningsspel without the rule")
	}
}

func TestArmoedeAllPass(t *testing.T) {
	rules := Rules{Limit: 10, Armoede: true}
	d := NewDeal(3, rules, 2, [MaxPlayers]int{9, 0, 0}, cards.NewDeck())
	must(t, d.Answer(1, false))
	must(t, d.Answer(2, false))
	r := d.Result()
	if r == nil || r.Winner != 0 || r.Tricks || !slices.Equal(r.Gains, []int{0, 1, 1}) {
		t.Fatalf("result %+v", r)
	}
}

// Who stands on armoede leads the first trick; of more, the first after the
// dealer. The others are asked from that player's left.
func TestArmoedeLeads(t *testing.T) {
	rules := Rules{Limit: 10, Armoede: true}
	// Dealer 3, voorhand 0; seat 2 on armoede.
	d := NewDeal(4, rules, 3, [MaxPlayers]int{6, 8, 9, 7}, cards.NewDeck())
	if d.FirstLeader() != 2 || d.View(0).FirstLeader != 2 || !slices.Equal(d.Asking(), []cards.Seat{3, 0, 1}) || d.Turn() != 3 {
		t.Fatalf("first leader %d (view %d), asking %v, turn %d", d.FirstLeader(), d.View(0).FirstLeader, d.Asking(), d.Turn())
	}
	must(t, d.Answer(3, false))
	must(t, d.Answer(0, true))
	must(t, d.Answer(1, false))
	if d.Phase() != PhasePlay || d.Turn() != 2 || d.Current().Leader != 2 {
		t.Fatalf("phase %v turn %d leader %d: armoede leads", d.Phase(), d.Turn(), d.Current().Leader)
	}
	// Two on armoede: the first after the dealer, also past the last seat;
	// the others are asked from its left, and it leads once they answered.
	for _, tc := range []struct {
		players int
		dealer  cards.Seat
		points  [MaxPlayers]int
		want    cards.Seat
		asking  []cards.Seat
	}{
		{4, 0, [MaxPlayers]int{0, 0, 9, 9}, 2, []cards.Seat{0, 1}},
		{4, 2, [MaxPlayers]int{9, 9, 0, 0}, 0, []cards.Seat{2, 3}},
		{5, 1, [MaxPlayers]int{0, 9, 9, 0, 0}, 2, []cards.Seat{3, 4, 0}}, // the dealer on armoede comes last: seat 2 leads
	} {
		d := NewDeal(tc.players, rules, tc.dealer, tc.points, cards.NewDeck())
		if d.FirstLeader() != tc.want || !slices.Equal(d.Asking(), tc.asking) {
			t.Errorf("dealer %d points %v: first leader %d asking %v, want %d %v", tc.dealer, tc.points, d.FirstLeader(), d.Asking(), tc.want, tc.asking)
		}
		for d.Phase() == PhaseToep {
			must(t, d.Answer(d.Turn(), true))
		}
		if d.Phase() != PhasePlay || d.Turn() != tc.want {
			t.Errorf("dealer %d points %v: phase %v turn %d, want %d", tc.dealer, tc.points, d.Phase(), d.Turn(), tc.want)
		}
	}
	// Without the rule voorhand leads.
	d = NewDeal(4, Rules{Limit: 10}, 3, [MaxPlayers]int{6, 8, 9, 7}, cards.NewDeck())
	if d.Phase() != PhasePlay || d.Turn() != 0 || d.FirstLeader() != 0 {
		t.Errorf("no armoede rule: phase %v turn %d first leader %d", d.Phase(), d.Turn(), d.FirstLeader())
	}
	// Seat 0 on armoede checks seat 1's genuine was and is out: seat 2, the
	// other on armoede, leads, and seats 3 and 1 are asked in that order.
	d = NewDeal(4, DefaultRules, 3, [MaxPlayers]int{9, 0, 9, 0}, deck("TH 9H 8H 7H", "JH QS KD 7C", "TS 9S 8S 7S", "TD 9D 8D 7D"))
	if d.FirstLeader() != 0 {
		t.Fatalf("first leader %d before the check", d.FirstLeader())
	}
	must(t, d.Was(0, false))
	must(t, d.Was(1, true))
	must(t, d.Was(2, false))
	must(t, d.Was(3, false))
	must2(t)(d.Check(2, false))
	must2(t)(d.Check(3, false))
	must2(t)(d.Check(0, true))
	if d.Status(0) != StatusDead || d.FirstLeader() != 2 {
		t.Fatalf("status %v first leader %d", d.Status(0), d.FirstLeader())
	}
	must(t, d.Was(1, false)) // asked again about the new cards
	if !slices.Equal(d.Asking(), []cards.Seat{3, 1}) {
		t.Fatalf("asking %v", d.Asking())
	}
	must(t, d.Answer(3, true))
	must(t, d.Answer(1, true))
	if d.Phase() != PhasePlay || d.Turn() != 2 {
		t.Errorf("phase %v turn %d", d.Phase(), d.Turn())
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
	must(t, d.Was(0, false)) // asked again about the new cards
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
	d := m.Deal(cards.NewDeck())
	if d.Dealer() != 1 || d.Voorhand() != 2 || m.Round != 1 {
		t.Fatalf("dealer %d voorhand %d", d.Dealer(), d.Voorhand())
	}
	m.Points = [MaxPlayers]int{0, 3, 10}
	d = m.Deal(cards.NewDeck())
	if d.Dealer() != 0 || d.Voorhand() != 1 || d.Status(2) != StatusOut || d.HandLen(2) != 0 {
		t.Fatalf("dealer %d voorhand %d", d.Dealer(), d.Voorhand())
	}
	if m.Over() || m.Winner() != cards.NoSeat {
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
		rules := Rules{Limit: []int{10, 15}[k%2], Was: k%3 != 0, Armoede: k%5 != 0,
			Koning: k%4 != 0, Boer: k%7 != 3, Lijntoep: k%3 == 1, Bluf: k%2 == 0}
		m := NewMatch(players, rules, cards.Seat(rng.IntN(players)))
		for rounds := 0; !m.Over(); rounds++ {
			if rounds > 4*players*rules.Limit {
				t.Fatalf("match %d does not end", k)
			}
			d := m.Deal(Shuffle(rng))
			before := m.Points
			left := m.Left()
			poor := 0
			for s := range cards.Seat(players) {
				if m.Alive(s) && m.Points[s] == rules.Limit-1 {
					poor++
				}
			}
			if d.Koning() != (rules.Koning && poor == left) {
				t.Fatalf("match %d: koningsspel %v with %d of %d on armoede", k, d.Koning(), poor, left)
			}
			playRandom(t, rng, d)
			r := d.Result()
			checked := 0 // a winner pays only for checking a genuine was, or a bluff caught (rule Bluf)
			for _, c := range d.Checks() {
				if c.Checker == r.Winner && c.Genuine() || c.Claimant == r.Winner && c.Checker != cards.NoSeat && !c.Genuine() {
					checked++
				}
			}
			off := 0 // and has one off for the last trick taken with a boer
			if r.Boer && before[r.Winner]+checked > 0 {
				off = 1
			}
			if r.Gains[r.Winner] != checked-off || r.Out[r.Winner] {
				t.Fatalf("match %d: the winner %d took points: %+v", k, r.Winner, r)
			}
			if r.Boer && (!rules.Boer || !r.Tricks) {
				t.Fatalf("match %d: a boer without the rule or the last trick: %+v", k, r)
			}
			gained := 0
			for s := range players {
				if cards.Seat(s) != r.Winner && r.Points[s] < before[s] || r.Gains[s] != r.Points[s]-before[s] {
					t.Fatalf("match %d: points went down or gains wrong: %+v", k, r)
				}
				if cards.Seat(s) != r.Winner {
					gained += r.Gains[s]
				}
			}
			if gained == 0 && checked == 0 {
				t.Fatalf("match %d: a round without points", k)
			}
			if r.Koning && m.Left() > 1 && func() bool { m.Settle(d); return !m.Over() }() {
				t.Fatalf("match %d: the koningsspel did not end the match: %+v", k, r)
			}
			m.Settle(d)
		}
		if m.Winner() == cards.NoSeat {
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
			for s := range cards.Seat(d.Players()) {
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
		case PhaseDiscard:
			s := d.Turn()
			hand := d.Hand(s)
			rng.Shuffle(len(hand), func(i, j int) { hand[i], hand[j] = hand[j], hand[i] })
			must(t, d.Discard(s, hand[:d.Lay(s)]))
			if d.HandLen(s) != d.Size() {
				t.Fatalf("after laying away: %d cards", d.HandLen(s))
			}
		case PhaseToep:
			if d.poorAsk { // armoede's question: clockwise from the left of who leads
				lead, prev := int(d.FirstLeader()), 0
				for _, a := range d.Asking() {
					at := (int(a) - lead + d.Players()) % d.Players()
					if at <= prev || d.Armoede(a) {
						t.Fatalf("asking %v on armoede's question, first leader %d", d.Asking(), lead)
					}
					prev = at
				}
			}
			s := d.Turn()
			if d.CanRaise(s) && rng.IntN(5) == 0 {
				must(t, d.Overtoep(s))
				continue
			}
			stay := rng.IntN(3) != 0
			if d.MustStay(s) {
				if err := d.Answer(s, false); !errors.Is(err, ErrMustStay) {
					t.Fatalf("passed under anti-lijntoep: %v", err)
				}
				stay = true
			}
			must(t, d.Answer(s, stay))
		case PhasePlay:
			s := d.Turn()
			if len(d.Tricks()) == 0 && len(d.Current().Cards) == 0 && s != d.FirstLeader() {
				t.Fatalf("turn %d before the first card, first leader %d", s, d.FirstLeader())
			}
			if d.Points(s)+d.Stake() >= d.Rules().Limit && d.CanToep(s) {
				t.Fatalf("%d may toep with %d points at stake %d", s, d.Points(s), d.Stake())
			}
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
	seen := map[cards.Card]int{}
	for s := range d.Players() {
		for _, c := range d.hands[s] {
			seen[c]++
		}
		for _, c := range d.given[s] {
			seen[c]++
		}
	}
	for _, c := range d.stock {
		seen[c]++
	}
	for s := range d.Players() {
		for _, c := range d.laid[s] {
			seen[c]++
		}
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
	d := NewDeal(4, noWas(), 0, [MaxPlayers]int{}, cards.NewDeck())
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
	if v.Claimed[1] || v.Answered || !v.CanClaim || v.Turn != cards.NoSeat {
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

// The table remembers each seat's bluffs: a toep whose cards came on the
// table without one above an aas, and a claim checked and false.
func TestRecord(t *testing.T) {
	m := NewMatch(3, DefaultRules, 2)
	// Seat 1 claims a was that is none, and is checked; seat 0 toeps with
	// four pictures, and everyone goes along to the end.
	d := m.Deal(deck("JH QS KD AC", "JD QD KH 8C", "TS 9S 8S 7S"))
	must(t, d.Was(0, false))
	must(t, d.Was(1, true))
	must(t, d.Was(2, false))
	must2(t)(d.Check(2, true))
	if !d.Open(1) {
		t.Fatal("the bluffer plays open")
	}
	must(t, d.Toep(0))
	must(t, d.Answer(1, true))
	must(t, d.Answer(2, true))
	for d.Phase() != PhaseDone {
		must(t, d.Play(d.Turn(), d.Legal()[0]))
	}
	m.Settle(d)
	if want := (Record{Toeps: 1, ToepBluffs: 1}); m.Record[0] != want {
		t.Errorf("seat 0: %+v", m.Record[0])
	}
	if want := (Record{Claims: 1, ClaimBluffs: 1}); m.Record[1] != want {
		t.Errorf("seat 1: %+v", m.Record[1])
	}
	if d := m.Deal(cards.NewDeck()); d.View(2).Record != m.Record {
		t.Error("the next round's view knows the record")
	}
	// A toeper who wins by everyone passing shows nothing.
	m = NewMatch(2, Rules{Limit: 10}, 1)
	d = m.Deal(deck("JH QS KD AC", "TS 9S 8S 7S"))
	must(t, d.Toep(0))
	must(t, d.Answer(1, false))
	m.Settle(d)
	if m.Record[0] != (Record{}) {
		t.Errorf("nothing shown: %+v", m.Record[0])
	}
}

// Passing costs the stake a player last agreed to: after a toep and an
// overtoep, who went along with the toep pays its stake, who did not pays
// the stake from before it.
func TestPassCost(t *testing.T) {
	d := NewDeal(4, noWas(), 3, [MaxPlayers]int{}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S", "JS QS KS AS"))
	must(t, d.Toep(0)) // 2: asking 1, 2, 3
	must(t, d.Answer(1, true))
	must(t, d.Overtoep(2)) // 3: asking 3, 0, 1
	if !slices.Equal(d.Asking(), []cards.Seat{3, 0, 1}) {
		t.Fatalf("asking %v", d.Asking())
	}
	if d.PassCost(3) != 1 || d.PassCost(0) != 2 || d.PassCost(1) != 2 || d.View(3).PassCost != 1 {
		t.Fatalf("pass costs %d %d %d", d.PassCost(3), d.PassCost(0), d.PassCost(1))
	}
	must(t, d.Answer(3, false))
	must(t, d.Answer(0, true))
	must(t, d.Answer(1, false))
	if d.Points(3) != 1 || d.Points(1) != 2 || d.PassCost(0) != 3 {
		t.Errorf("points %d %d, seat 0 agreed to %d", d.Points(3), d.Points(1), d.PassCost(0))
	}
}
