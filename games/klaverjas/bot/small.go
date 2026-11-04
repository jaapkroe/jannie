package bot

import (
	"jannie/games/klaverjas/game"
)

// Bots at a table of two or three players (design §2, §4.2). The levels
// mean what they mean with four: makkelijk plays loosely and makes
// mistakes, normaal plays by rules of thumb (pubTable.choose), sterk plays
// sampled deals out with those rules (smallsearch.go). The signals of §8
// are a matter between partners at a table of four and play no part.

// pubTable is what everyone at a small table can know while tricks are
// played: the cards played, who plays alone, and from the play which
// cards a seat cannot hold. With two players the face-up cards on the
// piles are public too; callers pass them in. It is updated card by card,
// from a view and inside simulations alike. It holds no slices: copying it
// is a full copy.
type pubTable struct {
	n       int
	trump   game.Suit
	rules   game.Rules
	soloist game.Seat // three players: who plays alone; NoSeat with two
	maker   game.Seat // who chose trump
	size    int       // tricks in the hand

	played cardSet
	excl   [4]cardSet // cards a seat certainly does not hold (three players)

	leader  game.Seat
	trick   [4]game.Card
	tn      int
	win     game.Seat // winning the trick so far
	best    game.Card // the card winning it
	high    int8      // trump order of the highest trump in the trick, -1 if none
	points  int       // card points in the trick so far
	trickNo int
}

// newPubTable starts the public state of a small table's hand once trump
// is known.
func newPubTable(n int, voorhand game.Seat, trump game.Suit, trumpBy, soloist game.Seat, rules game.Rules) pubTable {
	size := 10
	if n == 2 {
		size = 16
	}
	return pubTable{
		n: n, trump: trump, rules: rules, soloist: soloist, maker: trumpBy,
		size: size, leader: voorhand, win: game.NoSeat, high: -1,
	}
}

// pubFromView replays the history in v (phase play or done).
func pubFromView(v *game.View) pubTable {
	solo := game.NoSeat
	if v.Players == 3 {
		solo = v.Bidder
	}
	t := newPubTable(v.Players, v.Voorhand, v.Trump, v.TrumpBy, solo, v.Rules)
	for _, tr := range v.Tricks {
		for _, p := range tr.Cards {
			t.apply(p.Seat, p.Card)
		}
	}
	if len(v.Current.Cards) < v.Players {
		for _, p := range v.Current.Cards {
			t.apply(p.Seat, p.Card)
		}
	}
	return t
}

func (t *pubTable) next(s game.Seat) game.Seat {
	if s++; int(s) >= t.n {
		return 0
	}
	return s
}

// side is the side seat plays on (game.Deal.Side).
func (t *pubTable) side(s game.Seat) int {
	if t.n == 3 {
		return b2i(s != t.soloist)
	}
	return int(s & 1)
}

// partner is the seat that plays with s in this hand, NoSeat if none: with
// three players the soloist's two opponents play together.
func (t *pubTable) partner(s game.Seat) game.Seat {
	if t.n != 3 || s == t.soloist {
		return game.NoSeat
	}
	return 3 - s - t.soloist
}

// playing reports whether s is on the side that made trump.
func (t *pubTable) playing(s game.Seat) bool { return t.side(s) == t.side(t.maker) }

// apply records that seat played c.
func (t *pubTable) apply(seat game.Seat, c game.Card) {
	if t.tn == 0 {
		t.leader, t.win, t.best, t.high, t.points = seat, seat, c, -1, 0
	} else {
		t.infer(seat, c)
		if game.Beats(c, t.best, t.trick[0].Suit, t.trump) {
			t.win, t.best = seat, c
		}
	}
	if c.Suit == t.trump {
		t.high = max(t.high, int8(game.TrumpOrder(c.Rank)))
	}
	t.trick[t.tn] = c
	t.tn++
	t.points += game.Points(c, t.trump)
	t.played |= bit(c)
	if t.tn == t.n {
		t.tn = 0
		t.trickNo++
		t.leader = t.win
	}
}

// infer records what the rules tell about seat's cards when it plays c
// into the current trick (design §2, as table.infer for four players).
// With two players a player's face-down cards are unknown to itself, so
// nothing follows.
func (t *pubTable) infer(seat game.Seat, c game.Card) {
	if t.n != 3 {
		return
	}
	trump, led := t.trump, t.trick[0].Suit
	ex := &t.excl[seat]
	above := t.trumpsAbove(t.high)
	lower := c.Suit == trump && int8(game.TrumpOrder(c.Rank)) < t.high
	switch {
	case led == trump && c.Suit != trump:
		*ex |= suitSet(trump)
	case led == trump && lower:
		*ex |= above
	case led == trump || c.Suit == led:
	case t.rules == game.Amsterdams && t.win == t.partner(seat):
		*ex |= suitSet(led)
		if lower {
			*ex |= ^suitSet(trump) | above
		}
	case c.Suit != trump && t.rules == game.Rotterdams:
		*ex |= suitSet(led) | suitSet(trump)
	case c.Suit != trump:
		*ex |= suitSet(led) | above
	case lower && t.rules == game.Rotterdams:
		*ex |= suitSet(led) | above
	case lower:
		*ex |= suitSet(led) | ^suitSet(trump) | above
	default:
		*ex |= suitSet(led)
	}
}

