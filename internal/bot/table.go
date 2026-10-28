package bot

import "klaverjas/internal/game"

// table is the public state of a hand in play: what everyone at the table
// can know from the cards played so far. It is updated card by card, both
// when reading a game.View and inside simulations, so bots reason the same
// way in both. It holds no slices: copying it is a full copy.
type table struct {
	trump   game.Suit
	rules   game.Rules
	sig     game.Signals // the table's agreements on signals
	playing int          // playing team
	trumpBy game.Seat    // who made trump

	played   cardSet    // every card played, including the current trick
	playedBy [4]cardSet // cards played per seat
	excl     [4]cardSet // cards a seat certainly does not hold (inferred from play)

	// Current trick.
	leader game.Seat
	trick  [4]game.Card
	n      int
	win    game.Seat // seat winning the trick so far
	best   game.Card // card winning the trick so far
	high   int8      // trump order of the highest trump in the trick, -1 if none
	points int       // card points in the trick so far

	trickNo int    // completed tricks
	won     [2]int // tricks won per team
	hasLed  [4]bool
	suitLed [game.NumSuits]bool // a trick has been led in the suit
	// boerSig per team: the seat that signalled holding the trump boer by
	// leading a small side card or a side boer (kleintje boer, boer over
	// boer; see signalsBoer), NoSeat if none.
	boerSig [2]game.Seat
	// said per seat: the side cards the seat said it holds (aceSignal,
	// lowSignal), and sigBy the cards with which it said so. A card in
	// said may have fallen since: readers mask out what was played.
	said, sigBy [4]cardSet
}

// newTable starts the public state of a hand once trump is known.
func newTable(voorhand game.Seat, trump game.Suit, trumpBy game.Seat, rules game.Rules, sig game.Signals) table {
	return table{
		trump:   trump,
		rules:   rules,
		sig:     sig,
		playing: trumpBy.Team(),
		trumpBy: trumpBy,
		leader:  voorhand,
		win:     game.NoSeat,
		high:    -1,
		boerSig: [2]game.Seat{game.NoSeat, game.NoSeat},
	}
}

// tableFromView replays the history in v. v must be in phase play or done.
func tableFromView(v *game.View) table {
	t := newTable(v.Voorhand, v.Trump, v.TrumpBy, v.Rules, game.SignalsOf(v))
	for _, tr := range v.Tricks {
		for _, p := range tr.Cards {
			t.apply(p.Seat, p.Card)
		}
	}
	if len(v.Current.Cards) < 4 {
		for _, p := range v.Current.Cards {
			t.apply(p.Seat, p.Card)
		}
	}
	return t
}

// next returns the seat to play the next card.
func (t *table) next() game.Seat { return (t.leader + game.Seat(t.n)) & 3 }

// led returns the suit led in the current trick (valid when n > 0).
func (t *table) led() game.Suit { return t.trick[0].Suit }

// trumpsAbove returns the trumps stronger than trump order h (all trumps for h < 0).
func (t *table) trumpsAbove(h int8) cardSet {
	if h < 0 {
		return suitSet(t.trump)
	}
	return cardSet(above[1][trumpHighToLow[7-h]]) << (uint(t.trump) * 8)
}

// signalsBoer reports whether seat, leading c to a new trick, says "ik heb
// de troefboer" (design §8): a player of the playing team (the maker or its
// partner) on its first lead, while the boer is still out, with a 7, 8 or 9
// of a side suit (kleintje boer) or with a side boer (boer over boer), as
// far as the table agreed on them. In gedraaid the maker's first lead need
// not be the first trick. Bots avoid leading such a card without the boer
// (see mover.fakeSignal), so they can read it as a promise.
func (t *table) signalsBoer(seat game.Seat, c game.Card) bool {
	if t.n != 0 || t.hasLed[seat] || seat.Team() != t.playing || c.Suit == t.trump || t.played.has(jackOf(t.trump)) {
		return false
	}
	return t.sig.KleintjeBoer && c.Rank <= game.Nine || t.sig.BoerOverBoer && c.Rank == game.Jack
}

// Signals tell the partner which suit to lead, so they count only while
// the partner may still choose a lead afterwards: after a discard in the
// seventh trick the partner leads at most the last trick, with one card
// left.
const signalTricks = 6 // a discard signals in the first six tricks

