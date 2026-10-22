package bot

import (
	"flag"
	"fmt"
	"math"
	"math/rand/v2"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"klaverjas/internal/game"
)

// checkedSmallDeal plays one deal at a table of two or three with players
// in every seat and fails the test on any invalid decision.
func checkedSmallDeal(t *testing.T, d *game.Deal, players [4]Player) {
	t.Helper()
	for d.Phase() != game.PhaseDone {
		s := d.Turn()
		v := d.View(s)
		var err error
		switch d.Phase() {
		case game.PhaseAuction:
			bid := players[s].Auction(v)
			if bid != 0 && (bid < v.MinNextBid() || bid > game.MaxBid || bid%game.BidStep != 0) {
				t.Fatalf("seat %d bid %d (at least %d)", s, bid, v.MinNextBid())
			}
			err = d.Auction(s, bid)
		case game.PhaseDiscard:
			ds := players[s].Discard(v)
			if ds[0] == ds[1] || !slices.Contains(v.Hand, ds[0]) || !slices.Contains(v.Hand, ds[1]) {
				t.Fatalf("seat %d lays away %v from %v", s, ds, v.Hand)
			}
			err = d.Discard(s, ds[:])
		case game.PhaseBid:
			err = d.Bid(s, players[s].Bid(v))
		case game.PhaseTrump:
			suit := players[s].ChooseTrump(v)
			if suit >= game.NumSuits || (v.Forced && v.Players != 3 && suit == v.Turned) {
				t.Fatalf("seat %d chose trump %v (forced %v, turned %v)", s, suit, v.Forced, v.Turned)
			}
			err = d.ChooseTrump(s, suit)
		case game.PhasePlay:
			c := players[s].Play(v)
			if !slices.Contains(v.Legal, c) {
				t.Fatalf("seat %d played %v, not in legal %v", s, c, v.Legal)
			}
			err = d.Play(s, c)
		}
		if err != nil {
			t.Fatalf("seat %d: %v", s, err)
		}
	}
}

// TestSmallDecisionsValid plays deals for two and three players with every
// level and persona in every seat, in both trump modes and rule sets.
func TestSmallDecisionsValid(t *testing.T) {
	deals := 600
	if testing.Short() {
		deals = 120
	}
	rng := rand.New(rand.NewPCG(5, 6))
	for i := range deals {
		n := 2 + i%2
		var players [4]Player
		for s := range n {
			k := i*3 + s
			players[s] = newPlayer(roster[k%len(roster)], Level(k/len(roster)%3), rng.Uint64(), quickSearch)
		}
		hands, talon := game.ShuffleFor(n, rng)
		d := game.NewDealFor(n, game.Seat(rng.IntN(n)), hands, talon, game.TrumpMode(i/2%2), game.Rules(i/4%2), game.Suit(rng.IntN(4)))
		checkedSmallDeal(t, d, players)
	}
	if n := fallbacks.Load(); n != 0 {
		t.Errorf("the search failed %d times and fell back to the rule-based choice", n)
	}
}

// TestSmallDefaultConfig runs the production search a few times.
func TestSmallDefaultConfig(t *testing.T) {
	deals := 8
	if testing.Short() {
		deals = 2
	}
	rng := rand.New(rand.NewPCG(7, 8))
	for i := range deals {
		n := 2 + i%2
		var players [4]Player
		for s := range n {
			players[s] = New(roster[(i+s)%len(roster)], Sterk, rng.Uint64())
		}
		hands, talon := game.ShuffleFor(n, rng)
		d := game.NewDealFor(n, game.Seat(rng.IntN(n)), hands, talon, game.TrumpMode(i/2%2), game.Amsterdams, game.Suit(rng.IntN(4)))
		checkedSmallDeal(t, d, players)
	}
}

// twoPlayerDeal starts a two-player deal in which seat 0 made hearts trump
// and plays the given cards.
func twoPlayerDeal(t *testing.T, hands [4][]game.Card, plays string) *game.Deal {
	t.Helper()
	d := game.NewDealFor(2, 1, hands, nil, game.Utrechts, game.Amsterdams, 0)
	if err := d.ChooseTrump(0, game.Hearts); err != nil {
		t.Fatal(err)
	}
	for _, c := range game.MustParseCards(plays) {
		if err := d.Play(d.Turn(), c); err != nil {
			t.Fatalf("play %v: %v", c, err)
		}
	}
	return d
}

func TestTwoPlayerPolicy(t *testing.T) {
	hands := [4][]game.Card{
		game.MustParseCards("AS 7S JH 7C 8C 9C TC 7D " + "TS 8S 9S QS KS 9H 8D 9D"),
		game.MustParseCards("JS 7H 8H AC QC KC AD TD " + "QH KH AH TH JC JD QD KD"),
	}
	d := twoPlayerDeal(t, hands, "")
	choose := func() game.Card {
		v := d.View(d.Turn())
		tab := pubFromView(&v)
		return tab.choose(v.Seat, setOf(v.Hand), setOf(v.Legal), openOf(&v, 1-v.Seat))
	}
	// Seat 0 made trump and holds the boer: it draws trumps.
	if c := choose(); c != card("JH") {
		t.Errorf("maker leads %v, want ♥B", c)
	}
	// Seat 1 must follow the trump lead; it gives the least.
	if err := d.Play(0, card("JH")); err != nil {
		t.Fatal(err)
	}
	if c := choose(); c != card("7H") {
		t.Errorf("follow to ♥B: %v, want ♥7", c)
	}
	if err := d.Play(1, card("7H")); err != nil {
		t.Fatal(err)
	}
	// Now ♠A wins for sure against seat 1's open cards (♠B is the only
	// spade): leading it brings in at least ♠B's 2 points.
	if c := choose(); c != card("AS") && c != card("TC") {
		t.Errorf("then %v, want a sure winner", c)
	}
}

