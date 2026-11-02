package toepenserver

import (
	"slices"
	"time"

	"klaverjas/internal/game"
	"klaverjas/internal/server"
	"klaverjas/internal/toepen"
)

// state is the full per-seat state `s` of an update (design §11): the
// table's keys (server.Shared: code, phase, opts, you, host, roster in the
// lobby, players, turn, takeover, nextAt) and toepen's. nextAt is also
// the end of the time for a was.
type state struct {
	server.Shared
	Winner int `json:"winner"` // game over: the seat left

	HandNo      int             `json:"handNo"` // the round
	Dealer      int             `json:"dealer"`
	Voorhand    int             `json:"voorhand"`
	Stake       int             `json:"stake"`
	Toeper      int             `json:"toeper"`      // the last to toep this round, -1
	ArmoedeToep bool            `json:"armoedeToep"` // the stake went up for armoede
	Koning      bool            `json:"koning"`      // the koningsspel: eight cards each, the last trick wins the match
	Size        int             `json:"size"`        // cards each plays with this round (8 in the koningsspel)
	Lay         int             `json:"lay"`         // the koningsspel, your turn: how many cards you lay away
	Laid        []int           `json:"laid"`        // the koningsspel: per seat, how many cards it laid away
	WasRound    int             `json:"wasRound"`    // the time for a was: 1, more when new cards may be washed again
	CanRaise    bool            `json:"canRaise"`    // asked about a toep: you may toep again (overtoep)
	MustStay    bool            `json:"mustStay"`    // asked about a toep: you may not pass (anti-lijntoep)
	Points      []int           `json:"points"`      // penalty points, now
	Status      []toepen.Status `json:"status"`      // per seat this round: in, gepast, betrapt, eruit, uit
	Armoede     []bool          `json:"armoede"`     // per seat: one point from out this round
	Washed      []bool          `json:"washed"`      // got four new cards for a was
	Open        [][]game.Card   `json:"open"`        // per seat: its hand when played face up (a bluff caught), else empty
	Answered    []bool          `json:"answered"`    // the time for a was: who said whether they have one
	Claims      []bool          `json:"claims"`      // who claimed a was (once that time is over)
	CanClaim    bool            `json:"canClaim"`    // you may still claim a was
	Claimant    int             `json:"claimant"`    // check: whose was is asked about, -1
	Asking      []int           `json:"asking"`      // check, toep: who still answers, in order
	Checks      []toepen.Check  `json:"checks"`      // the claims settled this round
	Stock       int             `json:"stock"`
	Hand        []game.Card     `json:"hand"` // yours, display-sorted
	Legal       []game.Card     `json:"legal,omitempty"`
	Rule        string          `json:"rule,omitempty"`
	CanToep     bool            `json:"canToep"`
	Trick       *toepen.Trick   `json:"trick"`
	LastTrick   *toepen.Trick   `json:"lastTrick"`
	Tricks      int             `json:"tricks"` // taken this round
	Rounds      []round         `json:"rounds"` // the score sheet
}

// round is one line of the score sheet: how a round ended.
type round struct {
	Hand   int       `json:"hand"`
	Dealer game.Seat `json:"dealer"`
	Winner game.Seat `json:"winner"`
	Stake  int       `json:"stake"`
	Tricks bool      `json:"tricks"` // won with the last trick, else everyone else passed or sat out
	Boer   bool      `json:"boer"`   // the last trick taken with a boer: the winner had a point off (if any)
	Koning bool      `json:"koning"` // the koningsspel
	Gains  []int     `json:"gains"`  // penalty points this round, per seat (-1: the boer)
	Points []int     `json:"points"` // after it
	Out    []bool    `json:"out"`    // out of the match after it
}

