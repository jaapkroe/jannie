package server

import (
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"klaverjas/internal/game"
)

// step is a pause in the match flow; while one is pending nobody may act.
type step uint8

const (
	stepNone      step = iota
	stepDealt          // the deal animation: then the first turn opens
	stepAnnounced      // trump was announced: then voorhand leads
	stepCollect        // a complete trick lies on the table: then it is collected
	stepNextHand       // the hand summary: then the next hand (or game over)
)

type actKind uint8

const (
	actTrump actKind = iota + 1
	actBid
	actPlay
)

// action is one decision by a seat: a trump suit, a bid or a card.
type action struct {
	kind actKind
	suit game.Suit
	play bool
	card game.Card
}

// brainBox serialises calls into one Brain and guards against bad answers.
type brainBox struct {
	mu  sync.Mutex
	b   Brain
	log *slog.Logger
}

var errBadBrain = errors.New("brain answered something illegal")

// decide asks the brain for the decision of view v; a panic or an illegal
// answer falls back to a safe legal choice.
func (bb *brainBox) decide(v game.View) (a action) {
	bb.mu.Lock()
	defer bb.mu.Unlock()
	defer func() {
		if p := recover(); p != nil {
			bb.log.Error("bot panicked", "panic", fmt.Sprint(p), "phase", string(v.Phase))
			a = fallback(v)
		}
	}()
	switch v.Phase {
	case game.PhaseTrump:
		s := bb.b.ChooseTrump(v)
		if s >= game.NumSuits || (v.Forced && s == v.Turned) {
			bb.log.Error("bot chose an invalid trump", "err", errBadBrain)
			return fallback(v)
		}
		return action{kind: actTrump, suit: s}
	case game.PhaseBid:
		return action{kind: actBid, play: bb.b.Bid(v)}
	case game.PhasePlay:
		c := bb.b.Play(v)
		if !slices.Contains(v.Legal, c) {
			bb.log.Error("bot played an illegal card", "err", errBadBrain)
			return fallback(v)
		}
		return action{kind: actPlay, card: c}
	}
	return fallback(v)
}

// fallback is a legal decision without any thought: the longest allowed
// suit as trump, pass, or the first legal card.
func fallback(v game.View) action {
	switch v.Phase {
	case game.PhaseTrump:
		var n [game.NumSuits]int
		for _, c := range v.Hand {
			n[c.Suit]++
		}
		best := game.Suit(0)
		if v.Forced && v.Turned == best {
			best = 1
		}
		for s := game.Suit(0); s < game.NumSuits; s++ {
			if !(v.Forced && s == v.Turned) && n[s] > n[best] {
				best = s
			}
		}
		return action{kind: actTrump, suit: best}
	case game.PhaseBid:
		return action{kind: actBid}
	default:
		legal := v.Legal
		if len(legal) == 0 {
			legal = game.LegalMoves(v.Hand, v.Current, v.Seat, v.Trump, v.Rules)
		}
		if len(legal) == 0 {
			return action{kind: actPlay}
		}
		return action{kind: actPlay, card: legal[0]}
	}
}

// inHand reports whether a hand is being played (trump, bid or play).
func (r *room) inHand() bool {
	return r.phase == phaseTrump || r.phase == phaseBid || r.phase == phasePlay
}

// startMatch fills the empty seats and deals the first hand.
func (r *room) startMatch() {
	if r.phase == phaseLobby {
		r.sysChat("Het spel begint: %d potjes, %s/%s. Veel plezier!", r.opts.Hands, r.opts.TrumpMode.NameNL(), r.opts.Rules.NameNL())
	}
	r.fillSeats()
	for i := range r.seats {
		st := &r.seats[i]
		st.ready = false
		if st.kind == seatBot {
			st.brain = r.newBrain(st.persona.ID, r.opts.AI)
		}
	}
	r.handNo = 0
	r.deal = nil
	r.scores = nil
	r.total = [2]int{}
	r.prev = nil
	r.lastTrick = nil
	r.winner = -1
	r.overAt = time.Time{}
	r.log.Info("match started", "humans", r.humanCount(), "hands", r.opts.Hands,
		"trumpMode", r.opts.TrumpMode.String(), "rules", r.opts.Rules.String(), "ai", r.opts.AI, "training", r.training)
	r.startHand()
	r.greet()
}

