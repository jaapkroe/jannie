// Package bot holds the computer players: personas, play levels, training
// advice and chat.
//
// Levels:
//   - makkelijk: simple heuristics without card counting, a random legal
//     card about 30% of the time, and the longest suit as trump;
//   - normaal: the rule-based policy (policy.go), which sees only public
//     information plus its own hand: card tracking, void and trump
//     inference, roem awareness, spekken (points on the partner's trick),
//     the signals of design §8 (kleintje boer, met de aas seinen,
//     opseinen), given honestly and read, and trump choice and bidding
//     from a hand value fitted to simulations;
//   - sterk: determinised Monte Carlo (search.go). It samples the hidden
//     hands consistent with everything known (sample.go), weighted by the
//     bidding, the trump choice and the signals, plays every legal card and
//     finishes the hand with the rule-based policy for all four players.
//
// Advise explains the sterk choice in Dutch for the training mode, and Chat
// gives every persona its own voice.
package bot

import (
	"errors"

	"klaverjas/internal/persona"
)

// Level is the playing strength of a bot.
type Level int

const (
	Makkelijk Level = iota
	Normaal
	Sterk
)

// String returns the wire name ("normaal").
func (l Level) String() string {
	switch l {
	case Makkelijk:
		return "makkelijk"
	case Normaal:
		return "normaal"
	case Sterk:
		return "sterk"
	}
	return "?"
}

// ParseLevel parses "makkelijk", "normaal" or "sterk".
func ParseLevel(s string) (Level, error) {
	switch s {
	case "makkelijk":
		return Makkelijk, nil
	case "normaal":
		return Normaal, nil
	case "sterk":
		return Sterk, nil
	}
	return Normaal, errors.New("onbekend niveau: " + s)
}

// Persona is a bot character: its identity (package persona) with its
// klaverjas bio.
type Persona struct {
	ID, Name, Emoji, Color, Bio string // Name without "(AI)"; Bio is Dutch, one line

	Aggression float64 // 0..1: willingness to play/choose trump on weaker hands, to go for pit
	Chattiness float64 // 0..1: chance of commenting on events
	Speed      float64 // multiplier on think time (0.6 fast .. 1.4 slow)
}

// bios are what the personas say about themselves at a table of
// klaverjas.
var bios = map[string]string{
	"dirk":   "Speelt al zestig jaar in café De Klaver; voorzichtig, degelijk en altijd een spreekwoord paraat.",
	"truus":  "Kletst honderduit, is dol op roem en ziet altijd de zonnige kant.",
	"sjaak":  "Gokker in hart en nieren: speelt op dunne handen en gaat altijd voor de pit.",
	"fatima": "Wiskundestudent die elke kaart telt en weinig woorden nodig heeft.",
	"kees":   "Mopperkont met een hart van goud; eerlijk, maar wee je gebeente als hij nat gaat.",
	"jannie": "Geduldige juf die graag uitlegt waarom een kaart goed valt.",
	"bram":   "Jong en snel, speelt op gevoel en praat het liefst in emoji.",
	"vera":   "Staat om vijf uur op voor het brood en speelt scherp, maar altijd vriendelijk.",
}

// roster is the personas of package persona, with their bios.
var roster = func() []Persona {
	var out []Persona
	for _, p := range persona.All() {
		out = append(out, Persona{ID: p.ID, Name: p.Name, Emoji: p.Emoji, Color: p.Color, Bio: bios[p.ID],
			Aggression: p.Aggression, Chattiness: p.Chattiness, Speed: p.Speed})
	}
	return out
}()

// Roster returns the eight personas.
func Roster() []Persona {
	return append([]Persona(nil), roster...)
}

// ByID returns the persona with the given ID.
func ByID(id string) (Persona, bool) {
	for _, p := range roster {
		if p.ID == id {
			return p, true
		}
	}
	return Persona{}, false
}