func (p *play) State(i game.Seat) any {
	t := p.t
	n := t.Players()
	s := &state{
		Shared: t.Shared(i), Winner: -1, HandNo: p.handNo,
		Dealer: -1, Voorhand: -1, Toeper: -1, Claimant: -1,
		Points: make([]int, n), Status: make([]toepen.Status, n), Armoede: make([]bool, n),
		Washed: make([]bool, n), Answered: make([]bool, n), Claims: make([]bool, n), Open: make([][]game.Card, n),
		Laid:   make([]int, n),
		Asking: []int{}, Checks: []toepen.Check{}, Hand: []game.Card{}, Rounds: nonNil(p.rounds),
	}
	for k := range s.Open {
		s.Open[k] = []game.Card{}
	}
	if p.m != nil {
		copy(s.Points, p.m.Points[:n])
	}
	switch s.Phase {
	case "lobby":
		return s
	case "gameOver":
		s.Winner = p.winner
	}
	d := p.d
	if d == nil {
		return s
	}
	s.Dealer, s.Voorhand, s.Stake = int(d.Dealer()), int(d.Voorhand()), d.Stake()
	s.Toeper, s.ArmoedeToep = int(d.Toeper()), d.ArmoedeToep()
	s.Koning, s.Size, s.WasRound = d.Koning(), d.Size(), d.WasRound()
	s.Checks = nonNil(d.Checks())
	s.Stock = d.Stock()
	s.Tricks = len(d.Tricks())
	for k := range game.Seat(n) {
		s.Points[k] = d.Points(k)
		s.Status[k] = d.Status(k)
		s.Armoede[k] = d.Armoede(k)
		s.Washed[k] = d.Washed(k)
		s.Answered[k] = d.Answered(k)
		s.Claims[k] = d.Claimed(k)
		s.Laid[k] = len(d.Laid(k))
	}
	if ts := d.Tricks(); len(ts) > 0 {
		last := ts[len(ts)-1]
		s.LastTrick = &last
	}
	if !t.InHand() {
		return s
	}
	if d.Status(i) == toepen.StatusIn {
		s.Hand = toepen.SortHand(d.Hand(i))
	}
	for k := range game.Seat(n) {
		if d.Open(k) {
			s.Open[k] = toepen.SortHand(d.Hand(k))
		}
	}
	if c := d.Claimant(); c != game.NoSeat {
		s.Claimant = int(c)
	}
	for _, a := range d.Asking() {
		s.Asking = append(s.Asking, int(a))
	}
	if t.Pending() == stepWas {
		s.NextAt = t.PauseEnds().UnixMilli() // the end of the time for a was
		s.CanClaim = d.CanClaim(i)
	}
	if s.Phase == phasePlay || s.Phase == phaseToep {
		s.Trick = p.shownTrick()
	}
	if s.Turn == int(i) && d.Phase() == toepen.PhasePlay {
		legal := d.Legal()
		s.Legal = make([]game.Card, 0, len(legal))
		for _, c := range s.Hand {
			if slices.Contains(legal, c) {
				s.Legal = append(s.Legal, c)
			}
		}
		s.Rule = d.Constraint()
		s.CanToep = d.CanToep(i)
	}
	if s.Turn == int(i) && d.Phase() == toepen.PhaseDiscard {
		s.Lay = d.Lay(i)
	}
	if s.Turn == int(i) && d.Phase() == toepen.PhaseToep {
		s.CanRaise, s.MustStay = d.CanRaise(i), d.MustStay(i)
	}
	return s
}

// shownTrick is the trick on the table: the one just taken until it is
// collected, then the one being played.
func (p *play) shownTrick() *toepen.Trick {
	if p.last != nil && !p.collected {
		tr := *p.last
		return &tr
	}
	tr := p.d.Current()
	if len(tr.Cards) == 0 && len(p.d.Tricks()) == 0 && p.d.Phase() != toepen.PhasePlay {
		tr.Leader = p.d.Voorhand() // armoede: nobody has led yet
	}
	if tr.Cards == nil {
		tr.Cards = []game.Played{}
	}
	return &tr
}

// ---- events (ev.type) ----