func TestSoloPlan(t *testing.T) {
	// Strong hearts, a bare ♣10 (banked by laying it away) and a short
	// spade suit.
	h := setOf(game.MustParseCards("JH 9H AH TH KH TC 8C 7S AD KD 9D 8D"))
	trump, ds := soloPlan(h)
	if trump != game.Hearts {
		t.Errorf("trump %v, want hearts", trump)
	}
	got := []game.Card{ds[0], ds[1]}
	if !slices.Contains(got, card("TC")) || slices.Contains(got, card("AD")) || slices.Contains(got, card("JH")) {
		t.Errorf("lays away %v", got)
	}
}

func TestAuctionStrength(t *testing.T) {
	strong := game.MustParseCards("JH 9H AH TH KH QH AS TS AD TD")
	weak := game.MustParseCards("7H 8H 7S 8S 9S 7D 8D 9C 8C 7C")
	for _, tc := range []struct {
		hand []game.Card
		bid  bool
	}{{strong, true}, {weak, false}} {
		v := game.View{Players: 3, Seat: 1, Hand: tc.hand, Dealer: 0, Voorhand: 1, Phase: game.PhaseAuction,
			Turn: 1, Bids: [4]int{-1, -1, -1, -1}, Bidder: game.NoSeat}
		for _, lvl := range []Level{Normaal, Sterk} {
			b := newPlayer(roster[0], lvl, 1, quickSearch)
			if got := b.Auction(v) > 0; got != tc.bid {
				t.Errorf("%v with %v: bids %v, want %v", lvl, tc.hand, got, tc.bid)
			}
		}
	}
}

// smallArena plays boards deals at a table of n with level a in one seat
// and level b in the others, the same cards once for each seat a takes,
// and returns a's and b's average gain per hand and the standard error of
// the difference.
func smallArena(n int, a, b Level, boards int, seed uint64, cfg searchConfig) (ga, gb, se float64) {
	diffs := make([]float64, boards)
	sumA := make([]float64, boards)
	sumB := make([]float64, boards)
	var wg sync.WaitGroup
	jobs := make(chan int)
	for range runtime.GOMAXPROCS(0) {
		wg.Go(func() {
			for i := range jobs {
				rng := rand.New(rand.NewPCG(seed, uint64(i)))
				hands, talon := game.ShuffleFor(n, rng)
				dealer := game.Seat(rng.IntN(n))
				turned := game.Suit(rng.IntN(4))
				mode := game.TrumpMode(i % 2)
				for at := range n {
					var players [4]Player
					for s := range n {
						lvl := b
						if s == at {
							lvl = a
						}
						players[s] = newPlayer(roster[(i+s)%len(roster)], lvl, seed^uint64(i*8+s), cfg)
					}
					d := game.NewDealFor(n, dealer, hands, talon, mode, game.Amsterdams, turned)
					runSmallDeal(d, players)
					r := d.Result()
					others := 0.0
					for s := range n {
						if s != at {
							others += float64(r.Gains[game.ScorerOf(game.Seat(s), n)])
						}
					}
					mine := float64(r.Gains[game.ScorerOf(game.Seat(at), n)])
					others /= float64(n - 1)
					sumA[i] += mine / float64(n)
					sumB[i] += others / float64(n)
					diffs[i] += (mine - others) / float64(n)
				}
			}
		})
	}
	for i := range boards {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	var sum, sumSq float64
	for i := range boards {
		ga += sumA[i] / float64(boards)
		gb += sumB[i] / float64(boards)
		sum += diffs[i]
		sumSq += diffs[i] * diffs[i]
	}
	mean := sum / float64(boards)
	se = math.Sqrt((sumSq/float64(boards) - mean*mean) / float64(boards))
	return ga, gb, se
}

var arenaDefend = flag.Float64("arena.defend", 0, "arena: defendValue to try (0 keeps it)")

// runSmallDeal plays d to the end with players.
func runSmallDeal(d *game.Deal, players [4]Player) {
	for d.Phase() != game.PhaseDone {
		s := d.Turn()
		v := d.View(s)
		var err error
		switch d.Phase() {
		case game.PhaseAuction:
			err = d.Auction(s, players[s].Auction(v))
		case game.PhaseDiscard:
			ds := players[s].Discard(v)
			err = d.Discard(s, ds[:])
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

// TestSmallArena checks that the levels keep their order at the smaller
// tables: sterk beats normaal, normaal beats makkelijk.
func TestSmallArena(t *testing.T) {
	if *arenaDefend != 0 {
		defendValue = *arenaDefend
	}
	if testing.Short() {
		t.Skip("arena is slow")
	}
	cfg := defaultSearch
	cfg.workers = 1
	boards := max(*arenaBoards/4, 50)
	for _, n := range []int{3, 2} {
		for _, tc := range []struct{ a, b Level }{{Normaal, Makkelijk}, {Sterk, Normaal}} {
			name := fmt.Sprintf("%d-%s-%s", n, tc.a, tc.b)
			if !strings.Contains(name, *arenaOnly) {
				continue
			}
			ga, gb, se := smallArena(n, tc.a, tc.b, boards, 20261022, cfg)
			t.Logf("%d spelers, %s tegen %s: %.1f tegen %.1f per potje (± %.1f)", n, tc.a, tc.b, ga, gb, 2*se)
			if ga-gb < 2*se {
				t.Errorf("%d players: %s does not beat %s: %.1f against %.1f (± %.1f)", n, tc.a, tc.b, ga, gb, 2*se)
			}
		}
	}
}
