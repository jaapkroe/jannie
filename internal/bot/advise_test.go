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

// withParts sets the parts of the value of card c in res, per world.
func withParts(res []playResult, c string, parts map[int]float64) {
	for i := range res {
		if res[i].card == card(c) {
			for k, x := range parts {
				res[i].parts[k] = int64(math.Round(x * float64(res[i].n)))
			}
		}
	}
}

// TestTeachPick: the hint is the rule-based card with the reason of its
// rule, unless the search rates another card higher by teachTolerance and
// two standard errors: then that card, with where it gains. Never a false
// kleintje boer.
func TestTeachPick(t *testing.T) {
	// Partner led ♠V and an opponent trumped: ♠A or ♠8 into a lost trick.
	d := build(t, 1, [4]string{"", "QS", "TC AH KH QH JH TH 9H 8H", "8S AS 7D 8D 9D TD JD QD"}, game.Clubs, game.Amsterdams, "QS TC")
	v := turnView(d)
	v.Legal = legalCards(v)
	tab := tableFromView(&v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	pref, r := m.decide()
	duck := "Speel ♠8: je kunt de slag niet winnen, dus geef zo weinig mogelijk weg. ♠8 is niets waard."
	cases := []struct {
		name     string
		gap, se  float64
		want     string
		wantText string
	}{
		{"noise: the rule's card", 3, 0.5, "8S", duck},
		{"within two standard errors", 9, 6, "8S", duck},
		{"a clear gain: the search's card, and where it gains", 9, 1, "AS",
			"Speel ♠A: volgens de berekening levert dat gemiddeld 9 punten meer op dan ♠8, vooral in de punten van de latere slagen."},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := fakeResults(&v, map[string]float64{"AS": 20 + c.gap, "8S": 20}, c.se)
			withParts(res, "AS", map[int]float64{partPointsLater: c.gap})
			got, text := teachPick(&m, res, pref, r)
			if got != card(c.want) || text != c.wantText {
				t.Errorf("got %v %q\nwant %v %q", got, text, c.want, c.wantText)
			}
		})
	}

	// The maker's first lead without the trump boer: ♣7 would read as
	// kleintje boer. The search rates it best, but the hint does not lie.
	d = build(t, 0, [4]string{"7C KS QS 8S 9D 8D AH TH", "", "", ""}, game.Diamonds, game.Amsterdams, "")
	v = turnView(d)
	v.Legal = legalCards(v)
	tab = tableFromView(&v)
	m = newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	pref, r = m.decide()
	if pref != card("TH") || !m.fakeSignal(card("7C")) {
		t.Fatalf("setup: pref %v, ♣7 fake %v", pref, m.fakeSignal(card("7C")))
	}
	res := fakeResults(&v, map[string]float64{"7C": 36, "KS": 30, "TH": 22}, 0.5)
	withParts(res, "KS", map[int]float64{partPointsNow: 8})
	got, text := teachPick(&m, res, pref, r)
	if want := "Speel ♠H: volgens de berekening levert dat gemiddeld 8 punten meer op dan ♥10, vooral in de punten van deze slag."; got != card("KS") || text != want {
		t.Errorf("got %v %q\nwant ♠H %q", got, text, want)
	}
}