// startHand shuffles and deals the next hand; the first dealer is random.
func (r *room) startHand() {
	dealer := game.Seat(r.rng.IntN(4))
	if r.deal != nil {
		dealer = r.deal.Dealer().Next()
	}
	r.handNo++
	r.deal = game.NewDeal(dealer, game.Shuffle(r.rng), r.opts.TrumpMode, r.opts.Rules, game.Suit(r.rng.IntN(game.NumSuits)))
	r.phase = string(r.deal.Phase())
	r.collected = false
	r.lastTrick = nil
	r.nextAt = time.Time{}
	for i := range r.seats {
		r.seats[i].ready = false
	}
	r.pause(stepDealt, r.pace().deal)
	r.emit(evDeal{Type: "deal", HandNo: r.handNo, Dealer: dealer})
	r.drive()
}

// pause starts a pause of d (scaled) that ends with runPending.
func (r *room) pause(s step, d time.Duration) {
	r.pending = s
	r.pendingAt = time.Now().Add(r.scaled(d))
}

// openTurn marks the start of a turn: think time for bots and the hint
// cache key.
func (r *room) openTurn() {
	r.turnAt = time.Now()
	r.step++
	r.think = r.thinkTime(r.deal.Turn())
}

func (r *room) thinkTime(i game.Seat) time.Duration {
	if i == game.NoSeat {
		return 0
	}
	speed := 1.0
	if st := &r.seats[i]; st.kind == seatBot && st.persona.Speed > 0 {
		speed = st.persona.Speed
	}
	f := speed * (0.7 + 0.6*r.rng.Float64())
	if r.deal.Phase() == game.PhasePlay && len(r.deal.Legal()) == 1 {
		f *= 0.6
	}
	return r.scaled(time.Duration(float64(r.pace().think) * f))
}

// drive schedules whatever happens next: the end of a pause, a bot's move,
// or a substitute for a human who is away. It cancels everything scheduled
// before, so it is called after every state change.
func (r *room) drive() {
	r.gen++
	if !r.inHand() && r.phase != phaseHandEnd {
		return
	}
	live := r.alwaysOn || r.connectedHumans() > 0
	if r.pending != stepNone {
		// The hand summary waits for the players; the other pauses are part of
		// the animation and always end.
		if r.pending == stepNextHand && !live {
			return
		}
		r.after(time.Until(r.pendingAt), r.runPending)
		return
	}
	if !live || !r.inHand() {
		return
	}
	turn := r.deal.Turn()
	if turn == game.NoSeat {
		return
	}
	st := &r.seats[turn]
	switch {
	case st.kind == seatBot:
		r.botMove(turn, r.turnAt.Add(r.think))
	case st.client != nil:
		// A connected human: their move, no time limit.
	case st.away:
		r.botMove(turn, latest(r.turnAt, st.awayAt).Add(r.think))
	default:
		due := latest(r.turnAt, st.leftAt).Add(r.scaled(awayAfter))
		r.after(time.Until(due), func() { r.goAway(turn) })
	}
}

