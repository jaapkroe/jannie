package toepen

import (
	"errors"
	"fmt"
	"slices"

	"jannie/platform/cards"
)

// Rules are the table's choices where groups play toepen differently.
type Rules struct {
	Limit    int  `json:"limit"`    // penalty points that put a player out (10 or 15)
	Was      bool `json:"was"`      // a witte or vuile was may be swapped for new cards
	Armoede  bool `json:"armoede"`  // a player one point from out: the round starts toept
	Koning   bool `json:"koning"`   // everyone left one point from out: the koningsspel, eight cards each
	Boer     bool `json:"boer"`     // the last trick taken with a boer: a penalty point off
	Lijntoep bool `json:"lijntoep"` // anti-lijntoep: nobody passes on a toep more than twice in a row
	Bluf     bool `json:"bluf"`     // a bluff that is caught: play on with those cards face up (else sit the round out)
}

// DefaultRules are the rules of a new table.
var DefaultRules = Rules{Limit: DefaultLimit, Was: true, Armoede: true, Koning: true, Boer: true, Bluf: true}

// MaxPasses is how often in a row a player may pass on a toep under the
// anti-lijntoep rule; on the next toep it must go along.
const MaxPasses = 2

// Phase is where a round is.
type Phase string

const (
	// PhaseWas: right after the deal everyone in the round says, at the
	// same time, whether they have a was (Was); nobody's turn.
	PhaseWas Phase = "was"
	// PhaseCheck: a claimed was; the others are asked in turn whether
	// they check it (Check).
	PhaseCheck Phase = "check"
	// PhaseToep: after a toep (or armoede) the others say in turn whether
	// they go along, pass (Answer) or, after a toep, toep again
	// (Overtoep).
	PhaseToep Phase = "toep"
	// PhaseDiscard: the koningsspel; in turn from voorhand each lays the
	// cards it holds beyond the hand played away, face down (Discard).
	PhaseDiscard Phase = "discard"
	// PhasePlay: tricks; on their turn a player plays a card or toeps.
	PhasePlay Phase = "play"
	PhaseDone Phase = "done"
)

// Status is where a seat stands in a round.
type Status uint8

const (
	StatusOut    Status = iota // not in the match any more
	StatusIn                   // plays the round
	StatusPassed               // passed on a toep
	StatusCaught               // claimed a was that was none, and was checked
	StatusDead                 // reached the limit during the round
)

var statusCodes = [...]string{"uit", "in", "gepast", "betrapt", "eruit"}

// String is the wire code: "uit", "in", "gepast", "betrapt", "eruit".
func (s Status) String() string {
	if int(s) < len(statusCodes) {
		return statusCodes[s]
	}
	return "?"
}

// MarshalText writes the wire code.
func (s Status) MarshalText() ([]byte, error) { return []byte(s.String()), nil }

// UnmarshalText reads the wire code.
func (s *Status) UnmarshalText(b []byte) error {
	for k, code := range statusCodes {
		if string(b) == code {
			*s = Status(k)
			return nil
		}
	}
	return fmt.Errorf("toepen: unknown status %q", b)
}

// Errors, in Dutch: safe to show.
var (
	ErrWrongPhase    = errors.New("Dat kan nu niet.")
	ErrNotYourTurn   = errors.New("Je bent niet aan de beurt.")
	ErrNotIn         = errors.New("Je speelt dit potje niet (meer) mee.")
	ErrNotInHand     = errors.New("Die kaart heb je niet.")
	ErrIllegal       = errors.New("Die kaart mag niet.")
	ErrToepAgain     = errors.New("Je toepte zelf het laatst: eerst moet een ander toepen.")
	ErrAnswered      = errors.New("Je hebt al gezegd of je een vuile was hebt.")
	ErrNoStock       = errors.New("De stapel is op: er kan niemand meer wassen.")
	ErrToepArmoede   = errors.New("Op armoede kun je niet toepen.")
	ErrToepDead      = errors.New("Met deze inzet lig je er bij verlies al uit: dan kun je niet toepen.")
	ErrNoRaise       = errors.New("Overtoepen kan alleen op een toep.")
	ErrMustStay      = errors.New("Anti-lijntoep: je paste al twee keer achter elkaar, nu moet je mee.")
	ErrPoorBluff     = errors.New("Op armoede mag je alleen een echte vuile was inleveren.")
	ErrToepPointless = errors.New("Toepen heeft nu geen zin: niemand anders kan nog passen.")
	ErrDiscardTwice  = errors.New("Leg elke kaart maar één keer weg.")
)

// IllegalError is a card that may not be played, with the reason.
type IllegalError struct {
	Card   cards.Card
	Reason string
}