// TestSearchWhy: a card the search prefers gets how much more it brings
// than the rule-based card, and the part of the value where mainly; two
// parts when the largest is under 60% of the gap.
func TestSearchWhy(t *testing.T) {
	d := build(t, 0, [4]string{"AS TS 8S 7D 9D 7C 8C 9C", "", "", ""}, game.Hearts, game.Amsterdams, "")
	v := turnView(d)
	v.Legal = legalCards(v)
	tab := tableFromView(&v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	head := "volgens de berekening levert dat gemiddeld 10 punten meer op dan ♠10, vooral "
	for _, c := range []struct {
		name       string
		parts      map[int]float64
		natA, natT int // percent nat with ♠A and with ♠10
		want       string
	}{
		{"roem in this trick", map[int]float64{partRoemNow: 12, partPointsNow: -2}, 0, 0, "in de roem van deze slag."},
		{"two parts", map[int]float64{partPointsLater: 5, partRoemLater: 5}, 0, 0,
			"in de punten van de latere slagen en in de roem van de latere slagen."},
		{"nat", map[int]float64{partNatPit: 10}, 10, 30, "doordat jullie minder vaak nat gaan (10% tegen 30%)."},
		{"pit", map[int]float64{partNatPit: 10}, 0, 0, "door de kans op pit."},
	} {
		res := fakeResults(&v, map[string]float64{"AS": 40, "TS": 30}, 1)
		withParts(res, "AS", c.parts)
		i, j := resultIndex(res, card("AS")), resultIndex(res, card("TS"))
		res[i].out.natUs = c.natA * res[i].n / 100
		res[j].out.natUs = c.natT * res[j].n / 100
		if got := m.searchWhy(res, i, j); got != head+c.want {
			t.Errorf("%s: got %q\nwant %q", c.name, got, head+c.want)
		}
	}
}

// TestEquivalentPick: between cards that win and lose alike, the hint and
// sterk keep the rule-based card unless the search tells them apart: with
// ♠A and ♠10 the 10 goes first.
func TestEquivalentPick(t *testing.T) {
	d := build(t, 0, [4]string{"AS TS 8S 7D 9D 7C 8C 9C", "", "", ""}, game.Hearts, game.Amsterdams, "")
	v := turnView(d)
	v.Legal = legalCards(v)
	tab := tableFromView(&v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	pref := m.choose()
	if pref != card("TS") || !m.equivalent(card("AS"), card("TS")) || m.equivalent(card("TS"), card("8S")) {
		t.Fatalf("setup: pref %v, ♠A ♠10 equivalent %v, ♠10 ♠8 %v", pref, m.equivalent(card("AS"), card("TS")), m.equivalent(card("TS"), card("8S")))
	}
	for _, c := range []struct {
		name    string
		ace, se float64
		want    string
	}{
		{"within the tolerance", 34, 1, "TS"},
		{"within two standard errors", 38, 5, "TS"},
		{"a clear gain", 38, 1, "AS"},
	} {
		res := fakeResults(&v, map[string]float64{"AS": c.ace, "TS": 30}, c.se)
		if got, _ := teachPick(&m, res, pref, ruleCash); got != card(c.want) {
			t.Errorf("%s: hint %v, want %v", c.name, got, c.want)
		}
		if got := res[sterkPick(&m, res, pref)].card; got != card(c.want) {
			t.Errorf("%s: sterk %v, want %v", c.name, got, c.want)
		}
	}
}

// TestSterkReason: when sterk's card is not the one the search values most,
// the expert's reasoning says why: a false signal it does not give for so
// little, or the rule-based card kept as close enough; and the hint that
// keeps the rule-based card says why too.
func TestSterkReason(t *testing.T) {
	// Partner's ♦A has the trick; the mover cannot follow. ♣7 would say
	// "I have the highest club" (opseinen), without the ace and the 10.
	d := build(t, 1, [4]string{"KS QS 7C 8C 9C JC 8H 7H", "7D", "AD", "8D"}, game.Hearts, game.Amsterdams, "7D AD 8D")
	v := turnView(d)
	v.Legal = legalCards(v)
	tab := tableFromView(&v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	if !m.falseLow(card("7C")) || m.lieGain(card("KS")) != 0 {
		t.Fatalf("setup: ♣7 false low %v, ♠H lie gain %v", m.falseLow(card("7C")), m.lieGain(card("KS")))
	}
	res := fakeResults(&v, map[string]float64{"7C": 40, "KS": 30}, 1)
	i, why := sterkChoose(&m, res, card("KS"))
	if res[i].card != card("KS") {
		t.Fatalf("sterk %v, want ♠H", res[i].card)
	}
	want := "♣7 is volgens de berekening 10,0 punten beter dan ♠H, maar je maat zou ♣7 lezen als “speel klaveren, daar heb ik de hoogste van” (opseinen), " +
		"en die heb je niet. Een vals sein speelt Sterk pas als het minstens 20 punten meer oplevert."
	if got := m.sterkReason(res, i, why); got != want {
		t.Errorf("false signal:\n got %q\nwant %q", got, want)
	}
	res = fakeResults(&v, map[string]float64{"7C": 55, "KS": 30}, 1)
	if i, why := sterkChoose(&m, res, card("KS")); res[i].card != card("7C") || m.sterkReason(res, i, why) != "" {
		t.Errorf("a clear gain: sterk %v, reason %q", res[i].card, m.sterkReason(res, i, why))
	}
	// Just short of the gain: the difference is rounded down.
	res = fakeResults(&v, map[string]float64{"7C": 49.96, "KS": 30}, 1)
	if i, why := sterkChoose(&m, res, card("KS")); !strings.HasPrefix(m.sterkReason(res, i, why), "♣7 is volgens de berekening 19,9 punten beter") {
		t.Errorf("just short: %q", m.sterkReason(res, i, why))
	}

	// Every side card a false signal: Normaal's ♣7 is valued above the best
	// honest card ♥V (a trump), which took the place of ♣8, so sterk plays ♣7.
	d = build(t, 1, [4]string{"7C 8C JH 9H AH TH KH QH", "7D", "AD", "8D"}, game.Hearts, game.Amsterdams, "7D AD 8D")
	v = turnView(d)
	v.Legal = legalCards(v)
	tab = tableFromView(&v)
	m = newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	if pref := m.choose(); pref != card("7C") || !m.falseLow(card("8C")) {
		t.Fatalf("setup: Normaal %v, ♣8 false low %v", pref, m.falseLow(card("8C")))
	}
	res = fakeResults(&v, map[string]float64{"8C": 40.5, "7C": 40, "QH": 39}, 1)
	i, why = sterkChoose(&m, res, card("7C"))
	want = "♣8 is volgens de berekening 1,5 punten beter dan ♥V, maar je maat zou ♣8 lezen als “speel klaveren, daar heb ik de hoogste van” (opseinen), " +
		"en die heb je niet. Een vals sein speelt Sterk pas als het minstens 20 punten meer oplevert. ♣7, de kaart van Normaal, zet de berekening hoger dan ♥V: die speelt Sterk."
	if got := m.sterkReason(res, i, why); res[i].card != card("7C") || got != want {
		t.Errorf("Normaal above the honest card: sterk %v\n got %q\nwant %q", res[i].card, got, want)
	}

	// ♠A and ♠10 win and lose alike: sterk keeps the rule's ♠10 within the
	// hints' tolerance.
	d = build(t, 0, [4]string{"AS TS 8S 7D 9D 7C 8C 9C", "", "", ""}, game.Hearts, game.Amsterdams, "")
	v = turnView(d)
	v.Legal = legalCards(v)
	tab = tableFromView(&v)
	m = newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	res = fakeResults(&v, map[string]float64{"AS": 34, "TS": 30}, 1)
	i, why = sterkChoose(&m, res, card("TS"))
	want = "♠10 en ♠A winnen en verliezen even vaak, en ♠A is volgens de berekening 4,0 punten beter, minder dan 5 punten: dan speelt Sterk de kaart van Normaal."
	if got := m.sterkReason(res, i, why); res[i].card != card("TS") || got != want {
		t.Errorf("alike: sterk %v\n got %q\nwant %q", res[i].card, got, want)
	}
	res = fakeResults(&v, map[string]float64{"AS": 30.5, "8S": 30}, 1)
	i, why = sterkChoose(&m, res, card("8S"))
	want = "♠A is volgens de berekening minder dan 1 punt beter: dan speelt Sterk de kaart van Normaal."
	if got := m.sterkReason(res, i, why); res[i].card != card("8S") || got != want {
		t.Errorf("noise: sterk %v\n got %q\nwant %q", res[i].card, got, want)
	}

	// Sterk plays ♠A, 3 points over the rule's ♠8: the hint keeps ♠8.
	res = fakeResults(&v, map[string]float64{"AS": 33, "8S": 30}, 1)
	si, j := sterkPick(&m, res, card("8S")), resultIndex(res, card("8S"))
	if hint, _ := teachPick(&m, res, card("8S"), ruleCash); res[si].card != card("AS") || hint != card("8S") {
		t.Fatalf("sterk %v, hint %v", res[si].card, hint)
	}
	want = "Sterk is volgens de berekening 3,0 punten beter dan de kaart van Normaal, minder dan 5 punten: dan blijft de tip bij die kaart."
	if got := hintKeptReason(res, si, j); got != want {
		t.Errorf("hint kept:\n got %q\nwant %q", got, want)
	}
	res = fakeResults(&v, map[string]float64{"AS": 40, "8S": 30}, 8)
	if got := hintKeptReason(res, resultIndex(res, card("AS")), resultIndex(res, card("8S"))); !strings.Contains(got, "minder dan twee keer de standaardfout van dat verschil (16,0 punten)") {
		t.Errorf("hint kept within two standard errors: %q", got)
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
