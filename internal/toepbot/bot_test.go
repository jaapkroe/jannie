package toepbot

import (
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

var cards = game.MustParseCards

// decide applies the decision of the bot of the seat whose answer the
// round of d awaits (or of every seat in the time for a was).
func decide(t testing.TB, d *toepen.Deal, bots []*Player) {
	t.Helper()
	switch d.Phase() {
	case toepen.PhaseWas:
		for s := range game.Seat(d.Players()) {
			if d.Status(s) == toepen.StatusIn && !d.Answered(s) {
				if err := d.Was(s, bots[s].Was(d.View(s))); err != nil {
					t.Fatal(err)
				}
				if d.Phase() != toepen.PhaseWas {
					return
				}
			}
		}
	case toepen.PhaseCheck:
		s := d.Turn()
		if _, err := d.Check(s, bots[s].Check(d.View(s))); err != nil {
			t.Fatal(err)
		}
	case toepen.PhaseDiscard:
		s := d.Turn()
		if err := d.Discard(s, bots[s].Discard(d.View(s))); err != nil {
			t.Fatal(err)
		}
	case toepen.PhaseToep:
		s := d.Turn()
		if v := d.View(s); bots[s].Overtoep(v) {
			if err := d.Overtoep(s); err != nil {
				t.Fatal(err)
			}
			return
		}
		if err := d.Answer(s, bots[s].Answer(d.View(s))); err != nil {
			t.Fatal(err)
		}
	case toepen.PhasePlay:
		s := d.Turn()
		v := d.View(s)
		if bots[s].Toep(v) {
			if err := d.Toep(s); err != nil {
				t.Fatal(err)
			}
			return
		}
		c := bots[s].Play(v)
		if !slices.Contains(v.Legal, c) {
			t.Fatalf("%v played %v, legal %v", bots[s].lvl, c, v.Legal)
		}
		if err := d.Play(s, c); err != nil {
			t.Fatal(err)
		}
	}
}

// Every level only makes legal decisions, at every table size, and the
// matches end.
func TestLegalDecisions(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 5))
	n := 60
	if testing.Short() {
		n = 18
	}
	for k := range n {
		players := 2 + k%5
		bots := make([]*Player, players)
		for s := range bots {
			bots[s] = New(rng.Float64(), Level((k+s)%3), rng.Uint64())
		}
		rules := toepen.Rules{Limit: 10, Was: k%2 == 0, Armoede: k%3 != 0}
		m := toepen.NewMatch(players, rules, 0)
		for rounds := 0; !m.Over(); rounds++ {
			if rounds > 200 {
				t.Fatal("match does not end")
			}
			d := m.Deal(toepen.Shuffle(rng))
			for steps := 0; d.Phase() != toepen.PhaseDone; steps++ {
				if steps > 300 {
					t.Fatal("round does not end")
				}
				decide(t, d, bots)
			}
			m.Settle(d)
		}
	}
}

func TestNormalCard(t *testing.T) {
	all := func(game.Seat) bool { return true }
	lead := toepen.Trick{Leader: 0}
	// Leading: low, and not from the suit of the card kept for the end.
	if c := normalCard(cards("TH JH 8S QD"), lead, all); c != cards("QD")[0] {
		t.Errorf("lead %v, want ♦V", c)
	}
	// Following: the lowest, keeping the best.
	tr := toepen.Trick{Leader: 1, Cards: []game.Played{{Seat: 1, Card: cards("8H")[0]}}}
	if c := normalCard(cards("TH JH 9H AS"), tr, all); c != cards("JH")[0] {
		t.Errorf("follow %v, want ♥B", c)
	}
	// Cannot follow: throw the weakest.
	if c := normalCard(cards("TS QD 9C"), tr, all); c != cards("QD")[0] {
		t.Errorf("discard %v, want ♦V", c)
	}
	// The trick before the last: take it with the card not kept.
	if c := normalCard(cards("9H TH"), tr, all); c != cards("9H")[0] {
		t.Errorf("third trick %v, want ♥9", c)
	}
}

