package toepbot

import (
	"slices"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

// noCard: playout lets the rules of thumb choose every card.
var noCard = game.Card{Rank: game.NumRanks}

// normalCard is the rule-of-thumb card of hand for trick t, where in tells
// the seats still in the round. Only the last trick counts, so the best
// card is kept for it; the trick before it is worth winning with a card
// that is not the best, to lead the last one.
func normalCard(hand []game.Card, t toepen.Trick, in func(game.Seat) bool) game.Card {
	legal := toepen.Legal(hand, t)
	if len(legal) == 1 {
		return legal[0]
	}
	keep := strongest(hand)
	led, ok := t.Led()
	if !ok {
		// Lead low, from another suit than the card kept if possible.
		var other []game.Card
		for _, c := range legal {
			if c.Suit != keep.Suit {
				other = append(other, c)
			}
		}
		if len(other) > 0 {
			return weakest(other)
		}
		return weakest(without(legal, keep))
	}
	if legal[0].Suit != led {
		return weakest(legal) // cannot follow: throw the least useful card
	}
	if len(hand) == 2 {
		// The trick before the last: take it with the other card, then lead
		// the best.
		if w, ok := winningCard(t, in); ok {
			for _, c := range legal {
				if c != keep && toepen.Beats(c, w) {
					return c
				}
			}
		}
	}
	return weakest(without(legal, keep))
}

// winningCard is the card that wins t so far among the seats still in.
func winningCard(t toepen.Trick, in func(game.Seat) bool) (game.Card, bool) {
	s, ok := t.Winning(in)
	if !ok {
		return game.Card{}, false
	}
	for _, p := range t.Cards {
		if p.Seat == s {
			return p.Card, true
		}
	}
	return game.Card{}, false
}

func strongest(cs []game.Card) game.Card {
	best := cs[0]
	for _, c := range cs[1:] {
		if toepen.Strength(c.Rank) > toepen.Strength(best.Rank) {
			best = c
		}
	}
	return best
}

func weakest(cs []game.Card) game.Card {
	low := cs[0]
	for _, c := range cs[1:] {
		if toepen.Strength(c.Rank) < toepen.Strength(low.Rank) {
			low = c
		}
	}
	return low
}

// without is cs less the cards drop, or cs itself when that would leave
// nothing.
func without(cs []game.Card, drop ...game.Card) []game.Card {
	var out []game.Card
	for _, x := range cs {
		if !slices.Contains(drop, x) {
			out = append(out, x)
		}
	}
	if len(out) == 0 {
		return cs
	}
	return out
}

// playout plays the round of v on to its last trick in world w (the hidden
// hands; v.Seat holds v.Hand), every seat by the rules of thumb, v.Seat
// first playing first when that is a card and it is its turn. Nobody toeps
// or passes any more. It returns the seat that takes the last trick.
func playout(v *toepen.View, w *world, first game.Card) game.Seat {
	n := v.Players
	var hands [toepen.MaxPlayers][]game.Card
	for s := range game.Seat(n) {
		if !v.In(s) {
			continue
		}
		src := w[s]
		if s == v.Seat {
			src = v.Hand
		}
		hands[s] = append(make([]game.Card, 0, toepen.HandSize), src...)
	}
	in := v.In
	t := v.Current
	t.Cards = append(make([]game.Played, 0, n), t.Cards...)
	if len(t.Cards) == 0 && v.Phase != toepen.PhasePlay && len(v.Tricks) == 0 {
		t.Leader = v.Voorhand // before the first card
	}
	next := func() game.Seat {
		s := t.Leader
		if k := len(t.Cards); k > 0 {
			s = (t.Cards[k-1].Seat + 1) % game.Seat(n)
		}
		for range n {
			if in(s) && !t.Played(s) {
				return s
			}
			s = (s + 1) % game.Seat(n)
		}
		return game.NoSeat
	}
	for {
		s := next()
		if s == game.NoSeat {
			win, _ := t.Winning(in)
			if win == game.NoSeat || len(hands[win]) == 0 {
				return win
			}
			t = toepen.Trick{Leader: win, Cards: t.Cards[:0], Winner: game.NoSeat}
			continue
		}
		if len(hands[s]) == 0 { // a view that does not add up: stop here
			win, _ := t.Winning(in)
			return win
		}
		var c game.Card
		if s == v.Seat && first != noCard {
			c, first = first, noCard
		} else {
			c = normalCard(hands[s], t, in)
		}
		h := hands[s]
		for k, x := range h {
			if x == c {
				hands[s] = append(h[:k], h[k+1:]...)
				break
			}
		}
		t.Cards = append(t.Cards, game.Played{Seat: s, Card: c})
	}
}
