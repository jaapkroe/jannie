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

// TestSignalReading: which plays the table reads as met de aas seinen and
// opseinen, and what they say.
func TestSignalReading(t *testing.T) {
	play := func(tab *table, cards string) {
		for _, c := range game.MustParseCards(cards) {
			tab.apply(tab.next(), c)
		}
	}
	// Trump hearts, made by seat 1; seat 0 leads.
	tab := newTable(0, game.Hearts, 1, game.Amsterdams, game.DefaultSignals)
	play(&tab, "AS 7S 8S 9S") // an ace lead says nothing
	if tab.said[0] != 0 {
		t.Errorf("ace lead: said %v", tab.said[0].appendCards(nil))
	}
	// Seat 0 leads ♦7, seat 1 takes it with ♦8; seat 2 discards ♣9 into
	// the opponents' trick (no signal), seat 3 ♣7 on its partner's (laag).
	play(&tab, "7D 8D 9C 7C")
	if tab.said[2] != 0 || tab.said[3] != bit(card("AC")) || tab.sigBy[3] != bit(card("7C")) {
		t.Errorf("discards: seat 2 said %v, seat 3 said %v", tab.said[2].appendCards(nil), tab.said[3].appendCards(nil))
	}
	noHoogLaag := newTable(0, game.Hearts, 1, game.Amsterdams, game.Signals{Aas: true, KleintjeBoer: true})
	play(&noHoogLaag, "7D 8D 9C 7C")
	if noHoogLaag.said[3] != 0 {
		t.Errorf("a table without op- of afseinen reads ♣7 as %v", noHoogLaag.said[3].appendCards(nil))
	}
	// Seat 0 leads ♦A, seat 2 gives ♠A to it: met de aas seinen, ♠10 is out.
	aas := newTable(0, game.Hearts, 1, game.Amsterdams, game.DefaultSignals)
	play(&aas, "AD 7D AS 8D")
	if aas.said[2] != bit(card("TS")) || aas.sigBy[2] != bit(card("AS")) {
		t.Errorf("ace discard: said %v by %v", aas.said[2].appendCards(nil), aas.sigBy[2].appendCards(nil))
	}
	noAas := newTable(0, game.Hearts, 1, game.Amsterdams, game.Signals{KleintjeBoer: true, HoogLaag: true})
	play(&noAas, "AD 7D AS 8D")
	if noAas.said[2] != 0 {
		t.Errorf("a table without met de aas seinen reads ♠A as %v", noAas.said[2].appendCards(nil))
	}
	for _, c := range []struct {
		name  string
		cards string // played before the card under test, from a fresh hand
		card  string
		ace   bool
		low   bool
	}{
		{"ace on partner's trick", "AD 7D", "AS", true, false},
		{"ace lead", "", "AS", false, false},
		{"ace into an opponents' trick", "7D 8D", "AS", false, false},
		{"ace whose 10 has fallen", "7D 8D TS 7C AD 9D", "AS", false, false},
		{"ace of a suit that was led", "7S 8S 9S JS AD 7D", "AS", false, false},
		{"trump ace", "AD 7D", "AH", false, false},
		{"ace in the sixth trick", "7C 8C 9C TC 7D 8D 9D TD JC QC KC AC JD QD KD AD 7H 8H 9H 7S JH 8S", "AS", true, false},
		{"ace in the seventh trick", "7C 8C 9C TC 7D 8D 9D TD JC QC KC AC JD QD KD AD 7H 8H 9H 7S JH 8S TH QH KH 9S", "AS", false, false},
		{"follow suit low", "7S", "8S", false, false},
		{"small discard into an opponents' trick", "7S", "8D", false, false},
		{"small discard on partner's trick", "7S AS 8S", "8D", false, true},
		{"small trump", "7S", "8H", false, false},
		{"high discard", "7S", "KD", false, false},
		{"small discard in the seventh trick", "7C 8C 9C TC 7D 8D 9D TD JC QC KC AC JD QD KD AD 7H 8H 9H TH JH QH KH AH 7S", "8S", false, false},
	} {
		tab := newTable(0, game.Hearts, 1, game.Amsterdams, game.DefaultSignals)
		played := game.MustParseCards(c.cards)
		for _, p := range played {
			tab.apply(tab.next(), p)
		}
		x := card(c.card)
		_, ace := tab.aceSignal(x)
		_, low := tab.lowSignal(x)
		if ace != c.ace || low != c.low {
			t.Errorf("%s: met de aas seinen %v, opseinen %v; want %v, %v", c.name, ace, low, c.ace, c.low)
		}
	}
}

