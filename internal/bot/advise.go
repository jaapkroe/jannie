package bot

import (
	"hash/fnv"
	"math"
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
// A play hint may prefer, within a small teaching tolerance, a card whose
// reason it can name (see teachPlay). The same view always gets the same
// advice.
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
		tab := tableFromView(&v)
		c := legal[0]
		if len(legal) == 1 {
			return Advice{Card: &c, Text: playText(&v, &tab, c)}
		}
		c, text := teachPlay(&v, &tab, defaultSearch, seed)
		return Advice{Card: &c, Text: text}
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

// trumpHonours lists the trump honours of h in suit s ("de boer", "de nel",
// "de aas"). Heer and vrouw in one hand are no honour: stuk counts only
// when they fall in the same trick (design §2), which one player cannot do.
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
	return out
}

// suitCount phrases n cards of suit s: "drie harten", "één kaart in harten".
func suitCount(n int, s game.Suit) string {
	if n == 1 {
		return "één kaart in " + game.SuitNameNL(s)
	}
	return numberNL(n) + " " + game.SuitNameNL(s)
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
	case len(hon) > 0 && n == 1:
		b.WriteString("je hebt " + hon[0] + ", maar verder geen " + name + ".")
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

// bidText explains the bid advice; st is the search outcome of spelen.
func bidText(v *game.View, play bool, st optionStats) string {
	s := v.Turned
	h := setOf(v.Hand)
	n := h.countSuit(s)
	name := game.SuitNameNL(s)
	hon := trumpHonours(h, s)
	chance := chanceText(st.madeRate())
	if play {
		what := suitCount(n, s)
		switch {
		case len(hon) > 0 && n == 1:
			what = hon[0] + " van " + s.Symbol() + " (je enige troef)"
		case len(hon) > 0:
			what = joinNL(hon) + " van " + s.Symbol() + " (" + numberNL(n) + " troeven in totaal)"
		}
		return "Spelen: met " + what + " is je hand sterk genoeg." + sideAcesText(h, s) +
			" Je haalt het naar schatting " + chance + "."
	}
	var why string
	switch {
	case n == 0:
		why = "je hebt geen " + name
	case len(hon) == 0 && n <= 2:
		why = "je hebt geen boer, nel of aas van " + s.Symbol() + " en maar " + suitCount(n, s)
	case len(hon) == 0:
		why = "je hebt wel " + numberNL(n) + " " + name + ", maar geen boer, nel of aas"
	case n == 1:
		why = "je hebt wel " + hon[0] + " van " + s.Symbol() + ", maar verder geen " + name
	case n <= 2:
		why = "je hebt wel " + joinNL(hon) + " van " + s.Symbol() + ", maar met maar " + numberNL(n) + " " + name + " is dat te weinig"
	default:
		why = "je hebt " + joinNL(hon) + " van " + s.Symbol() + " en " + numberNL(n) + " " + name + ", maar de rest van je hand is te zwak"
	}
	head := "Passen: " + why + ". Als je speelt, haal je het naar schatting " + chance
	// The advice compares expected scores, not the chance of making it.
	// At "6 van de 10" or worse nat is the reason; with better odds it
	// is that passing scores more on average.
	if st.madeRate() < 0.65 && st.mean() <= 0 {
		return head + "; de kans op nat is te groot."
	}
	return head + ", maar passen levert gemiddeld meer op: " + passReason(v, h) + "."
}

// passReason says why passing pays although playing would usually succeed.
func passReason(v *game.View, h cardSet) string {
	if v.Seat == v.Voorhand {
		// design §2: when all four pass, voorhand chooses another suit.
		return "passen de anderen ook, dan kies jij een andere kleur als troef"
	}
	nat := "gaat het mis, dan krijgen de tegenstanders 162 punten en alle roem"
	switch a := sideAces(h, v.Turned); {
	case a == 1:
		return nat + ", en met je aas verdedig je ook goed"
	case a > 1:
		return nat + ", en met je azen verdedig je sterk"
	}
	return nat
}

// teachTolerance is how many points of expected value a play hint may give
// up for a card whose reason the learner can follow (see teachPlay).
const teachTolerance = 5

// teachPlay returns the card to advise in v (which has more than one legal
// card) and its explanation. It starts from the sterk card. When the hint
// can name no reason for that card beyond the search's estimate, it
// advises the rule-based card, or else the cheapest card, if that card has
// a reason of its own and the search cannot tell the two apart: the gap is
// under teachTolerance points or two standard errors. It never moves to a
// card that would falsely promise the trump boer (kleintje boer), which
// sterk play also avoids.
func teachPlay(v *game.View, tab *table, cfg searchConfig, seed uint64) (game.Card, string) {
	m := newMover(tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5)
	pref := m.choose()
	res := searchPlay(v, tab, cfg, seed, 0.5)
	return teachPick(v, tab, &m, res, pref)
}

// teachPick is teachPlay once the search results res are known.
func teachPick(v *game.View, tab *table, m *mover, res []playResult, pref game.Card) (game.Card, string) {
	best := sterkPick(m, res, pref)
	text, generic := explainPlay(v, tab, res[best].card, res)
	if !generic {
		return res[best].card, text
	}
	for _, alt := range [...]game.Card{pref, cheapest(v.Legal, v.Trump)} {
		i := resultIndex(res, alt)
		if i < 0 || i == best || m.fakeSignal(alt) {
			continue
		}
		if res[best].mean()-res[i].mean() >= max(teachTolerance, 2*pairSE(res, best, i)) {
			continue
		}
		if t, g := explainPlay(v, tab, alt, res); !g {
			return alt, t
		}
	}
	return res[best].card, text
}

// explainer is the mover whose card a play hint explains, with the search
// behind the hint.
type explainer struct {
	mover
	v       *game.View
	res     []playResult // the search of v.Legal; nil when there was none
	generic bool         // the text names no reason (set by noReason)
	lacks   *[4]cardSet  // aces each seat probably lacks, from its signals (see lacksAce)
}

// explainPlay explains card c of v.Legal for a learner. res is the search
// behind the advice, or nil. generic reports that the text names no reason
// for c beyond the search's estimate.
func explainPlay(v *game.View, tab *table, c game.Card, res []playResult) (text string, generic bool) {
	cs := game.CardShortNL(c)
	if len(v.Legal) == 1 {
		if len(v.Hand) == 1 {
			return "Speel " + cs + ": dat is je laatste kaart.", false
		}
		return "Speel " + cs + ": " + onlyCardReason(tab, setOf(v.Hand), v.Seat, c) + ".", false
	}
	m := explainer{mover: newMover(tab, v.Seat, setOf(v.Hand), setOf(v.Legal), 0.5), v: v, res: res}
	if tab.n == 0 {
		text = leadText(&m, c)
	} else {
		text = followText(&m, c)
	}
	return text, m.generic
}

// playText explains why c is a good card in v, for a learner.
func playText(v *game.View, tab *table, c game.Card) string {
	text, _ := explainPlay(v, tab, c, nil)
	return text
}

// noReason is the clause for card c when the hint can name no reason for
// it: the search simply rates it best. With the search at hand it says how
// much more c brings in than the cheapest other card, after join ("maar
// reken je de mogelijke kaartverdelingen door, dan levert ♠A hier
// gemiddeld zo'n 9 punten meer op dan ♠8"); without it, or when the
// difference is under half a point, it is plain.
func (m *explainer) noReason(c game.Card, plain, join string) string {
	m.generic = true
	i := resultIndex(m.res, c)
	if i < 0 || len(m.res) < 2 {
		return plain
	}
	others := make([]game.Card, 0, len(m.res)-1)
	for _, r := range m.res {
		if r.card != c {
			others = append(others, r.card)
		}
	}
	y := cheapest(others, m.t.trump)
	gap := m.res[i].mean() - m.res[resultIndex(m.res, y)].mean()
	what := "iets"
	switch n := int(math.Round(gap)); {
	case gap < 0.5:
		return plain
	case n >= 2:
		what = "zo'n " + strconv.Itoa(n) + " punten"
	}
	return join + "reken je de mogelijke kaartverdelingen door, dan levert " + game.CardShortNL(c) +
		" hier gemiddeld " + what + " meer op dan " + game.CardShortNL(y)
}

// onlyCardReason says why c is the only card that seat may play into the
// current trick, holding hand (more than one card). The rule bar shows the
// general constraint; this names the concrete reason.
func onlyCardReason(t *table, hand cardSet, seat game.Seat, c game.Card) string {
	trump, led := t.trump, t.led()
	partner := t.win == seat.Partner()
	switch {
	case c.Suit == led && led != trump:
		return "je moet bekennen, en dit is je enige " + game.SuitNameNL(led)
	case led == trump && hand.countSuit(trump) == 1:
		return "troef is gevraagd, en dit is je enige troef"
	case led == trump && partner:
		return "troef is gevraagd en je moet overtroeven, ook over je maat heen; alleen deze troef is hoger"
	case led == trump:
		return "troef is gevraagd en je moet overtroeven; alleen deze troef is hoger"
	case c.Suit == trump && !game.Beats(c, t.best, led, trump) && t.rules == game.Rotterdams && hand&^suitSet(trump) != 0:
		return "je kunt niet bekennen en niet overtroeven, maar bij Rotterdams moet je toch troeven; dit is je enige troef"
	case c.Suit == trump && !game.Beats(c, t.best, led, trump):
		return "je kunt niet bekennen en hebt alleen nog lagere troeven, dus je moet ondertroeven"
	case c.Suit == trump && partner && t.rules == game.Amsterdams:
		return "je maat heeft de slag, maar je hebt alleen nog troef en ondertroeven mag niet"
	case c.Suit == trump:
		must := "je moet troeven"
		if t.high >= 0 {
			must = "je moet overtroeven"
		}
		if partner {
			must += ", bij Rotterdams ook als je maat de slag heeft"
		}
		if hand.countSuit(trump) > 1 {
			must += "; alleen deze troef is hoger"
		}
		return "je kunt niet bekennen, dus " + must
	}
	// A side card: no card of the led suit and no trump that may be played.
	return "je kunt niet bekennen en niet overtroeven, en ondertroeven mag niet"
}

func leadText(m *explainer, c game.Card) string {
	t := m.t
	trump := t.trump
	cs := game.CardShortNL(c)
	if c.Suit != trump {
		text := sideLeadText(m, c)
		// The manual teaches boer over boer: say whether this is one.
		switch {
		case !m.sideBoerLead(c) || strings.Contains(text, "boer over boer"):
		case m.hand.has(jackOf(trump)):
			text += " Zo zeg je ook dat jij de troefboer hebt (boer over boer)."
		default:
			text += " Dit is geen boer over boer: je hebt de troefboer niet."
		}
		return text
	}
	if m.hand.inSuit(trump) == m.hand {
		return "Speel " + cs + ": je hebt alleen nog troef."
	}
	// isBoss looks at the other players' cards only: a trump can be the
	// highest outstanding one while the mover holds a higher one itself.
	own := m.hand.higher(c, trump)
	if m.ourTeamPlays() {
		if t.boerSig[m.seat.Team()] == m.partner() && m.unk.has(jackOf(trump)) {
			return "Speel troef (" + cs + "): je maat vroeg met een kleintje om troef (kleintje boer), dus speel troef naar je maat toe."
		}
		if !m.oppsMayTrump() {
			return "Speel " + cs + ": de tegenstanders hebben geen troef meer, dus deze troef is een zekere slag."
		}
		switch {
		case m.isBoss(c) && own != 0:
			return "Trek troef met " + cs + ": " + ownHigher(own, trump) + ", dus niemand kan hier overheen. Haal de troeven van de tegenstanders eruit."
		case m.isBoss(c) && c.Rank == game.Jack:
			return "Trek troef met " + cs + ": jullie spelen en de boer is de hoogste troef. Haal de troeven van de tegenstanders eruit."
		case m.isBoss(c):
			return "Trek troef met " + cs + ": jullie spelen en dit is nu de hoogste troef. Haal de troeven van de tegenstanders eruit."
		case m.hand.inSuit(trump) == bit(c):
			return "Trek troef met je enige troef, " + cs + ": jullie spelen, en zo haal je troeven bij de tegenstanders weg."
		case own == 0:
			// Trump is led: whoever can play higher must (design §2).
			who := "een hogere troef"
			if hi := namesHighToLow(m.unk.higher(c, trump), trump); len(hi) <= 2 {
				who = joinOr(hi)
			}
			return "Trek troef met " + cs + ", je hoogste troef: jullie spelen, dus haal de troeven van de tegenstanders eruit. Wie " +
				who + " heeft, moet er nu overheen."
		}
		return "Trek troef met " + cs + ": jullie spelen, dus haal de troeven van de tegenstanders eruit en houd je hoge troeven achter de hand."
	}
	// Defenders: the manual's tip is not to lead trump, so say why here.
	const usually = "als tegenpartij kom je meestal niet met troef uit, maar "
	switch {
	case m.isBoss(c) && own != 0:
		return "Speel " + cs + ": " + ownHigher(own, trump) + ", dus niemand kan hier overheen. Als tegenpartij kom je meestal niet met troef uit, " +
			"maar zo pak je de slag en haal je troeven weg bij de spelende partij."
	case m.isBoss(c):
		return "Speel " + cs + ", de hoogste troef: " + usually + "met de hoogste troef pak je zelf de slag. " +
			"Zo haal je troeven weg bij de spelende partij, die ze dan niet meer kunnen gebruiken om jullie azen af te troeven."
	}
	return "Speel troef (" + cs + "): " + usually + "hier wel: " + m.defenderTrumpReason(c) + "."
}

// sideLeadText explains leading c, a card of a side suit.
func sideLeadText(m *explainer, c game.Card) string {
	t := m.t
	trump := t.trump
	cs := game.CardShortNL(c)
	suitName := game.SuitNameNL(c.Suit)
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
	if t.signalsBoer(m.seat, c) {
		if m.hand.has(jackOf(trump)) {
			return "Speel " + cs + ": met een kleintje laat je je maat weten dat jij de troefboer hebt (kleintje boer). Neemt je maat de slag, dan speelt die troef terug."
		}
		return "Kom uit met " + cs + ": " + m.noReason(c, "dat levert hier naar verwachting het meeste op", "") +
			". Let op: je maat kan een kleintje lezen als kleintje boer (“ik heb de troefboer”)."
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
	if next, x, ok := m.driveOut(c); ok {
		return "Speel " + cs + ": zo jaag je " + game.CardShortNL(x) + " eruit, daarna is je " + game.CardShortNL(next) + " de hoogste."
	}
	if sure, ok := m.partnerAce(c); ok {
		where := "zit waarschijnlijk bij je maat"
		if sure {
			where = "zit bij je maat"
		}
		return "Speel " + cs + ": " + game.CardShortNL(aceOf(c.Suit)) + " " + where + ", dus zo speel je " + suitName + " naar je maat toe."
	}
	if m.sideBoerLead(c) && m.hand.has(jackOf(trump)) {
		return "Speel " + cs + ": met een boer van een bijkleur zeg je dat jij de troefboer hebt (boer over boer)."
	}
	if hi, ok := m.bareHonour(c); ok {
		return "Speel " + cs + ": die staat kaal terwijl " + stillOut(hi, trump) + ", dus later raak je hem waarschijnlijk toch kwijt."
	}
	if l, hi, ok := m.bareAfter(c); ok {
		return "Speel " + cs + ": speel je " + game.CardShortNL(l) + ", dan staat je " + cs + " straks kaal terwijl " + stillOut(hi, trump) + "."
	}
	return "Speel " + cs + ": " + m.noReason(c, "dat levert hier naar verwachting het meeste op", "") + "."
}

// driveOut reports whether leading c, a side card that is not the highest,
// would chase out the one outstanding card x that keeps next, the mover's
// highest other card of the suit, from being the highest: x is the only
// card above next that is still out, so it also beats c.
func (m *mover) driveOut(c game.Card) (next, x game.Card, ok bool) {
	trump := m.t.trump
	rest := m.hand.inSuit(c.Suit) &^ bit(c)
	if c.Suit == trump || rest == 0 {
		return game.Card{}, game.Card{}, false
	}
	next, _ = rest.top(c.Suit, trump)
	hi := m.unk.higher(next, trump)
	if hi.count() != 1 {
		return game.Card{}, game.Card{}, false
	}
	return next, game.CardFromIndex(trailing(hi)), true
}

// partnerAce reports whether the ace of c's side suit is (sure: certainly)
// with the partner, so that leading c plays the suit to it: the opponents
// cannot hold it, or signalled that they lack it (signalHints), and cannot
// ruff the suit.
func (m *explainer) partnerAce(c game.Card) (sure, ok bool) {
	ace := aceOf(c.Suit)
	if c.Suit == m.t.trump || !m.unk.has(ace) || m.mayHold(m.partner(), bit(ace)) == 0 || m.oppMayRuff(c.Suit) {
		return false, false
	}
	sure = true
	for _, o := range m.opps() {
		if m.mayHold(o, bit(ace)) == 0 {
			continue
		}
		if !m.lacksAce(o, ace) {
			return false, false
		}
		sure = false
	}
	return sure, true
}

// lacksAce reports whether seat p's signals say it probably does not hold
// ace (aas voorspelen and smeren, see signalHints).
func (m *explainer) lacksAce(p game.Seat, ace game.Card) bool {
	if m.lacks == nil {
		m.lacks = new([4]cardSet)
		if m.v != nil {
			for _, h := range signalHints(m.v, m.seat) {
				if h.held < h.notHeld {
					m.lacks[h.seat] |= bit(h.card)
				}
			}
		}
	}
	return m.lacks[p].has(ace)
}

// sideBoerLead reports whether leading c is what the manual calls boer
// over boer when made with the trump boer: a side-suit boer led by the
// playing team while the trump boer is still out.
func (m *mover) sideBoerLead(c game.Card) bool {
	t := m.t
	return c.Rank == game.Jack && c.Suit != t.trump && m.ourTeamPlays() && !t.played.has(jackOf(t.trump))
}

// honourPoints is what a card must be worth for the hints to call it kaal
// or guarded: a vrouw, heer or 10 (a side boer is hardly worth guarding).
const honourPoints = 3

// bareHonour reports whether c, a side honour, is the mover's only card of
// its suit (kaal) while an opponent may still hold a higher one; it
// returns the higher cards that are out.
func (m *mover) bareHonour(c game.Card) (cardSet, bool) {
	trump := m.t.trump
	if c.Suit == trump || game.Points(c, trump) < honourPoints || m.hand.inSuit(c.Suit) != bit(c) {
		return 0, false
	}
	hi := m.unk.higher(c, trump)
	return hi, m.oppsMayHold(hi) != 0
}

// bareAfter reports whether c, an honour, is the higher and dearer of the
// mover's last two cards of its suit while an opponent may still hold a
// card above c: playing the other card l would leave c kaal. It returns l
// and the higher cards that are out.
func (m *mover) bareAfter(c game.Card) (l game.Card, hi cardSet, ok bool) {
	trump := m.t.trump
	rest := m.hand.inSuit(c.Suit) &^ bit(c)
	if rest.count() != 1 {
		return game.Card{}, 0, false
	}
	l = game.CardFromIndex(trailing(rest))
	hi = m.unk.higher(c, trump)
	p := game.Points(c, trump)
	ok = p >= honourPoints && p > game.Points(l, trump) && m.oppsMayHold(hi) != 0
	return l, hi, ok
}

// guarded returns the card that c guards: c and it are the mover's only
// two cards of a side suit, and it is a 10 or plaatje (vrouw, heer) worth
// more than c that an opponent may still catch with a higher card. Without
// c it would stand kaal.
func (m *mover) guarded(c game.Card) (game.Card, bool) {
	trump := m.t.trump
	rest := m.hand.inSuit(c.Suit) &^ bit(c)
	if c.Suit == trump || rest.count() != 1 {
		return game.Card{}, false
	}
	h := game.CardFromIndex(trailing(rest))
	p := game.Points(h, trump)
	return h, p >= honourPoints && p > game.Points(c, trump) && m.oppsMayHold(m.unk.higher(h, trump)) != 0
}

// guardText finishes "Gooi X af: …" when every cheaper legal card that also
// loses the trick guards an honour: "houd ♣7 bij je ♣10, anders staat die
// kaal". It returns "" otherwise.
func (m *mover) guardText(c game.Card) string {
	cheaper := m.cheaperLosers(c)
	if cheaper == 0 || cheaper.count() > 2 {
		return ""
	}
	var keep []string
	for s := cheaper; s != 0; s &= s - 1 {
		g := game.CardFromIndex(trailing(s))
		h, ok := m.guarded(g)
		if !ok || h == c {
			return ""
		}
		keep = append(keep, game.CardShortNL(g)+" bij je "+game.CardShortNL(h))
	}
	if len(keep) == 1 {
		return "houd " + keep[0] + ", anders staat die kaal"
	}
	return "houd " + joinNL(keep) + ", anders staan die kaal"
}

// highDiscard reports whether discarding c says truthfully what the
// manual's hoog/laag bijspelen reads in it (design §8): c is a 10 or
// plaatje of a side suit that was not led, and at most one other card of
// that suit stays, not its ace: "ik heb weinig in deze kleur".
func (m *mover) highDiscard(c game.Card) bool {
	t := m.t
	switch c.Rank {
	case game.Ten, game.Jack, game.Queen, game.King:
	default:
		return false
	}
	rest := m.hand.inSuit(c.Suit) &^ bit(c)
	return c.Suit != t.trump && c.Suit != t.led() && rest.count() <= 1 && !rest.has(aceOf(c.Suit))
}

// ownHigher says that only the mover's own trumps in own are higher:
// "alleen jouw eigen ♣B is hoger".
func ownHigher(own cardSet, trump game.Suit) string {
	names := namesHighToLow(own, trump)
	if len(names) == 1 {
		return "alleen jouw eigen " + names[0] + " is hoger"
	}
	return "alleen jouw eigen " + joinNL(names) + " zijn hoger"
}

// namesHighToLow names the cards of s, strongest first within each suit.
func namesHighToLow(s cardSet, trump game.Suit) []string {
	var names []string
	for su := game.Suit(0); su < game.NumSuits; su++ {
		order := &plainHighToLow
		if su == trump {
			order = &trumpHighToLow
		}
		for _, r := range order {
			if c := (game.Card{Rank: r, Suit: su}); s.has(c) {
				names = append(names, game.CardShortNL(c))
			}
		}
	}
	return names
}

// stillOut finishes "terwijl …" for the outstanding higher cards s, all of
// one suit: "♠A nog niet gevallen is", "♠A en ♠10 nog niet gevallen zijn",
// "er nog drie hogere schoppen in het spel zijn".
func stillOut(s cardSet, trump game.Suit) string {
	names := namesHighToLow(s, trump)
	switch len(names) {
	case 1:
		return names[0] + " nog niet gevallen is"
	case 2:
		return joinNL(names) + " nog niet gevallen zijn"
	}
	c := game.CardFromIndex(trailing(s))
	return "er nog " + numberNL(len(names)) + " hogere " + game.SuitNameNL(c.Suit) + " in het spel zijn"
}

// defenderTrumpReason finishes "als tegenpartij kom je meestal niet met
// troef uit, maar hier wel: …" for c, a trump that is not the highest.
func (m *explainer) defenderTrumpReason(c game.Card) string {
	trump := m.t.trump
	// A side boss of ours that the spelende partij could otherwise ruff.
	for _, r := range [...]game.Rank{game.Ace, game.Ten, game.King, game.Queen} {
		for s := game.Suit(0); s < game.NumSuits; s++ {
			b := game.Card{Rank: r, Suit: s}
			if s != trump && m.hand.has(b) && m.isBoss(b) && m.unk.inSuit(s) != 0 {
				return "zo haal je troeven weg bij de spelende partij, zodat ze je " + game.CardShortNL(b) + " straks niet kunnen aftroeven"
			}
		}
	}
	if top, _ := m.hand.top(trump, trump); game.TrumpOrder(top.Rank) <= game.TrumpOrder(game.King) {
		return "je troeven zijn laag, en zo haal je er troeven van de spelende partij mee weg"
	}
	return m.noReason(c, "een andere kleur voorspelen kost jullie naar verwachting meer", "")
}

// ruffClause finishes a sentence about leading a suit nobody else holds.
func (m *mover) ruffClause(s game.Suit) string {
	if m.oppsMayTrump() {
		return "de tegenstanders moeten troeven of iets weggooien."
	}
	return "deze kaart wint zeker."
}

func followText(m *explainer, c game.Card) string {
	t := m.t
	rules := t.rules
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
		case m.rotterdamsUnder(c):
			head += ", maar bij Rotterdams moet je troeven als je niet kunt bekennen, ook als dat ondertroeven is"
			switch low, _ := m.legal.bottom(trump, trump); {
			case pts >= 10:
				return head + ": smeer je " + cs + " voor " + strconv.Itoa(pts) + " extra punten."
			case low == c:
				return head + ": speel je laagste troef (" + cs + ")."
			}
			return head + ": " + m.noReason(c, cs+" levert hier naar verwachting het meeste op", "") + "."
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
		return m.overtakeText(c)
	}
	if wins {
		extra := ""
		if roem > 0 {
			extra = " En je maakt er " + strconv.Itoa(roem) + " roem bij (" + m.roemNames(c) + ")."
		}
		where := " (" + count(total, "punt", "punten") + " tot nu toe)"
		switch {
		case c.Suit == trump && led != trump:
			verb := "Troef"
			if t.high >= 0 {
				verb = "Overtroef"
			}
			if last || m.certain(c) {
				return verb + " met " + cs + ": je kunt niet bekennen en zo pak je de slag" + where + "." + extra
			}
			return verb + " met " + cs + ": je kunt niet bekennen; zo neem je de slag voorlopig" + where +
				", alleen een hogere troef achter je kan er nog overheen." + extra
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

	// The opponents keep the trick. A roem warning about the only cheaper
	// card is the reason not to play that card.
	warn, warned, ok := m.roemWarn(c, roem)
	warnOnly := ok && m.cheaperLosers(c) == bit(warned)
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
		switch {
		case m.fewestPoints(c):
			return "Je kunt de slag niet winnen: met " + cs + " geef je de tegenstanders zo weinig mogelijk." + warn
		case m.partnerMayWin():
			return "Je kunt de slag zelf niet winnen, maar je maat speelt na jou nog en kan hem pakken: dan zijn de " + count(pts, "punt", "punten") + " van " + cs + " voor jullie." + warn
		}
		if l, hi, ok := m.bareAfter(c); ok {
			return "Speel " + cs + ": je kunt de slag niet winnen, en speel je " + game.CardShortNL(l) + ", dan staat je " + cs +
				" straks kaal terwijl " + stillOut(hi, trump) + "." + warn
		}
		if warnOnly {
			return "Speel " + cs + ": je kunt de slag niet winnen." + warn
		}
		return "Speel " + cs + ": je kunt de slag niet winnen, " + m.noReason(c, "en dit levert hier naar verwachting het meeste op", "maar ") + "." + warn
	}
	if c.Suit == trump && m.rotterdamsUnder(c) {
		head := "Je kunt niet bekennen en niet overtroeven, maar bij Rotterdams moet je toch troeven"
		if low, _ := m.legal.bottom(trump, trump); low == c {
			return head + ": speel je laagste (" + cs + ")." + warn
		}
		return head + ": " + m.noReason(c, cs+" levert hier naar verwachting het meeste op", "") + "." + warn
	}
	if c.Suit == trump {
		// Only undertrumping is left (design §2).
		head := "Je hebt alleen nog lagere troeven, dus je moet ondertroeven"
		if low, _ := m.legal.bottom(trump, trump); low == c {
			return head + ": speel je laagste (" + cs + ")." + warn
		}
		return head + ": " + m.noReason(c, cs+" levert hier naar verwachting het meeste op", "") + "." + warn
	}
	n := m.hand.countSuit(c.Suit)
	if n == 1 && pts == 0 && m.hand.inSuit(trump) != 0 {
		return "Gooi je laatste " + game.SuitNameNL(c.Suit) + " af (" + cs + "): dan kun je die kleur straks troeven." + warn
	}
	switch {
	case pts == 0:
		return "Gooi je " + cs + " af: die is niets waard en je kunt niet bekennen." + warn
	case m.fewestPoints(c):
		return "Gooi " + cs + " af: je kunt niet bekennen, en zo verlies je de minste punten." + warn
	case m.partnerMayWin():
		return "Gooi " + cs + " af: je maat speelt na jou nog en kan de slag pakken, dan zijn deze " + count(pts, "punt", "punten") + " voor jullie." + warn
	}
	head := "Gooi " + cs + " af: je kunt niet bekennen"
	if hi, ok := m.bareHonour(c); ok {
		return head + ", en je " + cs + " staat kaal terwijl " + stillOut(hi, trump) + "." + warn
	}
	if l, hi, ok := m.bareAfter(c); ok && m.cheaperLosers(c) == bit(l) {
		return head + ", en gooi je " + game.CardShortNL(l) + " af, dan staat je " + cs + " straks kaal terwijl " + stillOut(hi, trump) + "." + warn
	}
	if g := m.guardText(c); g != "" {
		return head + "; " + g + "." + warn
	}
	if warnOnly {
		return head + "." + warn
	}
	if m.highDiscard(c) {
		return head + ", en met een hoge bijkaart zeg je dat je weinig " + game.SuitNameNL(c.Suit) + " hebt (hoog/laag bijspelen)." + warn
	}
	return head + ", " + m.noReason(c, "en dit levert hier naar verwachting het meeste op", "maar ") + "." + warn
}

// roemWarn warns against another legal card that loses the trick too and
// would give the opponents roem in it, when c adds none (roem is what c
// adds): first a card that makes roem itself, else a card worth fewer
// points than c to which one card of a later player can add more roem than
// to c. It returns the sentence, starting with a space, and that card.
func (m *mover) roemWarn(c game.Card, roem int) (string, game.Card, bool) {
	t := m.t
	if roem > 0 {
		return "", game.Card{}, false
	}
	for s := m.legal; s != 0; s &= s - 1 {
		o := game.CardFromIndex(trailing(s))
		if r := m.roemGain(o); o != c && r > 0 && !game.Beats(o, t.best, t.led(), t.trump) {
			return " Met " + game.CardShortNL(o) + " zou je de tegenstanders " + strconv.Itoa(r) + " roem geven.", o, true
		}
	}
	own, _ := m.roemThreat(c)
	for s := m.cheaperLosers(c); s != 0; s &= s - 1 {
		o := game.CardFromIndex(trailing(s))
		r, x := m.roemThreat(o)
		if r <= own {
			continue
		}
		prefix := append(append(make([]game.Card, 0, 4), t.trick[:t.n]...), o)
		w := " Met " + game.CardShortNL(o) + " zou " + game.CardShortNL(x) + " na jou de tegenstanders " + strconv.Itoa(r) +
			" roem kunnen geven (" + addedRoemNames(prefix, x, t.trump) + ")"
		if own > 0 {
			w += ", met " + game.CardShortNL(c) + " hooguit " + strconv.Itoa(own)
		}
		return w + ".", o, true
	}
	return "", game.Card{}, false
}

// roemThreat returns the most roem that one card of a player after the
// mover could add to the trick once the mover has played o, with that
// card. Only cards of the led suit count (whoever holds them must follow
// suit), and not a card with which the partner would take the trick.
func (m *mover) roemThreat(o game.Card) (int, game.Card) {
	t := m.t
	var cards [4]game.Card
	n := copy(cards[:], t.trick[:t.n])
	cards[n] = o
	base := game.RoemPoints(cards[:n+1], t.trump)
	best := t.best
	if game.Beats(o, best, t.led(), t.trump) {
		best = o
	}
	most, card := 0, game.Card{}
	after, k := m.afterMe()
	for _, p := range after[:k] {
		for s := m.mayHold(p, suitSet(t.led())); s != 0; s &= s - 1 {
			x := game.CardFromIndex(trailing(s))
			if p.Team() == m.seat.Team() && game.Beats(x, best, t.led(), t.trump) {
				continue
			}
			cards[n+1] = x
			if r := game.RoemPoints(cards[:n+2], t.trump) - base; r > most {
				most, card = r, x
			}
		}
	}
	return most, card
}

// oppsMayHold returns the cards of set that an opponent may hold.
func (m *mover) oppsMayHold(set cardSet) cardSet {
	o := m.opps()
	return m.mayHold(o[0], set) | m.mayHold(o[1], set)
}

// oppsAfterMayHold returns the cards of set that an opponent who still
// plays to this trick after the mover may hold.
func (m *mover) oppsAfterMayHold(set cardSet) cardSet {
	var out cardSet
	after, n := m.afterMe()
	for _, p := range after[:n] {
		if p.Team() != m.seat.Team() {
			out |= m.mayHold(p, set)
		}
	}
	return out
}

// rotterdamsUnder reports whether c is an undertrump that only the
// Rotterdams rule forces: a side suit was led, the mover cannot follow or
// overtrump, and still holds side cards (design §2).
func (m *mover) rotterdamsUnder(c game.Card) bool {
	t := m.t
	return t.rules == game.Rotterdams && c.Suit == t.trump && t.led() != t.trump &&
		!game.Beats(c, t.best, t.led(), t.trump) && m.hand&^suitSet(t.trump) != 0
}

// cheaperLosers returns the legal cards other than c that lose the trick
// too and are worth fewer points than c.
func (m *mover) cheaperLosers(c game.Card) cardSet {
	t := m.t
	p := game.Points(c, t.trump)
	var out cardSet
	for l := m.legal &^ bit(c); l != 0; l &= l - 1 {
		o := game.CardFromIndex(trailing(l))
		if game.Points(o, t.trump) < p && !game.Beats(o, t.best, t.led(), t.trump) {
			out |= bit(o)
		}
	}
	return out
}

// fewestPoints reports whether no legal card that loses the trick is worth
// fewer points than c.
func (m *mover) fewestPoints(c game.Card) bool {
	return m.cheaperLosers(c) == 0
}

// partnerMayWin reports whether the partner still plays to this trick
// and might beat the card that wins it now.
func (m *mover) partnerMayWin() bool {
	after, n := m.afterMe()
	for _, p := range after[:n] {
		if p == m.partner() {
			return m.canBeat(p, m.t.best, m.t.led(), n)
		}
	}
	return false
}

// overtakeText explains c, which beats the card with which the partner is
// winning the trick: forced by the rules, a free choice when the partner's
// card is already safe, or taking over a trick the opponents could steal.
func (m *explainer) overtakeText(c game.Card) string {
	t := m.t
	cs := game.CardShortNL(c)
	if m.allLegalBeat() {
		return m.mustOvertake() + " " + m.winnerChoice(c)
	}
	if t.n == 3 || m.certain(t.best) {
		head := "Je maat heeft de slag al"
		if t.n == 3 {
			head += " en jij bent de laatste"
		}
		switch roem, pts := m.roemGain(c), game.Points(c, t.trump); {
		case roem > 0:
			return head + ": met " + cs + " komt er " + strconv.Itoa(roem) + " roem bij voor jullie (" + m.roemNames(c) + ")."
		case pts >= 10:
			return head + ": met " + cs + " komen er " + strconv.Itoa(pts) + " punten bij voor jullie."
		}
		return head + ", maar neem hem zelf met " + cs + ": dan kom jij de volgende slag uit."
	}
	if m.certain(c) {
		return "Neem de slag over met " + cs + ": de kaart van je maat is niet veilig, zo is de slag zeker voor jullie."
	}
	return "Neem de slag over met " + cs + ": de kaart van je maat is niet veilig, en zo moet de tegenstander achter je hoger komen."
}

// certain reports whether card w, winning the trick after the mover's
// play, cannot be beaten by a later opponent whatever they hold. (safe is
// the policy's working guess: it assumes a player who may still hold the
// led suit follows it.)
func (m *mover) certain(w game.Card) bool {
	trump := m.t.trump
	after, n := m.afterMe()
	for _, p := range after[:n] {
		if p.Team() == m.seat.Team() {
			continue
		}
		if m.mayHold(p, m.unk.higher(w, trump)) != 0 || (w.Suit != trump && m.mayTrump(p)) {
			return false
		}
	}
	return true
}

// allLegalBeat reports whether every legal card beats the trick's winning card.
func (m *mover) allLegalBeat() bool {
	t := m.t
	for l := m.legal; l != 0; l &= l - 1 {
		if !game.Beats(game.CardFromIndex(trailing(l)), t.best, t.led(), t.trump) {
			return false
		}
	}
	return true
}

// mustOvertake says which rule makes every legal card beat the partner's.
func (m *mover) mustOvertake() string {
	t := m.t
	trump, led := t.trump, t.led()
	switch {
	case led == trump:
		return "Troef is gevraagd: je moet overtroeven, ook over je maat heen."
	case m.legal.inSuit(led) != 0:
		return "Je moet bekennen, en al je " + game.SuitNameNL(led) + " zijn hoger dan de kaart van je maat."
	case t.rules == game.Rotterdams && t.high < 0:
		return "Je kunt niet bekennen, en bij Rotterdams moet je dan troeven, ook al heeft je maat de slag."
	case t.rules == game.Rotterdams:
		return "Je kunt niet bekennen, en bij Rotterdams moet je dan overtroeven, ook over je maat heen."
	case t.high < 0:
		return "Je kunt niet bekennen en hebt alleen nog troef, dus je moet troeven, ook al heeft je maat de slag."
	}
	return "Je kunt niet bekennen en hebt alleen nog troef, en ondertroeven mag niet: je moet over je maat heen."
}

// winnerChoice explains c among legal cards that all win the trick (they
// are all of one suit).
func (m *explainer) winnerChoice(c game.Card) string {
	trump := m.t.trump
	cs := game.CardShortNL(c)
	low, _ := m.legal.bottom(c.Suit, trump)
	sure := m.certain(c)
	pts := game.Points(c, trump)
	kept := "kaarten"
	if c.Suit == trump {
		kept = "troeven"
	}
	lowest := "Speel je laagste, " + cs
	if m.hand.lower(c, trump) != 0 {
		lowest = "Speel de laagste troef die mag, " + cs // lower trumps may not be played
	}
	switch r := m.roemGain(c); {
	case r > 0:
		return "Met " + cs + " komt er " + strconv.Itoa(r) + " roem bij voor jullie (" + m.roemNames(c) + ")."
	case c == low && sure:
		return lowest + ": daarmee is de slag al zeker voor jullie."
	case c == low:
		return lowest + ", en bewaar je hogere " + kept + "."
	case sure && !m.certain(low):
		return "Speel " + cs + ": daarmee is de slag zeker voor jullie, met een lagere kaart nog niet."
	case sure && pts >= 10:
		return "Speel " + cs + ": de slag is zeker voor jullie, en zo komen er " + strconv.Itoa(pts) + " punten bij."
	}
	// Neither card is sure: c leaves the opponents behind fewer cards that
	// beat it than low does.
	if between := m.oppsAfterMayHold(m.unk.higher(low, trump) &^ m.unk.higher(c, trump)); between != 0 {
		with := "met veel meer kaarten"
		if names := namesHighToLow(between, trump); len(names) <= 2 {
			with = "ook met " + joinOr(names)
		}
		return "Speel " + cs + ": " + m.onlyOver(c) + ". Met " + game.CardShortNL(low) + " kan de tegenstander achter je " + with + " hoger komen."
	}
	return "Speel " + cs + ": " + m.noReason(c, "dat levert hier naar verwachting het meeste op", "") + "."
}

// onlyOver says what can still beat c, winning the trick, from the
// opponents after the mover: "daar kan alleen ♠A of een troef nog
// overheen". Some card can (c is not certain).
func (m *mover) onlyOver(c game.Card) string {
	trump := m.t.trump
	ruff := false
	after, n := m.afterMe()
	for _, p := range after[:n] {
		if p.Team() != m.seat.Team() && c.Suit != trump && m.mayTrump(p) {
			ruff = true
		}
	}
	over := namesHighToLow(m.oppsAfterMayHold(m.unk.higher(c, trump)), trump)
	if len(over) > 2 {
		over = []string{"een hogere " + game.SuitNameNL(c.Suit)}
		if c.Suit == trump {
			over = []string{"een hogere troef"}
		}
	}
	switch {
	case len(over) == 0 && m.isBoss(c):
		return "dat is de hoogste " + game.SuitNameNL(c.Suit) + ", daar kan alleen een troef nog overheen"
	case len(over) == 0:
		return "daar kan na jou alleen een troef nog overheen"
	case ruff:
		return "daar kan alleen " + joinOr(append(over, "een troef")) + " nog overheen"
	}
	return "daar kan alleen " + joinOr(over) + " nog overheen"
}

// roemNames names the roem that c adds to the trick ("driekaart en stuk").
func (m *mover) roemNames(c game.Card) string {
	return addedRoemNames(m.t.trick[:m.t.n], c, m.t.trump)
}

// addedRoemNames names the roem that c adds to the cards before.
func addedRoemNames(before []game.Card, c game.Card, trump game.Suit) string {
	had := game.TrickRoem(before, trump)
	var names []string
	for _, r := range game.TrickRoem(append(append([]game.Card(nil), before...), c), trump) {
		if i := slices.Index(had, r); i >= 0 {
			had = slices.Delete(had, i, i+1)
			continue
		}
		names = append(names, r.NameNL())
	}
	return joinNL(names)
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
	cards := make([]game.Card, 0, 4)
	seen, overtrumped := false, false // overtrumped: a trump fell before the winning card
	var under []string                // players who undertrumped after it
	for _, p := range t.Cards {
		cards = append(cards, p.Card)
		switch {
		case p.Seat == t.Winner:
			win, seen = p.Card, true
		case p.Card.Suit == trump && !seen:
			overtrumped = true
		case p.Card.Suit == trump:
			under = append(under, names[p.Seat])
		}
	}
	name := names[t.Winner]
	var b strings.Builder
	switch {
	case win.Suit == trump && led == trump:
		b.WriteString(name + " wint de slag met " + game.CardShortNL(win) + ", de hoogste troef.")
	case win.Suit == trump && overtrumped:
		b.WriteString(name + " wint de slag met " + game.CardShortNL(win) + ": overgetroefd met de hoogste troef.")
	case win.Suit == trump:
		b.WriteString(name + " troeft in met " + game.CardShortNL(win) + " (geen " + led.Symbol() + ") en wint de slag")
		switch {
		case len(under) == 1:
			b.WriteString("; " + under[0] + " moest ondertroeven")
		case len(under) > 1:
			b.WriteString("; " + joinNL(under) + " moesten ondertroeven")
		}
		b.WriteString(".")
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

// joinOr joins alternatives as "a, b of c".
func joinOr(items []string) string {
	if len(items) < 2 {
		return joinNL(items)
	}
	return strings.Join(items[:len(items)-1], ", ") + " of " + items[len(items)-1]
}

func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}
