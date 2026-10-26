package server

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"klaverjas/internal/game"
)

// botChatGap is the least time between two lines of one bot, divided by its
// Chattiness: chatty bots talk more often.
const botChatGap = 8 * time.Second

const (
	botChatMemory = 2 // lines per event kind a bot does not repeat
	botChatTries  = 6 // asks for a line it did not say just now
)

// botSay lets the bot at seat i react to ev, within its limits: one line
// per trick and one per gap, and not one of its latest lines for this kind
// of event (it stays silent rather than repeat itself). The line appears
// after delay (scaled). It reports whether the bot speaks.
func (r *room) botSay(i game.Seat, ev ChatEvent, delay time.Duration) bool {
	st := &r.seats[i]
	if st.kind != seatBot {
		return false
	}
	now := time.Now()
	gap := r.scaled(time.Duration(float64(botChatGap) / max(st.persona.Chattiness, 0.2)))
	if st.chatAt == r.trickNo || (!st.lastChat.IsZero() && now.Sub(st.lastChat) < gap) {
		return false
	}
	text := cleanChat(r.aiChat(st.persona.ID, ev))
	if text == "" {
		return false // nothing to say about this
	}
	// The bot chose to speak; a later "" only means its dice said no again.
	for try := 1; st.saidLately(ev.Kind, text); try++ {
		if try == botChatTries {
			return false
		}
		text = cleanChat(r.aiChat(st.persona.ID, ev))
	}
	st.remember(ev.Kind, text)
	st.lastChat, st.chatAt = now, r.trickNo
	m := chatMsg{Seat: int(i), Name: botName(st.persona), Text: text, Bot: true}
	r.later(r.scaled(delay), func() {
		m.TS = time.Now().UnixMilli()
		r.addChat(m)
	})
	return true
}

// saidLately reports whether text is one of the bot's latest lines for
// kind ("" counts as said, so it is asked again). Numbers do not count:
// "20 roem. Niet slecht." and "50 roem. Niet slecht." are the same line.
func (st *seat) saidLately(kind, text string) bool {
	if text == "" {
		return true
	}
	return slices.Contains(st.said[kind], lineKey(text))
}

// remember keeps text among the bot's latest lines for kind. A new persona
// starts with an empty memory (newBot).
func (st *seat) remember(kind, text string) {
	if st.said == nil {
		st.said = make(map[string][]string)
	}
	lines := append(st.said[kind], lineKey(text))
	if len(lines) > botChatMemory {
		lines = lines[len(lines)-botChatMemory:]
	}
	st.said[kind] = lines
}

// lineKey is a chat line with every number replaced by #.
func lineKey(text string) string {
	var b strings.Builder
	digits := false
	for _, r := range text {
		if unicode.IsDigit(r) {
			if !digits {
				b.WriteByte('#')
			}
			digits = true
			continue
		}
		digits = false
		b.WriteRune(r)
	}
	return b.String()
}

func (r *room) aiChat(id string, ev ChatEvent) (text string) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("Chat panicked", "panic", fmt.Sprint(p))
			text = ""
		}
	}()
	return r.srv.cfg.AI.Chat(id, ev, r.rng)
}

// botsReact offers ev to the bots in random order until n of them spoke;
// mk adapts the event per bot. Later lines get a little more delay.
func (r *room) botsReact(n int, delay time.Duration, mk func(i game.Seat) (ChatEvent, bool)) {
	order := r.rng.Perm(r.players())
	for _, k := range order {
		if n == 0 {
			return
		}
		i := game.Seat(k)
		if r.seats[i].kind != seatBot {
			continue
		}
		ev, ok := mk(i)
		if ok && r.botSay(i, ev, delay) {
			n--
			delay += 1500 * time.Millisecond
		}
	}
}

// greet: up to two bots say hello as the match starts. With lessons Juf
// Jannie introduces herself in the first one instead.
func (r *room) greet() {
	r.botsReact(2, 2500*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		return ChatEvent{Kind: "greet"}, !r.lessonsOn() || i != r.learner().Partner()
	})
}

