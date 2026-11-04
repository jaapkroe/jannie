package toepbot

import (
	"math/rand/v2"
	"slices"

	"jannie/games/klaverjas/game"
	"jannie/games/toepen/toepen"
)

// world is one guess at the hidden cards: the hand of every other seat
// still in the round, consistent with the suits it showed it lacks; a hand
// played face up is known.
type world [toepen.MaxPlayers][]game.Card

// unseen lists the cards v.Seat has not seen: not in its hand, not played,
// not shown by a check. The hidden hands, the stock and the cards given
// back or thrown in are among them.
func unseen(v *toepen.View) []game.Card {
	known := make(map[game.Card]bool, 32)
	for _, c := range v.Hand {
		known[c] = true
	}
	for _, c := range v.Seen() {
		known[c] = true
	}
	var out []game.Card
	for _, c := range game.NewDeck() {
		if !known[c] {
			out = append(out, c)
		}
	}
	return out
}

// voids lists per seat the suits it showed it lacks: it played another
// suit to a trick in which that suit was led.
func voids(v *toepen.View) [toepen.MaxPlayers][game.NumSuits]bool {
	var out [toepen.MaxPlayers][game.NumSuits]bool
	mark := func(t toepen.Trick) {
		led, ok := t.Led()
		if !ok {
			return
		}
		for _, p := range t.Cards[1:] {
			if p.Card.Suit != led {
				out[p.Seat][led] = true
			}
		}
	}
	for _, t := range v.Tricks {
		mark(t)
	}
	mark(v.Current)
	return out
}

// sampler draws worlds for one view.
type sampler struct {
	v     *toepen.View
	pool  []game.Card
	voids [toepen.MaxPlayers][game.NumSuits]bool
	order []game.Seat // the other seats in the round, most constrained first
}

func newSampler(v *toepen.View) *sampler {
	s := &sampler{v: v, pool: unseen(v), voids: voids(v)}
	for o := range game.Seat(v.Players) {
		if o != v.Seat && v.In(o) && v.Open[o] == nil {
			s.order = append(s.order, o)
		}
	}
	count := func(o game.Seat) int {
		n := 0
		for _, b := range s.voids[o] {
			if b {
				n++
			}
		}
		return n
	}
	slices.SortStableFunc(s.order, func(a, b game.Seat) int { return count(b) - count(a) })
	return s
}

// draw deals the pool out to the other seats, respecting the voids; after
// a few failed tries it ignores them (a play nobody can explain). The hands
// played face up are as they are.
func (s *sampler) draw(rng *rand.Rand) world {
	var w world
	for o := range s.v.Players {
		if o != int(s.v.Seat) && s.v.Open[o] != nil {
			w[o] = slices.Clone(s.v.Open[o])
		}
	}
	pool := slices.Clone(s.pool)
	for try := range 8 {
		rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
		if s.fill(&w, pool, try < 7) {
			return w
		}
	}
	return w
}

func (s *sampler) fill(w *world, pool []game.Card, strict bool) bool {
	used := make([]bool, len(pool))
	for _, o := range s.order {
		need := s.v.Cards[o]
		w[o] = w[o][:0]
		for k, c := range pool {
			if len(w[o]) == need {
				break
			}
			if used[k] || strict && s.voids[o][c.Suit] {
				continue
			}
			used[k] = true
			w[o] = append(w[o], c)
		}
		if len(w[o]) < need {
			return false
		}
	}
	return true
}

// strength of a hand for a toep: the best card it holds, 0 (boer) .. 1 (a
// 10), squared and a bit more for a second high card.
func toepStrength(hand []game.Card) float64 {
	best, second := -1, -1
	for _, c := range hand {
		switch st := toepen.Strength(c.Rank); {
		case st > best:
			best, second = st, best
		case st > second:
			second = st
		}
	}
	if best < 0 {
		return 0
	}
	x := float64(best) / 7
	if second >= 5 {
		x += 0.15
	}
	return min(x*x, 1)
}
