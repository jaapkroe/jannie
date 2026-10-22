package server

import (
	"time"

	"klaverjas/internal/game"
)

// stateFor builds the full state `s` for the player at seat i (design §7).
func (r *room) stateFor(i game.Seat) *state {
	s := &state{
		Code:        r.code,
		Phase:       r.phase,
		Opts:        r.opts,
		Training:    r.training,
		You:         int(i),
		Host:        int(r.host),
		HandNo:      r.handNo,
		Hands:       r.opts.Hands,
		Dealer:      -1,
		Voorhand:    -1,
		Bids:        [4]int{-1, -1, -1, -1},
		TrumpBy:     -1,
		PlayingTeam: -1,
		Turn:        -1,
		Hand:        []game.Card{},
		Scores:      r.scores,
		Total:       r.total,
		PrevHand:    r.prev,
		LastTrick:   r.lastTrick,
		Winner:      -1,
	}
	if s.Scores == nil {
		s.Scores = []scoreRow{}
	}
	for k := range r.seats {
		s.Players[k] = r.playerState(game.Seat(k))
	}
	switch r.phase {
	case phaseLobby:
		s.Roster = r.roster()
		return s
	case phaseHandEnd:
		s.NextAt = unixMilli(r.nextAt)
	case phaseGameOver:
		s.Winner = r.winner
		s.Review = r.reviewFor(i)
	}
	d := r.deal
	if d == nil {
		return s
	}
	s.Dealer, s.Voorhand = int(d.Dealer()), int(d.Voorhand())
	s.Bids, s.Forced = d.Bids(), d.Forced()
	if d.Mode() == game.Gedraaid {
		t := d.Turned()
		s.Turned = &t
	}
	trump, known := d.Trump()
	if known {
		s.Trump = &trump
		s.TrumpBy = int(d.TrumpBy())
		s.PlayingTeam = d.PlayingTeam()
	}
	s.TricksWon, s.HandPoints, s.HandRoem = d.TricksWon(), d.HandPoints(), d.HandRoem()
	if !r.inHand() {
		return s
	}
	s.Hand = game.SortHand(d.Hand(i), trump, known)
	s.Trick = r.shownTrick()
	if r.pending == stepNone {
		s.Turn = int(d.Turn())
	}
	if s.Turn == int(i) {
		if d.Phase() == game.PhasePlay {
			legal := d.Legal()
			s.Legal = make([]game.Card, 0, len(legal))
			for _, c := range s.Hand {
				for _, l := range legal {
					if c == l {
						s.Legal = append(s.Legal, c)
					}
				}
			}
			v := d.View(i)
			s.Rule = game.ExplainConstraint(v.Hand, v.Current, i, trump, d.Rules())
		}
		if r.training {
			s.Hint = r.hintFor(i)
		}
	}
	if r.training && r.opts.Open {
		var all [4][]game.Card
		for k := range all {
			all[k] = game.SortHand(d.Hand(game.Seat(k)), trump, known)
		}
		s.Hands4 = &all
	}
	return s
}

// shownTrick is the trick on the table: the complete trick until it is
// collected, then the empty next trick led by its winner.
func (r *room) shownTrick() *game.Trick {
	t := r.deal.Current()
	if t.Complete() && r.collected {
		return &game.Trick{Leader: t.Winner, Winner: game.NoSeat, Cards: []game.Played{}}
	}
	return &t
}

func (r *room) playerState(i game.Seat) *playerState {
	st := &r.seats[i]
	cards := 0
	if r.inHand() && r.deal != nil {
		cards = r.deal.HandLen(i)
	}
	switch st.kind {
	case seatHuman:
		return &playerState{
			Name:      st.name,
			Connected: st.client != nil,
			Away:      st.away,
			Cards:     cards,
			Ready:     st.ready && r.phase == phaseHandEnd,
		}
	case seatBot:
		p := st.persona
		return &playerState{
			Name:      botName(p),
			Bot:       true,
			BotID:     p.ID,
			Emoji:     p.Emoji,
			Color:     p.Color,
			Connected: true,
			Cards:     cards,
		}
	}
	return nil
}

func (r *room) roster() []rosterEntry {
	out := make([]rosterEntry, len(r.srv.personas))
	for k, p := range r.srv.personas {
		out[k] = rosterEntry{ID: p.ID, Name: p.Name, Emoji: p.Emoji, Color: p.Color, Bio: p.Bio}
	}
	return out
}

// emitState sends a state change without an animation.
func (r *room) emitState() {
	if r.phase == phaseLobby {
		r.emit(evLobby{Type: "lobby"})
		return
	}
	r.emit(nil)
}

// unixMilli is t in unix ms, 0 for the zero time.
func unixMilli(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}