// TestBoerSignals: the leads that say "ik heb de troefboer", as far as the
// table agreed on them: a small side card (kleintje boer) and a side boer
// (boer over boer, off by default).
func TestBoerSignals(t *testing.T) {
	for _, c := range []struct {
		name string
		sig  game.Signals
		card string
		want bool
	}{
		{"kleintje boer", game.DefaultSignals, "7S", true},
		{"kleintje boer not agreed", game.Signals{Aas: true, HoogLaag: true}, "7S", false},
		{"a side boer by default", game.DefaultSignals, "JS", false},
		{"boer over boer agreed", game.Signals{KleintjeBoer: true, BoerOverBoer: true}, "JS", true},
		{"boer over boer without kleintje boer", game.Signals{BoerOverBoer: true}, "7S", false},
	} {
		tab := newTable(0, game.Hearts, 0, game.Amsterdams, c.sig) // seat 0 made trump and leads
		if got := tab.signalsBoer(0, card(c.card)); got != c.want {
			t.Errorf("%s: %v says ik heb de troefboer: %v, want %v", c.name, c.card, got, c.want)
		}
	}
}

// TestSignalEvidence: after met de aas seinen, the other seats' samples
// mostly give the discarder the 10; after opseinen, the discarder
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
	// Seat 2 gives ♠A to its partner's ♦A and holds ♠10.
	d := build(t, 3, [4]string{"AD", "8D", "AS TS 7H 8H 9H JC QC KC", "7D"}, game.Hearts, game.Amsterdams, "7D AD 8D AS")
	for _, obs := range []game.Seat{0, 1, 3} {
		f := share(d, obs, 2, card("TS"))
		t.Logf("seat %d: the ace discarder holds ♠10 in %.2f of samples", obs, f)
		if f < 0.75 {
			t.Errorf("seat %d: the discarder of ♠A holds ♠10 in %.2f of samples, want most", obs, f)
		}
	}
	// Seat 1 discards ♠7 on its partner's ♦A and holds ♠A; the partner,
	// seat 3, reads it.
	spec := [4]string{"7D", "7C 8C QC AS 7S 8S 9S KS", "8D", "AD JS 9C QD 8H 7H"}
	with := share(build(t, 3, spec, game.Hearts, game.Amsterdams, "AD 7D 7S"), 3, 1, card("AS"))
	without := share(build(t, 3, spec, game.Hearts, game.Amsterdams, "AD 7D QC"), 3, 1, card("AS"))
	t.Logf("the discarder holds ♠A in %.2f of samples after ♠7, %.2f after ♣V", with, without)
	if with < without+0.1 {
		t.Errorf("opseinen is not read: ♠A with the discarder in %.2f of samples, %.2f without the signal", with, without)
	}
}

// TestFeasibleHall checks the written-out Hall's condition of feasible
// against the condition as stated, set by set.
func TestFeasibleHall(t *testing.T) {
	hall := func(cnt [8]int, capa [3]int) bool {
		if cnt[0] > 0 {
			return false
		}
		for set := 1; set < 8; set++ {
			n, c := 0, 0
			for m := 1; m < 8; m++ {
				if m&^set == 0 {
					n += cnt[m]
				}
			}
			for j := range 3 {
				if set&(1<<j) != 0 {
					c += capa[j]
				}
			}
			if n > c {
				return false
			}
		}
		return true
	}
	var sp sampler
	rng := rand.New(rand.NewPCG(23, 24))
	for range 200000 {
		var cnt [8]int
		var capa [3]int
		for m := range cnt {
			if rng.IntN(3) > 0 {
				cnt[m] = rng.IntN(5)
			}
		}
		if rng.IntN(2) == 0 {
			cnt[0] = 0
		}
		for j := range capa {
			capa[j] = rng.IntN(9)
		}
		if got, want := sp.feasible(cnt, capa), hall(cnt, capa); got != want {
			t.Fatalf("feasible(%v, %v) = %v, want %v", cnt, capa, got, want)
		}
	}
}
