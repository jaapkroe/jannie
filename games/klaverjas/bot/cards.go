package bot

import (
	"math/bits"

	"jannie/games/klaverjas/game"
)

// cardSet is a set of cards as a bitmask over game.Card.Index (suit-major,
// eight bits per suit).
type cardSet uint32

const allCards cardSet = 1<<32 - 1

func bit(c game.Card) cardSet { return 1 << uint(c.Index()) }

func suitSet(s game.Suit) cardSet { return 0xFF << (uint(s) * 8) }

func setOf(cards []game.Card) cardSet {
	var s cardSet
	for _, c := range cards {
		s |= bit(c)
	}
	return s
}

func (s cardSet) has(c game.Card) bool { return s&bit(c) != 0 }

func (s cardSet) count() int { return bits.OnesCount32(uint32(s)) }

func (s cardSet) inSuit(su game.Suit) cardSet { return s & suitSet(su) }

func (s cardSet) countSuit(su game.Suit) int { return s.inSuit(su).count() }

// appendCards appends the cards of s to dst in index order.
func (s cardSet) appendCards(dst []game.Card) []game.Card {
	for s != 0 {
		i := bits.TrailingZeros32(uint32(s))
		dst = append(dst, game.CardFromIndex(i))
		s &= s - 1
	}
	return dst
}

// Ranks from high to low, in trump and in plain order.
var (
	trumpHighToLow = [game.NumRanks]game.Rank{game.Jack, game.Nine, game.Ace, game.Ten, game.King, game.Queen, game.Eight, game.Seven}
	plainHighToLow = [game.NumRanks]game.Rank{game.Ace, game.Ten, game.King, game.Queen, game.Jack, game.Nine, game.Eight, game.Seven}
)

// above[t][r] is the 8-bit rank mask of ranks stronger than r, in trump
// order (t=1) or plain order (t=0).
var above [2][game.NumRanks]uint8

func init() {
	for r := game.Rank(0); r < game.NumRanks; r++ {
		for o := game.Rank(0); o < game.NumRanks; o++ {
			if game.PlainOrder(o) > game.PlainOrder(r) {
				above[0][r] |= 1 << o
			}
			if game.TrumpOrder(o) > game.TrumpOrder(r) {
				above[1][r] |= 1 << o
			}
		}
	}
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// higher returns the cards of s in c's suit that beat c within that suit.
func (s cardSet) higher(c game.Card, trump game.Suit) cardSet {
	m := cardSet(above[b2i(c.Suit == trump)][c.Rank]) << (uint(c.Suit) * 8)
	return s & m
}

// lower returns the cards of s in c's suit that c beats within that suit.
func (s cardSet) lower(c game.Card, trump game.Suit) cardSet {
	return s.inSuit(c.Suit) &^ s.higher(c, trump) &^ bit(c)
}

// top returns the strongest card of s in suit su.
func (s cardSet) top(su game.Suit, trump game.Suit) (game.Card, bool) {
	order := &plainHighToLow
	if su == trump {
		order = &trumpHighToLow
	}
	for _, r := range order {
		if c := (game.Card{Rank: r, Suit: su}); s.has(c) {
			return c, true
		}
	}
	return game.Card{}, false
}

// bottom returns the weakest card of s in suit su.
func (s cardSet) bottom(su game.Suit, trump game.Suit) (game.Card, bool) {
	order := &plainHighToLow
	if su == trump {
		order = &trumpHighToLow
	}
	for i := len(order) - 1; i >= 0; i-- {
		if c := (game.Card{Rank: order[i], Suit: su}); s.has(c) {
			return c, true
		}
	}
	return game.Card{}, false
}

func jackOf(s game.Suit) game.Card { return game.Card{Rank: game.Jack, Suit: s} }
func nineOf(s game.Suit) game.Card { return game.Card{Rank: game.Nine, Suit: s} }
func aceOf(s game.Suit) game.Card  { return game.Card{Rank: game.Ace, Suit: s} }
func tenOf(s game.Suit) game.Card  { return game.Card{Rank: game.Ten, Suit: s} }
