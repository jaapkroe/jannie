package bot

import (
	"math/rand/v2"
	"strconv"
	"strings"
	"unicode"
)

// ChatEvent is something a bot may react to in the chat.
type ChatEvent struct {
	// Kind is one of "greet", "trump", "pass", "play", "wonTrick", "roem",
	// "nat", "natOpp", "pit", "handWon", "handLost", "gameWon", "gameLost",
	// "partnerGood", "reply".
	Kind   string
	Mine   bool   // about the bot itself / its team; for "reply": the bot is the speaker's partner
	Text   string // for "reply": the human chat line being answered
	Points int    // roem/points involved
	// For "reply": InHand while tricks are being played, and Playing when
	// the bot's team made trump in that hand.
	InHand, Playing bool
}

// Chat returns a line for p in reaction to ev, or "" to stay silent. Lines
// are in character and never reveal the bot's cards. The server
// rate-limits on top of this.
func Chat(p Persona, ev ChatEvent, rng *rand.Rand) string {
	if rng == nil {
		return ""
	}
	v, ok := voices[p.ID]
	if !ok {
		v = genericVoice
	}
	if ev.Kind == "reply" {
		return reply(p, v, ev, rng)
	}
	if rng.Float64() >= chatChance(p, ev.Kind) {
		return ""
	}
	key := ev.Kind
	if !ev.Mine {
		if _, ok := v.lines[key+"/opp"]; ok {
			key += "/opp"
		} else if sided[key] {
			return "" // the bot's own side of the event does not fit
		}
	}
	return pick(v.lines[key], ev.Points, rng)
}

// sided are the event kinds that happen to one team: a bot of the other
// team uses the "/opp" lines, or says nothing.
var sided = map[string]bool{"trump": true, "wonTrick": true, "roem": true, "pit": true}

// chatChance is how likely p comments on an event of this kind.
func chatChance(p Persona, kind string) float64 {
	c := p.Chattiness
	if c <= 0 {
		return 0
	}
	switch kind {
	case "greet":
		return 0.6 + 0.4*c
	case "gameWon", "gameLost":
		return 0.5 + 0.5*c
	case "pit", "nat", "natOpp":
		return 0.4 + 0.6*c
	case "roem":
		if p.ID == "truus" {
			return 1
		}
		return 0.25 + 0.6*c
	case "partnerGood":
		return 0.2 + 0.6*c
	case "handWon", "handLost":
		return 0.6 * c
	case "trump", "pass":
		return 0.45 * c
	case "wonTrick":
		return 0.35 * c
	case "play":
		return 0.3 * c
	}
	return c
}

// pick returns a random line; lines with a {p} placeholder need points.
func pick(lines []string, points int, rng *rand.Rand) string {
	var usable [16]string
	n := 0
	for _, l := range lines {
		if strings.Contains(l, "{p}") && points <= 0 {
			continue
		}
		if n < len(usable) {
			usable[n] = l
			n++
		}
	}
	if n == 0 {
		return ""
	}
	return strings.ReplaceAll(usable[rng.IntN(n)], "{p}", strconv.Itoa(points))
}

// replyKinds are the human chat lines bots recognise, in priority order.
var replyKinds = []struct {
	kind  string
	words []string // whole words (lower case)
	parts []string // substrings, for phrases and emoji
}{
	{"gg", []string{"gg", "ggg", "ggwp"}, []string{"good game"}},
	{"praise", []string{"mooi", "knap", "netjes", "top", "bravo", "wauw", "wow", "sterk", "nice", "lekker"}, []string{"goed gespeeld", "goed gedaan", "👍", "👏"}},
	{"sorry", []string{"sorry", "sorrie", "oeps", "oops", "excuus", "sry"}, []string{"mijn fout"}},
	{"thanks", []string{"bedankt", "dankje", "dankjewel", "thanks", "thx", "merci"}, []string{"dank je", "dank u"}},
	{"help", []string{"help", "hoe", "uitleg", "regels", "waarom"}, []string{"snap het niet", "wat moet ik", "hoe werkt"}},
	{"nat", []string{"nat"}, nil},
	{"pech", []string{"pech", "jammer", "balen", "helaas", "verdorie", "shit", "damn"}, nil},
	{"laugh", []string{"haha", "hahaha", "hihi", "lol", "hehe", "xd"}, []string{"😂", "🤣", "😆", ":d"}},
	{"hello", []string{"hoi", "hallo", "hey", "hee", "hé", "goedenavond", "goedemiddag", "goedemorgen", "avond", "yo", "moi", "hai", "dag", "hoihoi"}, []string{"👋"}},
	{"bye", []string{"doei", "doeg", "welterusten", "ciao", "bye"}, []string{"tot ziens", "tot later", "slaap lekker", "ik ga"}},
}

// classifyReply returns the reply kind of a human chat line, or "".
func classifyReply(text string) string {
	low := strings.ToLower(text)
	for _, p := range []string{"hoe gaat het", "hoe is het", "alles goed"} {
		if strings.Contains(low, p) {
			return "hello"
		}
	}
	words := strings.FieldsFunc(low, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	has := func(w string) bool {
		for _, x := range words {
			if x == w || (strings.HasPrefix(x, w) && strings.Trim(x[len(w):], "a") == "" && (w == "haha" || w == "hihi")) {
				return true
			}
		}
		return false
	}
	for _, k := range replyKinds {
		for _, w := range k.words {
			if has(w) {
				return k.kind
			}
		}
		for _, p := range k.parts {
			if strings.Contains(low, p) {
				return k.kind
			}
		}
	}
	return ""
}

// mentions reports whether text names the persona ("dirk", "ans"): the
// first word of its name, after a title such as "Opa" or "Juf".
func mentions(p Persona, text string) bool {
	name := strings.Fields(strings.ToLower(p.Name))
	if len(name) > 1 && (name[0] == "opa" || name[0] == "tante" || name[0] == "juf" || name[0] == "bakker") {
		name = name[1:]
	}
	if len(name) == 0 {
		return false
	}
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) }) {
		if w == name[0] {
			return true
		}
	}
	return false
}

func reply(p Persona, v *voice, ev ChatEvent, rng *rand.Rand) string {
	kind := classifyReply(ev.Text)
	named := mentions(p, ev.Text)
	if kind == "" {
		if !named {
			return ""
		}
		kind = "name"
	}
	if kind == "nat" {
		// "Nat!" taunts the playing team during a hand: the bot's partner
		// joins in, a bot of the playing team protests. Anything else (after
		// the hand, or a player lamenting their own team) gets no answer.
		switch {
		case !ev.InHand:
			return ""
		case ev.Mine && !ev.Playing:
			kind = "nat/maat"
		case ev.Mine || !ev.Playing:
			return ""
		}
	}
	chance := 0.2 + 0.7*p.Chattiness
	if named {
		chance = 0.9
	}
	if p.Chattiness <= 0 || rng.Float64() >= chance {
		return ""
	}
	return pick(v.replies[kind], 0, rng)
}

// voice is one persona's chat lines: lines per event kind ("kind/opp" for
// the opponents' side of an event) and replies per reply kind.
type voice struct {
	lines   map[string][]string
	replies map[string][]string
}

