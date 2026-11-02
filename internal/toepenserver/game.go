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
	Overtoep(v toepen.View) bool  // asked about a toep: toep again (only asked when v.CanRaise)?
	Answer(v toepen.View) bool    // go along with the toep (else pass; true when v.MustStay)?
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

// Options are toepen's own options (docs/toepen.md §2): the penalty
// points that put a player out, and which of the rules that groups play
// differently are played: the witte and vuile was, armoede, the
// koningsspel, a point off for the last trick with a boer,
// anti-lijntoep, and playing on face up after a bluff that was caught.
type Options struct {
	Limit    int
	Was      bool
	Armoede  bool
	Koning   bool
	Boer     bool
	Lijntoep bool
	Bluf     bool
}

func defaultOptions() *Options {
	r := toepen.DefaultRules
	return &Options{Limit: r.Limit, Was: r.Was, Armoede: r.Armoede, Koning: r.Koning, Boer: r.Boer, Lijntoep: r.Lijntoep, Bluf: r.Bluf}
}

// Set reads limit and the rules' switches (server.GameOptions).
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
		case "was", "armoede", "koning", "boer", "lijntoep", "bluf":
			var b *bool // null would otherwise switch it off
			if json.Unmarshal(val, &b) != nil || b == nil {
				err = errors.New("Ongeldige waarde voor " + key + ".")
				break
			}
			*map[string]*bool{"was": &next.Was, "armoede": &next.Armoede, "koning": &next.Koning,
				"boer": &next.Boer, "lijntoep": &next.Lijntoep, "bluf": &next.Bluf}[key] = *b
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
	Players  int    `json:"players"`
	AI       string `json:"ai"`
	Tempo    string `json:"tempo"`
	Seed     int    `json:"seed"`
	Limit    int    `json:"limit"`
	Was      bool   `json:"was"`
	Armoede  bool   `json:"armoede"`
	Koning   bool   `json:"koning"`
	Boer     bool   `json:"boer"`
	Lijntoep bool   `json:"lijntoep"`
	Bluf     bool   `json:"bluf"`
}

// Wire is the options on the wire (server.GameOptions).
func (o *Options) Wire(t server.TableOpts) any {
	return wireOpts{Players: t.Players, AI: t.AI, Tempo: t.Tempo, Seed: t.Seed, Limit: o.Limit, Was: o.Was,
		Armoede: o.Armoede, Koning: o.Koning, Boer: o.Boer, Lijntoep: o.Lijntoep, Bluf: o.Bluf}
}

// rules are the options as package toepen's rules.
func (o *Options) rules() toepen.Rules {
	return toepen.Rules{Limit: o.Limit, Was: o.Was, Armoede: o.Armoede, Koning: o.Koning, Boer: o.Boer, Lijntoep: o.Lijntoep, Bluf: o.Bluf}
}

// variant names the rules for the start line and the log: "toepen tot 10
// strafpunten, met vuile was, armoede, koningsspel, boer eraf en open na
// bluf" (as variantText in web/toepen/js/rules.js).
func (o *Options) variant() string {
	var with []string
	for _, x := range []struct {
		on   bool
		name string
	}{{o.Was, "vuile was"}, {o.Armoede, "armoede"}, {o.Koning, "koningsspel"}, {o.Boer, "boer eraf"}, {o.Lijntoep, "anti-lijntoep"},
		{o.Was && o.Bluf, "open na bluf"}} {
		if x.on {
			with = append(with, x.name)
		}
	}
	s := fmt.Sprintf("toepen tot %d strafpunten", o.Limit)
	if len(with) > 0 {
		s += ", met " + joinNL(with)
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
