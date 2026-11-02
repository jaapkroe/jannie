package bot

import (
	"math"
	"strconv"
	"strings"

	"klaverjas/internal/game"
)

// The reasons of play hints (design §4.2). A hint gives the reason of what
// chose its card: the rule of the rule-based policy (ruleWhy), or, for a
// card the search rates clearly higher, how much more it brings and in
// which part of the value (searchWhy). What the card signals at the table
// is added as a note (signalNote).

// ruleWhy is the reason of rule r for card c, the text after "Speel ♠V: ".
func (m *mover) ruleWhy(c game.Card, r rule) string {
	t := m.t
	cs := game.CardShortNL(c)
	switch r {
	case ruleOnly:
		if m.hand.count() == 1 {
			return "dat is je laatste kaart."
		}
		return onlyCardReason(t, m.hand, m.seat, c) + "."
	case ruleAskedTrump:
		return "je maat vroeg met een kleintje om troef (kleintje boer), dus speel troef naar je maat toe."
	case ruleKleintjeBoer:
		return "met een kleintje laat je je maat weten dat jij de troefboer hebt (kleintje boer). Neemt je maat de slag, dan speelt die troef terug."
	case rulePullTrump:
		return "dit is de hoogste troef die er nog is. Jullie spelen, dus haal de troeven van de tegenstanders eruit."
	case rulePullLow:
		return "jullie spelen, dus haal de troeven van de tegenstanders eruit. Je hoge troeven houd je achter de hand."
	case ruleDefendTrump:
		return "dit is de hoogste troef die er nog is. Als tegenpartij kom je meestal niet met troef uit, " +
			"maar zo pak je de slag en haal je troeven weg bij de spelende partij."
	case ruleCash:
		return m.cashWhy(c)
	case ruleLead:
		return m.leadWhy(c) + m.signalNote(c)
	case ruleTrumpNotFake:
		return "met een kleintje van een bijkleur zou je kleintje boer seinen (“ik heb de troefboer”), maar die heb je niet. Met troef gebeurt dat niet."
	case ruleOnlyTrumps:
		return "je hebt alleen nog troef."
	case ruleSmear:
		return m.partnerHas() + ", dus spek hem: " + m.smearWhy(c) + m.signalNote(c)
	case ruleThrow:
		text := m.partnerHas()
		if why := m.keptWhy(m.richest(), c, false); why != "" {
			text += ", maar " + why
		}
		return text + ". " + m.discardWhy(c, false) + m.signalNote(c)
	case ruleSecure:
		return "je maat heeft de slag nog niet zeker. Daarmee neem je hem over" + m.unbeaten(c) + m.pointsSoFar(c) + "." + m.roemNote(c)
	case ruleThrowUnsure:
		return "je maat heeft de slag nog niet zeker, dus geef er geen punten bij. " + m.discardWhy(c, false) + m.signalNote(c)
	case ruleLastWin:
		return "je speelt als laatste, dus daarmee is de slag van jou" + m.pointsSoFar(c) + "." + m.roemNote(c)
	case ruleSafeWin:
		if c.Suit == t.trump && t.led() != t.trump {
			return "je kunt niet bekennen. Daarmee troef je in, en niemand na je kan nog overtroeven" + m.pointsSoFar(c) + "." + m.roemNote(c)
		}
		return "daarmee pak je de slag" + m.unbeaten(c) + m.pointsSoFar(c) + "." + m.roemNote(c)
	case ruleCheapRuff:
		return "je kunt niet bekennen en de slag is weinig waard, dus troef met je laagste troef die wint. Je hoge troeven houd je achter de hand." +
			m.roemNote(c)
	case ruleForcedWin:
		if c.Suit == t.trump && t.led() != t.trump {
			return "je kunt niet bekennen en moet troeven. Met je laagste troef die wint neem je de slag voorlopig." + m.roemNote(c)
		}
		return "elke kaart die je mag spelen gaat er voorlopig overheen, en " + cs + " kost het minst." + m.roemNote(c)
	}
	// ruleDuck
	head := "je kunt de slag niet winnen"
	if _, ok := m.bestWinner(false, false); ok {
		head = "je kunt de slag niet zeker winnen: na jou kan er nog overheen"
	}
	return head + ", dus geef zo weinig mogelijk weg. " + m.discardWhy(c, true) + m.signalNote(c)
}

