package toepbot

import (
	"fmt"
	"math/rand/v2"
	"strings"
)

// ChatEvent is something a bot at a table of toepen may comment on. Kind
// is one of: "greet", "toep" (it toept), "overtoep" (it toept again on a
// toep), "stay" (it goes along with a toep), "pass" (it passed), "was"
// (it claimed one), "caught" (its bluff was checked), "checkWrong" (it
// checked a real was), "checkRight" (it caught a bluff), "wonRound",
// "boer" (it took the last trick with a boer), "lostRound" (Points: the
// penalty points), "koning" (the koningsspel begins), "out", "gameWon",
// "gameLost" and "reply" (Text: the human line it answers). A bot speaks
// of its own decisions only once it made them, so what it says and what
// it does agree.
type ChatEvent struct {
	Kind   string
	Mine   bool
	Text   string
	Points int
}

// chance is how likely a bot of average chattiness comments on a kind.
var chance = map[string]float64{
	"greet": 0.8, "toep": 0.55, "overtoep": 0.75, "stay": 0.2, "pass": 0.35, "was": 0.7, "caught": 0.8,
	"checkWrong": 0.6, "checkRight": 0.7, "wonRound": 0.35, "boer": 0.8, "lostRound": 0.4, "koning": 0.6,
	"out": 0.9, "gameWon": 0.9, "gameLost": 0.7,
}

// lines are the Dutch lines per kind, for every persona; {n} is Points with
// its noun ("1 strafpunt", "3 strafpunten").
// Like klaverjas's bots they name no time of day and never give away a
// card they hold.
var lines = map[string][]string{
	"greet": {"Hallo allemaal! Wie durft er te toepen?", "Daar gaan we: vier kaarten, en alleen de laatste slag telt.",
		"Hoi! Niet te snel passen, hè.", "Kaarten erbij. Ik voel een goeie hand aankomen."},
	"toep": {"Toep!", "Ik klop. Wie gaat er mee?", "Toep! Durven jullie?", "Klop klop. Er gaat een puntje bij.",
		"Toep. Ik zou maar passen als ik jullie was."},
	"overtoep": {"Overtoep! Nu jij weer.", "En ik doe er nog eentje bij!", "Toep terug!", "Dacht je dat? Overtoep!"},
	"stay": {"Ik ga mee.", "Daar schrik ik niet van. Mee!", "Bluf of geen bluf: ik ga mee.", "Toepen kan iedereen. Ik ga mee.",
		"Mee. Laat maar zien wat je hebt."},
	"pass": {"Ik pas. Volgende keer beter.", "Pas. Te dure grap voor mij.", "Dit keer niet: pas.",
		"Ik laat 'm gaan. Pas."},
	"was": {"Vuile was! Kijk maar niet te goed.", "Ik heb een vuile was. Nieuwe kaarten graag.", "Vuile was! Vertrouw me maar.",
		"Wat een hand. Vuile was!"},
	"caught": {"Betrapt… Het was het proberen waard.", "Oeps. Dat was dus geen vuile was.",
		"Ach, je kunt niet altijd winnen.", "Hè, jij ook altijd met je controleren."},
	"checkWrong": {"Hm, die was echt. Strafpunt voor mij.", "Had ik maar niet gekeken.",
		"Eerlijk is eerlijk: een mooie vuile was.", "Dat had ik niet gedacht."},
	"checkRight": {"Dacht ik het niet! Geen vuile was.", "Mij hou je niet voor de gek.", "Ha, betrapt!", "Nette poging."},
	"boer":       {"Met de boer! Puntje eraf.", "De laagste kaart, en toch de laatste slag.", "Een boer als laatste: dat scheelt een punt."},
	"koning": {"Het koningsspel! Nu wordt het spannend.", "Alles draait om één laatste slag. Daar gaan we.",
		"Iedereen op armoede: wie de laatste slag haalt, wint."},
	"wonRound": {"De laatste slag is voor mij!", "Die laatste slag, daar gaat het om.", "Mooi zo, geen strafpunten.",
		"Zo hoort dat. Volgende!"},
	"lostRound": {"Au, {n}.", "Dat had ik niet zien aankomen.", "Hm. Volgend potje beter.",
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
	"sjaak":  {"toep": {"Toep! En ik meen het. Misschien."}, "was": {"Vuile was! Echt. Bijna echt."}},
	"fatima": {"toep": {"Toep. De kansen zijn met mij."}, "checkRight": {"De kans op een echte vuile was was klein."}},
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
		return "" // someone else's toep: the bot answers it with its decision
	}
	pool := lines[key]
	if len(pool) == 0 {
		return ""
	}
	if rng.Float64() >= chance[key]*(0.4+chattiness) {
		return ""
	}
	pool = append(pool[:len(pool):len(pool)], flavour[personaID][key]...)
	n := fmt.Sprint(ev.Points, " strafpunten")
	if ev.Points == 1 {
		n = "1 strafpunt"
	}
	return strings.ReplaceAll(pool[rng.IntN(len(pool))], "{n}", n)
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
