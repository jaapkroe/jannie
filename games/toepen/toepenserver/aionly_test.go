package toepenserver

import (
	"slices"
	"sync"
	"testing"
	"time"

	"jannie/games/toepen/toepen"
	"jannie/platform/cards"
	"jannie/platform/server/servertest"
)

// gateBrain toeps on every turn and passes on every toep, so whoever
// toeps first wins the round and the others get a point each. Once seats
// 0 and 1 are out, it waits for gate before it toeps or plays a card: the
// match stands still while a test looks at the choice.
type gateBrain struct{ gate <-chan struct{} }

func (b gateBrain) wait(v toepen.View) {
	if v.Status[0] == toepen.StatusOut && v.Status[1] == toepen.StatusOut {
		<-b.gate
	}
}

func (b gateBrain) Was(toepen.View) bool      { return false }
func (b gateBrain) Check(toepen.View) bool    { return false }
func (b gateBrain) Overtoep(toepen.View) bool { return false }
func (b gateBrain) Answer(toepen.View) bool   { return false }
func (b gateBrain) Toep(v toepen.View) bool {
	b.wait(v)
	return true
}
func (b gateBrain) Discard(v toepen.View) []cards.Card { return v.Hand[len(v.Hand)-v.Lay:] }
func (b gateBrain) Play(v toepen.View) cards.Card {
	b.wait(v)
	return v.Legal[0]
}

// aiOnlyOf reads c's messages until the choice of only AI players left
// satisfies pred, and returns it.
func aiOnlyOf(t *testing.T, c *servertest.Client, what string, pred func(a *aiOnly) bool) *aiOnly {
	t.Helper()
	return untilToep(t, c, what, func(s *state) bool { return s.AIOnly != nil && pred(s.AIOnly) }).AIOnly
}

// passAlong plays for clients, who each pass on every toep and play their
// first legal card, until done has said so of an update of each. done
// sees every update, with the client's index.
func passAlong(t *testing.T, clients []*servertest.Client, done func(k int, m *servertest.Msg, s *state) bool) {
	t.Helper()
	ended := make([]bool, len(clients))
	sent := make([]string, len(clients))
	deadline := time.Now().Add(30 * time.Second)
	for slices.Contains(ended, false) {
		if time.Now().After(deadline) {
			t.Fatalf("not done: %v", ended)
		}
		busy := false
		for k, c := range clients {
			var last *servertest.Msg
			for m := c.Poll(); m != nil && !ended[k]; m = c.Poll() {
				busy = true
				if m.T == "error" {
					t.Fatalf("seat %d: error %s: %s", c.Seat, m.Code, m.ErrMsg())
				}
				if m.T == "update" {
					last = m
					ended[k] = done(k, m, toepS(t, m))
				}
			}
			if last == nil || ended[k] || string(last.S) == sent[k] {
				continue
			}
			switch s := toepS(t, last); {
			case s.Turn != s.You:
			case s.Phase == phaseToep:
				c.Send(map[string]any{"t": "answer", "play": false})
				sent[k] = string(last.S)
			case s.Phase == phasePlay && len(s.Legal) > 0:
				c.Send(map[string]any{"t": "play", "card": s.Legal[0].String()})
				sent[k] = string(last.S)
			}
		}
		if !busy {
			time.Sleep(time.Millisecond)
		}
	}
}

// aiOnlyOpts are the rules of the tests of the choice: nothing but toeps,
// passes and cards.
func aiOnlyOpts(players, seed int) map[string]any {
	return map[string]any{"players": players, "was": false, "armoede": false, "koning": false, "lijntoep": false, "seed": seed}
}

