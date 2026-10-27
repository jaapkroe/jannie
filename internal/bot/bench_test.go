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

// BenchmarkAdvisePlay is a training hint in the middle of a hand.
func BenchmarkAdvisePlay(b *testing.B) {
	_, mid := benchViews()
	for b.Loop() {
		Advise(mid)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

// gradeViews returns the decisions of seat 0 with a choice in one hand
// played by normaal bots, as the review grades them.
func gradeViews() (vs []game.View, cs []Choice) {
	rng := rand.New(rand.NewPCG(59, 60))
	d := game.NewDeal(3, game.Shuffle(rng), game.Gedraaid, game.Amsterdams, game.Hearts)
	var players [4]Player
	for s := range players {
		players[s] = newPlayer(roster[s], Normaal, uint64(s), defaultSearch)
	}
	for d.Phase() != game.PhaseDone {
		s := d.Turn()
		v := d.View(s)
		var c Choice
		var err error
		switch d.Phase() {
		case game.PhaseBid:
			p := players[s].Bid(v)
			c.Play = &p
			err = d.Bid(s, p)
		case game.PhaseTrump:
			t := players[s].ChooseTrump(v)
			c.Suit = &t
			err = d.ChooseTrump(s, t)
		case game.PhasePlay:
			card := players[s].Play(v)
			c.Card = &card
			err = d.Play(s, card)
		}
		if err != nil {
			panic(err)
		}
		if s == 0 && (c.Card == nil || len(v.Legal) > 1) {
			vs, cs = append(vs, v), append(cs, c)
		}
	}
	return vs, cs
}

// BenchmarkGradeHand grades every decision of one player in one hand on
// one core, as the review does for each human (a match has 16 hands).
func BenchmarkGradeHand(b *testing.B) {
	vs, cs := gradeViews()
	for b.Loop() {
		for i := range vs {
			GradeChoice(vs[i], cs[i])
		}
	}
	b.ReportMetric(float64(len(vs)), "grades/op")
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

// BenchmarkHintGradeHand is the training game's work for the same
// decisions: the hint on the player's turn, then the grade of the choice.
func BenchmarkHintGradeHand(b *testing.B) {
	vs, cs := gradeViews()
	for b.Loop() {
		for i := range vs {
			Advise(vs[i])
			GradeChoice(vs[i], cs[i])
		}
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

// BenchmarkHandLuck is the review's worth of one dealt hand.
func BenchmarkHandLuck(b *testing.B) {
	rng := rand.New(rand.NewPCG(61, 62))
	d := game.NewDeal(3, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	v := d.View(1)
	HandLuck(v) // the baseline, once per process
	for b.Loop() {
		HandLuck(v)
	}
}

// smallBenchView plays a deal for n players with normaal bots until stop
// says the view of the seat on turn is the one to measure.
func smallBenchView(n int, seed uint64, stop func(d *game.Deal, v *game.View) bool) game.View {
	rng := rand.New(rand.NewPCG(seed, uint64(n)))
	hands, talon := game.ShuffleFor(n, rng)
	d := game.NewDealFor(n, 0, hands, talon, game.Utrechts, game.Amsterdams, game.Hearts)
	var players [4]Player
	for s := range players {
		players[s] = newPlayer(roster[s], Normaal, uint64(s), defaultSearch)
	}
	for {
		s := d.Turn()
		v := d.View(s)
		if stop(d, &v) {
			return v
		}
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

func atPhase(p game.Phase) func(*game.Deal, *game.View) bool {
	return func(d *game.Deal, v *game.View) bool { return d.Phase() == p }
}

func midPlay(d *game.Deal, v *game.View) bool {
	return d.Phase() == game.PhasePlay && d.TrickCount() >= 2 && len(v.Legal) >= 3
}

func benchSmallPlay(b *testing.B, n int) {
	v := smallBenchView(n, 63, midPlay)
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.Play(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkThreePlay(b *testing.B) { benchSmallPlay(b, 3) }
func BenchmarkSterkTwoPlay(b *testing.B)   { benchSmallPlay(b, 2) }

// BenchmarkSterkAuction is the first bid of a hand with three players:
// the estimate of playing alone (every level plays sampled deals out).
func BenchmarkSterkAuction(b *testing.B) {
	v := smallBenchView(3, 64, atPhase(game.PhaseAuction))
	for b.Loop() {
		p := newPlayer(roster[0], Sterk, 1, defaultSearch)
		p.Auction(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkDiscard(b *testing.B) {
	v := smallBenchView(3, 65, atPhase(game.PhaseDiscard))
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.Discard(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkThreeTrump(b *testing.B) {
	v := smallBenchView(3, 66, atPhase(game.PhaseTrump))
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.ChooseTrump(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkTwoTrump(b *testing.B) {
	v := smallBenchView(2, 67, atPhase(game.PhaseTrump))
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.ChooseTrump(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

// BenchmarkSterkTwoBid is the bid on the turned suit with two players.
func BenchmarkSterkTwoBid(b *testing.B) {
	rng := rand.New(rand.NewPCG(69, 70))
	hands, _ := game.ShuffleFor(2, rng)
	d := game.NewDealFor(2, 0, hands, nil, game.Gedraaid, game.Amsterdams, game.Hearts)
	v := d.View(d.Turn())
	p := newPlayer(roster[0], Sterk, 1, defaultSearch)
	for b.Loop() {
		p.Bid(v)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

// benchHand plays one deal for n players to the end with sterk bots on
// one core each: the CPU a table of bots costs per hand.
func benchHand(b *testing.B, n int, mode game.TrumpMode) {
	cfg := defaultSearch
	cfg.workers = 1
	rng := rand.New(rand.NewPCG(68, uint64(n)))
	hands, talon := game.ShuffleFor(n, rng)
	for b.Loop() {
		var players [4]Player
		for s := range players {
			players[s] = newPlayer(roster[s], Sterk, uint64(s), cfg)
		}
		d := game.NewDealFor(n, 0, hands, talon, mode, game.Amsterdams, game.Hearts)
		runSmallDeal(d, players)
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/1000/float64(b.N), "ms/op")
}

func BenchmarkSterkHandFourOneCore(b *testing.B)  { benchHand(b, 4, game.Gedraaid) }
func BenchmarkSterkHandThreeOneCore(b *testing.B) { benchHand(b, 3, game.Utrechts) }
func BenchmarkSterkHandTwoOneCore(b *testing.B)   { benchHand(b, 2, game.Gedraaid) }
