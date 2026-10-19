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

// Brain makes the decisions for one bot seat. The server calls one brain from
// one goroutine at a time.
type Brain interface {
	ChooseTrump(v game.View) game.Suit // utrechts, or forced (never v.Turned when v.Forced)
	Bid(v game.View) bool              // gedraaid: play on v.Turned?
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

// ChatEvent is something a bot may comment on (see bot.ChatEvent).
type ChatEvent struct {
	Kind   string
	Mine   bool
	Text   string
	Points int
}

// AI is what the server needs from the bot package; cmd/klaverjas adapts
// package bot to it, and tests use a fake.
type AI interface {
	Personas() []Persona
	// NewBrain returns a player for a persona at level "makkelijk", "normaal"
	// or "sterk". An empty personaID asks for a neutral player (substitutes).
	NewBrain(personaID, level string, seed uint64) Brain
	Advise(v game.View) Advice
	ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
	Chat(personaID string, ev ChatEvent, rng *rand.Rand) string
}
