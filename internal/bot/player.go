package bot

import (
	"math/rand/v2"
	"sync/atomic"

	"klaverjas/internal/game"
)

// Player makes the decisions for one bot seat, at a table of v.Players.
type Player interface {
	ChooseTrump(v game.View) game.Suit // utrechts, forced (never v.Turned when v.Forced), or the soloist
	Bid(v game.View) bool              // gedraaid: play on v.Turned?
	Auction(v game.View) int           // three players: a bid of at least v.MinNextBid(), or 0 to pass
	Discard(v game.View) [2]game.Card  // three players: two cards of v.Hand for the soloist to lay away
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
	est     auctionEstimate // three players: the estimate of the hand being bid on
}

// small reports whether v is at a table of two or three players.
func small(v *game.View) bool { return v.Players == 2 || v.Players == 3 }

// makkelijkMistakes is the share of random legal cards a makkelijk bot plays.
const makkelijkMistakes = 0.3

// fallbacks counts decisions where the search failed and the rule-based
// choice was used instead. It should stay zero; tests check that.
var fallbacks atomic.Int64

func (b *player) ChooseTrump(v game.View) (s game.Suit) {
	if small(&v) {
		return b.smallTrump(v)
	}
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
	if small(&v) {
		return b.smallBid(v)
	}
	h := setOf(v.Hand)
	normal := trumpValue(h, v.Turned) >= bidThreshold(b.persona.Aggression)
	switch {
	case b.level == Makkelijk:
		return makkelijkBid(h.inSuit(v.Turned), v.Turned, b.persona.Aggression)
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
	if small(&v) {
		return b.smallPlay(v)
	}
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

// Signals at sterk: the search alone would rarely give kleintje boer and
// would sometimes fake a signal, but partners (and humans following the
// manual) read the signals of design §8 as promises. The search may break
// them only for a clear gain.
const (
	fakeSignalGain  = 10 // points a false kleintje boer must gain over the best honest card
	fakeLowGain     = 20 // the same for a false opseinen or met de aas seinen
	signalTolerance = 6  // points a genuine kleintje boer may cost
)

// lieGain returns how much more than the best honest card c must bring in
// when playing it would signal something untrue (kleintje boer, met de
// aas seinen or opseinen), or 0 when c is honest.
func (m *mover) lieGain(c game.Card) float64 {
	switch {
	case m.falseAce(c):
		return fakeLowGain
	case m.fakeSignal(c):
		return fakeSignalGain
	case m.falseLow(c):
		return fakeLowGain
	}
	return 0
}

// sterkChoice is the Monte Carlo card for v (see sterkPick).
func sterkChoice(v *game.View, cfg searchConfig, seed uint64, aggr float64) game.Card {
	tab := tableFromView(v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(v.Legal), aggr)
	pref := m.choose()
	res := searchPlay(v, &tab, cfg, seed, aggr)
	return res[sterkPick(&m, res, pref)].card
}

// sterkPick returns the index in res (the search of m's legal cards) of
// the sterk card. When the rule-based card pref is within a point of the
// best (signalTolerance for a genuine kleintje boer or boer over boer), it
// is played instead: the difference is noise, and the rule-based card
// looks natural. So is a
// pref that wins and loses alike with the best card (equivalent), unless
// the search can tell the two apart (teachTolerance, two standard errors):
// with ♥A and ♥10 the 10 goes first. A false signal needs its lieGain.
func sterkPick(m *mover, res []playResult, pref game.Card) int {
	i, _ := sterkChoose(m, res, pref)
	return i
}

// Why sterkChoose kept the rule-based card over another.
const (
	keptNone  = iota
	keptNoise // within a point
	keptBoer  // a genuine kleintje boer (or boer over boer), within signalTolerance
	keptAlike // wins and loses alike, within the hints' tolerance
	keptAbove // a false signal itself, valued above the best honest card, which took the place of another
)

// sterkWhy says why sterkChoose did not play the card the search valued
// most: liar is that card when it would be a false signal that gains less
// than lie over honest, the best honest card (-1: none); kept is why the
// rule-based card was played over over, within tol.
type sterkWhy struct {
	liar, honest int
	lie          float64
	kept, over   int
	tol          float64
}

// sterkChoose is sterkPick, with the reason (for the expert's reasoning).
func sterkChoose(m *mover, res []playResult, pref game.Card) (int, sterkWhy) {
	why := sterkWhy{liar: -1, honest: -1}
	best := bestResult(res, pref, m.t.trump)
	if gain := m.lieGain(res[best].card); gain > 0 {
		alt := -1
		for i, r := range res {
			if m.lieGain(r.card) == 0 && (alt < 0 || r.total > res[alt].total || r.total == res[alt].total && r.card == pref) {
				alt = i
			}
		}
		if alt >= 0 && res[best].mean()-res[alt].mean() < gain {
			why.liar, why.honest, why.lie = best, alt, gain
			best = alt
		}
	}
	i := resultIndex(res, pref)
	if i < 0 {
		return best, why
	}
	tol, kept := 1.0, keptNoise
	switch {
	case m.t.signalsBoer(m.seat, pref) && !m.fakeSignal(pref):
		tol, kept = signalTolerance, keptBoer
	case m.equivalent(pref, res[best].card) && m.lieGain(pref) == 0:
		tol, kept = max(teachTolerance, 2*pairSE(res, best, i)), keptAlike
	}
	if res[best].mean()-res[i].mean() < tol {
		if res[i].mean() >= res[best].mean() {
			kept = keptAbove
		}
		if i != best {
			why.kept, why.over, why.tol = kept, best, tol
		}
		return i, why
	}
	return best, why
}

// equivalent reports whether a and b, cards of one suit in the mover's
// hand, win and lose alike: no card that is still out lies between them.
func (m *mover) equivalent(a, b game.Card) bool {
	trump := m.t.trump
	if a.Suit != b.Suit {
		return false
	}
	if game.Order(a, trump) > game.Order(b, trump) {
		a, b = b, a
	}
	return m.unk.higher(a, trump)&m.unk.lower(b, trump) == 0
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

// makkelijkBid is the naive bid on the turned suit s, given the hand's
// cards t in it: play on the boer or on length, ignoring the side suits.
// The persona's aggression moves the bar: cautious players want the boer
// with another trump (or five trumps), bold ones also play on the nel with
// two more.
func makkelijkBid(t cardSet, s game.Suit, aggr float64) bool {
	n := t.count()
	jack, nine := t.has(jackOf(s)), t.has(nineOf(s))
	switch {
	case aggr < 0.5:
		return (jack && n >= 2) || n >= 5
	case aggr >= 0.7:
		return jack || (nine && n >= 3) || n >= 4
	}
	return jack || n >= 4
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
// Lead an ace or (when playing) the trump boer, give points (spekken) when
// the partner is winning with a high card, win as cheaply as possible,
// else play low.
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