// cashWhy is the reason for cashing c, a side card that no outstanding card
// beats: with its ace in hand the 10 goes first.
func (m *mover) cashWhy(c game.Card) string {
	suit := game.SuitNameNL(c.Suit)
	if ace := aceOf(c.Suit); c.Rank == game.Ten && m.hand.has(ace) {
		as := game.CardShortNL(ace)
		text := "je hebt " + as + " zelf, dus de 10 wint net zo goed."
		if n, _ := m.openRuns(c); n > 0 && m.noRuns(ace) {
			text += " Met de 10 kan er nog roem in de slag komen, met de aas niet."
		}
		return text + " Daarna is je " + as + " de hoogste " + suit + "."
	}
	if !m.oppsMayTrump() {
		return "dit is de hoogste " + suit + " die er nog is, en de tegenstanders hebben geen troef meer: een zekere slag."
	}
	return "dit is de hoogste " + suit + " die er nog is: haal de slag binnen voordat iemand kan troeven."
}

// leadWhy is the reason of leadCost for c, the cheapest sensible lead: the
// bonus that c got, or that it is cheap.
func (m *mover) leadWhy(c game.Card) string {
	s := c.Suit
	suit := game.SuitNameNL(s)
	if plain, _ := m.cheapestLead(false); plain != c {
		// The roem term decided: the lead without it gives the opponents
		// roem, or c brings roem for us.
		if m.leadRoem(plain) < 0 {
			return "met " + game.CardShortNL(plain) + " kunnen de tegenstanders in deze slag roem maken: " + m.runCards(plain) + "."
		}
		return "daarmee kan er in deze slag roem bij komen voor jullie: " + m.runCards(c) + "."
	}
	if hi, ok := m.partnerHigh(s); ok && !m.oppMayRuff(s) {
		return m.partnerSaid(hi) + "."
	}
	if p := m.partner(); m.voidIn(p, s) && m.mayTrump(p) && !m.oppMayRuff(s) {
		return "je maat heeft geen " + suit + " meer en kan troeven."
	}
	if low := cheapest(m.legal.appendCards(nil), m.t.trump); low != c && m.fakeSignal(low) {
		return "met " + game.CardShortNL(low) + " zou je kleintje boer seinen (“ik heb de troefboer”), maar die heb je niet."
	}
	if m.hand.countSuit(s) == 1 && m.hand.inSuit(m.t.trump) != 0 {
		return "dit is je laatste " + suit + ". Dan ben je die kleur kwijt en kun je later troeven."
	}
	if c.Rank <= game.Nine {
		return "een lage kaart kost weinig, en je hoge kaarten bewaar je voor later."
	}
	return "dit is je goedkoopste uitkomst: je hogere kaarten bewaar je voor later."
}

// runCards says which cards still out could make roem with c in its
// trick: "♠9, ♠10 en ♠B zijn nog in het spel".
func (m *mover) runCards(c game.Card) string {
	_, cards := m.openRuns(c)
	var names []string
	for _, x := range cards.appendCards(nil) {
		names = append(names, game.CardShortNL(x))
	}
	if len(names) == 1 {
		return names[0] + " is nog in het spel"
	}
	return joinNL(names) + " zijn nog in het spel"
}

// partnerHas opens the reason for a card on the partner's trick that the
// policy counts as safe: sure, or only a trump can still take it.
func (m *mover) partnerHas() string {
	if m.certain(m.t.best) {
		return "je maat heeft de slag zeker"
	}
	return "je maat heeft de slag (alleen een troef kan er nog overheen)"
}

// unbeaten says, after "daarmee pak je de slag", who can still beat c, a
// safe winner: nobody, or only a trump.
func (m *mover) unbeaten(c game.Card) string {
	if m.certain(c) {
		return ", en niemand na je kan er nog overheen"
	}
	return ", tenzij iemand na je troeft"
}

// certain reports whether w, winning the trick once the mover has played,
// cannot be beaten: it is safe (no higher card of its suit behind, no
// known void that trumps), and as a side card no opponent behind may hold
// a trump.
func (m *mover) certain(w game.Card) bool {
	if !m.safe(w, m.t.led()) {
		return false
	}
	if w.Suit == m.t.trump {
		return true
	}
	after, n := m.afterMe()
	for _, p := range after[:n] {
		if p.Team() != m.seat.Team() && m.mayTrump(p) {
			return false
		}
	}
	return true
}

