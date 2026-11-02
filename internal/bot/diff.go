package bot

import (
	"math"

	"klaverjas/internal/game"
)

// What two cards do differently (design §4.2). The value of a card says
// how much it brings, the parts in which tricks; neither says what happens.
// The search plays every card in the same deals, so per deal it keeps what
// a player can check at the table (playEvent): which of their own cards
// their team wins, who wins the last trick, and the roem in the card's own
// trick. diffWhy compares two cards on these and names the difference that
// brings the most points, when it is clear and large enough to be a reason:
// at least diffMin points on average and a quarter of the gap between the
// two cards, and with sampled deals at least two standard errors of the
// paired difference.

// diffMin is the least a difference in the playouts must bring on average
// for diffWhy to name it.
const diffMin = 2.0

// diffWhy is what playing a instead of b does differently, in one sentence,
// or "": gap is how much more a brings, ea and eb are their playouts in the
// same deals, w the weight of each deal (nil: sampled deals of equal
// weight, so a difference must also stand out from their noise; else every
// possible deal, weighted), hand the player's cards and trump the trump
// suit.
func diffWhy(a, b game.Card, gap float64, ea, eb []playEvent, w []float64, hand cardSet, trump game.Suit) string {
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
	// gain is the mean of f with a minus f with b, and whether it is clear.
	gain := func(f func(e playEvent) float64) (float64, bool) {
		var sw, s, s2 float64
		for k := range n {
			d := f(ea[k]) - f(eb[k])
			sw += weight(k)
			s += weight(k) * d
			s2 += weight(k) * d * d
		}
		if sw == 0 {
			return 0, false
		}
		mean := s / sw
		if mean < max(diffMin, gap/4) {
			return mean, false
		}
		if w == nil && n > 1 {
			se := math.Sqrt(max(s2/sw-mean*mean, 0) / float64(n-1))
			return mean, mean >= 2*se
		}
		return mean, true
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
	// The player's other cards, each on its own. The two cards compared go
	// together: one is played now and the other later, so what one gains
	// the other may lose.
	for x := hand &^ bit(a) &^ bit(b); x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		g, ok := gain(won(c))
		consider(g, ok, cardLost(c))
	}
	wa, wb := won(a), won(b)
	if g, ok := gain(func(e playEvent) float64 { return wa(e) + wb(e) }); ok {
		ga, _ := gain(wa)
		gb, _ := gain(wb)
		c := a
		if gb > ga {
			c = b
		}
		consider(g, ok, cardLost(c))
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
	g, ok = gain(func(e playEvent) float64 { return float64(e.roem) })
	consider(g, ok, func() string {
		theirs, ours := func(e playEvent) bool { return e.roem < 0 }, func(e playEvent) bool { return e.roem > 0 }
		less, _ := gain(func(e playEvent) float64 { return -float64(min(e.roem, 0)) })
		more, _ := gain(func(e playEvent) float64 { return float64(max(e.roem, 0)) })
		if more > -less {
			return "Jullie maken roem in deze slag in " + percent(share(ea, ours)) + " van de verdelingen als je " + game.CardShortNL(a) +
				" speelt, en in " + percent(share(eb, ours)) + " als je " + game.CardShortNL(b) + " speelt."
		}
		return "De tegenstanders maken roem in deze slag in " + percent(share(eb, theirs)) + " van de verdelingen als je " + game.CardShortNL(b) +
			" speelt, en in " + percent(share(ea, theirs)) + " als je " + game.CardShortNL(a) + " speelt."
	})
	return text
}
