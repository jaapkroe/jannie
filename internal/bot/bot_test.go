package bot

import (
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"klaverjas/internal/game"
)

// quickSearch keeps sterk cheap in tests that only check legality.
var quickSearch = searchConfig{playWorlds: 16, trumpWorlds: 16, workers: 1}

func TestRoster(t *testing.T) {
	ids := []string{"dirk", "truus", "sjaak", "fatima", "kees", "ans", "bram", "vera"}
	r := Roster()
	if len(r) != len(ids) {
		t.Fatalf("roster has %d personas, want %d", len(r), len(ids))
	}
	colors := map[string]bool{}
	for i, p := range r {
		if p.ID != ids[i] {
			t.Errorf("persona %d id %q, want %q", i, p.ID, ids[i])
		}
		if p.Name == "" || p.Emoji == "" || p.Bio == "" || strings.Contains(p.Name, "(AI)") {
			t.Errorf("persona %q incomplete: %+v", p.ID, p)
		}
		if len(p.Color) != 7 || p.Color[0] != '#' || colors[p.Color] {
			t.Errorf("persona %q color %q not a distinct #rrggbb", p.ID, p.Color)
		}
		colors[p.Color] = true
		if p.Aggression < 0 || p.Aggression > 1 || p.Chattiness < 0 || p.Chattiness > 1 || p.Speed < 0.6 || p.Speed > 1.4 {
			t.Errorf("persona %q traits out of range: %+v", p.ID, p)
		}
		if got, ok := ByID(p.ID); !ok || got != p {
			t.Errorf("ByID(%q) = %+v, %v", p.ID, got, ok)
		}
	}
	if _, ok := ByID("nobody"); ok {
		t.Error("ByID found an unknown id")
	}
	if a, b := Roster(), Roster(); &a[0] == &b[0] {
		t.Error("Roster returns a shared slice")
	}
}

func TestParseLevel(t *testing.T) {
	for _, l := range []Level{Makkelijk, Normaal, Sterk} {
		got, err := ParseLevel(l.String())
		if err != nil || got != l {
			t.Errorf("ParseLevel(%q) = %v, %v", l.String(), got, err)
		}
	}
	if got, err := ParseLevel("expert"); err == nil || got != Normaal {
		t.Errorf("ParseLevel(expert) = %v, %v; want Normaal and an error", got, err)
	}
}

