package bot

import (
	"math/rand/v2"
	"sync"

	"klaverjas/internal/game"
)

// Choice is a decision of a player: exactly one of Card, Suit or Play is
// set.
type Choice struct {
	Card *game.Card
	Suit *game.Suit
	Play *bool
}

// Grade is the analysis of one decision for the game-end review, at sterk
// strength and from what the player knew when deciding. It runs the search
// of Advise on the same view, so it agrees with the training hint. Points
// are expected score differences between the teams, as in the hints.
type Grade struct {
	Stake  float64 // points between the best and the worst option; 0 when there was no choice
	Lost   float64 // points the choice gave up against Better; 0 within the noise of the search
	Gain   float64 // a strong choice: points it gained over the rule-based choice; else 0
	Better Choice  // the advised option, when Lost > 0
	Text   string  // the hint for Better (Lost > 0) or for the choice (Gain > 0)
	Nat    float64 // a bid to play: the chance of going nat
}

// strongGain is how many points a choice must gain over the rule-based one
// to count as a strong move: the obvious card is no achievement.
const strongGain = 10

// gradeSearch is the search of Advise on one goroutine: the results do not
// depend on the number of workers (see chunks), and the server bounds the
// cores that grading takes by the number of grades it runs at once.
var gradeSearch = searchConfig{playWorlds: defaultSearch.playWorlds, trumpWorlds: defaultSearch.trumpWorlds, workers: 1}

// GradeChoice grades choice c of the player of v, whose turn it must be.
// A choice loses points when the hint's option is better by more than the
// hint's tolerance (teachTolerance, or two paired standard errors). It is
// strong when it is the hint's option, the rule-based policy would have
// chosen otherwise, and it gains at least strongGain over that. Without a
// choice (one legal card), or should the search fail, the grade is zero.
func GradeChoice(v game.View, c Choice) (g Grade) {
	if v.Turn.Valid() && v.Turn != v.Seat {
		return Grade{}
	}
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			g = Grade{}
		}
	}()
	seed := viewSeed(&v)
	switch {
	case v.Phase == game.PhasePlay && c.Card != nil:
		return gradePlay(&v, *c.Card, seed)
	case v.Phase == game.PhaseTrump && c.Suit != nil:
		return gradeTrump(&v, *c.Suit, seed)
	case v.Phase == game.PhaseBid && c.Play != nil:
		return gradeBid(&v, *c.Play, seed)
	}
	return Grade{}
}

func gradePlay(v *game.View, c game.Card, seed uint64) Grade {
	legal := legalCards(*v)
	if len(legal) < 2 {
		return Grade{}
	}
	v.Legal = legal
	tab := tableFromView(v)
	m := newMover(&tab, v.Seat, setOf(v.Hand), setOf(legal), 0.5)
	pref := m.choose()
	res := searchPlay(v, &tab, gradeSearch, seed, 0.5)
	adv, text := teachPick(v, &tab, &m, res, pref)
	i, a := resultIndex(res, c), resultIndex(res, adv)
	if i < 0 || a < 0 {
		return Grade{}
	}
	lo, hi := res[0].mean(), res[0].mean()
	for _, r := range res[1:] {
		lo, hi = min(lo, r.mean()), max(hi, r.mean())
	}
	g := Grade{Stake: hi - lo}
	if gap := res[a].mean() - res[i].mean(); gap >= max(teachTolerance, 2*pairSE(res, a, i)) {
		g.Lost, g.Text = gap, text
		g.Better.Card = &adv
		return g
	}
	if p := resultIndex(res, pref); c == adv && c != pref && p >= 0 {
		if gain := res[i].mean() - res[p].mean(); gain >= max(strongGain, 2*pairSE(res, i, p)) {
			g.Gain, g.Text = gain, text
		}
	}
	return g
}

func gradeTrump(v *game.View, s game.Suit, seed uint64) Grade {
	if s >= game.NumSuits || (v.Forced && s == v.Turned) {
		return Grade{}
	}
	st := searchTrump(v, gradeSearch, seed, 0.5)
	best := bestSuit(st, v.Forced, v.Turned)
	lo, hi := st[best].mean(), st[best].mean()
	for o := game.Suit(0); o < game.NumSuits; o++ {
		if !(v.Forced && o == v.Turned) {
			lo, hi = min(lo, st[o].mean()), max(hi, st[o].mean())
		}
	}
	g := Grade{Stake: hi - lo}
	if gap := st[best].mean() - st[s].mean(); gap >= max(teachTolerance, 2*st[best].pairSE(st[s], int(s))) {
		g.Lost, g.Text = gap, trumpText(v, best, st[best])
		g.Better.Suit = &best
		return g
	}
	normal := bestTrumpNormal(setOf(v.Hand), v.Forced, v.Turned)
	if s == best && normal != s {
		if gain := st[s].mean() - st[normal].mean(); gain >= max(strongGain, 2*st[s].pairSE(st[normal], int(normal))) {
			g.Gain, g.Text = gain, trumpText(v, s, st[s])
		}
	}
	return g
}

