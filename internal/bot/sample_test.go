package bot

import (
	"math/rand/v2"
	"testing"

	"klaverjas/internal/game"
)

// TestInferenceSound checks, over many deals and from every seat's point
// of view, that the table agrees with the engine, that nothing inferred
// contradicts the real hands, and that sampled deals are consistent.
func TestInferenceSound(t *testing.T) {
	deals := 400
	if testing.Short() {
		deals = 80
	}
	rng := rand.New(rand.NewPCG(21, 22))
	for i := range deals {
		var players [4]Player
		for s := range players {
			players[s] = newPlayer(roster[(i+s)%8], Level((i+s)%2), rng.Uint64(), quickSearch)
		}
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			switch d.Phase() {
			case game.PhaseBid:
				if err := d.Bid(s, players[s].Bid(d.View(s))); err != nil {
					t.Fatal(err)
				}
				continue
			case game.PhaseTrump:
				if err := d.ChooseTrump(s, players[s].ChooseTrump(d.View(s))); err != nil {
					t.Fatal(err)
				}
				continue
			}
			for obs := game.Seat(0); obs < 4; obs++ {
				v := d.View(obs)
				tab := tableFromView(&v)
				checkTable(t, d, &v, &tab)
				m := newMover(&tab, obs, setOf(v.Hand), setOf(v.Hand), 0.5)
				for p := game.Seat(0); p < 4; p++ {
					h := setOf(d.Hand(p))
					if h&tab.excl[p] != 0 {
						t.Fatalf("seat %d holds %v, inferred impossible", p, (h & tab.excl[p]).appendCards(nil))
					}
					if p != obs && h&^m.poss[p] != 0 {
						t.Fatalf("observer %d: seat %d holds %v outside its possible cards", obs, p, (h &^ m.poss[p]).appendCards(nil))
					}
				}
				if obs == s && d.TrickCount() < 7 && rng.IntN(4) == 0 {
					checkWorlds(t, d, &v, &tab, rng)
				}
			}
			v := d.View(s)
			if err := d.Play(s, players[s].Play(v)); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func checkTable(t *testing.T, d *game.Deal, v *game.View, tab *table) {
	t.Helper()
	if tab.trickNo != len(v.Tricks) || tab.won != d.TricksWon() {
		t.Fatalf("table has %d tricks %v, engine %d %v", tab.trickNo, tab.won, len(v.Tricks), d.TricksWon())
	}
	if tab.n != len(v.Current.Cards) || tab.next() != d.Turn() {
		t.Fatalf("table trick n=%d next=%d, engine n=%d turn=%d", tab.n, tab.next(), len(v.Current.Cards), d.Turn())
	}
	if tab.n > 0 {
		if w, _ := v.Current.CurrentWinner(v.Trump); w != tab.win {
			t.Fatalf("table winner %d, engine %d", tab.win, w)
		}
	}
}

func checkWorlds(t *testing.T, d *game.Deal, v *game.View, tab *table, rng *rand.Rand) {
	t.Helper()
	k := knowledgeFromView(v, tab)
	sp := newSampler(&k)
	for _, w := range k.worlds(sp, rng, 8) {
		var all cardSet
		for p := game.Seat(0); p < 4; p++ {
			if all&w[p] != 0 {
				t.Fatal("sampled hands overlap")
			}
			all |= w[p]
			if w[p].count() != d.HandLen(p) {
				t.Fatalf("seat %d sampled %d cards, holds %d", p, w[p].count(), d.HandLen(p))
			}
			if p != v.Seat && w[p]&tab.excl[p] != 0 {
				t.Fatalf("seat %d sampled an excluded card", p)
			}
		}
		if all != allCards&^tab.played {
			t.Fatal("sampled hands do not cover the unplayed cards")
		}
		if _, err := game.Resume(*v, [4][]game.Card{w[0].appendCards(nil), w[1].appendCards(nil), w[2].appendCards(nil), w[3].appendCards(nil)}); err != nil {
			t.Fatal(err)
		}
	}
}

// TestSamplerUniform: without information every hidden card is equally
// likely to be with each of the other seats.
func TestSamplerUniform(t *testing.T) {
	rng := rand.New(rand.NewPCG(23, 24))
	d := game.NewDeal(3, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	if err := d.ChooseTrump(0, game.Hearts); err != nil {
		t.Fatal(err)
	}
	v := d.View(0)
	tab := tableFromView(&v)
	k := knowledgeFromView(&v, &tab)
	sp := newSampler(&k)
	const n = 6000
	var counts [32][4]int
	for _, w := range k.worlds(sp, rng, n) {
		for p := 1; p < 4; p++ {
			for c := w[p]; c != 0; c &= c - 1 {
				counts[trailing(c)][p]++
			}
		}
	}
	for _, c := range sp.cards {
		for p := 1; p < 4; p++ {
			if f := float64(counts[c.Index()][p]) / n; f < 0.29 || f > 0.38 {
				t.Errorf("card %v with seat %d in %.2f of samples, want about 1/3", c, p, f)
			}
		}
	}
}

// TestSoftEvidence: players who passed on the turned suit are less likely
// to hold its boer, and a maker who chose freely is likely strong in trump.
func TestSoftEvidence(t *testing.T) {
	rng := rand.New(rand.NewPCG(25, 26))
	const trials, per = 40, 100

	// Dealer 0: seats 1 and 2 passed, seat 3 is to bid and lacks the boer.
	// Seat 0 has not bid yet, so it should hold the boer and the suit more
	// often than the passers do.
	var bidderJack, lengthGap float64
	for n := 0; n < trials; {
		hands := game.Shuffle(rng)
		turned := game.Suit(rng.IntN(4))
		if setOf(hands[3]).has(jackOf(turned)) {
			continue
		}
		n++
		d := game.NewDeal(0, hands, game.Gedraaid, game.Amsterdams, turned)
		for s := game.Seat(1); s <= 2; s++ {
			if err := d.Bid(s, false); err != nil {
				t.Fatal(err)
			}
		}
		v := d.View(3)
		k := knowledgeFromView(&v, nil)
		for _, w := range k.worlds(newSampler(&k), rng, per) {
			if w[0].has(jackOf(turned)) {
				bidderJack++
			}
			lengthGap += float64(w[0].countSuit(turned)) - float64(w[1].countSuit(turned)+w[2].countSuit(turned))/2
		}
	}
	f, gap := bidderJack/(trials*per), lengthGap/(trials*per)
	t.Logf("non-passer holds the boer in %.2f of samples; holds %.2f more cards of the suit than a passer", f, gap)
	if f < 0.36 || gap < 0.25 {
		t.Errorf("passing is not read as weakness in the turned suit")
	}

	// Utrechts: the voorhand who chose trump is modelled as strong in it.
	var excess float64
	for range trials {
		hands := game.Shuffle(rng)
		d := game.NewDeal(0, hands, game.Utrechts, game.Amsterdams, 0)
		maker := game.Seat(1)
		trump := bestTrumpNormal(setOf(hands[maker]), false, 0)
		if err := d.ChooseTrump(maker, trump); err != nil {
			t.Fatal(err)
		}
		v := d.View(0)
		tab := tableFromView(&v)
		k := knowledgeFromView(&v, &tab)
		uniform := float64(8-setOf(v.Hand).countSuit(trump)) / 3
		total := 0
		for _, w := range k.worlds(newSampler(&k), rng, per) {
			total += w[maker].countSuit(trump)
		}
		excess += float64(total)/per - uniform
	}
	if avg := excess / trials; avg < 0.6 {
		t.Errorf("maker holds %.2f trumps more than uniform on average, want clearly more", avg)
	}
}

// TestKleintjeBoerEvidence: after the maker's kleintje boer, the other
// seats' samples mostly give the maker the trump boer.
func TestKleintjeBoerEvidence(t *testing.T) {
	rng := rand.New(rand.NewPCG(27, 28))
	d := build(t, 0, [4]string{"JH KH 7C 8C AS KS AD QD", "", "", ""}, game.Hearts, game.Amsterdams, "7C")
	for _, obs := range []game.Seat{1, 2} {
		v := d.View(obs)
		tab := tableFromView(&v)
		if tab.boerSig[0] != 0 {
			t.Fatalf("the maker's kleintje boer was not read: %v", tab.boerSig)
		}
		k := knowledgeFromView(&v, &tab)
		const n = 2000
		held := 0
		for _, w := range k.worlds(newSampler(&k), rng, n) {
			if w[0].has(jackOf(game.Hearts)) {
				held++
			}
		}
		f := float64(held) / n
		t.Logf("seat %d: maker holds the boer in %.2f of samples", obs, f)
		if f < 0.75 {
			t.Errorf("seat %d: the signalling maker holds the boer in %.2f of samples, want most", obs, f)
		}
	}
}

// TestSignalReading: which plays the table reads as aas voorspelen and
// laag bijspelen, and what they say.
func TestSignalReading(t *testing.T) {
	play := func(tab *table, cards string) {
		for _, c := range game.MustParseCards(cards) {
			tab.apply(tab.next(), c)
		}
	}
	// Trump hearts, made by seat 1; seat 0 leads.
	tab := newTable(0, game.Hearts, 1, game.Amsterdams)
	play(&tab, "AS 7S 8S 9S") // seat 0: aas voorspelen, ♠10 is out
	if tab.said[0] != bit(card("TS")) || tab.sigBy[0] != bit(card("AS")) {
		t.Errorf("ace lead: said %v by %v", tab.said[0].appendCards(nil), tab.sigBy[0].appendCards(nil))
	}
	play(&tab, "7D 7C 8D KC") // seat 0 leads ♦7; seat 1 discards ♣7, seat 3 ♣H
	if tab.said[1] != bit(card("AC")) || tab.sigBy[1] != bit(card("7C")) || tab.said[3] != 0 {
		t.Errorf("discards: seat 1 said %v, seat 3 said %v", tab.said[1].appendCards(nil), tab.said[3].appendCards(nil))
	}
	for _, c := range []struct {
		name  string
		cards string // played before the card under test, from a fresh hand
		card  string
		ace   bool
		low   bool
	}{
		{"ace whose 10 has fallen", "7S TS 8S 9S", "AS", false, false},
		{"trump ace", "", "AH", false, false},
		{"ace in the sixth trick", "7C 8C 9C TC 7D 8D 9D TD JC QC KC AC JD QD KD AD 7S 8S 9S JS", "AS", false, false},
		{"ace in the fifth trick", "7C 8C 9C TC 7D 8D 9D TD JC QC KC AC JD QD KD AD", "AS", true, false},
		{"follow suit low", "7S", "8S", false, false},
		{"small discard", "7S", "8D", false, true},
		{"small trump", "7S", "8H", false, false},
		{"high discard", "7S", "KD", false, false},
		{"small discard in the seventh trick", "7C 8C 9C TC 7D 8D 9D TD JC QC KC AC JD QD KD AD 7H 8H 9H TH JH QH KH AH 7S", "8S", false, false},
	} {
		tab := newTable(0, game.Hearts, 1, game.Amsterdams)
		played := game.MustParseCards(c.cards)
		for _, p := range played {
			tab.apply(tab.next(), p)
		}
		x := card(c.card)
		_, ace := tab.aceSignal(x)
		_, low := tab.lowSignal(x)
		if ace != c.ace || low != c.low {
			t.Errorf("%s: aas voorspelen %v, laag bijspelen %v; want %v, %v", c.name, ace, low, c.ace, c.low)
		}
	}
}

// TestSignalEvidence: after aas voorspelen, the other seats' samples
// mostly give the leader the 10; after laag bijspelen, the discarder
// holds the highest card of the suit more often than without the signal.
func TestSignalEvidence(t *testing.T) {
	rng := rand.New(rand.NewPCG(29, 30))
	share := func(d *game.Deal, obs, seat game.Seat, c game.Card) float64 {
		v := d.View(obs)
		tab := tableFromView(&v)
		k := knowledgeFromView(&v, &tab)
		const n = 2000
		held := 0
		for _, w := range k.worlds(newSampler(&k), rng, n) {
			if w[seat].has(c) {
				held++
			}
		}
		return float64(held) / n
	}
	// Seat 0 leads ♠A and holds ♠10.
	d := build(t, 0, [4]string{"AS TS 7D JH 9H 8H 7H KH", "", "", ""}, game.Hearts, game.Amsterdams, "AS")
	for _, obs := range []game.Seat{1, 2, 3} {
		f := share(d, obs, 0, card("TS"))
		t.Logf("seat %d: the ace leader holds ♠10 in %.2f of samples", obs, f)
		if f < 0.75 {
			t.Errorf("seat %d: the leader of ♠A holds ♠10 in %.2f of samples, want most", obs, f)
		}
	}
	// Seat 1 discards ♠7 on ♦7 and holds ♠A; seat 3 watches.
	spec := [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"}
	with := share(build(t, 0, spec, game.Hearts, game.Amsterdams, "7D 7S"), 3, 1, card("AS"))
	without := share(build(t, 0, spec, game.Hearts, game.Amsterdams, "7D QC"), 3, 1, card("AS"))
	t.Logf("the discarder holds ♠A in %.2f of samples after ♠7, %.2f after ♣V", with, without)
	if with < without+0.1 {
		t.Errorf("laag bijspelen is not read: ♠A with the discarder in %.2f of samples, %.2f without the signal", with, without)
	}
}
