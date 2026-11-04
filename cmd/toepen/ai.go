package main

import (
	"math"
	"math/rand/v2"

	"jannie/games/toepen/toepbot"
	"jannie/games/toepen/toepen"
	"jannie/games/toepen/toepenserver"
	"jannie/platform/persona"
	"jannie/platform/server"
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

// Explain is toepbot's reasoning for a decision, rounded for the wire:
// shares to thousandths, points to tenths.
func (toepAI) Explain(v toepen.View, seed uint64) toepenserver.Explanation {
	e := toepbot.Explain(v, seed)
	out := toepenserver.Explanation{Decision: e.Decision, Advice: e.Advice, Why: e.Why, Rule: e.Rule, RuleCard: e.RuleCard,
		Chance: math.Round(1000*e.Chance) / 1000, Worlds: e.Worlds, Options: []toepenserver.WhyOption{}}
	for _, o := range e.Options {
		x := math.Round(1000*o.Value) / 1000
		if o.Value < 0 {
			x = -1
		} else if o.Points {
			x = math.Round(10*o.Value) / 10
		}
		out.Options = append(out.Options, toepenserver.WhyOption{Label: o.Label, Cards: o.Cards, Value: x, Points: o.Points, Best: o.Best})
	}
	return out
}

func (toepAI) Chat(personaID string, ev server.ChatEvent, rng *rand.Rand) string {
	p, ok := persona.ByID(personaID)
	if !ok {
		return ""
	}
	return toepbot.Chat(p.ID, p.Chattiness, toepbot.ChatEvent{Kind: ev.Kind, Mine: ev.Mine, Text: ev.Text, Points: ev.Points}, rng)
}