func latest(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// runPending ends the current pause.
func (r *room) runPending() {
	s := r.pending
	r.pending = stepNone
	switch s {
	case stepDealt:
		r.openTurn()
		if r.deal.Mode() == game.Gedraaid {
			r.emit(evTurned{Type: "turned", Suit: r.deal.Turned()})
		} else {
			r.emit(nil)
		}
	case stepAnnounced:
		r.openTurn()
		r.emit(nil)
	case stepCollect:
		r.collected = true
		w := r.deal.Current().Winner
		if r.deal.Phase() == game.PhaseDone {
			r.emit(evCollect{Type: "collect", Winner: w})
			r.endHand()
			return
		}
		r.openTurn()
		r.emit(evCollect{Type: "collect", Winner: w})
	case stepNextHand:
		r.nextHand()
		return
	}
	r.drive()
}

// viewFor is what seat i knows, with the match fields filled in.
func (r *room) viewFor(i game.Seat) game.View {
	v := r.deal.View(i)
	v.HandNo = r.handNo
	v.HandsTotal = r.opts.Hands
	v.MatchScore = r.total
	return v
}

// botMove lets the brain of seat i decide in the background and applies
// the decision at due, unless the room moved on meanwhile.
func (r *room) botMove(i game.Seat, due time.Time) {
	gen := r.gen
	st := &r.seats[i]
	if st.brain == nil { // the substitute of a human
		st.brain = r.newBrain("", "normaal")
	}
	bb, v := st.brain, r.viewFor(i)
	go func() {
		a := bb.decide(v)
		if wait := time.Until(due); wait > 0 {
			t := time.NewTimer(wait)
			select {
			case <-t.C:
			case <-r.done:
				t.Stop()
				return
			}
		}
		r.post(func() {
			if r.gen != gen {
				return
			}
			if err := r.act(i, a); err != nil {
				r.log.Error("bot move rejected", "seat", int(i), "err", err.Error())
				if err := r.act(i, fallback(v)); err != nil {
					r.log.Error("fallback move rejected", "seat", int(i), "err", err.Error())
				}
			}
		})
	}()
}

// goAway lets a substitute play for a human who is still disconnected on
// their turn.
func (r *room) goAway(i game.Seat) {
	st := &r.seats[i]
	if st.kind != seatHuman || st.client != nil || st.away {
		return
	}
	st.away = true
	st.awayAt = time.Now()
	r.sysChat("%s is even weg; een AI-speler speelt zolang voor %s.", st.name, st.name)
	r.emit(evSeat{Type: "away", Seat: i})
	r.drive()
}

var errPaused = errors.New("Even geduld, het spel gaat zo verder.")

// humanAct applies a decision of a connected human and reports errors.
func (r *room) humanAct(c *client, i game.Seat, a action) {
	if !r.inHand() {
		c.sendError(errInvalid, "Dat kan nu niet.")
		return
	}
	err := r.act(i, a)
	switch {
	case err == nil:
	case errors.Is(err, game.ErrNotYourTurn), errors.Is(err, errPaused):
		c.sendError(errNotTurn, err.Error())
	default:
		c.sendError(errInvalid, err.Error())
	}
}

// act applies one decision of seat i, emits the events and moves on.
func (r *room) act(i game.Seat, a action) error {
	if !r.inHand() {
		return game.ErrWrongPhase
	}
	if r.pending != stepNone {
		return errPaused
	}
	d := r.deal
	p := r.pace()
	switch a.kind {
	case actTrump:
		forced := d.Forced()
		if err := d.ChooseTrump(i, a.suit); err != nil {
			return err
		}
		r.phase = phasePlay
		r.pause(stepAnnounced, p.announce)
		r.emit(evTrump{Type: "trump", Seat: i, Suit: a.suit, Forced: forced})
		r.botSay(i, ChatEvent{Kind: "trump", Mine: true}, 700*time.Millisecond)
	case actBid:
		if err := d.Bid(i, a.play); err != nil {
			return err
		}
		if a.play {
			r.phase = phasePlay
			r.pause(stepAnnounced, p.announce)
			r.emit(evBid{Type: "bid", Seat: i, Play: true})
			r.emit(evTrump{Type: "trump", Seat: i, Suit: d.Turned()})
			r.botSay(i, ChatEvent{Kind: "trump", Mine: true}, 700*time.Millisecond)
		} else {
			r.phase = string(d.Phase())
			r.openTurn()
			r.emit(evBid{Type: "bid", Seat: i})
			r.botSay(i, ChatEvent{Kind: "pass", Mine: true}, 300*time.Millisecond)
		}
	case actPlay:
		if err := d.Play(i, a.card); err != nil {
			return err
		}
		t := d.Current()
		if !t.Complete() {
			r.openTurn()
			r.emit(evPlay{Type: "play", Seat: i, Card: a.card})
			if r.rng.Float64() < 0.1 {
				r.botSay(i, ChatEvent{Kind: "play", Mine: true}, 300*time.Millisecond)
			}
			break
		}
		r.collected = false
		r.lastTrick = &t
		r.trickNo++
		r.pause(stepCollect, p.trick)
		r.emit(evPlay{Type: "play", Seat: i, Card: a.card})
		roem := t.Roem
		if roem == nil {
			roem = []game.RoemItem{}
		}
		r.emit(evTrick{Type: "trick", Winner: t.Winner, Points: t.Points, Roem: roem, Last: d.Phase() == game.PhaseDone})
		r.sendTips(t)
		r.chatTrick(t)
	default:
		return errors.New("onbekende actie")
	}
	r.drive()
	return nil
}

// sendTips explains a finished trick to the player in training.
func (r *room) sendTips(t game.Trick) {
	if !r.training {
		return
	}
	trump, _ := r.deal.Trump()
	for i := range r.seats {
		st := &r.seats[i]
		if st.kind != seatHuman || st.client == nil {
			continue
		}
		var names [4]string
		for k := range names {
			names[k] = r.displayName(game.Seat(k))
		}
		names[i] = "Jij"
		if text := r.explainTrick(t, trump, names); text != "" {
			st.client.send(mustJSON(tipMsg{T: "tip", Text: text}))
		}
	}
}

func (r *room) explainTrick(t game.Trick, trump game.Suit, names [4]string) (text string) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("ExplainTrick panicked", "panic", fmt.Sprint(p))
			text = ""
		}
	}()
	return r.srv.cfg.AI.ExplainTrick(t, trump, names)
}

