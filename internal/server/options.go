package server

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"klaverjas/internal/game"
)

// Options are the room settings chosen by the host (design §3).
type Options struct {
	Humans    int            `json:"humans"`
	Hands     int            `json:"hands"`
	TrumpMode game.TrumpMode `json:"trumpMode"`
	Rules     game.Rules     `json:"rules"`
	AI        string         `json:"ai"`
	Tempo     string         `json:"tempo"`
	Open      bool           `json:"open"`
}

func defaultOptions() Options {
	return Options{
		Humans:    4,
		Hands:     16,
		TrumpMode: game.Utrechts,
		Rules:     game.Amsterdams,
		AI:        "normaal",
		Tempo:     "normaal",
	}
}

var (
	validHands  = map[int]bool{4: true, 8: true, 12: true, 16: true, 20: true, 24: true}
	validLevels = map[string]bool{"makkelijk": true, "normaal": true, "sterk": true}
)

// optsPatch is a partial options update; nil fields are unchanged.
type optsPatch struct {
	Humans    *int
	Hands     *int
	TrumpMode *game.TrumpMode
	Rules     *game.Rules
	AI        *string
	Tempo     *string
	Open      *bool
}

// parseOpts reads a partial options object. With lenient, invalid values
// are skipped (create: stale settings must not block a new game); otherwise
// the first invalid value is an error with a Dutch message.
func parseOpts(raw json.RawMessage, lenient bool) (optsPatch, error) {
	var p optsPatch
	if len(raw) == 0 || string(raw) == "null" {
		return p, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		if lenient {
			return p, nil
		}
		return p, errors.New("Ongeldige spelregels.")
	}
	fail := func(msg string) error {
		if lenient {
			return nil
		}
		return errors.New(msg)
	}
	for key, val := range fields {
		var err error
		switch key {
		case "humans":
			var n int
			if json.Unmarshal(val, &n) != nil || n < 1 || n > 4 {
				err = fail("Het aantal spelers moet tussen 1 en 4 liggen.")
			} else {
				p.Humans = &n
			}
		case "hands":
			var n int
			if json.Unmarshal(val, &n) != nil || !validHands[n] {
				err = fail("Kies 4, 8, 12, 16, 20 of 24 potjes.")
			} else {
				p.Hands = &n
			}
		case "trumpMode":
			var m game.TrumpMode
			if json.Unmarshal(val, &m) != nil {
				err = fail("Onbekende troefkeuze.")
			} else {
				p.TrumpMode = &m
			}
		case "rules":
			var r game.Rules
			if json.Unmarshal(val, &r) != nil {
				err = fail("Onbekende spelregels.")
			} else {
				p.Rules = &r
			}
		case "ai":
			var s string
			if json.Unmarshal(val, &s) != nil || !validLevels[s] {
				err = fail("Onbekend niveau voor de AI.")
			} else {
				p.AI = &s
			}
		case "tempo":
			var s string
			if json.Unmarshal(val, &s) != nil || pacings[s] == (pacing{}) {
				err = fail("Onbekend tempo.")
			} else {
				p.Tempo = &s
			}
		case "open":
			var b bool
			if json.Unmarshal(val, &b) != nil {
				err = fail("Ongeldige waarde voor open kaarten.")
			} else {
				p.Open = &b
			}
		}
		if err != nil {
			return optsPatch{}, err
		}
	}
	return p, nil
}

// apply sets the fields of p on o, except Humans (rooms handle seats).
func (p optsPatch) apply(o *Options) {
	if p.Hands != nil {
		o.Hands = *p.Hands
	}
	if p.TrumpMode != nil {
		o.TrumpMode = *p.TrumpMode
	}
	if p.Rules != nil {
		o.Rules = *p.Rules
	}
	if p.AI != nil {
		o.AI = *p.AI
	}
	if p.Tempo != nil {
		o.Tempo = *p.Tempo
	}
	if p.Open != nil {
		o.Open = *p.Open
	}
}

// pacing holds the unscaled delays of one tempo (design §6).
type pacing struct {
	think, deal, announce, trick, summary time.Duration
}

var pacings = map[string]pacing{
	"rustig":  {1500 * time.Millisecond, 2000 * time.Millisecond, 1200 * time.Millisecond, 2200 * time.Millisecond, 15 * time.Second},
	"normaal": {900 * time.Millisecond, 1500 * time.Millisecond, 900 * time.Millisecond, 1500 * time.Millisecond, 12 * time.Second},
	"snel":    {450 * time.Millisecond, 900 * time.Millisecond, 500 * time.Millisecond, 800 * time.Millisecond, 8 * time.Second},
}

const (
	maxNameRunes = 20
	maxChatRunes = 200
)

// cleanName makes a display name: control and bidi characters stripped,
// spaces collapsed, at most 20 characters, no fake "(AI)" suffix; empty
// becomes "Speler".
func cleanName(s string) string {
	s = cleanText(s, maxNameRunes+8)
	for {
		t := strings.TrimSpace(s)
		if len(t) >= 4 && strings.EqualFold(t[len(t)-4:], "(AI)") {
			s = t[:len(t)-4]
			continue
		}
		s = t
		break
	}
	s = truncateRunes(s, maxNameRunes)
	s = strings.TrimSpace(s)
	if s == "" {
		return "Speler"
	}
	return s
}

// cleanChat makes a chat line: as cleanText, at most 200 characters.
func cleanChat(s string) string {
	return strings.TrimSpace(truncateRunes(cleanText(s, maxChatRunes*2), maxChatRunes))
}

// cleanText strips control and bidi-override characters, turns any run of
// whitespace into one space and trims. It looks at no more than limit runes
// of input after cleaning.
func cleanText(s string, limit int) string {
	s = strings.ToValidUTF8(s, "")
	var b strings.Builder
	n := 0
	space := false
	for _, r := range s {
		if n >= limit {
			break
		}
		switch {
		case unicode.IsSpace(r):
			space = true
			continue
		case unicode.IsControl(r), isBidiControl(r), r == utf8.RuneError:
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
			n++
		}
		space = false
		b.WriteRune(r)
		n++
	}
	return b.String()
}

func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) || r == 0x200E || r == 0x200F || r == 0x061C
}

func truncateRunes(s string, n int) string {
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos]
		}
		i++
	}
	return s
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"

// normCode upper-cases and validates a room code; "" if it cannot be one.
func normCode(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != 4 {
		return ""
	}
	for i := 0; i < 4; i++ {
		if strings.IndexByte(codeAlphabet, s[i]) < 0 {
			return ""
		}
	}
	return s
}
