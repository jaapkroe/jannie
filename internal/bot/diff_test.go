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
// only when it is at least diffMin and a quarter of what the card brings
// more in points and roem, and with sampled deals clear of their noise.
func TestDiffWhy(t *testing.T) {
	tc, nc, as := card("TC"), card("9C"), card("AS")
	hand := bit(tc) | bit(nc) | bit(as)
	none := playEvent{}
	cases := []struct {
		name   string
		a, b   game.Card
		ea, eb []playEvent
		w      []float64
		want   string
	}{
		{"the card kept is lost later", tc, nc,
			events(100, 50, playEvent{ours: bit(tc)}, none), events(100, 0, none, none), nil,
			"Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je ♣9 speelt, en in 50% als je ♣10 speelt."},
		{"another card of the player", nc, tc,
			events(100, 80, playEvent{ours: bit(as)}, none), events(100, 20, playEvent{ours: bit(as)}, none), nil,
			"Je ♠A gaat in 80% van de verdelingen naar de tegenstanders als je ♣10 speelt, en in 20% als je ♣9 speelt."},
		{"the last trick", tc, nc,
			events(100, 60, playEvent{last: true}, none), events(100, 20, playEvent{last: true}, none), nil,
			"Jullie halen de laatste slag in 60% van de verdelingen als je ♣10 speelt, en in 20% als je ♣9 speelt."},
		{"their roem", as, tc,
			events(100, 5, playEvent{roem: -20}, none), events(100, 30, playEvent{roem: -20}, none), nil,
			"De tegenstanders maken roem in deze slag in 30% van de verdelingen als je ♣10 speelt, en in 5% als je ♠A speelt."},
		{"our roem", as, tc,
			events(100, 25, playEvent{roem: 20}, none), events(100, 5, playEvent{roem: 20}, none), nil,
			"Jullie maken roem in deze slag in 25% van de verdelingen als je ♠A speelt, en in 5% als je ♣10 speelt."},
		{"the largest of two", tc, nc,
			events(100, 50, playEvent{ours: bit(tc), last: true}, none), events(100, 40, playEvent{last: true}, none), nil,
			"Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je ♣9 speelt, en in 50% als je ♣10 speelt."},
		{"under diffMin", tc, nc,
			events(100, 5, playEvent{last: true}, none), events(100, 0, none, none), nil, ""},
		{"under a quarter of the points and roem", tc, nc,
			events(100, 50, playEvent{last: true, raw: 200}, none), events(100, 0, none, none), nil, ""},
		{"a quarter of the points and roem, though nat makes the gap larger", tc, nc,
			events(100, 50, playEvent{last: true, raw: 40}, none), events(100, 0, none, none), nil,
			"Jullie halen de laatste slag in 50% van de verdelingen als je ♣10 speelt, en in 0% als je ♣9 speelt."},
		{"their roem, more of it but not more often", as, tc,
			events(100, 30, playEvent{roem: -20}, none), events(100, 30, playEvent{roem: -100}, none), nil, ""},
		{"the card that gains, while the other loses", tc, as,
			events(100, 50, playEvent{ours: bit(tc)}, playEvent{ours: bit(tc) | bit(as)}), events(100, 0, none, playEvent{ours: bit(as)}), nil, ""},
		{"one deal", tc, nc,
			events(1, 1, playEvent{last: true}, none), events(1, 0, none, none), nil, ""},
		{"noise in a few deals", tc, nc,
			events(4, 1, playEvent{last: true}, none), events(4, 0, none, none), nil, ""},
		{"every possible deal, weighted: no noise", tc, nc,
			events(4, 1, playEvent{last: true}, none), events(4, 0, none, none), []float64{3, 1, 1, 1},
			"Jullie halen de laatste slag in 50% van de verdelingen als je ♣10 speelt, en in 0% als je ♣9 speelt."},
	}
	for _, c := range cases {
		if got := diffWhy(c.a, c.b, c.ea, c.eb, c.w, hand, game.Diamonds); got != c.want {
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
	v := dealt(t, 2, game.Diamonds, [4]string{"8D AH 9H 7D 9C QS TC TD", "QD AC 7C KS QC 8C TH KH", "9S QH TS KC JS 7S 8H AS", "9D KD AD JH JC JD 8S 7H"},
		game.Diamonds, "JD 8D QD 7S 9D 7D TH 8H AD TD KH 9S 8S QS KS AS QH 7H AH 7C 9H 8C KC JH JC")
	want := "♣10: volgens de berekening levert dat gemiddeld 13 punten meer op dan ♣9, vooral in de punten van de latere slagen. " +
		"Je ♣10 gaat in 100% van de verdelingen naar de tegenstanders als je ♣9 speelt, en in 51% als je ♣10 speelt."
	if got := optionWhy(t, Explain(v), "9C"); got != want {
		t.Errorf("hand 1, ♣9: got %q\nwant %q", got, want)
	}

	v = dealt(t, 3, game.Hearts, [4]string{"QD 9H AH KC 9S TC TH 8S", "JD 8H AD KH 7S 8C 7D QS", "QC 7H TS KD 8D TD 9C JS", "AS 7C KS AC 9D JH QH JC"},
		game.Hearts, "")
	want = "♥A: volgens de berekening levert dat gemiddeld 8 punten meer op dan ♥10, vooral doordat jullie minder vaak nat gaan (42% tegen 45%). " +
		"De tegenstanders maken roem in deze slag in 30% van de verdelingen als je ♥10 speelt, en in 5% als je ♥A speelt."
	e := Explain(v)
	if a := Advise(v); a.Card == nil || *a.Card != card("AH") || a.Text != "Speel "+want {
		t.Errorf("hand 10, the hint: got %v %q\nwant ♥A %q", a.Card, a.Text, "Speel "+want)
	}
	if got := optionWhy(t, e, "TH"); got != want {
		t.Errorf("hand 10, ♥10: got %q\nwant %q", got, want)
	}
	if got := optionWhy(t, e, "AH"); got != "" {
		t.Errorf("hand 10, ♥A is the best, but has a reason: %q", got)
	}
	// The best is clearly better than ♦V, but not by two standard errors:
	// the note on noise is about that, before what differs.
	want = "♥A: volgens de berekening levert dat gemiddeld 5 punten meer op dan ♦V, vooral doordat jullie minder vaak nat gaan (42% tegen 44%). " +
		"Dat verschil is kleiner dan twee keer de standaardfout en kan toeval zijn. " +
		"Je ♥10 gaat in 38% van de verdelingen naar de tegenstanders als je ♦V speelt, en in 0% als je ♥A speelt."
	if got := optionWhy(t, e, "QD"); got != want {
		t.Errorf("hand 10, ♦V: got %q\nwant %q", got, want)
	}
}

// optionWhy is the reason of card c's row in explanation e.
func optionWhy(t *testing.T, e Explanation, c string) string {
	t.Helper()
	for _, o := range e.Options {
		if o.Card != nil && *o.Card == card(c) {
			return o.Why
		}
	}
	t.Fatalf("no option %s in %+v", c, e.Options)
	return ""
}

// dealt is the view of the player on turn in a deal of four as dealt by
// dealer with turned suit turned (Utrechts, Amsterdams), voorhand choosing
// trump, after plays.
func dealt(t *testing.T, dealer game.Seat, turned game.Suit, hands [4]string, trump game.Suit, plays string) game.View {
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