// smearWhy says what c gives to the partner's trick, and why the card with
// the most points stays in hand when it does (keptWhy).
func (m *mover) smearWhy(c game.Card) string {
	trump := m.t.trump
	pts, roem := game.Points(c, trump), m.roemGain(c)
	var text string
	switch {
	case roem > 0 && pts > 0:
		text = count(pts, "punt", "punten") + " en " + strconv.Itoa(roem) + " roem (" + m.roemNames(c) + ") erbij"
	case roem > 0:
		text = strconv.Itoa(roem) + " roem (" + m.roemNames(c) + ") erbij"
	default:
		text = count(pts, "punt", "punten") + " erbij"
	}
	if p := m.richest(); game.Points(p, trump) > pts {
		if why := m.keptWhy(p, c, false); why != "" {
			text += "; " + why
		}
	}
	return text + "."
}

// richest returns the legal side card worth the most points, or the first
// legal card when there is none.
func (m *mover) richest() game.Card {
	best, most := game.CardFromIndex(trailing(m.legal)), -1
	for s := m.legal &^ suitSet(m.t.trump); s != 0; s &= s - 1 {
		c := game.CardFromIndex(trailing(s))
		if p := game.Points(c, m.t.trump); p > most {
			best, most = c, p
		}
	}
	return best
}

// discardWhy says why discard chose c: why the plainly cheapest card stays
// in hand (keptWhy), or else that c is worth nothing or costs least.
func (m *mover) discardWhy(c game.Card, toOpp bool) string {
	if p := cheapest(m.legal.appendCards(nil), m.t.trump); p != c {
		if why := m.keptWhy(p, c, toOpp); why != "" {
			return capital(why) + "."
		}
	}
	cs := game.CardShortNL(c)
	if game.Points(c, m.t.trump) == 0 {
		return cs + " is niets waard."
	}
	return cs + " kost het minst."
}

// keptWhy says which of the policy's costs kept p in hand, a card that
// looks cheaper or richer than c, the card played: "" when none did.
func (m *mover) keptWhy(p, c game.Card, toOpp bool) string {
	t := m.t
	ps := game.CardShortNL(p)
	suit := game.SuitNameNL(p.Suit)
	switch {
	case p.Suit == t.trump && c.Suit != t.trump:
		return "je troeven houd je achter de hand"
	case toOpp && m.roemGain(p) > 0:
		return "met " + ps + " zou je de tegenstanders " + strconv.Itoa(m.roemGain(p)) + " roem geven (" + m.roemNames(p) + ")"
	case p.Suit != t.trump && m.isBoss(p) && m.unk.inSuit(p.Suit) != 0:
		return ps + " is de hoogste " + suit + " en kan zelf nog een slag halen"
	case m.falseLow(p):
		return ps + " zou je maat lezen als “speel " + suit + ", daar heb ik de hoogste van” (opseinen), maar die heb je niet"
	case m.falseAce(p):
		return ps + " zou je maat lezen als “ik heb " + game.CardShortNL(tenOf(p.Suit)) + " ook” (met de aas seinen), maar die heb je niet"
	case m.guardPenalty(p) > 0:
		return ps + " houd je als dekking van je " + game.CardShortNL(tenOf(p.Suit))
	}
	return ""
}

// capital starts s with a capital letter.
func capital(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}

// pointsSoFar says what the trick holds once c is played: " (14 punten)",
// or "" when it holds none.
func (m *mover) pointsSoFar(c game.Card) string {
	if n := m.t.points + game.Points(c, m.t.trump); n > 0 {
		return " (" + count(n, "punt", "punten") + ")"
	}
	return ""
}

// roemNote is the sentence, starting with a space, on the roem that c adds
// to a trick the mover takes; "" without roem.
func (m *mover) roemNote(c game.Card) string {
	if r := m.roemGain(c); r > 0 {
		return " Je maakt er " + strconv.Itoa(r) + " roem bij (" + m.roemNames(c) + ")."
	}
	return ""
}

