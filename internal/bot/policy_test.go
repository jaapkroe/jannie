package bot

import (
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
			name: "lead an ace", trump: game.Hearts,
			spec: [4]string{"JH 9H 8H AS AD 7C 8C 9C", "", "", ""},
			card: "AS",
			want: "Speel ♠A: de aas is de hoogste kaart in schoppen en levert 11 punten op.",
		},
		{
			name: "smear", trump: game.Hearts,
			spec:  [4]string{"AS JH 9H 7C 8C 9C 7D 8D", "7S 8S", "TS QS 9S", "JS"},
			plays: "AS 7S",
			card:  "TS",
			want:  "Je maat heeft de slag: smeer je ♠10 voor 10 extra punten.",
		},
		{
			name: "discard a worthless card", voorhand: 3, trump: game.Spades,
			spec: [4]string{"7D 9D TD JD 7S 8H 9H TH", "8D QD KD 7H AH 9C JC QC",
				"AC TC 7C 8C KH QH JH KC", "AD JS 9S AS TS KS QS 8S"},
			plays: "AD 7D 8D",
			card:  "7C",
			want:  "Gooi je ♣7 af: die is niets waard en je kunt niet bekennen.",
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
			want:  "Speel ♥8: dat is de enige kaart die mag (je kunt niet bekennen: je moet troeven (♥)).",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := build(t, c.voorhand, c.spec, c.trump, game.Amsterdams, c.plays)
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
