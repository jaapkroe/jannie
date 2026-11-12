package bot

import (
	"math/bits"

	"jannie/games/klaverjas/game"
)

// mover is one player's view of the table at its turn: the public table
// plus its own hand. The rule-based (normaal) policy works on it; it is
// also the playout policy of the Monte Carlo search, so it must be fast
// and must not look at other players' cards.
type mover struct {
	t     *table
	seat  game.Seat
	hand  cardSet
	legal cardSet
	unk   cardSet    // cards held by the other three players
	poss  [4]cardSet // cards each other seat may hold
	aggr  float64    // persona aggression, 0..1
}

func newMover(t *table, seat game.Seat, hand, legal cardSet, aggr float64) mover {
	m := mover{t: t, seat: seat, hand: hand, legal: legal, unk: allCards &^ t.played &^ hand, aggr: aggr}
	var need [4]int
	for p := range m.poss {
		if game.Seat(p) != seat {
			m.poss[p] = m.unk &^ t.excl[p]
			need[p] = 8 - t.playedBy[p].count()
		}
	}
	// Counting: a seat whose possible cards exactly fill its hand holds
	// them all, so nobody else does.
	for range 2 {
		changed := false
		for p := range m.poss {
			if game.Seat(p) == seat || m.poss[p].count() != need[p] {
				continue
			}
			for q := range m.poss {
				if q != p && game.Seat(q) != seat && m.poss[q]&m.poss[p] != 0 {
					m.poss[q] &^= m.poss[p]
					changed = true
				}
			}
		}
		if !changed {
			break
		}
	}
	return m
}

func (m *mover) partner() game.Seat { return m.seat.Partner() }
func (m *mover) ourTeamPlays() bool { return m.t.playing == m.seat.Team() }
func (m *mover) opps() [2]game.Seat { return [2]game.Seat{m.seat.Next(), m.seat.Next().Partner()} }

// mayHold returns the cards of set that seat p might hold.
func (m *mover) mayHold(p game.Seat, set cardSet) cardSet {
	return set & m.poss[p]
}

// voidIn reports whether p certainly holds no card of suit s.
func (m *mover) voidIn(p game.Seat, s game.Suit) bool {
	return m.mayHold(p, suitSet(s)) == 0
}

// mayTrump reports whether p might still hold a trump.
func (m *mover) mayTrump(p game.Seat) bool {
	return m.mayHold(p, suitSet(m.t.trump)) != 0
}

// oppsMayTrump reports whether an opponent might still hold a trump.
func (m *mover) oppsMayTrump() bool {
	o := m.opps()
	return m.mayTrump(o[0]) || m.mayTrump(o[1])
}

// isBoss reports whether no outstanding card of c's suit is stronger.
func (m *mover) isBoss(c game.Card) bool {
	return m.unk.higher(c, m.t.trump) == 0
}

// afterMe returns the seats that still play in this trick after the mover.
func (m *mover) afterMe() (out [3]game.Seat, n int) {
	for i := m.t.n + 1; i < 4; i++ {
		out[n] = (m.t.leader + game.Seat(i)) & 3
		n++
	}
	return out, n
}

// canBeat reports whether p, playing after the mover, might beat card w
// (the winning card after the mover's play) in a trick led with led.
func (m *mover) canBeat(p game.Seat, w game.Card, led game.Suit, behind int) bool {
	trump := m.t.trump
	if w.Suit == trump {
		return m.mayHold(p, m.unk.higher(w, trump)) != 0
	}
	if m.mayHold(p, m.unk.higher(w, trump)) != 0 {
		return true
	}
	// A player who is void in the led suit can trump in.
	outLed := m.unk.inSuit(led)
	void := m.mayHold(p, outLed) == 0 || outLed.count() < behind
	return void && m.mayTrump(p)
}

// safe reports whether card w, winning after the mover's play, can no
// longer be beaten by the players after the mover.
func (m *mover) safe(w game.Card, led game.Suit) bool {
	after, n := m.afterMe()
	for i := range n {
		if after[i].Team() == m.seat.Team() {
			continue
		}
		if m.canBeat(after[i], w, led, n) {
			return false
		}
	}
	return true
}

// choose returns the rule-based card for the mover.
func (m *mover) choose() game.Card {
	c, _ := m.decide()
	return c
}

