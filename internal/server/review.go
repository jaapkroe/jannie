package server

import (
	"cmp"
	"fmt"
	"math"
	"runtime"
	"slices"
	"sync/atomic"

	"klaverjas/internal/game"
)

// The review (design §9 Spelanalyse) grades every decision a human makes
// with a choice, in the background, and shows the result to that player
// alone when the match is over.

const (
	riskyNat     = 0.4 // a bid to play with a higher chance of nat is listed as risky
	reviewListed = 3   // moments listed per kind
)

// gradeSlots is how many analyses run at once over all rooms; each takes
// one core.
func gradeSlots() int { return max(1, runtime.GOMAXPROCS(0)/4) }

// analyse runs f in one of the server's analysis slots, unless stale says,
// once a slot is free, that nobody needs it any more. A panic is logged.
func (s *Server) analyse(stale func() bool, f func()) {
	s.grading <- struct{}{}
	defer func() {
		<-s.grading
		if p := recover(); p != nil {
			s.log.Error("analysis panicked", "panic", fmt.Sprint(p))
		}
	}()
	if !stale() {
		f()
	}
}

// review collects the analysis of one human's play in a match. Grades come
// in from the background; pending counts those still out.
type review struct {
	pending int         // analyses still out
	grading int         // of which grades of choices
	stale   atomic.Bool // the match is over (written by the room, read by the analyses)

	hands int     // hands dealt to the player
	luck  float64 // summed HandLuck of those hands

	choices int // decisions with more than one option
	stake   float64
	lost    float64

	leads, leadsBest   int
	trumps, trumpsBest int // trump choices and bids

	roem, roemTimes int // roem given to the opponents
	roemAt          int // what the player's card gives if the opponents take the current trick

	risky          []int // hands with a bid to play at more than riskyNat chance of nat
	missed, strong []moment
}

// moment is a decision named in the review: points left against the
// better option, or a strong move.
type moment struct {
	Hand   int         `json:"hand"`
	Trick  int         `json:"trick"` // 1–8; 0 for a trump choice or bid
	Played choiceJSON  `json:"played"`
	Better *choiceJSON `json:"better,omitempty"`
	Points int         `json:"points"`
	Why    string      `json:"why"`             // the reason of the hint, or "" when it cannot be cut out
	Text   string      `json:"text"`            // the whole hint
	Cards  []game.Card `json:"cards,omitempty"` // a trump choice or bid: the player's hand
	Table  *game.Trick `json:"table,omitempty"` // a card: the trick it went into
}

type choiceJSON struct {
	Card *game.Card `json:"card,omitempty"`
	Suit *game.Suit `json:"suit,omitempty"`
	Play *bool      `json:"play,omitempty"`
}

// reviewState is the review for the player of a state (design §7).
type reviewState struct {
	ID      string   `json:"id"` // the match, for the history kept on the device
	Pending bool     `json:"pending"`
	Pct     int      `json:"pct"`
	Hands   int      `json:"hands"`
	Choices int      `json:"choices"`
	Luck    int      `json:"luck"` // points per hand against an average hand
	Lost    int      `json:"lost"`
	LostN   int      `json:"lostN"`
	StrongN int      `json:"strongN"`
	Leads   [2]int   `json:"leads"`  // best, of
	Trumps  [2]int   `json:"trumps"` // best, of
	Roem    [2]int   `json:"roem"`   // points, times
	Risky   [2]int   `json:"risky"`  // bids, of which nat
	Strong  []moment `json:"strong"`
	Missed  []moment `json:"missed"`
}

// reviewOf returns the review of human seat i, started when needed (a
// player who joined during the match).
func (r *room) reviewOf(i game.Seat) *review {
	st := &r.seats[i]
	if st.review == nil {
		st.review = &review{}
	}
	return st.review
}

