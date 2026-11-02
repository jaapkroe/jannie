package toepbot

import (
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

var cards = game.MustParseCards

// decide applies the decision of the bot of the seat whose answer the
// round of d awaits (or of every seat in the time for a was).
func decide(t testing.TB, d *toepen.Deal, bots []*Player) {
	t.Helper()
	switch d.Phase() {
	case toepen.PhaseWas:
		for s := range game.Seat(d.Players()) {
			if d.Status(s) == toepen.StatusIn && !d.Answered(s) {
				if err := d.Was(s, bots[s].Was(d.View(s))); err != nil {
					t.Fatal(err)
				}
				if d.Phase() != toepen.PhaseWas {
					return
				}
			}
		}
	case toepen.PhaseCheck:
		s := d.Turn()
		if _, err := d.Check(s, bots[s].Check(d.View(s))); err != nil {
			t.Fatal(err)
		}
	case toepen.PhaseToep:
		s := d.Turn()
		if err := d.Answer(s, bots[s].Answer(d.View(s))); err != nil {
			t.Fatal(err)
		}
	case toepen.PhasePlay:
		s := d.Turn()
		v := d.View(s)
		if bots[s].Toep(v) {
			if err := d.Toep(s); err != nil {
				t.Fatal(err)
			}
			return
		}
		c := bots[s].Play(v)
		if !slices.Contains(v.Legal, c) {
			t.Fatalf("%v played %v, legal %v", bots[s].lvl, c, v.Legal)
		}
		if err := d.Play(s, c); err != nil {
			t.Fatal(err)
		}
	}
}

// Every level only makes legal decisions, at every table size, and the
// matches end.
func TestLegalDecisions(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 5))
	n := 60
	if testing.Short() {
		n = 18
	}
	for k := range n {
		players := 2 + k%5
		bots := make([]*Player, players)
		for s := range bots {
			bots[s] = New(rng.Float64(), Level((k+s)%3), rng.Uint64())
		}
		rules := toepen.Rules{Limit: 10, Was: k%2 == 0, Armoede: k%3 != 0}
		m := toepen.NewMatch(players, rules, 0)
		for rounds := 0; !m.Over(); rounds++ {
			if rounds > 200 {
				t.Fatal("match does not end")
			}
			d := m.Deal(toepen.Shuffle(rng))
			for steps := 0; d.Phase() != toepen.PhaseDone; steps++ {
				if steps > 300 {
					t.Fatal("round does not end")
				}
				decide(t, d, bots)
			}
			m.Settle(d)
		}
	}
}

func TestNormalCard(t *testing.T) {
	all := func(game.Seat) bool { return true }
	lead := toepen.Trick{Leader: 0}
	// Leading: low, and not from the suit of the card kept for the end.
	if c := normalCard(cards("TH JH 8S QD"), lead, all); c != cards("QD")[0] {
		t.Errorf("lead %v, want ♦V", c)
	}
	// Following: the lowest, keeping the best.
	tr := toepen.Trick{Leader: 1, Cards: []game.Played{{Seat: 1, Card: cards("8H")[0]}}}
	if c := normalCard(cards("TH JH 9H AS"), tr, all); c != cards("JH")[0] {
		t.Errorf("follow %v, want ♥B", c)
	}
	// Cannot follow: throw the weakest.
	if c := normalCard(cards("TS QD 9C"), tr, all); c != cards("QD")[0] {
		t.Errorf("discard %v, want ♦V", c)
	}
	// The trick before the last: take it with the card not kept.
	if c := normalCard(cards("9H TH"), tr, all); c != cards("9H")[0] {
		t.Errorf("third trick %v, want ♥9", c)
	}
}

func TestAnswerWhenOutAnyway(t *testing.T) {
	// Passing at stake 2 costs 1 point: seat 0 has 9 of 10, so it is out
	// either way and goes along.
	p := New(0, Normaal, 1)
	v := toepen.View{
		Players: 3, Seat: 0, Phase: toepen.PhaseToep, Turn: 0, Stake: 2,
		Rules: toepen.Rules{Limit: 10}, Hand: cards("JH QS KD 8C"),
		Points: [toepen.MaxPlayers]int{9, 0, 0},
		Status: [toepen.MaxPlayers]toepen.Status{toepen.StatusIn, toepen.StatusIn, toepen.StatusIn},
		Cards:  [toepen.MaxPlayers]int{4, 4, 4},
	}
	if !p.Answer(v) {
		t.Error("passed into going out")
	}
	// With nothing at risk and a hopeless hand it passes.
	v.Points[0] = 0
	v.Toeps = []toepen.Toep{{Seat: 1, Stake: 2}}
	v.Current = toepen.Trick{Leader: 2, Cards: []game.Played{{Seat: 2, Card: cards("TH")[0]}}}
	v.Cards[2] = 3
	if p.Answer(v) {
		t.Error("went along with nothing")
	}
}

