package server

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"time"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

// toepPlay is a match of toepen at the table (design §11): rounds of four
// cards, the last trick wins, toepen raises the stake, and the match goes
// on until one player is left. It plays on the shared table: the lobby,
// bots, chat, calls, reconnects and the question whether an AI may play
// for someone who is gone work as for klaverjas.
type toepPlay struct {
	r      *room
	m      *toepen.Match
	d      *toepen.Deal
	last   *toepen.Trick // the trick just taken, on the table until collected
	rounds []toepRound   // the score sheet
	dealt  [maxSeats][]game.Card
	acts   string // the round's decisions, for the game log
	wasGen int    // bumped when the time for a was opens: late bot answers are dropped
	poorAt int    // the round whose armoede was announced
}

// The decisions of toepen, after klaverjas's (match.go).
const (
	actToep   actKind = iota + 16 // raise the stake, on the turn to play
	actAnswer                     // play: go along with the toep, else pass
	actWas                        // play: claim a was, else not
	actCheck                      // play: check the claimed was, else let it go
)

// toepRules are the table's rules of toepen.
func (r *room) toepRules() toepen.Rules {
	return toepen.Rules{Limit: r.opts.Limit, Was: r.opts.Was, Armoede: r.opts.Armoede}
}

func (t *toepPlay) variant() string {
	o := t.r.opts
	s := fmt.Sprintf("toepen tot %d strafpunten", o.Limit)
	switch {
	case o.Was && o.Armoede:
		s += ", met was en armoede"
	case o.Was:
		s += ", met was"
	case o.Armoede:
		s += ", met armoede"
	}
	return s
}

func (t *toepPlay) start() {
	r := t.r
	n := r.players()
	r.total = make([]int, n)
	t.m = toepen.NewMatch(n, r.toepRules(), game.Seat(r.deals.IntN(n)))
	t.rounds = nil
	r.sysChat("Spel (%d) begint: %s. Wie de laatste slag haalt, krijgt geen strafpunten. Veel plezier!", r.seed, t.variant())
	r.logMatch()
	r.log.Info("match started", "game", gameToepen, "players", n, "humans", r.humanCount(),
		"limit", r.opts.Limit, "was", r.opts.Was, "armoede", r.opts.Armoede, "ai", r.opts.AI)
	t.deal()
}

// deal deals the next round from the match's seed.
func (t *toepPlay) deal() {
	r := t.r
	t.d = t.m.Deal(toepen.Shuffle(r.deals))
	r.handNo = t.m.Round
	for s := range r.players() {
		t.dealt[s] = t.d.Hand(game.Seat(s))
	}
	t.acts, t.last = "", nil
	r.collected = false
	r.nextAt = time.Time{}
	for i := range r.seats {
		r.seats[i].ready = false
	}
	r.phase = t.phase()
	r.pause(stepDealt, r.pace().deal)
	r.emit(evDeal{Type: "deal", HandNo: r.handNo, Dealer: t.d.Dealer()})
	r.drive()
}

// phase is the room phase of the round in play.
func (t *toepPlay) phase() string {
	switch t.d.Phase() {
	case toepen.PhaseWas:
		return phaseWas
	case toepen.PhaseCheck:
		return phaseCheck
	case toepen.PhaseToep:
		return phaseToep
	}
	return phasePlay
}

func (t *toepPlay) turn() game.Seat {
	if t.d == nil {
		return game.NoSeat
	}
	return t.d.Turn()
}

func (t *toepPlay) handLen(i game.Seat) int {
	if t.d == nil {
		return 0
	}
	return t.d.HandLen(i)
}

func (t *toepPlay) single() bool {
	d := t.d
	return d != nil && d.Phase() == toepen.PhasePlay && len(d.Legal()) == 1 && !d.CanToep(d.Turn())
}

