package bot

import (
	"math"
	"math/rand/v2"
	"runtime"
	"sync"
	"sync/atomic"

	"klaverjas/internal/game"
)

// searchConfig sizes the Monte Carlo search.
type searchConfig struct {
	playWorlds  int     // sampled deals per card decision
	trumpWorlds int     // sampled deals per trump or bid decision
	workers     int     // goroutines; 0 means GOMAXPROCS (capped at chunks)
	defend      float64 // three players: what defending is worth (see defendValue); 0 for the default
	points      bool    // value options by the scores alone, without the appetite for pit (hints and grades)
}

// defaultSearch keeps a decision well under ~150 ms on a 16-core machine.
var defaultSearch = searchConfig{playWorlds: 400, trumpWorlds: 320}

// adviseSearch is the search behind the hints and the review: the same
// size, valuing each option by the points it brings the players alone.
var adviseSearch = searchConfig{playWorlds: defaultSearch.playWorlds, trumpWorlds: defaultSearch.trumpWorlds, points: true}

// appetite is the aggression behind the appetite for pit in the value of
// an option: none when the search counts points alone.
func (cfg searchConfig) appetite(aggr float64) float64 {
	if cfg.points {
		return 0
	}
	return aggr
}

// chunks is the fixed number of independent work units per decision; each
// has its own random stream, so results do not depend on the worker count.
const chunks = 16

// pitAppetite is the extra value a bot with aggression 1 puts on pit.
const pitAppetite = 40

// sim is a hand being played out: the engine deal plus the public table.
type sim struct {
	d game.Deal
	t table
}

func (s *sim) play(c game.Card) {
	seat := s.d.Turn()
	if err := s.d.Play(seat, c); err != nil {
		panic("bot: playout made an illegal move: " + err.Error())
	}
	s.t.apply(seat, c)
}

// run plays the hand to the end with the rule-based policy for every seat.
func (s *sim) run(aggr *[4]float64) {
	for s.d.Phase() == game.PhasePlay {
		s.step(aggr)
	}
}

// finishTrick plays the current trick to its end, as run would.
func (s *sim) finishTrick(aggr *[4]float64) {
	for s.t.n != 0 && s.d.Phase() == game.PhasePlay {
		s.step(aggr)
	}
}

// step plays one card with the rule-based policy.
func (s *sim) step(aggr *[4]float64) {
	seat := s.d.Turn()
	legal := cardSet(s.d.LegalMask())
	if legal&(legal-1) == 0 {
		s.play(game.CardFromIndex(trailing(legal))) // the only card, as decide plays it
		return
	}
	m := newMover(&s.t, seat, cardSet(s.d.HandMask(seat)), legal, aggr[seat])
	s.play(m.choose())
}

// value is result r for team: its score minus the opponents' score,
// including nat and pit, plus the appetite for pit of a persona at
// aggression aggr.
func value(r *game.HandResult, team int, aggr float64) int {
	v := r.Score[team] - r.Score[1-team]
	if r.Pit && r.PitTeam == team {
		v += int(pitAppetite * aggr)
	}
	return v
}

// outcome sums what an option led to over the sampled deals (see Outcome).
type outcome struct {
	us, them       int64 // the scores of the team searched for and of the opponents
	natUs, natThem int   // deals where that team, or the opponents, played and went nat
}

func (o *outcome) add(r *game.HandResult, team int) {
	o.us += int64(r.Score[team])
	o.them += int64(r.Score[1-team])
	if r.Nat && r.PlayingTeam == team {
		o.natUs++
	} else if r.Nat {
		o.natThem++
	}
}

func (o *outcome) merge(p outcome) {
	o.us += p.us
	o.them += p.them
	o.natUs += p.natUs
	o.natThem += p.natThem
}

// mean is the outcome per deal over n deals.
func (o outcome) mean(n int) Outcome {
	if n == 0 {
		return Outcome{}
	}
	f := float64(n)
	return Outcome{Us: float64(o.us) / f, Them: float64(o.them) / f, NatUs: float64(o.natUs) / f, NatThem: float64(o.natThem) / f}
}