func (e *IllegalError) Error() string { return e.Reason }

// Is makes errors.Is(err, ErrIllegal) hold.
func (e *IllegalError) Is(target error) bool { return target == ErrIllegal }

// Check is how a claimed was ended: let through by everyone (Checker
// NoSeat), or checked, and then genuine or not; or, for a claimant on
// armoede, laid open on the table (Shown) without a question. Cards are the
// claimed hand when it was checked or shown: everyone has seen them.
type Check struct {
	Claimant cards.Seat   `json:"claimant"`
	Checker  cards.Seat   `json:"checker"`
	Kind     WasKind      `json:"kind"`  // what the hand was; only told when checked or shown
	Cards    []cards.Card `json:"cards"` // the hand shown, when checked or shown
	Shown    bool         `json:"shown"` // on armoede: laid open on the table, always genuine
}

// Genuine reports whether the claimed hand was a was (only known when it
// was checked or shown).
func (c Check) Genuine() bool { return c.Kind != NoWas }

// Washed reports whether the claimant handed the hand in for new cards:
// let through, or checked or shown and genuine.
func (c Check) Washed() bool { return c.Checker == cards.NoSeat || c.Genuine() }

// Toep is one raise of the stake: by Seat, with Tricks tricks complete,
// to Stake.
type Toep struct {
	Seat   cards.Seat `json:"seat"`
	Tricks int        `json:"tricks"`
	Stake  int        `json:"stake"`
}

// Result is how a round ended. Points and gains are penalty points, per
// seat.
type Result struct {
	Winner cards.Seat `json:"winner"`
	Stake  int        `json:"stake"`
	Tricks bool       `json:"tricks"` // won with the last trick; else everyone else passed or sat out
	Boer   bool       `json:"boer"`   // the last trick taken with a boer (rule Boer): a point off for the winner
	Koning bool       `json:"koning"` // the koningsspel
	Gains  []int      `json:"gains"`  // this round (the winner's -1 for the boer)
	Points []int      `json:"points"` // after it
	Out    []bool     `json:"out"`    // out of the match after it
}

// Deal is one round. It holds no timing and no randomness: the cards come
// in through NewDeal.
type Deal struct {
	players  int
	rules    Rules
	dealer   cards.Seat
	voorhand cards.Seat
	phase    Phase
	turn     cards.Seat
	stake    int
	toeper   cards.Seat // the last to toep; NoSeat before anyone did (also after armoede)
	armoedeT bool       // the stake was raised for armoede
	poorAsk  bool       // PhaseToep: the question is armoede's, not a toep's
	toeps    []Toep
	koning   bool                     // the koningsspel
	size     int                      // cards each plays with
	dealt    int                      // cards dealt to each: size, or more in the koningsspel
	laid     [MaxPlayers][]cards.Card // the koningsspel: the cards each laid away, face down
	streak   [MaxPlayers]int          // passes on a toep in a row, also in rounds before (anti-lijntoep)
	accepted [MaxPlayers]int          // the stake each last agreed to: passing costs it
	auto     []cards.Seat             // went along at the last raise without a question: passing would put them out
	stockOut bool                     // new cards could not be washed again: the stock ran out
	record   [MaxPlayers]Record       // the bluffs seen in the rounds before

	start   [MaxPlayers]int // penalty points at the deal
	points  [MaxPlayers]int // penalty points now
	status  [MaxPlayers]Status
	armoede [MaxPlayers]bool
	hands   [MaxPlayers][]cards.Card
	stock   []cards.Card

	// The was.
	window   int // the time for a was: 1, and one more each time new cards may be washed again
	answered [MaxPlayers]bool
	claimed  [MaxPlayers]bool
	claims   []cards.Seat // left to settle, in order from voorhand
	washed   [MaxPlayers]bool
	fresh    [MaxPlayers]bool         // got new cards in this time for a was
	given    [MaxPlayers][]cards.Card // the hands given back, in order
	checks   []Check
	open     [MaxPlayers]bool // caught bluffing (rule Bluf): plays on with its cards face up

	// Questions asked in turn: whether to check a was, or to go along.
	asking []cards.Seat

	current Trick
	tricks  []Trick
	result  *Result
}