func (t *toepPlay) resume(s step) {
	r := t.r
	switch s {
	case stepDealt:
		if t.d.Phase() == toepen.PhaseWas {
			t.openWas()
			return
		}
		t.proceed()
		return
	case stepWas:
		t.d.CloseWas()
		t.afterWas()
		return
	case stepAnnounced:
		t.proceed()
		return
	case stepCollect:
		r.collected = true
		w := t.last.Winner
		if t.d.Phase() == toepen.PhaseDone {
			r.emit(evCollect{Type: "collect", Winner: w})
			t.endRound()
			return
		}
		r.openTurn()
		r.emit(evCollect{Type: "collect", Winner: w})
	case stepNextHand:
		t.next()
		return
	}
	r.drive()
}

// proceed goes on in whatever the round awaits now: the announcement of
// armoede first, else the next turn, or the end of the round.
func (t *toepPlay) proceed() {
	r, d := t.r, t.d
	r.phase = t.phase()
	switch {
	case d.Phase() == toepen.PhaseDone:
		t.endRound()
		return
	case d.ArmoedeToep() && t.poorAt != r.handNo:
		t.poorAt = r.handNo
		var poor []game.Seat
		var names []string
		for s := range game.Seat(r.players()) {
			if d.Armoede(s) && d.Status(s) == toepen.StatusIn {
				poor = append(poor, s)
				names = append(names, r.displayName(s))
			}
		}
		r.pause(stepAnnounced, 2*r.pace().announce)
		r.emit(evArmoede{Type: "armoede", Seats: poor, Stake: d.Stake()})
		r.sysChat("Armoede: %s %s nog één strafpunt van eruit. De inzet is meteen %d.", joinNL(names),
			map[bool]string{true: "staat", false: "staan"}[len(names) == 1], d.Stake())
	default:
		r.openTurn()
		r.emit(nil)
	}
	r.drive()
}

// ---- the was ----

// openWas opens the time for a was: everyone in the round says at once
// whether they have one. The bots decide in the background and answer
// after their think time; the time runs out after pace().was.
func (t *toepPlay) openWas() {
	r, d := t.r, t.d
	r.phase = phaseWas
	r.pause(stepWas, r.pace().was)
	r.nextAt = r.pendingAt
	t.wasGen++
	gen := t.wasGen
	for s := range game.Seat(r.players()) {
		if d.Status(s) != toepen.StatusIn || !r.botPlays(s) {
			continue
		}
		bb, v, delay := r.brainOf(s), d.View(s), r.thinkTime(s)
		go func() {
			a := bb.toep(v)
			r.later(delay, func() {
				if t.wasGen == gen && t.d == d && r.pending == stepWas && !d.Answered(s) && r.botPlays(s) {
					t.was(s, a.play)
				}
			})
		}()
	}
	r.emit(nil)
	r.drive()
}

// was records the answer of seat i in the time for a was; after the last
// answer it is over at once.
func (t *toepPlay) was(i game.Seat, claim bool) error {
	r, d := t.r, t.d
	if r.pending != stepWas || d.Phase() != toepen.PhaseWas {
		return toepen.ErrWrongPhase
	}
	if err := d.Was(i, claim); err != nil {
		return err
	}
	if claim {
		t.act(i, "w")
	}
	if d.Phase() == toepen.PhaseWas {
		r.emit(nil) // who has answered
		return nil
	}
	r.pending = stepNone
	t.afterWas()
	return nil
}

// afterWas announces the claims, if any, once the time for a was is over.
func (t *toepPlay) afterWas() {
	r, d := t.r, t.d
	r.nextAt = time.Time{}
	var claims []game.Seat
	for s := range game.Seat(r.players()) {
		if d.Claimed(s) {
			claims = append(claims, s)
		}
	}
	if len(claims) == 0 {
		t.proceed()
		return
	}
	r.phase = t.phase()
	r.pause(stepAnnounced, r.pace().announce)
	r.emit(evClaims{Type: "claims", Seats: claims})
	for _, s := range claims {
		r.botSay(s, ChatEvent{Kind: "was", Mine: true}, 300*time.Millisecond)
	}
	r.drive()
}

// ---- decisions ----

