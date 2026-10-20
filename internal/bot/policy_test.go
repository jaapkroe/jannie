package bot

import (
	"math/rand/v2"
	"strings"
	"testing"

	"klaverjas/internal/game"
)

// build deals the given cards (space-separated codes per seat), fills every
// hand to 8 cards with the remaining cards in deck order, lets voorhand
// choose trump (utrechts) and plays the given cards in turn.
func build(t *testing.T, voorhand game.Seat, spec [4]string, trump game.Suit, rules game.Rules, plays string) *game.Deal {
	t.Helper()
	var hands [4][]game.Card
	used := cardSet(0)
	for s, codes := range spec {
		hands[s] = game.MustParseCards(codes)
		for _, c := range hands[s] {
			if used.has(c) {
				t.Fatalf("card %v dealt twice", c)
			}
			used |= bit(c)
		}
	}
	rest := (allCards &^ used).appendCards(nil)
	for s := range hands {
		for len(hands[s]) < 8 {
			hands[s] = append(hands[s], rest[0])
			rest = rest[1:]
		}
	}
	d := game.NewDeal((voorhand+3)&3, hands, game.Utrechts, rules, 0)
	if err := d.ChooseTrump(voorhand, trump); err != nil {
		t.Fatal(err)
	}
	for _, c := range game.MustParseCards(plays) {
		if err := d.Play(d.Turn(), c); err != nil {
			t.Fatalf("play %v: %v", c, err)
		}
	}
	return d
}

// turnView returns the view of the seat on turn.
func turnView(d *game.Deal) game.View { return d.View(d.Turn()) }

func TestNormaalScenarios(t *testing.T) {
	cases := []struct {
		name     string
		voorhand game.Seat
		spec     [4]string
		trump    game.Suit
		plays    string
		want     string
	}{
		{
			name: "maker pulls trump with the boer", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"JH 9H 8H AS AD 7C 8C 9C", "", "", ""},
			want: "JH",
		},
		{
			name: "smear the 10 on partner's ace", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AS JH 9H 7C 8C 9C 7D 8D", "7S 8S", "TS QS 9S", "JS"},
			plays: "AS 7S",
			want:  "TS",
		},
		{
			name: "keep a side ace, smear the 10", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AS KS JH 9H 7C 8C 9C 8D", "7S 8S", "AD TC JC QD 7D 9D KD QC", "9S TS"},
			plays: "AS 7S",
			want:  "TC",
		},
		{
			name: "make stuk on partner's boer", voorhand: 0, trump: game.Clubs,
			spec:  [4]string{"JC 9C AS AD AH 7S 7D 7H", "KC 8S 8D 8H", "QC 7C 9S 9D", ""},
			plays: "JC KC",
			want:  "QC",
		},
		{
			name: "win as cheaply as possible when last", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"KD JH 9H 7C 8C 9C 7S 8S", "7D JD QD 9D KC AC 9S TS",
				"8D AH TH KH QH 8H 7H JS", "AD TD QS KS AS TC JC QC"},
			plays: "KD 7D 8D",
			want:  "TD",
		},
		{
			name: "do not give roem to the opponents", voorhand: 0, trump: game.Spades,
			spec: [4]string{"9D JS 9S AS AH TH KH QH", "7C 8C 9C TC JC QC KC AC",
				"TD AD KD QD 7H 8H 9H JH", "8D JD 7D TS KS QS 8S 7S"},
			plays: "9D 7C TD",
			want:  "7D",
		},
		{
			name: "discard low when void without trump", voorhand: 3, trump: game.Spades,
			spec: [4]string{"7D 9D TD JD 7S 8H 9H TH", "8D QD KD 7H AH 9C JC QC",
				"AC TC 7C 8C KH QH JH KC", "AD JS 9S AS TS KS QS 8S"},
			plays: "AD 7D 8D",
			want:  "7C",
		},
		{
			// The boer is the only trump nobody can overtrump, but a cheap
			// trick is not worth it: the 8 wins it now.
			name: "ruff a cheap trick low and keep the boer", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7S", "JH 8H AC TC KC QC AD KD", "", ""},
			plays: "7S",
			want:  "8H",
		},
		{
			name: "maker with a bare boer leads kleintje boer", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"JH KH 7C 8C AS KS AD QD", "", "", ""},
			want: "7C",
		},
		{
			name: "partner returns trump after the maker's kleintje boer", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"JH KH 7C 8C AS KS AD QD", "9C", "AC 7H 8H", "TC"},
			plays: "7C 9C AC TC",
			want:  "7H",
		},
		{
			name: "maker without the boer does not lead a small card", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"9H 8H 7C 8C KS QS KD QD", "", "", ""},
			want: "QD",
		},
		{
			name: "only small side cards: lead trump, not a false kleintje boer", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"9H 8H 7C 8C 7S 8S 7D 9D", "", "", ""},
			want: "8H",
		},
		{
			name: "aas voorspelen: lead the ace with its 10, keep the bare ace", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"AD 7D AS TS 8S 7C 8C 9C", "", "", ""},
			want: "AS",
		},
		{
			name: "a bare ace waits, and no lead under it", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"AS AD 7D 9S KC QC 7C 8C", "KS", "7S", "8S"},
			plays: "KS 7S 8S AS",
			want:  "7C",
		},
		{
			name: "come back to the suit of partner's aas voorspelen", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AS TS 7D JH 9H 8H 7H KH", "7S 8D", "8S AD QS 7C 8C 9C KD QD", "9S 9D"},
			plays: "AS 7S 8S 9S 7D 8D AD 9D",
			want:  "QS",
		},
		{
			name: "laag bijspelen: discard low where you hold the highest card", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"},
			plays: "7D",
			want:  "7S",
		},
		{
			name: "play to partner's laag bijspelen", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"},
			plays: "7D 7S 8D AD",
			want:  "JS",
		},
		{
			name: "no highest card anywhere: discard a boer, not a false laag bijspelen", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"AD", "7C 8C QC KS 7S 8S 9S JS", "7D", "8D"},
			plays: "7D 8D AD",
			want:  "JS",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := build(t, c.voorhand, c.spec, c.trump, game.Amsterdams, c.plays)
			v := turnView(d)
			got := normalChoice(&v, 0.5)
			if got != card(c.want) {
				t.Errorf("normaal played %v, want %v (hand %v, legal %v)", got, c.want, v.Hand, v.Legal)
			}
		})
	}
}