// NewDeal deals a round to every seat of a table of players still in the
// match (fewer than rules.Limit points): four cards each from deck, in
// order from voorhand, the first seat in the match after dealer, which
// must be in it. The rest of the deck is the stock for a was. When
// everyone left stands one point from out and the rules have the
// koningsspel, each gets eleven cards instead (as many as the deck holds
// for all), lays away down to eight (PhaseDiscard) and plays those; there
// is no was and no armoede.
func NewDeal(players int, rules Rules, dealer cards.Seat, points [MaxPlayers]int, deck []cards.Card) *Deal {
	d := &Deal{
		players: players,
		rules:   rules,
		dealer:  dealer,
		stake:   1,
		toeper:  cards.NoSeat,
		start:   points,
		points:  points,
		turn:    cards.NoSeat,
	}
	in, poor := 0, 0
	for s := range players {
		if points[s] < rules.Limit {
			d.status[s] = StatusIn
			d.accepted[s] = 1
			d.armoede[s] = rules.Armoede && points[s] == rules.Limit-1
			in++
			if points[s] == rules.Limit-1 {
				poor++
			}
		}
	}
	d.koning = rules.Koning && in >= 2 && poor == in
	d.size, d.dealt = HandSize, HandSize
	if d.koning {
		d.dealt = min(KoningDeal, len(deck)/in)
		d.size = min(KoningSize, d.dealt)
	}
	d.voorhand = d.nextIn(dealer)
	at := 0
	for k, s := 0, d.voorhand; k < players; k, s = k+1, d.next(s) {
		if d.status[s] == StatusIn {
			d.hands[s] = slices.Clone(deck[at : at+d.dealt])
			at += d.dealt
		}
	}
	d.stock = slices.Clone(deck[at:])
	if d.dealt > d.size {
		for k, s := 0, d.voorhand; k < players; k, s = k+1, d.next(s) {
			if d.status[s] == StatusIn {
				d.asking = append(d.asking, s)
			}
		}
		d.phase = PhaseDiscard
		d.turn = d.asking[0]
		return d
	}
	if rules.Was && !d.koning && len(d.stock) >= HandSize {
		d.phase = PhaseWas
		d.window = 1
		return d
	}
	d.afterWas()
	return d
}

// next is the seat after s, clockwise.
func (d *Deal) next(s cards.Seat) cards.Seat { return (s + 1) % cards.Seat(d.players) }

// nextIn is the first seat after s that is still in the round.
func (d *Deal) nextIn(s cards.Seat) cards.Seat {
	for range d.players {
		s = d.next(s)
		if d.status[s] == StatusIn {
			return s
		}
	}
	return cards.NoSeat
}

// fromIn is s when it is still in the round, else nextIn(s).
func (d *Deal) fromIn(s cards.Seat) cards.Seat {
	if d.status[s] == StatusIn {
		return s
	}
	return d.nextIn(s)
}

// in reports whether s still plays this round.
func (d *Deal) in(s cards.Seat) bool { return s >= 0 && int(s) < d.players && d.status[s] == StatusIn }

// inCount is the number of seats still in the round.
func (d *Deal) inCount() int {
	n := 0
	for s := range d.players {
		if d.status[s] == StatusIn {
			n++
		}
	}
	return n
}

// others lists the seats still in the round after s, clockwise, without s.
func (d *Deal) others(s cards.Seat) []cards.Seat {
	var out []cards.Seat
	for k, o := 0, d.next(s); k < d.players-1; k, o = k+1, d.next(o) {
		if d.status[o] == StatusIn {
			out = append(out, o)
		}
	}
	return out
}

// penalise adds n penalty points to s; reaching the limit takes s out of
// the round at once.
func (d *Deal) penalise(s cards.Seat, n int) {
	d.points[s] += n
	if d.points[s] >= d.rules.Limit && d.status[s] == StatusIn {
		d.status[s] = StatusDead
	}
}

// ---- the was ----

// Was records whether seat claims a was (claim) or not. Everyone still in
// the round answers once, in any order; after the last answer the claims
// are settled one by one in order from voorhand (PhaseCheck).
func (d *Deal) Was(seat cards.Seat, claim bool) error {
	if d.phase != PhaseWas {
		return ErrWrongPhase
	}
	if !d.in(seat) {
		return ErrNotIn
	}
	if d.answered[seat] {
		return ErrAnswered
	}
	if claim {
		n := 1
		for s := range d.players {
			if d.claimed[s] {
				n++
			}
		}
		if n*HandSize > len(d.stock) {
			return ErrNoStock
		}
		if d.armoede[seat] && Was(d.hands[seat]) == NoWas {
			return ErrPoorBluff
		}
	}
	d.answered[seat], d.claimed[seat] = true, claim
	for s := range d.players {
		if d.status[s] == StatusIn && !d.answered[s] {
			return nil
		}
	}
	d.CloseWas()
	return nil
}

// CanClaim reports whether seat may still claim a was: it is the time for
// it, the seat has not answered and the stock holds new cards for it; on
// armoede only with a real one.
func (d *Deal) CanClaim(seat cards.Seat) bool {
	if d.phase != PhaseWas || !d.in(seat) || d.answered[seat] || d.armoede[seat] && Was(d.hands[seat]) == NoWas {
		return false
	}
	n := 1
	for s := range d.players {
		if d.claimed[s] {
			n++
		}
	}
	return n*HandSize <= len(d.stock)
}

