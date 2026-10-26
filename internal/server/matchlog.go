package server

import (
	crand "crypto/rand"
	"encoding/binary"
	"math/rand/v2"
	"time"

	"klaverjas/internal/game"
)

// maxSeed bounds a seed someone types (option seed) and every seed drawn,
// so the Spelanalyse shows a number of at most nine digits.
const maxSeed = 999_999_999

// newSeed draws the seed of a match without a fixed one.
func newSeed() uint64 {
	var b [8]byte
	crand.Read(b[:])
	return binary.LittleEndian.Uint64(b[:])%maxSeed + 1
}

// dealRNG is the stream every deal of a match is drawn from: the first
// dealer, the cards and the turned suit, nothing else. So the same seed and
// options give the same cards, whatever the players do (design §3 seed).
func dealRNG(seed uint64) *rand.Rand {
	return rand.New(rand.NewPCG(seed, seed^0x6b6c61766572))
}

// logPlayerAt is who sits at seat i now.
func (r *room) logPlayerAt(i game.Seat) logPlayer {
	st := &r.seats[i]
	p := logPlayer{Seat: int(i), Name: r.displayName(i)}
	switch {
	case st.kind == seatBot:
		p.Bot, p.Level = st.persona.ID, r.opts.AI
	case st.away && st.client == nil:
		p.Bot, p.Level = "invaller", "normaal" // an AI plays for the absent player (see decide)
	case st.client != nil:
		p.IP, p.Device = st.client.ip, st.client.device
	}
	return p
}

// logMatch records a match that starts, with the version of the server,
// its seed and players.
func (r *room) logMatch() {
	rec := logMatch{T: "match", Match: r.matchID, Room: r.code, At: time.Now().UTC(), Version: r.srv.cfg.Version, Seed: r.seed,
		Training: r.training, Expert: r.expert, Opts: r.opts}
	for i := range r.players() {
		rec.Players = append(rec.Players, r.logPlayerAt(game.Seat(i)))
	}
	r.srv.games.write(rec)
}

// logSeat records that seat i changed hands during the match.
func (r *room) logSeat(i game.Seat) {
	if r.matchID == "" || r.phase == phaseLobby {
		return
	}
	r.srv.games.write(logSeat{T: "seat", Match: r.matchID, At: time.Now().UTC(), Hand: r.handNo, Player: r.logPlayerAt(i)})
}

// logHand records the hand just finished.
func (r *room) logHand(res game.HandResult) {
	rec := logHand{T: "hand", Match: r.matchID, At: time.Now().UTC(), Hand: r.handNo, Dealer: r.deal.Dealer(),
		Turned: r.deal.Turned(), Acts: r.acts, Talon: cardsString(r.dealt.talon), Result: res}
	for i := range r.players() {
		rec.Cards = append(rec.Cards, cardsString(r.dealt.hands[i]))
	}
	r.srv.games.write(rec)
}

// logEnd records the end of the match.
func (r *room) logEnd() {
	r.srv.games.write(logEnd{T: "end", Match: r.matchID, At: time.Now().UTC(), Total: r.total, Winner: r.winner})
}

// logClose records a room that goes before its match is over.
func (r *room) logClose(reason string) {
	if r.matchID == "" || r.phase == phaseLobby || r.phase == phaseGameOver {
		return
	}
	r.srv.games.write(logClose{T: "close", Match: r.matchID, At: time.Now().UTC(), Hand: r.handNo, Reason: reason})
}

// logReview records the review of seat i once, when it is complete.
func (r *room) logReview(i game.Seat, rv *review) {
	if rv.logged {
		return
	}
	out := r.reviewFor(i)
	if out == nil || out.Pending {
		return
	}
	rv.logged = true
	out.Replay = nil
	r.srv.games.write(logReview{T: "review", Match: r.matchID, At: time.Now().UTC(), Seat: int(i), Name: r.displayName(i), Review: out})
}