func (t *toepPlay) move(c *client, i game.Seat, m *inMsg) bool {
	var a action
	switch m.T {
	case "play":
		card, err := game.ParseCard(m.Card)
		if err != nil {
			c.sendError(errInvalid, "Die kaart bestaat niet.")
			return true
		}
		a = action{kind: actPlay, card: card}
	case "toep":
		a = action{kind: actToep}
	case "answer", "was", "check":
		if m.Play == nil {
			c.sendError(errInvalid, map[string]string{
				"answer": "Kies meegaan of passen.", "was": "Zeg of je een was hebt.", "check": "Kies controleren of laten gaan.",
			}[m.T])
			return true
		}
		a = action{kind: map[string]actKind{"answer": actAnswer, "was": actWas, "check": actCheck}[m.T], play: *m.Play}
	default:
		return false
	}
	if a.kind == actWas && (t.r.pending != stepWas || t.d == nil || t.d.Phase() != toepen.PhaseWas || t.d.Answered(i)) {
		return true // a late tap (the time for a was is over), or the answer again
	}
	if !t.r.inHand() {
		c.sendError(errInvalid, "Dat kan nu niet.")
		return true
	}
	switch err := t.apply(i, a); {
	case err == nil:
	case errors.Is(err, toepen.ErrNotYourTurn), errors.Is(err, errPaused):
		c.sendError(errNotTurn, err.Error())
	default:
		c.sendError(errInvalid, err.Error())
	}
	return true
}

func (t *toepPlay) decision(i game.Seat, bb *brainBox) (func() action, action) {
	v := t.d.View(i)
	return func() action { return bb.toep(v) }, toepSafe(v)
}

// apply plays decision a of seat i, emits the events and moves on.
func (t *toepPlay) apply(i game.Seat, a action) error {
	r, d := t.r, t.d
	if !r.inHand() || d == nil {
		return toepen.ErrWrongPhase
	}
	if a.kind == actWas {
		return t.was(i, a.play)
	}
	if r.pending != stepNone {
		return errPaused
	}
	p := r.pace()
	switch a.kind {
	case actToep:
		if err := d.Toep(i); err != nil {
			return err
		}
		t.act(i, "t")
		r.phase = phaseToep
		r.pause(stepAnnounced, p.announce)
		r.emit(evToep{Type: "toep", Seat: i, Stake: d.Stake()})
		t.chatToep(i)
	case actAnswer:
		stake := d.Stake()
		if err := d.Answer(i, a.play); err != nil {
			return err
		}
		t.act(i, map[bool]string{true: "a1", false: "a0"}[a.play])
		ev := evAnswer{Type: "answer", Seat: i, Stay: a.play}
		if !a.play {
			ev.Points = stake - 1
			r.botSay(i, ChatEvent{Kind: "pass", Mine: true, Points: ev.Points}, 300*time.Millisecond)
		}
		r.phase = t.phase()
		if d.Phase() == toepen.PhaseDone {
			r.emit(ev)
			t.endRound()
			return nil
		}
		r.openTurn()
		r.emit(ev)
	case actCheck:
		claimant := d.Claimant()
		res, err := d.Check(i, a.play)
		if err != nil {
			return err
		}
		t.act(i, map[bool]string{true: "c1", false: "c0"}[a.play])
		ev := evCheck{Type: "check", Seat: i, Claimant: claimant, Check: a.play}
		if res == nil { // the next is asked
			r.openTurn()
			r.emit(ev)
			break
		}
		r.phase = t.phase()
		wait := p.announce
		if res.Checker != game.NoSeat {
			wait = 3 * p.announce // the hand is shown: time to look
		}
		r.pause(stepAnnounced, wait)
		r.emit(ev)
		r.emit(evWasDone{Type: "wasDone", Claimant: res.Claimant, Checker: res.Checker, Kind: res.Kind,
			Cards: nonNil(res.Cards), Genuine: res.Genuine(), Washed: d.Washed(res.Claimant)})
		t.chatCheck(res)
	case actPlay:
		before := len(d.Tricks())
		if err := d.Play(i, a.card); err != nil {
			return err
		}
		t.act(i, a.card.String())
		if len(d.Tricks()) == before {
			r.openTurn()
			r.emit(evPlay{Type: "play", Seat: i, Card: a.card})
			break
		}
		tr := d.Tricks()[before]
		t.last = &tr
		r.collected = false
		r.trickNo++
		r.pause(stepCollect, p.trick)
		r.emit(evPlay{Type: "play", Seat: i, Card: a.card})
		r.emit(evToepTrick{Type: "trick", Winner: tr.Winner, Last: d.Phase() == toepen.PhaseDone})
	default:
		return errors.New("onbekende actie")
	}
	r.drive()
	return nil
}