// Answered reports whether seat has said whether it has a was.
func (d *Deal) Answered(seat cards.Seat) bool { return d.answered[seat] }

// CloseWas ends the time for a was: whoever has not answered has none.
func (d *Deal) CloseWas() {
	if d.phase != PhaseWas {
		return
	}
	for k, s := 0, d.voorhand; k < d.players; k, s = k+1, d.next(s) {
		if d.claimed[s] {
			d.claims = append(d.claims, s)
		}
	}
	d.nextClaim()
}

// nextClaim asks about the first claim still to settle, or moves on.
func (d *Deal) nextClaim() {
	for len(d.claims) > 0 {
		if d.inCount() <= 1 {
			break
		}
		c := d.claims[0]
		if !d.in(c) {
			d.claims = d.claims[1:]
			continue
		}
		if d.armoede[c] {
			// On armoede the hand is laid open on the table, and it is
			// real (Was refuses a bluff): nobody is asked.
			d.checks = append(d.checks, Check{Claimant: c, Checker: cards.NoSeat, Kind: Was(d.hands[c]),
				Cards: slices.Clone(d.hands[c]), Shown: true})
			d.swap(c)
			d.claims = d.claims[1:]
			continue
		}
		d.asking = d.others(c)
		d.phase = PhaseCheck
		d.turn = d.asking[0]
		return
	}
	d.claims = nil
	if d.inCount() <= 1 {
		d.finish(d.fromIn(d.voorhand), false)
		return
	}
	if d.washAgain() {
		return
	}
	d.afterWas()
}

// washAgain opens another time for a was when claims got new cards: who
// got them says again whether they have one (a was may be handed in more
// than once, while the stock lasts). The others are not asked.
func (d *Deal) washAgain() bool {
	again := false
	for s := range d.players {
		again = again || d.fresh[s] && d.status[s] == StatusIn
	}
	if !again || len(d.stock) < HandSize {
		d.stockOut = d.stockOut || again
		d.fresh = [MaxPlayers]bool{}
		return false
	}
	d.window++
	for s := range d.players {
		d.answered[s] = !(d.fresh[s] && d.status[s] == StatusIn)
		d.claimed[s] = false
	}
	d.fresh = [MaxPlayers]bool{}
	d.phase = PhaseWas
	d.turn = cards.NoSeat
	return true
}

// Claimant is the seat whose was is being asked about (PhaseCheck), else
// NoSeat.
func (d *Deal) Claimant() cards.Seat {
	if d.phase != PhaseCheck {
		return cards.NoSeat
	}
	return d.claims[0]
}

// Check records whether seat, asked about the claimed was, checks it. The
// first to check settles it: a genuine was costs the checker a point, a
// false one the claimant, who then plays on with those cards face up (rule
// Bluf) or sits the round out; a genuine or unchecked claim gets four new
// cards from the stock. The result is set once the claim is settled
// (checked, or let through by everyone). Claims of seats on armoede that
// follow are settled at once (shown).
func (d *Deal) Check(seat cards.Seat, check bool) (*Check, error) {
	if d.phase != PhaseCheck {
		return nil, ErrWrongPhase
	}
	if seat != d.turn {
		return nil, ErrNotYourTurn
	}
	claimant := d.claims[0]
	d.asking = d.asking[1:]
	var res *Check
	switch {
	case check:
		kind := Was(d.hands[claimant])
		res = &Check{Claimant: claimant, Checker: seat, Kind: kind, Cards: slices.Clone(d.hands[claimant])}
		if kind != NoWas {
			d.penalise(seat, 1)
			d.swap(claimant)
		} else {
			d.penalise(claimant, 1)
			switch {
			case d.status[claimant] != StatusIn:
			case d.rules.Bluf:
				d.open[claimant] = true
			default:
				d.status[claimant] = StatusCaught
			}
		}
	case len(d.asking) == 0:
		res = &Check{Claimant: claimant, Checker: cards.NoSeat}
		d.swap(claimant)
	default:
		d.turn = d.asking[0]
		return nil, nil
	}
	d.checks = append(d.checks, *res)
	d.asking = nil
	d.turn = cards.NoSeat
	d.claims = d.claims[1:]
	d.nextClaim()
	return res, nil
}

// swap gives s four new cards from the stock for its hand.
func (d *Deal) swap(s cards.Seat) {
	d.given[s] = append(d.given[s], d.hands[s]...)
	d.hands[s] = slices.Clone(d.stock[:HandSize])
	d.stock = d.stock[HandSize:]
	d.washed[s] = true
	d.fresh[s] = true
}