// trumpsAbove returns the trumps stronger than trump order h (all trumps
// for h < 0).
func (t *pubTable) trumpsAbove(h int8) cardSet {
	if h < 0 {
		return suitSet(t.trump)
	}
	return cardSet(above[1][trumpHighToLow[7-h]]) << (uint(t.trump) * 8)
}

// unseen returns the cards seat has not seen: not played, not in its hand
// and not among the opponent's face-up cards (two players).
func (t *pubTable) unseen(hand, opp cardSet) cardSet { return allCards &^ t.played &^ hand &^ opp }

// boss reports whether c is the strongest card of its suit that is still
// out or in hand.
func (t *pubTable) boss(c game.Card, hand, opp cardSet) bool {
	return t.unseen(hand, opp).higher(c, t.trump)|opp.higher(c, t.trump) == 0
}

// choose is the rule-based card (normaal, and every seat in simulations)
// for seat holding hand with legal cards legal; opp are the opponent's
// face-up cards with two players (0 with three).
func (t *pubTable) choose(seat game.Seat, hand, legal, opp cardSet) game.Card {
	if legal.count() == 1 {
		return game.CardFromIndex(trailing(legal))
	}
	if t.tn == 0 {
		return t.lead(seat, hand, legal, opp)
	}
	return t.follow(seat, hand, legal, opp)
}

// lastTrick reports whether the trick being played is the last one.
func (t *pubTable) lastTrick() bool { return t.trickNo == t.size-1 }

// lead picks a card to lead. The side that plays draws trumps while it
// holds the strongest one; then everyone cashes cards that win for sure
// (with two players the opponent's answers are known exactly); else a
// cheap card goes, preferably from a short side suit.
func (t *pubTable) lead(seat game.Seat, hand, legal, opp cardSet) game.Card {
	trump := t.trump
	out := (t.unseen(hand, opp) | opp).inSuit(trump)
	if t.playing(seat) && out != 0 {
		if c, ok := legal.top(trump, trump); ok && t.boss(c, hand, opp) {
			return c
		}
	}
	var sure game.Card
	gain := -1
	for x := legal; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		if c.Suit == trump && !t.playing(seat) {
			continue
		}
		g, ok := t.sureWin(seat, c, hand, opp)
		if ok && g > gain {
			sure, gain = c, g
		}
	}
	if gain >= 0 {
		return sure
	}
	return t.cheapLead(hand, legal)
}

// sureWin reports whether seat, leading c, wins the trick whatever the
// others hold, and how many points it then brings in at least. With two
// players the opponent's answer comes from its face-up cards; with three,
// c must be the strongest of its suit, and a side card must not risk an
// opponent's trump (ruffRisk).
func (t *pubTable) sureWin(seat game.Seat, c game.Card, hand, opp cardSet) (int, bool) {
	trump := t.trump
	if t.n == 2 {
		replies := cardSet(game.LegalReply(uint32(opp), c, 0, 1, trump, t.rules))
		beat := replies.higher(c, trump)
		if c.Suit != trump {
			beat |= replies.inSuit(trump)
		}
		if beat != 0 {
			return 0, false
		}
		least := 0
		for x, first := replies, true; x != 0; x, first = x&(x-1), false {
			if p := game.Points(game.CardFromIndex(trailing(x)), trump); first || p < least {
				least = p
			}
		}
		return game.Points(c, trump) + least, true
	}
	if !t.boss(c, hand, 0) {
		return 0, false
	}
	if c.Suit != trump {
		for s := t.next(seat); s != seat; s = t.next(s) {
			if s != t.partner(seat) && t.ruffRisk(s, c.Suit, hand) {
				return 0, false
			}
		}
	}
	return game.Points(c, trump), true
}

// ruffRisk reports whether seat s may trump a lead in side suit su: it may
// still hold a trump, and it is known to lack the suit or few cards of it
// are left to go round.
func (t *pubTable) ruffRisk(s game.Seat, su game.Suit, hand cardSet) bool {
	left := t.unseen(hand, 0)
	if left.inSuit(t.trump)&^t.excl[s] == 0 {
		return false
	}
	return left.inSuit(su)&^t.excl[s] == 0 || left.countSuit(su) < t.n-1
}