func TestAnswerWhenOutAnyway(t *testing.T) {
	// Passing at stake 2 costs 1 point: seat 0 has 9 of 10, so it is out
	// either way and goes along.
	p := New(0, Normaal, 1)
	v := toepen.View{
		Players: 3, Seat: 0, Phase: toepen.PhaseToep, Turn: 0, Stake: 2, PassCost: 1,
		Rules: toepen.Rules{Limit: 10}, Hand: cards("JH QS KD 8C"),
		Points: [toepen.MaxPlayers]int{9, 0, 0},
		Status: [toepen.MaxPlayers]toepen.Status{toepen.StatusIn, toepen.StatusIn, toepen.StatusIn},
		Cards:  [toepen.MaxPlayers]int{4, 4, 4},
	}
	if !p.Answer(v) {
		t.Error("passed into going out")
	}
	// With nothing at risk and a hopeless hand it passes.
	v.Points[0] = 0
	v.Toeps = []toepen.Toep{{Seat: 1, Stake: 2}}
	v.Current = toepen.Trick{Leader: 2, Cards: []game.Played{{Seat: 2, Card: cards("TH")[0]}}}
	v.Cards[2] = 3
	if p.Answer(v) {
		t.Error("went along with nothing")
	}
}

func TestWasChance(t *testing.T) {
	// Against counting every hand of four from the 28 cards a hand of
	// four eights leaves.
	pool := slices.DeleteFunc(game.NewDeck(), func(c game.Card) bool { return c.Rank == game.Eight })
	n, was := 0, 0
	for a := range pool {
		for b := a + 1; b < len(pool); b++ {
			for c := b + 1; c < len(pool); c++ {
				for d := c + 1; d < len(pool); d++ {
					n++
					if toepen.Was([]game.Card{pool[a], pool[b], pool[c], pool[d]}) != toepen.NoWas {
						was++
					}
				}
			}
		}
	}
	if got, want := wasChance(pool), float64(was)/float64(n); math.Abs(got-want) > 1e-12 {
		t.Errorf("wasChance %v, counted %v", got, want)
	}
}

func TestCheck(t *testing.T) {
	v := toepen.View{
		Players: 3, Seat: 1, Phase: toepen.PhaseCheck, Turn: 1, Claimant: 0, Stake: 1,
		Rules:  toepen.Rules{Limit: 10, Was: true},
		Status: [toepen.MaxPlayers]toepen.Status{toepen.StatusIn, toepen.StatusIn, toepen.StatusIn},
	}
	p := New(0.5, Sterk, 1)
	// Holding four pictures, a real was is unlikely: check.
	v.Hand = cards("JH QS KD AC")
	if !p.Check(v) {
		t.Error("did not check with four pictures in hand")
	}
	// Holding no picture and no 7, a real one is likely: let it go.
	v.Hand = cards("8H 9S TD 8C")
	if p.Check(v) {
		t.Error("checked with no pictures in hand")
	}
}

// The levels against each other at a table of four, two seats each, every
// deal played twice with the levels on swapped seats: the stronger level
// takes fewer penalty points per round.
func TestArena(t *testing.T) {
	if testing.Short() {
		t.Skip("arena: slow")
	}
	pairs := []struct {
		strong, weak Level
		deals        int
	}{
		{Normaal, Makkelijk, 1500},
		{Sterk, Normaal, 700},
	}
	rules := toepen.Rules{Limit: 1000, Was: true}
	for _, pr := range pairs {
		rng := rand.New(rand.NewPCG(42, uint64(pr.strong)))
		var strong, weak float64
		for range pr.deals {
			deck := toepen.Shuffle(rng)
			dealer := game.Seat(rng.IntN(4))
			for swap := range 2 {
				bots := make([]*Player, 4)
				for s := range bots {
					lvl := pr.weak
					if (s+swap)%2 == 0 {
						lvl = pr.strong
					}
					bots[s] = New(0.5, lvl, rng.Uint64())
				}
				d := toepen.NewDeal(4, rules, dealer, [toepen.MaxPlayers]int{}, deck)
				for d.Phase() != toepen.PhaseDone {
					decide(t, d, bots)
				}
				for s, g := range d.Result().Gains {
					if bots[s].lvl == pr.strong {
						strong += float64(g)
					} else {
						weak += float64(g)
					}
				}
			}
		}
		rounds := float64(2 * pr.deals)
		t.Logf("%v %.3f vs %v %.3f penalty points per round for two seats", pr.strong, strong/rounds, pr.weak, weak/rounds)
		if strong >= weak {
			t.Errorf("%v (%.0f points) does not beat %v (%.0f)", pr.strong, strong, pr.weak, weak)
		}
	}
}