// startReviews starts a review for every human at the start of a match.
func (r *room) startReviews() {
	r.matchID = newToken()[:12]
	r.handTricks = nil
	for i := range r.seats {
		if rv := r.seats[i].review; rv != nil {
			rv.stale.Store(true)
		}
		r.seats[i].review = nil
		if r.seats[i].kind == seatHuman {
			r.seats[i].review = &review{}
		}
	}
}

// gradeHands measures, in the background, what the cards just dealt are
// worth to each human.
func (r *room) gradeHands() {
	for k := range r.seats {
		i := game.Seat(k)
		if r.seats[i].kind != seatHuman {
			continue
		}
		rv, v := r.reviewOf(i), r.viewFor(i)
		rv.roemAt = 0
		rv.pending++
		go func() {
			var luck float64
			r.srv.analyse(rv.staleIn(r), func() { luck = r.srv.cfg.AI.HandLuck(v) })
			r.post(func() {
				rv.pending--
				rv.hands++
				rv.luck += luck
				r.reviewDone(i, rv)
			})
		}()
	}
}

// beforeChoice returns the view seat i decides action a on, when it is
// their turn, and notes the roem their card would give.
func (r *room) beforeChoice(i game.Seat, a action) (game.View, bool) {
	if r.pending != stepNone || r.deal == nil || r.deal.Turn() != i {
		return game.View{}, false
	}
	v := r.viewFor(i)
	if a.kind == actPlay {
		r.reviewOf(i).roemAt = roemAdded(&v, a.card)
	}
	return v, true
}

// roemAdded is the roem card c adds to the cards on the table in v, beyond
// the least that a legal card adds.
func roemAdded(v *game.View, c game.Card) int {
	cards := make([]game.Card, 0, 4)
	for _, p := range v.Current.Cards {
		cards = append(cards, p.Card)
	}
	n := len(cards)
	with := func(x game.Card) int { return game.RoemPoints(append(cards[:n], x), v.Trump) }
	least := with(c)
	for _, l := range v.Legal {
		least = min(least, with(l))
	}
	return with(c) - least
}

// gradeChoice grades action a of seat i, decided in view v, in the
// background, when the player had a choice.
func (r *room) gradeChoice(i game.Seat, v game.View, a action) {
	var c Choice
	switch a.kind {
	case actPlay:
		if len(v.Legal) < 2 {
			return
		}
		c.Card = &a.card
	case actTrump:
		c.Suit = &a.suit
	case actBid:
		c.Play = &a.play
	}
	rv := r.reviewOf(i)
	rv.pending++
	rv.grading++
	go func() {
		var g Grade
		r.srv.analyse(rv.staleIn(r), func() { g = r.srv.cfg.AI.Grade(v, c) })
		r.post(func() {
			rv.pending--
			rv.grading--
			rv.add(&v, c, g)
			r.reviewDone(i, rv)
		})
	}()
}

// staleIn reports whether rv's analyses are no longer needed in room r:
// a new match started, or the room was closed.
func (rv *review) staleIn(r *room) func() bool {
	return func() bool {
		select {
		case <-r.done:
			return true
		default:
			return rv.stale.Load()
		}
	}
}

// reviewTrick books the roem that the humans' own cards gave the
// opponents in trick t, just completed.
func (r *room) reviewTrick(t game.Trick) {
	for i := range r.seats {
		rv := r.seats[i].review
		if rv == nil || rv.roemAt == 0 {
			continue
		}
		if t.Winner.Team() != game.Seat(i).Team() {
			rv.roem += rv.roemAt
			rv.roemTimes++
		}
		rv.roemAt = 0
	}
}

// reviewDone sends a finished review to its player once the last grade is
// in after the match ended.
func (r *room) reviewDone(i game.Seat, rv *review) {
	st := &r.seats[i]
	if rv.pending == 0 && r.phase == phaseGameOver && st.review == rv && st.client != nil {
		r.resync(st.client, i)
	}
}