// checkedDeal plays one deal with players in every seat and fails the test
// on any invalid decision.
func checkedDeal(t *testing.T, d *game.Deal, players [4]Player) {
	t.Helper()
	for d.Phase() != game.PhaseDone {
		s := d.Turn()
		v := d.View(s)
		var err error
		switch d.Phase() {
		case game.PhaseBid:
			err = d.Bid(s, players[s].Bid(v))
		case game.PhaseTrump:
			suit := players[s].ChooseTrump(v)
			if suit >= game.NumSuits || (v.Forced && suit == v.Turned) {
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

// TestDecisionsAlwaysValid plays thousands of deals with every level and
// persona in every seat, in both trump modes and both rule sets.
func TestDecisionsAlwaysValid(t *testing.T) {
	deals := 2400
	if testing.Short() {
		deals = 480
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range deals {
		var players [4]Player
		for s := range players {
			k := i*4 + s
			p := roster[k%len(roster)]
			lvl := Level(k / len(roster) % 3)
			players[s] = newPlayer(p, lvl, rng.Uint64(), quickSearch)
		}
		mode := game.TrumpMode(i % 2)
		rules := game.Rules(i / 2 % 2)
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), mode, rules, game.Suit(rng.IntN(4)))
		checkedDeal(t, d, players)
	}
	if n := fallbacks.Load(); n != 0 {
		t.Errorf("the search failed %d times and fell back to the rule-based choice", n)
	}
}

// TestDefaultConfigValid runs the production configuration (New) a few times.
func TestDefaultConfigValid(t *testing.T) {
	deals := 24
	if testing.Short() {
		deals = 4
	}
	rng := rand.New(rand.NewPCG(3, 4))
	for i := range deals {
		var players [4]Player
		for s := range players {
			players[s] = New(roster[(i+s)%len(roster)], Level((i+s)%3), rng.Uint64())
		}
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		checkedDeal(t, d, players)
	}
}

// allPassed returns a gedraaid deal in which everybody passed.
func allPassed(rng *rand.Rand, rules game.Rules) *game.Deal {
	d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.Gedraaid, rules, game.Suit(rng.IntN(4)))
	for range 4 {
		if err := d.Bid(d.Turn(), false); err != nil {
			panic(err)
		}
	}
	return d
}

func TestForcedTrumpNeverTurned(t *testing.T) {
	n := 300
	if testing.Short() {
		n = 60
	}
	rng := rand.New(rand.NewPCG(5, 6))
	for i := range n {
		d := allPassed(rng, game.Rules(i%2))
		v := d.View(d.Turn())
		if !v.Forced || v.Phase != game.PhaseTrump {
			t.Fatalf("not a forced choice: %+v", v)
		}
		for _, lvl := range []Level{Makkelijk, Normaal, Sterk} {
			for _, p := range roster {
				if s := newPlayer(p, lvl, uint64(i), quickSearch).ChooseTrump(v); s == v.Turned || s >= game.NumSuits {
					t.Fatalf("%s/%s chose %v with turned %v", p.ID, lvl, s, v.Turned)
				}
			}
		}
		if i%10 == 0 {
			if a := Advise(v); a.Suit == nil || *a.Suit == v.Turned || !strings.Contains(a.Text, "Kies "+a.Suit.Symbol()) {
				t.Fatalf("forced advice %+v (turned %v)", a, v.Turned)
			}
		}
	}
}

// Phrases of play hints that claim the trick for the mover's team, or
// that the mover cannot win it, and of hints that name no reason.
var (
	sureClaims = []string{"zo pak je de slag", "niemand na je kan hier nog overheen", "de slag is zeker", "slag al zeker", "slag zeker voor jullie"}
	loseClaims = []string{"Je kunt de slag niet winnen", "je kunt de slag niet winnen"}
	noReasons  = []string{"naar verwachting het meeste op", "naar verwachting meer", "volgens de berekening"}
)

func containsAny(s string, subs []string) bool {
	return slices.ContainsFunc(subs, func(sub string) bool { return strings.Contains(s, sub) })
}

// TestAdviseAlwaysValid asks for advice at every decision of some deals,
// with every seat following it. Play hints must be true to what happens in
// the trick, and few may lack a reason (training hints teach, design §4.2).
func TestAdviseAlwaysValid(t *testing.T) {
	deals := 16
	if testing.Short() {
		deals = 3
	}
	rng := rand.New(rand.NewPCG(7, 8))
	choices, generic := 0, 0
	for i := range deals {
		d := game.NewDeal(game.Seat(rng.IntN(4)), game.Shuffle(rng), game.TrumpMode(i%2), game.Rules(i/2%2), game.Suit(rng.IntN(4)))
		type claim struct {
			seat game.Seat
			sure bool // else: the mover cannot win the trick
			text string
		}
		var claims []claim
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			a := Advise(v)
			if a.Text == "" || strings.Contains(a.Text, "%") {
				t.Fatalf("advice without text: %+v", a)
			}
			checkTerms(t, a.Text)
			var err error
			switch d.Phase() {
			case game.PhaseBid:
				if a.Play == nil || a.Card != nil || a.Suit != nil {
					t.Fatalf("bid advice %+v", a)
				}
				err = d.Bid(s, *a.Play)
			case game.PhaseTrump:
				if a.Suit == nil || a.Card != nil || a.Play != nil || (v.Forced && *a.Suit == v.Turned) {
					t.Fatalf("trump advice %+v", a)
				}
				err = d.ChooseTrump(s, *a.Suit)
			case game.PhasePlay:
				if a.Card == nil || a.Suit != nil || a.Play != nil || !slices.Contains(v.Legal, *a.Card) {
					t.Fatalf("play advice %+v for legal %v", a, v.Legal)
				}
				if !strings.Contains(a.Text, game.CardShortNL(*a.Card)) {
					t.Fatalf("advice %q does not name %v", a.Text, game.CardShortNL(*a.Card))
				}
				if again := Advise(v); again.Text != a.Text || *again.Card != *a.Card {
					t.Fatalf("advice not deterministic: %+v then %+v", a, again)
				}
				if strings.Contains(a.Text, "houd je hoge troeven achter de hand") && setOf(v.Hand).higher(*a.Card, v.Trump) == 0 {
					t.Errorf("%q, but %v is the highest trump in hand %v", a.Text, *a.Card, v.Hand)
				}
				if len(v.Legal) > 1 {
					choices++
					if containsAny(a.Text, noReasons) {
						generic++
					}
				}
				switch {
				case containsAny(a.Text, sureClaims):
					claims = append(claims, claim{s, true, a.Text})
				case containsAny(a.Text, loseClaims):
					claims = append(claims, claim{s, false, a.Text})
				}
				n := d.TrickCount()
				err = d.Play(s, *a.Card)
				if d.TrickCount() > n {
					w := d.Tricks()[n].Winner
					for _, c := range claims {
						if c.sure && w.Team() != c.seat.Team() || !c.sure && w == c.seat {
							t.Errorf("seat %d was told %q, and seat %d won the trick", c.seat, c.text, w)
						}
					}
					claims = claims[:0]
				}
			}
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Logf("%d of %d play hints with a choice name no reason", generic, choices)
	if choices >= 200 && float64(generic) > 0.04*float64(choices) {
		t.Errorf("%d of %d play hints name no reason, want at most 4%%", generic, choices)
	}
	// Not your turn: no advice.
	d := game.NewDeal(0, game.Shuffle(rng), game.Utrechts, game.Amsterdams, 0)
	if a := Advise(d.View(3)); a.Card != nil || a.Suit != nil || a.Play != nil || a.Text != "" {
		t.Errorf("advice when it is not your turn: %+v", a)
	}
	if n := fallbacks.Load(); n != 0 {
		t.Errorf("the search failed %d times", n)
	}
}

// TestDeterministic checks that equal seeds give equal games, whatever the
// number of search goroutines.
func TestDeterministic(t *testing.T) {
	run := func(workers int) []game.Card {
		cfg := searchConfig{playWorlds: 48, trumpWorlds: 32, workers: workers}
		rng := rand.New(rand.NewPCG(9, 10))
		var players [4]Player
		for s := range players {
			players[s] = newPlayer(roster[s], Sterk, uint64(s+1), cfg)
		}
		var out []game.Card
		for i := range 6 {
			d := game.NewDeal(game.Seat(i%4), game.Shuffle(rng), game.TrumpMode(i%2), game.Amsterdams, game.Suit(i%4))
			checkedDeal(t, d, players)
			for _, tr := range d.Tricks() {
				for _, p := range tr.Cards {
					out = append(out, p.Card)
				}
			}
		}
		return out
	}
	a, b := run(1), run(8)
	if !slices.Equal(a, b) {
		t.Error("sterk bots played differently with 1 and 8 workers")
	}
	if c := run(1); !slices.Equal(a, c) {
		t.Error("sterk bots are not deterministic")
	}
}

func TestExplainTrick(t *testing.T) {
	names := [4]string{"Piet", "Fatima (AI)", "Klaas", "Bram (AI)"}
	trick := func(leader game.Seat, winner game.Seat, points int, codes string, roem ...game.RoemItem) game.Trick {
		cards := game.MustParseCards(codes)
		tr := game.Trick{Leader: leader, Winner: winner, Points: points, Roem: roem}
		for i, c := range cards {
			tr.Cards = append(tr.Cards, game.Played{Seat: (leader + game.Seat(i)) & 3, Card: c})
		}
		return tr
	}
	stuk := game.RoemItem{Kind: game.RoemStuk, Points: 20}
	drie := game.RoemItem{Kind: game.RoemDrie, Points: 20}
	cases := []struct {
		tr   game.Trick
		want string
	}{
		{trick(0, 1, 27, "QH JH KH 7H", stuk),
			"Fatima (AI) wint de slag met ♥B, de hoogste troef. 27 punten, roem: stuk (20)."},
		{trick(0, 1, 37, "QH JH KH 7H", stuk, drie),
			"Fatima (AI) wint de slag met ♥B, de hoogste troef. 37 punten (met 10 voor de laatste slag), roem: stuk (20) en driekaart (20)."},
		{trick(2, 3, 21, "AS 8H TS 7S"),
			"Bram (AI) troeft in met ♥8 (geen ♠) en wint de slag. 21 punten."},
		{trick(2, 0, 35, "AS 8H 9H TS"),
			"Piet wint de slag met ♥9: overgetroefd met de hoogste troef. 35 punten."},
		// Trumping in first is no overtrump, also when someone undertrumps after.
		{trick(0, 1, 35, "AS 9H 7H TS"),
			"Fatima (AI) troeft in met ♥9 (geen ♠) en wint de slag; Klaas moest ondertroeven. 35 punten."},
		{trick(0, 1, 31, "AS JH 7S 7H"),
			"Fatima (AI) troeft in met ♥B (geen ♠) en wint de slag; Bram (AI) moest ondertroeven. 31 punten."},
		{trick(1, 2, 15, "KD AD 7D 7C"),
			"Klaas wint de slag met ♦A, de hoogste kaart in de gevraagde kleur (♦). 15 punten."},
		{trick(3, 0, 2, "8C JC 7C 9S"),
			"Piet wint de slag met ♣B, de hoogste kaart in de gevraagde kleur (♣). 2 punten."},
	}
	for _, c := range cases {
		if got := ExplainTrick(c.tr, game.Hearts, names); got != c.want {
			t.Errorf("got  %q\nwant %q", got, c.want)
		}
	}
	// Clubs, the suit of the zero Card, as trump.
	if got, want := ExplainTrick(trick(0, 1, 35, "AS 9C 7C TS"), game.Clubs, names),
		"Fatima (AI) troeft in met ♣9 (geen ♠) en wint de slag; Klaas moest ondertroeven. 35 punten."; got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
	if got := ExplainTrick(game.Trick{Winner: game.NoSeat}, game.Hearts, names); got != "" {
		t.Errorf("incomplete trick explained as %q", got)
	}
}

func card(s string) game.Card {
	c, err := game.ParseCard(s)
	if err != nil {
		panic(err)
	}
	return c
}

// TestFallbackOnBadView: an inconsistent view makes the search fail (in a
// worker goroutine); the bot must still answer with a legal card.
func TestFallbackOnBadView(t *testing.T) {
	_, mid := benchViews()
	bad := mid
	bad.Hand = append([]game.Card(nil), mid.Hand...)
	for _, c := range mid.Hand {
		if !slices.Contains(mid.Legal, c) {
			bad.Hand = slices.DeleteFunc(bad.Hand, func(x game.Card) bool { return x == c })
			break
		}
	}
	if len(bad.Hand) == len(mid.Hand) {
		bad.Hand = append(bad.Hand, game.Card{Rank: game.Seven, Suit: game.Clubs})
	}
	before := fallbacks.Load()
	defer fallbacks.Store(before)
	for _, workers := range []int{1, 8} {
		cfg := quickSearch
		cfg.workers = workers
		c := newPlayer(roster[0], Sterk, 1, cfg).Play(bad)
		if !slices.Contains(mid.Legal, c) {
			t.Errorf("fallback played %v, not in %v", c, mid.Legal)
		}
	}
	if fallbacks.Load() != before+2 {
		t.Errorf("expected two fallbacks, got %d", fallbacks.Load()-before)
	}
	if a := Advise(bad); a.Card != nil || a.Text != "" {
		t.Errorf("advice from a broken view: %+v", a)
	}
}