// TestSterkScenarios: positions where the best card is clear.
func TestSterkScenarios(t *testing.T) {
	cases := []struct {
		name  string
		spec  [4]string
		trump game.Suit
		plays string
		want  string
	}{
		{
			name: "take an ace-high trick when last", trump: game.Hearts,
			spec: [4]string{"KD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS",
				"8D AH TH KH QH 8H 7H JS", "AD 9D QS KS AS TC JC QC"},
			plays: "KD 7D 8D",
			want:  "AD",
		},
		{
			name: "make stuk on partner's boer", trump: game.Clubs,
			spec:  [4]string{"JC 9C AS AD AH 7S 7D 7H", "KC 8S 8D 8H", "QC 7C 9S 9D", ""},
			plays: "JC KC",
			want:  "QC",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := build(t, 0, c.spec, c.trump, game.Amsterdams, c.plays)
			v := turnView(d)
			if got := New(roster[3], Sterk, 1).Play(v); got != card(c.want) {
				t.Errorf("sterk played %v, want %v", got, c.want)
			}
		})
	}
}

func TestPlayTexts(t *testing.T) {
	cases := []struct {
		name     string
		voorhand game.Seat
		spec     [4]string
		trump    game.Suit
		rules    game.Rules // default amsterdams
		plays    string
		card     string
		want     string
	}{
		{
			name: "pull trump", trump: game.Hearts,
			spec: [4]string{"JH 9H 8H AS AD 7C 8C 9C", "", "", ""},
			card: "JH",
			want: "Trek troef met ♥B: jullie spelen en de boer is de hoogste troef. Haal de troeven van de tegenstanders eruit.",
		},
		{
			name: "aas voorspelen: lead an ace with its 10", trump: game.Hearts,
			spec: [4]string{"JH 9H 8H AS TS 7C 8C 9C", "", "", ""},
			card: "AS",
			want: "Speel ♠A: de aas is de hoogste kaart in schoppen en levert 11 punten op. Je hebt ook ♠10, dus zo weet je maat dat die veilig in schoppen kan terugkomen (aas voorspelen).",
		},
		{
			name: "lead an ace without its 10", trump: game.Hearts,
			spec: [4]string{"JH 9H 8H AS AD 7C 8C 9C", "", "", ""},
			card: "AS",
			want: "Speel ♠A: de aas is de hoogste kaart in schoppen en levert 11 punten op. Let op: je maat kan dit lezen als aas voorspelen (“ik heb ♠10 ook”), maar die heb je niet.",
		},
		{
			name: "lead an ace whose 10 has fallen", trump: game.Hearts,
			spec: [4]string{"7D 7S 7H 8H TH QH KH AH", "8D AD TD KD QD JD AC 8S",
				"TS QS JS 9S TC JC QC KC", "9D AS KS 7C 8C 9C JH 9H"},
			plays: "7D 8D TS 9D",
			card:  "AS",
			want:  "Speel ♠A: de aas is de hoogste kaart in schoppen en levert 11 punten op.",
		},
		{
			name: "smear", trump: game.Hearts,
			spec:  [4]string{"AS JH 9H 7C 8C 9C 7D 8D", "7S 8S", "TS QS 9S", "JS"},
			plays: "AS 7S",
			card:  "TS",
			want:  "Je maat heeft de slag: spek hem met je ♠10, dat is 10 punten extra.",
		},
		{
			name: "discard a worthless card", voorhand: 3, trump: game.Spades,
			spec: [4]string{"7D 9D TD JD 7S 8H 9H TH", "8D QD KD 7H AH 9C JC QC",
				"AC TC 7C 8C KH QH JH KC", "AD JS 9S AS TS KS QS 8S"},
			plays: "AD 7D 8D",
			card:  "7C",
			want:  "Gooi je ♣7 af: die is niets waard en je kunt niet bekennen. Met dit kleine kaartje zeg je ook tegen je maat: “speel klaveren, daar heb ik de hoogste van” (hoog/laag bijspelen).",
		},
		{
			name: "roem for us", trump: game.Clubs,
			spec:  [4]string{"JC 9C AS AD AH 7S 7D 7H", "KC 8S 8D 8H", "QC 7C 9S 9D", ""},
			plays: "JC KC",
			card:  "QC",
			want:  "Je maat heeft de slag: met ♣V komt er 40 roem bij voor jullie (driekaart en stuk).",
		},
		{
			name: "take the trick last", trump: game.Hearts,
			spec: [4]string{"KD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS",
				"8D AH TH KH QH 8H 7H JS", "AD 9D QS KS AS TC JC QC"},
			plays: "KD 7D 8D",
			card:  "AD",
			want:  "Pak de slag met ♦A: je bent de laatste, dus de slag is zeker van jou (15 punten tot nu toe).",
		},
		{
			name: "trump in", trump: game.Hearts,
			spec: [4]string{"AD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS",
				"8D 9D KD AH TH KH QH JS", "7H 8H QS KS AS TC JC QC"},
			plays: "AD 7D 8D",
			card:  "7H",
			want:  "Troef met ♥7: je kunt niet bekennen en zo pak je de slag (11 punten tot nu toe).",
		},
		{
			name: "only one legal card", trump: game.Hearts,
			spec: [4]string{"AD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS",
				"8D 9D KD AH TH KH QH 7H", "JS QS KS AS TC JC QC 8H"},
			plays: "AD 7D 8D",
			card:  "8H",
			want:  "Speel ♥8: je kunt niet bekennen, dus je moet troeven.",
		},
		{
			name: "only one card of the led suit", trump: game.Hearts,
			spec:  [4]string{"AD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS", "8D 7H 8H TH QH KH AH TC"},
			plays: "AD 7D",
			card:  "8D",
			want:  "Speel ♦8: je moet bekennen, en dit is je enige ruiten.",
		},
		{
			name: "the only higher trump on a trump lead", trump: game.Hearts,
			spec:  [4]string{"KH AS AD 7C 8C 9C 7S 8S", "7H TC JC QC KC AC 9S TS", "AH 8H 7D 8D 9D TD JD QD"},
			plays: "KH 7H",
			card:  "AH",
			want:  "Speel ♥A: troef is gevraagd en je moet overtroeven, ook over je maat heen; alleen deze troef is hoger.",
		},
		{
			name: "forced to overtrump partner on a trump lead", trump: game.Hearts,
			spec: [4]string{"7H 8H TH 7C 8C 9C 7D 8D", "7S 8S 9S TS JS QS KS AS",
				"JH 9H AC KC QC AD KD QD", ""},
			plays: "7H 7S",
			card:  "9H",
			want:  "Troef is gevraagd: je moet overtroeven, ook over je maat heen. Speel je laagste, ♥9: daarmee is de slag al zeker voor jullie.",
		},
		{
			name: "forced to overtrump partner, lower trumps in hand", trump: game.Hearts,
			spec: [4]string{"KH AS AD 7C 8C 9C 7S 8S", "7H TC JC QC KC AC 9S TS",
				"JH 9H 8H 7D 8D 9D TD JD", ""},
			plays: "KH 7H",
			card:  "9H",
			want:  "Troef is gevraagd: je moet overtroeven, ook over je maat heen. Speel de laagste troef die mag, ♥9: daarmee is de slag al zeker voor jullie.",
		},
		{
			name: "rotterdams: forced to trump partner's trick", voorhand: 1, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"8H 9H TH JH QH KH AH 7C", "7S", "AS", "8S"},
			plays: "7S AS 8S",
			card:  "8H",
			want:  "Je kunt niet bekennen, en bij Rotterdams moet je dan troeven, ook al heeft je maat de slag. Speel je laagste, ♥8: daarmee is de slag al zeker voor jullie.",
		},
		{
			name: "rotterdams: undertrump an opponent, holding side cards", trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"KS", "7S", "9H JC QC KC AC 9D TD JD", "AH 7H AD 8C 9C TC 7D 8D"},
			plays: "KS 7S 9H",
			card:  "7H",
			want:  "Je kunt niet bekennen en niet overtroeven, maar bij Rotterdams moet je toch troeven: speel je laagste (♥7).",
		},
		{
			name: "rotterdams: undertrump the partner, holding side cards", voorhand: 1, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"AH 7H AD 8C 9C TC 7D 8D", "KS", "9H JC QC KC AC 9D TD JD", "7S"},
			plays: "KS 9H 7S",
			card:  "7H",
			want:  "Je maat heeft de slag, maar bij Rotterdams moet je troeven als je niet kunt bekennen, ook als dat ondertroeven is: speel je laagste troef (♥7).",
		},
		{
			name: "rotterdams: smear the trump ace under the partner", voorhand: 1, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"AH 7H AD 8C 9C TC 7D 8D", "KS", "9H JC QC KC AC 9D TD JD", "7S"},
			plays: "KS 9H 7S",
			card:  "AH",
			want:  "Je maat heeft de slag, maar bij Rotterdams moet je troeven als je niet kunt bekennen, ook als dat ondertroeven is: spek de slag dan met je ♥A, dat is 11 punten extra.",
		},
		{
			name: "rotterdams: the only trump is lower", voorhand: 1, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"7H AD 8C 9C TC 7D 8D QD", "KS", "9H JC QC KC AC 9D TD JD", "7S"},
			plays: "KS 9H 7S",
			card:  "7H",
			want:  "Speel ♥7: je kunt niet bekennen en niet overtroeven, maar bij Rotterdams moet je toch troeven; dit is je enige troef.",
		},
		{
			name: "last: overtake partner's trick for points", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"KC", "8S 7S 9S TS 7D 8D 9D TD", "TC 7C", "JC"},
			plays: "JC KC 8S",
			card:  "TC",
			want:  "Je maat heeft de slag al en jij bent de laatste: met ♣10 komen er 10 punten bij voor jullie.",
		},
		{
			name: "last: overtake partner's trick for the lead", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"9C", "8S 7S 9S TS 7D 8D 9D TD", "JC 7C", "8C"},
			plays: "8C 9C 8S",
			card:  "JC",
			want:  "Je maat heeft de slag al en jij bent de laatste, maar neem hem zelf met ♣B: dan kom jij de volgende slag uit.",
		},
		{
			name: "take over partner's unsafe trick", trump: game.Hearts,
			spec:  [4]string{"KS", "7S", "AS 8S"},
			plays: "KS 7S",
			card:  "AS",
			want:  "Neem de slag over met ♠A: de kaart van je maat is niet veilig, en zo moet de tegenstander achter je hoger komen.",
		},
		{
			name: "discard points ahead of partner", trump: game.Diamonds,
			spec:  [4]string{"QC", "AH 8H 9H 7S 8S 9S TS JS"},
			plays: "QC",
			card:  "AH",
			want:  "Gooi ♥A af: je maat speelt na jou nog en kan de slag pakken, dan zijn deze 11 punten voor jullie.",
		},
		{
			name: "discard points last: not the cheapest", voorhand: 2, trump: game.Diamonds,
			spec:  [4]string{"8C", "AH 8H 9H 7S 8S 9S TS JS", "QC", "7C"},
			plays: "QC 7C 8C",
			card:  "AH",
			want:  "Gooi ♥A af: je kunt niet bekennen, en dit levert hier naar verwachting het meeste op.",
		},
		{
			name: "pull trump below your own boer", trump: game.Clubs,
			spec: [4]string{"JC 9C AH TH KS 7D 8D 7S", "", "", ""},
			card: "9C",
			want: "Trek troef met ♣9: alleen jouw eigen ♣B is hoger, dus niemand kan hier overheen. Haal de troeven van de tegenstanders eruit.",
		},
		{
			name: "defender leads trump to protect an ace", trump: game.Spades,
			spec:  [4]string{"7H", "AH 7S AC TC QC 7D JD 8D", "8H", "9H"},
			plays: "7H AH 8H 9H",
			card:  "7S",
			want:  "Speel troef (♠7): als tegenpartij kom je meestal niet met troef uit, maar hier wel: zo haal je troeven weg bij de spelende partij, zodat ze je ♣A straks niet kunnen aftroeven.",
		},
		{
			name: "maker gives kleintje boer", trump: game.Hearts,
			spec: [4]string{"JH KH 7C 8C AS KS AD QD", "", "", ""},
			card: "7C",
			want: "Speel ♣7: met een kleintje laat je je maat weten dat jij de troefboer hebt (kleintje boer). Neemt je maat de slag, dan speelt die troef terug.",
		},
		{
			name: "pull trump with the only trump", trump: game.Clubs,
			spec: [4]string{"7C AH KH TD JD AS KS QS", "", "", ""},
			card: "7C",
			want: "Trek troef met je enige troef, ♣7: jullie spelen, en zo haal je troeven bij de tegenstanders weg.",
		},
		{
			name: "pull trump with the highest own trump", trump: game.Diamonds,
			spec: [4]string{"AD TD KD 9H TC 7C AS QS", "", "", ""},
			card: "AD",
			want: "Trek troef met ♦A, je hoogste troef: jullie spelen, dus haal de troeven van de tegenstanders eruit. Wie ♦B of ♦9 heeft, moet er nu overheen.",
		},
		{
			name: "pull trump below an own higher trump", trump: game.Hearts,
			spec: [4]string{"8H 9H AS AD 7C 8C 9C KS", "", "", ""},
			card: "8H",
			want: "Trek troef met ♥8: jullie spelen, dus haal de troeven van de tegenstanders eruit en houd je hoge troeven achter de hand.",
		},
		{
			name: "trump in, an opponent behind may overtrump", trump: game.Hearts,
			spec:  [4]string{"AD 7S 8S 9S TS JS QS KS", "7H 8H 7C 8C 9C TC JC QC"},
			plays: "AD",
			card:  "7H",
			want:  "Troef met ♥7: je kunt niet bekennen; zo neem je de slag voorlopig (11 punten tot nu toe), alleen een hogere troef achter je kan er nog overheen.",
		},
		{
			name: "overtrump, an opponent behind may go higher", trump: game.Hearts,
			spec: [4]string{"AD 7S 8S 9S TS JS QS KS", "7H 7C 8C 9C TC JC QC KC",
				"8H 9H AS AC TH KH QH AH"},
			plays: "AD 7H",
			card:  "8H",
			want:  "Overtroef met ♥8: je kunt niet bekennen; zo neem je de slag voorlopig (11 punten tot nu toe), alleen een hogere troef achter je kan er nog overheen.",
		},
		{
			name: "roem that the next player can complete", trump: game.Clubs,
			spec: [4]string{"KD 7C 8C 9C TC JC QC KC", "AD AC AS TS JS QS KS AH",
				"TD JD 7S 8S 9S 7H 8H 9H", "QD 7D 8D 9D TH JH QH KH"},
			plays: "KD AD",
			card:  "TD",
			want:  "Speel ♦10: je kunt de slag niet winnen. Met ♦B zou ♦V na jou de tegenstanders 50 roem kunnen geven (vierkaart), met ♦10 hooguit 20.",
		},
		{
			name: "discard a bare ten", trump: game.Hearts,
			spec:  [4]string{"AD", "7D", "8D", "TS 7C 8C 9C TC JC QC KC"},
			plays: "AD 7D 8D",
			card:  "TS",
			want:  "Gooi ♠10 af: je kunt niet bekennen, en je ♠10 staat kaal terwijl ♠A nog niet gevallen is.",
		},
		{
			name: "discard, keeping the guard of a ten", trump: game.Hearts,
			spec: [4]string{"7D 8D 9D TD JD QD KD AD", "JH 9H AH TH KH QH 7S 8S",
				"7H 8H TC 7C QS AS TS KS"},
			plays: "7D JH",
			card:  "QS",
			want:  "Gooi ♠V af: je kunt niet bekennen; houd ♣7 bij je ♣10, anders staat die kaal.",
		},
		{
			name: "laag bijspelen: a small discard below your highest card", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"},
			plays: "7D",
			card:  "7S",
			want:  "Gooi je ♠7 af: die is niets waard en je kunt niet bekennen. Met dit kleine kaartje zeg je ook tegen je maat: “speel schoppen, daar heb ik de hoogste van” (hoog/laag bijspelen).",
		},
		{
			name: "a small discard without the highest card", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"},
			plays: "7D",
			card:  "7C",
			want:  "Gooi je ♣7 af: die is niets waard en je kunt niet bekennen. Let op: je maat kan dit lezen als “speel klaveren, daar heb ik de hoogste van” (hoog/laag bijspelen), maar die heb je niet.",
		},
		{
			name: "discard a boer: every small card would be a false laag bijspelen", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"AD", "7C 8C QC KS 7S 8S 9S JS", "7D", "8D"},
			plays: "7D 8D AD",
			card:  "JS",
			want:  "Gooi ♠B af: je kunt niet bekennen. Met ♣7 of ♠7 zou je je maat vragen om die kleur te spelen (hoog/laag bijspelen), maar daar heb je de hoogste niet.",
		},
		{
			name: "come back after partner's aas voorspelen", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AS TS 7D JH 9H 8H 7H KH", "7S 8D", "8S AD QS 7C 8C 9C KD QD", "9S 9D"},
			plays: "AS 7S 8S 9S 7D 8D AD 9D",
			card:  "QS",
			want:  "Speel ♠V: je maat kwam uit met ♠A en zei daarmee “ik heb ♠10 ook” (aas voorspelen), dus zo kom je veilig in schoppen terug.",
		},
		{
			name: "play to partner's laag bijspelen", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"},
			plays: "7D 7S 8D AD",
			card:  "JS",
			want:  "Speel ♠B: je maat gooide ♠7 bij en zei daarmee “speel schoppen, daar heb ik de hoogste van” (hoog/laag bijspelen), dus zo speel je schoppen naar je maat toe.",
		},
		{
			name: "discard high: hoog/laag bijspelen", trump: game.Hearts,
			spec: [4]string{"7D 8D 9D TD JD QD KD AD", "JH 9H AH TH KH QH 8S 9S",
				"7H 8H JS 7S 7C 8C 9C QC"},
			plays: "7D JH",
			card:  "JS",
			want:  "Gooi ♠B af: je kunt niet bekennen, en met een hoge bijkaart zeg je dat je weinig schoppen hebt (hoog/laag bijspelen).",
		},
		{
			name: "follow high: the low card would leave it bare", trump: game.Clubs,
			spec:  [4]string{"AS", "KS 8S 7H 8H 9H 7D 8D 9D"},
			plays: "AS",
			card:  "KS",
			want:  "Speel ♠H: je kunt de slag niet winnen, en speel je ♠8, dan staat je ♠H straks kaal terwijl ♠10 nog niet gevallen is.",
		},
		{
			name: "forced over partner: the boss leaves less to beat it", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"AS KS 7C 8C 9C 7D 8D 9D", "", "8S", "7S"},
			plays: "8S 7S",
			card:  "AS",
			want: "Je moet bekennen, en al je schoppen zijn hoger dan de kaart van je maat. Speel ♠A: dat is de hoogste schoppen, " +
				"daar kan alleen een troef nog overheen. Met ♠H kan de tegenstander achter je ook met ♠10 hoger komen.",
		},
		{
			name: "lead a ten to drive out the ace", trump: game.Clubs,
			spec: [4]string{"TD KD 8C 9C 7H 8H 7S 8S", "", "", ""},
			card: "TD",
			want: "Speel ♦10: zo jaag je ♦A eruit, daarna is je ♦H de hoogste.",
		},
		{
			name: "lead the honour of a doubleton", trump: game.Clubs,
			spec: [4]string{"KH 8H 7C 8C 9C 7S 8S 9S", "", "", ""},
			card: "KH",
			want: "Speel ♥H: speel je ♥8, dan staat je ♥H straks kaal terwijl ♥A en ♥10 nog niet gevallen zijn.",
		},
		{
			name: "boer over boer", trump: game.Hearts,
			spec: [4]string{"JD 7D JH 9H AS KS AC KC", "", "", ""},
			card: "JD",
			want: "Speel ♦B: met een boer van een bijkleur zeg je dat jij de troefboer hebt (boer over boer).",
		},
		{
			name: "lead the last card of a side suit", trump: game.Hearts,
			spec: [4]string{"KS JH 9H 7C 8C 9C AD TD", "", "", ""},
			card: "KS",
			want: "Speel ♠H, je laatste schoppen: dan ben je die kleur kwijt en kun je later troeven als hij gevraagd wordt.",
		},
		{
			name: "defender leads the highest trump", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"AD JH 7C 8C 9C 7S 8S 9S", "7D", "8D", "9D"},
			plays: "7D 8D 9D AD",
			card:  "JH",
			want: "Speel ♥B, de hoogste troef: als tegenpartij kom je meestal niet met troef uit, maar met de hoogste troef pak je zelf de slag. " +
				"Zo haal je troeven weg bij de spelende partij, die ze dan niet meer kan gebruiken om jullie azen af te troeven.",
		},
		{
			name: "trump in a trick without points", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"7H 8H 7S 8S 9S TS JS QS", "7C", "7D 8D 9D TD JD QD KD AD", "8C"},
			plays: "7C 7D 8C",
			card:  "7H",
			want:  "Troef met ♥7: je kunt niet bekennen en zo pak je de slag.",
		},
		{
			name: "no rule: bank the points of a trump that could be caught", voorhand: 1, trump: game.Clubs, rules: game.Rotterdams,
			spec:  [4]string{"KC 7C 7S 8S 9S TS QS KS", "JH", "AH", "JS 7D 8D 9D TD QD KD AD"},
			plays: "JH AH JS",
			card:  "KC",
			want: "Je kunt niet bekennen, en bij Rotterdams moet je dan troeven, ook al heeft je maat de slag. " +
				"Speel ♣H: de slag is zeker voor jullie, dus zo zijn de 4 punten van ♣H binnen; later kan een hogere troef hem nog pakken.",
		},
		{
			name: "no rule: the cheapest card gives roem", voorhand: 3, trump: game.Spades, rules: game.Rotterdams,
			spec:  [4]string{"QS", "TS", "9D 9S 8D KS AH AS TH 7C", "JS"},
			plays: "JS QS TS",
			card:  "AS",
			want: "Speel ♠A: je kunt de slag niet winnen, en met ♠H zou je de tegenstanders 50 roem geven (vierkaart en stuk in plaats van driekaart). " +
				"Met ♠9 zou je de tegenstanders 30 roem geven.",
		},
		{
			name: "the cheapest card would give roem", voorhand: 1, trump: game.Spades,
			spec: [4]string{"8S QS AS 9C QH KD 7D 8D", "9S JS 7S 7C 8C TC JC QC",
				"KS KC AC 9D TD JD QD AD", "TS 7H 8H 9H TH JH KH AH"},
			plays: "9S KS TS",
			card:  "AS",
			want:  "Speel ♠A: je kunt de slag niet winnen. Met ♠8 zou je de tegenstanders 20 roem geven.",
		},
		{
			name: "no rule: a lead that keeps the trumps", trump: game.Hearts,
			spec: [4]string{"8S 7H 8H 9H TH QH KH AH", "", "", ""},
			card: "8S",
			want: "Kom uit met ♠8: zo houd je je troeven achter de hand. Let op: je maat kan een kleintje lezen als kleintje boer (“ik heb de troefboer”).",
		},
		{
			name: "a side boer without the trump boer", trump: game.Hearts,
			spec: [4]string{"JD QD 9H 8H AS KS AC KC", "", "", ""},
			card: "JD",
			want: "Kom uit met ♦B, je laagste ruiten: zo kost het weinig, en je hogere kaarten bewaar je voor later. Dit is geen boer over boer: je hebt de troefboer niet.",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := build(t, c.voorhand, c.spec, c.trump, c.rules, c.plays)
			v := turnView(d)
			tab := tableFromView(&v)
			if got := playText(&v, &tab, card(c.card)); got != c.want {
				t.Errorf("got  %q\nwant %q", got, c.want)
			}
		})
	}
}