// aceSignal reports whether discarding c says "ik heb de 10 ook" (met de
// aas seinen, design §8), when the table agreed on it: c is the ace of a
// side suit that nobody has led yet, given to the partner's trick while
// its 10 is still out, in time for the partner to come back to the suit.
// It returns that 10, the highest card of the suit once the ace is gone.
func (t *table) aceSignal(c game.Card) (game.Card, bool) {
	ten := tenOf(c.Suit)
	return ten, t.sig.Aas && t.partnersTrick() && c.Rank == game.Ace && c.Suit != t.trump && !t.suitLed[c.Suit] &&
		!t.played.has(ten) && t.trickNo < signalTricks
}

// partnersTrick reports whether the partner of the seat to play holds the
// current trick: only then does a discard signal (op- of afseinen);
// into a trick the opponents hold it is just a card thrown away.
func (t *table) partnersTrick() bool {
	return t.n > 0 && t.win == t.next().Partner()
}

// lowSignal reports whether playing c into the current trick says "speel
// deze kleur, daar heb ik de hoogste van" (opseinen, design §8), when the
// table agreed on op- of afseinen: c is a 7, 8 or 9 of a side suit that was
// not led, so a discard, on the partner's trick, and a card of that suit is
// still out besides c. It returns the highest such card.
func (t *table) lowSignal(c game.Card) (game.Card, bool) {
	if !t.sig.HoogLaag || !t.partnersTrick() || c.Suit == t.trump || c.Suit == t.led() || c.Rank > game.Nine || t.trickNo >= signalTricks {
		return game.Card{}, false
	}
	return (suitSet(c.Suit) &^ t.played &^ bit(c)).top(c.Suit, t.trump)
}

// apply records that seat played c.
func (t *table) apply(seat game.Seat, c game.Card) {
	trump := t.trump
	if t.n == 0 {
		// Only one player can hold the boer: the team's first signal counts.
		if t.signalsBoer(seat, c) && !t.boerSig[seat.Team()].Valid() {
			t.boerSig[seat.Team()] = seat
		}
		t.leader, t.win, t.best, t.high, t.points = seat, seat, c, -1, 0
		t.hasLed[seat] = true
		t.suitLed[c.Suit] = true
	} else {
		if hi, ok := t.lowSignal(c); ok {
			t.said[seat] |= bit(hi)
			t.sigBy[seat] |= bit(c)
		}
		if ten, ok := t.aceSignal(c); ok {
			t.said[seat] |= bit(ten)
			t.sigBy[seat] |= bit(c)
		}
		t.infer(seat, c)
		if game.Beats(c, t.best, t.led(), trump) {
			t.win, t.best = seat, c
		}
	}
	if c.Suit == trump {
		if o := int8(game.TrumpOrder(c.Rank)); o > t.high {
			t.high = o
		}
	}
	t.trick[t.n] = c
	t.n++
	t.points += game.Points(c, trump)
	b := bit(c)
	t.played |= b
	t.playedBy[seat] |= b
	if c == jackOf(trump) {
		t.boerSig = [2]game.Seat{game.NoSeat, game.NoSeat}
	}
	if t.n == 4 {
		t.won[t.win.Team()]++
		t.trickNo++
		t.n = 0
		t.leader = t.win
	}
}

// infer records what the rules tell about seat's hand when it plays c
// into the current trick (n > 0). See design.md §2 "Following suit".
func (t *table) infer(seat game.Seat, c game.Card) {
	trump, led := t.trump, t.led()
	ex := &t.excl[seat]
	lowerTrump := c.Suit == trump && int8(game.TrumpOrder(c.Rank)) < t.high
	if led == trump {
		switch {
		case c.Suit != trump:
			*ex |= suitSet(trump)
		case lowerTrump:
			*ex |= t.trumpsAbove(t.high)
		}
		return
	}
	if c.Suit == led {
		return
	}
	*ex |= suitSet(led)
	if t.rules == game.Amsterdams && t.win == seat.Partner() {
		// Free choice, except that undertrumping means nothing else was left.
		if lowerTrump {
			*ex |= ^suitSet(trump) | t.trumpsAbove(t.high)
		}
		return
	}
	switch {
	case c.Suit != trump && t.rules == game.Rotterdams:
		*ex |= suitSet(trump) // Rotterdams: a void player with any trump must trump
	case c.Suit != trump:
		*ex |= t.trumpsAbove(t.high) // no trump at all if none was in the trick
	case lowerTrump && t.rules == game.Rotterdams:
		*ex |= t.trumpsAbove(t.high) // undertrumping is compulsory: side suits stay possible
	case lowerTrump:
		*ex |= ^suitSet(trump) | t.trumpsAbove(t.high)
	}
}
