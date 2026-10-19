package game

import (
	"errors"
	"fmt"
	"math/rand/v2"
)

// Phase of a deal.
type Phase string

const (
	PhaseTrump Phase = "trump" // a player chooses trump (utrechts, or forced in gedraaid)
	PhaseBid   Phase = "bid"   // gedraaid: players say spelen or passen on the turned suit
	PhasePlay  Phase = "play"  // tricks are being played
	PhaseDone  Phase = "done"  // all eight tricks played; Result is valid
)

// Errors returned by the Deal actions. Their texts are Dutch and may be
// shown to players as they are.
var (
	ErrWrongPhase  = errors.New("Dat kan nu niet.")
	ErrNotYourTurn = errors.New("Je bent niet aan de beurt.")
	ErrBadSuit     = errors.New("Ongeldige kleur.")
	ErrTurnedSuit  = errors.New("De gedraaide kleur is door iedereen gepast: kies een andere kleur.")
	ErrNotInHand   = errors.New("Die kaart heb je niet.")
	ErrIllegal     = errors.New("Die kaart mag je nu niet spelen.")
)

// IllegalError is returned by Play for a card the rules forbid. Reason is
// the Dutch explanation from ExplainIllegal; errors.Is(err, ErrIllegal) holds.
type IllegalError struct {
	Card   Card
	Reason string
}

func (e *IllegalError) Error() string { return e.Reason }
func (e *IllegalError) Unwrap() error { return ErrIllegal }

// HandResult is the outcome of one hand.
type HandResult struct {
	PlayingTeam int    `json:"playingTeam"`
	TrumpBy     Seat   `json:"trumpBy"`
	Trump       Suit   `json:"trump"`
	Dealer      Seat   `json:"dealer"`
	Points      [2]int `json:"points"` // card points incl. last trick, before nat
	Roem        [2]int `json:"roem"`   // roem incl. the 100 for pit, before nat
	Score       [2]int `json:"score"`  // what goes on the score sheet
	Nat         bool   `json:"nat"`
	Pit         bool   `json:"pit"`
	PitTeam     int    `json:"pitTeam"` // -1 if none
}

// PitBonus is the roem for winning all eight tricks.
const PitBonus = 100

// LastTrickBonus is added to the card points of the last trick.
const LastTrickBonus = 10

// ScoreHand applies the nat rule: the playing team must score strictly more
// than half of all points and roem (roem includes any pit bonus). If not,
// it is nat: it scores 0 and the defenders score everything.
func ScoreHand(playingTeam int, points, roem [2]int) (score [2]int, nat bool) {
	p := playingTeam & 1
	total := points[0] + points[1] + roem[0] + roem[1]
	if 2*(points[p]+roem[p]) > total {
		return [2]int{points[0] + roem[0], points[1] + roem[1]}, false
	}
	score[1-p] = total
	return score, true
}

// View is everything one seat may know about a deal. HandNo, HandsTotal and
// MatchScore are not known to the deal; the server fills them in.
type View struct {
	Seat        Seat
	Hand        []Card
	Dealer      Seat
	Voorhand    Seat
	Mode        TrumpMode
	Rules       Rules
	Phase       Phase
	Turn        Seat // whose action is awaited, NoSeat when done
	Trump       Suit
	TrumpKnown  bool
	TrumpBy     Seat // NoSeat before trump is known
	PlayingTeam int  // -1 before trump is known
	Turned      Suit
	Bids        [4]int
	Forced      bool
	// Current is the trick the next card goes into: once a trick is complete
	// it is already the next (empty) trick, led by the winner; the completed
	// trick is the last of Tricks. When the deal is done, Current is the
	// last trick.
	Current            Trick
	Tricks             []Trick // completed tricks of this hand, in order
	Legal              []Card  // when it is Seat's turn in phase play
	HandNo, HandsTotal int
	MatchScore         [2]int
}