var genericVoice = &voice{
	lines: map[string][]string{
		"greet":        {"Hallo allemaal!", "Daar zijn we weer, zullen we?", "Daar gaan we, veel plezier!", "Schud ze maar goed!"},
		"trump":        {"Die durf ik wel aan.", "Laten we het proberen.", "Daar gaan we voor.", "Ik speel."},
		"trump/opp":    {"Daar wordt gespeeld.", "We zullen zien.", "Gedurfd.", "Succes ermee."},
		"pass":         {"Pas.", "Niks voor mij.", "Ik laat hem lopen.", "Pas, volgende."},
		"play":         {"Hmm, even denken…", "Daar is ie.", "Die moet maar.", "Hop."},
		"wonTrick":     {"Die is voor ons.", "Mooi zo.", "Die nemen we mee.", "Kijk eens aan."},
		"wonTrick/opp": {"Die is voor jullie.", "Goed gespeeld.", "Jammer.", "Volgende."},
		"roem":         {"Roem!", "Kijk eens aan, roem op tafel.", "Dat telt mooi mee.", "{p} roem erbij!"},
		"roem/opp":     {"Roem voor jullie.", "Hm, {p} roem voor de overkant.", "Dat telt voor jullie.", "Gun ik jullie."},
		"nat":          {"Au, nat…", "Dat liep niet zoals gehoopt.", "Volgende keer beter.", "Nat. Jammer."},
		"natOpp":       {"Nat!", "Die gaan nat!", "Nat, goed tegengehouden.", "Nat, mooi verdedigd."},
		"pit":          {"Pit! Alle slagen!", "Wat een potje!", "Doormars, allemaal voor ons!", "Pit!"},
		"pit/opp":      {"Een pit tegen…", "Alle slagen voor jullie, knap.", "Dat was een pak slaag.", "Pit voor jullie."},
		"handWon":      {"Mooi potje.", "Zo mag ik het zien.", "Dat ging lekker.", "Netjes."},
		"handLost":     {"Jammer.", "Die was voor jullie.", "Volgende potje beter.", "Kan gebeuren."},
		"gameWon":      {"Gewonnen! Bedankt voor het spel.", "Wat een potje, goed gespeeld allemaal!", "Gezellig was het, en gewonnen ook.", "Gewonnen!"},
		"gameLost":     {"Gefeliciteerd, jullie waren beter.", "Goed gespeeld, revanche?", "Volgende keer pakken we jullie.", "Verloren, maar gezellig."},
		"partnerGood":  {"Goed gespeeld, maat!", "Mooi gedaan!", "Zo, die zat.", "Netjes, maat."},
	},
	replies: map[string][]string{
		"hello":    {"Hoi!", "Hallo!", "Hé, gezellig!"},
		"praise":   {"Dank je!", "Jij ook!", "Dank je wel."},
		"gg":       {"gg!", "Goed gespeeld!", "Dank je, jij ook."},
		"laugh":    {"Haha!", "😄", "Gezellig!"},
		"help":     {"Kijk even in de handleiding.", "Eerst bekennen, anders troeven.", "Vraag maar raak."},
		"nat":      {"Dat zien we nog wel!", "Niet te vroeg juichen.", "Het potje is nog niet uit."},
		"nat/maat": {"Zeker weten, die gaan nat!", "Dat zou mooi zijn!", "Nat, nat, nat!"},
		"pech":     {"Volgende keer beter.", "Jammer!", "Kop op!"},
		"sorry":    {"Geeft niks.", "Geen probleem.", "Zand erover."},
		"thanks":   {"Graag gedaan.", "Geen dank.", "Alsjeblieft."},
		"bye":      {"Dag!", "Doei!", "Tot de volgende keer!"},
		"name":     {"Ja?", "Zeg het maar.", "Ik ben er."},
	},
}

