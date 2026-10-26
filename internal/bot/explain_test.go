package bot

import (
	"math"
	"math/rand/v2"
	"strings"
	"testing"

	"klaverjas/internal/game"
)

// TestExplainAgreesWithAdvise explains every decision of a few deals: the
// hint is Advise's, the rule card is normaal's, sterk's card is sterk's on
// the same search, every option is listed once with its value, the best
// one without a standard error, and the parts of a card add up to its
// value less what was scored before it.
func TestExplainAgreesWithAdvise(t *testing.T) {
	deals := 4
	if testing.Short() {
		deals = 1
	}
	rng := rand.New(rand.NewPCG(71, 72))
	for i := range deals {
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			a, e := Advise(v), Explain(v)
			if !sameChoice(e.Hint, Choice{Card: a.Card, Suit: a.Suit, Play: a.Play}) || e.HintText != a.Text {
				t.Fatalf("explanation hint %+v %q, advice %+v %q", e.Hint, e.HintText, a, a.Text)
			}
			var want int
			switch d.Phase() {
			case game.PhaseBid:
				want = 2
				normal := trumpValue(setOf(v.Hand), v.Turned) >= bidThreshold(0.5)
				if e.Normaal.Play == nil || *e.Normaal.Play != normal || e.Rule != "" {
					t.Fatalf("bid: normaal %+v, rule %q", e.Normaal, e.Rule)
				}
			case game.PhaseTrump:
				want = 4
				if v.Forced {
					want = 3
				}
				if e.Normaal.Suit == nil || *e.Normaal.Suit != bestTrumpNormal(setOf(v.Hand), v.Forced, v.Turned) {
					t.Fatalf("trump: normaal %+v", e.Normaal)
				}
			case game.PhasePlay:
				want = len(v.Legal)
				if e.Normaal.Card == nil || *e.Normaal.Card != normalChoice(&v, 0.5) || !strings.HasPrefix(e.Rule, "Speel "+game.CardShortNL(*e.Normaal.Card)+": ") {
					t.Fatalf("play: normaal %+v, rule %q", e.Normaal, e.Rule)
				}
			}
			if len(e.Options) != want {
				t.Fatalf("%d options, want %d: %+v", len(e.Options), want, e.Options)
			}
			checkOptions(t, &v, e)
			var err error
			switch d.Phase() {
			case game.PhaseBid:
				err = d.Bid(s, *a.Play)
			case game.PhaseTrump:
				err = d.ChooseTrump(s, *a.Suit)
			case game.PhasePlay:
				err = d.Play(s, *a.Card)
			}
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	d := game.NewDeal(0, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	if e := Explain(d.View(3)); e.Worlds != 0 || e.Options != nil {
		t.Errorf("an explanation when it is not your turn: %+v", e)
	}
	if n := fallbacks.Load(); n != 0 {
		t.Errorf("the search failed %d times", n)
	}
}

// checkOptions checks the options of explanation e of view v.
func checkOptions(t *testing.T, v *game.View, e Explanation) {
	t.Helper()
	if v.Phase == game.PhasePlay && len(v.Legal) == 1 {
		if e.Worlds != 0 || !sameChoice(e.Sterk, e.Normaal) || e.HintText != e.Rule {
			t.Fatalf("one legal card: %+v", e)
		}
		return
	}
	if e.Worlds <= 0 {
		t.Fatalf("no worlds: %+v", e)
	}
	best := 0
	for i, o := range e.Options {
		if o.Value > e.Options[best].Value {
			best = i
		}
	}
	var before float64 // play: the score difference before the card
	for i, o := range e.Options {
		switch {
		case o.SE < 0 || i == best && o.SE != 0:
			t.Fatalf("option %d of %+v: SE %v", i, e.Options, o.SE)
		case o.NatUs < 0 || o.NatThem < 0 || o.NatUs+o.NatThem > 1:
			t.Fatalf("option %d: nat %v %v", i, o.NatUs, o.NatThem)
		case math.Abs(o.Us-o.Them-o.Value) > 1e-6:
			t.Fatalf("option %d: value %v, scores %v − %v", i, o.Value, o.Us, o.Them)
		}
		if v.Phase != game.PhasePlay {
			continue
		}
		if len(o.Parts) != numParts {
			t.Fatalf("option %d: parts %v", i, o.Parts)
		}
		// The parts add up to the value less what was scored before the
		// card, the same for every card.
		sum := 0.0
		for _, p := range o.Parts {
			sum += p
		}
		if i == 0 {
			before = o.Value - sum
		} else if math.Abs(o.Value-sum-before) > 1e-6 {
			t.Fatalf("option %d: value %v, parts %v, before %v", i, o.Value, o.Parts, before)
		}
	}
}

func sameChoice(x, y Choice) bool {
	return (x.Card == nil) == (y.Card == nil) && (x.Card == nil || *x.Card == *y.Card) &&
		(x.Suit == nil) == (y.Suit == nil) && (x.Suit == nil || *x.Suit == *y.Suit) &&
		(x.Play == nil) == (y.Play == nil) && (x.Play == nil || *x.Play == *y.Play)
}
