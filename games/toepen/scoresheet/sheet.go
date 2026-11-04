// Package scoresheet keeps the score of toepen played at a real table,
// without the app's table (docs/toepen.md §9): the host, who made the
// sheet, enters every round (who won, who went away, the points) and
// chooses the names; everyone with the code watches it live. A sheet
// lives in memory and, given a directory, on disk, so a restart keeps it;
// one untouched for a week is gone.
package scoresheet

import (
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Sizes of a sheet.
const (
	MinPlayers = 2
	MaxPlayers = 8 // 32 cards, four each
	MaxRounds  = 300
	MaxName    = 20
	// MaxGain bounds the points of one player in one round, either way.
	MaxGain = 30
)

// Sheet is the score of one match, as everyone sees it.
type Sheet struct {
	Code    string    `json:"code"`
	Limit   int       `json:"limit"` // penalty points that put a player out: 10 or 15
	Names   []string  `json:"names"`
	Rounds  []Round   `json:"rounds"`
	Version int       `json:"version"` // one more with every change
	Updated time.Time `json:"updated"`
}

// Round is one round as the host entered it. Gains are the penalty points
// per player (negative: points off, as for the boer), Passed who went away
// on a toep, Stake what the round was played for at the end (0: not
// given; the points are what count). Winner is -1 for a row of
// corrections only.
type Round struct {
	Winner int    `json:"winner"`
	Gains  []int  `json:"gains"`
	Passed []bool `json:"passed"`
	Stake  int    `json:"stake,omitempty"`
}

// Points are each player's penalty points after every round.
func (s *Sheet) Points() []int {
	out := make([]int, len(s.Names))
	for _, r := range s.Rounds {
		for k, g := range r.Gains {
			out[k] += g
		}
	}
	return out
}

// Errors, in Dutch: shown to the host.
var (
	ErrNames  = errors.New("Geef 2 tot 8 spelers een naam (hoogstens 20 tekens), elk een andere.")
	ErrLimit  = errors.New("Speel tot 10 of tot 15 strafpunten.")
	ErrRound  = errors.New("Dat potje klopt niet: kies een winnaar uit de spelers en punten van -30 tot 30.")
	ErrFull   = errors.New("Deze scorelijst is vol.")
	ErrNoSuch = errors.New("Dat potje bestaat niet.")
	ErrShrink = errors.New("Spelers kun je toevoegen of hernoemen, niet weghalen.")
)

// cleanNames trims names and checks them: 2 to 8, each 1 to 20
// characters, no two alike.
func cleanNames(names []string) ([]string, error) {
	if len(names) < MinPlayers || len(names) > MaxPlayers {
		return nil, ErrNames
	}
	out := make([]string, len(names))
	for k, n := range names {
		n = strings.Join(strings.Fields(n), " ")
		if n == "" || utf8.RuneCountInString(n) > MaxName || !utf8.ValidString(n) {
			return nil, ErrNames
		}
		for _, o := range out[:k] {
			if strings.EqualFold(o, n) {
				return nil, ErrNames
			}
		}
		out[k] = n
	}
	return out, nil
}

func validLimit(limit int) error {
	if limit != 10 && limit != 15 {
		return ErrLimit
	}
	return nil
}

// check reports whether r is a round of n players.
func (r *Round) check(n int) error {
	if r.Winner < -1 || r.Winner >= n || len(r.Gains) != n || len(r.Passed) != n || r.Stake < 0 || r.Stake > MaxGain {
		return ErrRound
	}
	for k, g := range r.Gains {
		if g < -MaxGain || g > MaxGain || r.Passed[k] && k == r.Winner {
			return ErrRound
		}
	}
	return nil
}

// grow gives every round a zero for players added since.
func (s *Sheet) grow() {
	for k := range s.Rounds {
		r := &s.Rounds[k]
		for len(r.Gains) < len(s.Names) {
			r.Gains = append(r.Gains, 0)
			r.Passed = append(r.Passed, false)
		}
	}
}

// round is the round of a "round" or "edit" message.
func (m *msg) round() Round {
	return Round{Winner: m.Winner, Gains: slices.Clone(m.Gains), Passed: slices.Clone(m.Passed), Stake: m.Stake}
}

// apply makes change m to s; it is the host's.
func (s *Sheet) apply(m *msg) error {
	n := len(s.Names)
	switch m.T {
	case "round":
		if len(s.Rounds) >= MaxRounds {
			return ErrFull
		}
		r := m.round()
		if err := r.check(n); err != nil {
			return err
		}
		s.Rounds = append(s.Rounds, r)
	case "edit":
		if m.Index < 0 || m.Index >= len(s.Rounds) {
			return ErrNoSuch
		}
		r := m.round()
		if err := r.check(n); err != nil {
			return err
		}
		s.Rounds[m.Index] = r
	case "delete":
		if m.Index < 0 || m.Index >= len(s.Rounds) {
			return ErrNoSuch
		}
		s.Rounds = slices.Delete(s.Rounds, m.Index, m.Index+1)
	case "names":
		if len(m.Names) < n {
			return ErrShrink
		}
		names, err := cleanNames(m.Names)
		if err != nil {
			return err
		}
		s.Names = names
		s.grow()
	case "limit":
		if err := validLimit(m.Limit); err != nil {
			return err
		}
		s.Limit = m.Limit
	case "restart":
		// A new match with the same players: the rounds go.
		s.Rounds = []Round{}
	default:
		return errUnknown
	}
	return nil
}
