package bot

import (
	"math"

	"jannie/games/klaverjas/game"
)

// What two cards do differently (games/klaverjas/README.md#package-bot).
// The value of a card says how much it brings, the parts in which tricks;
// neither says what happens. The search plays every card in the same
// deals, so per deal it keeps what a player can check at the table
// (playEvent): which of their own cards their team wins, who wins the last
// trick, and the roem in the card's own trick. diffWhy compares two cards
// on these and names the difference that brings the most points, when it
// is clear and large enough to be a reason: at least diffMin points on
// average and a quarter of what the one card brings more in points and
// roem (before nat and pit, which can turn a few points into a whole
// hand), and with sampled deals at least two standard errors of the paired
// difference. A sentence says how often something happens, so a difference
// counts only when its shares, as written, go the same way.

// diffMin is the least a difference in the playouts must bring on average
// for diffWhy to name it.
const diffMin = 2.0

// diffWhy is what playing a instead of b does differently, in one sentence,
// or "": ea and eb are their playouts in the same deals, w the weight of
// each deal (nil: sampled deals of equal weight, so a difference must also
// stand out from their noise; else every possible deal, weighted), hand the
// player's cards and trump the trump suit.
func diffWhy(a, b game.Card, ea, eb []playEvent, w []float64, hand cardSet, trump game.Suit) string {
	n := len(ea)
	if n == 0 || len(eb) != n {
		return ""
	}
	weight := func(k int) float64 {
		if w == nil {
			return 1
		}
		return w[k]
	}
	// avg is the mean of f with a minus f with b.
	avg := func(f func(e playEvent) float64) float64 {
		var sw, s float64
		for k := range n {
			sw += weight(k)
			s += weight(k) * (f(ea[k]) - f(eb[k]))
		}
		return s / sw
	}
	least := max(diffMin, avg(func(e playEvent) float64 { return float64(e.raw) })/4)
	// gain is avg of f, and whether it is clear.
	gain := func(f func(e playEvent) float64) (float64, bool) {
		var sw, s, s2 float64
		for k := range n {
			d := f(ea[k]) - f(eb[k])
			sw += weight(k)
			s += weight(k) * d
			s2 += weight(k) * d * d
		}
		mean := s / sw
		switch {
		case mean < least:
			return mean, false
		case w != nil:
			return mean, true
		case n < 2:
			return mean, false
		}
		se := math.Sqrt(max(s2/sw-mean*mean, 0) / float64(n-1))
		return mean, mean >= 2*se
	}
	// share is the weighted share of the deals where f holds.
	share := func(ev []playEvent, f func(e playEvent) bool) float64 {
		var sw, s float64
		for k := range n {
			sw += weight(k)
			if f(ev[k]) {
				s += weight(k)
			}
		}
		return s / sw
	}
	// won is what card c of the player brings: its points, for whichever
	// team wins its trick.
	won := func(c game.Card) func(e playEvent) float64 {
		p := float64(game.Points(c, trump))
		return func(e playEvent) float64 {
			if e.ours.has(c) {
				return p
			}
			return -p
		}
	}

	best, text := 0.0, ""
	consider := func(g float64, ok bool, say func() string) {
		if ok && g > best {
			best, text = g, say()
		}
	}
	cardLost := func(c game.Card) func() string {
		return func() string {
			lost := func(e playEvent) bool { return !e.ours.has(c) }
			return "Je " + game.CardShortNL(c) + " gaat in " + percent(share(eb, lost)) + " van de verdelingen naar de tegenstanders als je " +
				game.CardShortNL(b) + " speelt, en in " + percent(share(ea, lost)) + " als je " + game.CardShortNL(a) + " speelt."
		}
	}
	// The player's other cards, each on its own.
	for x := hand &^ bit(a) &^ bit(b); x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		g, ok := gain(won(c))
		consider(g, ok, cardLost(c))
	}
	// The two cards compared go together: one is played now and the other
	// later, so what one gains the other may lose. The sentence names the
	// one that gains, so that one must gain clearly and the other not lose
	// more than diffMin.
	wa, wb := won(a), won(b)
	if g, ok := gain(func(e playEvent) float64 { return wa(e) + wb(e) }); ok {
		ga, oka := gain(wa)
		gb, okb := gain(wb)
		c, okc, other := a, oka, gb
		if gb > ga {
			c, okc, other = b, okb, ga
		}
		consider(g, okc && other >= -diffMin, cardLost(c))
	}
	last := func(e playEvent) bool { return e.last }
	g, ok := gain(func(e playEvent) float64 {
		if e.last {
			return game.LastTrickBonus
		}
		return -game.LastTrickBonus
	})
	consider(g, ok, func() string {
		return "Jullie halen de laatste slag in " + percent(share(ea, last)) + " van de verdelingen als je " + game.CardShortNL(a) +
			" speelt, en in " + percent(share(eb, last)) + " als je " + game.CardShortNL(b) + " speelt."
	})
	// Roem in this trick, the opponents' and ours apart.
	theirs, ours := func(e playEvent) bool { return e.roem < 0 }, func(e playEvent) bool { return e.roem > 0 }
	ta, tb := share(ea, theirs), share(eb, theirs)
	g, ok = gain(func(e playEvent) float64 { return float64(min(e.roem, 0)) })
	consider(g, ok && wholePercent(tb) > wholePercent(ta), func() string {
		return "De tegenstanders maken roem in deze slag in " + percent(tb) + " van de verdelingen als je " + game.CardShortNL(b) +
			" speelt, en in " + percent(ta) + " als je " + game.CardShortNL(a) + " speelt."
	})
	oa, ob := share(ea, ours), share(eb, ours)
	g, ok = gain(func(e playEvent) float64 { return float64(max(e.roem, 0)) })
	consider(g, ok && wholePercent(oa) > wholePercent(ob), func() string {
		return "Jullie maken roem in deze slag in " + percent(oa) + " van de verdelingen als je " + game.CardShortNL(a) +
			" speelt, en in " + percent(ob) + " als je " + game.CardShortNL(b) + " speelt."
	})
	return text
}
