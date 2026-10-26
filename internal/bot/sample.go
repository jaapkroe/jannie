package bot

import (
	"math"
	"math/rand/v2"

	"klaverjas/internal/game"
)

// hint is soft evidence about a seat's original hand: the likelihood of
// what happened is multiplied by held or notHeld depending on whether the
// seat was dealt card.
type hint struct {
	seat          game.Seat
	card          game.Card
	held, notHeld float64
}

// knowledge is what one seat knows about the hidden hands: hard
// constraints for sampling and soft evidence for weighting the samples.
type knowledge struct {
	me     game.Seat
	hand   cardSet
	unk    cardSet    // cards held by the other three seats
	excl   [4]cardSet // cards a seat certainly does not hold
	need   [4]int     // cards each seat still holds
	shown  [4]cardSet // cards each seat has played (part of its dealt hand)
	turned game.Suit
	mode   game.TrumpMode

	// Soft evidence.
	bids    [4]int    // gedraaid: -1 none, 0 pass, 1 play
	maker   game.Seat // chose trump freely among allowed suits (NoSeat if not)
	trump   game.Suit
	forced  bool
	hints   []hint
	anySoft bool
}

// Kleintje boer (table.signalsBoer) as soft evidence that the signaller
// holds the trump boer. Measured in sterk self-play: it is given on about
// 31% of first leads with the boer, and a small side card is led on about
// 4% of first leads without it, a likelihood ratio of about 8 (normaal
// bots almost never lead one without the boer). The game does not tell
// bots which seats are human, so humans get the same weight.
const boerSigHeld, boerSigNotHeld = 2.0, 0.25

// knowledgeFromView collects what v.Seat knows; tab must be tableFromView(v)
// for a view in phase play, or nil before trump is known.
func knowledgeFromView(v *game.View, tab *table) knowledge {
	k := knowledge{
		me:     v.Seat,
		hand:   setOf(v.Hand),
		turned: v.Turned,
		mode:   v.Mode,
		bids:   v.Bids,
		maker:  game.NoSeat,
		trump:  v.Trump,
		forced: v.Forced,
	}
	played := cardSet(0)
	if tab != nil {
		played = tab.played
		k.excl = tab.excl
		k.shown = tab.playedBy
	}
	k.unk = allCards &^ played &^ k.hand
	for s := range k.need {
		k.need[s] = 8 - k.shown[s].count()
	}
	k.need[k.me] = k.hand.count()
	if v.TrumpKnown && v.TrumpBy != k.me && (v.Mode == game.Utrechts || v.Forced) {
		k.maker = v.TrumpBy
	}
	if v.Mode == game.Gedraaid {
		for s, b := range v.Bids {
			if b >= 0 && game.Seat(s) != k.me {
				k.anySoft = true
			}
		}
	}
	if k.maker.Valid() {
		k.anySoft = true
	}
	if tab != nil {
		k.hints = signalHints(v, k.me)
		if sig := tab.boerSig[k.me.Team()^1]; sig.Valid() {
			k.hints = append(k.hints, hint{sig, jackOf(v.Trump), boerSigHeld, boerSigNotHeld})
		}
		if sig := tab.boerSig[k.me.Team()]; sig.Valid() && sig != k.me {
			k.hints = append(k.hints, hint{sig, jackOf(v.Trump), boerSigHeld, boerSigNotHeld})
		}
		for p := range tab.said {
			seat := game.Seat(p)
			if seat == k.me {
				continue
			}
			for x := tab.said[p]; x != 0; x &= x - 1 {
				c := game.CardFromIndex(trailing(x))
				if c == tenOf(c.Suit) && tab.sigBy[p].has(aceOf(c.Suit)) {
					k.hints = append(k.hints, hint{seat, c, aceSigHeld, aceSigNotHeld})
				} else {
					k.hints = append(k.hints, hint{seat, c, lowSigHeld, lowSigNotHeld})
				}
			}
		}
		if len(k.hints) > 0 {
			k.anySoft = true
		}
	}
	return k
}

