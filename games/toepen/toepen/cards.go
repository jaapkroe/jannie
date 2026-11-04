// Package toepen is the rules engine of Toepen (docs/design.md §11): a pure
// state machine for one round ("potje") and the bookkeeping of a match that
// goes on until one player is left. It plays with the 32 cards of package
// game, under the same codes on the wire ("TH" = harten 10), with an order
// of its own within a suit, no trump, and only the last trick counting.
package toepen

import (
	"fmt"
	"math/rand/v2"
	"slices"

	"jannie/platform/cards"
)

const (
	// MaxPlayers is the largest table: four cards each from 32.
	MaxPlayers = 8
	// HandSize is the number of cards dealt to each player, and so the
	// number of tricks in a round; and the cards of a was.
	HandSize = 4
	// KoningSize is the hand played in the koningsspel, KoningDeal the
	// cards dealt for it (each lays the rest away, face down), both when
	// the deck holds them for everyone left.
	KoningSize = 8
	KoningDeal = 11
	// DefaultLimit is the number of penalty points that puts a player out.
	DefaultLimit = 10
)

// strength is the order within a suit, 0 (lowest) .. 7 (highest): boer,
// vrouw, heer, aas, 7, 8, 9, 10.
var strength = [cards.NumRanks]int8{
	cards.Jack: 0, cards.Queen: 1, cards.King: 2, cards.Ace: 3,
	cards.Seven: 4, cards.Eight: 5, cards.Nine: 6, cards.Ten: 7,
}

// Strength is the place of rank r in the order of a suit, 0 (boer) .. 7
// (10).
func Strength(r cards.Rank) int { return int(strength[r]) }

// Beats reports whether a beats b: the same suit and higher. A card of
// another suit than the one led never wins, so it beats nothing.
func Beats(a, b cards.Card) bool { return a.Suit == b.Suit && strength[a.Rank] > strength[b.Rank] }

// Plaatje reports whether r is one of the four lowest ranks, the pictures
// of a was: boer, vrouw, heer and aas.
func Plaatje(r cards.Rank) bool { return strength[r] < strength[cards.Seven] }

// Shuffle returns the 32 cards in an order drawn from rng.
func Shuffle(rng *rand.Rand) []cards.Card {
	deck := cards.NewDeck()
	rng.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })
	return deck
}

// SortHand orders a hand for display: suits alternating in colour, each
// suit from low to high in the order of toepen.
func SortHand(hand []cards.Card) []cards.Card {
	out := slices.Clone(hand)
	// Clubs, hearts, spades, diamonds: black and red alternate.
	place := [cards.NumSuits]int{cards.Clubs: 0, cards.Hearts: 1, cards.Spades: 2, cards.Diamonds: 3}
	slices.SortFunc(out, func(a, b cards.Card) int {
		if a.Suit != b.Suit {
			return place[a.Suit] - place[b.Suit]
		}
		return Strength(a.Rank) - Strength(b.Rank)
	})
	return out
}

// WasKind is what a hand of four is, for the rule of the was.
type WasKind uint8

const (
	NoWas WasKind = iota
	Witte         // four pictures: boer, vrouw, heer or aas
	Vuile         // three pictures and a 7
)

// Was tells whether hand is a was, and which.
func Was(hand []cards.Card) WasKind {
	if len(hand) != HandSize {
		return NoWas
	}
	pictures, sevens := 0, 0
	for _, c := range hand {
		switch {
		case Plaatje(c.Rank):
			pictures++
		case c.Rank == cards.Seven:
			sevens++
		}
	}
	switch {
	case pictures == 4:
		return Witte
	case pictures == 3 && sevens == 1:
		return Vuile
	}
	return NoWas
}

// NameNL is the Dutch name: "witte was", "vuile was", "" for none.
func (k WasKind) NameNL() string {
	switch k {
	case Witte:
		return "witte was"
	case Vuile:
		return "vuile was"
	}
	return ""
}

