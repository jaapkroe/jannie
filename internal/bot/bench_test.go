package bot

import (
	"math/rand/v2"
	"testing"
	"time"

	"klaverjas/internal/game"
)

// benchViews returns views at the first lead and in the middle of a hand.
func benchViews() (first, mid game.View) {
	rng := rand.New(rand.NewPCG(51, 52))
	d := game.NewDeal(3, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	v := d.View(0)
	if err := d.ChooseTrump(0, bestTrumpNormal(setOf(v.Hand), false, 0)); err != nil {
		panic(err)
	}
	first = d.View(0)
	for {
		s := d.Turn()
		v := d.View(s)
		if d.TrickCount() >= 3 && len(v.Legal) >= 3 {
			return first, v
		}
		if err := d.Play(s, normalChoice(&v, 0.5)); err != nil {
			panic(err)
		}
	}
}

func benchPlay(b *testing.B, v game.View, cfg searchConfig) {
	p := newPlayer(roster[0], Sterk, 1, cfg)
	b.ResetTimer()
	for b.Loop() {
		p.Play(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkFirstLead(b *testing.B) {
	first, _ := benchViews()
	benchPlay(b, first, defaultSearch)
}

func BenchmarkSterkMidHand(b *testing.B) {
	_, mid := benchViews()
	benchPlay(b, mid, defaultSearch)
}

// BenchmarkSterkFirstLeadOneCore shows the CPU cost of one decision.
func BenchmarkSterkFirstLeadOneCore(b *testing.B) {
	first, _ := benchViews()
	cfg := defaultSearch
	cfg.workers = 1
	benchPlay(b, first, cfg)
}

func BenchmarkSterkChooseTrump(b *testing.B) {
	rng := rand.New(rand.NewPCG(53, 54))
	d := game.NewDeal(3, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	v := d.View(0)
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.ChooseTrump(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkBid(b *testing.B) {
	rng := rand.New(rand.NewPCG(55, 56))
	d := game.NewDeal(3, game.Shuffle(rng), game.Gedraaid, game.Amsterdams, game.Hearts)
	v := d.View(0)
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.Bid(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkNormaalPlay(b *testing.B) {
	_, mid := benchViews()
	p := newPlayer(roster[0], Normaal, 1, defaultSearch)
	for b.Loop() {
		p.Play(mid)
	}
}

// BenchmarkPlayout is one rule-based playout of a whole hand.
func BenchmarkPlayout(b *testing.B) {
	rng := rand.New(rand.NewPCG(57, 58))
	d := game.NewDeal(3, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	if err := d.ChooseTrump(0, game.Hearts); err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		playOut(d, game.DefaultSignals, 0.5, 0)
	}
}

// TestSterkDecisionTime keeps the worst decision (the first lead) within
// the design budget of about 150 ms on a multi-core machine.
func TestSterkDecisionTime(t *testing.T) {
	if testing.Short() {
		t.Skip("timing")
	}
	first, _ := benchViews()
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	p.Play(first) // warm up
	start := time.Now()
	const n = 5
	for range n {
		p.Play(first)
	}
	per := time.Since(start) / n
	t.Logf("sterk first lead: %v per decision", per)
	if per > 400*time.Millisecond {
		t.Errorf("sterk decision takes %v, far over the ~150 ms budget", per)
	}
}