func BenchmarkSterkCard(b *testing.B) {
	rng := rand.New(rand.NewPCG(1, 2))
	p := New(0.5, Sterk, 3)
	for b.Loop() {
		d := toepen.NewDeal(4, toepen.Rules{Limit: 10}, 3, [toepen.MaxPlayers]int{}, toepen.Shuffle(rng))
		v := d.View(d.Turn())
		p.Toep(v)
		p.Play(v)
	}
}

func TestChat(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 1))
	for kind := range lines {
		said := 0
		for range 200 {
			text := Chat("bram", 1, ChatEvent{Kind: kind, Mine: true, Points: 3}, rng)
			if text == "" {
				continue
			}
			said++
			if strings.Contains(text, "{n}") || strings.Contains(text, "goedenavond") {
				t.Errorf("%s: %q", kind, text)
			}
		}
		if said == 0 && !strings.HasSuffix(kind, "/opp") {
			t.Errorf("never a line for %s", kind)
		}
	}
	if Chat("dirk", 1, ChatEvent{Kind: "toep"}, rand.New(rand.NewPCG(2, 2))) == "Toep!" {
		t.Error("someone else's toep is not the bot's own")
	}
	if Chat("dirk", 1, ChatEvent{Kind: "reply", Text: "Hoi allemaal"}, rng) == "" {
		t.Error("no answer to hoi")
	}
	if Chat("dirk", 1, ChatEvent{Kind: "nope"}, rng) != "" {
		t.Error("a line for an unknown kind")
	}
}

// In the koningsspel every level lays away legal cards, and sterk's eight
// take the last trick at least as often as the weakest-cards rule's.
func TestDiscard(t *testing.T) {
	rng := rand.New(rand.NewPCG(5, 6))
	rules := toepen.DefaultRules
	won := map[Level]int{}
	for k := range 150 {
		deck := toepen.Shuffle(rng)
		for _, lvl := range []Level{Makkelijk, Normaal, Sterk} {
			d := toepen.NewDeal(2, rules, 1, [toepen.MaxPlayers]int{9, 9}, deck)
			if d.Phase() != toepen.PhaseDiscard {
				t.Fatalf("no laying away: %v", d.Phase())
			}
			bots := []*Player{New(0.5, lvl, uint64(k)), New(0.5, Normaal, uint64(k)+1)}
			for d.Phase() != toepen.PhaseDone {
				decide(t, d, bots)
			}
			if d.Result().Winner == 0 {
				won[lvl]++
			}
		}
	}
	t.Logf("koningsspel won against normaal of 150: %v", won)
	if won[Sterk] < won[Normaal] {
		t.Errorf("sterk lays away worse than the rule: %v", won)
	}
}

// The reasoning for every kind of decision: an option marked best, an
// advice and a reason in Dutch, and the rule of thumb.
func TestExplain(t *testing.T) {
	rules := toepen.DefaultRules
	best := func(e Explanation) int {
		n := 0
		for _, o := range e.Options {
			if o.Best {
				n++
			}
		}
		return n
	}
	// A card, on a turn that may toep: every legal card and Toepen.
	d := toepen.NewDeal(3, toepen.Rules{Limit: 10}, 2, [toepen.MaxPlayers]int{}, deck("TH 9H 8H 7H", "JH QH KH AH", "TS 9S 8S 7S"))
	e := Explain(d.View(0), 1)
	if e.Decision != "kaart" || len(e.Options) != 5 || e.Options[4].Label != "Toepen" || e.Advice == "" || e.Why == "" || e.Rule == "" || e.RuleCard == nil {
		t.Fatalf("card: %+v", e)
	}
	if !e.Options[4].Best || !strings.HasPrefix(e.Advice, "Toep") || e.Chance < 0.9 {
		t.Errorf("the four best hearts toep: %+v", e)
	}
	// Asked about a toep with nothing: pass.
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(d.Toep(0))
	e = Explain(d.View(1), 1)
	if e.Decision != "antwoord" || e.Advice != "Pas" || best(e) != 1 || len(e.Options) != 3 {
		t.Errorf("answer: %+v", e)
	}
	// The vuile was: a real one is handed in; a hopeless bluff may be.
	d = toepen.NewDeal(3, rules, 2, [toepen.MaxPlayers]int{}, deck("JH QS KD 7C", "TH 9H 8H 7H", "TS 9S 8S 7S"))
	if e = Explain(d.View(0), 1); e.Decision != "was" || !e.Options[0].Best || !strings.HasPrefix(e.Advice, "Lever in") {
		t.Errorf("was: %+v", e)
	}
	// A check: holding four pictures, a real one is unlikely.
	must(d.Was(0, true))
	must(d.Was(1, false))
	must(d.Was(2, false))
	v := d.View(1)
	v.Hand = cards("JD QH KS AC")
	if e = Explain(v, 1); e.Decision != "controle" || e.Advice != "Controleer" || e.Chance != -1 {
		t.Errorf("check: %+v", e)
	}
	// Laying away in the koningsspel: the five best choices.
	d = toepen.NewDeal(2, rules, 1, [toepen.MaxPlayers]int{9, 9}, toepen.Shuffle(rand.New(rand.NewPCG(3, 4))))
	if e = Explain(d.View(0), 1); e.Decision != "wegleggen" || len(e.Options) != 5 || len(e.Options[0].Cards) != 3 || !e.Options[0].Best ||
		e.Options[0].Value < e.Options[4].Value {
		t.Errorf("discard: %+v", e)
	}
}