// rule is the rule of the policy that chose a card. A hint for that card
// gives the rule's reason (see why.go).
type rule uint8

const (
	ruleOnly         rule = iota // the only legal card
	ruleAskedTrump               // partner led kleintje boer: play trump back
	ruleKleintjeBoer             // tell partner we hold the trump boer
	rulePullTrump                // pull trump with the highest trump out
	rulePullLow                  // pull trump with a low trump
	ruleDefendTrump              // defenders take trumps out with the highest trump
	ruleCash                     // cash a side boss (the 10 before its ace)
	ruleLead                     // the cheapest sensible lead (leadCost)
	ruleTrumpNotFake             // trump rather than a false kleintje boer
	ruleOnlyTrumps               // only trumps left
	ruleSmear                    // partner's sure trick: give points
	ruleThrow                    // partner's sure trick, nothing to give: throw the least needed card
	ruleSecure                   // partner's trick is not sure: take it over safely
	ruleThrowUnsure              // partner's trick is not sure: give no points
	ruleLastWin                  // last to play: take the trick
	ruleSafeWin                  // take the trick, nobody after can beat it
	ruleCheapRuff                // a cheap trick: the lowest trump that wins
	ruleForcedWin                // every legal card wins, or a trump must be played
	ruleDuck                     // the trick is lost: the card that costs least
)

// decide returns the rule-based card for the mover and the rule that chose it.
func (m *mover) decide() (game.Card, rule) {
	if m.legal.count() == 1 {
		return game.CardFromIndex(trailing(m.legal)), ruleOnly
	}
	if m.t.n == 0 {
		return m.lead()
	}
	return m.follow()
}

// lead picks the card to lead a trick.
func (m *mover) lead() (game.Card, rule) {
	t := m.t
	trump := t.trump
	trumps := m.hand.inSuit(trump)
	team := m.seat.Team()

	if m.ourTeamPlays() && trumps != 0 {
		// Partner asked for trump with a small card (kleintje boer).
		if t.boerSig[team] == m.partner() && m.unk.has(jackOf(trump)) {
			c, _ := trumps.bottom(trump, trump)
			return c, ruleAskedTrump
		}
		// Kleintje boer, when the table agreed on it: tell partner we hold
		// the boer. The maker does so only when it opens the hand with
		// little else in trump; otherwise it pulls trump itself.
		if t.sig.KleintjeBoer && trumps.has(jackOf(trump)) && !t.hasLed[m.seat] && !t.boerSig[team].Valid() && m.oppsMayTrump() &&
			(t.trumpBy != m.seat || (t.trickNo == 0 && m.thinTrumps())) {
			if c, ok := m.smallSignalCard(); ok {
				return c, ruleKleintjeBoer
			}
		}
		// Pull trumps while the opponents may still have them.
		if m.oppsMayTrump() {
			top, _ := trumps.top(trump, trump)
			if m.isBoss(top) {
				return top, rulePullTrump
			}
			if trumps.count() >= 3 || (t.trumpBy == m.seat && trumps.count() >= 2 && !trumps.has(nineOf(trump))) {
				c, _ := trumps.bottom(trump, trump)
				return c, rulePullLow
			}
		}
	}

	// Defenders with the top trump take the makers' trumps out.
	if !m.ourTeamPlays() && trumps != 0 && m.oppsMayTrump() {
		if top, _ := trumps.top(trump, trump); m.isBoss(top) {
			return top, ruleDefendTrump
		}
	}
	// Cash a side boss that will not be trumped. With the ace and the 10
	// the 10 goes first: it wins just as surely, it can still bring roem
	// (the ace only with the heer and vrouw), and the ace stays on top.
	var best game.Card
	bestPts := -1
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if s == trump {
			continue
		}
		top, ok := m.hand.top(s, trump)
		if !ok || !m.isBoss(top) || m.oppMayRuff(s) {
			continue
		}
		if ten := tenOf(s); top.Rank == game.Ace && m.hand.has(ten) {
			top = ten
		}
		if p := game.Points(top, trump); p > bestPts {
			best, bestPts = top, p
		}
	}
	if bestPts >= 0 {
		return best, ruleCash
	}

	// Otherwise the cheapest sensible lead (leadCost), possibly a ruff for
	// partner. Every side card is a candidate: a higher card beats the
	// lowest when that would promise a boer we lack (kleintje boer) or give
	// the opponents roem. Trump replaces a small card that is still the
	// cheapest and promises the boer.
	if c, ok := m.cheapestLead(true); ok {
		if m.fakeSignal(c) && trumps != 0 && m.oppsMayTrump() {
			c, _ = trumps.bottom(trump, trump)
			return c, ruleTrumpNotFake
		}
		return c, ruleLead
	}
	// Only trumps left.
	top, _ := trumps.top(trump, trump)
	if m.isBoss(top) {
		return top, ruleOnlyTrumps
	}
	c, _ := trumps.bottom(trump, trump)
	return c, ruleOnlyTrumps
}