// trickRec is the compact, copyable form of a trick inside Deal.
type trickRec struct {
	cards  [4]Card
	n      uint8
	nRoem  uint8
	leader Seat
	winner Seat
	points int
	roem   [2]RoemItem
}

// Deal is one hand ("potje") as a pure state machine: no timing and no
// randomness. It holds no slices or maps, so assigning *dst = *src (or
// Clone) is a complete, independent copy, which suits simulations.
type Deal struct {
	dealer     Seat
	mode       TrumpMode
	rules      Rules
	phase      Phase
	turn       Seat
	turned     Suit
	trump      Suit
	trumpKnown bool
	trumpBy    Seat
	forced     bool
	bids       [4]int
	hands      [4][8]Card
	nHand      [4]uint8
	tricks     [8]trickRec
	cur        int // index of the current trick in tricks
	points     [2]int
	roem       [2]int
	won        [2]int
}

// NewDeal starts a hand. hands are the cards of seats 0..3 (normally 8 each,
// all the same length); turned is the turned suit for gedraaid and ignored
// for utrechts. It panics on hands of unequal length or longer than 8.
func NewDeal(dealer Seat, hands [4][]Card, mode TrumpMode, rules Rules, turned Suit) *Deal {
	d := &Deal{
		dealer:  dealer & 3,
		mode:    mode,
		rules:   rules,
		turned:  turned & 3,
		trumpBy: NoSeat,
		bids:    [4]int{-1, -1, -1, -1},
	}
	for s, h := range hands {
		if len(h) > 8 || len(h) != len(hands[0]) {
			panic(fmt.Sprintf("game: NewDeal: bad hand sizes %d/%d/%d/%d",
				len(hands[0]), len(hands[1]), len(hands[2]), len(hands[3])))
		}
		d.nHand[s] = uint8(copy(d.hands[s][:], h))
	}
	d.turn = d.dealer.Next()
	d.tricks[0] = trickRec{leader: d.turn, winner: NoSeat}
	if mode == Gedraaid {
		d.phase = PhaseBid
	} else {
		d.phase = PhaseTrump
	}
	return d
}

// Shuffle shuffles a deck and deals it 3-2-3 to seats 0..3. A nil rng uses
// the global source.
func Shuffle(rng *rand.Rand) [4][]Card {
	deck := NewDeck()
	swap := func(i, j int) { deck[i], deck[j] = deck[j], deck[i] }
	if rng != nil {
		rng.Shuffle(len(deck), swap)
	} else {
		rand.Shuffle(len(deck), swap)
	}
	var hands [4][]Card
	for s := range hands {
		hands[s] = make([]Card, 0, 8)
	}
	i := 0
	for _, k := range [3]int{3, 2, 3} {
		for s := range hands {
			hands[s] = append(hands[s], deck[i:i+k]...)
			i += k
		}
	}
	return hands
}

// Clone returns an independent copy of d.
func (d *Deal) Clone() *Deal {
	c := *d
	return &c
}

// Simple accessors; see the design for their meaning.
func (d *Deal) Phase() Phase        { return d.phase }
func (d *Deal) Dealer() Seat        { return d.dealer }
func (d *Deal) Voorhand() Seat      { return d.dealer.Next() }
func (d *Deal) Mode() TrumpMode     { return d.mode }
func (d *Deal) Rules() Rules        { return d.rules }
func (d *Deal) Turned() Suit        { return d.turned }
func (d *Deal) Forced() bool        { return d.forced }
func (d *Deal) Bids() [4]int        { return d.bids }
func (d *Deal) TrumpBy() Seat       { return d.trumpBy }
func (d *Deal) Trump() (Suit, bool) { return d.trump, d.trumpKnown }

// Turn returns whose action is awaited, NoSeat when the deal is done.
func (d *Deal) Turn() Seat { return d.turn }

