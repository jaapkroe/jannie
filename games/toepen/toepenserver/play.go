package toepenserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"jannie/games/toepen/toepen"
	"jannie/platform/cards"
	"jannie/platform/server"
)

// play is a match of toepen at the table
// (games/toepen/README.md#server): rounds of four cards, the last trick
// wins, toepen raises the stake, and the match goes on until one player
// is left. In the lobby it only gives the state.
type play struct {
	t          *server.Table
	ai         AI
	explaining bool       // a why is being worked out
	why        *whyAnswer // the last one, for its asker while the decision stands
	m          *toepen.Match
	d          *toepen.Deal
	handNo     int
	last       *toepen.Trick // the trick just taken, on the table until collected
	collected  bool          // the trick just taken has been collected
	rounds     []round       // the score sheet
	course     []any         // the round's course so far: what everyone saw happen (emit)
	courses    [][]any       // the course of every round ended, for game over
	total      []int         // the penalty points after the last round
	winner     int           // game over: the seat left
	acts       string        // the round's decisions, for the game log
	wasGen     int           // bumped when the time for a was opens: late bot answers are dropped
	told       int           // the settled claims of the round told the table (wasDone)
	stockTold  bool          // the table was told the stock ran out for a vuile was
	poorAt     int           // the round whose armoede was announced

	// Per seat: fast or watch, chosen once only AI players play on (aionly.go).
	choice map[cards.Seat]string
}

// Room phases of toepen, besides the table's (lobby, handEnd, gameOver).
const (
	phaseWas     = "was"     // right after the deal, everyone says whether they have a was
	phaseCheck   = "check"   // a claimed was; the others are asked in turn whether they check it
	phaseToep    = "toep"    // after a toep, the others say in turn whether they go along
	phaseDiscard = "discard" // the koningsspel: in turn each lays its extra cards away
	phasePlay    = "play"
)

// The decisions of toepen.
type actKind uint8

const (
	actPlay     actKind = iota + 1 // a card
	actToep                        // raise the stake, on the turn to play
	actOvertoep                    // raise it again, asked about a toep
	actAnswer                      // play: go along with the toep, else pass
	actWas                         // play: claim a was, else not
	actCheck                       // play: check the claimed was, else let it go
	actDiscard                     // cards: laid away in the koningsspel
)

// action is one decision of a seat.
type action struct {
	kind  actKind
	play  bool
	card  cards.Card
	cards []cards.Card
}

func (p *play) opts() *Options { return p.t.Options().(*Options) }

// pace is toepen's own delays at the table's tempo.
func (p *play) pace() pacing {
	if pc, ok := pacings[p.t.Opts().Tempo]; ok {
		return pc
	}
	return pacings["normaal"]
}

func (p *play) Variant() string { return p.opts().variant() }

func (p *play) Start() {
	t := p.t
	n := t.Players()
	p.total = make([]int, n)
	p.winner = -1
	p.m = toepen.NewMatch(n, p.opts().rules(), cards.Seat(t.Deals().IntN(n)))
	p.rounds, p.courses = nil, nil
	// Without the seed: the table names it at game over (docs/server.md#the-seed).
	t.SysChat("Het spel begint: %s. Wie de laatste slag haalt, krijgt geen strafpunten. Veel plezier!", p.Variant())
	p.deal()
}

// deal deals the next round from the match's seed.
func (p *play) deal() {
	t := p.t
	p.d = p.m.Deal(toepen.Shuffle(t.Deals()))
	p.handNo = p.m.Round
	t.SetHand(p.handNo)
	p.acts, p.last, p.collected, p.told, p.stockTold = "", nil, false, 0, false
	p.course = nil
	t.SetPhase(p.phase())
	t.Pause(stepDealt, t.Pace().Deal)
	p.emit(evDeal{Type: "deal", HandNo: p.handNo, Dealer: p.d.Dealer(), Koning: p.d.Koning()})
	if d := p.d; d.Koning() {
		deal, lay := fmt.Sprintf("Ieder speelt met %d kaarten", d.Size()), ""
		if d.DealtSize() > d.Size() {
			deal = fmt.Sprintf("Ieder krijgt %d kaarten en speelt met %d", d.DealtSize(), d.Size())
			lay = fmt.Sprintf(" Leg er eerst %d dicht weg.", d.DealtSize()-d.Size())
		}
		t.SysChat("Koningsspel: iedereen die nog meedoet, staat op armoede. %s, zonder vuile was en zonder toepen: wie de laatste slag haalt, wint het spel.%s",
			deal, lay)
		t.BotsReact(1, 1200*time.Millisecond, func(i cards.Seat) (server.ChatEvent, bool) {
			return server.ChatEvent{Kind: "koning", Mine: true}, p.d.Status(i) == toepen.StatusIn
		})
	}
}