// thinTrumps reports whether the maker holds the boer with little else in
// trump (no nel, at most one other trump): opening the hand, it then leads
// kleintje boer and lets partner play trump to it, rather than pulling
// trump with a bare boer. (Measured in self-play: about even at normaal;
// giving it on a later first lead costs points.)
func (m *mover) thinTrumps() bool {
	trumps := m.hand.inSuit(m.t.trump)
	return trumps.has(jackOf(m.t.trump)) && !trumps.has(nineOf(m.t.trump)) && trumps.count() <= 2
}

// fakeSignal reports whether leading c now would promise the trump boer
// (kleintje boer) that the mover does not hold.
func (m *mover) fakeSignal(c game.Card) bool {
	return m.t.signalsBoer(m.seat, c) && !m.hand.has(jackOf(m.t.trump))
}

// falseAce reports whether discarding c, a side ace, would say "ik heb de
// 10 ook" (met de aas seinen) while the mover lacks that 10 and an opponent
// may hold it: the partner would come back to the suit and lose the trick.
func (m *mover) falseAce(c game.Card) bool {
	ten, ok := m.t.aceSignal(c)
	return ok && !m.hand.has(ten) && m.oppsMayHold(bit(ten)) != 0
}

// trueAce reports whether discarding c, a side ace, says truthfully "ik
// heb de 10 ook" (met de aas seinen): the 10 then takes over as the highest
// card of the suit.
func (m *mover) trueAce(c game.Card) bool {
	ten, ok := m.t.aceSignal(c)
	return ok && m.hand.has(ten)
}

// falseLow reports whether discarding c, a 7, 8 or 9, would say "speel deze
// kleur, daar heb ik de hoogste van" (opseinen) while the mover lacks
// that card and an opponent may hold it.
func (m *mover) falseLow(c game.Card) bool {
	hi, ok := m.t.lowSignal(c)
	return ok && !m.hand.has(hi) && m.oppsMayHold(bit(hi)) != 0
}

// partnerHigh returns the card with which the partner said it holds the
// highest card of side suit s (met de aas seinen or opseinen), when the
// partner may still hold it and it is still the highest card out: a lead
// in s is then the partner's trick, unless an opponent trumps it.
func (m *mover) partnerHigh(s game.Suit) (game.Card, bool) {
	p := m.partner()
	for x := m.t.said[p] & m.poss[p] & suitSet(s); x != 0; x &= x - 1 {
		if c := game.CardFromIndex(trailing(x)); m.isBoss(c) {
			return c, true
		}
	}
	return game.Card{}, false
}

// smallSignalCard returns the lowest side 7, 8 or 9 to lead as kleintje boer.
func (m *mover) smallSignalCard() (game.Card, bool) {
	trump := m.t.trump
	for _, r := range [3]game.Rank{game.Seven, game.Eight, game.Nine} {
		for s := game.Suit(0); s < game.NumSuits; s++ {
			c := game.Card{Rank: r, Suit: s}
			if s != trump && m.hand.has(c) && !m.oppMayRuff(s) {
				return c, true
			}
		}
	}
	return game.Card{}, false
}

// oppMayRuff reports whether an opponent may trump a lead in side suit s.
func (m *mover) oppMayRuff(s game.Suit) bool {
	if !m.oppsMayTrump() {
		return false
	}
	out := m.unk.inSuit(s)
	for _, o := range m.opps() {
		if m.mayHold(o, out) == 0 && m.mayTrump(o) {
			return true
		}
	}
	return false
}

