package main

import (
	"math/rand/v2"

	"klaverjas/internal/persona"
	"klaverjas/internal/server"
	"klaverjas/internal/toepbot"
	"klaverjas/internal/toepenserver"
)

// toepAI adapts package toepbot to toepenserver.AI, with the personas of
// package persona and toepen's bios: a persona's aggression is how boldly
// it toeps, goes along and bluffs a was.
type toepAI struct{}

// neutral plays for a human who is away: no character, average boldness.
var neutral = persona.Persona{ID: "", Name: "AI", Aggression: 0.5, Speed: 1}

func (toepAI) Personas() []server.Persona {
	var out []server.Persona
	for _, p := range persona.All() {
		out = append(out, server.Persona{
			ID: p.ID, Name: p.Name, Emoji: p.Emoji, Color: p.Color, Bio: toepbot.Bio(p.ID),
			Chattiness: p.Chattiness, Speed: p.Speed,
		})
	}
	return out
}

func (toepAI) NewBrain(personaID, level string, seed uint64) toepenserver.Brain {
	p, ok := persona.ByID(personaID)
	if !ok {
		p = neutral
	}
	return toepbot.New(p.Aggression, toepbot.ParseLevel(level), seed)
}

func (toepAI) Chat(personaID string, ev server.ChatEvent, rng *rand.Rand) string {
	p, ok := persona.ByID(personaID)
	if !ok {
		return ""
	}
	return toepbot.Chat(p.ID, p.Chattiness, toepbot.ChatEvent{Kind: ev.Kind, Mine: ev.Mine, Text: ev.Text, Points: ev.Points}, rng)
}