// cheapLead returns the cheapest legal card, from a side suit when there
// is one, preferring a suit where the hand is short (to ruff later).
func (t *pubTable) cheapLead(hand, legal cardSet) game.Card {
	best, bestCost := game.Card{}, 1<<30
	for x := legal; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		k := cost(c, t.trump) + 3*hand.countSuit(c.Suit)
		if c.Rank == game.Ten && c.Suit != t.trump && !hand.has(aceOf(c.Suit)) {
			k += 15 // a bare 10 led is an easy catch
		}
		if k < bestCost {
			best, bestCost = c, k
		}
	}
	return best
}

// follow picks a card for a trick already led.
func (t *pubTable) follow(seat game.Seat, hand, legal, opp cardSet) game.Card {
	trump := t.trump
	led := t.trick[0].Suit
	last := t.tn == t.n-1
	bonus := 0
	if t.lastTrick() {
		bonus = game.LastTrickBonus
	}
	if p := t.partner(seat); p != game.NoSeat && t.win == p {
		if last || t.holds(t.best, led, hand) {
			return t.smear(legal)
		}
		return t.throw(legal, hand)
	}
	var win cardSet
	for x := legal; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		if game.Beats(c, t.best, led, trump) {
			win |= bit(c)
		}
	}
	if win == 0 {
		return t.throw(legal, hand)
	}
	if last {
		c := cheapestOf(win, trump)
		if c.Suit != trump || t.points+bonus >= 10 || t.points+game.Points(c, trump) >= 14 {
			return c
		}
		return t.throw(legal, hand)
	}
	// Middle seat with three players: the next one may still beat us,
	// unless our card holds.
	var hold cardSet
	for x := win; x != 0; x &= x - 1 {
		if c := game.CardFromIndex(trailing(x)); t.holds(c, led, hand) {
			hold |= bit(c)
		}
	}
	if hold != 0 {
		return cheapestOf(hold, trump)
	}
	if p := t.partner(seat); p != game.NoSeat && t.next(seat) == p {
		return t.throw(legal, hand) // the partner comes after us
	}
	if t.points+bonus >= 10 {
		return highestOf(win, trump)
	}
	return t.throw(legal, hand)
}

// holds reports whether card c, winning the trick, stays winning against
// the players after the one to play now: nothing unseen beats it in its
// suit, and a side card does not risk a trump (ruffRisk).
func (t *pubTable) holds(c game.Card, led game.Suit, hand cardSet) bool {
	trump := t.trump
	left := t.unseen(hand, 0)
	if left.higher(c, trump) != 0 {
		return false
	}
	if c.Suit == trump {
		return true
	}
	for k := t.tn + 1; k < t.n; k++ {
		if s := (t.leader + game.Seat(k)) % game.Seat(t.n); t.ruffRisk(s, led, hand) {
			return false
		}
	}
	return true
}

// smear gives the partner's trick the most points it can (spekken):
// a side 10 or ace, else the cheapest card.
func (t *pubTable) smear(legal cardSet) game.Card {
	var best game.Card
	pts := 0
	for x := legal; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		if p := game.Points(c, t.trump); c.Suit != t.trump && p > pts {
			best, pts = c, p
		}
	}
	if pts > 0 {
		return best
	}
	return cheapestOf(legal, t.trump)
}

// throw gives away the card least worth keeping, sparing the guard of a
// side 10 or the last card of a suit that may still be useful.
func (t *pubTable) throw(legal, hand cardSet) game.Card {
	best, bestCost := game.Card{}, 1<<30
	for x := legal; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		k := cost(c, t.trump)
		if c.Suit != t.trump && hand.has(tenOf(c.Suit)) && c.Rank != game.Ten && hand.countSuit(c.Suit) == 2 {
			k += 12 // the 10's last guard
		}
		if k < bestCost {
			best, bestCost = c, k
		}
	}
	return best
}

// cheapestOf returns the card of s least worth keeping (see cost).
func cheapestOf(s cardSet, trump game.Suit) game.Card {
	best, bestCost := game.Card{}, 1<<30
	for x := s; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		if k := cost(c, trump); k < bestCost {
			best, bestCost = c, k
		}
	}
	return best
}

// highestOf returns the strongest card of s (see cost).
func highestOf(s cardSet, trump game.Suit) game.Card {
	best, bestCost := game.Card{}, -1
	for x := s; x != 0; x &= x - 1 {
		c := game.CardFromIndex(trailing(x))
		if k := cost(c, trump); k > bestCost {
			best, bestCost = c, k
		}
	}
	return best
}

// ---- before play: trump, bids, the auction and the discards ----