// cheapestLead returns the side card with the lowest leadCost, with its
// roem term (leadRoem) or without; not ok when only trumps are left.
func (m *mover) cheapestLead(roem bool) (best game.Card, ok bool) {
	bestCost := 0
	for s := m.hand &^ suitSet(m.t.trump); s != 0; s &= s - 1 {
		c := game.CardFromIndex(trailing(s))
		cost := m.leadCost(c)
		if roem {
			cost -= 3 * m.leadRoem(c)
		}
		if !ok || cost < bestCost {
			best, bestCost, ok = c, cost, true
		}
	}
	return best, ok
}

// Roem at the lead: what one open run of three through the led card is
// worth, in points, to the team that takes the trick (see leadRoem).
// Measured in duplicate self-play against the lead without roem: normaal
// gains about 1.9 points per hand at 2, 3.3 at 8, and no more above 8.
const (
	leadRoemOurs   = 8
	leadRoemTheirs = 8
)

// leadRoem estimates the roem that leading c brings into its trick for the
// mover's team, in points; negative when it goes to the opponents. Each
// open run through c (openRuns) may fall in the trick, and goes to the
// team that probably takes it: the mover's when c is the highest card of
// its suit or the partner signalled the highest card, and nobody is known
// to ruff the suit; else the opponents'.
func (m *mover) leadRoem(c game.Card) int {
	runs, _ := m.openRuns(c)
	if runs == 0 {
		return 0
	}
	s := c.Suit
	if _, ok := m.partnerHigh(s); (ok || m.isBoss(c)) && !m.oppMayRuff(s) {
		return runs * leadRoemOurs
	}
	return -runs * leadRoemTheirs
}

// openRuns counts the runs of three in c's suit through c whose two other
// cards are still out with two different players, and returns those cards.
func (m *mover) openRuns(c game.Card) (n int, cards cardSet) {
	for lo := max(int(c.Rank)-2, 0); lo <= int(c.Rank) && lo+2 < game.NumRanks; lo++ {
		pair := cardSet(0b111) << (uint(c.Suit)*8 + uint(lo)) &^ bit(c)
		if pair&^m.unk == 0 && m.apart(pair) {
			n++
			cards |= pair
		}
	}
	return n, cards
}

// apart reports whether the two cards of pair may be with two different
// players (other than the mover, whose own cards are known).
func (m *mover) apart(pair cardSet) bool {
	x := pair & -pair
	y := pair &^ x
	for p := range m.poss {
		for q := range m.poss {
			if p != q && m.poss[p]&x != 0 && m.poss[q]&y != 0 {
				return true
			}
		}
	}
	return false
}

// leadCost scores leading side card c (lower is better), without roem
// (see cheapestLead).
func (m *mover) leadCost(c game.Card) int {
	trump := m.t.trump
	s := c.Suit
	cost := 3*game.Points(c, trump) + game.Order(c, trump)
	if m.oppMayRuff(s) {
		cost += 30
	}
	p := m.partner()
	if m.voidIn(p, s) && m.mayTrump(p) && !m.oppMayRuff(s) {
		cost -= 15 // partner trumps it
	}
	n := m.hand.countSuit(s)
	ten := tenOf(s)
	if m.hand.has(ten) && c != ten && n == 2 && m.unk.has(aceOf(s)) {
		cost += 10 // keep the 10 guarded
	}
	if n == 1 && m.hand.inSuit(trump) != 0 {
		cost -= 4 // a void to trump later
	}
	if m.unk.has(aceOf(s)) && m.unk.has(tenOf(s)) && !m.ourTeamPlays() {
		cost -= 2 // defenders: lead where the opponents' points are
	}
	if m.fakeSignal(c) {
		cost += 15 // partner would read kleintje boer and return trump
	}
	if c.Rank != game.Ace && m.hand.has(aceOf(s)) {
		cost += 30 // do not lead under the own ace
	}
	if _, ok := m.partnerHigh(s); ok && !m.oppMayRuff(s) {
		cost -= 20 // partner said it holds the highest card here
	}
	return cost
}