// TestToepenAIOnly: two people and two AI players; the people pass on
// every toep, so with this seed both are out with both AI players still
// in. From then on the state has aiOnly with everyone's choice. The match
// plays on fast only while everyone connected chose that: one who keeps
// watching holds the tempo, one who drops out no longer counts, and back
// at the table their choice counts again. Fast, the summary of a round,
// the last one too, takes a tenth of its time. A choice before or after
// is ignored, another word refused, and the match ends as any other.
func TestToepenAIOnly(t *testing.T) {
	gate := make(chan struct{})
	open := sync.OnceFunc(func() { close(gate) })
	defer open()
	srv := servertest.Start(t, New(&testAI{brain: func(string, uint64) Brain { return gateBrain{gate} }}))
	h := srv.Dial()
	h.Create("Jaap", aiOnlyOpts(4, 1), false)
	g := srv.Dial()
	g.Join(h.Code, "Kees", "")
	if h.Seat != 0 || g.Seat != 1 {
		t.Fatalf("seats %d and %d", h.Seat, g.Seat)
	}
	h.Send(map[string]any{"t": "start"})
	h.Send(map[string]any{"t": "aiOnly", "choice": choiceFast}) // too early: ignored
	token := g.Token
	passAlong(t, []*servertest.Client{h, g}, func(k int, m *servertest.Msg, s *state) bool {
		if s.Phase == "gameOver" {
			t.Fatalf("over with a person in it: points %v", s.Points)
		}
		if s.AIOnly == nil {
			return false
		}
		checkKeys(t, m, s)
		if s.Points[0] < 10 || s.Points[1] < 10 || s.Points[2] >= 10 || s.Points[3] >= 10 {
			t.Fatalf("seat %d: points %v", k, s.Points)
		}
		if a := s.AIOnly; a.Fast || len(a.Choice) != 4 || a.Choice[0] != "" || a.Choice[1] != "" {
			t.Errorf("seat %d: at first %+v", k, a)
		}
		return true
	})

	h.Send(map[string]any{"t": "aiOnly", "choice": "snel"})
	if m := h.WaitError("ongeldig"); m.ErrMsg() != "Kies versnellen of toekijken." {
		t.Errorf("another word: %q", m.ErrMsg())
	}
	choose := func(c *servertest.Client, choice string) {
		c.Send(map[string]any{"t": "aiOnly", "choice": choice})
	}
	chose := func(seat int, choice string) func(*aiOnly) bool {
		return func(a *aiOnly) bool { return a.Choice[seat] == choice }
	}
	choose(h, choiceFast)
	if a := aiOnlyOf(t, g, "Jaap's choice", chose(0, choiceFast)); a.Fast {
		t.Errorf("fast with one of two: %+v", a)
	}
	choose(g, choiceWatch)
	if a := aiOnlyOf(t, h, "Kees watches", chose(1, choiceWatch)); a.Fast {
		t.Errorf("fast while Kees watches: %+v", a)
	}
	choose(g, choiceFast)
	if a := aiOnlyOf(t, h, "Kees's choice", chose(1, choiceFast)); !a.Fast {
		t.Errorf("not fast with both: %+v", a)
	}
	choose(g, choiceWatch)
	aiOnlyOf(t, h, "Kees watches again", func(a *aiOnly) bool { return !a.Fast })
	g.Close()
	aiOnlyOf(t, h, "fast without Kees", func(a *aiOnly) bool { return a.Fast })
	g = srv.Dial()
	g.Join(h.Code, "Kees", token)
	if a := aiOnlyOf(t, h, "Kees back", func(a *aiOnly) bool { return !a.Fast }); a.Choice[1] != choiceWatch {
		t.Errorf("Kees back: %+v", a)
	}
	choose(g, choiceFast)
	aiOnlyOf(t, h, "fast with both again", func(a *aiOnly) bool { return a.Fast })

	// The AI players play on: the summary of every round, 4.5 s at this
	// tempo, takes a tenth of its scaled time, and the choice stays until
	// game over.
	open()
	var over *state
	for n := 0; over == nil; n++ {
		m := h.Until(10*time.Second, "the end of a round", func(m *servertest.Msg) bool {
			return m.EvType() == "handEnd" || m.EvType() == "gameOver"
		})
		s := toepS(t, m)
		if m.EvType() == "gameOver" {
			if n == 0 {
				t.Error("no round played fast")
			}
			over = s
			break
		}
		if left := time.Until(time.UnixMilli(s.NextAt)); left > 10*time.Millisecond {
			t.Errorf("fast: the summary takes %v", left)
		}
		if s.AIOnly == nil || !s.AIOnly.Fast {
			t.Errorf("in the summary: %+v", s.AIOnly)
		}
	}
	if over.AIOnly != nil || over.Winner < 2 {
		t.Errorf("over: aiOnly %+v, winner %d", over.AIOnly, over.Winner)
	}
	choose(h, choiceWatch) // too late: ignored
	h.Send(map[string]any{"t": "chat", "text": "hoi"})
	h.Until(5*time.Second, "the chat line", func(m *servertest.Msg) bool {
		if m.T == "error" {
			t.Errorf("a late choice: %s %s", m.Code, m.ErrMsg())
		}
		_, _, text, _, _ := m.Chat()
		return m.T == "chat" && text == "hoi"
	})
}

// TestToepenAIOnlyLastRound: the summary of the round that puts the one
// person out against one AI player, the last of the match, has no choice:
// nothing is left to play.
func TestToepenAIOnlyLastRound(t *testing.T) {
	srv := servertest.Start(t, New(&testAI{brain: func(string, uint64) Brain { return gateBrain{} }}))
	for seed := 1; ; seed++ {
		if seed > 20 {
			t.Fatal("the person won twenty matches")
		}
		h := srv.Dial()
		h.Create("Jaap", aiOnlyOpts(2, seed), true)
		var over *state
		passAlong(t, []*servertest.Client{h}, func(k int, m *servertest.Msg, s *state) bool {
			if s.AIOnly != nil {
				t.Fatalf("seed %d, %s: aiOnly %+v, points %v", seed, s.Phase, s.AIOnly, s.Points)
			}
			over = s
			return s.Phase == "gameOver"
		})
		if over.Winner == 1 {
			return
		}
	}
}
