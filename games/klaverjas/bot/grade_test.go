package bot

import (
	"flag"
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"testing"

	"jannie/games/klaverjas/game"
)

// TestGradeAgreesWithAdvise grades every option of every decision in a few
// deals: the hint's option loses nothing, another option loses at most the
// stake and names the hint's option and text, and a lone legal card gets
// no grade.
func TestGradeAgreesWithAdvise(t *testing.T) {
	deals := 6
	if testing.Short() {
		deals = 2
	}
	rng := rand.New(rand.NewPCG(61, 62))
	lost, graded := 0, 0
	for i := range deals {
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			a := Advise(v)
			var options []Choice
			switch d.Phase() {
			case game.PhaseBid:
				options = []Choice{{Play: ptr(true)}, {Play: ptr(false)}}
			case game.PhaseTrump:
				for su := game.Suit(0); su < game.NumSuits; su++ {
					if !(v.Forced && su == v.Turned) {
						options = append(options, Choice{Suit: ptr(su)})
					}
				}
			case game.PhasePlay:
				for _, c := range v.Legal {
					options = append(options, Choice{Card: ptr(c)})
				}
			}
			for _, c := range options {
				g := GradeChoice(v, c)
				if d.Phase() == game.PhasePlay && len(v.Legal) == 1 {
					if g != (Grade{}) {
						t.Fatalf("a lone legal card got a grade: %+v", g)
					}
					continue
				}
				graded++
				advised := c.Card != nil && *c.Card == *a.Card || c.Suit != nil && *c.Suit == *a.Suit || c.Play != nil && *c.Play == *a.Play
				switch {
				case g.Stake < 0 || g.Lost < 0 || g.Gain < 0 || g.Lost > g.Stake+1e-9:
					t.Fatalf("grade %+v of %+v out of range", g, c)
				case advised && g.Lost > 0:
					t.Fatalf("the hint's option %+v loses %.1f", c, g.Lost)
				case g.Lost > 0 && g.Text != a.Text:
					t.Fatalf("grade text %q, hint %q", g.Text, a.Text)
				case g.Lost > 0 && !(g.Better.Card != nil && *g.Better.Card == *a.Card || g.Better.Suit != nil && *g.Better.Suit == *a.Suit ||
					g.Better.Play != nil && *g.Better.Play == *a.Play):
					t.Fatalf("grade names %+v as better, the hint %+v", g.Better, a)
				case g.Gain > 0 && (g.Lost > 0 || !advised || g.Text == ""):
					t.Fatalf("strong grade %+v for %+v (hint %+v)", g, c, a)
				case (c.Play == nil || !*c.Play) && g.Nat != 0, g.Nat < 0 || g.Nat > 1:
					t.Fatalf("nat chance %v for %+v", g.Nat, c)
				case (g.Gain > 0) != (g.Obvious != Choice{}):
					t.Fatalf("strong grade %+v names the obvious option %+v", g, g.Obvious)
				case !outcomesAdd(g):
					t.Fatalf("grade %+v: the outcomes do not add up to its points", g)
				}
				if g.Lost > 0 {
					lost++
				}
			}
			last := options[len(options)-1]
			if a, b := GradeChoice(v, last), GradeChoice(v, last); !sameGrade(a, b) {
				t.Fatalf("grade not deterministic: %+v then %+v", a, b)
			}
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
	t.Logf("%d of %d graded options lose points", lost, graded)
	if lost == 0 {
		t.Error("no option ever loses points")
	}
	d := game.NewDeal(0, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	if g := GradeChoice(d.View(3), Choice{Suit: ptr(game.Hearts)}); g != (Grade{}) {
		t.Errorf("a grade when it is not your turn: %+v", g)
	}
	if n := fallbacks.Load(); n != 0 {
		t.Errorf("the search failed %d times", n)
	}
}

// outcomesAdd reports whether the outcomes of a grade explain its points:
// the score difference of the better option minus that of the worse one,
// both nat chances within [0, 1]; and no outcomes without points.
func outcomesAdd(g Grade) bool {
	diff := func(o Outcome) float64 { return o.Us - o.Them }
	ok := func(o Outcome) bool { return o.NatUs >= 0 && o.NatThem >= 0 && o.NatUs+o.NatThem <= 1 }
	switch {
	case g.Lost > 0:
		return math.Abs(diff(g.Other)-diff(g.Played)-g.Lost) < 1e-6 && ok(g.Played) && ok(g.Other)
	case g.Gain > 0:
		return math.Abs(diff(g.Played)-diff(g.Other)-g.Gain) < 1e-6 && ok(g.Played) && ok(g.Other)
	}
	return g.Played == Outcome{} && g.Other == Outcome{}
}

func sameGrade(a, b Grade) bool {
	same := func(x, y Choice) bool {
		return (x.Card == nil) == (y.Card == nil) && (x.Card == nil || *x.Card == *y.Card) &&
			(x.Suit == nil) == (y.Suit == nil) && (x.Suit == nil || *x.Suit == *y.Suit) &&
			(x.Play == nil) == (y.Play == nil) && (x.Play == nil || *x.Play == *y.Play)
	}
	return a.Stake == b.Stake && a.Lost == b.Lost && a.Gain == b.Gain && a.Text == b.Text && a.Nat == b.Nat && same(a.Better, b.Better) &&
		same(a.Obvious, b.Obvious) && a.Played == b.Played && a.Other == b.Other
}

// dealFor deals hand to seat 0 (voorhand, utrechts) and the remaining cards
// at random to the others.
func dealFor(hand string, seed uint64) *game.Deal {
	var hands [4][]game.Card
	hands[0] = game.MustParseCards(hand)
	rest := (allCards &^ setOf(hands[0])).appendCards(nil)
	rng := rand.New(rand.NewPCG(seed, seed+1))
	rng.Shuffle(len(rest), func(i, j int) { rest[i], rest[j] = rest[j], rest[i] })
	for s := 1; s < 4; s++ {
		hands[s] = rest[(s-1)*8 : s*8]
	}
	return game.NewDeal(3, hands, game.Utrechts, game.Amsterdams, 0)
}

func TestGradeTrump(t *testing.T) {
	v := dealFor("JH 9H AH TH KH AS AD AC", 1).View(0)
	if g := GradeChoice(v, Choice{Suit: ptr(game.Hearts)}); g.Lost != 0 || g.Stake <= 0 {
		t.Errorf("hearts with boer, nel, aas, 10 and heer: %+v", g)
	}
	g := GradeChoice(v, Choice{Suit: ptr(game.Spades)})
	if g.Lost < 50 || g.Better.Suit == nil || *g.Better.Suit != game.Hearts || !strings.HasPrefix(g.Text, "Kies ♥ als troef: ") {
		t.Errorf("spades with only the ace: %+v", g)
	}
}

func TestHandLuck(t *testing.T) {
	if l := HandLuck(dealFor("JH 9H AH TH KH AS AD AC", 2).View(0)); l < 60 {
		t.Errorf("five top hearts and three aces: luck %.1f", l)
	}
	if l := HandLuck(dealFor("7H 8H 7S 8S 7D 8D 7C 8C", 3).View(0)); l > -30 {
		t.Errorf("all sevens and eights: luck %.1f", l)
	}
	// Over random hands in every seat, mode and rules, luck averages zero.
	rng := rand.New(rand.NewPCG(63, 64))
	n := 200
	if testing.Short() {
		n = 40
	}
	var sum, sumSq float64
	for i := range n {
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		l := HandLuck(d.View(game.Seat(rng.IntN(4))))
		sum += l
		sumSq += l * l
	}
	mean := sum / float64(n)
	se := math.Sqrt((sumSq/float64(n) - mean*mean) / float64(n))
	t.Logf("luck over %d random hands: %.1f ± %.1f", n, mean, 2*se)
	if math.Abs(mean) > 3*se+1 {
		t.Errorf("luck of random hands averages %.1f ± %.1f", mean, 2*se)
	}
}

var gradeGames = flag.Int("grade.games", 24, "grade levels: 16-hand games per level")

var breakdownDeals = flag.Int("grade.breakdown", 0, "grade breakdown: deals to play (0 skips the test)")

// TestGradeBreakdown shows where the points of large losses come from: a
// player at normaal strength, the others playing the hint, its card
// choices graded, and every loss of 30 points or more split into what the
// two cards bring each team and the chance of nat. Run with
// -grade.breakdown 60 -v.
func TestGradeBreakdown(t *testing.T) {
	if *breakdownDeals == 0 {
		t.Skip("-grade.breakdown N")
	}
	rng := rand.New(rand.NewPCG(181, 182))
	var lost []float64
	var lines []string
	for i := range *breakdownDeals {
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			a := Advise(v)
			var err error
			switch d.Phase() {
			case game.PhaseBid:
				err = d.Bid(s, *a.Play)
			case game.PhaseTrump:
				err = d.ChooseTrump(s, *a.Suit)
			case game.PhasePlay:
				c := *a.Card
				if s == 0 && len(v.Legal) > 1 {
					tab := tableFromView(&v)
					m := newMover(&tab, s, setOf(v.Hand), setOf(v.Legal), 0.5)
					c = m.choose()
					g := GradeChoice(v, Choice{Card: &c})
					lost = append(lost, g.Lost)
					if p, o := g.Played, g.Other; g.Lost >= 30 {
						lines = append(lines, fmt.Sprintf("%5.1f: %s (%d) for %s (%d), trump %s, trick %d | us %+5.1f them %+5.1f | nat us %3.0f%% → %3.0f%%, them %3.0f%% → %3.0f%%",
							g.Lost, game.CardShortNL(c), game.Points(c, v.Trump), game.CardShortNL(*g.Better.Card), game.Points(*g.Better.Card, v.Trump),
							v.Trump.Symbol(), len(v.Tricks)+1, o.Us-p.Us, o.Them-p.Them, 100*p.NatUs, 100*o.NatUs, 100*p.NatThem, 100*o.NatThem))
					}
				}
				err = d.Play(s, c)
			}
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	slices.Sort(lost)
	n := 0
	for _, l := range lost {
		if l > 0 {
			n++
		}
	}
	q := func(p float64) float64 { return lost[int(p*float64(len(lost)-1))] }
	t.Logf("%d graded cards, %d lose points; median %.1f, p90 %.1f, p99 %.1f, max %.1f", len(lost), n, q(.5), q(.9), q(.99), lost[len(lost)-1])
	slices.Sort(lines)
	slices.Reverse(lines)
	for _, l := range lines {
		t.Log(l)
	}
}

// TestGradeLevels plays games with a bot of each level at seat 0 (normaal
// bots elsewhere), grades its decisions as the review does and reports the
// numbers the review shows. The percentage must order the levels, and the
// verdicts of the review (reviewVerdict in web/js/util.js, from 95% sterk
// gespeeld, from 82% goed gespeeld) must fit their averages.
func TestGradeLevels(t *testing.T) {
	if testing.Short() {
		t.Skip("slow")
	}
	var pcts [3]float64
	for lvl := Makkelijk; lvl <= Sterk; lvl++ {
		var games []float64
		var strong, missed, lucks []float64
		for gi := range *gradeGames {
			rng := rand.New(rand.NewPCG(uint64(lvl)*1000+uint64(gi), 65))
			var players [4]Player
			for s := range players {
				l := Normaal
				if s == 0 {
					l = lvl
				}
				players[s] = newPlayer(roster[(gi+s)%len(roster)], l, rng.Uint64(), defaultSearch)
			}
			var stake, lost, luck float64
			var nStrong, nMissed int
			for hand := range 16 {
				d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(gi%2), game.Rules(hand%2), game.Suit(rng.IntN(4)))
				luck += HandLuck(d.View(0))
				for d.Phase() != game.PhaseDone {
					s := d.Turn()
					v := d.View(s)
					var c Choice
					var err error
					switch d.Phase() {
					case game.PhaseBid:
						c.Play = ptr(players[s].Bid(v))
						err = d.Bid(s, *c.Play)
					case game.PhaseTrump:
						c.Suit = ptr(players[s].ChooseTrump(v))
						err = d.ChooseTrump(s, *c.Suit)
					case game.PhasePlay:
						c.Card = ptr(players[s].Play(v))
						err = d.Play(s, *c.Card)
					}
					if err != nil {
						t.Fatal(err)
					}
					if s != 0 {
						continue
					}
					g := GradeChoice(v, c)
					stake += g.Stake
					lost += g.Lost
					if g.Lost > 0 {
						nMissed++
					}
					if g.Gain > 0 {
						nStrong++
					}
				}
			}
			games = append(games, 100*(1-lost/stake))
			strong = append(strong, float64(nStrong))
			missed = append(missed, float64(nMissed))
			lucks = append(lucks, luck/16)
		}
		pcts[lvl] = mean(games)
		t.Logf("%-9s %% %s; sterke zetten %s; laten liggen %s; kaarten %s", lvl,
			spread(games), spread(strong), spread(missed), spread(lucks))
	}
	if !(pcts[Sterk] > pcts[Normaal] && pcts[Normaal] > pcts[Makkelijk]) {
		t.Errorf("percentages do not order the levels: %.1f", pcts)
	}
	if !(pcts[Sterk] >= 95 && pcts[Normaal] >= 82 && pcts[Normaal] < 95 && pcts[Makkelijk] < 82) {
		t.Errorf("average percentages %.1f no longer fit the verdicts' bounds 82 and 95", pcts)
	}
}

func mean(xs []float64) float64 {
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

// spread shows the mean, and the minimum, quartiles and maximum.
func spread(xs []float64) string {
	s := slices.Sorted(slices.Values(xs))
	q := func(p float64) float64 { return s[int(p*float64(len(s)-1)+0.5)] }
	return strings.Join([]string{
		"gem " + ftoa(mean(xs)),
		"[" + ftoa(s[0]) + " " + ftoa(q(0.25)) + " " + ftoa(q(0.5)) + " " + ftoa(q(0.75)) + " " + ftoa(s[len(s)-1]) + "]",
	}, " ")
}

func ftoa(x float64) string { return strconv.FormatFloat(x, 'f', 1, 64) }
