package bot

import (
	"math"
	"strings"
	"testing"

	"klaverjas/internal/game"
)

func TestPairSE(t *testing.T) {
	// Per-world values 10 20 30 40 and 8 18 28 44: differences 2 2 2 -4,
	// mean 0.5, sample variance 9, so the standard error is 1.5.
	a, b := []int64{10, 20, 30, 40}, []int64{8, 18, 28, 44}
	res := []playResult{{card: card("AS")}, {card: card("8S")}}
	for w := range a {
		res[0].total += a[w]
		res[1].total += b[w]
		d := a[w] - b[w]
		res[0].diffSq[1] += d * d
		res[1].diffSq[0] += d * d
	}
	res[0].n, res[1].n = 4, 4
	if se := pairSE(res, 0, 1); math.Abs(se-1.5) > 1e-9 {
		t.Errorf("pairSE = %v, want 1.5", se)
	}
	if se := pairSE(res, 1, 0); math.Abs(se-1.5) > 1e-9 {
		t.Errorf("pairSE is not symmetric: %v", se)
	}
	if se := pairSE(res, 0, 0); se != 0 {
		t.Errorf("pairSE of a card with itself = %v", se)
	}
}

// TestSearchPairStats: searchPlay's squared differences are symmetric and
// consistent with the totals (Σd² ≥ (Σd)²/n), and do not depend on the
// number of goroutines.
func TestSearchPairStats(t *testing.T) {
	_, v := benchViews()
	tab := tableFromView(&v)
	var runs [2][]playResult
	for k, workers := range []int{1, 4} {
		runs[k] = searchPlay(&v, &tab, searchConfig{playWorlds: 64, workers: workers}, 99, 0.5)
	}
	res := runs[0]
	if len(res) < 3 {
		t.Fatalf("want a view with at least 3 legal cards, got %d", len(res))
	}
	for i := range res {
		if res[i] != runs[1][i] {
			t.Errorf("result %d differs with 4 workers: %+v vs %+v", i, res[i], runs[1][i])
		}
		if res[i].diffSq[i] != 0 {
			t.Errorf("diffSq[%d][%d] = %d", i, i, res[i].diffSq[i])
		}
		for j := range res {
			if res[i].diffSq[j] != res[j].diffSq[i] {
				t.Errorf("diffSq not symmetric at %d,%d", i, j)
			}
			d := float64(res[i].total - res[j].total)
			if float64(res[i].diffSq[j])*float64(res[i].n) < d*d-1e-6 {
				t.Errorf("diffSq[%d][%d] = %d below (Σd)²/n = %.1f", i, j, res[i].diffSq[j], d*d/float64(res[i].n))
			}
		}
	}
}

func TestBestResultTies(t *testing.T) {
	res := []playResult{{card: card("9H"), total: 100}, {card: card("7H"), total: 100}, {card: card("8H"), total: 100}, {card: card("AS"), total: 90}}
	if got := res[bestResult(res, card("AS"), game.Spades)].card; got != card("7H") {
		t.Errorf("equal totals went to %v, want the cheapest card ♥7", got)
	}
	if got := res[bestResult(res, card("8H"), game.Spades)].card; got != card("8H") {
		t.Errorf("equal totals went to %v, want the preferred card ♥8", got)
	}
	// Trump is dearer than a side card of the same rank.
	res = []playResult{{card: card("7S"), total: 50}, {card: card("7H"), total: 50}}
	if got := res[bestResult(res, card("AD"), game.Spades)].card; got != card("7H") {
		t.Errorf("equal totals went to %v, want the side card ♥7 before trump", got)
	}
	res[0].total++
	if got := res[bestResult(res, card("7H"), game.Spades)].card; got != card("7S") {
		t.Errorf("a higher total lost to the tie-break: %v", got)
	}
}

// fakeResults returns search results for v.Legal with the given mean per
// card (others 0), every pair with standard error se.
func fakeResults(v *game.View, means map[string]float64, se float64) []playResult {
	const n = 400
	res := make([]playResult, len(v.Legal))
	for i, c := range v.Legal {
		res[i] = playResult{card: c, n: n, total: int64(math.Round(means[c.String()] * n))}
	}
	for i := range res {
		for j := range res {
			if i == j {
				continue
			}
			d := float64(res[i].total-res[j].total) / n
			res[i].diffSq[j] = int64(math.Round(n * (se*se*(n-1) + d*d)))
		}
	}
	return res
}