// afterWas starts the tricks, after the question of armoede when a player
// still in is one point from out: the stake is then 2 from the start and
// the others say whether they go along. Not in the koningsspel, where
// everyone is.
func (d *Deal) afterWas() {
	if d.rules.Armoede && !d.koning {
		poor := false
		var ask []cards.Seat
		for k, s := 0, d.voorhand; k < d.players; k, s = k+1, d.next(s) {
			switch {
			case d.status[s] != StatusIn:
			case d.armoede[s]:
				poor = true
			default:
				ask = append(ask, s)
			}
		}
		if poor {
			d.stake, d.armoedeT = 2, true
			for s := range d.players {
				if d.armoede[s] && d.status[s] == StatusIn {
					d.accepted[s] = 2 // on armoede: in at 2 from the start
				}
			}
			if len(ask) > 0 {
				d.asking = ask
				d.phase = PhaseToep
				d.poorAsk = true
				d.turn = ask[0]
				return
			}
		}
	}
	d.startPlay()
}

// startPlay starts the tricks: FirstLeader leads.
func (d *Deal) startPlay() {
	d.phase = PhasePlay
	d.poorAsk = false
	d.current = Trick{Leader: d.FirstLeader(), Winner: cards.NoSeat}
	d.turn = d.current.Leader
}

// ---- the koningsspel: laying away ----

// Lay is how many cards seat must lay away now: in PhaseDiscard on its
// turn, what it holds beyond the hand played; else 0.
func (d *Deal) Lay(seat cards.Seat) int {
	if d.phase != PhaseDiscard || seat != d.turn {
		return 0
	}
	return len(d.hands[seat]) - d.size
}

// Discard lays cards of seat away, face down: exactly Lay(seat) of them.
// In turn from voorhand; after the last, voorhand leads.
func (d *Deal) Discard(seat cards.Seat, cards []cards.Card) error {
	switch {
	case d.phase != PhaseDiscard:
		return ErrWrongPhase
	case seat != d.turn:
		return ErrNotYourTurn
	case len(cards) != d.Lay(seat):
		return fmt.Errorf("Leg precies %d kaarten weg.", d.Lay(seat))
	}
	hand := slices.Clone(d.hands[seat])
	for k, c := range cards {
		if slices.Contains(cards[:k], c) {
			return ErrDiscardTwice
		}
		i := slices.Index(hand, c)
		if i < 0 {
			return ErrNotInHand
		}
		hand = slices.Delete(hand, i, i+1)
	}
	d.hands[seat] = hand
	d.laid[seat] = slices.Clone(cards)
	d.asking = d.asking[1:]
	if len(d.asking) > 0 {
		d.turn = d.asking[0]
		return nil
	}
	d.startPlay()
	return nil
}

// Laid is the cards seat laid away in the koningsspel.
func (d *Deal) Laid(seat cards.Seat) []cards.Card { return slices.Clone(d.laid[seat]) }

// ---- toepen ----

// CanToep reports whether seat may toep now: on its turn to play, unless
// it was the last to toep, stands on armoede, would be out by losing at
// the present stake already, or nobody else could pass on it.
func (d *Deal) CanToep(seat cards.Seat) bool {
	return d.phase == PhasePlay && seat == d.turn && seat != d.toeper && d.inCount() > 1 && d.mayRaise(seat) == nil
}

// mayRaise says why seat may not raise the stake, nil when it may: not on
// armoede, not when losing at the present stake puts it out already, and
// not when everyone else still in would go along anyway (passing would put
// them out): then a raise only puts more at stake for seat itself.
func (d *Deal) mayRaise(seat cards.Seat) error {
	switch {
	case d.armoede[seat]:
		return ErrToepArmoede
	case d.points[seat]+d.stake >= d.rules.Limit:
		return ErrToepDead
	case !slices.ContainsFunc(d.others(seat), func(o cards.Seat) bool { return !d.doomed(o) }):
		return ErrToepPointless
	}
	return nil
}

// doomed reports whether passing would put seat out of the match: it goes
// along with every raise without being asked.
func (d *Deal) doomed(seat cards.Seat) bool {
	return d.points[seat]+d.accepted[seat] >= d.rules.Limit
}

// PassCost is what passing costs seat now: the stake it last agreed to
// (the stake before the first raise it did not go along with).
func (d *Deal) PassCost(seat cards.Seat) int { return d.accepted[seat] }

// AutoStays lists the seats that went along with the last raise without a
// question: passing would have put them out.
func (d *Deal) AutoStays() []cards.Seat { return slices.Clone(d.auto) }