// follow picks a card when the trick has already been led.
func (m *mover) follow() (game.Card, rule) {
	t := m.t
	trump, led := t.trump, t.led()
	last := t.n == 3
	if t.win == m.partner() {
		if last || m.safe(t.best, led) {
			if c, ok := m.smear(); ok {
				return c, ruleSmear
			}
			return m.discard(false), ruleThrow
		}
		// Secure the trick with a safe winner when that is worth it. A boss
		// trump wins its trick anyway; on a trump lead it also takes trumps.
		if c, ok := m.bestWinner(true, true); ok {
			worth := t.points+game.Points(c, trump)+m.roemGain(c) >= 10 || m.pitHunt()
			cheap := c.Suit != trump || game.TrumpOrder(c.Rank) <= 3 || t.points >= 20 ||
				(led == trump && m.isBoss(c))
			if worth && cheap {
				return c, ruleSecure
			}
		}
		return m.discard(false), ruleThrowUnsure
	}
	if last {
		if c, ok := m.bestWinner(false, true); ok {
			return c, ruleLastWin
		}
		return m.discard(true), ruleDuck
	}
	if c, ok := m.bestWinner(true, false); ok {
		// A trump is "safe" only when nobody behind can overtrump it, which
		// often leaves just the boer or nel. On a cheap side-suit trick the
		// cheapest trump that wins now is worth the risk: keep the boer and
		// nel for the tricks that matter.
		if c.Suit == trump && led != trump && t.points < 15 {
			if low, ok := m.bestWinner(false, false); ok {
				return low, ruleCheapRuff
			}
		}
		return c, ruleSafeWin
	}
	// No safe winner: play an unsafe one only when nothing else is allowed
	// or when it costs little (a trump that must be played anyway).
	if c, ok := m.bestWinner(false, false); ok {
		if m.allLegalBeat() || (c.Suit == trump && led != trump) {
			return c, ruleForcedWin
		}
	}
	return m.discard(true), ruleDuck
}

// pitHunt reports whether the mover goes all out for pit.
func (m *mover) pitHunt() bool {
	team := m.seat.Team()
	return m.aggr >= 0.6 && m.t.trickNo >= 4 && m.t.won[team] == m.t.trickNo
}

// roemGain returns the roem that c adds to the cards already in the trick.
func (m *mover) roemGain(c game.Card) int {
	return game.RoemAdded(m.t.trick[:m.t.n], c, m.t.trump)
}

// bestWinner returns the legal card that wins the trick now (with needSafe:
// and cannot be beaten by the players after the mover). It prefers the
// weakest such card, or with bank the one that brings in the most points
// without spending a boss that could win a trick of its own.
func (m *mover) bestWinner(needSafe, bank bool) (game.Card, bool) {
	t := m.t
	trump, led := t.trump, t.led()
	var best game.Card
	bestCost, found := 0, false
	for s := m.legal; s != 0; s &= s - 1 {
		c := game.CardFromIndex(trailing(s))
		if !game.Beats(c, t.best, led, trump) {
			continue
		}
		if needSafe && !m.safe(c, led) {
			continue
		}
		cost := 3*game.Order(c, trump) - 2*m.roemGain(c)
		if c.Suit == trump {
			cost += 30 + 3*game.Order(c, trump)
		} else if bank {
			cost -= 2 * game.Points(c, trump)
			if m.hand.inSuit(c.Suit).lower(c, trump) != 0 && m.isBoss(c) && m.unk.inSuit(c.Suit) != 0 {
				cost += 24 // keep the boss, play the lower winner
			}
		}
		if !found || cost < bestCost {
			best, bestCost, found = c, cost, true
		}
	}
	return best, found
}

// smear returns the card that gives the most points (and roem) to a trick
// the partner wins (spekken); not ok when that card brings nothing.
func (m *mover) smear() (game.Card, bool) {
	trump := m.t.trump
	var best game.Card
	bestScore, found := 0, false
	for s := m.legal; s != 0; s &= s - 1 {
		c := game.CardFromIndex(trailing(s))
		score := 2*game.Points(c, trump) + 2*m.roemGain(c)
		switch {
		case c.Suit == trump:
			score -= m.keepValue(c)
		case m.trueAce(c):
			// Met de aas seinen: the 10 stays to win the trick of the suit.
		case c.Suit != m.t.led() && m.isBoss(c) && m.unk.inSuit(c.Suit) != 0 && !m.oppMayRuff(c.Suit):
			// A side boss can still win a trick of its own: keep it.
			score -= 2*game.Points(c, trump) + 6
		}
		if m.falseAce(c) {
			score -= 15 // partner would read met de aas seinen and come back
		}
		score -= m.guardPenalty(c)
		if !found || score > bestScore {
			best, bestScore, found = c, score, true
		}
	}
	return best, game.Points(best, trump)+m.roemGain(best) > 0
}

