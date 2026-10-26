package server

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"klaverjas/internal/game"
)

// The expert mode (design §6 Expert mode), reached by an easter egg on the
// home screen: alone against three bots, with the cards of a seed, the
// whole match or one hand of it (option from). While the match runs and
// after it, the expert looks back at every card of a hand (the state's
// expert.hands), asks the engine's reasoning for the decision of any seat
// (why), gives their own choice for it (mark) and comments on it
// (feedback). Marks and comments go to the game log.

// Limits on what the expert adds to a match.
const (
	maxExpertMarks    = 500
	maxExpertFeedback = 200
)

// markKey names a decision of the match: hand, trick (0: the seat's last
// decision before the first card) and seat.
type markKey struct {
	hand, trick int
	seat        game.Seat
}

// markJSON is the expert's own choice for the decision of Seat in hand
// Hand, trick Trick (0: its trump choice or bid): one of card, suit or
// play.
type markJSON struct {
	Hand  int       `json:"hand"`
	Trick int       `json:"trick"`
	Seat  game.Seat `json:"seat"`
	choiceJSON
}

// preJSON is a decision before the first card: a bid (play) or a trump
// choice (suit).
type preJSON struct {
	Seat game.Seat `json:"seat"`
	choiceJSON
}

// expertState is the expert part of the state (design §7).
type expertState struct {
	Hands []replayHand `json:"hands"` // the hand in play (or just played); at game over every hand of the match
	Marks []markJSON   `json:"marks"`
}

// expertOpts keeps option from to expert rooms, in a match long enough to
// number its hand.
func (r *room) expertOpts() {
	if !r.expert {
		r.opts.From = 0
		return
	}
	for r.opts.Hands < r.opts.From {
		r.opts.Hands += 4
	}
}

// expertFor is the expert state, nil outside an expert match.
func (r *room) expertFor() *expertState {
	if !r.expert || r.phase == phaseLobby {
		return nil
	}
	out := &expertState{Hands: []replayHand{}, Marks: make([]markJSON, 0, len(r.marks))}
	switch {
	case r.phase == phaseGameOver:
		out.Hands = r.replay()
	case r.deal != nil:
		out.Hands = append(out.Hands, r.handReplay(r.handNo))
	}
	for k, m := range r.marks {
		out.Marks = append(out.Marks, markJSON{Hand: k.hand, Trick: k.trick, Seat: k.seat, choiceJSON: m})
	}
	slices.SortFunc(out.Marks, func(a, b markJSON) int {
		return cmp.Or(cmp.Compare(a.Hand, b.Hand), cmp.Compare(a.Trick, b.Trick), cmp.Compare(a.Seat, b.Seat))
	})
	return out
}

// handData is hand h (its number) of the match as dealt and its decisions
// so far, as tokens (actToken): a finished hand or the one in play.
func (r *room) handData(h int) (dealtCards, []string, bool) {
	if k := h - r.firstHand; k >= 0 && k < len(r.handDealt) {
		return r.handDealt[k], strings.Fields(r.handActs[k]), true
	}
	if h == r.handNo && r.deal != nil && r.inHand() {
		return r.dealt, strings.Fields(r.acts), true
	}
	return dealtCards{}, nil, false
}

// dealOf starts the deal of cards dc.
func (r *room) dealOf(dc dealtCards) *game.Deal {
	return game.NewDealFor(r.players(), dc.dealer, dc.hands, dc.talon, r.opts.TrumpMode, r.opts.Rules, dc.turned)
}

// handReplay is hand h as the replay shows it (design §7): the cards as
// dealt, sorted under its trump, and the tricks so far, the one in
// progress included. In an expert match also the decisions before the
// first card and, per card played, the cards its player could play.
func (r *room) handReplay(h int) replayHand {
	dc, acts, _ := r.handData(h)
	d := r.dealOf(dc)
	out := replayHand{Hand: h}
	for _, tok := range acts {
		seat, a, err := parseAct(tok)
		if err != nil {
			break
		}
		if r.expert {
			if a.kind == actPlay {
				out.Legal = append(out.Legal, d.Legal())
			} else {
				out.Pre = append(out.Pre, preJSON{Seat: seat, choiceJSON: choiceOf(a)})
			}
		}
		if applyAct(d, seat, a) != nil {
			break
		}
	}
	trump, known := d.Trump()
	for s := range r.players() {
		out.Cards[s] = game.SortHand(dc.hands[s], trump, known)
	}
	out.Tricks = d.Tricks()
	if cur := d.Current(); len(cur.Cards) > 0 && len(cur.Cards) < r.players() {
		out.Tricks = append(out.Tricks, cur)
	}
	return out
}