// StockOut reports whether new cards of a vuile was could not be washed
// again this round because the stock ran out.
func (d *Deal) StockOut() bool { return d.stockOut }

// Toep raises the stake by one; the others still in say in turn whether
// they go along (Answer) or toep again (Overtoep). Then seat plays its
// card.
func (d *Deal) Toep(seat cards.Seat) error {
	switch {
	case d.phase != PhasePlay:
		return ErrWrongPhase
	case seat != d.turn:
		return ErrNotYourTurn
	case seat == d.toeper:
		return ErrToepAgain
	}
	if err := d.mayRaise(seat); err != nil {
		return err
	}
	d.raise(seat)
	return nil
}

// raise puts the stake up by one for seat, and asks the others still in;
// who would be out by passing goes along at once.
func (d *Deal) raise(seat cards.Seat) {
	d.stake++
	d.toeper = seat
	d.accepted[seat] = d.stake
	d.toeps = append(d.toeps, Toep{Seat: seat, Tricks: len(d.tricks), Stake: d.stake})
	d.asking, d.auto = nil, nil
	for _, o := range d.others(seat) {
		if d.doomed(o) {
			d.auto = append(d.auto, o)
			d.accepted[o] = d.stake
			d.streak[o] = 0
			continue
		}
		d.asking = append(d.asking, o)
	}
	d.phase = PhaseToep
	d.poorAsk = false
	if len(d.asking) == 0 {
		d.endAsking(false)
		return
	}
	d.turn = d.asking[0]
}

// CanRaise reports whether seat, asked about a toep, may toep again
// (overtoepen): not on armoede's question, and as for CanToep.
func (d *Deal) CanRaise(seat cards.Seat) bool {
	return d.phase == PhaseToep && seat == d.turn && !d.poorAsk && d.mayRaise(seat) == nil
}

// Overtoep is the answer to a toep that raises the stake once more: seat
// goes along, and everyone else still in (the toeper too) is asked again,
// from seat's left. Passing then costs the stake from before this raise.
func (d *Deal) Overtoep(seat cards.Seat) error {
	switch {
	case d.phase != PhaseToep:
		return ErrWrongPhase
	case seat != d.turn:
		return ErrNotYourTurn
	case d.poorAsk:
		return ErrNoRaise
	}
	if err := d.mayRaise(seat); err != nil {
		return err
	}
	d.streak[seat] = 0
	d.raise(seat)
	return nil
}

// MustStay reports whether seat, asked about a toep, may not pass: under
// the anti-lijntoep rule it passed on the last two toeps it was asked
// about (armoede's question does not count).
func (d *Deal) MustStay(seat cards.Seat) bool {
	return d.rules.Lijntoep && d.phase == PhaseToep && !d.poorAsk && d.streak[seat] >= MaxPasses
}

// Answer records whether seat goes along with the toep (stay) or passes:
// it then takes the stake it last agreed to as penalty points (PassCost:
// the stake before the first raise it did not go along with) and sits the
// round out. When everyone else has passed, the one left wins.
func (d *Deal) Answer(seat cards.Seat, stay bool) error {
	if d.phase != PhaseToep {
		return ErrWrongPhase
	}
	if seat != d.turn {
		return ErrNotYourTurn
	}
	if !stay && d.MustStay(seat) {
		return ErrMustStay
	}
	poor := d.poorAsk
	if !poor && stay {
		d.streak[seat] = 0
	} else if !poor {
		d.streak[seat]++
	}
	if stay {
		d.accepted[seat] = d.stake
	} else {
		d.status[seat] = StatusPassed
		d.penalise(seat, d.accepted[seat])
	}
	d.asking = d.asking[1:]
	if len(d.asking) > 0 {
		d.turn = d.asking[0]
		return nil
	}
	d.endAsking(poor)
	return nil
}

// endAsking goes on once everyone asked about a raise (or armoede) has
// answered: the one left wins when everyone else passed; else the play.
func (d *Deal) endAsking(poor bool) {
	d.asking = nil
	if d.inCount() <= 1 {
		w := d.toeper
		if !d.in(w) {
			w = d.fromIn(d.voorhand)
		}
		d.finish(w, false)
		return
	}
	if poor {
		d.startPlay() // armoede: the first card
		return
	}
	d.phase = PhasePlay
	d.advance() // the toeper may have passed on an overtoep: the trick can be complete
}

// ---- tricks ----

// toPlay is the seat to play next to the current trick: the first seat
// still in, from the leader (an empty trick) or after the last card, that
// has not played to it.
func (d *Deal) toPlay() cards.Seat {
	t := &d.current
	s := t.Leader
	if n := len(t.Cards); n > 0 {
		s = d.next(t.Cards[n-1].Seat)
	}
	for range d.players {
		if d.status[s] == StatusIn && !t.Played(s) {
			return s
		}
		s = d.next(s)
	}
	return cards.NoSeat
}

