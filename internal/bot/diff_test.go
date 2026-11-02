package bot

import (
	"testing"

	"klaverjas/internal/game"
)

// events returns n playouts: the first k with ev, the rest with rest.
func events(n, k int, ev, rest playEvent) []playEvent {
	out := make([]playEvent, n)
	for i := range out {
		out[i] = rest
		if i < k {
			out[i] = ev
		}
	}
	return out
}

// TestDiffWhy: the difference named is the one that brings the most, in
// the terms of a player's cards, the last trick or the roem in this trick;
// only when it is at least diffMin and a quarter of the gap, and with
// sampled deals clear of their noise.
func TestDiffWhy(t *testing.T) {
	tc, nc, as := card("TC"), card("9C"), card("AS")
	hand := bit(tc) | bit(nc) | bit(as)
	none := playEvent{}
	cases := []struct {
		name   string
		a, b   game.Card
		gap    float64
		ea, eb []playEvent
		w      []float64
		want   string
	}{
		{"the card kept is lost later", tc, nc, 10,
			events(100, 50, playEvent{ours: bit(tc)}, none), events(100, 0, none, none), nil,
			"Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je ♣9 speelt, en in 50% als je ♣10 speelt."},
		{"another card of the player", nc, tc, 5,
			events(100, 80, playEvent{ours: bit(as)}, none), events(100, 20, playEvent{ours: bit(as)}, none), nil,
			"Je ♠A gaat in 80% van de verdelingen naar de tegenstanders als je ♣10 speelt, en in 20% als je ♣9 speelt."},
		{"the last trick", tc, nc, 8,
			events(100, 60, playEvent{last: true}, none), events(100, 20, playEvent{last: true}, none), nil,
			"Jullie halen de laatste slag in 60% van de verdelingen als je ♣10 speelt, en in 20% als je ♣9 speelt."},
		{"their roem", as, tc, 8,
			events(100, 5, playEvent{roem: -20}, none), events(100, 30, playEvent{roem: -20}, none), nil,
			"De tegenstanders maken roem in deze slag in 30% van de verdelingen als je ♣10 speelt, en in 5% als je ♠A speelt."},
		{"our roem", as, tc, 8,
			events(100, 25, playEvent{roem: 20}, none), events(100, 5, playEvent{roem: 20}, none), nil,
			"Jullie maken roem in deze slag in 25% van de verdelingen als je ♠A speelt, en in 5% als je ♣10 speelt."},
		{"the largest of two", tc, nc, 10,
			events(100, 50, playEvent{ours: bit(tc), last: true}, none), events(100, 40, playEvent{last: true}, none), nil,
			"Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je ♣9 speelt, en in 50% als je ♣10 speelt."},
		{"under diffMin", tc, nc, 1,
			events(100, 5, playEvent{last: true}, none), events(100, 0, none, none), nil, ""},
		{"under a quarter of the gap", tc, nc, 50,
			events(100, 50, playEvent{last: true}, none), events(100, 0, none, none), nil, ""},
		{"noise in a few deals", tc, nc, 10,
			events(4, 1, playEvent{last: true}, none), events(4, 0, none, none), nil, ""},
		{"every possible deal, weighted: no noise", tc, nc, 10,
			events(4, 1, playEvent{last: true}, none), events(4, 0, none, none), []float64{3, 1, 1, 1},
			"Jullie halen de laatste slag in 50% van de verdelingen als je ♣10 speelt, en in 0% als je ♣9 speelt."},
	}
	for _, c := range cases {
		if got := diffWhy(c.a, c.b, c.gap, c.ea, c.eb, c.w, hand, game.Diamonds); got != c.want {
			t.Errorf("%s: got %q\nwant %q", c.name, got, c.want)
		}
	}
}

// TestDiffWhyGame: two decisions of an expert's game (2 November 2026, seed
// 255714528), rebuilt as dealt, where the comment asked what the numbers
// meant. In hand 1 the last trick is the opponents' (the last trump is
// theirs), so ♣10 is lost when kept; in hand 10 ♥10 led into the boer
// gives 10-boer-vrouw roem.
func TestDiffWhyGame(t *testing.T) {
	deal := func(dealer game.Seat, turned game.Suit, hands [4]string, trump game.Suit, plays string) game.View {
		t.Helper()
		var cards [4][]game.Card
		for s, h := range hands {
			cards[s] = game.MustParseCards(h)
		}
		d := game.NewDealFor(4, dealer, cards, nil, game.Utrechts, game.Amsterdams, turned)
		if err := d.ChooseTrump(d.Voorhand(), trump); err != nil {
			t.Fatal(err)
		}
		for _, c := range game.MustParseCards(plays) {
			if err := d.Play(d.Turn(), c); err != nil {
				t.Fatal(err)
			}
		}
		return turnView(d)
	}
	v := deal(2, game.Diamonds, [4]string{"8D AH 9H 7D 9C QS TC TD", "QD AC 7C KS QC 8C TH KH", "9S QH TS KC JS 7S 8H AS", "9D KD AD JH JC JD 8S 7H"},
		game.Diamonds, "JD 8D QD 7S 9D 7D TH 8H AD TD KH 9S 8S QS KS AS QH 7H AH 7C 9H 8C KC JH JC")
	a := Advise(v)
	want := "Speel ♣10: volgens de berekening levert dat gemiddeld 13 punten meer op dan ♣9, vooral in de punten van de latere slagen. " +
		"Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je ♣9 speelt, en in 51% als je ♣10 speelt."
	if a.Card == nil || *a.Card != card("TC") || a.Text != want {
		t.Errorf("hand 1: got %v %q\nwant ♣10 %q", a.Card, a.Text, want)
	}

	v = deal(3, game.Hearts, [4]string{"QD 9H AH KC 9S TC TH 8S", "JD 8H AD KH 7S 8C 7D QS", "QC 7H TS KD 8D TD 9C JS", "AS 7C KS AC 9D JH QH JC"},
		game.Hearts, "")
	e := Explain(v)
	want = "♥A: volgens de berekening levert dat gemiddeld 8 punten meer op dan ♥10, vooral doordat jullie minder vaak nat gaan (42% tegen 45%). " +
		"De tegenstanders maken roem in deze slag in 30% van de verdelingen als je ♥10 speelt, en in 5% als je ♥A speelt."
	for _, o := range e.Options {
		if *o.Card == card("TH") && o.Why != want {
			t.Errorf("hand 10, ♥10: got %q\nwant %q", o.Why, want)
		}
		if *o.Card == card("AH") && o.Why != "" {
			t.Errorf("hand 10, ♥A is the best, but has a reason: %q", o.Why)
		}
	}
}