// signalNote is the sentence, starting with a space, on what c tells the
// partner at this table (design §8): a signal given truthfully, or a
// warning when the partner would read something untrue; "" otherwise.
func (m *mover) signalNote(c game.Card) string {
	t := m.t
	if t.n == 0 {
		if !t.signalsBoer(m.seat, c) {
			return ""
		}
		name := "kleintje boer"
		if c.Rank == game.Jack {
			name = "boer over boer"
		}
		if m.hand.has(jackOf(t.trump)) {
			return " Zo zeg je ook dat jij de troefboer hebt (" + name + ")."
		}
		return " Let op: je maat kan dit lezen als " + name + " (“ik heb de troefboer”), maar die heb je niet."
	}
	suit := game.SuitNameNL(c.Suit)
	if ten, ok := t.aceSignal(c); ok {
		switch {
		case m.hand.has(ten):
			return " Je hebt ook " + game.CardShortNL(ten) + ", en dat weet je maat nu (met de aas seinen): zonder de aas is je 10 de hoogste " +
				suit + " en kan die nog een slag halen."
		case m.falseAce(c):
			return " Let op: je maat kan dit lezen als “ik heb " + game.CardShortNL(ten) + " ook” (met de aas seinen), maar die heb je niet."
		}
		return ""
	}
	if hi, ok := t.lowSignal(c); ok {
		switch {
		case m.hand.has(hi):
			return " Zo zeg je ook tegen je maat: “speel " + suit + ", daar heb ik de hoogste van” (opseinen)."
		case m.falseLow(c):
			return " Let op: je maat kan dit lezen als “speel " + suit + ", daar heb ik de hoogste van” (opseinen), maar die heb je niet."
		}
		return ""
	}
	if m.highDiscard(c) {
		return " Met deze bijkaart zeg je ook dat je de hoogste " + suit + " niet hebt (afseinen)."
	}
	return ""
}

// searchWhy is the reason for res[i], the card the search rates clearly
// above res[j], the rule-based card: how much more it brings, in which part
// of the value mainly and what the playouts of the two do differently (see
// gainWhy), and what res[i] signals.
func (m *mover) searchWhy(res []playResult, i, j int) string {
	return m.gainWhy(res, i, j) + m.signalNote(res[i].card)
}

// gainWhy says how much more res[i] brings than res[j], and in which part of
// the value mainly (two parts when the largest is under 60% of the gap, or
// when nat brings at least 40% of it: the points in this trick and in the
// later ones partly cancel, so either can look larger than nat), followed by
// what the playouts of the two cards do differently in the same deals
// (diffWhy), when something stands out.
func (m *mover) gainWhy(res []playResult, i, j int) string {
	b, r := res[i], res[j]
	gap := b.mean() - r.mean()
	var d [numParts]float64
	for k := range d {
		d[k] = b.part(k) - r.part(k)
	}
	k1 := 0
	for k := range d {
		if d[k] > d[k1] {
			k1 = k
		}
	}
	k2 := -1
	if k1 != partNat && d[partNat] >= 0.4*gap {
		k2 = partNat
	} else if d[k1] < 0.6*gap {
		for k := range d {
			if k != k1 && d[k] > 0 && (k2 < 0 || d[k] > d[k2]) {
				k2 = k
			}
		}
	}
	where := m.partWhere(k1, b, r)
	if k2 >= 0 {
		where += " en " + m.partWhere(k2, b, r)
	}
	text := "volgens de berekening levert dat gemiddeld " + count(int(math.Round(gap)), "punt", "punten") + " meer op dan " +
		game.CardShortNL(r.card) + ", vooral " + where + "."
	if diff := diffWhy(b.card, r.card, gap, b.ev, r.ev, nil, m.hand, m.t.trump); diff != "" {
		text += " " + diff
	}
	return text
}

// optionWhy is the reason in the reasoning's row of res[i], a card the
// search values below res[best]: how much more the best brings, where and
// what differs (gainWhy), and whether that may be noise.
func (m *mover) optionWhy(res []playResult, best, i int) string {
	gap := res[best].mean() - res[i].mean()
	b, o := game.CardShortNL(res[best].card), game.CardShortNL(res[i].card)
	if math.Round(gap) == 0 {
		return b + " en " + o + " zijn volgens de berekening even goed: het verschil is minder dan een half punt."
	}
	text := b + ": " + m.gainWhy(res, best, i)
	if gap < 2*pairSE(res, best, i) {
		text += " Dat verschil is kleiner dan twee keer de standaardfout en kan toeval zijn."
	}
	return text
}