func TestTrumpAndBidTexts(t *testing.T) {
	hand := [4]string{"JH 9H AH TH 7H AS 7C 8D", "", "", ""}
	// Utrechts: voorhand 0 chooses.
	var hands [4][]game.Card
	full := build(t, 0, hand, game.Hearts, game.Amsterdams, "")
	for s := game.Seat(0); s < 4; s++ {
		hands[s] = full.Hand(s)
	}
	u := game.NewDeal(3, hands, game.Utrechts, game.Amsterdams, 0)
	a := Advise(u.View(0))
	if a.Suit == nil || *a.Suit != game.Hearts {
		t.Fatalf("trump advice %+v, want hearts", a)
	}
	for _, want := range []string{"Kies ♥ als troef: je hebt de boer, de nel en de aas, in totaal vijf harten. Daarnaast heb je een aas. Je haalt het zo naar schatting "} {
		if !strings.Contains(a.Text, want) {
			t.Errorf("trump advice %q lacks %q", a.Text, want)
		}
	}

	g := game.NewDeal(3, hands, game.Gedraaid, game.Amsterdams, game.Hearts)
	a = Advise(g.View(0))
	if a.Play == nil || !*a.Play || !strings.HasPrefix(a.Text, "Spelen: met de boer, de nel en de aas van ♥") {
		t.Errorf("bid advice %+v, want spelen", a)
	}
	g = game.NewDeal(3, hands, game.Gedraaid, game.Amsterdams, game.Clubs)
	a = Advise(g.View(0))
	if a.Play == nil || *a.Play || !strings.HasPrefix(a.Text, "Passen: ") {
		t.Errorf("bid advice %+v, want passen", a)
	}
}