// act adds a decision to the round's log: the seat, then "w" (a was
// claimed), "c1"/"c0" (checked or not), "t" (toep), "a1"/"a0" (went along
// or passed) or a card.
func (t *toepPlay) act(i game.Seat, what string) {
	if t.acts != "" {
		t.acts += " "
	}
	t.acts += string(rune('0'+i)) + what
}

// toep asks the brain for the decision of view v; a panic or an illegal
// answer falls back to a safe legal one.
func (bb *brainBox) toep(v toepen.View) (a action) {
	bb.mu.Lock()
	defer bb.mu.Unlock()
	defer func() {
		if p := recover(); p != nil {
			bb.log.Error("bot panicked", "panic", fmt.Sprint(p), "phase", string(v.Phase))
			a = toepSafe(v)
		}
	}()
	switch v.Phase {
	case toepen.PhaseWas:
		return action{kind: actWas, play: v.CanClaim && bb.tb.Was(v)}
	case toepen.PhaseCheck:
		return action{kind: actCheck, play: bb.tb.Check(v)}
	case toepen.PhaseToep:
		return action{kind: actAnswer, play: bb.tb.Answer(v)}
	case toepen.PhasePlay:
		if v.CanToep && bb.tb.Toep(v) {
			return action{kind: actToep}
		}
		c := bb.tb.Play(v)
		if !slices.Contains(v.Legal, c) {
			bb.log.Error("bot played an illegal card", "err", errBadBrain)
			return toepSafe(v)
		}
		return action{kind: actPlay, card: c}
	}
	return toepSafe(v)
}

// toepSafe is a legal decision without any thought: no was, no check, go
// along, the first legal card.
func toepSafe(v toepen.View) action {
	switch v.Phase {
	case toepen.PhaseWas:
		return action{kind: actWas}
	case toepen.PhaseCheck:
		return action{kind: actCheck}
	case toepen.PhaseToep:
		return action{kind: actAnswer, play: true}
	}
	legal := v.Legal
	if len(legal) == 0 {
		legal = toepen.Legal(v.Hand, v.Current)
	}
	if len(legal) == 0 {
		return action{kind: actPlay}
	}
	return action{kind: actPlay, card: legal[0]}
}

// brainOf is the brain that plays seat i: its bot's, or the substitute's.
func (r *room) brainOf(i game.Seat) *brainBox {
	st := &r.seats[i]
	if st.brain == nil {
		st.brain = r.newBrain("", "normaal")
	}
	return st.brain
}

// ---- the end of a round and of the match ----

// endRound takes the penalty points of the round and shows its summary.
func (t *toepPlay) endRound() {
	r, d := t.r, t.d
	res := d.Result()
	wasOut := make([]bool, r.players())
	for s := range wasOut {
		wasOut[s] = !t.m.Alive(game.Seat(s))
	}
	t.m.Settle(d)
	copy(r.total, res.Points)
	row := toepRound{Hand: r.handNo, Dealer: d.Dealer(), Winner: res.Winner, Stake: res.Stake, Tricks: res.Tricks,
		Gains: res.Gains, Points: res.Points, Out: res.Out}
	t.rounds = append(t.rounds, row)
	t.logRound(row)
	r.phase = phaseHandEnd
	for i := range r.seats {
		r.seats[i].ready = false
	}
	r.pending = stepNextHand
	r.timeSummary(time.Now())
	r.emit(evToepRound{Type: "handEnd", Result: row})
	for s := range game.Seat(r.players()) {
		if res.Out[s] && !wasOut[s] {
			r.sysChat("%s ligt eruit met %d strafpunten.", r.displayName(s), res.Points[s])
			r.botSay(s, ChatEvent{Kind: "out", Mine: true}, 900*time.Millisecond)
		}
	}
	if !res.Out[res.Winner] && !r.botSay(res.Winner, ChatEvent{Kind: "wonRound", Mine: true, Points: res.Stake}, 700*time.Millisecond) &&
		res.Stake >= 3 {
		r.botsReact(1, 1100*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
			return ChatEvent{Kind: "lostRound", Mine: true, Points: res.Gains[i]}, i != res.Winner && res.Gains[i] > 0
		})
	}
	r.drive()
}

