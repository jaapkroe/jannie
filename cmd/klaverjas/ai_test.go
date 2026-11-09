package main

import (
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"jannie/games/klaverjas/game"
	"jannie/platform/server"
)

// TestBotAI plays deals with the real bots through the adapter.
func TestBotAI(t *testing.T) {
	var ai server.AI = botAI{}
	personas := ai.Personas()
	if len(personas) != 8 || !slices.ContainsFunc(personas, func(p server.Persona) bool { return p.ID == "jannie" }) {
		t.Fatalf("personas %+v", personas)
	}
	for _, p := range personas {
		if p.Name == "" || p.Emoji == "" || p.Color == "" || p.Bio == "" || p.Speed <= 0 || strings.HasSuffix(p.Name, "(AI)") {
			t.Errorf("persona %+v", p)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for k, level := range []string{"makkelijk", "normaal", "sterk", ""} {
		id := ""
		if level != "" {
			id = personas[k].ID
		}
		var brains [4]server.Brain
		for i := range brains {
			brains[i] = ai.NewBrain(id, level, uint64(k*4+i))
		}
		mode := game.TrumpMode(k % 2)
		d := game.NewDeal(game.Seat(k%4), game.Shuffle(rng), mode, game.Rules(k/2%2), game.Suit(k))
		if l := ai.HandLuck(d.View(0)); l == 0 || math.Abs(l) > 200 {
			t.Errorf("hand luck %v", l)
		}
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			var err error
			switch d.Phase() {
			case game.PhaseTrump:
				if a := ai.Advise(v); a.Suit == nil || a.Text == "" {
					t.Errorf("trump advice %+v", a)
				}
				err = d.ChooseTrump(s, brains[s].ChooseTrump(v))
			case game.PhaseBid:
				err = d.Bid(s, brains[s].Bid(v))
			case game.PhasePlay:
				a := ai.Advise(v)
				if a.Card == nil || !slices.Contains(v.Legal, *a.Card) {
					t.Errorf("play advice %+v for legal %v", a, v.Legal)
				}
				c := brains[s].Play(v)
				if g := ai.Grade(v, server.Choice{Card: &c}); g.Lost > 0 && (g.Better.Card == nil || *g.Better.Card != *a.Card || g.Text != a.Text) {
					t.Errorf("grade %+v of %v, advice %+v", g, c, a)
				}
				err = d.Play(s, c)
				if tr := d.Current(); tr.Complete() {
					if text := ai.ExplainTrick(tr, v.Trump, [4]string{"jij", "Opa Dirk (AI)", "Juf Jannie (AI)", "Bram (AI)"}); text == "" {
						t.Errorf("no explanation for trick %+v", tr)
					}
				}
			}
			if err != nil {
				t.Fatalf("level %q: %v", level, err)
			}
		}
	}
	if line := ai.Chat("bestaat-niet", server.ChatEvent{Kind: "greet"}, rng); line != "" {
		t.Errorf("unknown persona chats: %q", line)
	}
	said := false
	for range 50 {
		said = said || ai.Chat("truus", server.ChatEvent{Kind: "greet"}, rng) != ""
	}
	if !said {
		t.Error("Tante Truus never greets")
	}
}