// Play puts card c of seat into the trick. When every seat still in has
// played, the highest card of the suit led takes the trick and leads the
// next; the last trick wins the round, and every other seat still in takes
// the stake as penalty points.
func (d *Deal) Play(seat cards.Seat, c cards.Card) error {
	if d.phase != PhasePlay {
		return ErrWrongPhase
	}
	if seat != d.turn {
		return ErrNotYourTurn
	}
	hand := d.hands[seat]
	k := slices.Index(hand, c)
	if k < 0 {
		return ErrNotInHand
	}
	if !IsLegal(c, hand, d.current) {
		return &IllegalError{Card: c, Reason: ExplainIllegal(c, hand, d.current)}
	}
	if len(d.current.Cards) == 0 {
		d.current.Leader = seat
	}
	d.hands[seat] = slices.Delete(slices.Clone(hand), k, k+1)
	d.current.Cards = append(d.current.Cards, cards.Played{Seat: seat, Card: c})
	d.advance()
	return nil
}

// advance moves on after a card, or an answer: the turn goes to the next
// seat to play to the trick; when every seat still in has played, the
// trick is taken and its winner leads the next, or wins the round.
func (d *Deal) advance() {
	if next := d.toPlay(); next != cards.NoSeat {
		d.turn = next
		return
	}
	t := d.current
	t.Winner, _ = t.Winning(d.in)
	d.tricks = append(d.tricks, t)
	if len(d.hands[t.Winner]) == 0 {
		d.finish(t.Winner, true)
		return
	}
	d.current = Trick{Leader: t.Winner, Winner: cards.NoSeat}
	d.turn = t.Winner
}

// finish ends the round with winner; after the last trick every other
// seat still in takes the stake, and a winner who took it with a boer
// (rule Boer) has a penalty point taken off, if it has one.
func (d *Deal) finish(winner cards.Seat, tricks bool) {
	boer := false
	if tricks {
		for s := range cards.Seat(d.players) {
			if s != winner && d.status[s] == StatusIn {
				d.penalise(s, d.stake)
			}
		}
		last := d.tricks[len(d.tricks)-1]
		for _, p := range last.Cards {
			boer = boer || d.rules.Boer && p.Seat == winner && p.Card.Rank == cards.Jack
		}
		if boer && d.points[winner] > 0 {
			d.points[winner]--
		}
	}
	res := &Result{
		Winner: winner, Stake: d.stake, Tricks: tricks, Boer: boer, Koning: d.koning,
		Gains: make([]int, d.players), Points: make([]int, d.players), Out: make([]bool, d.players),
	}
	for s := range d.players {
		res.Gains[s] = d.points[s] - d.start[s]
		res.Points[s] = d.points[s]
		res.Out[s] = d.points[s] >= d.rules.Limit
	}
	d.result = res
	d.phase = PhaseDone
	d.turn = cards.NoSeat
	d.asking = nil
}

// ---- accessors ----

func (d *Deal) Players() int         { return d.players }
func (d *Deal) Rules() Rules         { return d.rules }
func (d *Deal) Phase() Phase         { return d.phase }
func (d *Deal) Dealer() cards.Seat   { return d.dealer }
func (d *Deal) Voorhand() cards.Seat { return d.voorhand }
func (d *Deal) Stake() int           { return d.stake }

// FirstLeader is the seat to lead the first trick, as things stand before
// its first card: who stands on armoede and is still in the round, the
// first of them from voorhand when there are more; else the first seat
// still in from voorhand. In the koningsspel everyone is on armoede, so
// voorhand leads. It can change before the first card: a seat on armoede
// that checks a genuine was is out.
func (d *Deal) FirstLeader() cards.Seat {
	for k, s := 0, d.voorhand; k < d.players; k, s = k+1, d.next(s) {
		if d.armoede[s] && d.status[s] == StatusIn {
			return s
		}
	}
	return d.fromIn(d.voorhand)
}

// Toeper is the last seat to toep, NoSeat before anyone did.
func (d *Deal) Toeper() cards.Seat { return d.toeper }

// Toeps lists the raises of the stake, in order (not the one for armoede).
func (d *Deal) Toeps() []Toep { return slices.Clone(d.toeps) }

// ArmoedeToep reports whether the stake went up for armoede.
func (d *Deal) ArmoedeToep() bool { return d.armoedeT }

// Turn is whose answer or card is awaited; NoSeat in PhaseWas, when
// everyone answers at once, and when the round is done.
func (d *Deal) Turn() cards.Seat { return d.turn }