// phase is the room phase of the round in play.
func (p *play) phase() string {
	switch p.d.Phase() {
	case toepen.PhaseWas:
		return phaseWas
	case toepen.PhaseCheck:
		return phaseCheck
	case toepen.PhaseToep:
		return phaseToep
	case toepen.PhaseDiscard:
		return phaseDiscard
	}
	return phasePlay
}

func (p *play) Turn() cards.Seat {
	if p.d == nil {
		return cards.NoSeat
	}
	return p.d.Turn()
}

func (p *play) HandLen(i cards.Seat) int {
	if p.d == nil {
		return 0
	}
	return p.d.HandLen(i)
}

func (p *play) Single() bool {
	d := p.d
	return d != nil && d.Phase() == toepen.PhasePlay && len(d.Legal()) == 1 && !d.CanToep(d.Turn())
}

func (p *play) Resume(s server.Step) {
	t := p.t
	switch s {
	case stepDealt:
		if p.d.Phase() == toepen.PhaseWas {
			p.openWas()
			return
		}
		p.proceed()
	case stepWas:
		p.d.CloseWas()
		p.afterWas()
	case stepAnnounced:
		p.proceed()
	case stepCollect:
		p.collected = true
		w := p.last.Winner
		if p.d.Phase() == toepen.PhaseDone {
			p.emit(evCollect{Type: "collect", Winner: w})
			p.endRound()
			return
		}
		t.OpenTurn()
		p.emit(evCollect{Type: "collect", Winner: w})
	}
}

// proceed goes on in whatever the round awaits now: the announcement of
// armoede first, else the next turn, or the end of the round.
func (p *play) proceed() {
	t, d := p.t, p.d
	t.SetPhase(p.phase())
	p.tellStockOut()
	switch {
	case p.told < len(d.Checks()):
		p.tellShown() // vuile was on armoede, laid open on the table
	case d.Phase() == toepen.PhaseDone:
		p.endRound()
	case d.Phase() == toepen.PhaseWas:
		p.openWas() // new cards for a was: who got them may wash again
	case d.ArmoedeToep() && p.poorAt != p.handNo:
		p.poorAt = p.handNo
		var poor []cards.Seat
		var names []string
		for s := range cards.Seat(t.Players()) {
			if d.Armoede(s) && d.Status(s) == toepen.StatusIn {
				poor = append(poor, s)
				names = append(names, t.DisplayName(s))
			}
		}
		t.Pause(stepAnnounced, 2*t.Pace().Announce)
		p.emit(evArmoede{Type: "armoede", Seats: poor, Stake: d.Stake()})
		t.SysChat("Armoede: nog één strafpunt en %s %s eruit. De inzet is meteen %d.", joinNL(names),
			map[bool]string{true: "ligt", false: "liggen"}[len(names) == 1], d.Stake())
	default:
		t.OpenTurn()
		p.emit(nil)
	}
}

// ---- the was ----

