package toepen

import (
	"slices"

	"klaverjas/internal/game"
)

// View is everything seat may know of a round: the bots decide on it.
type View struct {
	Players  int
	Seat     game.Seat
	Rules    Rules
	Phase    Phase
	Turn     game.Seat
	Dealer   game.Seat
	Voorhand game.Seat
	Stake    int
	Toeper   game.Seat // the last to toep, NoSeat before anyone did
	Toeps    []Toep    // every raise so far
	CanToep  bool      // Seat may toep now
	Hand     []game.Card
	Legal    []game.Card // Seat's turn in PhasePlay

	Cards   [MaxPlayers]int    // cards each seat holds
	Points  [MaxPlayers]int    // penalty points now
	Status  [MaxPlayers]Status //
	Armoede [MaxPlayers]bool
	Washed  [MaxPlayers]bool // got new cards for a was
	Claimed [MaxPlayers]bool // claimed a was (once the time for it is over)

	Answered bool      // PhaseWas: Seat said whether it has a was
	CanClaim bool      // PhaseWas: Seat may still claim one
	Claimant game.Seat // PhaseCheck: whose was is asked about
	Checks   []Check   // the claims settled so far
	Stock    int       // cards left for a was

	Current Trick
	Tricks  []Trick
}

// View returns what seat may know.
func (d *Deal) View(seat game.Seat) View {
	v := View{
		Players:  d.players,
		Seat:     seat,
		Rules:    d.rules,
		Phase:    d.phase,
		Turn:     d.turn,
		Dealer:   d.dealer,
		Voorhand: d.voorhand,
		Stake:    d.stake,
		Toeper:   d.toeper,
		Toeps:    d.Toeps(),
		CanToep:  d.CanToep(seat),
		Hand:     slices.Clone(d.hands[seat]),
		Points:   d.points,
		Status:   d.status,
		Armoede:  d.armoede,
		Washed:   d.washed,
		Answered: d.answered[seat],
		CanClaim: d.CanClaim(seat),
		Claimant: d.Claimant(),
		Checks:   d.Checks(),
		Stock:    len(d.stock),
		Current:  d.Current(),
		Tricks:   d.Tricks(),
	}
	if d.status[seat] != StatusIn {
		v.Hand = nil
	}
	for s := range game.Seat(d.players) {
		v.Cards[s] = d.HandLen(s)
		v.Claimed[s] = d.Claimed(s)
	}
	if d.phase == PhasePlay && d.turn == seat {
		v.Legal = d.Legal()
	}
	return v
}

// In reports whether s still plays the round.
func (v *View) In(s game.Seat) bool {
	return s >= 0 && int(s) < v.Players && v.Status[s] == StatusIn
}

// InCount is the number of seats still in the round.
func (v *View) InCount() int {
	n := 0
	for s := range v.Players {
		if v.Status[s] == StatusIn {
			n++
		}
	}
	return n
}

// Next is the seat after s, clockwise.
func (v *View) Next(s game.Seat) game.Seat { return (s + 1) % game.Seat(v.Players) }

// Seen lists every card Seat has seen leave a hand: the cards played and
// the hands shown by a check.
func (v *View) Seen() []game.Card {
	var out []game.Card
	for _, t := range v.Tricks {
		for _, p := range t.Cards {
			out = append(out, p.Card)
		}
	}
	for _, p := range v.Current.Cards {
		out = append(out, p.Card)
	}
	for _, c := range v.Checks {
		out = append(out, c.Cards...)
	}
	return out
}

// Match is the bookkeeping of a game of toepen: the penalty points of
// every seat, and who deals. It goes on until one player is left.
type Match struct {
	Players int
	Rules   Rules
	Points  [MaxPlayers]int
	Dealer  game.Seat // of the round in play or last played
	Round   int       // rounds dealt
}

// NewMatch starts a match; first is the first dealer.
func NewMatch(players int, rules Rules, first game.Seat) *Match {
	return &Match{Players: players, Rules: rules, Dealer: first}
}

// Alive reports whether s is still in the match.
func (m *Match) Alive(s game.Seat) bool {
	return s >= 0 && int(s) < m.Players && m.Points[s] < m.Rules.Limit
}

// Left is the number of players still in.
func (m *Match) Left() int {
	n := 0
	for s := range game.Seat(m.Players) {
		if m.Alive(s) {
			n++
		}
	}
	return n
}

// Over reports whether one player is left.
func (m *Match) Over() bool { return m.Left() <= 1 }

// Winner is the last player in, NoSeat while more are.
func (m *Match) Winner() game.Seat {
	if !m.Over() {
		return game.NoSeat
	}
	for s := range game.Seat(m.Players) {
		if m.Alive(s) {
			return s
		}
	}
	return game.NoSeat
}

// Deal deals the next round from deck. The first round is dealt by the
// first dealer; then the deal passes clockwise to the next player still in.
func (m *Match) Deal(deck []game.Card) *Deal {
	if m.Round > 0 || !m.Alive(m.Dealer) {
		s := m.Dealer
		for range m.Players {
			s = (s + 1) % game.Seat(m.Players)
			if m.Alive(s) {
				break
			}
		}
		m.Dealer = s
	}
	m.Round++
	return NewDeal(m.Players, m.Rules, m.Dealer, m.Points, deck)
}

// Settle takes the penalty points of a finished round.
func (m *Match) Settle(d *Deal) {
	if r := d.Result(); r != nil {
		copy(m.Points[:], r.Points)
	}
}