// runChunks runs f for every chunk on the configured number of goroutines.
func (cfg searchConfig) runChunks(f func(chunk int)) {
	w := cfg.workers
	if w <= 0 {
		w = runtime.GOMAXPROCS(0)
	}
	w = min(w, chunks)
	if w <= 1 {
		for i := range chunks {
			f(i)
		}
		return
	}
	var next atomic.Int32
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failure any
	for range w {
		wg.Go(func() {
			defer func() {
				if r := recover(); r != nil {
					mu.Lock()
					failure = r
					mu.Unlock()
				}
			}()
			for {
				i := int(next.Add(1)) - 1
				if i >= chunks {
					return
				}
				f(i)
			}
		})
	}
	wg.Wait()
	if failure != nil {
		panic(failure) // in the caller's goroutine, where it can be recovered
	}
}

// perChunk splits n worlds over the chunks.
func perChunk(n, chunk int) int {
	q := n / chunks
	if chunk < n%chunks {
		q++
	}
	return q
}

func chunkRNG(seed uint64, chunk int) *rand.Rand {
	return rand.New(rand.NewPCG(seed, uint64(chunk)*0x9e3779b97f4a7c15+1))
}

// playResult is the search outcome for one candidate card.
type playResult struct {
	card  game.Card
	total int64 // summed value over the worlds
	n     int   // worlds
	out   outcome
	// diffSq[j] sums, over the worlds, the squared difference between this
	// card's value and that of candidate j (in v.Legal order): every
	// candidate is played out in the same worlds, see pairSE.
	diffSq [8]int64
	parts  [numParts]int64 // with cfg.points: the value summed per part
}

// The parts of a card's value that a hint names (see searchWhy): in a hand
// that is made the points and the roem in the card's own trick and in the
// later tricks, ours minus the opponents'; in a hand that goes nat all of
// that under nat, as one team gets everything and the points and the roem
// no longer count apart; and the pit bonus. They sum to the value less what
// was scored before the card, which is the same for every card.
const (
	partPointsNow = iota
	partPointsLater
	partRoemNow
	partRoemLater
	partNat
	partPit
	numParts
)

// addParts adds the parts of one playout's value v to p: start, mid and
// end are the points and the roem per side before the card, after its
// trick and at the end of the hand, without the pit bonus; r is the result
// of the hand.
func addParts(p *[numParts]int64, start, mid, end [2][2]int, r *game.HandResult, v, team int) {
	d := func(x [2]int) int { return x[team] - x[1-team] }
	pit := 0
	if r.Pit {
		pit = game.PitBonus
		if r.PitTeam != team {
			pit = -pit
		}
	}
	p[partPit] += int64(pit)
	if r.Nat {
		p[partNat] += int64(v - pit - d(start[0]) - d(start[1]))
		return
	}
	p[partPointsNow] += int64(d(mid[0]) - d(start[0]))
	p[partPointsLater] += int64(d(end[0]) - d(mid[0]))
	p[partRoemNow] += int64(d(mid[1]) - d(start[1]))
	p[partRoemLater] += int64(d(end[1]) - d(mid[1]))
}

// part is part k of r's value per world.
func (r playResult) part(k int) float64 {
	if r.n == 0 {
		return 0
	}
	return float64(r.parts[k]) / float64(r.n)
}

func (r playResult) outcome() Outcome { return r.out.mean(r.n) }

func (r playResult) mean() float64 {
	if r.n == 0 {
		return 0
	}
	return float64(r.total) / float64(r.n)
}

// pairSE is the standard error of res[i].mean() - res[j].mean(), from the
// paired per-world differences. Pairing removes the luck of the deal that
// both cards share, so it is much smaller than either mean's own error.
func pairSE(res []playResult, i, j int) float64 {
	n := float64(res[i].n)
	if i == j || n < 2 {
		return 0
	}
	d := float64(res[i].total-res[j].total) / n
	v := float64(res[i].diffSq[j])/n - d*d
	return math.Sqrt(max(v, 0) / (n - 1))
}