// openWas opens the time for a was: everyone in the round says at once
// whether they have one (again: only who just got new cards). The bots
// decide in the background and answer after their think time; the time
// runs out after the pace's was.
func (p *play) openWas() {
	t, d := p.t, p.d
	t.SetPhase(phaseWas)
	t.Pause(stepWas, p.pace().was)
	p.wasGen++
	gen := p.wasGen
	for s := range cards.Seat(t.Players()) {
		if d.Status(s) != toepen.StatusIn || !t.BotPlays(s) || d.Answered(s) {
			continue
		}
		v := d.View(s)
		t.Think(s, func(brain any) any { return v.CanClaim && brain.(Brain).Was(v) }, func(a any) {
			claim, _ := a.(bool) // nil: the brain panicked, no claim
			if p.wasGen == gen && p.d == d && t.Pending() == stepWas && !d.Answered(s) && t.BotPlays(s) {
				p.was(s, claim)
			}
		})
	}
	p.emit(nil)
}

// was records the answer of seat i in the time for a was; after the last
// answer it is over at once.
func (p *play) was(i cards.Seat, claim bool) error {
	t, d := p.t, p.d
	if t.Pending() != stepWas || d.Phase() != toepen.PhaseWas {
		return toepen.ErrWrongPhase
	}
	if err := d.Was(i, claim); err != nil {
		return err
	}
	if claim {
		p.act(i, "w")
	}
	if d.Phase() == toepen.PhaseWas {
		p.emit(nil) // who has answered
		return nil
	}
	t.EndPause()
	p.afterWas()
	return nil
}

// afterWas announces the claims, if any, once the time for a was is over.
func (p *play) afterWas() {
	t, d := p.t, p.d
	var claims []cards.Seat
	for s := range cards.Seat(t.Players()) {
		if d.Claimed(s) {
			claims = append(claims, s)
		}
	}
	if len(claims) == 0 {
		p.proceed()
		return
	}
	t.SetPhase(p.phase())
	t.Pause(stepAnnounced, t.Pace().Announce)
	p.emit(evClaims{Type: "claims", Seats: claims})
	for _, s := range claims {
		t.BotSay(s, server.ChatEvent{Kind: "was", Mine: true}, 300*time.Millisecond)
	}
}

// ---- decisions ----

// The messages of toepen (games/toepen/README.md#protocol).
type toepMsg struct {
	Card  string   `json:"card"`
	Cards []string `json:"cards"`
	Play  *bool    `json:"play"`
	// aiOnly: fast or watch.
	Choice string `json:"choice"`
}

func (p *play) Move(i cards.Seat, m server.Msg) error {
	var msg toepMsg
	json.Unmarshal(m.Raw, &msg)
	var a action
	switch m.T {
	case "play":
		card, err := cards.ParseCard(msg.Card)
		if err != nil {
			return errors.New("Die kaart bestaat niet.")
		}
		a = action{kind: actPlay, card: card}
	case "discard":
		a = action{kind: actDiscard}
		for _, s := range msg.Cards {
			c, err := cards.ParseCard(s)
			if err != nil {
				return errors.New("Die kaart bestaat niet.")
			}
			a.cards = append(a.cards, c)
		}
	case "toep":
		a = action{kind: actToep}
	case "overtoep":
		a = action{kind: actOvertoep}
	case "why":
		return p.askWhy(i)
	case "aiOnly":
		return p.choose(i, msg.Choice)
	case "answer", "was", "check":
		if msg.Play == nil {
			return errors.New(map[string]string{
				"answer": "Kies meegaan of passen.", "was": "Zeg of je een vuile was hebt.", "check": "Kies controleren of laten gaan.",
			}[m.T])
		}
		a = action{kind: map[string]actKind{"answer": actAnswer, "was": actWas, "check": actCheck}[m.T], play: *msg.Play}
	default:
		return server.ErrUnknownMsg
	}
	if a.kind == actWas && (p.t.Pending() != stepWas || p.d == nil || p.d.Phase() != toepen.PhaseWas || p.d.Answered(i)) {
		return server.ErrIgnore // a late tap (the time for a was is over), or the answer again
	}
	if !p.t.InHand() {
		return errors.New("Dat kan nu niet.")
	}
	err := p.Apply(i, a)
	if errors.Is(err, toepen.ErrNotYourTurn) {
		return server.NotYourTurn(err)
	}
	return err
}

