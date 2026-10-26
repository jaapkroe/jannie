package bot

import (
	"math"
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
			name: "with the ace and the 10, lead the 10 first", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"AS TS 8S 7D 9D 7C 8C 9C", "", "", ""},
			want: "TS",
		},
		{
			name: "cash a bare ace: an ace lead says nothing", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"AS AD 7D 9S KC QC 7C 8C", "KS", "7S", "8S"},
			plays: "KS 7S 8S AS",
			want:  "AD",
		},
		{
			name: "aas vraagt 10: give the ace with its 10 to partner's trick", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"AD 8S QS 7C 8C 9C KD QD", "8D", "AS TS 7H 8H 9H JC QC KC", "7D"},
			plays: "7D AD 8D",
			want:  "AS",
		},
		{
			name: "come back to the suit of partner's aas vraagt 10", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"AD 8S QS 7C 8C 9C KD QD", "8D", "AS TS 7H 8H 9H JC QC KC", "7D"},
			plays: "7D AD 8D AS",
			want:  "8S",
		},
		{
			name: "laag bijspelen on partner's trick: discard low where you hold the highest card", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"8D", "7C 8C 9C AS 7S 8S 9S 7H", "7D", "AD JS TC QD 8H KH"},
			plays: "7D AD 8D",
			want:  "7S",
		},
		{
			name: "play to partner's laag bijspelen", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"8D", "7C 8C 9C AS 7S 8S 9S 7H", "7D", "AD JS TC QD 8H KH"},
			plays: "7D AD 8D 7S",
			want:  "JS",
		},
		{
			name: "an opponents' trick: throw the cheapest card, a 7 says nothing there", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"AD", "7C 8C QC KS 7S 8S 9S JS", "7D", "8D"},
			plays: "7D 8D AD",
			want:  "7C",
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

