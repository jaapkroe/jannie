package game

import "errors"

// Seat is a player position 0..3, clockwise. Team of a seat is s%2.
// NoSeat (-1) means "nobody".
type Seat int

// NoSeat marks an unknown or absent seat (no winner yet, nobody's turn).
const NoSeat Seat = -1

// Next returns the seat to the left (clockwise), who plays after s.
func (s Seat) Next() Seat { return (s + 1) & 3 }

// Partner returns the seat opposite s.
func (s Seat) Partner() Seat { return (s + 2) & 3 }

// Team returns 0 for seats 0 and 2, 1 for seats 1 and 3.
func (s Seat) Team() int { return int(s & 1) }

// Valid reports whether s is one of the four seats.
func (s Seat) Valid() bool { return s >= 0 && s < 4 }

// Rules selects the obligation to trump when you cannot follow suit.
type Rules uint8

const (
	// Amsterdams: no need to (over)trump a trick your partner is winning.
	Amsterdams Rules = iota
	// Rotterdams: always (over)trump when you cannot follow suit.
	Rotterdams
)

// String returns "amsterdams" or "rotterdams".
func (r Rules) String() string {
	switch r {
	case Amsterdams:
		return "amsterdams"
	case Rotterdams:
		return "rotterdams"
	}
	return "?"
}

// NameNL returns the display name ("Amsterdams").
func (r Rules) NameNL() string {
	switch r {
	case Amsterdams:
		return "Amsterdams"
	case Rotterdams:
		return "Rotterdams"
	}
	return "?"
}

// ParseRules parses "amsterdams" or "rotterdams".
func ParseRules(s string) (Rules, error) {
	switch s {
	case "amsterdams":
		return Amsterdams, nil
	case "rotterdams":
		return Rotterdams, nil
	}
	return 0, errors.New("onbekende spelregels: " + quote(s))
}

func (r Rules) MarshalText() ([]byte, error) {
	if r > Rotterdams {
		return nil, errors.New("game: invalid rules")
	}
	return []byte(r.String()), nil
}

func (r *Rules) UnmarshalText(b []byte) error {
	v, err := ParseRules(string(b))
	if err != nil {
		return err
	}
	*r = v
	return nil
}

// TrumpMode selects how trump is chosen.
type TrumpMode uint8

const (
	// Utrechts ("verplicht spelen"): voorhand chooses trump.
	Utrechts TrumpMode = iota
	// Gedraaid ("vrij"): a turned suit is offered to each player in turn.
	Gedraaid
)

// String returns "utrechts" or "gedraaid".
func (m TrumpMode) String() string {
	switch m {
	case Utrechts:
		return "utrechts"
	case Gedraaid:
		return "gedraaid"
	}
	return "?"
}

// NameNL returns the display name ("Utrechts").
func (m TrumpMode) NameNL() string {
	switch m {
	case Utrechts:
		return "Utrechts"
	case Gedraaid:
		return "Gedraaid"
	}
	return "?"
}

// ParseTrumpMode parses "utrechts" or "gedraaid".
func ParseTrumpMode(s string) (TrumpMode, error) {
	switch s {
	case "utrechts":
		return Utrechts, nil
	case "gedraaid":
		return Gedraaid, nil
	}
	return 0, errors.New("onbekende troefkeuze: " + quote(s))
}

func (m TrumpMode) MarshalText() ([]byte, error) {
	if m > Gedraaid {
		return nil, errors.New("game: invalid trump mode")
	}
	return []byte(m.String()), nil
}

func (m *TrumpMode) UnmarshalText(b []byte) error {
	v, err := ParseTrumpMode(string(b))
	if err != nil {
		return err
	}
	*m = v
	return nil
}