// decision finds the decision of seat in trick t (1–8; 0: the seat's last
// decision before the first card) of hand h, and rebuilds the deal up to
// it. done is what was decided, or nil for the decision awaited now: the
// hand in play, the seat's turn. ok is false when there is no such
// decision (yet).
func (r *room) decision(h, t int, seat game.Seat) (d *game.Deal, done *action, ok bool) {
	dc, acts, found := r.handData(h)
	if !found || !seat.ValidFor(r.players()) || t < 0 || t > 8 {
		return nil, nil, false
	}
	at, cards := -1, 0
	for k, tok := range acts {
		s, a, err := parseAct(tok)
		if err != nil {
			return nil, nil, false
		}
		switch {
		case a.kind == actPlay:
			if s == seat && cards/r.players()+1 == t {
				at = k
			}
			cards++
		case t == 0 && s == seat:
			at = k
		}
	}
	d = r.dealOf(dc)
	upTo := acts
	if at >= 0 {
		upTo = acts[:at]
	}
	for _, tok := range upTo {
		s, a, _ := parseAct(tok)
		if applyAct(d, s, a) != nil {
			return nil, nil, false
		}
	}
	if at >= 0 {
		_, a, _ := parseAct(acts[at])
		return d, &a, true
	}
	play := d.Phase() == game.PhasePlay
	now := h == r.handNo && r.inHand() && d.Turn() == seat && (t == 0) != play && (t == 0 || cards/r.players()+1 == t)
	return d, nil, now
}

// matchView is what seat knew in deal d, a moment of hand h, with the
// match fields filled in as viewFor does.
func (r *room) matchView(d *game.Deal, seat game.Seat, h int) game.View {
	v := d.View(seat)
	v.HandNo, v.HandsTotal = h, r.opts.Hands
	v.MatchScore = make([]int, len(r.total))
	for _, row := range r.scores {
		if row.Hand < h {
			for k, g := range row.Gains {
				v.MatchScore[k] += g
			}
		}
	}
	sig := r.opts.Signals
	v.Signals = &sig
	return v
}

// decisionArgs reads the decision a mark, why or feedback is about: hand,
// trick and seat (the sender's own when left out).
func decisionArgs(i game.Seat, m *inMsg) (h, t int, seat game.Seat, ok bool) {
	if m.Hand == nil || m.Trick == nil {
		return 0, 0, game.NoSeat, false
	}
	seat = i
	if m.Seat != nil {
		seat = game.Seat(*m.Seat)
	}
	return *m.Hand, *m.Trick, seat, true
}

// cmdWhy works out the engine's reasoning for a decision of the match
// (design §7 why), made or awaited now, of any seat. It runs in the
// background, one at a time per room, and the answer goes to the asker.
func (r *room) cmdWhy(c *client, i game.Seat, m *inMsg) {
	if !r.expert || r.phase == phaseLobby {
		c.sendError(errInvalid, "De redenering van de AI vraag je op in de expertmodus.")
		return
	}
	h, t, seat, ok := decisionArgs(i, m)
	var d *game.Deal
	var done *action
	if ok {
		d, done, ok = r.decision(h, t, seat)
	}
	if !ok {
		c.sendError(errInvalid, "Die beslissing is er (nog) niet.")
		return
	}
	if r.explaining {
		c.sendError(errLimit, "Even geduld: de AI denkt nog na over de vorige vraag.")
		return
	}
	r.explaining = true
	v := r.matchView(d, seat, h)
	msg := whyMsg{T: "why", Hand: h, Trick: t, Seat: seat, Options: []optionJSON{}}
	if done != nil {
		played := choiceOf(*done)
		msg.Played = &played
	}
	go func() {
		e := r.explain(v)
		r.post(func() {
			r.explaining = false
			msg.fill(e)
			if r.seats[i].client == c {
				c.send(mustJSON(msg))
			}
		})
	}()
}

// explain asks the AI for the reasoning of view v; a panic gives none.
func (r *room) explain(v game.View) (e Explanation) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("Explain panicked", "panic", fmt.Sprint(p))
			e = Explanation{}
		}
	}()
	return r.srv.cfg.AI.Explain(v)
}

// fill puts explanation e in msg, rounded: points to tenths, shares of
// deals to thousandths.
func (msg *whyMsg) fill(e Explanation) {
	tenths := func(x float64) float64 { return math.Round(10*x) / 10 }
	share := func(x float64) float64 { return math.Round(1000*x) / 1000 }
	msg.Normaal, msg.Rule, msg.Sterk = choiceJSON(e.Normaal), e.Rule, choiceJSON(e.Sterk)
	msg.Hint, msg.HintText, msg.Worlds = choiceJSON(e.Hint), e.HintText, e.Worlds
	for _, o := range e.Options {
		oj := optionJSON{choiceJSON: choiceJSON(o.Choice), Value: tenths(o.Value), SE: tenths(o.SE),
			Us: tenths(o.Us), Them: tenths(o.Them), NatUs: share(o.NatUs), NatThem: share(o.NatThem)}
		for _, p := range o.Parts {
			oj.Parts = append(oj.Parts, tenths(p))
		}
		msg.Options = append(msg.Options, oj)
	}
}

