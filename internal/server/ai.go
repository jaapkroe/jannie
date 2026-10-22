package server

import (
	"math/rand/v2"

	"klaverjas/internal/game"
)

// Persona is a bot character as the server needs it. Name is without "(AI)";
// the server adds that suffix for display.
type Persona struct {
	ID, Name, Emoji, Color, Bio string
	Chattiness                  float64 // 0..1, scales how often the bot chats
	Speed                       float64 // multiplier on think time
}

// Brain makes the decisions for one bot seat, at a table of v.Players. The
// server calls one brain from one goroutine at a time.
type Brain interface {
	ChooseTrump(v game.View) game.Suit // utrechts, forced (never v.Turned when v.Forced), or the soloist
	Bid(v game.View) bool              // gedraaid: play on v.Turned?
	Auction(v game.View) int           // three players: a bid of at least v.MinNextBid(), or 0 to pass
	Discard(v game.View) [2]game.Card  // three players: two cards of v.Hand for the soloist to lay away
	Play(v game.View) game.Card        // one of v.Legal
}

// Advice is a training hint: one of Card, Suit or Play is set, with a Dutch
// explanation.
type Advice struct {
	Card *game.Card
	Suit *game.Suit
	Play *bool
	Text string
}

// Choice is one decision of a player: exactly one of Card, Suit or Play is
// set.
type Choice struct {
	Card *game.Card
	Suit *game.Suit
	Play *bool
}

// Grade is the analysis of one decision for the review at the end of the
// match (see bot.Grade): points are expected score differences.
type Grade struct {
	Stake  float64 // between the best and the worst option; 0 without a choice
	Lost   float64 // given up against Better; 0 within the noise
	Gain   float64 // a strong choice: gained over the rule-based choice
	Better Choice  // the advised option, when Lost > 0
	Text   string  // the hint for Better (Lost > 0) or for the choice (Gain > 0)
	Nat    float64 // a bid to play: the chance of going nat
}

// ChatEvent is something a bot may comment on (see bot.ChatEvent).
type ChatEvent struct {
	Kind            string
	Mine            bool
	Text            string
	Points          int
	InHand, Playing bool // for "reply": tricks are being played; the bot's team made trump
}

// AI is what the server needs from the bot package; cmd/klaverjas adapts
// package bot to it, and tests use a fake.
type AI interface {
	Personas() []Persona
	// NewBrain returns a player for a persona at level "makkelijk", "normaal"
	// or "sterk". An empty personaID asks for a neutral player (substitutes).
	NewBrain(personaID, level string, seed uint64) Brain
	Advise(v game.View) Advice
	// Grade analyses decision c of the player of v, on their turn, and
	// HandLuck what the cards dealt to the player of v are worth against an
	// average hand (v is the view at the deal); both for the review at the
	// end of the match.
	Grade(v game.View, c Choice) Grade
	HandLuck(v game.View) float64
	ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
	Chat(personaID string, ev ChatEvent, rng *rand.Rand) string
}
