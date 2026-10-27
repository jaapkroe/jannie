package bot

import (
	"bufio"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"strings"
	"testing"

	"klaverjas/internal/game"
)

var identityOut = flag.String("identity.out", "", "TestIdentity: write the record of decisions to this file")

// TestIdentity records, for many seeded deals at tables of two, three and
// four in both trump modes and both rule sets, the decision of every level
// at every turn, the hints, grades and explanations, and the raw search
// statistics, to the file named by -identity.out. A change that must not
// alter any decision (a speed-up) leaves the file byte for byte the same.
// Run it before the change and after it, and compare (/src is the
// repository inside scripts/go):
//
//	scripts/go test -run '^TestIdentity$' ./internal/bot -args -identity.out=/src/id-before.txt
//	scripts/go test -run '^TestIdentity$' ./internal/bot -args -identity.out=/src/id-after.txt
//	cmp id-before.txt id-after.txt
//
// Skipped without the flag; it takes about half a minute.
func TestIdentity(t *testing.T) {
	if *identityOut == "" {
		t.Skip("needs -identity.out")
	}
	f, err := os.Create(*identityOut)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	defer w.Flush()
	saveA, saveG := adviseSearch, gradeSearch
	defer func() { adviseSearch, gradeSearch = saveA, saveG }()
	fallbacks.Store(0)

	small := searchConfig{playWorlds: 40, trumpWorlds: 32}
	for i := range 192 {
		cfg := small
		if i < 8 {
			cfg = defaultSearch // a few at the production size
		}
		adviseSearch = searchConfig{playWorlds: cfg.playWorlds, trumpWorlds: cfg.trumpWorlds, points: true}
		gradeSearch = adviseSearch
		gradeSearch.workers = 1
		identityFour(w, i, cfg)
	}
	for i := range 96 {
		cfg := small
		if i < 4 {
			cfg = defaultSearch
		}
		identitySmall(w, 3, i, cfg)
		identitySmall(w, 2, i, cfg)
	}
	fmt.Fprintf(w, "fallbacks %d\n", fallbacks.Load())
}

// identityPlayers returns a player per seat and level, with seeds from i.
func identityPlayers(i int, cfg searchConfig) [4][3]*player {
	var ps [4][3]*player
	for s := range ps {
		for l := range ps[s] {
			ps[s][l] = newPlayer(roster[(i+s+l)%len(roster)], Level(l), uint64(i*16+s*4+l), cfg)
		}
	}
	return ps
}

func fmtChoice(c Choice) string {
	switch {
	case c.Card != nil:
		return "c" + c.Card.String()
	case c.Suit != nil:
		return "s" + c.Suit.String()
	case c.Play != nil:
		return fmt.Sprint("p", *c.Play)
	}
	return "-"
}

func fmtGrade(g Grade) string {
	return fmt.Sprintf("{%v %v %v %s %s %q %v %v %v}", g.Stake, g.Lost, g.Gain, fmtChoice(g.Better), fmtChoice(g.Obvious), g.Text, g.Nat, g.Played, g.Other)
}

func fmtAdvice(a Advice) string {
	return fmt.Sprintf("%s %q", fmtChoice(Choice{a.Card, a.Suit, a.Play}), a.Text)
}

func fmtExplain(e Explanation) string {
	var b strings.Builder
	fmt.Fprintf(&b, "n=%s rule=%q st=%s hint=%s %q worlds=%d", fmtChoice(e.Normaal), e.Rule, fmtChoice(e.Sterk), fmtChoice(e.Hint), e.HintText, e.Worlds)
	for _, o := range e.Options {
		fmt.Fprintf(&b, " [%s %v %v %v %v]", fmtChoice(o.Choice), o.Value, o.SE, o.Outcome, o.Parts)
	}
	return b.String()
}

func fmtResults(res []playResult) string {
	var b strings.Builder
	for _, r := range res {
		fmt.Fprintf(&b, " %v:%d/%d %v %v %v", r.card, r.total, r.n, r.out, r.diffSq, r.parts)
	}
	return b.String()
}