// String is the wire code: "witte", "vuile", "".
func (k WasKind) String() string {
	switch k {
	case Witte:
		return "witte"
	case Vuile:
		return "vuile"
	}
	return ""
}

// MarshalText writes the wire code.
func (k WasKind) MarshalText() ([]byte, error) { return []byte(k.String()), nil }

// UnmarshalText reads the wire code.
func (k *WasKind) UnmarshalText(b []byte) error {
	for _, w := range []WasKind{NoWas, Witte, Vuile} {
		if string(b) == w.String() {
			*k = w
			return nil
		}
	}
	return fmt.Errorf("toepen: unknown was %q", b)
}

// Trick is one trick of a round. A player who passes on a toep after
// playing to the trick leaves the card on the table, but it no longer
// counts (Winner).
type Trick struct {
	Leader cards.Seat     `json:"leader"`
	Cards  []cards.Played `json:"cards"`
	Winner cards.Seat     `json:"winner"` // NoSeat until the trick is complete
}

// Led returns the suit of the first card, false for an empty trick.
func (t Trick) Led() (cards.Suit, bool) {
	if len(t.Cards) == 0 {
		return 0, false
	}
	return t.Cards[0].Card.Suit, true
}

// Played reports whether seat has a card in the trick.
func (t Trick) Played(seat cards.Seat) bool {
	for _, p := range t.Cards {
		if p.Seat == seat {
			return true
		}
	}
	return false
}

// Winning returns the seat whose card wins t so far among the seats for
// which in is true: the highest card of the suit led. When nobody still in
// followed it (the leader passed), the suit of the first card of a seat
// still in decides. False when no seat still in has played.
func (t Trick) Winning(in func(cards.Seat) bool) (cards.Seat, bool) {
	led, ok := t.Led()
	if !ok {
		return cards.NoSeat, false
	}
	best := -1
	for k, p := range t.Cards {
		if in(p.Seat) && p.Card.Suit == led && (best < 0 || Beats(p.Card, t.Cards[best].Card)) {
			best = k
		}
	}
	if best < 0 {
		for k, p := range t.Cards {
			if !in(p.Seat) {
				continue
			}
			if best < 0 || Beats(p.Card, t.Cards[best].Card) {
				best = k
			}
		}
	}
	if best < 0 {
		return cards.NoSeat, false
	}
	return t.Cards[best].Seat, true
}

// Legal returns the cards of hand that may go into trick t: a card of the
// suit led when the hand holds one, else any card; any card leads.
func Legal(hand []cards.Card, t Trick) []cards.Card {
	led, ok := t.Led()
	if !ok {
		return slices.Clone(hand)
	}
	var out []cards.Card
	for _, c := range hand {
		if c.Suit == led {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return slices.Clone(hand)
	}
	return out
}

// IsLegal reports whether c, which must be in hand, may go into t.
func IsLegal(c cards.Card, hand []cards.Card, t Trick) bool {
	led, ok := t.Led()
	if !ok || c.Suit == led {
		return true
	}
	for _, h := range hand {
		if h.Suit == led {
			return false
		}
	}
	return true
}

// Constraint is the short Dutch rule shown above the hand on a turn.
func Constraint(hand []cards.Card, t Trick) string {
	led, ok := t.Led()
	switch {
	case !ok:
		return "Je komt uit: speel wat je wilt"
	case slices.ContainsFunc(hand, func(c cards.Card) bool { return c.Suit == led }):
		return "Bekennen: speel " + led.Symbol()
	}
	return "Je kunt niet bekennen: vrije keuze (die kaart wint niet)"
}

// ExplainIllegal says why c may not go into t (Dutch), "" when it may.
func ExplainIllegal(c cards.Card, hand []cards.Card, t Trick) string {
	if !slices.Contains(hand, c) {
		return "Die kaart heb je niet."
	}
	if IsLegal(c, hand, t) {
		return ""
	}
	led, _ := t.Led()
	return "Je moet bekennen (" + led.Symbol() + ")."
}