// resultIndex returns the index of card c in res, or -1.
func resultIndex(res []playResult, c game.Card) int {
	for i, r := range res {
		if r.card == c {
			return i
		}
	}
	return -1
}

// searchPlay evaluates every legal card of v by determinised Monte Carlo:
// sample the hidden hands, play each card and finish the hand with the
// rule-based policy. It returns the results in v.Legal order.
func searchPlay(v *game.View, tab *table, cfg searchConfig, seed uint64, aggr float64) []playResult {
	legal := v.Legal
	res := make([]playResult, len(legal))
	for i, c := range legal {
		res[i].card = c
	}
	k := knowledgeFromView(v, tab)
	sp := newSampler(&k)
	team := v.Seat.Team()
	ag := [4]float64{0.5, 0.5, 0.5, 0.5}
	ag[v.Seat] = aggr
	var sums [chunks][8]int64
	var sq [chunks][8][8]int64 // sq[ch][i][j], i < j: summed squared differences
	var outs [chunks][8]outcome
	var counts [chunks]int
	var parts [chunks][8][numParts]int64
	appetite := cfg.appetite(aggr)
	cfg.runChunks(func(ch int) {
		n := perChunk(cfg.playWorlds, ch)
		if n == 0 {
			return
		}
		rng := chunkRNG(seed, ch)
		var hands [4][]game.Card
		for s := range hands {
			hands[s] = make([]game.Card, 0, 8)
		}
		var vals [8]int64
		var base game.Deal
		for _, w := range k.worlds(sp, rng, n) {
			for s := range hands {
				hands[s] = w[s].appendCards(hands[s][:0])
			}
			if err := game.ResumeInto(&base, v, hands); err != nil {
				panic("bot: resume: " + err.Error())
			}
			start := [2][2]int{base.HandPoints(), base.HandRoem()}
			for i, c := range legal {
				s := sim{d: base, t: *tab}
				s.play(c)
				var mid [2][2]int
				if cfg.points {
					s.finishTrick(&ag)
					mid = [2][2]int{s.d.HandPoints(), s.d.HandRoem()}
				}
				s.run(&ag)
				r := s.d.Result()
				vals[i] = int64(value(&r, team, appetite))
				sums[ch][i] += vals[i]
				outs[ch][i].add(&r, team)
				if cfg.points {
					addParts(&parts[ch][i], start, mid, [2][2]int{s.d.HandPoints(), s.d.HandRoem()}, &r, int(vals[i]), team)
				}
				for j := range i {
					d := vals[j] - vals[i]
					sq[ch][j][i] += d * d
				}
			}
			counts[ch]++
		}
	})
	for ch := range chunks {
		for i := range res {
			res[i].total += sums[ch][i]
			res[i].n += counts[ch]
			res[i].out.merge(outs[ch][i])
			for k := range numParts {
				res[i].parts[k] += parts[ch][i][k]
			}
			for j := range i {
				res[i].diffSq[j] += sq[ch][j][i]
				res[j].diffSq[i] += sq[ch][j][i]
			}
		}
	}
	return res
}

// bestResult returns the index of the best card. Ties go to prefer, then
// to the cheaper card (see cost): equal totals usually mean equivalent
// cards, such as ♥7 and ♥8, and the lower one keeps the higher for later.
func bestResult(res []playResult, prefer game.Card, trump game.Suit) int {
	best := 0
	for i := 1; i < len(res); i++ {
		r, b := res[i], res[best]
		switch {
		case r.total > b.total:
			best = i
		case r.total < b.total || b.card == prefer:
		case r.card == prefer || cost(r.card, trump) < cost(b.card, trump):
			best = i
		}
	}
	return best
}

