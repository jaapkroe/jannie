// Package bot holds the computer players: personas, play levels, training
// advice and chat.
//
// Levels:
//   - makkelijk: simple heuristics without card counting, a random legal
//     card about 30% of the time, and the longest suit as trump;
//   - normaal: the rule-based policy (policy.go), which sees only public
//     information plus its own hand: card tracking, void and trump
//     inference, roem awareness and smearing, and trump choice and bidding
//     from a hand value fitted to simulations;
//   - sterk: determinised Monte Carlo (search.go). It samples the hidden
//     hands consistent with everything known (sample.go), weighted by the
//     bidding, the trump choice and the signals, plays every legal card and
//     finishes the hand with the rule-based policy for all four players.
//
// Advise explains the sterk choice in Dutch for the training mode, and Chat
// gives every persona its own voice.
package bot

import "errors"

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

// Persona is a bot character.
type Persona struct {
	ID, Name, Emoji, Color, Bio string // Name without "(AI)"; Bio is Dutch, one line

	Aggression float64 // 0..1: willingness to play/choose trump on weaker hands, to go for pit
	Chattiness float64 // 0..1: chance of commenting on events
	Speed      float64 // multiplier on think time (0.6 fast .. 1.4 slow)
}

var roster = []Persona{
	{
		ID: "henk", Name: "Opa Henk", Emoji: "👴", Color: "#8a5a2b",
		Bio:        "Speelt al zestig jaar in café De Klaver; voorzichtig, degelijk en altijd een spreekwoord paraat.",
		Aggression: 0.25, Chattiness: 0.45, Speed: 1.3,
	},
	{
		ID: "truus", Name: "Tante Truus", Emoji: "👵", Color: "#c2477a",
		Bio:        "Kletst honderduit, is dol op roem en ziet altijd de zonnige kant.",
		Aggression: 0.5, Chattiness: 0.9, Speed: 1.1,
	},
	{
		ID: "sjaak", Name: "Sjaak", Emoji: "🎲", Color: "#e07b24",
		Bio:        "Gokker in hart en nieren: speelt op dunne handen en gaat altijd voor de pit.",
		Aggression: 0.9, Chattiness: 0.6, Speed: 0.8,
	},
	{
		ID: "fatima", Name: "Fatima", Emoji: "🧠", Color: "#5b6ee1",
		Bio:        "Wiskundestudent die elke kaart telt en weinig woorden nodig heeft.",
		Aggression: 0.45, Chattiness: 0.25, Speed: 0.9,
	},
	{
		ID: "kees", Name: "Kees de Visser", Emoji: "🎣", Color: "#2a8c9c",
		Bio:        "Mopperkont met een hart van goud; eerlijk, maar wee je gebeente als hij nat gaat.",
		Aggression: 0.35, Chattiness: 0.6, Speed: 1.0,
	},
	{
		ID: "ans", Name: "Juf Ans", Emoji: "👩‍🏫", Color: "#3f9b5a",
		Bio:        "Geduldige juf die graag uitlegt waarom een kaart goed valt.",
		Aggression: 0.4, Chattiness: 0.5, Speed: 1.2,
	},
	{
		ID: "bram", Name: "Bram", Emoji: "🛹", Color: "#9b59b6",
		Bio:        "Jong en snel, speelt op gevoel en praat het liefst in emoji.",
		Aggression: 0.7, Chattiness: 0.7, Speed: 0.6,
	},
	{
		ID: "lies", Name: "Bakker Lies", Emoji: "🥐", Color: "#c9a227",
		Bio:        "Staat om vijf uur op voor het brood en speelt scherp, maar altijd vriendelijk.",
		Aggression: 0.55, Chattiness: 0.4, Speed: 0.85,
	},
}

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