// Aas vraagt 10 and laag bijspelen (table.aceSignal, table.lowSignal) as
// soft evidence that the signaller holds the card it said. Measured in
// self-play (TestSignalsHonest): every ace discard that the table reads
// comes with the 10, but only about three in four small discards come
// with the highest card, since a discard often has no honest choice. So
// the low signal weighs less. Humans get the same weights.
const (
	aceSigHeld, aceSigNotHeld = 2.0, 0.125
	lowSigHeld, lowSigNotHeld = 2.0, 0.4
)

// signalHints reads what the play so far says about the aces (design §8):
//   - a player who leads a side card other than the ace or the 10 while
//     that ace is still out probably does not hold the ace (with it, one
//     leads the ace, or the 10 first when holding both);
//   - spekken: a player who gives a side 10 to the partner's trick while
//     that ace is out probably does not hold the ace either (with both,
//     one keeps the ace and gives something else).
//
// The cards that players said they hold (table.said) are read in
// knowledgeFromView.
func signalHints(v *game.View, me game.Seat) []hint {
	var hints []hint
	var played cardSet
	trump := v.Trump
	visit := func(tr game.Trick) {
		for i, p := range tr.Cards {
			c, s := p.Card, p.Card.Suit
			if p.Seat != me && s != trump && !played.has(aceOf(s)) {
				switch {
				case i == 0 && c.Rank != game.Ace && c.Rank != game.Ten:
					hints = append(hints, hint{p.Seat, aceOf(s), 0.5, 1})
				case i > 0 && c.Rank == game.Ten && s != tr.Cards[0].Card.Suit:
					prefix := game.Trick{Leader: tr.Leader, Cards: tr.Cards[:i]}
					if w, _ := prefix.CurrentWinner(trump); w == p.Seat.Partner() {
						hints = append(hints, hint{p.Seat, aceOf(s), 0.5, 1})
					}
				}
			}
			played |= bit(c)
		}
	}
	for _, tr := range v.Tricks {
		visit(tr)
	}
	if len(v.Current.Cards) < 4 {
		visit(v.Current)
	}
	return hints
}

// weight returns the relative likelihood of the observed bids, trump
// choice and signals given the dealt hands.
func (k *knowledge) weight(h *[4]cardSet) float64 {
	w := 1.0
	dealt := func(s game.Seat) cardSet { return h[s] | k.shown[s] }
	if k.mode == game.Gedraaid {
		for s, b := range k.bids {
			seat := game.Seat(s)
			if b < 0 || seat == k.me {
				continue
			}
			p := bidProb(dealt(seat), k.turned)
			if b == 1 {
				w *= p
			} else {
				w *= 1 - p
			}
		}
	}
	if k.maker.Valid() {
		w *= choiceProb(dealt(k.maker), k.trump, k.forced, k.turned)
	}
	for _, x := range k.hints {
		if dealt(x.seat).has(x.card) {
			w *= x.held
		} else {
			w *= x.notHeld
		}
	}
	return max(w, 1e-9)
}

// bidProb is the modelled chance that a player bids spelen on turned.
func bidProb(h cardSet, turned game.Suit) float64 {
	x := float64(trumpValue(h, turned)-bidThreshold(0.5)) / 8
	return 0.02 + 0.96/(1+math.Exp(-x))
}

// choiceProb is the modelled chance that a player chooses trump among the
// allowed suits: a softmax over trumpValue.
func choiceProb(h cardSet, trump game.Suit, forced bool, turned game.Suit) float64 {
	const temp = 10.0
	var vals [game.NumSuits]float64
	hi := math.Inf(-1)
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if forced && s == turned {
			continue
		}
		vals[s] = float64(trumpValue(h, s))
		hi = max(hi, vals[s])
	}
	sum, own := 0.0, 0.0
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if forced && s == turned {
			continue
		}
		e := math.Exp((vals[s] - hi) / temp)
		sum += e
		if s == trump {
			own = e
		}
	}
	return own / sum
}