// TestBidAndTrumpWording checks the reasons given for trump and bid advice.
func TestBidAndTrumpWording(t *testing.T) {
	stats := func(mean float64, made float64) optionStats {
		return optionStats{total: int64(mean * 100), n: 100, made: int(made * 100)}
	}
	view := func(hand string, turned game.Suit, seat game.Seat) game.View {
		return game.View{Hand: game.MustParseCards(hand), Turned: turned, Seat: seat, Voorhand: 1}
	}
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"trump: a single honour",
			trumpText(ptr(view("JS AH KH QH AD KD QD AC", game.Hearts, 1)), game.Spades, stats(10, 0.5)),
			"Kies ♠ als troef: je hebt de boer, maar verder geen schoppen. Daarnaast heb je drie azen. Je haalt het zo naar schatting in 5 van de 10 potjes."},
		{"trump: heer and vrouw in hand are no stuk",
			trumpText(ptr(view("AH KH QH 7H 7S 8S 7D 8D", game.Clubs, 1)), game.Hearts, stats(10, 0.6)),
			"Kies ♥ als troef: je hebt de aas, in totaal vier harten. Je haalt het zo naar schatting in 6 van de 10 potjes."},
		{"pass: likely to make it, but passing scores more",
			bidText(ptr(view("JC QC AH TH 7H QS AD TD", game.Clubs, 2)), false, stats(26, 0.78)),
			"Passen: je hebt wel de boer van ♣, maar met maar twee klaveren is dat te weinig. Als je speelt, haal je het naar schatting in 8 van de 10 potjes, " +
				"maar passen levert gemiddeld meer op: gaat het mis, dan krijgen de tegenstanders 162 punten en alle roem, en met je azen verdedig je sterk."},
		{"pass as voorhand",
			bidText(ptr(view("JC QC AH TH 7H QS AD TD", game.Clubs, 1)), false, stats(26, 0.78)),
			"Passen: je hebt wel de boer van ♣, maar met maar twee klaveren is dat te weinig. Als je speelt, haal je het naar schatting in 8 van de 10 potjes, " +
				"maar passen levert gemiddeld meer op: passen de anderen ook, dan kies jij een andere kleur als troef."},
		{"pass: nat is too likely",
			bidText(ptr(view("7C 8C AH TH 7H QS 9D TD", game.Clubs, 2)), false, stats(-40, 0.4)),
			"Passen: je hebt geen boer, nel of aas van ♣ en maar twee klaveren. Als je speelt, haal je het naar schatting in 4 van de 10 potjes; de kans op nat is te groot."},
		{"pass: none of the suit",
			bidText(ptr(view("7S 8S AH TH 7H QS 9D TD", game.Clubs, 2)), false, stats(-80, 0.1)),
			"Passen: je hebt geen klaveren. Als je speelt, haal je het naar schatting in 1 van de 10 potjes; de kans op nat is te groot."},
		{"pass: one card of the suit",
			bidText(ptr(view("7C 8S AH TH 7H QS 9D TD", game.Clubs, 2)), false, stats(-80, 0.1)),
			"Passen: je hebt geen boer, nel of aas van ♣ en maar één kaart in klaveren. Als je speelt, haal je het naar schatting in 1 van de 10 potjes; de kans op nat is te groot."},
		{"play on a bare boer",
			bidText(ptr(view("JC AS AH TH 7H QS AD TD", game.Clubs, 2)), true, stats(30, 0.7)),
			"Spelen: met de boer van ♣ (je enige troef) is je hand sterk genoeg. Daarnaast heb je drie azen. Je haalt het naar schatting in 7 van de 10 potjes."},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s:\ngot  %q\nwant %q", c.name, c.got, c.want)
		}
	}
}

