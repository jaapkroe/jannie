package bot

import (
	"math/rand/v2"
	"sync/atomic"

	"klaverjas/internal/game"
)

// Player makes the decisions for one bot seat.
type Player interface {
	ChooseTrump(v game.View) game.Suit // utrechts, or forced (never v.Turned when v.Forced)
	Bid(v game.View) bool              // gedraaid: play on v.Turned?
	Play(v game.View) game.Card        // always one of v.Legal
}

// New returns a player for persona p at level lvl. Its decisions depend
// only on the seed and the views it is shown.
func New(p Persona, lvl Level, seed uint64) Player {
	return newPlayer(p, lvl, seed, defaultSearch)
}

func newPlayer(p Persona, lvl Level, seed uint64, cfg searchConfig) *player {
	if lvl < Makkelijk || lvl > Sterk {
		lvl = Normaal
	}
	return &player{
		persona: p,
		level:   lvl,
		cfg:     cfg,
		rng:     rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)),
	}
}

type player struct {
	persona Persona
	level   Level
	cfg     searchConfig
	rng     *rand.Rand
}

// makkelijkMistakes is the share of random legal cards a makkelijk bot plays.
const makkelijkMistakes = 0.3

// fallbacks counts decisions where the search failed and the rule-based
// choice was used instead. It should stay zero; tests check that.
var fallbacks atomic.Int64

func (b *player) ChooseTrump(v game.View) (s game.Suit) {
	h := setOf(v.Hand)
	switch {
	case b.level == Makkelijk:
		return longestSuit(h, v.Forced, v.Turned)
	case b.level == Normaal || v.Phase != game.PhaseTrump || v.Turn != v.Seat:
		return bestTrumpNormal(h, v.Forced, v.Turned)
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			s = bestTrumpNormal(h, v.Forced, v.Turned)
		}
	}()
	st := searchTrump(&v, b.cfg, b.rng.Uint64(), b.persona.Aggression)
	return bestSuit(st, v.Forced, v.Turned)
}

func (b *player) Bid(v game.View) (play bool) {
	h := setOf(v.Hand)
	normal := trumpValue(h, v.Turned) >= bidThreshold(b.persona.Aggression)
	switch {
	case b.level == Makkelijk:
		t := h.inSuit(v.Turned)
		return t.has(jackOf(v.Turned)) || t.count() >= 4
	case b.level == Normaal || v.Phase != game.PhaseBid || v.Turn != v.Seat:
		return normal
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			play = normal
		}
	}()
	yes, no := searchBid(&v, b.cfg, b.rng.Uint64(), b.persona.Aggression)
	return yes.mean()+bidBias(b.persona.Aggression) > no.mean()
}

func (b *player) Play(v game.View) (c game.Card) {
	legal := legalCards(v)
	if len(legal) == 0 {
		return game.Card{}
	}
	if len(legal) == 1 || v.Phase != game.PhasePlay || !v.TrumpKnown {
		return legal[0]
	}
	v.Legal = legal
	switch b.level {
	case Makkelijk:
		if b.rng.Float64() < makkelijkMistakes {
			return legal[b.rng.IntN(len(legal))]
		}
		return simpleChoice(&v, legal)
	case Normaal:
		return normalChoice(&v, b.persona.Aggression)
	}
	seed := b.rng.Uint64()
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			c = normalChoice(&v, b.persona.Aggression)
		}
	}()
	return sterkChoice(&v, b.cfg, seed, b.persona.Aggression)
}

// sterkChoice is the Monte Carlo card for v. When the rule-based card is
// within a point of the best, it is played instead: the difference is
// noise, and the rule-based card looks natural.
func sterkChoice(v *game.View, cfg searchConfig, seed uint64, aggr float64) game.Card {
	tab := tableFromView(v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), aggr)
	pref := m.choose()
	res := searchPlay(v, &tab, cfg, seed, aggr)
	best := bestResult(res, pref)
	for _, r := range res {
		if r.card == pref && res[best].mean()-r.mean() < 1 {
			return pref
		}
	}
	return res[best].card
}

// normalChoice is the rule-based card for v.
func normalChoice(v *game.View, aggr float64) game.Card {
	tab := tableFromView(v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), aggr)
	return m.choose()
}

// legalCards returns v.Legal, or computes it when the view lacks it.
func legalCards(v game.View) []game.Card {
	if len(v.Legal) > 0 {
		return v.Legal
	}
	if l := game.LegalMoves(v.Hand, v.Current, v.Seat, v.Trump, v.Rules); len(l) > 0 {
		return l
	}
	return v.Hand
}

// longestSuit is the naive trump choice: the longest suit, ties broken by
// card points.
func longestSuit(h cardSet, forced bool, turned game.Suit) game.Suit {
	best, bestVal := game.Suit(0), -1
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if forced && s == turned {
			continue
		}
		val := 100 * h.countSuit(s)
		for _, c := range h.inSuit(s).appendCards(make([]game.Card, 0, 8)) {
			val += game.Points(c, s)
		}
		if val > bestVal {
			best, bestVal = s, val
		}
	}
	return best
}

// simpleChoice is the makkelijk heuristic: no card counting, no signals.
// Lead an ace or (when playing) the trump boer, smear when the partner is
// winning with a high card, win as cheaply as possible, else play low.
func simpleChoice(v *game.View, legal []game.Card) game.Card {
	trump := v.Trump
	if len(v.Current.Cards) == 0 {
		if v.PlayingTeam == v.Seat.Team() {
			for _, c := range legal {
				if c == jackOf(trump) {
					return c
				}
			}
		}
		for _, c := range legal {
			if c.Suit != trump && c.Rank == game.Ace {
				return c
			}
		}
		return cheapest(legal, trump)
	}
	led := v.Current.Cards[0].Card.Suit
	winner, _ := v.Current.CurrentWinner(trump)
	best, _ := v.Current.WinningCard(trump)
	if winner == v.Seat.Partner() {
		strong := best.Rank == game.Ace || (best.Suit == trump && game.TrumpOrder(best.Rank) >= game.TrumpOrder(game.Ace))
		if strong || len(v.Current.Cards) == 3 {
			var smear game.Card
			pts := 0
			for _, c := range legal {
				if p := game.Points(c, trump); c.Suit != trump && p > pts {
					smear, pts = c, p
				}
			}
			if pts > 0 {
				return smear
			}
		}
		return cheapest(legal, trump)
	}
	var win game.Card
	found := false
	for _, c := range legal {
		if game.Beats(c, best, led, trump) && (!found || cost(c, trump) < cost(win, trump)) {
			win, found = c, true
		}
	}
	if found {
		return win
	}
	return cheapest(legal, trump)
}

// cost ranks cards by how much they are worth keeping.
func cost(c game.Card, trump game.Suit) int {
	n := game.Points(c, trump)*2 + game.Order(c, trump)
	if c.Suit == trump {
		n += 40
	}
	return n
}

// cheapest returns the legal card that is least worth keeping.
func cheapest(legal []game.Card, trump game.Suit) game.Card {
	best := legal[0]
	for _, c := range legal[1:] {
		if cost(c, trump) < cost(best, trump) {
			best = c
		}
	}
	return best
}