// next deals the next round, or ends the match when one player is left.
func (t *toepPlay) next() {
	r := t.r
	r.pending = stepNone
	r.nextAt = time.Time{}
	if !t.m.Over() {
		t.deal()
		return
	}
	r.phase = phaseGameOver
	r.overAt = time.Now()
	w := t.m.Winner()
	r.winner = int(w)
	r.emit(evGameOver{Type: "gameOver", Total: slices.Clone(r.total), Winner: r.winner})
	r.sysChat("%s wint het spel na %d potjes!", r.displayName(w), r.handNo)
	r.botsReact(2, 1800*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		if i == w {
			return ChatEvent{Kind: "gameWon", Mine: true}, true
		}
		return ChatEvent{Kind: "gameLost", Mine: true}, true
	})
	r.logEnd()
	r.log.Info("match over", "game", gameToepen, "rounds", r.handNo, "points", r.total)
	r.drive()
}

// ---- chat ----

// chatToep: the bot that toept says so; else someone else may react.
func (t *toepPlay) chatToep(i game.Seat) {
	r := t.r
	if r.botSay(i, ChatEvent{Kind: "toep", Mine: true, Points: t.d.Stake()}, 200*time.Millisecond) {
		return
	}
	r.botsReact(1, 900*time.Millisecond, func(s game.Seat) (ChatEvent, bool) {
		return ChatEvent{Kind: "toep", Points: t.d.Stake()}, s != i && t.d.Status(s) == toepen.StatusIn
	})
}

// chatCheck tells the table how a claimed was ended.
func (t *toepPlay) chatCheck(res *toepen.Check) {
	r := t.r
	who := r.displayName(res.Claimant)
	switch {
	case res.Checker == game.NoSeat:
		r.sysChat("Niemand controleert de was van %s: vier nieuwe kaarten.", who)
	case res.Genuine():
		r.sysChat("%s controleert de was van %s: een echte %s. %s krijgt een strafpunt, %s vier nieuwe kaarten.",
			r.displayName(res.Checker), who, res.Kind.NameNL(), r.displayName(res.Checker), who)
		r.botSay(res.Checker, ChatEvent{Kind: "checkWrong", Mine: true}, 900*time.Millisecond)
	default:
		r.sysChat("%s controleert de was van %s: geen was! %s krijgt een strafpunt en speelt dit potje niet mee.",
			r.displayName(res.Checker), who, who)
		if !r.botSay(res.Claimant, ChatEvent{Kind: "caught", Mine: true}, 900*time.Millisecond) {
			r.botSay(res.Checker, ChatEvent{Kind: "checkRight", Mine: true}, 900*time.Millisecond)
		}
	}
}