// cmdMark sets or clears the expert's own choice for a decision of the
// match (design §7 mark), of any seat, while the match runs and after: a
// legal card for a card played, a suit for a trump choice, spelen or
// passen for a bid. It goes to the game log, and the state shows it.
func (r *room) cmdMark(c *client, i game.Seat, m *inMsg) {
	if !r.expert || r.phase == phaseLobby {
		c.sendError(errInvalid, "Een eigen keuze geef je in de expertmodus.")
		return
	}
	h, t, seat, ok := decisionArgs(i, m)
	var d *game.Deal
	var done *action
	if ok {
		d, done, ok = r.decision(h, t, seat)
	}
	if !ok || done == nil {
		c.sendError(errInvalid, "Die beslissing is er (nog) niet.")
		return
	}
	var mark choiceJSON
	switch done.kind {
	case actPlay:
		if m.Card != "" {
			card, err := game.ParseCard(m.Card)
			if err != nil || !slices.Contains(d.Legal(), card) {
				c.sendError(errInvalid, "Die kaart mocht daar niet.")
				return
			}
			mark.Card = &card
		}
	case actTrump:
		if m.Suit != "" {
			s, err := game.ParseSuit(m.Suit)
			if err != nil || d.Forced() && s == d.Turned() {
				c.sendError(errInvalid, "Die kleur kon daar geen troef worden.")
				return
			}
			mark.Suit = &s
		}
	case actBid:
		mark.Play = m.Play
	}
	key := markKey{hand: h, trick: t, seat: seat}
	if mark == (choiceJSON{}) {
		delete(r.marks, key)
	} else {
		if _, ok := r.marks[key]; !ok && len(r.marks) >= maxExpertMarks {
			c.sendError(errLimit, "Je hebt al genoeg zetten van een eigen keuze voorzien.")
			return
		}
		if r.marks == nil {
			r.marks = make(map[markKey]choiceJSON)
		}
		r.marks[key] = mark
	}
	played := choiceOf(*done)
	r.srv.games.write(logMark{T: "mark", Match: r.matchID, At: time.Now().UTC(), Seat: int(i), Name: r.displayName(i),
		Hand: h, Trick: t, By: int(seat), Mark: mark, Played: &played})
	r.resync(c, i)
}

// choiceOf is decision a as a choice: a card, a suit or a bid.
func choiceOf(a action) choiceJSON {
	switch a.kind {
	case actPlay:
		c := a.card
		return choiceJSON{Card: &c}
	case actTrump:
		s := a.suit
		return choiceJSON{Suit: &s}
	case actBid:
		p := a.play
		return choiceJSON{Play: &p}
	}
	return choiceJSON{}
}

var errBadAct = errors.New("onbekende actie")

// parseAct reads a token of actToken.
func parseAct(tok string) (game.Seat, action, error) {
	if len(tok) < 3 || tok[0] < '0' || tok[0] > '3' {
		return game.NoSeat, action{}, errBadAct
	}
	seat, rest := game.Seat(tok[0]-'0'), tok[1:]
	// A kind is a small letter; a card starts with a capital or a digit.
	switch rest[0] {
	case 'b':
		if rest == "b0" || rest == "b1" {
			return seat, action{kind: actBid, play: rest == "b1"}, nil
		}
	case 't':
		if s, err := game.ParseSuit(rest[1:]); err == nil {
			return seat, action{kind: actTrump, suit: s}, nil
		}
	case 'a':
		if n, err := strconv.Atoi(rest[1:]); err == nil {
			return seat, action{kind: actAuction, bid: n}, nil
		}
	case 'd':
		if len(rest) == 5 {
			a, errA := game.ParseCard(rest[1:3])
			b, errB := game.ParseCard(rest[3:5])
			if errA == nil && errB == nil {
				return seat, action{kind: actDiscard, cards: [2]game.Card{a, b}}, nil
			}
		}
	default:
		if c, err := game.ParseCard(rest); err == nil {
			return seat, action{kind: actPlay, card: c}, nil
		}
	}
	return game.NoSeat, action{}, errBadAct
}

// applyAct makes decision a of seat in deal d.
func applyAct(d *game.Deal, seat game.Seat, a action) error {
	switch a.kind {
	case actTrump:
		return d.ChooseTrump(seat, a.suit)
	case actBid:
		return d.Bid(seat, a.play)
	case actAuction:
		return d.Auction(seat, a.bid)
	case actDiscard:
		return d.Discard(seat, a.cards[:])
	case actPlay:
		return d.Play(seat, a.card)
	}
	return errBadAct
}
