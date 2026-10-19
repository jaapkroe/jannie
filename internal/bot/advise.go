package bot

import (
	"hash/fnv"
	"slices"
	"strconv"
	"strings"

	"klaverjas/internal/game"
)

// Advice is a training hint: exactly one of Card, Suit or Play is set for
// the decision at hand, with a Dutch explanation.
type Advice struct {
	Card *game.Card
	Suit *game.Suit
	Play *bool
	Text string // e.g. "Speel ♥A: de aas is de hoogste kaart in harten en levert 11 punten op."
}

// Advise returns advice at sterk strength for the player of v, whose turn
// it must be (otherwise, and should the search fail, it returns no advice).
// The same view always gets the same advice.
func Advise(v game.View) (a Advice) {
	if v.Turn.Valid() && v.Turn != v.Seat {
		return Advice{}
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			a = Advice{}
		}
	}()
	seed := viewSeed(&v)
	switch v.Phase {
	case game.PhaseTrump:
		st := searchTrump(&v, defaultSearch, seed, 0.5)
		s := bestSuit(st, v.Forced, v.Turned)
		return Advice{Suit: &s, Text: trumpText(&v, s, st[s])}
	case game.PhaseBid:
		play, pass := searchBid(&v, defaultSearch, seed, 0.5)
		p := play.mean() > pass.mean()
		return Advice{Play: &p, Text: bidText(&v, p, play)}
	case game.PhasePlay:
		legal := legalCards(v)
		if len(legal) == 0 {
			return Advice{}
		}
		v.Legal = legal
		c := legal[0]
		if len(legal) > 1 {
			c = sterkChoice(&v, defaultSearch, seed, 0.5)
		}
		tab := tableFromView(&v)
		return Advice{Card: &c, Text: playText(&v, &tab, c)}
	}
	return Advice{}
}

// viewSeed derives a seed from everything in the view that matters.
func viewSeed(v *game.View) uint64 {
	h := fnv.New64a()
	b := []byte{byte(v.Seat), byte(v.Dealer), byte(v.Mode), byte(v.Rules), byte(v.Trump), byte(v.Turned)}
	for _, c := range v.Hand {
		b = append(b, byte(c.Index()))
	}
	for _, t := range v.Tricks {
		for _, p := range t.Cards {
			b = append(b, byte(p.Card.Index()))
		}
	}
	for _, p := range v.Current.Cards {
		b = append(b, byte(p.Card.Index()))
	}
	h.Write(b)
	return h.Sum64()
}

