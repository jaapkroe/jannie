package main

import (
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"jannie/games/toepen/toepen"
	"jannie/games/toepen/toepenserver"
	"jannie/platform/cards"
	"jannie/platform/server"
)

// TestToepAI plays matches with the real bots through the adapter.
func TestToepAI(t *testing.T) {
	var ai toepenserver.AI = toepAI{}
	personas := ai.Personas()
	if len(personas) != 8 || !slices.ContainsFunc(personas, func(p server.Persona) bool { return p.ID == "jannie" }) {
		t.Fatalf("personas %+v", personas)
	}
	for _, p := range personas {
		if p.Name == "" || p.Emoji == "" || p.Color == "" || p.Bio == "" || p.Speed <= 0 || strings.HasSuffix(p.Name, "(AI)") ||
			strings.Contains(p.Bio, "roem") || strings.Contains(p.Bio, "De Klaver") {
			t.Errorf("persona %+v", p)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for k, level := range []string{"makkelijk", "normaal", "sterk", ""} {
		players := 2 + k
		brains := make([]toepenserver.Brain, players)
		for i := range brains {
			id := ""
			if level != "" {
				id = personas[(k+i)%len(personas)].ID
			}
			brains[i] = ai.NewBrain(id, level, uint64(k*8+i))
		}
		m := toepen.NewMatch(players, toepen.DefaultRules, 0)
		for rounds := 0; !m.Over(); rounds++ {
			if rounds > 200 {
				t.Fatalf("level %q: the match does not end", level)
			}
			d := m.Deal(toepen.Shuffle(rng))
			for steps := 0; d.Phase() != toepen.PhaseDone; steps++ {
				if steps > 500 {
					t.Fatalf("level %q: the round does not end", level)
				}
				if err := decide(d, brains); err != nil {
					t.Fatalf("level %q: %v", level, err)
				}
			}
			m.Settle(d)
		}
	}
	if line := ai.Chat("bestaat-niet", server.ChatEvent{Kind: "greet"}, rng); line != "" {
		t.Errorf("unknown persona chats: %q", line)
	}
	said := false
	for range 50 {
		said = said || ai.Chat("truus", server.ChatEvent{Kind: "toep", Mine: true}, rng) != ""
	}
	if !said {
		t.Error("Tante Truus never toeps out loud")
	}
}

// decide applies the decision of the brain whose answer the round of d
// awaits (or of every seat in the time for a was): the cards laid away in
// the koningsspel, a vuile was, a check, an overtoep or an answer, a toep
// or a card.
func decide(d *toepen.Deal, brains []toepenserver.Brain) error {
	switch d.Phase() {
	case toepen.PhaseWas:
		for s := range cards.Seat(d.Players()) {
			if d.Status(s) == toepen.StatusIn && !d.Answered(s) {
				v := d.View(s)
				if err := d.Was(s, v.CanClaim && brains[s].Was(v)); err != nil || d.Phase() != toepen.PhaseWas {
					return err
				}
			}
		}
		d.CloseWas()
	case toepen.PhaseCheck:
		s := d.Turn()
		_, err := d.Check(s, brains[s].Check(d.View(s)))
		return err
	case toepen.PhaseDiscard:
		s := d.Turn()
		return d.Discard(s, brains[s].Discard(d.View(s)))
	case toepen.PhaseToep:
		s := d.Turn()
		if v := d.View(s); v.CanRaise && brains[s].Overtoep(v) {
			return d.Overtoep(s)
		}
		return d.Answer(s, brains[s].Answer(d.View(s)))
	case toepen.PhasePlay:
		s := d.Turn()
		v := d.View(s)
		if v.CanToep && brains[s].Toep(v) {
			return d.Toep(s)
		}
		return d.Play(s, brains[s].Play(v))
	}
	return nil
}
