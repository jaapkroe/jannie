package server

import (
	"klaverjas/internal/game"
)

// A server plays one game (Config.Game). The room is the table every game
// shares: codes and links, seats and the lobby, bots, chat, calls,
// reconnects, the question whether an AI may play for someone who is gone,
// pacing and limits. The game on it is a gameplay: klaverjas, built in on
// the match code in match.go, state.go, review.go, lesson.go and
// expert.go (adapted below), or a game on the exported API (api.go),
// adapted by extPlay (ext.go).

// gameplay is what the table needs from the game on it. Every method runs
// on the room goroutine.
type gameplay interface {
	// start deals the first hand of a match; the seats are filled and the
	// match's seed drawn (r.deals).
	start()
	// lobby is the table back in the lobby after a match (cmdLobby).
	lobby()
	// turn is the seat whose decision the game waits for, NoSeat when it
	// waits for nobody in particular (a pause, or everyone at once).
	turn() game.Seat
	// handLen is the number of cards seat i holds, for players[i].cards.
	handLen(i game.Seat) int
	// state is the full state `s` of an update for seat i.
	state(i game.Seat) any
	// move handles a message of the human at seat i that belongs to the
	// game; false when m is none of its messages.
	move(c *client, i game.Seat, m *inMsg) bool
	// decision is the decision of the bot (or substitute) at seat i for
	// this turn, to work out in the background with bb (it must not touch
	// the room), and a safe one for when that comes out illegal.
	decision(i game.Seat, bb *brainBox) (think func() any, safe any)
	// apply plays decision a of the bot at seat i.
	apply(i game.Seat, a any) error
	// single reports whether the decision on turn has one option: the bot
	// then thinks shorter.
	single() bool
	// resume goes on after the pause s (runPending).
	resume(s step)
	// next deals the next hand after the summary, or ends the match.
	next()
}

// klaverjas is the built-in game, on the code it always had.
type klaverjas struct{ r *room }

func (k klaverjas) start() { k.r.startKlaverjas() }

// lobby: cmdLobby clears the match itself.
func (k klaverjas) lobby() {}

func (k klaverjas) turn() game.Seat {
	if k.r.deal == nil {
		return game.NoSeat
	}
	return k.r.deal.Turn()
}

func (k klaverjas) handLen(i game.Seat) int {
	if k.r.deal == nil {
		return 0
	}
	return k.r.deal.HandLen(i)
}

func (k klaverjas) state(i game.Seat) any { return k.r.stateFor(i) }

func (k klaverjas) move(c *client, i game.Seat, m *inMsg) bool { return k.r.klaverjasMove(c, i, m) }

func (k klaverjas) decision(i game.Seat, bb *brainBox) (func() any, any) {
	v := k.r.viewFor(i)
	return func() any { return bb.decide(v) }, fallback(v)
}

func (k klaverjas) apply(i game.Seat, a any) error {
	act, _ := a.(action)
	return k.r.act(i, act)
}

func (k klaverjas) single() bool {
	d := k.r.deal
	return d != nil && d.Phase() == game.PhasePlay && len(d.Legal()) == 1
}

func (k klaverjas) resume(s step) { k.r.resumeKlaverjas(s) }

func (k klaverjas) next() { k.r.nextHand() }

// klaverjasMove handles the messages of klaverjas: the decisions of a
// hand, and the training, review and expert requests.
func (r *room) klaverjasMove(c *client, i game.Seat, m *inMsg) bool {
	switch m.T {
	case "auction":
		if m.Bid == nil {
			c.sendError(errInvalid, "Bied een aantal punten of pas.")
			return true
		}
		r.humanAct(c, i, action{kind: actAuction, bid: *m.Bid})
	case "discard":
		var a action
		if len(m.Cards) != 2 {
			c.sendError(errInvalid, game.ErrBadDiscard.Error())
			return true
		}
		for k, code := range m.Cards {
			card, err := game.ParseCard(code)
			if err != nil {
				c.sendError(errInvalid, "Die kaart bestaat niet.")
				return true
			}
			a.cards[k] = card
		}
		a.kind = actDiscard
		r.humanAct(c, i, a)
	case "trump":
		s, err := game.ParseSuit(m.Suit)
		if err != nil {
			c.sendError(errInvalid, "Kies een kleur: klaveren, ruiten, harten of schoppen.")
			return true
		}
		r.humanAct(c, i, action{kind: actTrump, suit: s})
	case "bid":
		if m.Play == nil {
			c.sendError(errInvalid, "Kies spelen of passen.")
			return true
		}
		r.humanAct(c, i, action{kind: actBid, play: *m.Play})
	case "play":
		card, err := game.ParseCard(m.Card)
		if err != nil {
			c.sendError(errInvalid, "Die kaart bestaat niet.")
			return true
		}
		r.humanAct(c, i, action{kind: actPlay, card: card})
	case "tipRead":
		r.cmdTipRead(m.N)
	case "handReview":
		r.cmdHandReview(c, i, m)
	case "why":
		r.cmdWhy(c, i, m)
	case "feedback":
		r.cmdFeedback(c, i, m)
	default:
		return false
	}
	return true
}
