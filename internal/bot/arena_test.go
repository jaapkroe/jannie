package bot

import (
	"flag"
	"fmt"
	"math"
	"math/rand/v2"
	"runtime"
	"strings"
	"sync"
	"testing"

	"klaverjas/internal/game"
)

// arenaResult summarises a duplicate match between two levels.
type arenaResult struct {
	hands        int
	scoreA       float64 // average score per hand of team A
	scoreB       float64
	diffSE       float64 // standard error of the per-board difference
	natA, natB   int     // hands where A (B) played and went nat
	playA, playB int     // hands where A (B) was the playing team
}

func (r arenaResult) String() string {
	return fmt.Sprintf("%d potjes: %.1f tegen %.1f per potje (verschil %.1f ± %.1f); speelt %d/%d, nat %d/%d",
		r.hands, r.scoreA, r.scoreB, r.scoreA-r.scoreB, 2*r.diffSE, r.playA, r.playB, r.natA, r.natB)
}

// playArena plays boards deals twice (duplicate): team A first at seats 0
// and 2, then at seats 1 and 3, with the same cards, dealer and turned
// suit. Personas stay with the seats, so only the level changes sides.
func playArena(a, b Level, boards int, seed uint64, cfg searchConfig) arenaResult {
	type board struct {
		scoreA, scoreB int
		natA, natB     int
		playA, playB   int
	}
	res := make([]board, boards)
	var wg sync.WaitGroup
	jobs := make(chan int)
	for range runtime.GOMAXPROCS(0) {
		wg.Go(func() {
			for i := range jobs {
				rng := rand.New(rand.NewPCG(seed, uint64(i)))
				hands := game.Shuffle(rng)
				dealer := game.Seat(rng.IntN(4))
				turned := game.Suit(rng.IntN(4))
				mode := game.TrumpMode(i % 2)
				rules := game.Rules(i / 2 % 2)
				var bd board
				for swap := range 2 {
					var players [4]Player
					var lv [4]Level
					for s := range players {
						lv[s] = a
						if (s+swap)%2 == 1 {
							lv[s] = b
						}
						p := roster[(i+s)%len(roster)]
						players[s] = newPlayer(p, lv[s], seed^uint64(i*8+s), cfg)
					}
					d := game.NewDeal(dealer, hands, mode, rules, turned)
					runDeal(d, players)
					r := d.Result()
					teamA := swap // team of seat 0 is 0; A sits at seats with (s+swap)%2==0
					bd.scoreA += r.Score[teamA]
					bd.scoreB += r.Score[1-teamA]
					if r.PlayingTeam == teamA {
						bd.playA++
						if r.Nat {
							bd.natA++
						}
					} else {
						bd.playB++
						if r.Nat {
							bd.natB++
						}
					}
				}
				res[i] = bd
			}
		})
	}
	for i := range boards {
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	var out arenaResult
	out.hands = 2 * boards
	var sum, sumSq float64
	for _, bd := range res {
		out.scoreA += float64(bd.scoreA)
		out.scoreB += float64(bd.scoreB)
		out.natA += bd.natA
		out.natB += bd.natB
		out.playA += bd.playA
		out.playB += bd.playB
		d := float64(bd.scoreA-bd.scoreB) / 2
		sum += d
		sumSq += d * d
	}
	out.scoreA /= float64(out.hands)
	out.scoreB /= float64(out.hands)
	mean := sum / float64(boards)
	variance := sumSq/float64(boards) - mean*mean
	out.diffSE = math.Sqrt(variance/float64(boards)) / 2
	return out
}

// runDeal plays d to the end with players.
func runDeal(d *game.Deal, players [4]Player) {
	for d.Phase() != game.PhaseDone {
		s := d.Turn()
		v := d.View(s)
		var err error
		switch d.Phase() {
		case game.PhaseBid:
			err = d.Bid(s, players[s].Bid(v))
		case game.PhaseTrump:
			err = d.ChooseTrump(s, players[s].ChooseTrump(v))
		case game.PhasePlay:
			err = d.Play(s, players[s].Play(v))
		}
		if err != nil {
			panic(err)
		}
	}
}

var (
	arenaBoards = flag.Int("arena.boards", 1000, "arena: deals per match (each played twice)")
	arenaOnly   = flag.String("arena.only", "", "arena: run only matches whose \"a-b\" name contains this")
)

// TestArena checks that the levels are ordered: sterk > normaal > makkelijk.
func TestArena(t *testing.T) {
	if testing.Short() {
		t.Skip("arena is slow")
	}
	cfg := defaultSearch
	cfg.workers = 1
	boards := *arenaBoards
	cases := []struct {
		a, b   Level
		margin float64
	}{
		{Normaal, Makkelijk, 10},
		{Sterk, Normaal, 5},
		{Sterk, Makkelijk, 15},
	}
	for _, tc := range cases {
		if !strings.Contains(tc.a.String()+"-"+tc.b.String(), *arenaOnly) {
			continue
		}
		r := playArena(tc.a, tc.b, boards, 20261019, cfg)
		t.Logf("%s tegen %s: %v", tc.a, tc.b, r)
		if diff := r.scoreA - r.scoreB; diff < tc.margin || diff < 3*r.diffSE {
			t.Errorf("%s does not clearly beat %s: %.1f points per hand (want ≥ %.0f)", tc.a, tc.b, diff, tc.margin)
		}
	}
}