// PlayingTeam returns the team that made trump, -1 before trump is known.
func (d *Deal) PlayingTeam() int {
	if !d.trumpKnown {
		return -1
	}
	return d.trumpBy.Team()
}

// Hand returns a copy of the cards seat still holds, in dealt order
// (never nil, so it marshals as []).
func (d *Deal) Hand(seat Seat) []Card {
	return d.AppendHand(make([]Card, 0, d.nHand[seat&3]), seat)
}

// AppendHand appends the cards seat still holds to dst.
func (d *Deal) AppendHand(dst []Card, seat Seat) []Card {
	s := seat & 3
	return append(dst, d.hands[s][:d.nHand[s]]...)
}

// HandLen returns how many cards seat still holds.
func (d *Deal) HandLen(seat Seat) int { return int(d.nHand[seat&3]) }

// TricksWon returns the number of completed tricks per team.
func (d *Deal) TricksWon() [2]int { return d.won }

// HandPoints returns the card points per team so far (incl. last trick).
func (d *Deal) HandPoints() [2]int { return d.points }

// HandRoem returns the roem per team from tricks so far (without pit).
func (d *Deal) HandRoem() [2]int { return d.roem }

// Current returns the trick in progress. A completed trick stays current
// until the next card is played; before play it is empty, led by voorhand.
func (d *Deal) Current() Trick {
	return d.tricks[d.cur].trick()
}

// Tricks returns the completed tricks in order, including a completed
// trick that is still Current.
func (d *Deal) Tricks() []Trick {
	n := d.completed()
	out := make([]Trick, n)
	for i := range out {
		out[i] = d.tricks[i].trick()
	}
	return out
}

// completed returns the number of completed tricks.
func (d *Deal) completed() int {
	if d.tricks[d.cur].n == 4 {
		return d.cur + 1
	}
	return d.cur
}

// TrickCount returns the number of completed tricks.
func (d *Deal) TrickCount() int { return d.completed() }

func (r *trickRec) trick() Trick {
	t := Trick{Leader: r.leader, Winner: r.winner, Cards: make([]Played, r.n)}
	for i := range t.Cards {
		t.Cards[i] = Played{Seat: (r.leader + Seat(i)) & 3, Card: r.cards[i]}
	}
	if r.n == 4 {
		t.Points = r.points
		t.Roem = make([]RoemItem, r.nRoem)
		copy(t.Roem, r.roem[:r.nRoem])
	}
	return t
}

// ChooseTrump sets trump: voorhand in utrechts, or in gedraaid after four
// passes (forced; the turned suit is not allowed then).
func (d *Deal) ChooseTrump(seat Seat, s Suit) error {
	if d.phase != PhaseTrump {
		return ErrWrongPhase
	}
	if seat != d.turn {
		return ErrNotYourTurn
	}
	if s >= NumSuits {
		return ErrBadSuit
	}
	if d.forced && s == d.turned {
		return ErrTurnedSuit
	}
	d.setTrump(seat, s)
	return nil
}

// Bid records spelen (play=true) or passen in gedraaid. The first player
// to play makes the turned suit trump; after four passes voorhand must
// choose another suit.
func (d *Deal) Bid(seat Seat, play bool) error {
	if d.phase != PhaseBid {
		return ErrWrongPhase
	}
	if seat != d.turn {
		return ErrNotYourTurn
	}
	if play {
		d.bids[seat] = 1
		d.setTrump(seat, d.turned)
		return nil
	}
	d.bids[seat] = 0
	d.turn = seat.Next()
	if d.turn == d.Voorhand() {
		d.forced = true
		d.phase = PhaseTrump
	}
	return nil
}

func (d *Deal) setTrump(seat Seat, s Suit) {
	d.trump, d.trumpKnown, d.trumpBy = s, true, seat
	d.phase = PhasePlay
	d.turn = d.tricks[0].leader
	if d.nHand[0] == 0 {
		d.finish()
	}
}

