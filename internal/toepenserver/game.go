// Package toepenserver is toepen (design §11) as a game for package
// server: its options, the rounds at the table, the bots' decisions, the
// state and events on the wire and the game log's rounds. The rules are
// package toepen's; the bots come in through AI (cmd/toepen adapts package
// toepbot to it).
package toepenserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"klaverjas/internal/game"
	"klaverjas/internal/server"
	"klaverjas/internal/toepen"
)

// Brain makes the decisions of one bot seat. The table calls one brain
// from one goroutine at a time.
type Brain interface {
	Was(v toepen.View) bool       // right after the deal: claim a was (only asked when v.CanClaim)?
	Check(v toepen.View) bool     // check the claimed was of v.Claimant?
	Toep(v toepen.View) bool      // on its turn to play: toep first (only asked when v.CanToep)?
	Answer(v toepen.View) bool    // go along with the toep (else pass)?
	Play(v toepen.View) game.Card // one of v.Legal
}

// AI is what tables of toepen need from the bots.
type AI interface {
	// Personas are the bots, with their toepen bios; at least five.
	Personas() []server.Persona
	// NewBrain returns a player for a persona at level "makkelijk",
	// "normaal" or "sterk"; an empty personaID asks for a neutral one.
	NewBrain(personaID, level string, seed uint64) Brain
	// Chat is a line of the persona about ev, "" for silence.
	Chat(personaID string, ev server.ChatEvent, rng *rand.Rand) string
}

// New returns toepen for server.Config.Game, played by ai's bots; nil
// plays with plain ones (plainAI).
func New(ai AI) server.Game {
	if ai == nil {
		ai = plainAI{}
	}
	return toepGame{ai}
}

type toepGame struct{ ai AI }

func (toepGame) Name() string                    { return "toepen" }
func (toepGame) Seats() (int, int, int)          { return 2, 6, 4 }
func (g toepGame) Personas() []server.Persona    { return g.ai.Personas() }
func (toepGame) NewOptions() server.GameOptions  { return defaultOptions() }
func (toepGame) New(t *server.Table) server.Play { return &play{t: t, poorAt: -1} }

func (g toepGame) NewBrain(personaID, level string, seed uint64) any {
	return g.ai.NewBrain(personaID, level, seed)
}

func (g toepGame) Chat(personaID string, ev server.ChatEvent, rng *rand.Rand) string {
	return g.ai.Chat(personaID, ev, rng)
}

// ---- options ----

// Options are toepen's own options (design §11): the penalty points that
// put a player out, and whether the witte and vuile was and armoede are
// played.
type Options struct {
	Limit   int
	Was     bool
	Armoede bool
}

func defaultOptions() *Options { return &Options{Limit: toepen.DefaultLimit, Was: true, Armoede: true} }

// Set reads limit, was and armoede (server.GameOptions).
func (o *Options) Set(fields map[string]json.RawMessage, lenient bool) error {
	next := *o
	for key, val := range fields {
		var err error
		switch key {
		case "limit":
			var n int
			if json.Unmarshal(val, &n) != nil || n != 10 && n != 15 {
				err = errors.New("Speel tot 10 of tot 15 strafpunten.")
			} else {
				next.Limit = n
			}
		case "was", "armoede":
			var b *bool // null would otherwise switch it off
			switch {
			case json.Unmarshal(val, &b) != nil || b == nil:
				err = errors.New("Ongeldige waarde voor " + key + ".")
			case key == "was":
				next.Was = *b
			default:
				next.Armoede = *b
			}
		}
		if err != nil && !lenient {
			return err
		}
	}
	*o = next
	return nil
}

// wireOpts is s.opts and the game log's opts: the table's options and
// toepen's.
type wireOpts struct {
	Players int    `json:"players"`
	AI      string `json:"ai"`
	Tempo   string `json:"tempo"`
	Seed    int    `json:"seed"`
	Limit   int    `json:"limit"`
	Was     bool   `json:"was"`
	Armoede bool   `json:"armoede"`
}

// Wire is the options on the wire (server.GameOptions).
func (o *Options) Wire(t server.TableOpts) any {
	return wireOpts{Players: t.Players, AI: t.AI, Tempo: t.Tempo, Seed: t.Seed, Limit: o.Limit, Was: o.Was, Armoede: o.Armoede}
}

// rules are the options as package toepen's rules.
func (o *Options) rules() toepen.Rules {
	return toepen.Rules{Limit: o.Limit, Was: o.Was, Armoede: o.Armoede}
}

// variant names the rules for the start line and the log.
func (o *Options) variant() string {
	s := fmt.Sprintf("toepen tot %d strafpunten", o.Limit)
	switch {
	case o.Was && o.Armoede:
		s += ", met was en armoede"
	case o.Was:
		s += ", met was"
	case o.Armoede:
		s += ", met armoede"
	}
	return s
}

// ---- pacing ----

// pacing is toepen's own delays of a tempo (design §11): the time to say
// whether you have a was, and the summary of a round.
type pacing struct{ was, round time.Duration }

var pacings = map[string]pacing{
	"rustig":  {10 * time.Second, 6 * time.Second},
	"normaal": {8 * time.Second, 4500 * time.Millisecond},
	"snel":    {6 * time.Second, 3 * time.Second},
}

// The pauses of a round (server.Step).
const (
	stepDealt     server.Step = iota + 1 // the deal animation: then the time for a was, or the first turn
	stepWas                              // the time for a was, in which everyone answers at once
	stepAnnounced                        // claims, a toep, armoede or a settled was are shown: then the round goes on
	stepCollect                          // a complete trick lies on the table: then it is collected
)
