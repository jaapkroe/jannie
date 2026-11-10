package toepbot

import (
	"slices"

	"jannie/games/toepen/toepen"
	"jannie/platform/cards"
)

// noCard: playout lets the rules of thumb choose every card.
var noCard = cards.Card{Rank: cards.NumRanks}

// normalCard is the rule-of-thumb card of hand for trick t, where in tells
// the seats still in the round. Only the last trick counts, so the best
// card is kept for it; the trick before it is worth winning with a card
// that is not the best, to lead the last one.
func normalCard(hand []cards.Card, t toepen.Trick, in func(cards.Seat) bool) cards.Card {
	legal := toepen.Legal(hand, t)
	if len(legal) == 1 {
		return legal[0]
	}
	keep := strongest(hand)
	led, ok := t.Led()
	if !ok {
		// Lead low, from another suit than the card kept if possible.
		var other []cards.Card
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
func winningCard(t toepen.Trick, in func(cards.Seat) bool) (cards.Card, bool) {
	s, ok := t.Winning(in)
	if !ok {
		return cards.Card{}, false
	}
	for _, p := range t.Cards {
		if p.Seat == s {
			return p.Card, true
		}
	}
	return cards.Card{}, false
}

func strongest(cs []cards.Card) cards.Card {
	best := cs[0]
	for _, c := range cs[1:] {
		if toepen.Strength(c.Rank) > toepen.Strength(best.Rank) {
			best = c
		}
	}
	return best
}

func weakest(cs []cards.Card) cards.Card {
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
func without(cs []cards.Card, drop ...cards.Card) []cards.Card {
	var out []cards.Card
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
func playout(v *toepen.View, w *world, first cards.Card) cards.Seat {
	n := v.Players
	var hands [toepen.MaxPlayers][]cards.Card
	for s := range cards.Seat(n) {
		if !v.In(s) {
			continue
		}
		src := w[s]
		if s == v.Seat {
			src = v.Hand
		}
		hands[s] = append(make([]cards.Card, 0, toepen.HandSize), src...)
	}
	in := v.In
	t := v.Current
	t.Cards = append(make([]cards.Played, 0, n), t.Cards...)
	if len(t.Cards) == 0 && v.Phase != toepen.PhasePlay && len(v.Tricks) == 0 {
		t.Leader = v.FirstLeader // before the first card
	}
	next := func() cards.Seat {
		s := t.Leader
		if k := len(t.Cards); k > 0 {
			s = (t.Cards[k-1].Seat + 1) % cards.Seat(n)
		}
		for range n {
			if in(s) && !t.Played(s) {
				return s
			}
			s = (s + 1) % cards.Seat(n)
		}
		return cards.NoSeat
	}
	for {
		s := next()
		if s == cards.NoSeat {
			win, _ := t.Winning(in)
			if win == cards.NoSeat || len(hands[win]) == 0 {
				return win
			}
			t = toepen.Trick{Leader: win, Cards: t.Cards[:0], Winner: cards.NoSeat}
			continue
		}
		if len(hands[s]) == 0 { // a view that does not add up: stop here
			win, _ := t.Winning(in)
			return win
		}
		var c cards.Card
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
		t.Cards = append(t.Cards, cards.Played{Seat: s, Card: c})
	}
}
