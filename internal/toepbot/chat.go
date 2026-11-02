package toepbot

import (
	"fmt"
	"math/rand/v2"
	"strings"
)

// ChatEvent is something a bot at a table of toepen may comment on. Kind
// is one of: "greet", "toep" (Mine: it toept; else someone else did),
// "pass", "was" (it claimed one), "caught" (its bluff was checked),
// "checkWrong" (it checked a real was), "checkRight" (it caught a bluff),
// "wonRound", "lostRound" (Points: the penalty points), "out", "gameWon",
// "gameLost" and "reply" (Text: the human line it answers).
type ChatEvent struct {
	Kind   string
	Mine   bool
	Text   string
	Points int
}

// chance is how likely a bot of average chattiness comments on a kind.
var chance = map[string]float64{
	"greet": 0.8, "toep": 0.55, "toep/opp": 0.25, "pass": 0.35, "was": 0.7, "caught": 0.8,
	"checkWrong": 0.6, "checkRight": 0.7, "wonRound": 0.35, "lostRound": 0.4, "out": 0.9,
	"gameWon": 0.9, "gameLost": 0.7,
}

// lines are the Dutch lines per kind, for every persona; {n} is Points.
// Like klaverjas's bots they name no time of day and never give away a
// card they hold.
var lines = map[string][]string{
	"greet": {"Hallo allemaal! Wie durft er te toepen?", "Daar gaan we: vier kaarten, en alleen de laatste slag telt.",
		"Hoi! Niet te snel passen, hè.", "Kaarten erbij. Ik voel een goeie hand aankomen."},
	"toep": {"Toep!", "Ik klop. Wie gaat er mee?", "Toep! Durven jullie?", "Klop klop. Er gaat een puntje bij.",
		"Toep. Ik zou maar passen als ik jullie was."},
	"toep/opp": {"Hmm, wat heb jij dan?", "Bluf of geen bluf…", "Daar schrik ik niet van.", "Oei, die meent het.",
		"Toepen kan iedereen!"},
	"pass": {"Ik pas. Volgende keer beter.", "Pas. Te dure grap voor mij.", "Dit keer niet: pas.",
		"Ik laat 'm gaan. Pas."},
	"was": {"Was! Kijk maar niet te goed.", "Ik heb een was. Nieuwe kaarten graag.", "Was! Vertrouw me maar.",
		"Wat een hand. Was!"},
	"caught": {"Betrapt… Het was het proberen waard.", "Oeps. Dat was dus geen was.",
		"Ach, je kunt niet altijd winnen.", "Hè, jij ook altijd met je controleren."},
	"checkWrong": {"Hm, die was echt. Strafpunt voor mij.", "Had ik maar niet gekeken.",
		"Eerlijk is eerlijk: een mooie was.", "Dat had ik niet gedacht."},
	"checkRight": {"Dacht ik het niet! Geen was.", "Mij hou je niet voor de gek.", "Ha, betrapt!", "Nette poging."},
	"wonRound": {"De laatste slag is voor mij!", "Die laatste slag, daar gaat het om.", "Mooi zo, geen strafpunten.",
		"Zo hoort dat. Volgende!"},
	"lostRound": {"Au, {n} strafpunten.", "Dat had ik niet zien aankomen.", "Hm. Volgend potje beter.",
		"Ik had moeten passen."},
	"out": {"Ik lig eruit. Succes nog!", "Dat was het voor mij. Ik kijk wel toe.", "Eruit… maar met opgeheven hoofd.",
		"Speel mooi verder, ik ben klaar."},
	"gameWon": {"Gewonnen! Wie wil er revanche?", "Als laatste over, zo hoort het.", "Dank jullie wel, het was gezellig!",
		"Toepen is een vak."},
	"gameLost": {"Goed gespeeld allemaal!", "Volgende keer win ik.", "Gefeliciteerd! Nog een potje?",
		"Gezellig was het wel."},
}

// flavour are lines only one persona says, mixed in with the others.
var flavour = map[string]map[string][]string{
	"dirk":   {"toep": {"Wie niet waagt, die niet wint. Toep!"}, "pass": {"Een goed verstaander past op tijd."}, "out": {"Zestig jaar kaarten, en nog steeds eruit."}},
	"truus":  {"greet": {"Wat gezellig, toepen! Ik heb er zo'n zin in."}, "wonRound": {"Joepie, die is voor mij!"}},
	"sjaak":  {"toep": {"Toep! En ik meen het. Misschien."}, "was": {"Was! Echt. Bijna echt."}},
	"fatima": {"toep": {"Toep. De kansen zijn met mij."}, "checkRight": {"De kans op een echte was was klein."}},
	"kees":   {"lostRound": {"Pfff, alweer strafpunten.", "Typisch. Altijd die laatste slag."}, "pass": {"Pas. Mopper mopper."}},
	"jannie": {"toep": {"Toep! Let goed op wat ik doe."}, "gameLost": {"Goed gedaan! Je hebt er iets van geleerd, toch?"}},
	"bram":   {"toep": {"Toep! 🔥"}, "wonRound": {"Ez 😎"}, "out": {"Eruit 💀"}},
	"vera":   {"toep": {"Toep! Vers van de bakker."}, "greet": {"Ik ben er wakker voor gebleven: toepen!"}},
}

// Chat returns a line of the persona about ev, "" for silence. chattiness
// (0..1) scales how often it speaks.
func Chat(personaID string, chattiness float64, ev ChatEvent, rng *rand.Rand) string {
	if rng == nil {
		return ""
	}
	if ev.Kind == "reply" {
		return reply(ev.Text, rng)
	}
	key := ev.Kind
	if key == "toep" && !ev.Mine {
		key = "toep/opp"
	}
	pool := lines[key]
	if len(pool) == 0 {
		return ""
	}
	if rng.Float64() >= chance[key]*(0.4+chattiness) {
		return ""
	}
	pool = append(pool[:len(pool):len(pool)], flavour[personaID][key]...)
	return strings.ReplaceAll(pool[rng.IntN(len(pool))], "{n}", fmt.Sprint(ev.Points))
}

// reply answers a human line now and then.
func reply(text string, rng *rand.Rand) string {
	t := strings.ToLower(text)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(t, w) {
				return true
			}
		}
		return false
	}
	var pool []string
	switch {
	case has("hoi", "hallo", "hey", "hi "):
		pool = []string{"Hoi!", "Hallo!", "Hé, hallo!"}
	case has("goed gespeeld", "gg", "mooi"):
		pool = []string{"Dank je!", "Jij ook!", "Dankjewel 😊"}
	case has("haha", "lol", "😂"):
		pool = []string{"Haha", "😄", "Hihi"}
	case has("bluf"):
		pool = []string{"Wie, ik? Nooit.", "Dat zul je nooit weten.", "Bluffen? Ik?"}
	case has("toep", "klop"):
		pool = []string{"Rustig maar, eerst je beurt.", "Durf jij wel?", "We zullen zien!"}
	case has("was"):
		pool = []string{"Controleren of niet, dat is de vraag.", "Ik vertrouw niemand."}
	default:
		return ""
	}
	return pool[rng.IntN(len(pool))]
}