func ptr[T any](v T) *T { return &v }

// TestMakkelijkBidAggression: the naive bid still follows the persona.
func TestMakkelijkBidAggression(t *testing.T) {
	dirk, _ := ByID("dirk")
	truus, _ := ByID("truus")
	sjaak, _ := ByID("sjaak")
	bid := func(p Persona, hand string, turned game.Suit) bool {
		return makkelijkBid(setOf(game.MustParseCards(hand)).inSuit(turned), turned, p.Aggression)
	}
	if bid(dirk, "JH 7S", game.Hearts) || !bid(truus, "JH 7S", game.Hearts) || !bid(sjaak, "JH 7S", game.Hearts) {
		t.Error("a bare boer: Dirk should pass, Truus and Sjaak play")
	}
	if !bid(dirk, "JH 7H", game.Hearts) {
		t.Error("Dirk should play on the boer with another trump")
	}
	if bid(truus, "9H 7H 8H", game.Hearts) || !bid(sjaak, "9H 7H 8H", game.Hearts) {
		t.Error("nel with two more: only Sjaak plays")
	}
	// Over random hands, cautious personas bid less often than bold ones.
	rng := rand.New(rand.NewPCG(71, 72))
	var rates [3]int
	for range 4000 {
		h := setOf(game.Shuffle(rng)[0])
		s := game.Suit(rng.IntN(4))
		for i, p := range []Persona{dirk, truus, sjaak} {
			if makkelijkBid(h.inSuit(s), s, p.Aggression) {
				rates[i]++
			}
		}
	}
	if !(rates[0] < rates[1] && rates[1] < rates[2]) {
		t.Errorf("makkelijk bid counts dirk %d, truus %d, sjaak %d: want increasing with aggression", rates[0], rates[1], rates[2])
	}
}

