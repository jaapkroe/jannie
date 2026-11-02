package toepenserver

import (
	"math/rand/v2"

	"klaverjas/internal/game"
	"klaverjas/internal/persona"
	"klaverjas/internal/server"
	"klaverjas/internal/toepen"
)

// plainAI is the AI of New(nil): the personas of package persona without
// bios, whose brains play the first legal card, never toep or claim a was,
// always go along, and who say nothing.
type plainAI struct{}

func (plainAI) Personas() []server.Persona {
	var out []server.Persona
	for _, p := range persona.All() {
		out = append(out, server.Persona{ID: p.ID, Name: p.Name, Emoji: p.Emoji, Color: p.Color,
			Chattiness: p.Chattiness, Speed: p.Speed})
	}
	return out
}

func (plainAI) NewBrain(string, string, uint64) Brain { return plainBrain{} }

func (plainAI) Chat(string, server.ChatEvent, *rand.Rand) string { return "" }

type plainBrain struct{}

func (plainBrain) Was(toepen.View) bool         { return false }
func (plainBrain) Check(toepen.View) bool       { return false }
func (plainBrain) Toep(toepen.View) bool        { return false }
func (plainBrain) Overtoep(toepen.View) bool    { return false }
func (plainBrain) Answer(toepen.View) bool      { return true }
func (plainBrain) Play(v toepen.View) game.Card { return safe(v).card }