// TestRuleTexts: the hint for the rule-based card gives the reason of the
// rule that chose it (ruleWhy), with what the card signals.
func TestRuleTexts(t *testing.T) {
	cases := []struct {
		name     string
		voorhand game.Seat
		spec     [4]string
		trump    game.Suit
		rules    game.Rules    // default amsterdams
		sig      *game.Signals // default game.DefaultSignals
		plays    string
		want     string // the rule-based card
		text     string
	}{
		{
			name: "smear the 10, keep a side ace", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AS KS JH 9H 7C 8C 9C 8D", "7S 8S", "AD TC JC QD 7D 9D KD QC", "9S TS"},
			plays: "AS 7S",
			want:  "TC",
			text:  "Speel ♣10: je maat heeft de slag (alleen een troef kan er nog overheen), dus spek hem: 10 punten erbij; ♦A is de hoogste ruiten en kan zelf nog een slag halen.",
		},
		{
			name: "duck into the opponents' trick", voorhand: 0, trump: game.Spades,
			spec:  [4]string{"9D JS 9S AS AH TH KH QH", "7C 8C 9C TC JC QC KC AC", "TD AD KD QD 7H 8H 9H JH", "8D JD 7D TS KS QS 8S 7S"},
			plays: "9D 7C TD",
			want:  "7D",
			text:  "Speel ♦7: je kunt de slag niet winnen, dus geef zo weinig mogelijk weg. ♦7 is niets waard.",
		},
		{
			name: "ruff a cheap trick low", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7S", "JH 8H AC TC KC QC AD KD", "", ""},
			plays: "7S",
			want:  "8H",
			text:  "Speel ♥8: je kunt niet bekennen en de slag is weinig waard, dus troef met je laagste troef die wint. Je hoge troeven houd je achter de hand.",
		},
		{
			name: "partner returns trump after kleintje boer", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"JH KH 7C 8C AS KS AD QD", "9C", "AC 7H 8H", "TC"},
			plays: "7C 9C AC TC",
			want:  "7H",
			text:  "Speel ♥7: je maat vroeg met een kleintje om troef (kleintje boer), dus speel troef naar je maat toe.",
		},
		{
			name: "no small lead without the boer", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"9H 8H 7C 8C KS QS KD QD", "", "", ""},
			want: "QD",
			text: "Speel ♦V: met ♣7 zou je kleintje boer seinen (“ik heb de troefboer”), maar die heb je niet.",
		},
		{
			name: "with the ace and the 10, lead the 10 first", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"AS TS 8S 7D 9D 7C 8C 9C", "", "", ""},
			want: "TS",
			text: "Speel ♠10: je hebt ♠A zelf, dus de 10 wint net zo goed. Daarna is je ♠A de hoogste schoppen.",
		},
		{
			name: "laag bijspelen on partner's sure trick", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"8D", "7C 8C 9C AS 7S 8S 9S 7H", "7D", "AD JS TC QD 8H KH"},
			plays: "7D AD 8D",
			want:  "7S",
			text:  "Speel ♠7: je maat heeft de slag zeker, maar ♠A is de hoogste schoppen en kan zelf nog een slag halen. ♣7 zou je maat lezen als “speel klaveren, daar heb ik de hoogste van” (hoog/laag bijspelen), maar die heb je niet. Zo zeg je ook tegen je maat: “speel schoppen, daar heb ik de hoogste van” (hoog/laag bijspelen).",
		},
		{
			name: "lead to partner's laag bijspelen", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"8D", "7C 8C 9C AS 7S 8S 9S 7H", "7D", "AD JS TC QD 8H KH"},
			plays: "7D AD 8D 7S",
			want:  "JS",
			text:  "Speel ♠B: je maat gooide ♠7 bij en zei daarmee “speel schoppen, daar heb ik de hoogste van” (hoog/laag bijspelen), dus zo speel je schoppen naar je maat toe.",
		},
		{
			name: "pull trump with the highest trump", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"JH 9H 8H AS AD 7C 8C 9C", "", "", ""},
			want: "JH",
			text: "Speel ♥B: dit is de hoogste troef die er nog is. Jullie spelen, dus haal de troeven van de tegenstanders eruit.",
		},
		{
			name: "smear a 10 on partner's trick", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AS JH 9H 7C 8C 9C 7D 8D", "7S 8S", "TS QS 9S", "JS"},
			plays: "AS 7S",
			want:  "TS",
			text:  "Speel ♠10: je maat heeft de slag (alleen een troef kan er nog overheen), dus spek hem: 10 punten erbij.",
		},
		{
			name: "smear roem on partner's sure trick", voorhand: 0, trump: game.Clubs,
			spec:  [4]string{"JC 9C AS AD AH 7S 7D 7H", "KC 8S 8D 8H", "QC 7C 9S 9D", ""},
			plays: "JC KC",
			want:  "QC",
			text:  "Speel ♣V: je maat heeft de slag zeker, dus spek hem: 3 punten en 40 roem (driekaart en stuk) erbij.",
		},
		{
			name: "take the trick last", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"KD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS", "8D AH TH KH QH 8H 7H JS", "AD 9D QS KS AS TC JC QC"},
			plays: "KD 7D 8D",
			want:  "AD",
			text:  "Speel ♦A: je speelt als laatste, dus daarmee is de slag van jou (15 punten).",
		},
		{
			name: "trump in last", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS", "8D 9D KD AH TH KH QH JS", "7H 8H QS KS AS TC JC QC"},
			plays: "AD 7D 8D",
			want:  "7H",
			text:  "Speel ♥7: je speelt als laatste, dus daarmee is de slag van jou (11 punten).",
		},
		{
			name: "only one legal card", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS", "8D 9D KD AH TH KH QH 7H", "JS QS KS AS TC JC QC 8H"},
			plays: "AD 7D 8D",
			want:  "8H",
			text:  "Speel ♥8: je kunt niet bekennen, dus je moet troeven.",
		},
		{
			name: "only one card of the led suit", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AD JH 9H 7C 8C 9C 7S 8S", "7D TD JD QD KC AC 9S TS", "8D 7H 8H TH QH KH AH TC", ""},
			plays: "AD 7D",
			want:  "8D",
			text:  "Speel ♦8: je moet bekennen, en dit is je enige ruiten.",
		},
		{
			name: "the only higher trump on a trump lead", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"KH AS AD 7C 8C 9C 7S 8S", "7H TC JC QC KC AC 9S TS", "AH 8H 7D 8D 9D TD JD QD", ""},
			plays: "KH 7H",
			want:  "AH",
			text:  "Speel ♥A: troef is gevraagd en je moet overtroeven, ook over je maat heen; alleen deze troef is hoger.",
		},
		{
			name: "take over partner's trick that is not sure", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7H 8H TH 7C 8C 9C 7D 8D", "7S 8S 9S TS JS QS KS AS", "JH 9H AC KC QC AD KD QD", ""},
			plays: "7H 7S",
			want:  "9H",
			text:  "Speel ♥9: je maat heeft de slag nog niet zeker. Daarmee neem je hem over, en niemand na je kan er nog overheen (14 punten).",
		},
		{
			name: "rotterdams: undertrump an opponent", voorhand: 0, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"KS", "7S", "9H JC QC KC AC 9D TD JD", "AH 7H AD 8C 9C TC 7D 8D"},
			plays: "KS 7S 9H",
			want:  "7H",
			text:  "Speel ♥7: je kunt de slag niet winnen, dus geef zo weinig mogelijk weg. ♥7 is niets waard.",
		},
		{
			name: "rotterdams: trump under the partner, keep the trump ace", voorhand: 1, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"AH 7H AD 8C 9C TC 7D 8D", "KS", "9H JC QC KC AC 9D TD JD", "7S"},
			plays: "KS 9H 7S",
			want:  "7H",
			text:  "Speel ♥7: je maat heeft de slag zeker. ♥7 is niets waard.",
		},
		{
			name: "rotterdams: the only trump is lower", voorhand: 1, trump: game.Hearts, rules: game.Rotterdams,
			spec:  [4]string{"7H AD 8C 9C TC 7D 8D QD", "KS", "9H JC QC KC AC 9D TD JD", "7S"},
			plays: "KS 9H 7S",
			want:  "7H",
			text:  "Speel ♥7: je kunt niet bekennen en niet overtroeven, maar bij Rotterdams moet je toch troeven; dit is je enige troef.",
		},
		{
			name: "take over partner's unsafe trick with a side ace", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"KS", "7S", "AS 8S", ""},
			plays: "KS 7S",
			want:  "AS",
			text:  "Speel ♠A: je maat heeft de slag nog niet zeker. Daarmee neem je hem over, tenzij iemand na je troeft (15 punten).",
		},
		{
			name: "the 10 before its ace: only the 10 can make roem", voorhand: 0, trump: game.Spades,
			spec:  [4]string{"7H", "AH 7S AC TC QC 7D JD 8D", "8H", "9H"},
			plays: "7H AH 8H 9H",
			want:  "TC",
			text:  "Speel ♣10: je hebt ♣A zelf, dus de 10 wint net zo goed. Met de 10 kan er nog roem in de slag komen, met de aas niet. Daarna is je ♣A de hoogste klaveren.",
		},
		{
			name: "maker gives kleintje boer", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"JH KH 7C 8C AS KS AD QD", "", "", ""},
			want: "7C",
			text: "Speel ♣7: met een kleintje laat je je maat weten dat jij de troefboer hebt (kleintje boer). Neemt je maat de slag, dan speelt die troef terug.",
		},
		{
			name: "cash a side ace", voorhand: 0, trump: game.Clubs,
			spec: [4]string{"7C AH KH TD JD AS KS QS", "", "", ""},
			want: "AH",
			text: "Speel ♥A: dit is de hoogste harten die er nog is: haal de slag binnen voordat iemand kan troeven.",
		},
		{
			name: "pull trump low", voorhand: 0, trump: game.Diamonds,
			spec: [4]string{"AD TD KD 9H TC 7C AS QS", "", "", ""},
			want: "KD",
			text: "Speel ♦H: jullie spelen, dus haal de troeven van de tegenstanders eruit. Je hoge troeven houd je achter de hand.",
		},
		{
			name: "must trump: the lowest trump that wins", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"AD 7S 8S 9S TS JS QS KS", "7H 8H 7C 8C 9C TC JC QC", "", ""},
			plays: "AD",
			want:  "7H",
			text:  "Speel ♥7: je kunt niet bekennen en moet troeven. Met je laagste troef die wint neem je de slag voorlopig.",
		},
		{
			name: "smear, keeping a side boss", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"},
			plays: "AD 7D",
			want:  "KS",
			text:  "Speel ♠H: je maat heeft de slag (alleen een troef kan er nog overheen), dus spek hem: 4 punten erbij; ♠A is de hoogste schoppen en kan zelf nog een slag halen.",
		},
		{
			name: "aas vraagt 10 on partner's trick", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"AD 8S QS 7C 8C 9C KD QD", "8D", "AS TS 7H 8H 9H JC QC KC", "7D"},
			plays: "7D AD 8D",
			want:  "AS",
			text:  "Speel ♠A: je maat heeft de slag zeker, dus spek hem: 11 punten erbij. Je hebt ook ♠10, en dat weet je maat nu (aas vraagt 10): zonder de aas is je 10 de hoogste schoppen en kan die nog een slag halen.",
		},
		{
			name: "lead to partner's aas vraagt 10", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"AD 8S QS 7C 8C 9C KD QD", "8D", "AS TS 7H 8H 9H JC QC KC", "7D"},
			plays: "7D AD 8D AS",
			want:  "8S",
			text:  "Speel ♠8: je maat gooide ♠A bij en zei daarmee “ik heb ♠10 ook” (aas vraagt 10), dus zo speel je schoppen naar je maat toe.",
		},
		{
			name: "trump rather than a false kleintje boer", voorhand: 0, trump: game.Clubs,
			spec: [4]string{"TD KD 8C 9C 7H 8H 7S 8S", "", "", ""},
			want: "8C",
			text: "Speel ♣8: met een kleintje van een bijkleur zou je kleintje boer seinen (“ik heb de troefboer”), maar die heb je niet. Met troef gebeurt dat niet.",
		},
		{
			name: "defender leads the highest trump", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"AD JH 7C 8C 9C 7S 8S 9S", "7D", "8D", "9D"},
			plays: "7D 8D 9D AD",
			want:  "JH",
			text:  "Speel ♥B: dit is de hoogste troef die er nog is. Als tegenpartij kom je meestal niet met troef uit, maar zo pak je de slag en haal je troeven weg bij de spelende partij.",
		},
		{
			name: "trump in last, a trick without points", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"7H 8H 7S 8S 9S TS JS QS", "7C", "7D 8D 9D TD JD QD KD AD", "8C"},
			plays: "7C 7D 8C",
			want:  "7H",
			text:  "Speel ♥7: je speelt als laatste, dus daarmee is de slag van jou.",
		},
		{
			name: "duck: the cheapest card would give roem", voorhand: 3, trump: game.Spades, rules: game.Rotterdams,
			spec:  [4]string{"QS", "TS", "9D 9S 8D KS AH AS TH 7C", "JS"},
			plays: "JS QS TS",
			want:  "AS",
			text:  "Speel ♠A: je kunt de slag niet winnen, dus geef zo weinig mogelijk weg. Met ♠H zou je de tegenstanders 50 roem geven (vierkaart en stuk in plaats van driekaart).",
		},
		{
			name: "only trumps", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"7H 8H 9H TH JH QH KH AH", "", "", ""},
			want: "JH",
			text: "Speel ♥B: je hebt alleen nog troef.",
		},
		{
			name: "partner void: lead for a ruff", voorhand: 0, trump: game.Hearts,
			spec:  [4]string{"7D 8D AS 9C QC KC JC 7C", "9D 9S", "7H 7S 8H 9H TS QS KS JS", "TD 8S"},
			plays: "7D 9D 7H TD 7S 8S AS 9S",
			want:  "8D",
			text:  "Speel ♦8: je maat heeft geen ruiten meer en kan troeven.",
		},
		{
			name: "lead the last card of a suit", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"7H 8S 9C QC KC 9D QD KD", "", "", ""},
			sig:  &game.Signals{Aas: true, HoogLaag: true},
			want: "8S",
			text: "Speel ♠8: dit is je laatste schoppen. Dan ben je die kleur kwijt en kun je later troeven.",
		},
		{
			name: "no trump, only small cards: a false kleintje boer", voorhand: 0, trump: game.Hearts,
			spec: [4]string{"7C 8C 7D 8D 9S 8S 7S 9D", "", "", ""},
			want: "7C",
			text: "Speel ♣7: een lage kaart kost weinig, en je hoge kaarten bewaar je voor later. Let op: je maat kan dit lezen als kleintje boer (“ik heb de troefboer”), maar die heb je niet.",
		},
		{
			name: "high discard on partner's trick", voorhand: 1, trump: game.Hearts,
			spec:  [4]string{"KS 7S 7C 8C 9C QC JC 7H", "7D", "AD", "8D"},
			plays: "7D AD 8D",
			want:  "KS",
			text:  "Speel ♠H: je maat heeft de slag zeker, dus spek hem: 4 punten erbij. Met deze hoge bijkaart zeg je ook dat je weinig schoppen hebt (hoog/laag bijspelen).",
		},
		{
			name: "take the trick, nobody after can beat it", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"AS 7S 7C 8C 9C QC JC KC", "", "", "KS"},
			plays: "KS",
			want:  "AS",
			text:  "Speel ♠A: daarmee pak je de slag, tenzij iemand na je troeft (15 punten).",
		},
		{
			name: "every legal card wins", voorhand: 3, trump: game.Hearts,
			spec:  [4]string{"8S 9S 7C 8C 9C QC JC KC", "", "", "7S"},
			plays: "7S",
			want:  "8S",
			text:  "Speel ♠8: elke kaart die je mag spelen gaat er voorlopig overheen, en ♠8 kost het minst.",
		},
		{
			name: "partner's trick not sure: give no points", voorhand: 2, trump: game.Hearts,
			spec:  [4]string{"AC 7C TC 8D 9D QD JD KD", "", "QS", "8S"},
			plays: "QS 8S",
			want:  "7C",
			text:  "Speel ♣7: je maat heeft de slag nog niet zeker, dus geef er geen punten bij. ♣7 is niets waard. Zo zeg je ook tegen je maat: “speel klaveren, daar heb ik de hoogste van” (hoog/laag bijspelen).",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := build(t, c.voorhand, c.spec, c.trump, c.rules, c.plays)
			v := turnView(d)
			v.Signals = c.sig
			tab := tableFromView(&v)
			m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(legalCards(v)), 0.5)
			got, r := m.decide()
			if text := hintText(got, m.ruleWhy(got, r)); got != card(c.want) || text != c.text {
				t.Errorf("got %v %q\nwant %v %q", got, text, c.want, c.text)
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
// table reads as signals (aas vraagt 10, laag bijspelen) mostly tell the
// truth, at normaal and at sterk: nine in ten and seven in ten, or not
// clearly fewer (two standard errors; there are a few dozen per level).
// The rates back the sampling weights (aceSigHeld, lowSigHeld).
func TestSignalsHonest(t *testing.T) {
	deals := 600
	if testing.Short() {
		deals = 150
	}
	honest := func(k, n int, p float64) bool {
		return float64(k) >= float64(n)*p-2*math.Sqrt(float64(n)*p*(1-p))
	}
	cfg := searchConfig{playWorlds: 64, trumpWorlds: 32, workers: 1}
	var allAces, allLows int
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
		t.Logf("%s: %d of %d ace discards with the 10, %d of %d small discards with the highest card", lvl, aceTrue, aces, lowTrue, lows)
		if !honest(aceTrue, aces, 0.9) || !honest(lowTrue, lows, 0.7) {
			t.Errorf("%s: aas vraagt 10 %d/%d true, laag bijspelen %d/%d true; want honest signals", lvl, aceTrue, aces, lowTrue, lows)
		}
		allAces += aces
		allLows += lows
	}
	if allAces == 0 || allLows == 0 {
		t.Errorf("%d ace discards and %d small discards read as signals; want some of each", allAces, allLows)
	}
}