// sampler deals the unknown cards to the other three seats, consistent
// with the hard constraints and close to uniform.
type sampler struct {
	seats [3]game.Seat
	cards []game.Card
	allow []uint8 // per card: bitmask over seats[0..2] that may hold it
	need  [3]int
}

func newSampler(k *knowledge) *sampler {
	sp := &sampler{}
	i := 0
	for s := game.Seat(0); s < 4; s++ {
		if s != k.me {
			sp.seats[i] = s
			sp.need[i] = k.need[s]
			i++
		}
	}
	sp.cards = k.unk.appendCards(make([]game.Card, 0, 24))
	sp.allow = make([]uint8, len(sp.cards))
	for ci, c := range sp.cards {
		for j, s := range sp.seats {
			if !k.excl[s].has(c) {
				sp.allow[ci] |= 1 << j
			}
		}
	}
	if !sp.feasible(sp.counts(), sp.need) {
		// Should not happen with legal play; fall back to no inference.
		for ci := range sp.allow {
			sp.allow[ci] = 7
		}
	}
	return sp
}

func (sp *sampler) counts() [8]int {
	var cnt [8]int
	for _, a := range sp.allow {
		cnt[a]++
	}
	return cnt
}

// feasible checks Hall's condition: for every set of seats, the cards that
// only those seats may hold fit in their remaining capacity.
func (sp *sampler) feasible(cnt [8]int, capa [3]int) bool {
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

// sample deals the unknown cards into h (the other seats' entries are
// overwritten; h[me] is left alone).
func (sp *sampler) sample(rng *rand.Rand, h *[4]cardSet) {
	for _, s := range sp.seats {
		h[s] = 0
	}
	n := len(sp.cards)
	var order [32]int
	for i := range n {
		order[i] = i
	}
	for i := n - 1; i > 0; i-- {
		j := rng.IntN(i + 1)
		order[i], order[j] = order[j], order[i]
	}
	cnt := sp.counts()
	capa := sp.need
	for _, ci := range order[:n] {
		a := sp.allow[ci]
		cnt[a]--
		var w [3]int
		total := 0
		for j := range 3 {
			if a&(1<<j) == 0 || capa[j] == 0 {
				continue
			}
			capa[j]--
			if sp.feasible(cnt, capa) {
				w[j] = capa[j] + 1
				total += w[j]
			}
			capa[j]++
		}
		pick := 0
		if total == 0 {
			// Unreachable when the start is feasible; keep going safely.
			for j := range 3 {
				if capa[j] > 0 {
					pick = j
					break
				}
			}
		} else {
			r := rng.IntN(total)
			for j := range 3 {
				if r < w[j] {
					pick = j
					break
				}
				r -= w[j]
			}
		}
		capa[pick]--
		h[sp.seats[pick]] |= bit(sp.cards[ci])
	}
}

// worlds returns n sampled deals of the hidden cards. With soft evidence
// it draws a larger pool and resamples it by likelihood.
func (k *knowledge) worlds(sp *sampler, rng *rand.Rand, n int) [][4]cardSet {
	out := make([][4]cardSet, n)
	if !k.anySoft {
		for i := range out {
			out[i][k.me] = k.hand
			sp.sample(rng, &out[i])
		}
		return out
	}
	pool := make([][4]cardSet, 3*n)
	w := make([]float64, len(pool))
	total := 0.0
	for i := range pool {
		pool[i][k.me] = k.hand
		sp.sample(rng, &pool[i])
		w[i] = k.weight(&pool[i])
		total += w[i]
	}
	// Systematic resampling.
	step := total / float64(n)
	u := rng.Float64() * step
	acc, j := w[0], 0
	for i := range out {
		target := u + float64(i)*step
		for acc < target && j < len(pool)-1 {
			j++
			acc += w[j]
		}
		out[i] = pool[j]
	}
	return out
}