func (p *play) Decision(i cards.Seat, brain any) (func() any, any) {
	v := p.d.View(i)
	log := p.t.Logger()
	return func() any {
		a := decide(brain.(Brain), v)
		if a.kind == actPlay && !slices.Contains(v.Legal, a.card) {
			log.Error("bot played an illegal card", "card", a.card.String())
			return safe(v)
		}
		return a
	}, safe(v)
}

// decide asks the brain for the decision of view v.
func decide(b Brain, v toepen.View) action {
	switch v.Phase {
	case toepen.PhaseDiscard:
		return action{kind: actDiscard, cards: b.Discard(v)}
	case toepen.PhaseWas:
		return action{kind: actWas, play: v.CanClaim && b.Was(v)}
	case toepen.PhaseCheck:
		return action{kind: actCheck, play: b.Check(v)}
	case toepen.PhaseToep:
		if v.CanRaise && b.Overtoep(v) {
			return action{kind: actOvertoep}
		}
		return action{kind: actAnswer, play: v.MustStay || b.Answer(v)}
	case toepen.PhasePlay:
		if v.CanToep && b.Toep(v) {
			return action{kind: actToep}
		}
		return action{kind: actPlay, card: b.Play(v)}
	}
	return safe(v)
}

// safe is a legal decision without any thought: no was, no check, go
// along, the first legal card.
func safe(v toepen.View) action {
	switch v.Phase {
	case toepen.PhaseDiscard:
		return action{kind: actDiscard, cards: safeLay(v)}
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

// Apply plays decision a of seat i and emits the events.
func (p *play) Apply(i cards.Seat, a any) error {
	act, ok := a.(action)
	if !ok {
		return errors.New("onbekende actie")
	}
	t, d := p.t, p.d
	if !t.InHand() || d == nil {
		return toepen.ErrWrongPhase
	}
	if act.kind == actWas {
		return p.was(i, act.play)
	}
	if t.Pending() != 0 {
		return server.ErrPaused
	}
	pace := t.Pace()
	switch act.kind {
	case actDiscard:
		if err := d.Discard(i, act.cards); err != nil {
			return err
		}
		p.act(i, "x"+cardsString(act.cards))
		t.SetPhase(p.phase())
		t.OpenTurn()
		p.emit(evDiscard{Type: "discard", Seat: i, N: len(act.cards)})
	case actToep:
		if err := d.Toep(i); err != nil {
			return err
		}
		p.act(i, "t")
		t.SetPhase(phaseToep)
		t.Pause(stepAnnounced, pace.Announce)
		p.emit(evToep{Type: "toep", Seat: i, Stake: d.Stake()})
		p.autoStays()
		t.BotSay(i, server.ChatEvent{Kind: "toep", Mine: true, Points: d.Stake()}, 200*time.Millisecond)
	case actOvertoep:
		if err := d.Overtoep(i); err != nil {
			return err
		}
		p.act(i, "o")
		t.SetPhase(phaseToep)
		t.Pause(stepAnnounced, pace.Announce)
		p.emit(evToep{Type: "toep", Seat: i, Stake: d.Stake(), Over: true})
		p.autoStays()
		t.BotSay(i, server.ChatEvent{Kind: "overtoep", Mine: true, Points: d.Stake()}, 200*time.Millisecond)
	case actAnswer:
		stake, passCost := d.Stake(), d.PassCost(i)
		before := len(d.Tricks())
		if err := d.Answer(i, act.play); err != nil {
			return err
		}
		p.act(i, map[bool]string{true: "a1", false: "a0"}[act.play])
		ev := evAnswer{Type: "answer", Seat: i, Stay: act.play}
		// The bot says what it did, never before: a line and a decision that agree.
		if act.play {
			if d.Toeper() != cards.NoSeat {
				t.BotSay(i, server.ChatEvent{Kind: "stay", Mine: true, Points: stake}, 300*time.Millisecond)
			}
		} else {
			ev.Points = passCost
			t.BotSay(i, server.ChatEvent{Kind: "pass", Mine: true, Points: ev.Points}, 300*time.Millisecond)
		}
		t.SetPhase(p.phase())
		if len(d.Tricks()) > before {
			// The toeper passed on an overtoep before its card, the last
			// to play to the trick: the trick is complete.
			tr := d.Tricks()[before]
			p.last, p.collected = &tr, false
			t.Trick()
			t.Pause(stepCollect, pace.Trick)
			p.emit(ev)
			p.emit(evTrick{Type: "trick", Winner: tr.Winner, Last: d.Phase() == toepen.PhaseDone})
			break
		}
		if d.Phase() == toepen.PhaseDone {
			p.emit(ev)
			p.endRound()
			return nil
		}
		t.OpenTurn()
		p.emit(ev)
	case actCheck:
		claimant := d.Claimant()
		res, err := d.Check(i, act.play)
		if err != nil {
			return err
		}
		p.act(i, map[bool]string{true: "c1", false: "c0"}[act.play])
		ev := evCheck{Type: "check", Seat: i, Claimant: claimant, Check: act.play}
		if res == nil { // the next is asked
			t.OpenTurn()
			p.emit(ev)
			break
		}
		if d.Phase() != toepen.PhaseWas { // else the next time for a was opens after the announcement
			t.SetPhase(p.phase())
		}
		wait := pace.Announce
		if res.Checker != cards.NoSeat {
			wait = 3 * pace.Announce // the hand is shown: time to look
		}
		t.Pause(stepAnnounced, wait)
		p.emit(ev)
		p.emit(wasDone(*res))
		p.told++
		p.chatCheck(res)
	case actPlay:
		before := len(d.Tricks())
		if err := d.Play(i, act.card); err != nil {
			return err
		}
		p.act(i, act.card.String())
		if len(d.Tricks()) == before {
			t.OpenTurn()
			p.emit(evPlay{Type: "play", Seat: i, Card: act.card})
			break
		}
		tr := d.Tricks()[before]
		p.last, p.collected = &tr, false
		t.Trick()
		t.Pause(stepCollect, pace.Trick)
		p.emit(evPlay{Type: "play", Seat: i, Card: act.card})
		p.emit(evTrick{Type: "trick", Winner: tr.Winner, Last: d.Phase() == toepen.PhaseDone})
	default:
		return errors.New("onbekende actie")
	}
	return nil
}

// emit sends ev to the table (nil: the state alone). The events everyone
// saw happen in a round are also its course, which the overview at game
// over shows (games/toepen/README.md#protocol): the claims of a vuile was
// and how each was settled, armoede, the cards laid away, the toeps, the
// answers, the cards played and who took each trick. Not the questions
// about a check, which wasDone settles.
func (p *play) emit(ev any) {
	switch ev.(type) {
	case evClaims, evWasDone, evArmoede, evDiscard, evToep, evAnswer, evPlay, evTrick:
		p.course = append(p.course, ev)
	}
	p.t.Emit(ev)
}

// act adds a decision to the round's log: the seat, then "x" and the
// cards laid away (the koningsspel), "w" (a was claimed), "c1"/"c0"
// (checked or not), "t" (toep), "o" (overtoep), "a1"/"a0" (went along or
// passed) or a card.
func (p *play) act(i cards.Seat, what string) {
	if p.acts != "" {
		p.acts += " "
	}
	p.acts += string(rune('0'+i)) + what
}

// ---- the end of a round and of the match ----

// endRound takes the penalty points of the round and shows its summary.
func (p *play) endRound() {
	t, d := p.t, p.d
	res := d.Result()
	wasOut := make([]bool, t.Players())
	for s := range wasOut {
		wasOut[s] = !p.m.Alive(cards.Seat(s))
	}
	p.m.Settle(d)
	copy(p.total, res.Points)
	row := round{Hand: p.handNo, Dealer: d.Dealer(), Winner: res.Winner, Stake: res.Stake, Tricks: res.Tricks,
		Boer: res.Boer, Koning: res.Koning, Gains: res.Gains, Points: res.Points, Out: res.Out}
	p.rounds = append(p.rounds, row)
	p.courses = append(p.courses, nonNil(p.course))
	p.logRound(row)
	t.Summary(evRound{Type: "handEnd", Result: row}, p.pace().round) // short, as a round: on by itself, also alone
	for s := range cards.Seat(t.Players()) {
		if res.Out[s] && !wasOut[s] {
			t.SysChat("%s ligt eruit met %d strafpunten.", t.DisplayName(s), res.Points[s])
			t.BotSay(s, server.ChatEvent{Kind: "out", Mine: true}, 900*time.Millisecond)
		}
	}
	won := "wonRound"
	if res.Boer {
		won = "boer"
		if res.Gains[res.Winner] < 0 {
			t.SysChat("%s haalt de laatste slag met de boer: een strafpunt eraf.", t.DisplayName(res.Winner))
		}
	}
	if !res.Out[res.Winner] && !t.BotSay(res.Winner, server.ChatEvent{Kind: won, Mine: true, Points: res.Stake}, 700*time.Millisecond) &&
		res.Stake >= 3 {
		t.BotsReact(1, 1100*time.Millisecond, func(i cards.Seat) (server.ChatEvent, bool) {
			return server.ChatEvent{Kind: "lostRound", Mine: true, Points: res.Gains[i]}, i != res.Winner && res.Gains[i] > 0
		})
	}
}

// Next deals the next round, or ends the match when one player is left.
func (p *play) Next() {
	if !p.m.Over() {
		p.deal()
		return
	}
	t := p.t
	w := p.m.Winner()
	p.winner = int(w)
	t.SysChat("%s wint het spel na %d %s!", t.DisplayName(w), p.handNo, map[bool]string{true: "potje", false: "potjes"}[p.handNo == 1]) // before the table's line with the seed
	t.GameOver(slices.Clone(p.total), p.winner)
	t.BotsReact(2, 1800*time.Millisecond, func(i cards.Seat) (server.ChatEvent, bool) {
		if i == w {
			return server.ChatEvent{Kind: "gameWon", Mine: true}, true
		}
		return server.ChatEvent{Kind: "gameLost", Mine: true}, true
	})
	t.Logger().Info("match over", "game", "toepen", "rounds", p.handNo, "points", p.total)
}

// ---- chat ----

// chatCheck tells the table how a claimed was ended.
func (p *play) chatCheck(res *toepen.Check) {
	t := p.t
	who := t.DisplayName(res.Claimant)
	switch {
	case res.Shown:
		t.SysChat("%s staat op armoede en legt een echte %s open op tafel: vier nieuwe kaarten.", who, res.Kind.NameNL())
	case res.Checker == cards.NoSeat:
		t.SysChat("Niemand controleert de vuile was van %s: die legt vier kaarten dicht weg en krijgt vier nieuwe.", who)
	case res.Genuine():
		t.SysChat("%s controleert de vuile was van %s: een echte %s. %s krijgt een strafpunt, %s vier nieuwe kaarten.",
			t.DisplayName(res.Checker), who, res.Kind.NameNL(), t.DisplayName(res.Checker), who)
		t.BotSay(res.Checker, server.ChatEvent{Kind: "checkWrong", Mine: true}, 900*time.Millisecond)
	default:
		then := "speelt dit potje niet mee"
		if p.d.Open(res.Claimant) {
			then = "neemt de kaarten terug en speelt open verder"
		}
		t.SysChat("%s controleert de vuile was van %s: geen vuile was! %s krijgt een strafpunt en %s.",
			t.DisplayName(res.Checker), who, who, then)
		if !t.BotSay(res.Claimant, server.ChatEvent{Kind: "caught", Mine: true}, 900*time.Millisecond) {
			t.BotSay(res.Checker, server.ChatEvent{Kind: "checkRight", Mine: true}, 900*time.Millisecond)
		}
	}
}

// ---- the reasoning of the AI (games/toepen/README.md#redenering-van-de-ai) ----

// whyAnswer is an explanation for seat's decision key.
type whyAnswer struct {
	seat cards.Seat
	key  string
	e    Explanation
}

// yours reports whether the round awaits a decision of seat i: its turn,
// or its answer in the time for a was.
func (p *play) yours(i cards.Seat) bool {
	t, d := p.t, p.d
	switch {
	case d == nil || !t.InHand():
		return false
	case d.Phase() == toepen.PhaseWas:
		return t.Pending() == stepWas && d.Status(i) == toepen.StatusIn && !d.Answered(i)
	}
	return d.Turn() == i
}

// decisionKey names the decision the round awaits now.
func (p *play) decisionKey(i cards.Seat) string {
	d := p.d
	return fmt.Sprintf("%d/%d/%s/%d/%d/%d/%d/%d", p.handNo, i, d.Phase(), d.WasRound(), len(d.Tricks()), len(d.Current().Cards),
		d.Stake(), len(d.Asking()))
}

// askWhy works out the reasoning for seat i's decision now, in the
// background, and puts it in that player's state. Only for a player alone
// with bots: at a table with friends it would be help nobody else has.
func (p *play) askWhy(i cards.Seat) error {
	t := p.t
	ex, ok := p.ai.(Explainer)
	switch {
	case !ok:
		return errors.New("Aan deze tafel kan de AI geen redenering geven.")
	case t.HumanCount() > 1:
		return errors.New("De redenering van de AI kun je alleen opvragen als je zonder andere mensen speelt.")
	case !p.yours(i):
		return errors.New("Je bent nu niet aan zet.")
	case p.explaining:
		return errors.New("Even geduld: de AI denkt nog na over je vorige vraag.")
	}
	v, key := p.d.View(i), p.decisionKey(i)
	seed := uint64(p.handNo)<<32 ^ uint64(len(p.acts))
	p.explaining = true
	t.Background(func() any { return ex.Explain(v, seed) }, func(a any) {
		p.explaining = false
		e, ok := a.(Explanation)
		if !ok {
			e = Explanation{Chance: -1, Why: "De AI kon hier niets over zeggen.", Options: []WhyOption{}}
		}
		p.why = &whyAnswer{seat: i, key: key, e: e}
		p.emit(nil)
	})
	return server.ErrIgnore // the answer comes in the state
}

// whyFor is the explanation for seat i's decision now, if it asked.
func (p *play) whyFor(i cards.Seat) *Explanation {
	if w := p.why; w != nil && w.seat == i && p.yours(i) && w.key == p.decisionKey(i) {
		return &w.e
	}
	return nil
}

// safeLay is the cards to lay away without any thought: the weakest.
func safeLay(v toepen.View) []cards.Card {
	if v.Lay <= 0 || v.Lay > len(v.Hand) {
		return nil
	}
	h := slices.Clone(v.Hand)
	slices.SortStableFunc(h, func(a, b cards.Card) int { return toepen.Strength(a.Rank) - toepen.Strength(b.Rank) })
	return h[:v.Lay]
}

// autoStays tells the table who went along with a raise without being
// asked: passing would have put them out.
func (p *play) autoStays() {
	for _, o := range p.d.AutoStays() {
		p.act(o, "a1")
		p.emit(evAnswer{Type: "answer", Seat: o, Stay: true, Auto: true})
	}
}

// tellStockOut says once a round that new cards of a vuile was cannot be
// washed again: the stock ran out.
func (p *play) tellStockOut() {
	if p.d.StockOut() && !p.stockTold {
		p.stockTold = true
		p.t.SysChat("De stapel is op: wie nieuwe kaarten kreeg, kan niet nog eens wassen.")
	}
}

// tellShown tells the table of the claims settled without a question: on
// armoede the hand is laid open on the table a moment (three times an
// announcement), and four new cards follow.
func (p *play) tellShown() {
	t, d := p.t, p.d
	checks := d.Checks()
	t.Pause(stepAnnounced, 3*t.Pace().Announce)
	for ; p.told < len(checks); p.told++ {
		c := checks[p.told]
		p.emit(wasDone(c))
		p.chatCheck(&c)
	}
}

// wasDone is the event of a settled claim.
func wasDone(c toepen.Check) evWasDone {
	return evWasDone{Type: "wasDone", Claimant: c.Claimant, Checker: c.Checker, Kind: c.Kind,
		Cards: nonNil(toepen.SortHand(c.Cards)), Genuine: c.Genuine(), Washed: c.Washed(), Shown: c.Shown}
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