// partWhere names part k of the value, where card b gains over card r. A
// change in the chance of nat is the reason only if it explains at least a
// third of the gain in nat, a hand that turns nat counting for the 162 card
// points. Otherwise the gain is in what the hands that go nat are worth;
// the share is the higher of the two cards'.
func (m *mover) partWhere(k int, b, r playResult) string {
	switch k {
	case partPointsNow:
		return "in de punten van deze slag"
	case partPointsLater:
		return "in de punten van de latere slagen"
	case partRoemNow:
		return "in de roem van deze slag"
	case partRoemLater:
		return "in de roem van de latere slagen"
	case partPit:
		return "door de kans op pit"
	}
	ob, or := b.outcome(), r.outcome()
	changed := func(hi, lo float64) bool {
		return wholePercent(hi) > wholePercent(lo) && 162*(hi-lo) >= (b.part(partNat)-r.part(partNat))/3
	}
	switch {
	case m.ourTeamPlays() && changed(or.NatUs, ob.NatUs):
		return "doordat jullie minder vaak nat gaan (" + percent(ob.NatUs) + " tegen " + percent(or.NatUs) + ")"
	case m.ourTeamPlays():
		return "doordat alle punten en roem naar de tegenstanders gaan als jullie nat gaan (" + percent(max(ob.NatUs, or.NatUs)) + ")"
	case changed(ob.NatThem, or.NatThem):
		return "doordat de tegenstanders vaker nat gaan (" + percent(ob.NatThem) + " tegen " + percent(or.NatThem) + ")"
	}
	return "doordat alle punten en roem naar jullie gaan als de tegenstanders nat gaan (" + percent(max(ob.NatThem, or.NatThem)) + ")"
}

// percent is a share as a whole percentage: "25%".
func percent(f float64) string { return strconv.Itoa(wholePercent(f)) + "%" }

func wholePercent(f float64) int { return int(math.Round(100 * f)) }

// noRuns reports whether c has no open run (see openRuns).
func (m *mover) noRuns(c game.Card) bool {
	n, _ := m.openRuns(c)
	return n == 0
}

// partnerSaid says how the partner told that it holds hi, the highest card
// of its suit (see partnerHigh), and so why a lead in that suit goes to
// the partner: "je maat gooide ♠A bij en zei daarmee “ik heb ♠10 ook”
// (met de aas seinen), dus zo speel je schoppen naar je maat toe".
func (m *mover) partnerSaid(hi game.Card) string {
	s := hi.Suit
	name := game.SuitNameNL(s)
	by := m.t.sigBy[m.partner()].inSuit(s)
	if a := aceOf(s); hi == tenOf(s) && by.has(a) {
		return "je maat gooide " + game.CardShortNL(a) + " bij en zei daarmee “ik heb " + game.CardShortNL(hi) +
			" ook” (met de aas seinen), dus zo speel je " + name + " naar je maat toe"
	}
	low, _ := by.bottom(s, m.t.trump)
	return "je maat gooide " + game.CardShortNL(low) + " bij en zei daarmee “speel " + name +
		", daar heb ik de hoogste van” (opseinen), dus zo speel je " + name + " naar je maat toe"
}

// highDiscard reports whether discarding c says truthfully what
// afseinen reads in it (design §8), at a table that agreed on op- en
// afseinen: c is a 10 or plaatje of a side suit that was not led, on the
// partner's trick, and at most one other card of that suit stays, not the
// highest card of the suit still out: "de hoogste van deze kleur heb ik
// niet".
func (m *mover) highDiscard(c game.Card) bool {
	t := m.t
	if !t.sig.HoogLaag || !t.partnersTrick() || c.Suit == t.trump || c.Suit == t.led() {
		return false
	}
	switch c.Rank {
	case game.Ten, game.Jack, game.Queen, game.King:
	default:
		return false
	}
	rest := m.hand.inSuit(c.Suit) &^ bit(c)
	hi, ok := (suitSet(c.Suit) &^ t.played &^ bit(c)).top(c.Suit, t.trump)
	return ok && rest.count() <= 1 && !rest.has(hi)
}

// roemNames names the roem that c adds to the trick ("driekaart en stuk").
func (m *mover) roemNames(c game.Card) string {
	return addedRoemNames(m.t.trick[:m.t.n], c, m.t.trump)
}