// hintFor returns the training hint for seat i on its turn, computed once
// per turn.
func (r *room) hintFor(i game.Seat) *hint {
	if r.hintStep == r.step && r.hintVal != nil {
		return r.hintVal
	}
	v := r.viewFor(i)
	a, ok := r.advise(v)
	if !ok {
		return nil
	}
	h := &hint{Text: a.Text}
	switch v.Phase {
	case game.PhaseTrump:
		if a.Suit != nil && *a.Suit < game.NumSuits && !(v.Forced && *a.Suit == v.Turned) {
			s := *a.Suit
			h.Suit = &s
		}
	case game.PhaseBid:
		if a.Play != nil {
			p := *a.Play
			h.Play = &p
		}
	case game.PhasePlay:
		if a.Card != nil && slices.Contains(v.Legal, *a.Card) {
			c := *a.Card
			h.Card = &c
		}
	}
	if h.Card == nil && h.Suit == nil && h.Play == nil && h.Text == "" {
		return nil
	}
	r.hintStep, r.hintVal = r.step, h
	return h
}

func (r *room) advise(v game.View) (a Advice, ok bool) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("Advise panicked", "panic", fmt.Sprint(p))
			ok = false
		}
	}()
	return r.srv.cfg.AI.Advise(v), true
}

// endHand scores the finished hand and shows the summary.
func (r *room) endHand() {
	d := r.deal
	res := d.Result()
	r.scores = append(r.scores, scoreRow{
		Hand: r.handNo, Dealer: res.Dealer, Trump: res.Trump, TrumpBy: res.TrumpBy,
		PlayingTeam: res.PlayingTeam, Points: res.Points, Roem: res.Roem, Score: res.Score,
		Nat: res.Nat, Pit: res.Pit,
	})
	r.total[0] += res.Score[0]
	r.total[1] += res.Score[1]
	r.prev = &prevHand{Tricks: d.Tricks(), Result: res}
	r.phase = phaseHandEnd
	for i := range r.seats {
		r.seats[i].ready = false
	}
	r.pause(stepNextHand, r.pace().summary)
	r.nextAt = r.pendingAt
	r.emit(evHandEnd{Type: "handEnd", Result: res})
	r.chatHandEnd(res)
	r.drive()
}

// nextHand deals the next hand, or ends the match after the last one.
func (r *room) nextHand() {
	r.pending = stepNone
	r.nextAt = time.Time{}
	if r.handNo < r.opts.Hands {
		r.startHand()
		return
	}
	r.phase = phaseGameOver
	r.overAt = time.Now()
	switch {
	case r.total[0] > r.total[1]:
		r.winner = 0
	case r.total[1] > r.total[0]:
		r.winner = 1
	default:
		r.winner = -1
	}
	r.emit(evGameOver{Type: "gameOver", Total: r.total, Winner: r.winner})
	r.chatGameOver()
	r.log.Info("match over", "hands", r.handNo, "total0", r.total[0], "total1", r.total[1])
	r.drive()
}