// Hand is the cards seat holds now.
func (d *Deal) Hand(seat cards.Seat) []cards.Card { return slices.Clone(d.hands[seat]) }

// HandLen is the number of cards seat holds; 0 once it is out of the round.
func (d *Deal) HandLen(seat cards.Seat) int {
	if d.status[seat] != StatusIn {
		return 0
	}
	return len(d.hands[seat])
}

// Dealt is the hand seat was dealt, before any was.
func (d *Deal) Dealt(seat cards.Seat) []cards.Card {
	if d.washed[seat] {
		return slices.Clone(d.given[seat][:HandSize])
	}
	h := append(slices.Clone(d.hands[seat]), d.laid[seat]...)
	for _, t := range d.tricks {
		for _, p := range t.Cards {
			if p.Seat == seat {
				h = append(h, p.Card)
			}
		}
	}
	for _, p := range d.current.Cards {
		if p.Seat == seat {
			h = append(h, p.Card)
		}
	}
	return h
}

// Legal is the cards the seat on turn may play (PhasePlay), else nil.
func (d *Deal) Legal() []cards.Card {
	if d.phase != PhasePlay || d.turn == cards.NoSeat {
		return nil
	}
	return Legal(d.hands[d.turn], d.current)
}

// Constraint is the rule for the seat on turn, for its screen.
func (d *Deal) Constraint() string {
	if d.phase != PhasePlay || d.turn == cards.NoSeat {
		return ""
	}
	return Constraint(d.hands[d.turn], d.current)
}

// Koning reports whether this round is the koningsspel.
func (d *Deal) Koning() bool { return d.koning }

// Size is the number of cards each plays with: four, or eight in the
// koningsspel; DealtSize what each was dealt (eleven in the koningsspel).
func (d *Deal) Size() int      { return d.size }
func (d *Deal) DealtSize() int { return d.dealt }

// WasRound is the time for a was this is or was last: 1, then one more
// each time a claim got new cards and may be washed again; 0 without one.
func (d *Deal) WasRound() int { return d.window }

// Open reports whether seat plays with its cards face up: it was caught
// bluffing a was (rule Bluf).
func (d *Deal) Open(seat cards.Seat) bool { return d.open[seat] && d.status[seat] == StatusIn }

// Streak is how often seat passed on a toep in a row (anti-lijntoep).
func (d *Deal) Streak(seat cards.Seat) int { return d.streak[seat] }

func (d *Deal) Status(seat cards.Seat) Status { return d.status[seat] }
func (d *Deal) Points(seat cards.Seat) int    { return d.points[seat] }
func (d *Deal) Armoede(seat cards.Seat) bool  { return d.armoede[seat] }
func (d *Deal) Washed(seat cards.Seat) bool   { return d.washed[seat] }

// Claimed reports whether seat claimed a was; only told once the time for
// it is over (a claim stays secret until everyone answered).
func (d *Deal) Claimed(seat cards.Seat) bool { return d.phase != PhaseWas && d.claimed[seat] }

// Checks lists the settled claims, in order.
func (d *Deal) Checks() []Check { return slices.Clone(d.checks) }

// Stock is the number of cards left for a was.
func (d *Deal) Stock() int { return len(d.stock) }

// Current is the trick being played (empty right after one was taken).
func (d *Deal) Current() Trick {
	t := d.current
	t.Cards = slices.Clone(t.Cards)
	return t
}

// Tricks are the completed tricks, in order.
func (d *Deal) Tricks() []Trick { return slices.Clone(d.tricks) }

// Asking lists the seats still to answer the question in turn (PhaseCheck,
// PhaseToep), the one on turn first.
func (d *Deal) Asking() []cards.Seat { return slices.Clone(d.asking) }

// Result is how the round ended; nil before PhaseDone.
func (d *Deal) Result() *Result { return d.result }

// Clone is an independent copy.
func (d *Deal) Clone() *Deal {
	c := *d
	for s := range d.hands {
		c.hands[s] = slices.Clone(d.hands[s])
		c.given[s] = slices.Clone(d.given[s])
		c.laid[s] = slices.Clone(d.laid[s])
	}
	c.auto = slices.Clone(d.auto)
	c.stock = slices.Clone(d.stock)
	c.claims = slices.Clone(d.claims)
	c.checks = slices.Clone(d.checks)
	c.asking = slices.Clone(d.asking)
	c.toeps = slices.Clone(d.toeps)
	c.current.Cards = slices.Clone(d.current.Cards)
	c.tricks = slices.Clone(d.tricks)
	if d.result != nil {
		r := *d.result
		c.result = &r
	}
	return &c
}