// deck lays out a deck for NewDeal: the hands in dealing order, then the
// other cards in deck order.
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

// The bots remember: who bluffed often is checked sooner and gets more
// going along; and they bluff themselves, at any stake.
func TestMemoryAndBluffs(t *testing.T) {
	rng := rand.New(rand.NewPCG(9, 9))
	liar := toepen.Record{Toeps: 6, ToepBluffs: 5, Claims: 6, ClaimBluffs: 5}
	honest := toepen.Record{Toeps: 6, Claims: 6}
	for _, lvl := range []Level{Normaal, Sterk} {
		checks, stays := map[bool]int{}, map[bool]int{}
		for range 120 {
			deck := toepen.Shuffle(rng)
			for _, lies := range []bool{false, true} {
				rec := map[bool]toepen.Record{false: honest, true: liar}[lies]
				// A claim of seat 0, seat 1 asked to check.
				d := toepen.NewDeal(3, toepen.DefaultRules, 2, [toepen.MaxPlayers]int{}, deck)
				_ = d.Was(0, true)
				_ = d.Was(1, false)
				_ = d.Was(2, false)
				if d.Phase() == toepen.PhaseCheck && d.Turn() == 1 {
					v := d.View(1)
					v.Record[0] = rec
					if New(0.5, lvl, 1).Check(v) {
						checks[lies]++
					}
				}
				// A toep of seat 0, seat 1 asked.
				d = toepen.NewDeal(3, toepen.Rules{Limit: 10}, 2, [toepen.MaxPlayers]int{}, deck)
				if err := d.Toep(0); err != nil {
					t.Fatal(err)
				}
				v := d.View(1)
				v.Record[0] = rec
				if New(0.5, lvl, 2).Answer(v) {
					stays[lies]++
				}
			}
		}
		t.Logf("%v: checks %v, goes along %v (false: honest, true: a liar)", lvl, checks, stays)
		if checks[true] <= checks[false] || stays[true] <= stays[false] {
			t.Errorf("%v does not read the liar: checks %v, stays %v", lvl, checks, stays)
		}
	}
	// Bluffs at a stake above 2: a hand with little chance toeps now and
	// then, so a toep of a bot is not always real.
	d := toepen.NewDeal(3, toepen.Rules{Limit: 15}, 2, [toepen.MaxPlayers]int{}, deck("JH QS KD JC", "TS 9S 8S 7S", "TH 9H 8H 7H"))
	v := d.View(0)
	v.Stake = 3
	if q := New(0.5, Sterk, 1).winChance(&v); q >= New(0.5, Sterk, 1).toepBar(&v)-0.1 {
		t.Fatalf("not a weak hand: %.2f", q)
	}
	bluffs := 0
	for k := range 400 {
		if New(0.9, Sterk, uint64(k)).Toep(v) {
			bluffs++
		}
	}
	t.Logf("a weak hand toeps at stake 3 in %d of 400", bluffs)
	if bluffs == 0 || bluffs > 100 {
		t.Errorf("bluffs at stake 3: %d of 400", bluffs)
	}
}