// guardPenalty discourages giving up the last guard of a 10 whose ace is out.
func (m *mover) guardPenalty(c game.Card) int {
	ten := tenOf(c.Suit)
	if c.Suit != m.t.trump && c != ten && m.hand.has(ten) && m.hand.countSuit(c.Suit) == 2 && m.unk.has(aceOf(c.Suit)) {
		return 8
	}
	return 0
}

// discard returns the legal card that is least worth keeping; toOpp means
// the opponents are likely to take the trick, so roem is a cost.
func (m *mover) discard(toOpp bool) game.Card {
	var best game.Card
	bestCost, found := 0, false
	for s := m.legal; s != 0; s &= s - 1 {
		c := game.CardFromIndex(trailing(s))
		cost := m.keepValue(c)
		if toOpp {
			cost += 3 * m.roemGain(c)
		}
		if !found || cost < bestCost {
			best, bestCost, found = c, cost, true
		}
	}
	return best
}

// keepValue is how much the mover loses by giving up c to the opponents.
func (m *mover) keepValue(c game.Card) int {
	trump := m.t.trump
	v := 3*game.Points(c, trump) + game.Order(c, trump)
	if c.Suit == trump {
		v += 40 + 3*game.Order(c, trump)
		return v
	}
	n := m.hand.countSuit(c.Suit)
	if m.isBoss(c) && (m.t.n == 0 || c.Suit != m.t.led()) {
		v += 10
	}
	v += m.guardPenalty(c)
	if n == 1 && m.hand.inSuit(trump) != 0 && (m.t.n == 0 || c.Suit != m.t.led()) {
		v -= 3 // creates a void
	}
	if hi, ok := m.t.lowSignal(c); ok && m.hand.has(hi) {
		v -= 2 // opseinen: asks partner to play the suit
	} else if m.falseLow(c) {
		v += 25 // partner would read opseinen and play the suit
	}
	return v
}

// bestTrumpNormal returns the suit with the best trumpValue (never the
// turned suit when forced).
func bestTrumpNormal(h cardSet, forced bool, turned game.Suit) game.Suit {
	best, bestVal := game.Suit(0), -1<<30
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if forced && s == turned {
			continue
		}
		if v := trumpValue(h, s); v > bestVal {
			best, bestVal = s, v
		}
	}
	return best
}

// lengthValue is the worth of holding n trumps (fitted to simulations).
var lengthValue = [9]int{0, 2, 12, 31, 59, 94, 139, 192, 253}

// trumpValue estimates how good suit s is as trump for the 8-card hand h:
// roughly the points it is worth, with weights fitted to simulated hands.
// Side aces count more than a trump ace: they win tricks of their own.
func trumpValue(h cardSet, s game.Suit) int {
	t := h.inSuit(s)
	n := t.count()
	v := lengthValue[n]
	jack, nine := t.has(jackOf(s)), t.has(nineOf(s))
	if jack {
		v += 39
	}
	if nine {
		v += 20
		if jack {
			v += 5
		} else if n < 3 {
			v -= 2
		}
	}
	if t.has(aceOf(s)) {
		v += 7
	}
	if t.has(tenOf(s)) {
		v += 2
	}
	for o := game.Suit(0); o < game.NumSuits; o++ {
		if o == s {
			continue
		}
		side := h.inSuit(o)
		k := side.count()
		switch {
		case side.has(aceOf(o)):
			v += 19
			if side.has(tenOf(o)) {
				v += 9
			}
		case side.has(tenOf(o)) && k >= 2:
			v += 8
		}
		switch k {
		case 0:
			v += 10
		case 1:
			v += 2
		}
	}
	return v
}

// bidThreshold is the trumpValue at which a persona plays in gedraaid.
func bidThreshold(aggr float64) int {
	return 90 - int(30*(aggr-0.5))
}

func trailing(s cardSet) int { return bits.TrailingZeros32(uint32(s)) }

// oppsMayHold returns the cards of set that an opponent may hold.
func (m *mover) oppsMayHold(set cardSet) cardSet {
	o := m.opps()
	return m.mayHold(o[0], set) | m.mayHold(o[1], set)
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