type evDeal struct {
	Type   string    `json:"type"` // "deal"
	HandNo int       `json:"handNo"`
	Dealer game.Seat `json:"dealer"`
	Koning bool      `json:"koning"` // the koningsspel
}

// evClaims: the time for a was is over and these seats claimed one.
type evClaims struct {
	Type  string      `json:"type"` // "claims"
	Seats []game.Seat `json:"seats"`
}

// evCheck: seat, asked about the was of claimant, checks it or not.
type evCheck struct {
	Type     string    `json:"type"` // "check"
	Seat     game.Seat `json:"seat"`
	Claimant game.Seat `json:"claimant"`
	Check    bool      `json:"check"`
}

// evWasDone: a claimed was is settled. Checked (checker not -1), the hand
// is shown and someone takes a point; shown (on armoede), it was laid
// open without a question; washed: the claimant handed it in for four new
// cards.
type evWasDone struct {
	Type     string         `json:"type"` // "wasDone"
	Claimant game.Seat      `json:"claimant"`
	Checker  game.Seat      `json:"checker"`
	Kind     toepen.WasKind `json:"kind"`
	Cards    []game.Card    `json:"cards"`
	Genuine  bool           `json:"genuine"`
	Washed   bool           `json:"washed"`
	Shown    bool           `json:"shown"`
}

// evToep: seat raised the stake to stake, on its turn, or as the answer
// to a toep (over: an overtoep).
// evDiscard: in the koningsspel seat laid n cards away, face down.
type evDiscard struct {
	Type string    `json:"type"` // "discard"
	Seat game.Seat `json:"seat"`
	N    int       `json:"n"`
}

type evToep struct {
	Type  string    `json:"type"` // "toep"
	Seat  game.Seat `json:"seat"`
	Stake int       `json:"stake"`
	Over  bool      `json:"over"`
}

// evAnswer: seat goes along with the toep (stay), or passes and takes
// points.
type evAnswer struct {
	Type   string    `json:"type"` // "answer"
	Seat   game.Seat `json:"seat"`
	Stay   bool      `json:"stay"`
	Points int       `json:"points"`
}

// evArmoede: these seats are one point from out; the stake starts at
// stake.
type evArmoede struct {
	Type  string      `json:"type"` // "armoede"
	Seats []game.Seat `json:"seats"`
	Stake int         `json:"stake"`
}

type evPlay struct {
	Type string    `json:"type"` // "play"
	Seat game.Seat `json:"seat"`
	Card game.Card `json:"card"`
}

type evTrick struct {
	Type   string    `json:"type"` // "trick"
	Winner game.Seat `json:"winner"`
	Last   bool      `json:"last"`
}

type evCollect struct {
	Type   string    `json:"type"` // "collect"
	Winner game.Seat `json:"winner"`
}

type evRound struct {
	Type   string `json:"type"` // "handEnd"
	Result round  `json:"result"`
}

// ---- the game log ----

// logRound is a round of toepen in the game log (design §11): the cards as
// dealt per seat ("" for a seat out of the match), the decisions (act) and
// how it ended.
type logRound struct {
	T      string    `json:"t"` // "round"
	Match  string    `json:"match"`
	At     time.Time `json:"at"`
	Hand   int       `json:"hand"`
	Dealer game.Seat `json:"dealer"`
	Cards  []string  `json:"cards"`
	Acts   string    `json:"acts"`
	Result round     `json:"result"`
}

func (p *play) logRound(row round) {
	rec := logRound{T: "round", Match: p.t.MatchID(), At: time.Now().UTC(), Hand: p.handNo, Dealer: row.Dealer,
		Acts: p.acts, Result: row}
	for s := range p.t.Players() {
		rec.Cards = append(rec.Cards, cardsString(p.d.Dealt(game.Seat(s))))
	}
	p.t.Log(rec)
}

// cardsString is cards as one compact string: "7SAS9H".
func cardsString(cards []game.Card) string {
	b := make([]byte, 0, 2*len(cards))
	for _, c := range cards {
		b = append(b, c.String()...)
	}
	return string(b)
}