// add books grade g of choice c, decided in view v.
func (rv *review) add(v *game.View, c Choice, g Grade) {
	rv.choices++
	rv.stake += g.Stake
	rv.lost += g.Lost
	m := moment{Hand: v.HandNo, Played: choiceJSON(c)}
	if c.Card != nil {
		m.Trick = len(v.Tricks) + 1
		if len(v.Current.Cards) == 0 {
			rv.leads++
			if g.Lost == 0 {
				rv.leadsBest++
			}
		}
	} else {
		m.Cards = game.SortHand(v.Hand, v.Trump, v.TrumpKnown)
		rv.trumps++
		if g.Lost == 0 {
			rv.trumpsBest++
		}
		if c.Play != nil && *c.Play && g.Nat > riskyNat {
			rv.risky = append(rv.risky, v.HandNo)
		}
	}
	h := hint{Card: c.Card, Suit: c.Suit, Play: c.Play, Text: g.Text}
	switch {
	case g.Lost > 0:
		better := choiceJSON(g.Better)
		m.Better = &better
		h = hint{Card: better.Card, Suit: better.Suit, Play: better.Play, Text: g.Text}
		m.Points = int(math.Round(g.Lost))
	case g.Gain > 0:
		m.Points = int(math.Round(g.Gain))
	default:
		return
	}
	if _, why, ok := splitHint(&h); ok {
		m.Why = why
	}
	m.Text = g.Text
	if g.Lost > 0 {
		rv.missed = append(rv.missed, m)
	} else {
		rv.strong = append(rv.strong, m)
	}
}

// reviewFor is the review for the player at seat i once the match is over,
// or nil.
func (r *room) reviewFor(i game.Seat) *reviewState {
	rv := r.seats[i].review
	if r.phase != phaseGameOver || rv == nil || (rv.choices == 0 && rv.grading == 0) {
		return nil
	}
	out := &reviewState{ID: r.matchID, Pending: rv.pending > 0}
	if out.Pending {
		return out
	}
	out.Pct = 100
	if rv.stake > 0 {
		out.Pct = min(100, max(0, int(math.Round(100*(1-rv.lost/rv.stake)))))
	}
	out.Hands, out.Choices = rv.hands, rv.choices
	if rv.hands > 0 {
		out.Luck = int(math.Round(rv.luck / float64(rv.hands)))
	}
	out.Lost, out.LostN, out.StrongN = int(math.Round(rv.lost)), len(rv.missed), len(rv.strong)
	out.Leads = [2]int{rv.leadsBest, rv.leads}
	out.Trumps = [2]int{rv.trumpsBest, rv.trumps}
	out.Roem = [2]int{rv.roem, rv.roemTimes}
	for _, h := range rv.risky {
		out.Risky[0]++
		for _, row := range r.scores {
			if row.Hand == h && row.Nat && row.PlayingTeam == i.Team() {
				out.Risky[1]++
			}
		}
	}
	out.Strong, out.Missed = r.listed(rv.strong), r.listed(rv.missed)
	return out
}

// listed picks the moments with the most points, in the order they were
// played, each with the trick its card went into.
func (r *room) listed(all []moment) []moment {
	out := append(make([]moment, 0, len(all)), all...) // never nil: [] on the wire
	slices.SortStableFunc(out, func(a, b moment) int { return cmp.Compare(b.Points, a.Points) })
	out = out[:min(len(out), reviewListed)]
	slices.SortStableFunc(out, func(a, b moment) int {
		return cmp.Or(cmp.Compare(a.Hand, b.Hand), cmp.Compare(a.Trick, b.Trick))
	})
	for k := range out {
		m := &out[k]
		if m.Trick > 0 && m.Hand-1 < len(r.handTricks) && m.Trick-1 < len(r.handTricks[m.Hand-1]) {
			t := r.handTricks[m.Hand-1][m.Trick-1]
			m.Table = &t
		}
	}
	return out
}