// Dutch number words for small counts, as people say them at the table.
var numberWords = [...]string{"geen", "één", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht"}

func numberNL(n int) string {
	if n >= 0 && n < len(numberWords) {
		return numberWords[n]
	}
	return strconv.Itoa(n)
}

// trumpHonours lists the trump honours of h in suit s ("de boer", "de nel", ...).
func trumpHonours(h cardSet, s game.Suit) []string {
	var out []string
	if h.has(jackOf(s)) {
		out = append(out, "de boer")
	}
	if h.has(nineOf(s)) {
		out = append(out, "de nel")
	}
	if h.has(aceOf(s)) {
		out = append(out, "de aas")
	}
	if h.has(game.Card{Rank: game.King, Suit: s}) && h.has(game.Card{Rank: game.Queen, Suit: s}) {
		out = append(out, "stuk")
	}
	return out
}

// sideAces counts the aces of h outside suit s.
func sideAces(h cardSet, s game.Suit) int {
	n := 0
	for o := game.Suit(0); o < game.NumSuits; o++ {
		if o != s && h.has(aceOf(o)) {
			n++
		}
	}
	return n
}

// chanceText phrases a success rate for a learner: "in 7 van de 10 potjes".
func chanceText(rate float64) string {
	n := int(rate*10 + 0.5)
	switch {
	case n >= 10:
		return "vrijwel altijd"
	case n <= 0:
		return "bijna nooit"
	}
	return "in " + strconv.Itoa(n) + " van de 10 potjes"
}

func trumpText(v *game.View, s game.Suit, st optionStats) string {
	h := setOf(v.Hand)
	n := h.countSuit(s)
	name := game.SuitNameNL(s)
	var b strings.Builder
	if v.Forced {
		b.WriteString("Iedereen heeft gepast, dus jij moet kiezen (niet " + v.Turned.Symbol() + "). ")
	}
	b.WriteString("Kies " + s.Symbol() + " als troef: ")
	hon := trumpHonours(h, s)
	switch {
	case len(hon) > 0:
		b.WriteString("je hebt " + joinNL(hon) + ", in totaal " + numberNL(n) + " " + name + ".")
	case n >= 3:
		b.WriteString("met " + numberNL(n) + " " + name + " is dat je langste kleur.")
	default:
		b.WriteString("geen sterke hand, maar met " + name + " als troef is de kans op nat het kleinst.")
	}
	b.WriteString(sideAcesText(h, s))
	b.WriteString(" Je haalt het zo naar schatting " + chanceText(st.madeRate()) + ".")
	return b.String()
}

// sideAcesText mentions the aces outside the trump suit.
func sideAcesText(h cardSet, s game.Suit) string {
	switch a := sideAces(h, s); {
	case a == 1:
		return " Daarnaast heb je een aas."
	case a > 1:
		return " Daarnaast heb je " + numberNL(a) + " azen."
	}
	return ""
}

func bidText(v *game.View, play bool, st optionStats) string {
	s := v.Turned
	h := setOf(v.Hand)
	n := h.countSuit(s)
	name := game.SuitNameNL(s)
	hon := trumpHonours(h, s)
	chance := chanceText(st.madeRate())
	if play {
		what := numberNL(n) + " " + name
		if len(hon) > 0 {
			what = joinNL(hon) + " van " + s.Symbol() + " (" + numberNL(n) + " troeven in totaal)"
		}
		return "Spelen: met " + what + " is je hand sterk genoeg." + sideAcesText(h, s) +
			" Je haalt het naar schatting " + chance + "."
	}
	var why string
	switch {
	case n == 0:
		why = "je hebt geen enkele " + name
	case len(hon) == 0 && n <= 2:
		why = "je hebt geen boer, nel of aas van " + s.Symbol() + " en maar " + numberNL(n) + " " + name
	case len(hon) == 0:
		why = "je hebt wel " + numberNL(n) + " " + name + ", maar geen boer, nel of aas"
	case n <= 2:
		why = "je hebt wel " + joinNL(hon) + " van " + s.Symbol() + ", maar met maar " + numberNL(n) + " " + name + " is dat te weinig"
	default:
		why = "je hebt " + joinNL(hon) + " van " + s.Symbol() + " en " + numberNL(n) + " " + name + ", maar de rest van je hand is te zwak"
	}
	return "Passen: " + why + ". Als je speelt, haal je het naar schatting " + chance + "; de kans op nat is te groot."
}

// playText explains why c is a good card in v, for a learner.
func playText(v *game.View, tab *table, c game.Card) string {
	cs := game.CardShortNL(c)
	if len(v.Legal) == 1 {
		if len(v.Hand) == 1 {
			return "Speel " + cs + ": dat is je laatste kaart."
		}
		rule := game.ExplainConstraint(v.Hand, v.Current, v.Seat, v.Trump, v.Rules)
		if !strings.HasPrefix(rule, "Rotterdams") {
			rule = lowerFirst(rule)
		}
		return "Speel " + cs + ": dat is de enige kaart die mag (" + rule + ")."
	}
	m := newMover(tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	if tab.n == 0 {
		return leadText(&m, c)
	}
	return followText(&m, c, v.Rules)
}

func leadText(m *mover, c game.Card) string {
	t := m.t
	trump := t.trump
	cs := game.CardShortNL(c)
	suitName := game.SuitNameNL(c.Suit)
	if c.Suit == trump {
		if m.hand.inSuit(trump) == m.hand {
			return "Speel " + cs + ": je hebt alleen nog troef."
		}
		if m.ourTeamPlays() {
			if t.boerSig[m.seat.Team()] == m.partner() && m.unk.has(jackOf(trump)) {
				return "Speel troef (" + cs + "): je maat vroeg met een kleintje om troef (kleintje boer), dus speel troef naar je maat toe."
			}
			if !m.oppsMayTrump() {
				return "Speel " + cs + ": de tegenstanders hebben geen troef meer, dus deze troef is een zekere slag."
			}
			if m.isBoss(c) {
				top := "dit is nu de hoogste troef"
				if c.Rank == game.Jack {
					top = "de boer is de hoogste troef"
				}
				return "Trek troef met " + cs + ": jullie spelen en " + top + ". Haal de troeven van de tegenstanders eruit."
			}
			return "Trek troef met " + cs + ": jullie spelen, dus haal de troeven van de tegenstanders eruit en houd je hoge troeven achter de hand."
		}
		if m.isBoss(c) {
			return "Speel " + cs + ", de hoogste troef: zo haal je troeven bij de spelers weg, en die kunnen ze dan niet meer gebruiken om jullie azen te troeven."
		}
		return "Speel troef (" + cs + "): zo haal je troeven bij de spelers weg."
	}
	if m.isBoss(c) && m.unk.inSuit(c.Suit) != 0 {
		pts := strconv.Itoa(game.Points(c, trump)) + " punten"
		switch {
		case c.Rank == game.Ace:
			return "Speel " + cs + ": de aas is de hoogste kaart in " + suitName + " en levert " + pts + " op."
		case m.hand.higher(c, trump) != 0:
			return "Speel " + cs + ": de hogere " + suitName + " heb je zelf, dus in " + suitName + " kan niemand hier overheen."
		case c.Rank == game.Ten:
			return "Speel " + cs + ": de aas is al gespeeld, dus je 10 is nu de hoogste " + suitName + " (" + pts + ")."
		}
		return "Speel " + cs + ": de hogere " + suitName + " zijn al gespeeld, dus dit is nu de hoogste kaart in die kleur."
	}
	if m.isBoss(c) {
		return "Speel " + cs + ": niemand heeft nog " + suitName + ", dus " + m.ruffClause(c.Suit)
	}
	if m.ourTeamPlays() && t.trumpBy == m.partner() && !t.hasLed[m.seat] &&
		m.hand.has(jackOf(trump)) && c.Rank <= game.Nine {
		return "Speel " + cs + ": met een kleintje laat je je maat weten dat jij de troefboer hebt (kleintje boer). Neemt je maat de slag, dan speelt die troef terug."
	}
	p := m.partner()
	if m.voidIn(p, c.Suit) && m.mayTrump(p) {
		return "Speel " + cs + ": je maat heeft geen " + suitName + " meer en kan troeven."
	}
	n := m.hand.countSuit(c.Suit)
	if n == 1 && m.hand.inSuit(trump) != 0 {
		return "Speel " + cs + ", je laatste " + suitName + ": dan ben je die kleur kwijt en kun je hem later troeven."
	}
	if low, _ := m.hand.bottom(c.Suit, trump); low == c {
		if c.Rank <= game.Nine {
			return "Kom uit met " + cs + ": een lage kaart kost weinig, en je hoge kaarten bewaar je voor later."
		}
		return "Kom uit met " + cs + ", je laagste " + suitName + ": zo kost het weinig, en je hogere kaarten bewaar je voor later."
	}
	if m.hand.has(tenOf(c.Suit)) && m.unk.has(aceOf(c.Suit)) && c != tenOf(c.Suit) {
		return "Speel " + cs + ": zo jaag je de aas eruit, daarna is je " + game.CardShortNL(tenOf(c.Suit)) + " de hoogste."
	}
	return "Speel " + cs + ": dat levert hier naar verwachting het meeste op."
}

// ruffClause finishes a sentence about leading a suit nobody else holds.
func (m *mover) ruffClause(s game.Suit) string {
	if m.oppsMayTrump() {
		return "de tegenstanders moeten troeven of iets weggooien."
	}
	return "deze kaart wint zeker."
}

func followText(m *mover, c game.Card, rules game.Rules) string {
	t := m.t
	trump, led := t.trump, t.led()
	cs := game.CardShortNL(c)
	pts := game.Points(c, trump)
	roem := m.roemGain(c)
	wins := game.Beats(c, t.best, led, trump)
	partnerWins := t.win == m.partner()
	last := t.n == 3
	total := t.points + pts

	if partnerWins && !wins {
		head := "Je maat heeft de slag"
		switch {
		case roem > 0:
			return head + ": met " + cs + " komt er " + strconv.Itoa(roem) + " roem bij voor jullie (" + m.roemNames(c) + ")."
		case pts >= 10:
			return head + ": smeer je " + cs + " voor " + strconv.Itoa(pts) + " extra punten."
		case pts > 0:
			return head + ": geef " + cs + " mee, dat is " + count(pts, "punt", "punten") + " erbij."
		case c.Suit != led && c.Suit != trump && rules == game.Amsterdams && m.hand.inSuit(trump) != 0:
			return head + ": je hoeft niet te troeven, dus gooi " + cs + " bij en bewaar je troeven."
		}
		return head + ": gooi " + cs + " bij, die is niets waard. Je goede kaarten bewaar je voor later."
	}
	if partnerWins && wins {
		if last || (m.isBoss(c) && (c.Suit == trump || !m.oppsMayTrump())) {
			return "Neem de slag over met " + cs + ": de kaart van je maat is niet veilig, zo is de slag zeker voor jullie."
		}
		return "Neem de slag over met " + cs + ": de kaart van je maat is niet veilig, en zo moet de tegenstander achter je hoger komen."
	}
	if wins {
		extra := ""
		if roem > 0 {
			extra = " En je maakt er " + strconv.Itoa(roem) + " roem bij (" + m.roemNames(c) + ")."
		}
		where := " (" + count(total, "punt", "punten") + " tot nu toe)"
		switch {
		case c.Suit == trump && led != trump && t.high >= 0:
			return "Overtroef met " + cs + ": je kunt niet bekennen en zo pak je de slag" + where + "." + extra
		case c.Suit == trump && led != trump:
			return "Troef met " + cs + ": je kunt niet bekennen en zo pak je de slag" + where + "." + extra
		case last:
			return "Pak de slag met " + cs + ": je bent de laatste, dus de slag is zeker van jou" + where + "." + extra
		case m.isBoss(c) && (c.Suit == trump || !m.oppsMayTrump()):
			return "Pak de slag met " + cs + ": niemand na je kan hier nog overheen" + where + "." + extra
		case m.isBoss(c):
			return "Pak de slag met " + cs + ": er is geen hogere " + game.SuitNameNL(c.Suit) + " meer, alleen een troef kan er nog overheen" + where + "." + extra
		}
		if t.n == 1 {
			return "Speel " + cs + ": daarmee neem je de slag voorlopig, en je maat speelt na jou nog." + extra
		}
		return "Speel " + cs + ": daarmee neem je de slag voorlopig; alleen de laatste speler kan er nog overheen." + extra
	}

	// The opponents keep the trick.
	warn := ""
	for s := m.legal; s != 0; s &= s - 1 {
		o := game.CardFromIndex(trailing(s))
		if r := m.roemGain(o); o != c && r > 0 && roem == 0 && !game.Beats(o, t.best, led, trump) {
			warn = " Met " + game.CardShortNL(o) + " zou je de tegenstanders " + strconv.Itoa(r) + " roem geven."
			break
		}
	}
	if c.Suit == led {
		if w, ok := m.bestWinner(false, false); ok {
			if last || (m.isBoss(w) && (w.Suit == trump || !m.oppsMayTrump())) {
				return "Duik met " + cs + ": met " + game.CardShortNL(w) + " kun je de slag nemen, maar die kaart is later meer waard." + warn
			}
			return "Duik met " + cs + ": je kunt de slag nu wel nemen, maar na jou kan er nog overheen worden gegaan. Bewaar je hoge kaart." + warn
		}
		if low, _ := m.hand.bottom(led, trump); low == c {
			if led == trump {
				return "Je kunt niet overtroeven: speel je laagste troef (" + cs + ")." + warn
			}
			return "Je kunt de slag niet winnen: speel je laagste " + game.SuitNameNL(led) + " (" + cs + ") en bewaar je punten." + warn
		}
		return "Je kunt de slag niet winnen: met " + cs + " geef je de tegenstanders zo weinig mogelijk." + warn
	}
	if c.Suit == trump {
		return "Je moet troeven, maar kunt niet overtroeven: speel je laagste troef (" + cs + ")." + warn
	}
	n := m.hand.countSuit(c.Suit)
	if n == 1 && pts == 0 && m.hand.inSuit(trump) != 0 {
		return "Gooi je laatste " + game.SuitNameNL(c.Suit) + " af (" + cs + "): dan kun je die kleur straks troeven." + warn
	}
	if pts == 0 {
		return "Gooi je " + cs + " af: die is niets waard en je kunt niet bekennen." + warn
	}
	return "Gooi " + cs + " af: je kunt niet bekennen, en zo verlies je de minste punten." + warn
}

// roemNames names the roem that c adds to the trick ("driekaart en stuk").
func (m *mover) roemNames(c game.Card) string {
	t := m.t
	before := game.TrickRoem(t.trick[:t.n], t.trump)
	var names []string
	for _, r := range game.TrickRoem(append(append([]game.Card(nil), t.trick[:t.n]...), c), t.trump) {
		if i := slices.Index(before, r); i >= 0 {
			before = slices.Delete(before, i, i+1)
			continue
		}
		names = append(names, r.NameNL())
	}
	return joinNL(names)
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// ExplainTrick describes a finished trick in Dutch: who won it, with what
// and why, and what it was worth. For example
// "Fatima (AI) wint de slag met ♥B, de hoogste troef. 27 punten, roem: stuk (20)."
func ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string {
	if len(t.Cards) != 4 || !t.Winner.Valid() {
		return ""
	}
	led := t.Cards[0].Card.Suit
	var win game.Card
	trumps := 0
	cards := make([]game.Card, 0, 4)
	for _, p := range t.Cards {
		cards = append(cards, p.Card)
		if p.Seat == t.Winner {
			win = p.Card
		}
		if p.Card.Suit == trump {
			trumps++
		}
	}
	name := names[t.Winner]
	var b strings.Builder
	switch {
	case win.Suit == trump && led == trump:
		b.WriteString(name + " wint de slag met " + game.CardShortNL(win) + ", de hoogste troef.")
	case win.Suit == trump && trumps == 1:
		b.WriteString(name + " troeft de " + led.Symbol() + " in met " + game.CardShortNL(win) + " en wint de slag.")
	case win.Suit == trump:
		b.WriteString(name + " wint de slag met " + game.CardShortNL(win) + ": overgetroefd met de hoogste troef.")
	default:
		b.WriteString(name + " wint de slag met " + game.CardShortNL(win) + ", de hoogste kaart in de gevraagde kleur (" + led.Symbol() + ").")
	}
	b.WriteString(" ")
	b.WriteString(count(t.Points, "punt", "punten"))
	if t.Points == game.CardPoints(cards, trump)+game.LastTrickBonus {
		b.WriteString(" (met 10 voor de laatste slag)")
	}
	if len(t.Roem) > 0 {
		parts := make([]string, len(t.Roem))
		for i, r := range t.Roem {
			parts[i] = r.NameNL() + " (" + strconv.Itoa(r.Points) + ")"
		}
		b.WriteString(", roem: ")
		b.WriteString(joinNL(parts))
	}
	b.WriteString(".")
	return b.String()
}

// joinNL joins items as "a, b en c".
func joinNL(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " en " + items[len(items)-1]
}

func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}