func TestWasChance(t *testing.T) {
	// Against counting every hand of four from the 28 cards a hand of
	// four eights leaves.
	pool := slices.DeleteFunc(game.NewDeck(), func(c game.Card) bool { return c.Rank == game.Eight })
	n, was := 0, 0
	for a := range pool {
		for b := a + 1; b < len(pool); b++ {
			for c := b + 1; c < len(pool); c++ {
				for d := c + 1; d < len(pool); d++ {
					n++
					if toepen.Was([]game.Card{pool[a], pool[b], pool[c], pool[d]}) != toepen.NoWas {
						was++
					}
				}
			}
		}
	}
	if got, want := wasChance(pool), float64(was)/float64(n); math.Abs(got-want) > 1e-12 {
		t.Errorf("wasChance %v, counted %v", got, want)
	}
}

func TestCheck(t *testing.T) {
	v := toepen.View{
		Players: 3, Seat: 1, Phase: toepen.PhaseCheck, Turn: 1, Claimant: 0, Stake: 1,
		Rules:  toepen.Rules{Limit: 10, Was: true},
		Status: [toepen.MaxPlayers]toepen.Status{toepen.StatusIn, toepen.StatusIn, toepen.StatusIn},
	}
	p := New(0.5, Sterk, 1)
	// Holding four pictures, a real was is unlikely: check.
	v.Hand = cards("JH QS KD AC")
	if !p.Check(v) {
		t.Error("did not check with four pictures in hand")
	}
	// Holding no picture and no 7, a real one is likely: let it go.
	v.Hand = cards("8H 9S TD 8C")
	if p.Check(v) {
		t.Error("checked with no pictures in hand")
	}
}

// The levels against each other at a table of four, two seats each, every
// deal played twice with the levels on swapped seats: the stronger level
// takes fewer penalty points per round.
func TestArena(t *testing.T) {
	if testing.Short() {
		t.Skip("arena: slow")
	}
	pairs := []struct {
		strong, weak Level
		deals        int
	}{
		{Normaal, Makkelijk, 1500},
		{Sterk, Normaal, 700},
	}
	rules := toepen.Rules{Limit: 1000, Was: true}
	for _, pr := range pairs {
		rng := rand.New(rand.NewPCG(42, uint64(pr.strong)))
		var strong, weak float64
		for range pr.deals {
			deck := toepen.Shuffle(rng)
			dealer := game.Seat(rng.IntN(4))
			for swap := range 2 {
				bots := make([]*Player, 4)
				for s := range bots {
					lvl := pr.weak
					if (s+swap)%2 == 0 {
						lvl = pr.strong
					}
					bots[s] = New(0.5, lvl, rng.Uint64())
				}
				d := toepen.NewDeal(4, rules, dealer, [toepen.MaxPlayers]int{}, deck)
				for d.Phase() != toepen.PhaseDone {
					decide(t, d, bots)
				}
				for s, g := range d.Result().Gains {
					if bots[s].lvl == pr.strong {
						strong += float64(g)
					} else {
						weak += float64(g)
					}
				}
			}
		}
		rounds := float64(2 * pr.deals)
		t.Logf("%v %.3f vs %v %.3f penalty points per round for two seats", pr.strong, strong/rounds, pr.weak, weak/rounds)
		if strong >= weak {
			t.Errorf("%v (%.0f points) does not beat %v (%.0f)", pr.strong, strong, pr.weak, weak)
		}
	}
}

func BenchmarkSterkCard(b *testing.B) {
	rng := rand.New(rand.NewPCG(1, 2))
	p := New(0.5, Sterk, 3)
	for b.Loop() {
		d := toepen.NewDeal(4, toepen.Rules{Limit: 10}, 3, [toepen.MaxPlayers]int{}, toepen.Shuffle(rng))
		v := d.View(d.Turn())
		p.Toep(v)
		p.Play(v)
	}
}

func TestChat(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 1))
	for kind := range lines {
		said := 0
		for range 200 {
			text := Chat("bram", 1, ChatEvent{Kind: kind, Mine: true, Points: 3}, rng)
			if text == "" {
				continue
			}
			said++
			if strings.Contains(text, "{n}") || strings.Contains(text, "goedenavond") {
				t.Errorf("%s: %q", kind, text)
			}
		}
		if said == 0 && !strings.HasSuffix(kind, "/opp") {
			t.Errorf("never a line for %s", kind)
		}
	}
	if Chat("dirk", 1, ChatEvent{Kind: "toep"}, rand.New(rand.NewPCG(2, 2))) == "Toep!" {
		t.Error("someone else's toep is not the bot's own")
	}
	if Chat("dirk", 1, ChatEvent{Kind: "reply", Text: "Hoi allemaal"}, rng) == "" {
		t.Error("no answer to hoi")
	}
	if Chat("dirk", 1, ChatEvent{Kind: "nope"}, rng) != "" {
		t.Error("a line for an unknown kind")
	}
}