// optionStats is the search outcome for one trump suit or bid.
type optionStats struct {
	total int64
	n     int
	made  int // worlds where our team played and did not go nat
	out   outcome
	// diffSq[j] sums, over the worlds, the squared difference between this
	// option's value and that of option j (a suit, or 0 spelen and 1
	// passen), which is played out in the same worlds: see pairSE.
	diffSq [game.NumSuits]int64
}

func (o optionStats) mean() float64 {
	if o.n == 0 {
		return 0
	}
	return float64(o.total) / float64(o.n)
}

func (o optionStats) outcome() Outcome { return o.out.mean(o.n) }

func (o optionStats) madeRate() float64 {
	if o.n == 0 {
		return 0
	}
	return float64(o.made) / float64(o.n)
}

// pairSE is the standard error of o.mean() - p.mean(), where p is option j
// in the same worlds (as pairSE of playResults).
func (o optionStats) pairSE(p optionStats, j int) float64 {
	n := float64(o.n)
	if n < 2 || p.n != o.n {
		return 0
	}
	d := float64(o.total-p.total) / n
	v := float64(o.diffSq[j])/n - d*d
	return math.Sqrt(max(v, 0) / (n - 1))
}

// addPairs adds the squared differences of one world's values to stats;
// skip is an option that was not played out (-1 for none).
func addPairs(stats []optionStats, vals []int64, skip int) {
	for i := range vals {
		for j := range i {
			if i == skip || j == skip {
				continue
			}
			d := vals[i] - vals[j]
			stats[i].diffSq[j] += d * d
			stats[j].diffSq[i] += d * d
		}
	}
}

// dealWorlds samples full deals for a decision before play: our own hand
// is known, the other 24 cards are hidden (weighted by earlier bids).
func dealWorlds(v *game.View, rng *rand.Rand, n int) [][4]cardSet {
	k := knowledgeFromView(v, nil)
	return k.worlds(newSampler(&k), rng, n)
}

// startDeal recreates the deal of world w with the bids made so far.
func startDeal(v *game.View, w *[4]cardSet) game.Deal {
	var hands [4][]game.Card
	var buf [4][8]game.Card
	for s := range hands {
		hands[s] = w[s].appendCards(buf[s][:0])
	}
	d := game.NewDeal(v.Dealer, hands, v.Mode, v.Rules, v.Turned)
	if v.Mode == game.Gedraaid {
		for s := v.Voorhand; ; s = s.Next() {
			if v.Bids[s] < 0 {
				break
			}
			if err := d.Bid(s, v.Bids[s] == 1); err != nil {
				panic("bot: replaying bids: " + err.Error())
			}
			if s.Next() == v.Voorhand {
				break
			}
		}
	}
	return *d
}

// playOut finishes deal d (in phase play) at a table with agreements sig,
// seat playing at aggression aggr, and returns the result.
func playOut(d *game.Deal, sig game.Signals, aggr float64, seat game.Seat) game.HandResult {
	trump, _ := d.Trump()
	s := sim{d: *d, t: newTable(d.Voorhand(), trump, d.TrumpBy(), d.Rules(), sig)}
	ag := [4]float64{0.5, 0.5, 0.5, 0.5}
	ag[seat] = aggr
	s.run(&ag)
	return s.d.Result()
}

