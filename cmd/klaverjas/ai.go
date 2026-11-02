package main

import (
	"math/rand/v2"

	"klaverjas/internal/bot"
	"klaverjas/internal/game"
	"klaverjas/internal/server"
	"klaverjas/internal/toepbot"
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

func (botAI) Grade(v game.View, c server.Choice) server.Grade {
	g := bot.GradeChoice(v, bot.Choice{Card: c.Card, Suit: c.Suit, Play: c.Play})
	return server.Grade{
		Stake: g.Stake, Lost: g.Lost, Gain: g.Gain, Text: g.Text, Nat: g.Nat,
		Better:  server.Choice{Card: g.Better.Card, Suit: g.Better.Suit, Play: g.Better.Play},
		Obvious: server.Choice{Card: g.Obvious.Card, Suit: g.Obvious.Suit, Play: g.Obvious.Play},
		Played:  server.Outcome(g.Played),
		Other:   server.Outcome(g.Other),
	}
}

func (botAI) HandLuck(v game.View) float64 { return bot.HandLuck(v) }

func (botAI) Explain(v game.View) server.Explanation {
	e := bot.Explain(v)
	choice := func(c bot.Choice) server.Choice { return server.Choice{Card: c.Card, Suit: c.Suit, Play: c.Play} }
	out := server.Explanation{
		Normaal: choice(e.Normaal), Rule: e.Rule, Sterk: choice(e.Sterk), SterkWhy: e.SterkWhy,
		Hint: choice(e.Hint), HintText: e.HintText, HintWhy: e.HintWhy, Worlds: e.Worlds,
	}
	for _, o := range e.Options {
		out.Options = append(out.Options, server.Option{
			Choice: choice(o.Choice), Value: o.Value, SE: o.SE, Outcome: server.Outcome(o.Outcome), Parts: o.Parts,
		})
	}
	return out
}

func (botAI) ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string {
	return bot.ExplainTrick(t, trump, names)
}

func (botAI) TrickSignals(v game.View) []server.Signal {
	var out []server.Signal
	for _, s := range bot.TrickSignals(v) {
		out = append(out, server.Signal(s))
	}
	return out
}

func (botAI) SignalChance(v game.View, prefer game.Card) (server.Signal, bool) {
	s, ok := bot.SignalChance(v, prefer)
	return server.Signal(s), ok
}

func (botAI) Chat(personaID string, ev server.ChatEvent, rng *rand.Rand) string {
	p, ok := bot.ByID(personaID)
	if !ok {
		return ""
	}
	return bot.Chat(p, bot.ChatEvent{Kind: ev.Kind, Mine: ev.Mine, Text: ev.Text, Points: ev.Points,
		InHand: ev.InHand, Playing: ev.Playing}, rng)
}

// toepAI adapts package toepbot to server.ToepAI, with the personas of
// package bot: their aggression is how boldly they toep, go along and
// bluff a was.
type toepAI struct{}

func (toepAI) NewToepBrain(personaID, level string, seed uint64) server.ToepBrain {
	p, ok := bot.ByID(personaID)
	if !ok {
		p = neutral
	}
	return toepbot.New(p.Aggression, toepbot.ParseLevel(level), seed)
}

func (toepAI) ToepChat(personaID string, ev server.ChatEvent, rng *rand.Rand) string {
	p, ok := bot.ByID(personaID)
	if !ok {
		return ""
	}
	return toepbot.Chat(p.ID, p.Chattiness, toepbot.ChatEvent{Kind: ev.Kind, Mine: ev.Mine, Text: ev.Text, Points: ev.Points}, rng)
}