// sterkReason says why sterk plays res[i] although the search valued
// another card more (sterkChoose's w): a false signal it does not give for
// so little, or the rule-based card kept as close enough. "" when res[i] is
// a card the search valued most. A difference is rounded down and a
// tolerance up, so the text never contradicts its threshold.
func (m *mover) sterkReason(res []playResult, i int, w sterkWhy) string {
	top := res[i].total
	for _, r := range res {
		top = max(top, r.total)
	}
	if res[i].total == top {
		return ""
	}
	var text []string
	if w.liar >= 0 {
		l, h := res[w.liar], res[w.honest]
		text = append(text, game.CardShortNL(l.card)+" is volgens de berekening "+tenthsDownNL(l.mean()-h.mean())+" punten beter dan "+
			game.CardShortNL(h.card)+", maar "+m.lieWhat(l.card)+", en die heb je niet. Een vals sein speelt Sterk pas als het minstens "+
			count(int(w.lie), "punt", "punten")+" meer oplevert.")
	}
	p, o, d := game.CardShortNL(res[i].card), "", ""
	if w.kept != keptNone {
		o, d = game.CardShortNL(res[w.over].card), tenthsDownNL(res[w.over].mean()-res[i].mean())
	}
	switch w.kept {
	case keptNoise:
		text = append(text, o+" is volgens de berekening minder dan 1 punt beter: dan speelt Sterk de kaart van Normaal.")
	case keptBoer:
		text = append(text, p+" is "+boerSignal(res[i].card)+". Dat sein mag Sterk tot "+count(signalTolerance, "punt", "punten")+
			" kosten, en "+o+" is volgens de berekening "+d+" punten beter.")
	case keptAlike:
		text = append(text, p+" en "+o+" winnen en verliezen even vaak, en "+o+" is volgens de berekening "+d+
			" punten beter, minder dan "+toleranceNL(w.tol)+": dan speelt Sterk de kaart van Normaal.")
	case keptAbove:
		text = append(text, p+", de kaart van Normaal, is ook een vals sein, maar de berekening zet die hoger dan "+o+": die speelt Sterk.")
	}
	return strings.Join(text, " ")
}

// boerSignal names the signal of side card c led as the first card of the
// playing team: boer over boer with a boer, else kleintje boer.
func boerSignal(c game.Card) string {
	if c.Rank == game.Jack {
		return "boer over boer"
	}
	return "kleintje boer"
}

// lieWhat says what false signal c would give: "je maat zou ♦9 lezen als
// “speel ruiten, daar heb ik de hoogste van” (opseinen)" (see lieGain).
func (m *mover) lieWhat(c game.Card) string {
	cs := game.CardShortNL(c)
	switch {
	case m.falseAce(c):
		return "je maat zou " + cs + " lezen als “ik heb " + game.CardShortNL(tenOf(c.Suit)) + " ook” (met de aas seinen)"
	case m.fakeSignal(c):
		return "met " + cs + " zou je " + boerSignal(c) + " seinen (“ik heb de troefboer”)"
	}
	return "je maat zou " + cs + " lezen als “speel " + game.SuitNameNL(c.Suit) + ", daar heb ik de hoogste van” (opseinen)"
}

// hintKeptReason says why the hint keeps the rule-based card res[j] while
// sterk plays res[i] (see teachPick): the search does not rate sterk's card
// clearly higher.
func hintKeptReason(res []playResult, i, j int) string {
	return "Sterk is volgens de berekening " + tenthsDownNL(res[i].mean()-res[j].mean()) + " punten beter dan de kaart van Normaal, minder dan " +
		toleranceNL(max(teachTolerance, 2*pairSE(res, i, j))) + ": dan blijft de tip bij die kaart."
}

// toleranceNL names the hints' tolerance tol, rounded up: "5 punten", or
// "twee keer de standaardfout van dat verschil (12,4 punten)" when two
// standard errors are more.
func toleranceNL(tol float64) string {
	if tol <= teachTolerance {
		return count(teachTolerance, "punt", "punten")
	}
	return "twee keer de standaardfout van dat verschil (" + tenthsNL(math.Ceil(10*tol)/10) + " punten)"
}

// tenthsDownNL is tenthsNL of x rounded down: a difference stays below the
// threshold it is measured against.
func tenthsDownNL(x float64) string { return tenthsNL(math.Floor(10*x+1e-9) / 10) } // a hair over: not floating-point noise

// tenthsNL writes x to one decimal with a decimal comma, as the reasoning's
// table does: "14,2".
func tenthsNL(x float64) string {
	return strings.Replace(strconv.FormatFloat(math.Round(10*x)/10, 'f', 1, 64), ".", ",", 1)
}