// Play plays card c for seat. Illegal cards return an *IllegalError.
func (d *Deal) Play(seat Seat, c Card) error {
	if d.phase != PhasePlay {
		return ErrWrongPhase
	}
	if seat != d.turn {
		return ErrNotYourTurn
	}
	hand := d.hands[seat][:d.nHand[seat]]
	idx := -1
	for i, h := range hand {
		if h == c {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotInHand
	}
	if d.tricks[d.cur].n == 4 {
		d.cur++
		d.tricks[d.cur] = trickRec{leader: d.tricks[d.cur-1].winner, winner: NoSeat}
	}
	t := &d.tricks[d.cur]
	ti := infoFromCards(t.leader, t.cards[:t.n], d.trump)
	if sit := judge(hand, &ti, seat, d.trump, d.rules); !sit.allows(c) {
		return &IllegalError{Card: c, Reason: sit.illegal(c)}
	}
	copy(hand[idx:], hand[idx+1:])
	d.nHand[seat]--
	t.cards[t.n] = c
	t.n++
	if t.n < 4 {
		d.turn = seat.Next()
		return nil
	}
	d.completeTrick(t)
	return nil
}

func (d *Deal) completeTrick(t *trickRec) {
	t.winner = (t.leader + Seat(trickWinner(t.cards[:], d.trump))) & 3
	t.points = CardPoints(t.cards[:], d.trump)
	last := d.nHand[0] == 0 && d.nHand[1] == 0 && d.nHand[2] == 0 && d.nHand[3] == 0
	if last {
		t.points += LastTrickBonus
	}
	t.nRoem = uint8(len(AppendTrickRoem(t.roem[:0], t.cards[:], d.trump)))
	team := t.winner.Team()
	d.won[team]++
	d.points[team] += t.points
	for _, r := range t.roem[:t.nRoem] {
		d.roem[team] += r.Points
	}
	d.turn = t.winner
	if last {
		d.finish()
	}
}

func (d *Deal) finish() {
	d.phase = PhaseDone
	d.turn = NoSeat
}

// AppendLegal appends the cards the seat on turn may play (nothing outside
// phase play). It does not allocate when dst has room for 8 cards.
func (d *Deal) AppendLegal(dst []Card) []Card {
	if d.phase != PhasePlay {
		return dst
	}
	s := d.turn
	hand := d.hands[s][:d.nHand[s]]
	t := &d.tricks[d.cur]
	var ti trickInfo
	if t.n == 4 {
		ti = trickInfo{high: -1, winner: NoSeat}
	} else {
		ti = infoFromCards(t.leader, t.cards[:t.n], d.trump)
	}
	return appendLegal(dst, hand, &ti, s, d.trump, d.rules)
}

// Legal returns the cards the seat on turn may play.
func (d *Deal) Legal() []Card {
	return d.AppendLegal(make([]Card, 0, 8))
}

// Result returns the outcome of the hand; valid when Phase() is PhaseDone.
func (d *Deal) Result() HandResult {
	r := HandResult{
		PlayingTeam: d.PlayingTeam(),
		TrumpBy:     d.trumpBy,
		Trump:       d.trump,
		Dealer:      d.dealer,
		Points:      d.points,
		Roem:        d.roem,
		PitTeam:     -1,
	}
	for team, n := range d.won {
		if n == 8 {
			r.Pit, r.PitTeam = true, team
			r.Roem[team] += PitBonus
		}
	}
	if r.PlayingTeam >= 0 {
		r.Score, r.Nat = ScoreHand(r.PlayingTeam, r.Points, r.Roem)
	}
	return r
}

// View returns everything seat may know.
func (d *Deal) View(seat Seat) View {
	seat &= 3
	v := View{
		Seat:        seat,
		Hand:        d.Hand(seat),
		Dealer:      d.dealer,
		Voorhand:    d.Voorhand(),
		Mode:        d.mode,
		Rules:       d.rules,
		Phase:       d.phase,
		Turn:        d.turn,
		Trump:       d.trump,
		TrumpKnown:  d.trumpKnown,
		TrumpBy:     d.trumpBy,
		PlayingTeam: d.PlayingTeam(),
		Turned:      d.turned,
		Bids:        d.bids,
		Forced:      d.forced,
		Tricks:      d.Tricks(),
	}
	if t := &d.tricks[d.cur]; t.n == 4 && d.phase == PhasePlay {
		v.Current = Trick{Leader: t.winner, Winner: NoSeat, Cards: []Played{}}
	} else {
		v.Current = t.trick()
	}
	if d.phase == PhasePlay && d.turn == seat {
		v.Legal = d.Legal()
	}
	return v
}

// Resume rebuilds a deal in phase play from v and the cards every seat
// still holds (hands[v.Seat] is normally v.Hand), for example hidden hands
// sampled by a bot. Points, roem and tricks won are recomputed from
// v.Tricks; v.Current continues as the trick in progress.
func Resume(v View, hands [4][]Card) (*Deal, error) {
	if v.Phase != PhasePlay || !v.TrumpKnown {
		return nil, errors.New("game: Resume needs a view in phase play")
	}
	if len(v.Tricks) > 8 || len(v.Current.Cards) > 4 {
		return nil, errors.New("game: Resume: too many tricks or cards")
	}
	d := &Deal{
		dealer:     v.Dealer & 3,
		mode:       v.Mode,
		rules:      v.Rules,
		phase:      PhasePlay,
		turned:     v.Turned & 3,
		trump:      v.Trump & 3,
		trumpKnown: true,
		trumpBy:    v.TrumpBy,
		forced:     v.Forced,
		bids:       v.Bids,
	}
	var played [4]int
	for i, t := range v.Tricks {
		if len(t.Cards) != 4 {
			return nil, fmt.Errorf("game: Resume: trick %d has %d cards", i+1, len(t.Cards))
		}
		r := &d.tricks[i]
		r.leader, r.n = t.Leader&3, 4
		for j, p := range t.Cards {
			r.cards[j] = p.Card
			played[(r.leader+Seat(j))&3]++
		}
		r.winner = (r.leader + Seat(trickWinner(r.cards[:], d.trump))) & 3
		r.points = CardPoints(r.cards[:], d.trump)
		if i == 7 {
			r.points += LastTrickBonus
		}
		r.nRoem = uint8(len(AppendTrickRoem(r.roem[:0], r.cards[:], d.trump)))
		team := r.winner.Team()
		d.won[team]++
		d.points[team] += r.points
		for _, it := range r.roem[:r.nRoem] {
			d.roem[team] += it.Points
		}
	}
	n := len(v.Tricks)
	switch {
	case len(v.Current.Cards) > 0 && len(v.Current.Cards) < 4:
		if n == 8 {
			return nil, errors.New("game: Resume: trick after the last")
		}
		r := &d.tricks[n]
		r.leader, r.winner = v.Current.Leader&3, NoSeat
		for j, p := range v.Current.Cards {
			r.cards[j] = p.Card
			r.n++
			played[(r.leader+Seat(j))&3]++
		}
		d.cur = n
		d.turn = (r.leader + Seat(r.n)) & 3
	case n > 0:
		d.cur = n - 1
		d.turn = d.tricks[d.cur].winner
	default:
		d.tricks[0] = trickRec{leader: d.dealer.Next(), winner: NoSeat}
		d.turn = d.tricks[0].leader
	}
	for s, h := range hands {
		if len(h)+played[s] != 8 {
			return nil, fmt.Errorf("game: Resume: seat %d has %d cards, want %d", s, len(h), 8-played[s])
		}
		d.nHand[s] = uint8(copy(d.hands[s][:], h))
	}
	if n == 8 {
		d.finish()
	}
	return d, nil
}