// TestTeachPick: a hint whose card has no reason moves, within the
// teaching tolerance, to a card with one; never to a false kleintje boer.
func TestTeachPick(t *testing.T) {
	// Partner led ♠V and an opponent trumped: ♠A or ♠8 into a lost trick.
	d := build(t, 1, [4]string{"", "QS", "TC AH KH QH JH TH 9H 8H", "8S AS 7D 8D 9D TD JD QD"}, game.Clubs, game.Amsterdams, "QS TC")
	v := turnView(d)
	v.Legal = legalCards(v)
	tab := tableFromView(&v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	pref := m.choose()
	cases := []struct {
		name     string
		gap, se  float64
		want     string
		wantText string
	}{
		{"noise: the low card", 3, 0.5, "8S", "Je kunt de slag niet winnen: speel je laagste schoppen (♠8) en bewaar je punten."},
		{"within two standard errors", 9, 6, "8S", "Je kunt de slag niet winnen: speel je laagste schoppen (♠8) en bewaar je punten."},
		{"a clear gain stays, with its size", 9, 1, "AS",
			"Speel ♠A: je kunt de slag niet winnen, maar volgens de berekening levert ♠A gemiddeld 9 punten meer op dan ♠8."},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := fakeResults(&v, map[string]float64{"AS": 20 + c.gap, "8S": 20}, c.se)
			got, text := teachPick(&v, &tab, &m, res, pref)
			if got != card(c.want) || text != c.wantText {
				t.Errorf("got %v %q\nwant %v %q", got, text, c.want, c.wantText)
			}
		})
	}

	// The maker's first lead without the trump boer: ♣7 and ♠8 would read
	// as kleintje boer. ♠H has no reason, but the hint must not move to ♣7.
	d = build(t, 0, [4]string{"7C KS QS 8S 9D 8D AH TH", "", "", ""}, game.Diamonds, game.Amsterdams, "")
	v = turnView(d)
	v.Legal = legalCards(v)
	tab = tableFromView(&v)
	m = newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	pref = m.choose()
	if pref != card("AH") || !m.fakeSignal(card("7C")) || cheapest(v.Legal, v.Trump) != card("7C") {
		t.Fatalf("setup: pref %v, ♣7 fake %v, cheapest %v", pref, m.fakeSignal(card("7C")), cheapest(v.Legal, v.Trump))
	}
	res := fakeResults(&v, map[string]float64{"KS": 30, "7C": 28, "AH": 22}, 0.5)
	got, text := teachPick(&v, &tab, &m, res, pref)
	if got != card("KS") || text != "Speel ♠H: volgens de berekening levert ♠H gemiddeld 2 punten meer op dan ♣7." {
		t.Errorf("got %v %q, want ♠H with the search's estimate", got, text)
	}
}

// TestPartnerAce: a lead into the partner's (probable) ace says so.
func TestPartnerAce(t *testing.T) {
	// Seat 0 defends (seat 1 made trump), holds ♦9 ♦8 and leads ♦9.
	tab := newTable(0, game.Clubs, 1, game.Amsterdams)
	hand := setOf(game.MustParseCards("9D 8D 7H 8H 9H 7S 8S 9S"))
	tab.excl[1] |= bit(card("AD"))
	tab.excl[3] |= bit(card("AD"))
	e := explainer{mover: newMover(&tab, 0, hand, hand, 0.5)}
	want := "Speel ♦9: ♦A zit bij je maat, dus zo speel je ruiten naar je maat toe."
	if got := leadText(&e, card("9D")); got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	// Seat 3 only signalled that it lacks the ace (as by a small lead in
	// diamonds, see signalHints).
	tab.excl[3] = 0
	e = explainer{mover: newMover(&tab, 0, hand, hand, 0.5), lacks: &[4]cardSet{3: bit(card("AD"))}}
	want = "Speel ♦9: ♦A zit waarschijnlijk bij je maat, dus zo speel je ruiten naar je maat toe."
	if got := leadText(&e, card("9D")); got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	// Without that signal nothing is known.
	e = explainer{mover: newMover(&tab, 0, hand, hand, 0.5), lacks: &[4]cardSet{}}
	if got := leadText(&e, card("9D")); strings.Contains(got, "maat") {
		t.Errorf("no evidence, yet %q", got)
	}
}

// TestConcreteReason: a card that no rule explains gets a fact that speaks
// for it against the cheapest other card, when one holds.
func TestConcreteReason(t *testing.T) {
	cases := []struct {
		name, hand, played, c, y, want string
	}{
		{"the last trick", "7S 9H", "JH", "7S", "9H",
			"zo houd je ♥9 over voor de laatste slag, die je daarmee zeker pakt (10 punten extra)"},
		{"the highest card of a side suit", "7D 9S", "AS TS KS QS JS", "7D", "9S",
			"zo houd je de hoogste schoppen (♠9) achter de hand"},
		{"the guard of a ten", "QS 7D TD", "", "QS", "7D",
			"zo houd je ♦7 bij je ♦10, anders staat die kaal"},
		{"nothing", "QS 7D 8C", "", "QS", "7D", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tab := newTable(0, game.Hearts, 0, game.Amsterdams)
			tab.played = setOf(game.MustParseCards(c.played))
			hand := setOf(game.MustParseCards(c.hand))
			e := explainer{mover: newMover(&tab, 0, hand, hand, 0.5)}
			if y, _ := e.cheapestOther(card(c.c)); y != card(c.y) {
				t.Fatalf("cheapest other card %v, want %v", y, c.y)
			}
			if got := e.concreteReason(card(c.c), card(c.y)); got != c.want {
				t.Errorf("got  %q\nwant %q", got, c.want)
			}
			// Without the search: the fact, linked with "en" after a
			// contrast, or else the plain clause.
			want := "plain"
			if c.want != "" {
				want = "en " + c.want
			}
			if got := e.noReason(card(c.c), "plain", "maar "); got != want || !e.generic {
				t.Errorf("noReason %q (generic %v), want %q", got, e.generic, want)
			}
		})
	}
}

// TestAddedRoemNames: the names add up to the roem a card adds, also when
// it turns roem already in the trick into more.
func TestAddedRoemNames(t *testing.T) {
	cases := []struct{ before, c, want string }{
		{"8H 9H", "TH", "driekaart"},
		{"QS 8D", "KS", "stuk"},
		{"TS JS QS", "KS", "vierkaart en stuk in plaats van driekaart"},
		{"TH JH QH", "9H", "vierkaart in plaats van driekaart"},
	}
	for _, c := range cases {
		if got := addedRoemNames(game.MustParseCards(c.before), card(c.c), game.Spades); got != c.want {
			t.Errorf("%s + %s: got %q, want %q", c.before, c.c, got, c.want)
		}
	}
}