// joinNL joins names the Dutch way: "A", "A en B", "A, B en C".
func joinNL(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " en " + names[len(names)-1]
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// ---- the state ----

// toepState is the full per-seat state `s` of an update at a table of
// toepen (design §11). The keys the table shares with klaverjas (code,
// phase, opts, players, turn, takeover, …) mean the same.
type toepState struct {
	Game     string         `json:"game"` // "toepen"
	Code     string         `json:"code"`
	Phase    string         `json:"phase"` // lobby, was, check, toep, play, handEnd, gameOver
	Opts     Options        `json:"opts"`
	Training bool           `json:"training"`
	Expert   bool           `json:"expert"`
	You      int            `json:"you"`
	Host     int            `json:"host"`
	Roster   []rosterEntry  `json:"roster,omitempty"`
	Players  []*playerState `json:"players"`
	Turn     int            `json:"turn"`
	Takeover *takeoverState `json:"takeover"`
	NextAt   int64          `json:"nextAt"` // the time for a was, or the summary: when it ends (unix ms)
	Winner   int            `json:"winner"` // game over: the seat left

	HandNo      int             `json:"handNo"` // the round
	Dealer      int             `json:"dealer"`
	Voorhand    int             `json:"voorhand"`
	Stake       int             `json:"stake"`
	Toeper      int             `json:"toeper"`      // the last to toep this round, -1
	ArmoedeToep bool            `json:"armoedeToep"` // the stake went up for armoede
	Points      []int           `json:"points"`      // penalty points, now
	Status      []toepen.Status `json:"status"`      // per seat this round: in, gepast, betrapt, eruit, uit
	Armoede     []bool          `json:"armoede"`     // per seat: one point from out this round
	Washed      []bool          `json:"washed"`      // got four new cards for a was
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
	Rounds      []toepRound     `json:"rounds"` // the score sheet
}

// toepRound is one line of the score sheet: how a round ended.
type toepRound struct {
	Hand   int       `json:"hand"`
	Dealer game.Seat `json:"dealer"`
	Winner game.Seat `json:"winner"`
	Stake  int       `json:"stake"`
	Tricks bool      `json:"tricks"` // won with the last trick, else everyone else passed or sat out
	Gains  []int     `json:"gains"`  // penalty points this round, per seat
	Points []int     `json:"points"` // after it
	Out    []bool    `json:"out"`    // out of the match after it
}

func (t *toepPlay) state(i game.Seat) any {
	r := t.r
	n := r.players()
	s := &toepState{
		Game: gameToepen, Code: r.code, Phase: r.phase, Opts: r.opts, You: int(i), Host: int(r.host),
		Players: make([]*playerState, n), Turn: -1, Winner: -1, HandNo: r.handNo,
		Dealer: -1, Voorhand: -1, Toeper: -1, Claimant: -1, Stake: 0,
		Points: make([]int, n), Status: make([]toepen.Status, n), Armoede: make([]bool, n),
		Washed: make([]bool, n), Answered: make([]bool, n), Claims: make([]bool, n),
		Asking: []int{}, Checks: []toepen.Check{}, Hand: []game.Card{}, Rounds: t.rounds,
		NextAt: unixMilli(r.nextAt),
	}
	if s.Rounds == nil {
		s.Rounds = []toepRound{}
	}
	for k := range s.Players {
		s.Players[k] = r.playerState(game.Seat(k))
	}
	if t.m != nil {
		copy(s.Points, t.m.Points[:n])
	}
	switch r.phase {
	case phaseLobby:
		s.Roster = r.roster()
		return s
	case phaseGameOver:
		s.Winner = r.winner
	}
	d := t.d
	if d == nil {
		return s
	}
	s.Dealer, s.Voorhand, s.Stake = int(d.Dealer()), int(d.Voorhand()), d.Stake()
	s.Toeper, s.ArmoedeToep = int(d.Toeper()), d.ArmoedeToep()
	s.Checks = d.Checks()
	s.Stock = d.Stock()
	s.Tricks = len(d.Tricks())
	for k := range game.Seat(n) {
		s.Points[k] = d.Points(k)
		s.Status[k] = d.Status(k)
		s.Armoede[k] = d.Armoede(k)
		s.Washed[k] = d.Washed(k)
		s.Answered[k] = d.Answered(k)
		s.Claims[k] = d.Claimed(k)
	}
	if ts := d.Tricks(); len(ts) > 0 {
		last := ts[len(ts)-1]
		s.LastTrick = &last
	}
	if !r.inHand() {
		return s
	}
	if d.Status(i) == toepen.StatusIn {
		s.Hand = toepen.SortHand(d.Hand(i))
	}
	if c := d.Claimant(); c != game.NoSeat {
		s.Claimant = int(c)
	}
	for _, a := range d.Asking() {
		s.Asking = append(s.Asking, int(a))
	}
	s.CanClaim = r.pending == stepWas && d.CanClaim(i)
	if r.phase == phasePlay || r.phase == phaseToep {
		s.Trick = t.shownTrick()
	}
	if r.pending == stepNone {
		s.Turn = int(d.Turn())
	}
	if q := r.asking; q != game.NoSeat {
		s.Takeover = &takeoverState{Seat: q, Left: r.seats[q].kind == seatLeft}
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
	return s
}

// shownTrick is the trick on the table: the one just taken until it is
// collected, then the one being played.
func (t *toepPlay) shownTrick() *toepen.Trick {
	if t.last != nil && !t.r.collected {
		tr := *t.last
		return &tr
	}
	tr := t.d.Current()
	if len(tr.Cards) == 0 && len(t.d.Tricks()) == 0 && t.d.Phase() != toepen.PhasePlay {
		tr.Leader = t.d.Voorhand() // armoede: nobody has led yet
	}
	if tr.Cards == nil {
		tr.Cards = []game.Played{}
	}
	return &tr
}

// ---- events ----

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
// is shown and someone takes a point; washed: the claimant got four new
// cards.
type evWasDone struct {
	Type     string         `json:"type"` // "wasDone"
	Claimant game.Seat      `json:"claimant"`
	Checker  game.Seat      `json:"checker"`
	Kind     toepen.WasKind `json:"kind"`
	Cards    []game.Card    `json:"cards"`
	Genuine  bool           `json:"genuine"`
	Washed   bool           `json:"washed"`
}

type evToep struct {
	Type  string    `json:"type"` // "toep"
	Seat  game.Seat `json:"seat"`
	Stake int       `json:"stake"`
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

type evToepTrick struct {
	Type   string    `json:"type"` // "trick"
	Winner game.Seat `json:"winner"`
	Last   bool      `json:"last"`
}

type evToepRound struct {
	Type   string    `json:"type"` // "handEnd"
	Result toepRound `json:"result"`
}

// ---- the game log ----

// logToepRound is a round of toepen in the game log: the cards as dealt
// per seat ("" for a seat out of the match), the decisions (act) and how
// it ended.
type logToepRound struct {
	T      string    `json:"t"` // "round"
	Match  string    `json:"match"`
	At     time.Time `json:"at"`
	Hand   int       `json:"hand"`
	Dealer game.Seat `json:"dealer"`
	Cards  []string  `json:"cards"`
	Acts   string    `json:"acts"`
	Result toepRound `json:"result"`
}

func (t *toepPlay) logRound(row toepRound) {
	r := t.r
	rec := logToepRound{T: "round", Match: r.matchID, At: time.Now().UTC(), Hand: r.handNo, Dealer: row.Dealer,
		Acts: t.acts, Result: row}
	for s := range r.players() {
		rec.Cards = append(rec.Cards, cardsString(t.d.Dealt(game.Seat(s))))
	}
	r.srv.games.write(rec)
}

// ---- without bots of its own ----

// plainToep is the ToepAI of a server configured without one: it plays
// the first legal card, never toeps or claims a was, always goes along,
// and says nothing.
type plainToep struct{}

func (plainToep) NewToepBrain(string, string, uint64) ToepBrain { return plainToepBrain{} }

func (plainToep) ToepChat(string, ChatEvent, *rand.Rand) string { return "" }

type plainToepBrain struct{}

func (plainToepBrain) Was(toepen.View) bool         { return false }
func (plainToepBrain) Check(toepen.View) bool       { return false }
func (plainToepBrain) Toep(toepen.View) bool        { return false }
func (plainToepBrain) Answer(toepen.View) bool      { return true }
func (plainToepBrain) Play(v toepen.View) game.Card { return toepSafe(v).card }