// identityFour plays deal i at a table of four.
func identityFour(w *bufio.Writer, i int, cfg searchConfig) {
	rng := rand.New(rand.NewPCG(uint64(i), 77))
	mode, rules := game.TrumpMode(i%2), game.Rules(i/2%2)
	var sig *game.Signals
	switch i / 4 % 3 {
	case 1:
		sig = &game.Signals{Aas: true, KleintjeBoer: true, HoogLaag: true, BoerOverBoer: true}
	case 2:
		sig = &game.Signals{}
	}
	d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), mode, rules, game.Suit(rng.IntN(4)))
	ps := identityPlayers(i, cfg)
	fmt.Fprintf(w, "four %d mode=%v rules=%v sig=%v dealer=%d\n", i, mode, rules, sig, d.Dealer())
	view := func(s game.Seat) game.View {
		v := d.View(s)
		v.Signals = sig
		return v
	}
	if i%8 == 0 {
		for s := range game.Seat(4) {
			fmt.Fprintf(w, " luck %d %v\n", s, HandLuck(view(s)))
		}
	}
	for step := 0; d.Phase() != game.PhaseDone; step++ {
		s := d.Turn()
		v := view(s)
		lv := (i + int(s)) % 3
		fmt.Fprintf(w, " %d seat=%d phase=%s", step, s, v.Phase)
		var c Choice
		switch v.Phase {
		case game.PhaseBid:
			var bids [3]bool
			for l := range bids {
				bids[l] = ps[s][l].Bid(v)
			}
			fmt.Fprintf(w, " bids=%v", bids)
			yes, no := searchBid(&v, cfg, uint64(i)<<8|uint64(step), 0.3)
			fmt.Fprintf(w, " search=%+v %+v", yes, no)
			c.Play = &bids[lv]
		case game.PhaseTrump:
			var suits [3]game.Suit
			for l := range suits {
				suits[l] = ps[s][l].ChooseTrump(v)
			}
			fmt.Fprintf(w, " trumps=%v", suits)
			st := searchTrump(&v, cfg, uint64(i)<<8|uint64(step), 0.8)
			fmt.Fprintf(w, " search=%+v", st)
			c.Suit = &suits[lv]
		case game.PhasePlay:
			var cards [3]game.Card
			for l := range cards {
				cards[l] = ps[s][l].Play(v)
			}
			fmt.Fprintf(w, " legal=%v cards=%v", v.Legal, cards)
			if len(v.Legal) > 1 {
				tab := tableFromView(&v)
				fmt.Fprintf(w, " search=%s", fmtResults(searchPlay(&v, &tab, cfg, uint64(i)<<8|uint64(step), 0.9)))
			}
			if ch, ok := SignalChance(v, cards[2]); ok {
				fmt.Fprintf(w, " chance=%+v", ch)
			}
			c.Card = &cards[lv]
		}
		fmt.Fprintf(w, "\n  advise %s\n  grade %s\n  explain %s\n", fmtAdvice(Advise(v)), fmtGrade(GradeChoice(v, c)), fmtExplain(Explain(v)))
		var err error
		switch v.Phase {
		case game.PhaseBid:
			err = d.Bid(s, *c.Play)
		case game.PhaseTrump:
			err = d.ChooseTrump(s, *c.Suit)
		case game.PhasePlay:
			err = d.Play(s, *c.Card)
			if d.Current().Complete() {
				tv := view(s)
				fmt.Fprintf(w, "  trick %+v %q\n", TrickSignals(tv), ExplainTrick(tv.Tricks[len(tv.Tricks)-1], tv.Trump, [4]string{"a", "b", "c", "d"}))
			}
		}
		if err != nil {
			panic(err)
		}
	}
	fmt.Fprintf(w, " result %+v\n", d.Result())
}

// identitySmall plays deal i at a table of n (two or three).
func identitySmall(w *bufio.Writer, n, i int, cfg searchConfig) {
	rng := rand.New(rand.NewPCG(uint64(i), uint64(n)))
	mode, rules := game.TrumpMode(i%2), game.Rules(i/2%2)
	hands, talon := game.ShuffleFor(n, rng)
	d := game.NewDealFor(n, game.Seat(rng.IntN(n)), hands, talon, mode, rules, game.Suit(rng.IntN(4)))
	ps := identityPlayers(i, cfg)
	fmt.Fprintf(w, "small%d %d mode=%v rules=%v dealer=%d\n", n, i, mode, rules, d.Dealer())
	for step := 0; d.Phase() != game.PhaseDone; step++ {
		s := d.Turn()
		v := d.View(s)
		v.HandNo = 1
		lv := (i + int(s)) % 3
		fmt.Fprintf(w, " %d seat=%d phase=%s", step, s, v.Phase)
		var err error
		switch v.Phase {
		case game.PhaseAuction:
			var bids [3]int
			for l := range bids {
				bids[l] = ps[s][l].Auction(v)
			}
			fmt.Fprintf(w, " auction=%v", bids)
			for l := range bids {
				var made, total int
				for _, x := range ps[s][l].est.deals {
					made, total = made+x.made, total+x.total
				}
				fmt.Fprintf(w, " est%d=%d/%d/%d", l, len(ps[s][l].est.deals), made, total)
			}
			err = d.Auction(s, bids[lv])
		case game.PhaseDiscard:
			var ds [3][2]game.Card
			for l := range ds {
				ds[l] = ps[s][l].Discard(v)
			}
			fmt.Fprintf(w, " discards=%v", ds)
			err = d.Discard(s, ds[lv][:])
		case game.PhaseBid:
			var bids [3]bool
			for l := range bids {
				bids[l] = ps[s][l].Bid(v)
			}
			fmt.Fprintf(w, " bids=%v", bids)
			if n == 2 {
				fmt.Fprintf(w, " search=%+v", twoSearch(&v, cfg, uint64(i)<<8|uint64(step), 0.7, func(game.Suit) bool { return true }))
			}
			err = d.Bid(s, bids[lv])
		case game.PhaseTrump:
			var suits [3]game.Suit
			for l := range suits {
				suits[l] = ps[s][l].ChooseTrump(v)
			}
			fmt.Fprintf(w, " trumps=%v", suits)
			if n == 2 {
				fmt.Fprintf(w, " search=%+v", twoSearch(&v, cfg, uint64(i)<<8|uint64(step), 0.7, func(game.Suit) bool { return true }))
			} else {
				fmt.Fprintf(w, " search=%+v", soloSearch(&v, cfg, uint64(i)<<8|uint64(step), func(game.Suit) bool { return true }))
			}
			err = d.ChooseTrump(s, suits[lv])
		case game.PhasePlay:
			var cards [3]game.Card
			for l := range cards {
				cards[l] = ps[s][l].Play(v)
			}
			fmt.Fprintf(w, " legal=%v cards=%v", v.Legal, cards)
			if len(v.Legal) > 1 {
				fmt.Fprintf(w, " search=%s", fmtResults(smallSearchPlay(&v, cfg, uint64(i)<<8|uint64(step), 0.2)))
			}
			err = d.Play(s, cards[lv])
		}
		fmt.Fprintln(w)
		if err != nil {
			panic(err)
		}
	}
	fmt.Fprintf(w, " result %+v\n", d.Result())
}
