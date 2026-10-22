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
}

// defaultSearch keeps a decision well under ~150 ms on a 16-core machine.
var defaultSearch = searchConfig{playWorlds: 400, trumpWorlds: 320}

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
	var buf [8]game.Card
	for s.d.Phase() == game.PhasePlay {
		seat := s.d.Turn()
		legal := setOf(s.d.AppendLegal(buf[:0]))
		hand := setOf(s.d.AppendHand(buf[:0], seat))
		m := newMover(&s.t, seat, hand, legal, aggr[seat])
		s.play(m.choose())
	}
}

// value is the outcome for team: its score minus the opponents' score,
// including nat and pit, plus the persona's appetite for pit.
func (s *sim) value(team int, aggr float64) int {
	r := s.d.Result()
	v := r.Score[team] - r.Score[1-team]
	if r.Pit && r.PitTeam == team {
		v += int(pitAppetite * aggr)
	}
	return v
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
	// diffSq[j] sums, over the worlds, the squared difference between this
	// card's value and that of candidate j (in v.Legal order): every
	// candidate is played out in the same worlds, see pairSE.
	diffSq [8]int64
}

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
	var counts [chunks]int
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
		for _, w := range k.worlds(sp, rng, n) {
			for s := range hands {
				hands[s] = w[s].appendCards(hands[s][:0])
			}
			base, err := game.Resume(*v, hands)
			if err != nil {
				panic("bot: resume: " + err.Error())
			}
			for i, c := range legal {
				s := sim{d: *base, t: *tab}
				s.play(c)
				s.run(&ag)
				vals[i] = int64(s.value(team, aggr))
				sums[ch][i] += vals[i]
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
}

func (o optionStats) mean() float64 {
	if o.n == 0 {
		return 0
	}
	return float64(o.total) / float64(o.n)
}

func (o optionStats) madeRate() float64 {
	if o.n == 0 {
		return 0
	}
	return float64(o.made) / float64(o.n)
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

// playOut finishes deal d (in phase play) and returns the value for team.
func playOut(d *game.Deal, team int, aggr float64, seat game.Seat) (int, bool) {
	trump, _ := d.Trump()
	s := sim{d: *d, t: newTable(d.Voorhand(), trump, d.TrumpBy(), d.Rules())}
	ag := [4]float64{0.5, 0.5, 0.5, 0.5}
	ag[seat] = aggr
	s.run(&ag)
	r := s.d.Result()
	return s.value(team, aggr), !r.Nat
}

// searchTrump evaluates each allowed trump suit for v.Seat (utrechts, or
// forced in gedraaid) by playing out sampled deals.
func searchTrump(v *game.View, cfg searchConfig, seed uint64, aggr float64) [game.NumSuits]optionStats {
	var stats [chunks][game.NumSuits]optionStats
	team := v.Seat.Team()
	cfg.runChunks(func(ch int) {
		n := perChunk(cfg.trumpWorlds, ch)
		if n == 0 {
			return
		}
		rng := chunkRNG(seed, ch)
		for _, w := range dealWorlds(v, rng, n) {
			base := startDeal(v, &w)
			for s := game.Suit(0); s < game.NumSuits; s++ {
				if v.Forced && s == v.Turned {
					continue
				}
				d := base
				if err := d.ChooseTrump(v.Seat, s); err != nil {
					panic("bot: trump: " + err.Error())
				}
				val, made := playOut(&d, team, aggr, v.Seat)
				st := &stats[ch][s]
				st.total += int64(val)
				st.n++
				if made {
					st.made++
				}
			}
		}
	})
	var out [game.NumSuits]optionStats
	for ch := range chunks {
		for s := range out {
			out[s].total += stats[ch][s].total
			out[s].n += stats[ch][s].n
			out[s].made += stats[ch][s].made
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
	cfg.runChunks(func(ch int) {
		n := perChunk(cfg.trumpWorlds, ch)
		if n == 0 {
			return
		}
		rng := chunkRNG(seed, ch)
		for _, w := range dealWorlds(v, rng, n) {
			base := startDeal(v, &w)
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
				val, made := playOut(&d, team, aggr, v.Seat)
				st := &stats[ch][opt]
				st.total += int64(val)
				st.n++
				if made && d.PlayingTeam() == team {
					st.made++
				}
			}
		}
	})
	for ch := range chunks {
		play.total += stats[ch][0].total
		play.n += stats[ch][0].n
		play.made += stats[ch][0].made
		pass.total += stats[ch][1].total
		pass.n += stats[ch][1].n
		pass.made += stats[ch][1].made
	}
	return play, pass
}

// bidBias is how many points of expected value a persona gives up to play
// (positive for bold players).
func bidBias(aggr float64) float64 { return 24 * (aggr - 0.5) }