// lastTrickWithTen plays a round of two to its last trick, in which seat 1
// leads the 10 of spades: nobody can beat it, and everyone knows it.
func lastTrickWithTen(t *testing.T, points [toepen.MaxPlayers]int) *toepen.Deal {
	t.Helper()
	d := toepen.NewDeal(2, toepen.Rules{Limit: 10}, 0, points, deck("9H 8H 7H TS", "7D QD KD JD"))
	for _, p := range []struct {
		s game.Seat
		c string
	}{{1, "9H"}, {0, "7D"}, {1, "8H"}, {0, "QD"}, {1, "7H"}, {0, "KD"}, {1, "TS"}} {
		if err := d.Play(p.s, cards(p.c)[0]); err != nil {
			t.Fatal(p, err)
		}
	}
	return d
}

// No bluff that cannot work: after an unbeatable 10 in the last trick a
// toep only raises the bot's own loss, so no level toeps; and asked about
// a toep there, every level passes.
func TestNoPointlessToep(t *testing.T) {
	v := lastTrickWithTen(t, [toepen.MaxPlayers]int{}).View(0)
	if !v.CanToep || !pointless(&v) {
		t.Fatalf("the spot: canToep %v pointless %v", v.CanToep, pointless(&v))
	}
	for _, lvl := range []Level{Makkelijk, Normaal, Sterk} {
		for k := range 500 {
			if New(1, lvl, uint64(k)).Toep(v) {
				t.Fatalf("%v toeps against a known winner", lvl)
			}
		}
	}
	// Seat 1 toeps, then leads the 10; seat 0 went along.
	d := toepen.NewDeal(2, toepen.Rules{Limit: 10}, 0, [toepen.MaxPlayers]int{}, deck("9H 8H 7H TS", "7D QD KD JD"))
	for _, p := range []struct {
		s game.Seat
		c string
	}{{1, "9H"}, {0, "7D"}, {1, "8H"}, {0, "QD"}, {1, "7H"}, {0, "KD"}} {
		if err := d.Play(p.s, cards(p.c)[0]); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.Toep(1); err != nil { // seat 1 leads the last trick: it toeps first
		t.Fatal(err)
	}
	if err := d.Answer(0, true); err != nil {
		t.Fatal(err)
	}
	if err := d.Play(1, cards("TS")[0]); err != nil {
		t.Fatal(err)
	}
	// Now seat 0 may toep back (seat 1 toept last): pointless.
	v = d.View(0)
	if v.CanToep {
		for _, lvl := range []Level{Makkelijk, Normaal, Sterk} {
			if New(1, lvl, 1).Toep(v) {
				t.Errorf("%v toeps back against the 10", lvl)
			}
		}
	}
	// Asked about a toep in a lost last trick: pass.
	v.Phase, v.Toeper, v.Stake, v.PassCost = toepen.PhaseToep, 1, 3, 2
	v.Record[1] = toepen.Record{Toeps: 6, ToepBluffs: 6}
	for _, lvl := range []Level{Makkelijk, Normaal, Sterk} {
		for k := range 200 {
			if New(1, lvl, uint64(k)).Answer(v) {
				t.Fatalf("%v goes along into a lost last trick", lvl)
			}
		}
	}
}

// No bot calls into going out with a weak hand when passing keeps it in:
// at 8 of 10, a toep to 2 with a hopeless hand is passed for 1.
func TestNoCallIntoGoingOut(t *testing.T) {
	d := toepen.NewDeal(3, toepen.Rules{Limit: 10}, 2, [toepen.MaxPlayers]int{8, 0, 0}, deck("JH QS KD 8C", "TH 9H 8H 7H", "TS 9S 8S 7S"))
	if err := d.Play(0, cards("8C")[0]); err != nil {
		t.Fatal(err)
	}
	if err := d.Toep(1); err != nil {
		t.Fatal(err)
	}
	if err := d.Answer(2, true); err != nil {
		t.Fatal(err)
	}
	if err := d.Overtoep(2); err == nil {
		t.Fatal("a second answer")
	}
	v := d.View(0)
	if v.Turn != 0 || v.PassCost != 1 {
		t.Fatalf("seat 0 asked, pass cost %d", v.PassCost)
	}
	v.Record[1] = toepen.Record{Toeps: 6, ToepBluffs: 5} // even against a bluffer
	for _, lvl := range []Level{Makkelijk, Normaal, Sterk} {
		for k := range 200 {
			if New(1, lvl, uint64(k)).Answer(v) {
				t.Fatalf("%v calls into going out", lvl)
			}
		}
	}
}