var voices = map[string]*voice{
	"dirk": {
		lines: map[string][]string{
			"greet": {
				"Dag allemaal. Zoals we in De Klaver zeggen: eerst de kaarten, dan de praatjes.",
				"Zo, daar zijn we weer. Wie het kleine niet eert, is het grote niet weerd.",
				"Dag! Zestig jaar klaverjassen en nog steeds zin in een potje.",
				"Daar gaan we. Rustig aan en goed tellen, dan komt het goed.",
				"Welkom aan tafel. Oefening baart kunst, zeg ik altijd.",
			},
			"trump": {
				"Vooruit dan maar. Wie niet waagt, die niet wint.",
				"Daar ga ik voor. Een goed begin is het halve werk.",
				"Die neem ik. Bezint eer ge begint, en ik heb me bezonnen.",
				"Hij is gekozen. Nu niet meer twijfelen.",
				"Zo, die keuze is gemaakt. Geen gezeur achteraf.",
			},
			"trump/opp": {
				"Zo zo, daar wordt gespeeld. We zullen zien.",
				"Hoogmoed komt voor de val, maar misschien heb je gelijk.",
				"Gedurfd. Maar je moet de dag niet prijzen voor het avond is.",
				"Goed, dan weten we waar we aan toe zijn.",
			},
			"pass": {
				"Pas. Beter een half ei dan een lege dop, maar dit is een lege dop.",
				"Ik pas. Bezint eer ge begint.",
				"Pas, jongens. Voorzichtigheid is de moeder van de porseleinkast.",
				"Niks voor mij. Pas.",
				"Pas. Wie zijn billen brandt, moet op de blaren zitten, en ik zit liever zonder blaren.",
			},
			"play": {
				"Haastige spoed is zelden goed.",
				"Hmm. Even nadenken, dat kost niks.",
				"Die moet maar.",
				"Zo. Daar is ie.",
			},
			"wonTrick": {
				"Die is binnen. Zuinigheid met vlijt bouwt huizen als kastelen.",
				"Mooi, die nemen we mee.",
				"Vele kleintjes maken een grote.",
				"Zo gaat dat. Rustig blijven tellen.",
			},
			"wonTrick/opp": {
				"Gun ze hem maar. Wie het laatst lacht, lacht het best.",
				"Ach, die was voor jullie.",
				"Het is nog geen tijd om te treuren.",
				"Goed gespeeld, dat moet ik toegeven.",
			},
			"roem": {
				"Roem! Dat is mooi meegenomen.",
				"{p} roem. Zestig jaar en het blijft leuk.",
				"Kijk eens aan, roem op tafel.",
				"Die {p} roem nemen we graag mee.",
				"Beter één vogel in de hand dan tien in de lucht: {p} roem.",
			},
			"roem/opp": {
				"Tja, {p} roem voor jullie. Daar is niks aan te doen.",
				"Roem voor de overkant. Het zit even tegen.",
				"Hm, dat had ik liever niet gezien.",
				"Gun het ze maar, het is nog vroeg.",
			},
			"nat": {
				"Nat. Hoogmoed komt voor de val, ik had het kunnen weten.",
				"Tja. Wie zijn billen brandt, moet op de blaren zitten.",
				"Nat gegaan. Volgende keer beter, zoals mijn vrouw altijd zei.",
				"Dat was te veel gevraagd. Ik ben er stil van.",
				"Nat. Je moet niet te veel hooi op je vork nemen, en dat deed ik wel.",
			},
			"natOpp": {
				"Nat! Wie het onderste uit de kan wil hebben, krijgt het lid op de neus.",
				"Zo, die gaan nat. Dat mag gezegd worden.",
				"Nat. Ik zei het toch: bezint eer ge begint.",
				"Dat liep mis voor de overkant. Jammer voor ze, mooi voor ons.",
			},
			"pit": {
				"Pit! In zestig jaar went dat nooit.",
				"Alle slagen! Eendracht maakt macht.",
				"Een pit, prachtig. Daar drinken we er een op.",
				"Pit. Dat noem ik nog eens samenspelen.",
			},
			"pit/opp": {
				"Een pit tegen. Dat overkomt de besten.",
				"Alle slagen voor jullie. Petje af.",
				"Pit tegen ons. Na regen komt zonneschijn.",
				"Dat was een pak slaag. Ik heb het overleefd.",
			},
			"handWon": {
				"Een mooi potje. Zo hoort het.",
				"Netjes. Zo bouwen we het op.",
				"Gaat goed zo. Niet te vroeg juichen.",
				"Mooi zo. Langzaam maar zeker.",
			},
			"handLost": {
				"Dit potje was voor jullie.",
				"Tja. Het kan niet altijd zondag zijn.",
				"Volgende potje beter.",
				"We hebben het nog niet verloren hoor.",
			},
			"gameWon": {
				"Gewonnen! Bedankt voor het gezellige potje.",
				"Het spel is uit en wij staan voor. Dank jullie wel.",
				"Zo, dat was een mooi spel. Gewonnen ook nog.",
				"Gewonnen. Oude liefde roest niet.",
			},
			"gameLost": {
				"Gefeliciteerd, jullie waren vandaag beter.",
				"Verloren, maar met plezier. Revanche?",
				"Jullie hebben het verdiend. Ik ga er eens goed over nadenken.",
				"Je wint wat, je verliest wat. Goed gespeeld.",
			},
			"partnerGood": {
				"Goed gespeeld, maat.",
				"Mooi gedaan. Jij hebt het begrepen.",
				"Zo zie ik het graag.",
				"Netjes. Zo spelen ze het in De Klaver ook.",
			},
		},
		replies: map[string][]string{
			"hello":    {"Dag!", "Hallo, welkom aan tafel.", "Dag! Ga zitten, de kaarten liggen klaar.", "Hoi. Gezellig dat je er bent."},
			"praise":   {"Dank je. Oefening baart kunst.", "Dat leer je na zestig jaar vanzelf.", "Dank je wel, jij ook.", "Mooi dat je het ziet."},
			"gg":       {"Goed gespeeld, allemaal.", "gg, zoals de jongelui zeggen.", "Dank je, het was me een genoegen."},
			"laugh":    {"Hè hè, gezellig zo.", "Lachen is gezond.", "Haha, ja hoor."},
			"help":     {"Kijk in de handleiding, daar staat het netjes uitgelegd.", "Eerst bekennen, dan pas troeven. Dat is het halve werk.", "Rustig tellen: hoeveel troeven zijn er al geweest?"},
			"nat":      {"Niet te vroeg juichen, het potje is nog niet uit.", "Nat? Dat zien we straks wel.", "Wie het laatst lacht, lacht het best."},
			"nat/maat": {"Zo is het, maat. Die gaan nat.", "Niet te hard roepen, maar je hebt gelijk.", "Geduld, maat. Wie wacht, die wint."},
			"pech":     {"Dat hoort erbij. Na regen komt zonneschijn.", "Volgende keer beter.", "Pech bestaat, maar tellen helpt."},
			"sorry":    {"Geeft niks, het is maar een spelletje.", "Zand erover.", "Ach, iedereen maakt fouten."},
			"thanks":   {"Graag gedaan.", "Geen dank.", "Alsjeblieft hoor."},
			"bye":      {"Dag! Tot de volgende keer.", "Het ga je goed, en kom goed thuis.", "Tot ziens, het was gezellig."},
			"name":     {"Ja? Ik zit hier hoor.", "Zeg het maar.", "Ik ben er nog, hoor. Ik denk alleen wat langzamer."},
		},
	},
	"truus": {
		lines: map[string][]string{
			"greet": {
				"Hallo hallo! Wat gezellig, zullen we er een mooi potje van maken?",
				"Ha, daar zijn jullie! Ik heb er zó'n zin in.",
				"Hallo schatjes! Ik voel het, vandaag valt de roem op tafel.",
				"Hoi allemaal! Heeft iedereen koffie? Dan beginnen we.",
				"Daar zijn we weer! Ik zei net nog tegen de buurvrouw: ik ga lekker klaverjassen.",
			},
			"trump": {
				"Ik waag het erop! Het komt vast goed.",
				"Ach, gewoon doen. Wat kan er nou misgaan?",
				"Ja hoor, ik speel. Ik heb een goed gevoel bij deze.",
				"Spannend! Ik ga ervoor.",
				"Kom op, dat wordt een mooi potje.",
			},
			"trump/opp": {
				"Oei, jij durft! Succes hoor.",
				"Zo, dat klinkt zelfverzekerd!",
				"Spannend, eens kijken of het lukt.",
				"Nou, laat maar zien wat je kunt!",
			},
			"pass": {
				"Ik pas, maar ik heb nog alle hoop hoor.",
				"Pas! Volgende keer beter.",
				"Nee, deze laat ik even gaan.",
				"Pas. Ik houd mijn kruit droog.",
			},
			"play": {
				"Eens kijken… deze!",
				"Daar gaat ie!",
				"Oei, spannend.",
				"Hup, op tafel ermee.",
			},
			"wonTrick": {
				"Die is voor ons, heerlijk!",
				"Kijk eens aan! Hoppa.",
				"Ja! Zo mag ik het zien.",
				"Die nemen we mee, dankjewel!",
			},
			"wonTrick/opp": {
				"Ach, gun het ze maar.",
				"Oké, die is voor jullie. Volgende!",
				"Geeft niks, we halen het wel in.",
				"Zo, die was mooi gespeeld.",
			},
			"roem": {
				"Roem!! Daar word ik nou blij van!",
				"{p} roem, dat is genieten!",
				"Kijk dan, roem op tafel! Hebben jullie dat gezien?",
				"Heerlijk, {p} roem erbij. Dit is mijn favoriete moment.",
				"Ooh, roem! Ik zei het toch, vandaag valt de roem.",
			},
			"roem/opp": {
				"Ach, {p} roem voor jullie. Ook leuk om te zien hoor.",
				"Roem voor de overkant! Nou ja, gun ik ze best.",
				"Oei, die roem had ik zelf wel gewild.",
				"Mooi hoor, al was het niet voor ons.",
			},
			"nat": {
				"Oei, nat! Nou ja, het was het proberen waard.",
				"Nat… Volgende keer zit het mee, ik voel het.",
				"Ach, nat gegaan. Daar maken we ons niet druk om.",
				"Hè, jammer! Maar niet getreurd hoor.",
			},
			"natOpp": {
				"Nat! Oh, sorry hoor, maar ik moet er wel om lachen.",
				"Die gaan nat! Wat spannend.",
				"Nat! Nou, dat had ik niet zien aankomen.",
				"Ai, nat voor jullie. Volgende keer beter, lieverds.",
			},
			"pit": {
				"PIT! Ik krijg er kippenvel van!",
				"Alle slagen! Dat moet ik straks aan de buurvrouw vertellen.",
				"Een pit! Wat een heerlijk potje!",
				"Pit! Daar doe ik het voor!",
			},
			"pit/opp": {
				"Een pit voor jullie, knap hoor!",
				"Oei, alle slagen. Nou ja, mooi gespeeld.",
				"Pit tegen! Dat zie je ook niet elke dag.",
				"Jullie pakten ze allemaal! Gefeliciteerd.",
			},
			"handWon": {
				"Wat een fijn potje!",
				"Zo, die is binnen. Lekker hoor.",
				"Heerlijk, zo gaat het goed.",
				"Weer een potje voor ons! Wie wil er nog koffie?",
			},
			"handLost": {
				"Ach, het volgende potje is voor ons.",
				"Geeft niks, gezellig is het toch.",
				"Nou, die was voor jullie. Gun ik jullie best.",
				"Volgende keer beter, ik heb er alle vertrouwen in.",
			},
			"gameWon": {
				"Gewonnen! Wat een heerlijk spel, dank jullie wel!",
				"Joepie, gewonnen! Zullen we er nog een doen?",
				"Gewonnen! Ik ga dit morgen aan iedereen vertellen.",
				"Wat een feest! Bedankt allemaal, het was supergezellig.",
			},
			"gameLost": {
				"Verloren, maar wat was het gezellig!",
				"Gefeliciteerd! Jullie hebben het verdiend hoor.",
				"Ach, verloren. Volgende keer nemen we revanche!",
				"Goed gespeeld allemaal. Ik heb genoten.",
			},
			"partnerGood": {
				"Wat speel jij goed, zeg!",
				"Prachtig gedaan, maatje!",
				"Ooh, die zat! Knap hoor.",
				"Wij zijn een goed team, hè?",
			},
		},
		replies: map[string][]string{
			"hello":    {"Hoi hoi! Wat leuk dat je er bent!", "Hallo! Ga lekker zitten.", "Hallo! Zin in een potje?", "Hé, daar ben je! Gezellig!"},
			"praise":   {"Ach, dankjewel! Jij ook hoor!", "Wat lief van je!", "Dankjewel! Ik doe gewoon maar wat hoor.", "Haha, dank je, ik geniet ervan."},
			"gg":       {"gg! Wat was het gezellig.", "Goed gespeeld, allemaal!", "Dank je! Nog eentje?"},
			"laugh":    {"Hahaha! Gezellig hè?", "Hihi!", "Haha, ik lig dubbel."},
			"help":     {"Kijk even in de handleiding, daar staat het mooi in.", "Gewoon bekennen als het kan, en anders troeven. Het komt goed!", "Geeft niks hoor, je leert het vanzelf."},
			"nat":      {"Ach, nat of niet, gezellig is het toch!", "Nou nou, niet te hard roepen hoor!", "We zien wel, het potje is nog niet voorbij."},
			"nat/maat": {"Oh, wat zou dat mooi zijn!", "Ja hè? Die gaan nat!", "Spannend! Ik duim met je mee."},
			"pech":     {"Ach, volgende keer zit het mee!", "Jammer hè? Maar we hebben plezier.", "Kop op, het komt goed!"},
			"sorry":    {"Ach, geeft toch niks!", "Geen probleem, schat.", "Overkomt de besten!"},
			"thanks":   {"Graag gedaan!", "Geen dank, lieverd!", "Alsjeblieft!"},
			"bye":      {"Dag! Tot de volgende keer!", "Doei! Het ga je goed.", "Dag dag, het was gezellig!"},
			"name":     {"Ja, wat is er, lieverd?", "Hier ben ik!", "Ja? Ik zat net even te kletsen."},
		},
	},
	"sjaak": {
		lines: map[string][]string{
			"greet": {
				"Mannen, dames. Ik voel me vandaag onoverwinnelijk.",
				"Hé! De inzet is een pit, verder niks.",
				"Daar is Sjaak. Wie durft?",
				"Hé! Ik heb geluk meegenomen, genoeg voor iedereen.",
				"Zo. Laat de kaarten maar komen, ik ben in vorm.",
			},
			"trump": {
				"Spelen natuurlijk. Wie niet waagt, die niet wint.",
				"Ik speel. Dunne hand? Bestaat niet.",
				"Alles of niks, zoals altijd.",
				"Ik speel. En ik ga voor de pit.",
				"Kijk maar niet zo bang, ik weet wat ik doe. Meestal.",
			},
			"trump/opp": {
				"Jij durft. Dat vind ik mooi.",
				"Zo, daar gaan we. Hou je vast.",
				"Te weinig, als je het mij vraagt.",
				"Dat gaat nat. Ik voel het.",
			},
			"pass": {
				"Pas. Ook een gokker moet soms ademhalen.",
				"Pas… voor deze ene keer.",
				"Ik pas, maar alleen omdat ik jullie een kans wil geven.",
				"Pas. Volgende ronde ga ik all-in.",
			},
			"play": {
				"Hop.",
				"Daar.",
				"Let maar op wat er nu gebeurt.",
				"Deze wordt legendarisch.",
			},
			"wonTrick": {
				"Zie je wel. Geluk is ook een vak.",
				"Hebbes.",
				"Die wist ik gewoon.",
				"Kassa! Zo gaan we het doen.",
			},
			"wonTrick/opp": {
				"Mag je hebben. Die had ik ingecalculeerd.",
				"Een gokje dat net verkeerd viel.",
				"Rustig, het komt nog.",
				"Ach, die kost niks.",
			},
			"roem": {
				"{p} roem. Precies volgens plan.",
				"Roem! Wat zei ik nou?",
				"Daar ligt het. Roem op tafel.",
				"Roem, hè? Dat had ik allang gezien.",
			},
			"roem/opp": {
				"{p} roem voor jullie. Mazzelaars.",
				"Pure mazzel, die roem.",
				"Geniet er maar van, het draait zo weer.",
				"Roem voor jullie? Dat zag ik niet aankomen. Echt niet.",
			},
			"nat": {
				"Nat. Hoort bij het vak.",
				"Nat gegaan. Volgende keer pak ik ze allemaal.",
				"Dat was een gok. Een slechte.",
				"Nat. Maar wel met stijl, toch?",
			},
			"natOpp": {
				"Nat! Dat zei ik toch?",
				"Hahaha, nat! Voorspeld.",
				"Nat. Daar had ik op gegokt.",
				"Nat. Kom maar op met dat volgende potje.",
			},
			"pit": {
				"PIT! Zie je wel, zie je wel!",
				"Alle slagen. Hier speel ik voor.",
				"Pit! Schrijf maar op: Sjaak was hier.",
				"Doormars! Ik zei toch dat ik voor de pit ging.",
			},
			"pit/opp": {
				"Een pit tegen? Dat overkomt mij nooit. Behalve nu.",
				"Alle slagen voor jullie. Respect, eerlijk is eerlijk.",
				"Pit tegen ons. Ik ga even diep ademhalen.",
				"Zo. Dat was een pak rammel.",
			},
			"handWon": {
				"Weer raak.",
				"Makkelijk zo.",
				"Zie je, durven loont.",
				"Die nemen we mee. Volgende!",
			},
			"handLost": {
				"Mag je hebben. De volgende is voor ons.",
				"Even een dipje.",
				"Ik spaar mijn geluk op voor straks.",
				"Te voorzichtig gespeeld. Dat gebeurt me niet nog eens.",
			},
			"gameWon": {
				"Gewonnen! Geluk en lef, daar gaat het om.",
				"Gewonnen. Wie durft er nog een keer?",
				"Ha! Gewonnen. Niemand die het zag aankomen, behalve ik.",
				"Gewonnen. Ik neem de pot mee.",
			},
			"gameLost": {
				"Verloren. Volgende keer verdubbelen we de inzet.",
				"Jullie hadden mazzel. Revanche!",
				"Verloren, maar wat een spektakel.",
				"Gefeliciteerd. Geniet ervan, het duurt niet lang.",
			},
			"partnerGood": {
				"Lekker bezig, maat!",
				"Dat is lef. Mooi.",
				"Jij en ik, wij gaan voor de pit.",
				"Kijk eens aan, een natuurtalent.",
			},
		},
		replies: map[string][]string{
			"hello":    {"Hé! Kom je verliezen?", "Yo. Klaar voor een gokje?", "Hallo! Ik voel me goed vandaag.", "Hoi. De inzet is een pit."},
			"praise":   {"Weet ik.", "Dank je. Een kwestie van lef.", "Ha, dat is nog niks.", "Wacht maar tot de pit."},
			"gg":       {"gg. Volgende keer pak ik ze allemaal.", "Goed gespeeld. Revanche?", "gg, mazzelaars."},
			"laugh":    {"Haha, lach maar, ik heb nog wat achter de hand.", "Lach jij maar.", "Ha!"},
			"help":     {"Gewoon durven. En de handleiding lezen, als je van saai houdt.", "Tip van Sjaak: speel nooit te voorzichtig.", "Bekennen, troeven, en verder op je gevoel."},
			"nat":      {"Nat? Wij? Nooit.", "Wacht maar af.", "Roep maar niet te hard."},
			"nat/maat": {"Nat! Daar zet ik alles op.", "Zeker weten. Ik voel het.", "Dat zei ik toch!"},
			"pech":     {"Pech bestaat niet, alleen gokken die nog niet goed vielen.", "Volgende keer beter. Zeker weten.", "Kop op, het draait altijd."},
			"sorry":    {"Geeft niks. Ik zit er ook weleens naast.", "Vergeven en vergeten.", "Zand erover."},
			"thanks":   {"Graag gedaan.", "Geen dank. Ik win toch wel.", "Altijd."},
			"bye":      {"Doei! Volgende keer de pit.", "Ga je al? Net nu het leuk wordt.", "Ciao!"},
			"name":     {"Ja? Wil je een gokje wagen?", "Sjaak luistert.", "Wat is er? Ik zit te rekenen. Grapje."},
		},
	},
	"fatima": {
		lines: map[string][]string{
			"greet": {
				"Hoi. 32 kaarten, 4 spelers. Beginnen.",
				"Hallo. Succes, allemaal.",
				"Hallo. Ik tel mee.",
				"Hoi. 162 punten per potje. Laten we gaan.",
				"Hallo. Zin in wat kansrekening.",
			},
			"trump": {
				"Gekozen. Kansen berekend.",
				"Ik speel. Kans is groot genoeg.",
				"Deze. Doorgerekend.",
				"Spelen.",
				"Ja. 82 punten nodig, haalbaar.",
			},
			"trump/opp": {
				"Interessante keuze.",
				"Genoteerd.",
				"Even herberekenen.",
				"Oké. 82 punten halen dan.",
			},
			"pass": {
				"Pas. Kans te klein.",
				"Pas.",
				"Pas. Verwachtingswaarde negatief.",
				"Nee. Pas.",
			},
			"play":     {"Logisch.", "Deze.", "Geteld.", "Volgens de som."},
			"wonTrick": {"Slag.", "Zoals berekend.", "Plus 1.", "Klopt."},
			"wonTrick/opp": {
				"Verwacht.",
				"Prima. Ingecalculeerd.",
				"Die mocht weg.",
				"Oké.",
			},
			"roem": {"+{p} roem.", "{p} roem. Genoteerd.", "Roem. Mooi meegenomen.", "Roem: {p}. Klopt."},
			"roem/opp": {
				"{p} roem voor jullie. Genoteerd.",
				"Roem tegen. Toeval.",
				"Hm. {p} erbij voor jullie.",
				"Genoteerd.",
			},
			"nat":     {"Nat. Statistisch kon het.", "Nat. Foutje in de som.", "Nat. Ik reken het na.", "Nat. 1 op de 4. Gebeurt."},
			"natOpp":  {"Nat. Niet meer dan de helft.", "Nat. Klopt.", "Nat. 162 plus roem voor ons.", "Nat. Zoals verwacht."},
			"pit":     {"Pit. 8 van de 8.", "Alle slagen. +100.", "Pit. Optimaal.", "8/8. Mooi."},
			"pit/opp": {"Pit tegen. Zeldzaam.", "8 van de 8 voor jullie. Netjes.", "Pit. Daar valt weinig aan te rekenen.", "Hm. Pit. Uitzonderlijk."},
			"handWon": {"Potje binnen.", "Plus. Goed.", "Klopt.", "Volgens plan."},
			"handLost": {
				"Min. Volgende.",
				"Potje weg. Kan gebeuren.",
				"Even achter. Variantie.",
				"Oké. Volgende potje.",
			},
			"gameWon": {
				"Gewonnen. Bedankt voor het spel.",
				"Gewonnen. Gunstige variantie vandaag.",
				"Winst. Goed gespeeld, allemaal.",
				"Gewonnen. De som klopte.",
			},
			"gameLost": {
				"Verloren. Goed gespeeld.",
				"Verloren. Gefeliciteerd.",
				"Verloren. Ik ga het nalopen.",
				"Jullie wonnen. Terecht.",
			},
			"partnerGood": {"Goed.", "Precies goed.", "Optimaal gespeeld, maat.", "Klopt helemaal."},
		},
		replies: map[string][]string{
			"hello":    {"Hoi.", "Hallo.", "Hoi. Succes.", "Hallo. Tellen jullie mee?"},
			"praise":   {"Dank je.", "Gewoon tellen.", "Dank je. Jij ook.", "Klopt."},
			"gg":       {"gg.", "gg. Goed gespeeld.", "gg, wp."},
			"laugh":    {"Haha.", ":)", "Grappig."},
			"help":     {"Handleiding, onder het vraagteken.", "Tel de troeven. Er zijn er 8.", "Eerst bekennen. Dan troeven."},
			"nat":      {"Eerst tellen.", "Nog niet. Reken maar na.", "Kans is klein."},
			"nat/maat": {"Klopt. Ze komen tekort.", "Waarschijnlijk, ja.", "Eens. Nat."},
			"pech":     {"Variantie.", "Kansen middelen uit.", "Volgende keer beter."},
			"sorry":    {"Geeft niks.", "Oké.", "Geen probleem."},
			"thanks":   {"Graag gedaan.", "Geen dank.", "👍"},
			"bye":      {"Doei.", "Dag.", "Tot ziens."},
			"name":     {"Ja?", "Ik tel.", "Zeg het maar."},
		},
	},
	"kees": {
		lines: map[string][]string{
			"greet": {
				"Ja ja, hallo. Laten we maar beginnen.",
				"Dag. Ik hoop dat de kaarten vandaag beter zijn dan vorige week.",
				"Daar zitten we weer. Schud ze maar goed, anders krijg ik weer niks.",
				"Hallo. Ik had liever aan de waterkant gezeten, maar goed.",
				"Dag. Geen gezeur, gewoon spelen.",
			},
			"trump": {
				"Ik speel wel. Iemand moet het doen.",
				"Vooruit. Maar als het misgaat, ligt het aan de kaarten.",
				"Ik speel. Niet dat ik er veel zin in heb.",
				"Deze dan maar. Het is niet anders.",
				"Goed, ik speel. Hou je vast.",
			},
			"trump/opp": {
				"Hm. Dat gaat nat, let maar op.",
				"Moet jij weten.",
				"Nou, daar gaan we weer.",
				"Lef heb je wel, dat moet ik je nageven.",
			},
			"pass": {
				"Pas. Met deze rommel ga ik niet spelen.",
				"Pas. Wat een kaarten weer.",
				"Pas, natuurlijk. Het zit me niet mee vandaag.",
				"Pas. Ik krijg ook nooit wat.",
			},
			"play": {"Vooruit dan.", "Daar.", "Mwah. Deze maar.", "Niet best, maar goed."},
			"wonTrick": {
				"Eindelijk eens wat.",
				"Die is voor ons. Werd tijd.",
				"Kijk, zo moet het.",
				"Hm. Die mag.",
			},
			"wonTrick/opp": {
				"Natuurlijk. Weer voor jullie.",
				"Ja hoor. Daar gaat ie weer.",
				"Nou, mooi is dat.",
				"Tja. Wat moet je ermee.",
			},
			"roem": {
				"Roem. Mag ook weleens.",
				"{p} roem. Niet slecht.",
				"Kijk eens aan. Het zit een keer mee.",
				"Roem voor ons, eindelijk.",
			},
			"roem/opp": {
				"En jullie krijgen er ook nog {p} roem bij. Natuurlijk.",
				"Roem voor jullie. Hoe kan het ook anders.",
				"Pfff. Roem ook nog.",
				"Het zit ze mee, hoor.",
			},
			"nat": {
				"Nat! Ik wist het. Wat een kaarten.",
				"Nat. Daar baal ik nou echt van.",
				"Nat gegaan. Dat krijg je ervan.",
				"Nat… Ik zeg maar niks meer.",
				"Nat! Met zulke kaarten kan ik er ook niks aan doen.",
			},
			"natOpp": {
				"Nat! Zie je wel. Te gretig.",
				"Haha, nat. Daar heb ik nou zin in.",
				"Nat. Net goed.",
				"Nat. Dat zag ik al aankomen.",
			},
			"pit": {
				"Pit. Dat had ik vandaag niet meer verwacht.",
				"Alle slagen. Nou, mag ik ook eens.",
				"Een pit. Kijk, zo kan het ook.",
				"Pit! Ik zeg het niet vaak, maar dat was mooi.",
			},
			"pit/opp": {
				"Een pit tegen. Typisch.",
				"Alle slagen voor jullie. Ja hoor.",
				"Pit. Ik ga maar weer vissen.",
				"Pfff. Pit tegen. Wat een dag.",
			},
			"handWon": {
				"Kijk. Zo kan het ook.",
				"Die is binnen. Niet slecht.",
				"Ja, dat was niet verkeerd.",
				"Mooi. Nu nog even volhouden.",
			},
			"handLost": {
				"Natuurlijk weer voor jullie.",
				"Tja. Wat had je dan verwacht met deze kaarten.",
				"Weer mis. Het zit niet mee.",
				"Hm. Volgende maar.",
			},
			"gameWon": {
				"Gewonnen. Zie je wel, het kan dus wel.",
				"Gewonnen. Ik ga tevreden naar huis.",
				"Gewonnen. Dat had ik niet verwacht, eerlijk is eerlijk.",
				"Gewonnen. Goed gespeeld, allemaal.",
			},
			"gameLost": {
				"Verloren. Met deze kaarten was er niks aan te doen.",
				"Verloren. Gefeliciteerd, al zat het jullie wel mee.",
				"Verloren. Volgende keer krijg ik betere kaarten, hoop ik.",
				"Jullie waren beter vandaag. Dat moet ik toegeven.",
			},
			"partnerGood": {
				"Goed gespeeld, maat. Echt waar.",
				"Mooi. Dat had ik zelf niet beter gedaan.",
				"Ja, zo moet het.",
				"Netjes, maat.",
			},
		},
		replies: map[string][]string{
			"hello":    {"Ja ja, hallo.", "Dag.", "Hoi. Ga zitten, dan kunnen we beginnen.", "Hallo. Schud ze maar."},
			"praise":   {"Ja, nou ja. Dank je.", "Het ging toevallig goed.", "Mwah. Dank je.", "Zeldzaam, maar het gebeurt."},
			"gg":       {"gg. Al zat het niet mee.", "Ja, goed gespeeld.", "gg. Volgende keer betere kaarten graag."},
			"laugh":    {"Ja, lach maar.", "Haha. Heel grappig.", "Lachen jullie maar."},
			"help":     {"Bekennen als je kan. Anders troeven. Zo moeilijk is het niet.", "Kijk in de handleiding. Daar staat alles.", "Tel de troeven, dan weet je wat er nog zit."},
			"nat":      {"Nat? Dat zullen we nog wel eens zien.", "Ja ja, roep maar.", "Het is nog niet voorbij."},
			"nat/maat": {"Mooi zo. Dat werd tijd.", "Ja, die gaan nat, let maar op.", "Eindelijk eens wat goeds."},
			"pech":     {"Pech? Ik heb de hele dag al pech.", "Welkom bij de club.", "Ja, dat ken ik."},
			"sorry":    {"Ja, nou ja. Geeft niks.", "Gebeurd is gebeurd.", "Volgende keer beter opletten."},
			"thanks":   {"Ja, graag gedaan.", "Mwah, geen dank.", "Ja ja."},
			"bye":      {"Dag.", "Ga je al? Nou, doei.", "Tot ziens. Ik ga vissen."},
			"name":     {"Wat?", "Ja, wat is er?", "Ik zit hier, hoor."},
		},
	},
	"ans": {
		lines: map[string][]string{
			"greet": {
				"Hallo allemaal! Fijn dat jullie er zijn. Veel plezier!",
				"Hallo! Vragen staat vrij, hoor. Daar zijn we voor.",
				"Welkom! Neem rustig de tijd voor elke kaart.",
				"Hoi! Weet je nog? Eerst bekennen, dan pas troeven. Zet 'm op!",
				"Daar zijn we! Ik heb er zin in. Samen komen we er wel uit.",
			},
			"trump": {
				"Ik speel. Nu moeten we wel meer dan de helft van de punten halen, hè.",
				"Deze kies ik. Let maar op hoe ik de troeven eruit haal.",
				"Ik speel! Weet je nog? Wie speelt, moet meer dan 81 punten halen.",
				"Gekozen. Nu eerst de troeven bij de tegenstanders weghalen.",
				"Ik waag het. Help je mee, maat?",
			},
			"trump/opp": {
				"Goed zo, een duidelijke keuze!",
				"Mooi. Nu moeten ze meer dan de helft halen.",
				"Spannend! Wij gaan proberen ze nat te spelen.",
				"Prima keuze, volgens mij.",
			},
			"pass": {
				"Ik pas. Soms is niet spelen de slimste zet.",
				"Pas. Deze kleur laat ik liever aan een ander.",
				"Ik pas. Liever geen risico op nat.",
				"Pas. Even afwachten wat de anderen doen.",
			},
			"play": {
				"Eens kijken wat er al gevallen is…",
				"Even goed tellen…",
				"Goed opletten wat er nog zit.",
				"Zo. Rustig aan.",
			},
			"wonTrick": {
				"Die slag is voor ons. Zie je hoe dat ging?",
				"Mooi zo, die nemen we mee.",
				"Kijk, de hoogste kaart wint.",
				"Die is binnen. Goed opgelet!",
			},
			"wonTrick/opp": {
				"Die was voor hen. Geeft niks, we hebben er nog genoeg.",
				"Goed gespeeld van de overkant.",
				"Die gaat naar hen. Let even op wat er al gevallen is.",
				"Oké, die is weg. Volgende slag nieuwe kansen.",
			},
			"roem": {
				"Roem! {p} punten extra, die tellen gewoon mee.",
				"Kijk, roem op tafel: {p} punten erbij voor ons.",
				"Roem! Wie de slag wint, krijgt de roem.",
				"Mooi, {p} roem. Daarom let je ook op kaarten op een rij.",
			},
			"roem/opp": {
				"{p} roem voor hen. Die krijg je als je de slag wint.",
				"Roem voor de overkant. Soms valt het zo.",
				"Hm, {p} roem voor hen. Volgende keer pakken wij die slag.",
				"Roem voor hen. Goed om te onthouden: wie de slag wint, krijgt de roem.",
			},
			"nat": {
				"Nat. We haalden niet meer dan de helft. Daar leren we van!",
				"Oei, nat. Dan krijgen de anderen alle punten.",
				"Nat gegaan. Geeft niks, zo leer je welke troef sterk genoeg is.",
				"Nat. Volgende keer iets voorzichtiger.",
			},
			"natOpp": {
				"Nat! Zij haalden niet meer dan de helft, dus wij krijgen alles.",
				"Ze gaan nat! Goed verdedigd, maat.",
				"Nat! Zie je? Samen verdedigen loont.",
				"Nat voor de overkant. Knap gespeeld!",
			},
			"pit": {
				"Pit! Alle acht slagen, en 100 punten extra!",
				"Een pit! Wat hebben we dat mooi samen gedaan.",
				"Alle slagen! Dat heet pit, of doormars.",
				"Pit! Daar mag je trots op zijn.",
			},
			"pit/opp": {
				"Een pit voor hen. Dat kan gebeuren als alle troeven aan één kant zitten.",
				"Alle slagen voor hen. Knap gespeeld!",
				"Pit tegen. Niet getreurd, het volgende potje is nieuw.",
				"Oei, een pit. Kijk eens terug naar de slagen, daar leer je veel van.",
			},
			"handWon": {
				"Mooi potje! Goed gedaan.",
				"Dat ging goed. Zie je hoe de troeven het werk deden?",
				"Potje binnen. Zo gaan we door!",
				"Goed gespeeld, dit potje is voor ons.",
			},
			"handLost": {
				"Dit potje was voor hen. Bekijk de slagen van dit potje gerust nog eens.",
				"Geeft niks, van verliezen leer je het meest.",
				"Volgende potje nieuwe kansen.",
				"Jammer. Maar je deed het goed hoor.",
			},
			"gameWon": {
				"Gewonnen! Goed gespeeld allemaal, en bedankt voor het spel.",
				"We hebben gewonnen! Bedankt voor het fijne spel.",
				"Gewonnen! Zo zie je maar: goed tellen loont.",
				"Gewonnen! Een mooie boom was dat.",
			},
			"gameLost": {
				"Verloren, maar wat hebben we veel geleerd!",
				"Gefeliciteerd aan de winnaars! Goed gespeeld.",
				"Verloren. Volgende keer pakken we ze, samen.",
				"Jammer! Maar het was een leerzaam potje.",
			},
			"partnerGood": {
				"Heel goed gespeeld, maat!",
				"Precies goed! Zo doe je dat.",
				"Mooi! Dat had ik zelf niet beter kunnen uitleggen.",
				"Goed gezien! Zo leer je het snel.",
				"Super! Je gaat met sprongen vooruit.",
			},
		},
		replies: map[string][]string{
			"hello":  {"Hallo! Fijn dat je er bent.", "Hoi! Klaar om te leren?", "Hoi! Welkom aan tafel.", "Hallo! Vragen mag altijd, hoor."},
			"praise": {"Dank je wel! Jij doet het ook heel goed.", "Wat lief! Je leert snel.", "Dank je! Goed opletten, dat is het geheim.", "Dank je! Samen spelen we sterk."},
			"gg":     {"Goed gespeeld, allemaal!", "gg! Wat was het leerzaam.", "Goed gedaan! Nog een potje?"},
			"laugh":  {"Haha! Leuk hè?", "Gezellig zo!", "Hihi, lachen mag altijd."},
			"help": {
				"Je moet altijd bekennen. Kun je dat niet, dan moet je meestal troeven.",
				"Kijk in de handleiding onder het vraagteken: daar staan de regels en tips.",
				"Tel de troeven: er zijn er acht. Dan weet je wat er nog zit.",
				"Heeft je maat de slag? Dan kun je hem spekken, bijvoorbeeld met een 10.",
			},
			"nat":      {"Nog even afwachten, het potje is nog niet voorbij!", "Wij moeten meer dan de helft halen, en dat kan nog!", "Spannend hè? Tellen maar!"},
			"nat/maat": {"Goed gezien! Ze moeten meer dan de helft halen.", "Misschien wel! Blijven tellen, maat.", "Samen spelen we ze nat!"},
			"pech":     {"Pech hoort erbij. Volgende keer beter!", "Geeft niks hoor, zo leer je.", "Kop op, je doet het goed!"},
			"sorry":    {"Geeft helemaal niks! Zo leer je het.", "Niks aan de hand.", "Fouten maken mag, daar leer je van."},
			"thanks":   {"Graag gedaan!", "Geen dank, daar ben ik voor.", "Alsjeblieft!"},
			"bye":      {"Dag! Goed gespeeld vandaag.", "Tot de volgende keer!", "Doei! Blijf oefenen hoor."},
			"name":     {"Ja? Vraag maar.", "Ik ben er! Wat wil je weten?", "Ja, zeg het maar."},
		},
	},
	"bram": {
		lines: map[string][]string{
			"greet":        {"Yo! 👋 Gaan met die banaan 🍌", "Hoi allemaal 😎", "Klaar? 🃏🔥", "Ey! Zin in 🙌", "Hallo hallo 👋 lekker vlot spelen hè"},
			"trump":        {"Spelen 💪", "Yes, deze 🔥", "Gevoel zegt spelen 🤙", "Ik ga ervoor 🚀", "Makkie 😎"},
			"trump/opp":    {"Oeh 👀", "Spannend 😬", "Durf 😏", "Oké oké 👀"},
			"pass":         {"Pas 🤷", "Nee joh 🙅", "Pas, volgende 😴", "Nah, pas ✌️"},
			"play":         {"👀", "Hop 🃏", "Deze 🤙", "Boem 💥"},
			"wonTrick":     {"Hebbes 😎", "💪💪", "Lekker 🔥", "Yes! 🙌"},
			"wonTrick/opp": {"Oké 😅", "Balen 😩", "Mag je hebben 🤷", "Pff 😤"},
			"roem":         {"ROEM 🎉", "+{p} 🔥🔥", "Roem! 🤑", "Lekker, {p} roem 😎"},
			"roem/opp":     {"Pff, {p} roem voor jullie 😒", "Roem tegen 😩", "Balen, roem 😬", "Mazzel 🙄"},
			"nat":          {"Nat 💀", "Oeps, nat 😅", "Nat… 🫠", "Rip 😭"},
			"natOpp":       {"NAT 😂😂", "Haha nat 💦", "Nat! 🎉", "Nat lol 😆"},
			"pit":          {"PIT 🔥🔥🔥", "Alle slagen!! 🏆", "Pit, ja toch 😎", "Doormars! 🚀🚀"},
			"pit/opp":      {"Pit tegen 💀", "Allemaal?? 😱", "Oef, pit 😵", "Dat potje mag weg 🫠"},
			"handWon":      {"Eitje 😎", "Nice 👌", "Binnen 🙌", "Lekker bezig 🔥"},
			"handLost":     {"Volgende 😤", "Meh 😕", "Balen 😩", "Komt goed 🤞"},
			"gameWon":      {"GG! Gewonnen 🏆🎉", "Makkelijk gewonnen 😎🔥", "Gewonnen!! 🙌 nog een?", "Winnaars 🏆 gg allemaal"},
			"gameLost":     {"gg, jullie waren beter 🫡", "Verloren 😭 revanche?", "gg wp 👏", "Volgende keer beter 😤"},
			"partnerGood":  {"Nice maat 🔥", "👏👏👏", "Goed bezig! 💪", "Sick zet 🤯"},
		},
		replies: map[string][]string{
			"hello":    {"Yo! 👋", "Hoi 😎", "Hé 🙌", "Hallo 👋"},
			"praise":   {"Dankje 😎", "🙏", "Haha dank je 🔥", "Jij ook 👊"},
			"gg":       {"gg 🫡", "gg wp 👏", "ggg 🏆"},
			"laugh":    {"😂😂", "lol 😆", "🤣"},
			"help":     {"Handleiding zit onder het vraagteken 👆", "Bekennen, anders troeven 🃏", "Gewoon op gevoel 🤙 (en tellen)"},
			"nat":      {"Nat? 👀 we gaan het zien", "Nooit 😤", "😬"},
			"nat/maat": {"Nat 💦", "Jaaa nat 😂", "Nat nat nat 🔥"},
			"pech":     {"Rip 😢", "Volgende keer 🤞", "Oef 😅"},
			"sorry":    {"Geen stress 😎", "Komt goed 👍", "Maakt niet uit 🤙"},
			"thanks":   {"Geen dank 🤙", "👍", "Graag 😎"},
			"bye":      {"Doei 👋", "Tot later ✌️", "Doeg 👋"},
			"name":     {"Ja? 👀", "Wat is er 🤔", "Yo? 👋"},
		},
	},
	"vera": {
		lines: map[string][]string{
			"greet": {
				"Hallo! Ik sta om vijf uur op, dus ik speel graag een beetje vlot.",
				"Hallo allemaal! Vers van de bakkerij en klaar om te spelen.",
				"Hoi! Ik heb nog een krentenbol bewaard voor de winnaar.",
				"Dag allemaal. Gezellig, maar ik geef niks cadeau hoor!",
				"Daar zijn we! Laten we er een mooi potje van maken.",
			},
			"trump": {
				"Ik speel. Dat deeg rijst wel.",
				"Spelen. En ik ga het jullie niet makkelijk maken.",
				"Die neem ik. Met liefde, maar zonder genade.",
				"Ik speel. Even doorkneden en dan komt het goed.",
				"Spelen! Hou je vast.",
			},
			"trump/opp": {
				"Zo, daar wordt gespeeld. Ik let op hoor.",
				"Mooi, dan gaan wij het jullie lastig maken.",
				"Dat mag. Maar gratis krijg je ze niet.",
				"Goed hoor. Eens kijken of het rijst.",
			},
			"pass": {
				"Pas. Dit deeg rijst niet.",
				"Ik pas. Geen zin in een half gebakken potje.",
				"Pas. Ik bewaar mijn krachten.",
				"Pas, lieverd.",
			},
			"play": {"Deze, vers van de plank.", "Hop, op tafel.", "Even kijken… ja, deze.", "Kijk maar goed."},
			"wonTrick": {
				"Die is voor ons, dank je wel.",
				"Netjes.",
				"Zo, die zit in de oven.",
				"Mooi, die is binnen.",
			},
			"wonTrick/opp": {
				"Goed gespeeld. Ik onthoud hem.",
				"Die gun ik jullie.",
				"Zo, die was scherp.",
				"Oké, die is voor jullie. Ik zit niet stil.",
			},
			"roem": {
				"Roem! {p} punten, vers van de pers.",
				"Kijk, {p} roem. Daar word je warm van.",
				"Roem voor ons! Lekker.",
				"Dat is nog eens bakken: {p} roem.",
			},
			"roem/opp": {
				"{p} roem voor jullie. Goed gezien.",
				"Roem voor de overkant. Gun ik jullie, voor deze keer.",
				"Zo, roem voor jullie. Ik onthoud het.",
				"Die roem was mooi, al was hij niet voor mij.",
			},
			"nat": {
				"Nat. Dat brood is ingezakt.",
				"Nat gegaan. Eerlijk is eerlijk, verdiend.",
				"Nat! Had ik maar beter moeten kijken.",
				"Oei, nat. Morgen weer vroeg op, dan vergeet ik het wel.",
			},
			"natOpp": {
				"Nat! Sorry hoor, maar dat was te gretig.",
				"Nat. Dat deeg was niet gerezen.",
				"Die gaan nat. Netjes verdedigd, maat.",
				"Nat! Zo, daar word ik even wakker van.",
			},
			"pit": {
				"Pit! Alle broodjes verkocht!",
				"Alle slagen! Dat is nog eens een volle oven.",
				"Een pit! Dit vier ik morgen met een taartje.",
				"Pit. Zo zie ik het graag.",
			},
			"pit/opp": {
				"Pit voor jullie. Petje af, echt.",
				"Alle slagen weg. Daar moet ik even van bijkomen.",
				"Een pit tegen. Knap hoor, maar zo blijft het niet.",
				"Zo, alles voor jullie. Ik ga er eens goed voor zitten.",
			},
			"handWon": {
				"Mooi potje. Zo gaat het goed.",
				"Weer een potje binnen. Dank je wel.",
				"Netjes gebakken.",
				"Zo, die is binnen.",
			},
			"handLost": {
				"Die was voor jullie. Goed gespeeld.",
				"Hm, dit potje ging mis. Volgende.",
				"Jammer. Ik ga scherper opletten.",
				"Kan gebeuren. Ik zit niet stil.",
			},
			"gameWon": {
				"Gewonnen! De krentenbol is voor ons.",
				"Gewonnen. Dank jullie wel, het was gezellig.",
				"Gewonnen! En nu snel naar huis, morgen om vijf uur op.",
				"Wij winnen! Goed gespeeld, allemaal.",
			},
			"gameLost": {
				"Gefeliciteerd! De krentenbol is voor jullie.",
				"Verloren, maar wel scherp gespeeld. Knap van jullie.",
				"Jullie wonnen. Volgende keer ben ik uitgeslapen!",
				"Goed gespeeld. Revanche als ik weer vrij ben?",
			},
			"partnerGood": {
				"Goed gezien, maat!",
				"Mooi gespeeld, dat is vakwerk.",
				"Netjes, zo hoort het.",
				"Scherp! Zo mag ik het zien.",
			},
		},
		replies: map[string][]string{
			"hello":    {"Hoi! Gezellig dat je er bent.", "Dag! Zin in een potje?", "Hallo! Ga lekker zitten.", "Hé, welkom!"},
			"praise":   {"Dank je wel! Jij ook.", "Ach, gewoon goed opletten.", "Dank je! Vakwerk, hè?", "Dat hoor ik graag."},
			"gg":       {"Goed gespeeld allemaal!", "gg! Dank jullie wel.", "Mooi spel, dank je."},
			"laugh":    {"Haha, gezellig!", "Hihi!", "Haha, ja hoor."},
			"help":     {"Altijd eerst bekennen. Kan dat niet, dan troeven.", "In de handleiding staat het heel duidelijk, kijk maar.", "Let op wat er al gespeeld is, dan weet je wat er nog zit."},
			"nat":      {"Dat zullen we nog wel eens zien!", "Niet zo snel, het potje loopt nog.", "Hm, eerst maar eens tellen."},
			"nat/maat": {"Die rijzen niet meer, maat!", "Zou zomaar kunnen, maat.", "Mooi, zo wil ik het zien."},
			"pech":     {"Kan gebeuren. Morgen is er weer vers brood.", "Jammer! Volgende keer beter.", "Kop op!"},
			"sorry":    {"Geeft niks hoor.", "Niks aan de hand.", "Ach, dat gebeurt."},
			"thanks":   {"Graag gedaan!", "Geen dank.", "Alsjeblieft!"},
			"bye":      {"Dag! Ik moet er ook zo vandoor.", "Doei! Tot de volgende keer.", "Dag, het ga je goed!"},
			"name":     {"Ja? Zeg het maar.", "Hier! Wat is er?", "Ja, lieverd?"},
		},
	},
}