// soloValue estimates the points (roem included) a soloist with three
// players makes with the ten cards h and trump s: roughly what each card
// brings in, fitted loosely to simulated hands. Long trumps and side aces
// win tricks of their own; a 10 is worth its points only with the ace.
func soloValue(h cardSet, s game.Suit) int {
	t := h.inSuit(s)
	n := t.count()
	v := [11]int{0, 4, 10, 20, 34, 52, 72, 92, 110, 124, 136}[n]
	if t.has(jackOf(s)) {
		v += 28
	}
	if t.has(nineOf(s)) {
		v += 16
		if !t.has(jackOf(s)) && n < 3 {
			v -= 8
		}
	}
	if t.has(aceOf(s)) {
		v += 8
	}
	for o := game.Suit(0); o < game.NumSuits; o++ {
		if o == s {
			continue
		}
		side := h.inSuit(o)
		switch {
		case side.has(aceOf(o)) && side.has(tenOf(o)):
			v += 34
		case side.has(aceOf(o)):
			v += 19
		case side.has(tenOf(o)) && side.count() >= 3:
			v += 4
		}
		if side == 0 && n >= 3 {
			v += 6 // a void to trump in
		}
	}
	return v
}

// soloPlan returns the trump and the two cards to lay away for a soloist
// holding the twelve cards h (its hand and the talon). The discards count
// for the soloist, so a 10 without its ace is laid away safely; otherwise
// a short side suit goes, to trump in later.
func soloPlan(h cardSet) (game.Suit, [2]game.Card) {
	var bestS game.Suit
	var bestD [2]game.Card
	bestV := -1 << 30
	for s := game.Suit(0); s < game.NumSuits; s++ {
		d := discardsFor(h, s)
		if v := soloValue(h&^bit(d[0])&^bit(d[1]), s) + game.Points(d[0], s) + game.Points(d[1], s); v > bestV {
			bestS, bestD, bestV = s, d, v
		}
	}
	return bestS, bestD
}

// discardsFor picks the two cards of h to lay away with trump s: those
// least worth keeping (keepSolo).
func discardsFor(h cardSet, s game.Suit) [2]game.Card {
	var out [2]game.Card
	rest := h
	for k := range out {
		best, bestV := game.Card{}, 1<<30
		for x := rest; x != 0; x &= x - 1 {
			c := game.CardFromIndex(trailing(x))
			if v := keepSolo(rest, c, s); v < bestV {
				best, bestV = c, v
			}
		}
		out[k] = best
		rest &^= bit(best)
	}
	return out
}

// keepSolo is how much the soloist wants to keep card c of hand h with
// trump s: trumps and aces always; a 10 only with its ace (laid away, it
// banks its 10 points); the last card of a short side suit least, which
// leaves a void.
func keepSolo(h cardSet, c game.Card, s game.Suit) int {
	if c.Suit == s {
		return 200 + game.TrumpOrder(c.Rank)
	}
	side := h.inSuit(c.Suit)
	switch c.Rank {
	case game.Ace:
		return 120
	case game.Ten:
		if side.has(aceOf(c.Suit)) {
			return 100
		}
		return -10
	}
	v := 2*game.PlainOrder(c.Rank) + 6*side.count()
	if side.has(aceOf(c.Suit)) || side.has(tenOf(c.Suit)) {
		v += 15 // a guard
	}
	return v
}

// twoValue estimates suit s as trump with two players, from the cards
// face up: ours count for us, the opponent's against us. The face-down
// cards are unknown to both.
func twoValue(mine, theirs cardSet, s game.Suit) int {
	worth := func(h cardSet) int {
		t := h.inSuit(s)
		v := 6 * t.count()
		if t.has(jackOf(s)) {
			v += 26
		}
		if t.has(nineOf(s)) {
			v += 16
		}
		if t.has(aceOf(s)) {
			v += 6
		}
		for o := game.Suit(0); o < game.NumSuits; o++ {
			if o != s && h.has(aceOf(o)) {
				v += 8
			}
		}
		return v
	}
	return worth(mine) - worth(theirs)
}

// bestTwo is the best allowed trump by twoValue.
func bestTwo(mine, theirs cardSet, forced bool, turned game.Suit) game.Suit {
	best, bestV := game.Suit(0), -1<<30
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if forced && s == turned {
			continue
		}
		if v := twoValue(mine, theirs, s); v > bestV {
			best, bestV = s, v
		}
	}
	return best
}

// openOf returns the face-up cards on seat's piles in v.
func openOf(v *game.View, seat game.Seat) cardSet {
	var s cardSet
	for _, p := range v.Piles[seat&1] {
		if p.N > 0 && p.Up {
			s |= bit(p.Card)
		}
	}
	return s
}
