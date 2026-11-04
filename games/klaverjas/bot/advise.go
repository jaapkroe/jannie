package bot

import (
	"hash/fnv"
	"slices"
	"strconv"
	"strings"

	"jannie/games/klaverjas/game"
)

// Advice is a training hint: exactly one of Card, Suit or Play is set for
// the decision at hand, with a Dutch explanation.
type Advice struct {
	Card *game.Card
	Suit *game.Suit
	Play *bool
	Text string // e.g. "Speel ♥A: de aas is de hoogste kaart in harten en levert 11 punten op."
}

// Advise returns advice for the player of v, whose turn it must be
// (otherwise, and should the search fail, it returns no advice). Trump and
// bid advice is the sterk choice. A play hint is the rule-based card with
// the reason of its rule, unless the search rates another card clearly
// higher (see teachPick). Options are valued by the points they bring
// alone, without a bot's appetite for pit (adviseSearch). The same view
// always gets the same advice.
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
		st := searchTrump(&v, adviseSearch, seed, 0.5)
		s := bestSuit(st, v.Forced, v.Turned)
		return Advice{Suit: &s, Text: trumpText(&v, s, st[s])}
	case game.PhaseBid:
		play, pass := searchBid(&v, adviseSearch, seed, 0.5)
		p := play.mean() > pass.mean()
		return Advice{Play: &p, Text: bidText(&v, p, play)}
	case game.PhasePlay:
		legal := legalCards(v)
		if len(legal) == 0 {
			return Advice{}
		}
		v.Legal = legal
		tab := tableFromView(&v)
		m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(legal), 0.5)
		c, r := m.decide()
		text := hintText(c, m.ruleWhy(c, r))
		if len(legal) > 1 {
			c, text = teachPick(&m, searchPlay(&v, &tab, adviseSearch, seed, 0.5), c, r)
		}
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
// when they fall in the same trick
// (games/klaverjas/README.md#roem-bonus-points-roem-op-tafel), which one
// player cannot do.
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
		// When all four pass, voorhand chooses another suit
		// (games/klaverjas/README.md#choosing-trump-trumpmode).
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
// up for the rule-based card (see teachPick).
const teachTolerance = 5

// teachPick returns the card of a play hint and its text, from the search
// res of m's legal cards and the rule-based card pref, chosen by rule r.
// It is pref with the reason of its rule, unless the sterk card is better
// by at least teachTolerance points and two paired standard errors: then
// it is the sterk card, with how much more it brings and where (searchWhy).
// So the hint's reason is always what chose its card.
func teachPick(m *mover, res []playResult, pref game.Card, r rule) (game.Card, string) {
	i, j := sterkPick(m, res, pref), resultIndex(res, pref)
	if j < 0 || i == j || res[i].mean()-res[j].mean() < max(teachTolerance, 2*pairSE(res, i, j)) {
		return pref, hintText(pref, m.ruleWhy(pref, r))
	}
	return res[i].card, hintText(res[i].card, m.searchWhy(res, i, j))
}

// hintText is the play hint for c with reason why: "Speel ♠V: " + why.
func hintText(c game.Card, why string) string { return "Speel " + game.CardShortNL(c) + ": " + why }

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

// addedRoemNames names the roem that c adds to the cards before. Roem that
// c turns into more is named too, so the names add up to the points
// added: "vierkaart en stuk in plaats van driekaart" (50 + 20 - 20).
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
	text := joinNL(names)
	if len(had) > 0 {
		gone := make([]string, len(had))
		for i, r := range had {
			gone[i] = r.NameNL()
		}
		text += " in plaats van " + joinNL(gone)
	}
	return text
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

// Signal is a card that told the partner something at this table
// (games/klaverjas/README.md#seinen-signals), as everyone there reads it.
type Signal struct {
	Seat game.Seat
	Card game.Card
	// Kind is the agreement, as in game.Signals: "kleintjeBoer" and
	// "boerOverBoer" (a lead), "aas" and "hoogLaag" (a low discard).
	Kind string
	// Means is the card the signal says Seat holds: the trump boer, the
	// 10 (met de aas seinen), or the highest card left in the suit
	// (opseinen).
	Means game.Card
}

// TrickSignals returns the signals given in the last completed trick of v
// at a table of four, in the order played, as the table reads them
// (signalsBoer, aceSignal, lowSignal): what the bots read, whether or not
// it is true.
func TrickSignals(v game.View) []Signal {
	if v.Players != 4 || !v.TrumpKnown || len(v.Tricks) == 0 {
		return nil
	}
	t := newTable(v.Voorhand, v.Trump, v.TrumpBy, v.Rules, game.SignalsOf(&v))
	last := len(v.Tricks) - 1
	for _, tr := range v.Tricks[:last] {
		for _, p := range tr.Cards {
			t.apply(p.Seat, p.Card)
		}
	}
	var out []Signal
	for _, p := range v.Tricks[last].Cards {
		if s, ok := t.signal(p.Seat, p.Card); ok {
			out = append(out, s)
		}
		t.apply(p.Seat, p.Card)
	}
	return out
}

// SignalChance returns a signal the player of v, on their turn in play at
// a table of four, can give truthfully now: a legal card whose signal
// says what the hand holds. prefer is tried first (the hint), then the
// legal cards in order. ok is false without one.
func SignalChance(v game.View, prefer game.Card) (s Signal, ok bool) {
	if v.Players != 4 || v.Phase != game.PhasePlay || !v.TrumpKnown || v.Turn != v.Seat {
		return Signal{}, false
	}
	legal := legalCards(v)
	t := tableFromView(&v)
	hand := setOf(v.Hand)
	order := legal
	if slices.Contains(legal, prefer) {
		order = append([]game.Card{prefer}, legal...)
	}
	for _, c := range order {
		if s, ok := t.signal(v.Seat, c); ok && hand.has(s.Means) {
			return s, true
		}
	}
	return Signal{}, false
}

// signal is the signal seat gives by playing c next, as the table reads
// it.
func (t *table) signal(seat game.Seat, c game.Card) (Signal, bool) {
	s := Signal{Seat: seat, Card: c}
	switch {
	case t.n == 0 && t.signalsBoer(seat, c):
		s.Kind, s.Means = "kleintjeBoer", jackOf(t.trump)
		if c.Rank == game.Jack {
			s.Kind = "boerOverBoer"
		}
	case t.n == 0:
		return Signal{}, false
	default:
		if ten, ok := t.aceSignal(c); ok {
			s.Kind, s.Means = "aas", ten
		} else if hi, ok := t.lowSignal(c); ok {
			s.Kind, s.Means = "hoogLaag", hi
		} else {
			return Signal{}, false
		}
	}
	return s, true
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