// TestKleintjeBoerHonest: in self-play (nearly) every kleintje boer that
// the table reads comes from a player who holds the boer, and makers give
// it too. A player without trump may have nothing but small cards to lead.
func TestKleintjeBoerHonest(t *testing.T) {
	deals := 1200
	if testing.Short() {
		deals = 300
	}
	rng := rand.New(rand.NewPCG(73, 74))
	read, genuine, byMaker := 0, 0, 0
	for i := range deals {
		var players [4]Player
		for s := range players {
			players[s] = newPlayer(roster[(i+s)%len(roster)], Normaal, rng.Uint64(), quickSearch)
		}
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			var err error
			switch d.Phase() {
			case game.PhaseBid:
				err = d.Bid(s, players[s].Bid(v))
			case game.PhaseTrump:
				err = d.ChooseTrump(s, players[s].ChooseTrump(v))
			case game.PhasePlay:
				tab := tableFromView(&v)
				c := players[s].Play(v)
				if tab.signalsBoer(s, c) && !tab.boerSig[s.Team()].Valid() {
					read++
					if setOf(v.Hand).has(jackOf(v.Trump)) {
						genuine++
					}
					if s == tab.trumpBy {
						byMaker++
					}
					after := tab
					after.apply(s, c)
					if after.boerSig[s.Team()] != s {
						t.Fatalf("seat %d led %v as kleintje boer, the table did not read it", s, c)
					}
				}
				err = d.Play(s, c)
			}
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Logf("%d signals read in %d deals, %d genuine, %d by the maker", read, deals, genuine, byMaker)
	if read == 0 || byMaker == 0 || float64(genuine) < 0.95*float64(read) {
		t.Errorf("kleintje boer: %d read, %d genuine, %d by the maker; want honest signals from makers and partners", read, genuine, byMaker)
	}
}

// TestSignalsHonest: in self-play the aces and small discards that the
// table reads as signals (aas voorspelen, laag bijspelen) mostly tell the
// truth, at normaal and at sterk. The rates back the sampling weights
// (aceSigHeld, lowSigHeld).
func TestSignalsHonest(t *testing.T) {
	deals := 600
	if testing.Short() {
		deals = 150
	}
	cfg := searchConfig{playWorlds: 64, trumpWorlds: 32, workers: 1}
	for _, lvl := range []Level{Normaal, Sterk} {
		rng := rand.New(rand.NewPCG(75, uint64(lvl)))
		var aces, aceTrue, lows, lowTrue int
		n := deals
		if lvl == Sterk {
			n /= 4
		}
		for i := range n {
			var players [4]Player
			for s := range players {
				players[s] = newPlayer(roster[(i+s)%len(roster)], lvl, rng.Uint64(), cfg)
			}
			d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
			for d.Phase() != game.PhaseDone {
				s := d.Turn()
				v := d.View(s)
				var err error
				switch d.Phase() {
				case game.PhaseBid:
					err = d.Bid(s, players[s].Bid(v))
				case game.PhaseTrump:
					err = d.ChooseTrump(s, players[s].ChooseTrump(v))
				case game.PhasePlay:
					tab := tableFromView(&v)
					c := players[s].Play(v)
					hand := setOf(v.Hand)
					if ten, ok := tab.aceSignal(c); ok {
						aces++
						if hand.has(ten) {
							aceTrue++
						}
					}
					if hi, ok := tab.lowSignal(c); ok {
						lows++
						if hand.has(hi) {
							lowTrue++
						}
					}
					var want cardSet
					if ten, ok := tab.aceSignal(c); ok {
						want = bit(ten)
					}
					if hi, ok := tab.lowSignal(c); ok {
						want = bit(hi)
					}
					after := tab
					after.apply(s, c)
					if got := after.said[s] &^ tab.said[s]; got != want&^tab.said[s] {
						t.Fatalf("seat %d played %v: the table read %v, want %v", s, c, got.appendCards(nil), want.appendCards(nil))
					}
					err = d.Play(s, c)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
		}
		t.Logf("%s: %d of %d ace leads with the 10, %d of %d small discards with the highest card", lvl, aceTrue, aces, lowTrue, lows)
		if aces == 0 || lows == 0 || float64(aceTrue) < 0.9*float64(aces) || float64(lowTrue) < 0.7*float64(lows) {
			t.Errorf("%s: aas voorspelen %d/%d true, laag bijspelen %d/%d true; want honest signals", lvl, aceTrue, aces, lowTrue, lows)
		}
	}
}