// chatTrump: the bot that made trump comments on it; if it says nothing (or
// a human chose), a bot of the other side may comment instead.
func (r *room) chatTrump(maker game.Seat) {
	if r.botSay(maker, ChatEvent{Kind: "trump", Mine: true}, 700*time.Millisecond) {
		return
	}
	d := r.deal
	r.botsReact(1, 1200*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		return ChatEvent{Kind: "trump"}, d.Side(i) != d.Side(maker)
	})
}

// chatTrick: comments on roem, a big trick, or a partner's good trick.
func (r *room) chatTrick(t game.Trick) {
	d := r.deal
	team := d.Side(t.Winner)
	if roem := t.RoemTotal(); roem > 0 {
		r.botsReact(1, 900*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
			return ChatEvent{Kind: "roem", Mine: d.Side(i) == team, Points: roem}, true
		})
		return
	}
	if t.Points < 25 || r.rng.Float64() > 0.5 {
		return
	}
	if r.seats[t.Winner].kind == seatBot {
		r.botSay(t.Winner, ChatEvent{Kind: "wonTrick", Mine: true, Points: t.Points}, 700*time.Millisecond)
		return
	}
	// A human took it: the partner praises it, or else an opponent sighs.
	if p := d.Partner(t.Winner); p != game.NoSeat &&
		r.botSay(p, ChatEvent{Kind: "partnerGood", Mine: true, Points: t.Points}, 700*time.Millisecond) {
		return
	}
	r.botsReact(1, 900*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		return ChatEvent{Kind: "wonTrick", Points: t.Points}, d.Side(i) != team
	})
}

// chatHandEnd: one bot comments on pit, nat or the result.
func (r *room) chatHandEnd(res game.HandResult) {
	d := r.deal
	r.botsReact(1, 1500*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		team := d.Side(i)
		switch {
		case res.Pit:
			return ChatEvent{Kind: "pit", Mine: team == res.PitTeam, Points: game.PitBonus}, true
		case res.Nat && team == res.PlayingTeam:
			return ChatEvent{Kind: "nat", Mine: true}, true
		case res.Nat:
			return ChatEvent{Kind: "natOpp"}, true
		case res.Score[team] > res.Score[1-team]:
			return ChatEvent{Kind: "handWon", Mine: true, Points: res.Score[team]}, true
		default:
			return ChatEvent{Kind: "handLost", Mine: true, Points: res.Score[team]}, true
		}
	})
}

// chatGameOver: up to two bots say goodbye; nobody gloats over a draw.
func (r *room) chatGameOver() {
	if r.winner < 0 {
		return
	}
	r.botsReact(2, 1800*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		if game.ScorerOf(i, r.players()) == r.winner {
			return ChatEvent{Kind: "gameWon", Mine: true}, true
		}
		return ChatEvent{Kind: "gameLost", Mine: true}, true
	})
}

// botReply: now and then a bot answers a human's chat line. The event says
// whether the bot is the speaker's partner and, while tricks are played,
// whether the bot's side made trump: "Nat!" means something else then.
// With fewer than four players partners exist only within a hand: the
// soloist's two opponents.
func (r *room) botReply(from game.Seat, text string) {
	if r.rng.Float64() > 0.6 {
		return
	}
	inHand := r.phase == phasePlay && r.deal != nil
	playing := -1
	if inHand {
		playing = r.deal.PlayingTeam()
	}
	r.botsReact(1, 1400*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		partner := i.Team() == from.Team()
		side := i.Team()
		if r.players() != 4 {
			partner, side = false, -2
			if r.deal != nil {
				partner, side = r.deal.Partner(i) == from, r.deal.Side(i)
			}
		}
		return ChatEvent{Kind: "reply", Text: text, Mine: partner,
			InHand: inHand, Playing: side == playing}, i != from
	})
}
