package toepenserver

import (
	"errors"

	"jannie/games/toepen/toepen"
	"jannie/platform/cards"
	"jannie/platform/server"
)

// Only AI players left (games/toepen/README.md#only-ai-players-left):
// once every seat still in the match is played by a bot, the people at
// the table, all out, each choose to have the rest played out fast or to
// keep watching.

// fastSpeed is how many times faster the match plays on once everyone at
// the table chose that.
const fastSpeed = 10

// The choices of someone at the table while only AI players play on.
const (
	choiceFast  = "fast"  // play the rest out fast
	choiceWatch = "watch" // keep watching at the table's tempo
)

// aiOnly is s.aiOnly: per seat the choice made ("" for none), and whether
// the match plays on fast now.
type aiOnly struct {
	Choice []string `json:"choice"`
	Fast   bool     `json:"fast"`
}

// aiOnly reports whether only AI players play on: the match is not over
// and a bot plays every seat still in it. A seat the game waits for (its
// player dropped out or left, and no AI took over yet) is none. It holds
// through the summary of the last round when only bots played that round;
// the last round of a person is no time for the choice.
func (p *play) aiOnly() bool {
	if p.m == nil || p.d == nil || p.winner >= 0 {
		return false
	}
	last := p.m.Over()
	for s := range cards.Seat(p.t.Players()) {
		in := p.m.Alive(s)
		if last {
			in = p.d.Status(s) != toepen.StatusOut
		}
		if in && !p.t.BotPlays(s) {
			return false
		}
	}
	return true
}

// fast reports whether the match plays on fast: only AI players play on
// and everyone connected chose that. Someone who drops out or leaves no
// longer counts; back at the table, their choice counts again.
func (p *play) fast() bool {
	if !p.aiOnly() {
		return false
	}
	n := 0
	for s := range cards.Seat(p.t.Players()) {
		if !p.t.Present(s) {
			continue
		}
		if p.choice[s] != choiceFast {
			return false
		}
		n++
	}
	return n > 0
}

// Speed makes the table run the game's delays fastSpeed times as fast
// while the match plays on fast (server.Speeder).
func (p *play) Speed() float64 {
	if p.fast() {
		return fastSpeed
	}
	return 1
}

// choose takes seat i's choice. It stands for the rest of the match, and
// i may change it.
func (p *play) choose(i cards.Seat, choice string) error {
	if choice != choiceFast && choice != choiceWatch {
		return errors.New("Kies versnellen of toekijken.")
	}
	if !p.aiOnly() || p.choice[i] == choice {
		return server.ErrIgnore // a late tap (the match is over, a person plays again), or the choice again
	}
	if p.choice == nil {
		p.choice = map[cards.Seat]string{}
	}
	p.choice[i] = choice
	p.t.Emit(nil)
	return nil
}

// aiOnlyState is s.aiOnly, nil while a person still plays.
func (p *play) aiOnlyState() *aiOnly {
	if !p.aiOnly() {
		return nil
	}
	a := &aiOnly{Choice: make([]string, p.t.Players()), Fast: p.fast()}
	for s := range a.Choice {
		a.Choice[s] = p.choice[cards.Seat(s)]
	}
	return a
}