func gradeBid(v *game.View, play bool, seed uint64) Grade {
	yes, no := searchBid(v, gradeSearch, seed, 0.5)
	best := yes.mean() > no.mean()
	gap := yes.mean() - no.mean()
	if !best {
		gap = -gap
	}
	g := Grade{Stake: gap}
	if play {
		g.Nat = 1 - yes.madeRate()
	}
	noise := 2 * yes.pairSE(no, 1)
	normal := trumpValue(setOf(v.Hand), v.Turned) >= bidThreshold(0.5)
	switch {
	case play != best && gap >= max(teachTolerance, noise):
		g.Lost, g.Text = gap, bidText(v, best, yes)
		g.Better.Play = &best
	case play == best && normal != play && gap >= max(strongGain, noise):
		g.Gain, g.Text = gap, bidText(v, play, yes)
	}
	return g
}

// luckWorlds is the number of sampled deals behind HandLuck, and
// luckBaseDeals the number of random deals behind its baseline.
const (
	luckWorlds    = 320
	luckBaseDeals = 20000
)

// HandLuck returns how many points the cards dealt to the player of v are
// worth to their team, compared with an average hand in the same seat: the
// mean score difference when the hand is played from the deal by the
// rule-based policy (bids and trump choice included) over sampled deals of
// the other cards, minus the same over random deals. v is the view at the
// deal, before any decision; the player's own choices are graded apart.
func HandLuck(v game.View) (luck float64) {
	defer func() {
		if r := recover(); r != nil {
			fallbacks.Add(1)
			luck = 0
		}
	}()
	rng := rand.New(rand.NewPCG(viewSeed(&v), 0x6c75636b))
	team := v.Seat.Team()
	var sum int64
	worlds := dealWorlds(&v, rng, luckWorlds)
	for _, w := range worlds {
		d := startDeal(&v, &w)
		sum += int64(playFromDeal(&d, &w, team))
	}
	base := luckBase(v.Mode, v.Rules)
	if team != v.Voorhand.Team() {
		base = -base
	}
	return float64(sum)/float64(len(worlds)) - base
}

// playFromDeal plays deal d with hands w from its bids or trump choice to
// the end with the rule-based policy and returns the score difference for
// team.
func playFromDeal(d *game.Deal, w *[4]cardSet, team int) int {
	for d.Phase() == game.PhaseBid {
		s := d.Turn()
		_ = d.Bid(s, trumpValue(w[s], d.Turned()) >= bidThreshold(0.5))
	}
	if d.Phase() == game.PhaseTrump {
		s := d.Turn()
		_ = d.ChooseTrump(s, bestTrumpNormal(w[s], d.Forced(), d.Turned()))
	}
	trump, _ := d.Trump()
	s := sim{d: *d, t: newTable(d.Voorhand(), trump, d.TrumpBy(), d.Rules())}
	ag := [4]float64{0.5, 0.5, 0.5, 0.5}
	s.run(&ag)
	r := s.d.Result()
	return r.Score[team] - r.Score[1-team]
}

// luckBases holds, per trump mode and rules, the mean score difference for
// the team of voorhand over random deals: what an average hand is worth in
// that team (and, negated, in the other).
var luckBases [2][2]struct {
	once sync.Once
	v    float64
}

func luckBase(mode game.TrumpMode, rules game.Rules) float64 {
	b := &luckBases[mode&1][rules&1]
	b.once.Do(func() {
		rng := rand.New(rand.NewPCG(uint64(mode)*2+uint64(rules)+1, 0x62617365))
		var sum int64
		for range luckBaseDeals {
			hands := game.Shuffle(rng)
			turned := game.Suit(rng.IntN(game.NumSuits))
			var w [4]cardSet
			for s := range w {
				w[s] = setOf(hands[s])
			}
			d := game.NewDeal(game.Seat(3), hands, mode, rules, turned) // voorhand is seat 0
			sum += int64(playFromDeal(d, &w, 0))
		}
		b.v = float64(sum) / luckBaseDeals
	})
	return b.v
}
