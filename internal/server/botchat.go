package server

import (
	"fmt"
	"time"

	"klaverjas/internal/game"
)

// botChatGap is the least time between two lines of one bot, divided by its
// Chattiness: chatty bots talk more often.
const botChatGap = 8 * time.Second

// botSay lets the bot at seat i react to ev, within its limits: one line
// per trick and one per gap. The line appears after delay (scaled). It
// reports whether the bot speaks.
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
		return false
	}
	st.lastChat, st.chatAt = now, r.trickNo
	m := chatMsg{Seat: int(i), Name: botName(st.persona), Text: text, Bot: true}
	r.later(r.scaled(delay), func() {
		m.TS = time.Now().UnixMilli()
		r.addChat(m)
	})
	return true
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
	order := r.rng.Perm(4)
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

// greet: up to two bots say hello as the match starts.
func (r *room) greet() {
	r.botsReact(2, 2500*time.Millisecond, func(game.Seat) (ChatEvent, bool) {
		return ChatEvent{Kind: "greet"}, true
	})
}

// chatTrick: comments on roem, a big trick, or a partner's good trick.
func (r *room) chatTrick(t game.Trick) {
	team := t.Winner.Team()
	if roem := t.RoemTotal(); roem > 0 {
		r.botsReact(1, 900*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
			return ChatEvent{Kind: "roem", Mine: i.Team() == team, Points: roem}, true
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
	partner := t.Winner.Partner()
	r.botSay(partner, ChatEvent{Kind: "partnerGood", Mine: true, Points: t.Points}, 700*time.Millisecond)
}

// chatHandEnd: one bot comments on pit, nat or the result.
func (r *room) chatHandEnd(res game.HandResult) {
	r.botsReact(1, 1500*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		team := i.Team()
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
		if i.Team() == r.winner {
			return ChatEvent{Kind: "gameWon", Mine: true}, true
		}
		return ChatEvent{Kind: "gameLost", Mine: true}, true
	})
}

// botReply: now and then a bot answers a human's chat line.
func (r *room) botReply(from game.Seat, text string) {
	if r.rng.Float64() > 0.6 {
		return
	}
	r.botsReact(1, 1400*time.Millisecond, func(i game.Seat) (ChatEvent, bool) {
		return ChatEvent{Kind: "reply", Text: text}, i != from
	})
}
