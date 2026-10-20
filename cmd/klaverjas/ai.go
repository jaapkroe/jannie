package main

import (
	"math/rand/v2"

	"klaverjas/internal/bot"
	"klaverjas/internal/game"
	"klaverjas/internal/server"
)

// botAI adapts package bot to server.AI.
type botAI struct{}

// neutral plays for a human who is away: no character, average boldness.
var neutral = bot.Persona{ID: "", Name: "AI", Aggression: 0.5, Speed: 1}

func (botAI) Personas() []server.Persona {
	roster := bot.Roster()
	out := make([]server.Persona, len(roster))
	for i, p := range roster {
		out[i] = server.Persona{
			ID: p.ID, Name: p.Name, Emoji: p.Emoji, Color: p.Color, Bio: p.Bio,
			Chattiness: p.Chattiness, Speed: p.Speed,
		}
	}
	return out
}

func (botAI) NewBrain(personaID, level string, seed uint64) server.Brain {
	p, ok := bot.ByID(personaID)
	if !ok {
		p = neutral
	}
	lvl, _ := bot.ParseLevel(level)
	return bot.New(p, lvl, seed)
}

func (botAI) Advise(v game.View) server.Advice {
	a := bot.Advise(v)
	return server.Advice{Card: a.Card, Suit: a.Suit, Play: a.Play, Text: a.Text}
}

func (botAI) ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string {
	return bot.ExplainTrick(t, trump, names)
}

func (botAI) Chat(personaID string, ev server.ChatEvent, rng *rand.Rand) string {
	p, ok := bot.ByID(personaID)
	if !ok {
		return ""
	}
	return bot.Chat(p, bot.ChatEvent{Kind: ev.Kind, Mine: ev.Mine, Text: ev.Text, Points: ev.Points,
		InHand: ev.InHand, Playing: ev.Playing}, rng)
}