// searchTrump evaluates each allowed trump suit for v.Seat (utrechts, or
// forced in gedraaid) by playing out sampled deals.
func searchTrump(v *game.View, cfg searchConfig, seed uint64, aggr float64) [game.NumSuits]optionStats {
	var stats [chunks][game.NumSuits]optionStats
	team := v.Seat.Team()
	sig := game.SignalsOf(v)
	appetite := cfg.appetite(aggr)
	cfg.runChunks(func(ch int) {
		n := perChunk(cfg.trumpWorlds, ch)
		if n == 0 {
			return
		}
		rng := chunkRNG(seed, ch)
		skip := -1
		if v.Forced {
			skip = int(v.Turned)
		}
		for _, w := range dealWorlds(v, rng, n) {
			base := startDeal(v, &w)
			var vals [game.NumSuits]int64
			for s := game.Suit(0); s < game.NumSuits; s++ {
				if v.Forced && s == v.Turned {
					continue
				}
				d := base
				if err := d.ChooseTrump(v.Seat, s); err != nil {
					panic("bot: trump: " + err.Error())
				}
				r := playOut(&d, sig, aggr, v.Seat)
				vals[s] = int64(value(&r, team, appetite))
				st := &stats[ch][s]
				st.total += vals[s]
				st.n++
				if !r.Nat {
					st.made++
				}
				st.out.add(&r, team)
			}
			addPairs(stats[ch][:], vals[:], skip)
		}
	})
	var out [game.NumSuits]optionStats
	for ch := range chunks {
		for s := range out {
			out[s].total += stats[ch][s].total
			out[s].n += stats[ch][s].n
			out[s].made += stats[ch][s].made
			out[s].out.merge(stats[ch][s].out)
			for j := range out[s].diffSq {
				out[s].diffSq[j] += stats[ch][s].diffSq[j]
			}
		}
	}
	return out
}

// bestSuit returns the allowed suit with the highest mean value.
func bestSuit(st [game.NumSuits]optionStats, forced bool, turned game.Suit) game.Suit {
	best := game.Suit(0)
	if forced && turned == 0 {
		best = 1
	}
	for s := game.Suit(0); s < game.NumSuits; s++ {
		if forced && s == turned {
			continue
		}
		if st[s].total > st[best].total {
			best = s
		}
	}
	return best
}

// searchBid compares spelen and passen on the turned suit for v.Seat. After
// a pass, the remaining players bid (and voorhand chooses when all pass)
// with the rule-based policy.
func searchBid(v *game.View, cfg searchConfig, seed uint64, aggr float64) (play, pass optionStats) {
	var stats [chunks][2]optionStats
	team := v.Seat.Team()
	sig := game.SignalsOf(v)
	appetite := cfg.appetite(aggr)
	cfg.runChunks(func(ch int) {
		n := perChunk(cfg.trumpWorlds, ch)
		if n == 0 {
			return
		}
		rng := chunkRNG(seed, ch)
		for _, w := range dealWorlds(v, rng, n) {
			base := startDeal(v, &w)
			var vals [2]int64
			for opt := range 2 {
				d := base
				if err := d.Bid(v.Seat, opt == 0); err != nil {
					panic("bot: bid: " + err.Error())
				}
				for d.Phase() == game.PhaseBid {
					s := d.Turn()
					_ = d.Bid(s, trumpValue(w[s], v.Turned) >= bidThreshold(0.5))
				}
				if d.Phase() == game.PhaseTrump {
					s := d.Turn()
					_ = d.ChooseTrump(s, bestTrumpNormal(w[s], true, v.Turned))
				}
				r := playOut(&d, sig, aggr, v.Seat)
				vals[opt] = int64(value(&r, team, appetite))
				st := &stats[ch][opt]
				st.total += vals[opt]
				st.n++
				if !r.Nat && r.PlayingTeam == team {
					st.made++
				}
				st.out.add(&r, team)
			}
			addPairs(stats[ch][:], vals[:], -1)
		}
	})
	for ch := range chunks {
		play.total += stats[ch][0].total
		play.n += stats[ch][0].n
		play.made += stats[ch][0].made
		play.out.merge(stats[ch][0].out)
		play.diffSq[1] += stats[ch][0].diffSq[1]
		pass.total += stats[ch][1].total
		pass.n += stats[ch][1].n
		pass.made += stats[ch][1].made
		pass.out.merge(stats[ch][1].out)
		pass.diffSq[0] += stats[ch][1].diffSq[0]
	}
	return play, pass
}

// bidBias is how many points of expected value a persona gives up to play
// (positive for bold players).
func bidBias(aggr float64) float64 { return 24 * (aggr - 0.5) }
