// Package toepbot plays toepen (package toepen) at three strengths. Every
// level plays its cards by the same rules of thumb (normalCard); sterk
// plays out every legal card in sampled deals of the hidden cards, and
// decides on toepen, going along and the was by its chance to take the
// last trick, weighed against the points at stake and the risk of going
// out.
package toepbot

import (
	"math"
	"math/rand/v2"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

// Level is a playing strength.
type Level int

const (
	Makkelijk Level = iota
	Normaal
	Sterk
)

func (l Level) String() string {
	switch l {
	case Makkelijk:
		return "makkelijk"
	case Sterk:
		return "sterk"
	}
	return "normaal"
}

// ParseLevel reads "makkelijk", "normaal" or "sterk"; anything else is
// normaal.
func ParseLevel(s string) Level {
	switch s {
	case "makkelijk":
		return Makkelijk
	case "sterk":
		return Sterk
	}
	return Normaal
}

// Player makes the decisions of one seat. Aggression (0..1) is the
// persona's boldness: it toeps on less, goes along more and bluffs a was
// more often.
type Player struct {
	lvl  Level
	aggr float64
	rng  *rand.Rand
}

// New returns a player; seed makes its choices repeatable.
func New(aggression float64, lvl Level, seed uint64) *Player {
	return &Player{lvl: lvl, aggr: min(max(aggression, 0), 1), rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
}

// worlds is the number of sampled deals per estimate.
func (p *Player) worlds() int {
	switch p.lvl {
	case Makkelijk:
		return 12
	case Sterk:
		return 240
	}
	return 48
}

// ---- cards ----

// Play chooses a card of v.Legal.
func (p *Player) Play(v toepen.View) game.Card {
	legal := v.Legal
	if len(legal) == 0 {
		legal = toepen.Legal(v.Hand, v.Current)
	}
	if len(legal) == 1 {
		return legal[0]
	}
	switch p.lvl {
	case Makkelijk:
		if p.rng.Float64() < 0.35 {
			return legal[p.rng.IntN(len(legal))]
		}
	case Sterk:
		return p.search(&v, legal)
	}
	return normalCard(v.Hand, v.Current, v.In)
}

// search plays every legal card out in the same sampled deals and keeps
// the one that takes the last trick most often; a tie goes to the rule's
// card.
func (p *Player) search(v *toepen.View, legal []game.Card) game.Card {
	rule := normalCard(v.Hand, v.Current, v.In)
	s := newSampler(v)
	wins := make([]float64, len(legal))
	n := p.worlds()
	for range n {
		w := s.draw(p.rng)
		weight := p.weight(v, &w)
		for k, c := range legal {
			if playout(v, &w, c) == v.Seat {
				wins[k] += weight
			}
		}
	}
	best := -1
	for k, c := range legal {
		switch {
		case best < 0, wins[k] > wins[best]+1e-9:
			best = k
		case math.Abs(wins[k]-wins[best]) <= 1e-9 && c == rule:
			best = k
		}
	}
	return legal[best]
}

// weight is how likely a sampled world is given the toeps made: a seat
// that toept is thought to hold a strong hand (sterk only).
func (p *Player) weight(v *toepen.View, w *world) float64 {
	if p.lvl != Sterk {
		return 1
	}
	x := 1.0
	for _, t := range v.Toeps {
		if t.Seat != v.Seat && v.In(t.Seat) {
			x *= 0.35 + toepStrength(w[t.Seat])
		}
	}
	return x
}

// winChance is the share of sampled deals in which v.Seat takes the last
// trick, everyone playing on by the rules of thumb (from v.Seat's best
// card, for sterk on its own turn).
func (p *Player) winChance(v *toepen.View) float64 {
	if !v.In(v.Seat) {
		return 0
	}
	if v.InCount() == 1 {
		return 1
	}
	s := newSampler(v)
	n := p.worlds()
	total, won := 0.0, 0.0
	legal := toepen.Legal(v.Hand, v.Current)
	mine := v.Turn == v.Seat && v.Phase == toepen.PhasePlay && p.lvl == Sterk && len(legal) > 1
	for range n {
		w := s.draw(p.rng)
		weight := p.weight(v, &w)
		total += weight
		if !mine {
			if playout(v, &w, noCard) == v.Seat {
				won += weight
			}
			continue
		}
		for _, c := range legal {
			if playout(v, &w, c) == v.Seat {
				won += weight
				break
			}
		}
	}
	if total == 0 {
		return 0
	}
	return won / total
}

// ---- the stake ----

// cost is what taking n penalty points costs a player with points of
// limit: the points, and being out of the match as much as five more.
func cost(points, n, limit int) float64 {
	if points+n >= limit {
		return float64(limit-points) + 5
	}
	return float64(n)
}

// Toep decides, on v.Seat's turn to play, whether to toep first.
func (p *Player) Toep(v toepen.View) bool {
	if !v.CanToep {
		return false
	}
	q := p.winChance(&v)
	bar := 0.62 - 0.12*p.aggr
	switch p.lvl {
	case Makkelijk:
		bar = 0.7 - 0.1*p.aggr
	case Sterk:
		// Toepen asks the others to pay the stake or play for more: with a
		// fair chance, more of them pass than it costs. Fewer players in,
		// a higher bar: one opponent left is a coin flip for more points.
		bar = 0.5 + 0.06*float64(3-min(v.InCount(), 3)) - 0.1*p.aggr
	}
	if q >= bar {
		return true
	}
	// Now and then a bluff with a hand that has nothing to lose.
	bluff := 0.02 + 0.08*p.aggr
	if p.lvl == Makkelijk {
		bluff = 0.04
	}
	return q < 0.12 && v.Stake <= 2 && p.rng.Float64() < bluff
}

// Answer decides whether to go along with a toep (true) or pass, taking
// the stake from before it.
func (p *Player) Answer(v toepen.View) bool {
	if v.InCount() <= 1 {
		return true
	}
	me := v.Points[v.Seat]
	limit := v.Rules.Limit
	fold := cost(me, v.Stake-1, limit)
	stay := cost(me, v.Stake, limit)
	if fold >= stay {
		return true // passing puts it out as surely as losing
	}
	q := p.winChance(&v)
	if p.lvl == Makkelijk {
		return q > 0.35-0.15*p.aggr || p.rng.Float64() < 0.15
	}
	// Going along costs the stake when the last trick is lost (and maybe
	// more after another toep); passing costs the stake before.
	risk := 1.1 - 0.25*p.aggr
	if p.lvl == Sterk {
		risk = 1.05 - 0.15*p.aggr
	}
	return (1-q)*stay*risk < fold
}

// ---- the was ----

// Was decides whether to claim a was: always with a real one (a fresh
// hand beats four pictures), now and then as a bluff with a hopeless hand.
func (p *Player) Was(v toepen.View) bool {
	if !v.CanClaim {
		return false
	}
	if toepen.Was(v.Hand) != toepen.NoWas {
		return p.lvl != Makkelijk || p.rng.Float64() < 0.7
	}
	q := p.winChance(&v)
	if q > 0.12 {
		return false
	}
	rate := map[Level]float64{Makkelijk: 0.04, Normaal: 0.08, Sterk: 0.12}[p.lvl]
	return p.rng.Float64() < rate*(0.5+p.aggr)
}

// Check decides whether to check the claimed was of v.Claimant. The cards
// v.Seat can see make a real was more or less likely; a check of a real one
// costs a point, of a bluff it costs the claimant one, and the round.
func (p *Player) Check(v toepen.View) bool {
	if p.lvl == Makkelijk {
		return p.rng.Float64() < 0.15
	}
	g := wasChance(unseen(&v))
	bluff := 0.15
	if p.lvl == Sterk {
		bluff = 0.12
	}
	pb := bluff * (1 - g) / (bluff*(1-g) + g)
	bar := 0.5
	if cost(v.Points[v.Seat], 1, v.Rules.Limit) > 1 {
		bar = 0.85 // a wrong check would put it out
	}
	return pb > bar
}

// wasChance is the chance that four cards drawn from pool are a was.
func wasChance(pool []game.Card) float64 {
	pics, sevens := 0, 0
	for _, c := range pool {
		switch {
		case toepen.Plaatje(c.Rank):
			pics++
		case c.Rank == game.Seven:
			sevens++
		}
	}
	all := choose(len(pool), 4)
	if all == 0 {
		return 0
	}
	return (choose(pics, 4) + choose(pics, 3)*float64(sevens)) / all
}

func choose(n, k int) float64 {
	if k < 0 || n < k {
		return 0
	}
	r := 1.0
	for i := range k {
		r = r * float64(n-i) / float64(i+1)
	}
	return r
}
