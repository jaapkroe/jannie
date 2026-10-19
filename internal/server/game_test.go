package server

import (
	"math/rand/v2"
	"slices"
	"testing"
	"time"

	"klaverjas/internal/game"
)

func (c *tclient) poll() *msg {
	select {
	case m, ok := <-c.in:
		if !ok {
			c.t.Fatalf("connection of seat %d closed: %v", c.seat, <-c.errc)
		}
		c.track(m)
		return m
	default:
		return nil
	}
}

// checkUpdate verifies the invariants every state must keep.
func checkUpdate(t *testing.T, c *tclient, m *msg) {
	t.Helper()
	if m.T != "update" {
		return
	}
	s := m.state
	if s == nil {
		t.Fatalf("update without state")
	}
	if s.You != c.seat {
		t.Errorf("you = %d, joined as %d", s.You, c.seat)
	}
	me := s.Players[s.You]
	if me == nil || me.Bot {
		t.Fatalf("own seat is not a human: %+v", me)
	}
	switch e := m.evType(); e {
	case "deal", "trump", "trick", "handEnd", "gameOver":
		// Pauses: nobody may act.
		if s.Turn != -1 {
			t.Errorf("turn %d after %s", s.Turn, e)
		}
	case "collect":
		last := s.TricksWon[0]+s.TricksWon[1] == 8 // the hand ends: nobody leads
		if s.Phase == phasePlay && !last && (s.Turn != int(s.Trick.Leader) || len(s.Trick.Cards) != 0) {
			t.Errorf("after collect: turn %d, trick %+v", s.Turn, s.Trick)
		}
	}
	inHand := s.Phase == phaseTrump || s.Phase == phaseBid || s.Phase == phasePlay
	if inHand {
		played := s.TricksWon[0] + s.TricksWon[1]
		if s.Trick != nil && len(s.Trick.Cards) < 4 {
			for _, p := range s.Trick.Cards {
				if int(p.Seat) == s.You {
					played++
				}
			}
		}
		if len(s.Hand) != 8-played {
			t.Errorf("hand %d cards after %d played (phase %s)", len(s.Hand), played, s.Phase)
		}
		if me.Cards != len(s.Hand) {
			t.Errorf("players[you].cards = %d, hand has %d", me.Cards, len(s.Hand))
		}
	} else if len(s.Hand) != 0 {
		t.Errorf("hand outside a hand: %v", s.Hand)
	}
	if s.Turn == s.You && s.Phase == phasePlay {
		if len(s.Legal) == 0 {
			t.Errorf("my turn without legal cards")
		}
		for _, l := range s.Legal {
			if !slices.Contains(s.Hand, l) {
				t.Errorf("legal card %v not in hand %v", l, s.Hand)
			}
		}
		if s.Rule == "" {
			t.Errorf("my turn without rule")
		}
	} else if s.Legal != nil || s.Rule != "" {
		t.Errorf("legal/rule while not my turn: %v %q", s.Legal, s.Rule)
	}
	sum := [2]int{}
	for k, row := range s.Scores {
		if row.Hand != k+1 {
			t.Errorf("score row %d has hand %d", k, row.Hand)
		}
		sum[0] += row.Score[0]
		sum[1] += row.Score[1]
	}
	if sum != s.Total {
		t.Errorf("total %v, scores add up to %v", s.Total, sum)
	}
	if m.evType() == "handEnd" {
		r := s.PrevHand.Result
		if r.Points[0]+r.Points[1] != 162 {
			t.Errorf("hand points %v do not add up to 162", r.Points)
		}
		roem := r.Roem[0] + r.Roem[1]
		if r.Nat {
			p := r.PlayingTeam
			if r.Score[p] != 0 || r.Score[1-p] != 162+roem {
				t.Errorf("nat scored %v (roem %v)", r.Score, r.Roem)
			}
		} else if r.Score[0] != r.Points[0]+r.Roem[0] || r.Score[1] != r.Points[1]+r.Roem[1] {
			t.Errorf("score %v from points %v roem %v", r.Score, r.Points, r.Roem)
		}
		if len(s.PrevHand.Tricks) != 8 {
			t.Errorf("prevHand has %d tricks", len(s.PrevHand.Tricks))
		}
		if len(s.Scores) != s.HandNo {
			t.Errorf("%d score rows after hand %d", len(s.Scores), s.HandNo)
		}
	}
}

// playGame drives the clients with random legal decisions until every one
// saw game over, checking all updates. It returns the final states.
func playGame(t *testing.T, rng *rand.Rand, hands int, clients ...*tclient) {
	t.Helper()
	acted := make([]int, len(clients))
	readied := make([]int, len(clients))
	over := make([]bool, len(clients))
	deadline := time.Now().Add(90 * time.Second)
	for slices.Contains(over, false) {
		if time.Now().After(deadline) {
			t.Fatalf("game did not finish; phases %v", phases(clients))
		}
		busy := false
		for k, c := range clients {
			for m := c.poll(); m != nil; m = c.poll() {
				busy = true
				checkUpdate(t, c, m)
				if m.T == "error" {
					t.Fatalf("seat %d got error %s: %s", c.seat, m.Code, m.errMsg())
				}
			}
			s := c.s
			if s == nil {
				continue
			}
			switch {
			case s.Phase == phaseGameOver:
				over[k] = true
			case c.myTurn() && acted[k] < c.seq:
				acted[k] = c.seq
				c.actRandom(rng)
			case s.Phase == phaseHandEnd && readied[k] < s.HandNo:
				readied[k] = s.HandNo
				c.send(map[string]any{"t": "ready"})
			}
		}
		if !busy {
			time.Sleep(time.Millisecond)
		}
	}
	for _, c := range clients {
		s := c.s
		if s.HandNo != hands || len(s.Scores) != hands {
			t.Errorf("game over after hand %d with %d rows, want %d", s.HandNo, len(s.Scores), hands)
		}
		want := -1
		if s.Total[0] > s.Total[1] {
			want = 0
		} else if s.Total[1] > s.Total[0] {
			want = 1
		}
		if s.Winner != want {
			t.Errorf("winner %d for total %v", s.Winner, s.Total)
		}
	}
}

// drive lets the clients make random decisions until done holds.
func drive(t *testing.T, done func() bool, clients ...*tclient) {
	t.Helper()
	rng := rand.New(rand.NewPCG(5, 5))
	acted := make([]int, len(clients))
	deadline := time.Now().Add(20 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("drive: condition not reached; phases %v", phases(clients))
		}
		busy := false
		for k, c := range clients {
			for m := c.poll(); m != nil; m = c.poll() {
				busy = true
				checkUpdate(t, c, m)
				if done() {
					return
				}
			}
			if c.myTurn() && acted[k] < c.seq && !done() {
				acted[k] = c.seq
				c.actRandom(rng)
			}
		}
		if !busy {
			time.Sleep(time.Millisecond)
		}
	}
}

func phases(cs []*tclient) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.phase()
	}
	return out
}

func TestQuickPlayToGameOver(t *testing.T) {
	_, ts, _ := newTestServer(t)
	rng := rand.New(rand.NewPCG(1, 2))
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1, "hands": 4}, false, true)
	if c.s.Phase != phaseLobby {
		t.Fatalf("first state is %q, want lobby", c.s.Phase)
	}
	c.waitEvent("deal")
	for i, p := range c.s.Players {
		if i == 0 {
			if p.Bot || p.Name != "Piet" {
				t.Errorf("seat 0: %+v", p)
			}
			continue
		}
		if p == nil || !p.Bot || p.Name != fakeName(p.BotID)+" (AI)" {
			t.Errorf("seat %d: %+v", i, p)
		}
	}
	playGame(t, rng, 4, c)
	want := []string{"deal", "play", "trick", "collect", "handEnd", "gameOver"}
	for _, ev := range want {
		if !slices.Contains(c.events, ev) {
			t.Errorf("never saw event %q", ev)
		}
	}
}

// call runs f on the room goroutine and waits for it.
func call(r *room, f func()) {
	done := make(chan struct{})
	if r.post(func() { defer close(done); f() }) {
		<-done
	}
}

func fakeName(id string) string {
	for _, p := range fakePersonas {
		if p.ID == id {
			return p.Name
		}
	}
	return "?"
}

func TestFourBotsToGameOver(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, mode := range []game.TrumpMode{game.Utrechts, game.Gedraaid} {
		r := newRoom(s, "TEST")
		r.alwaysOn = true
		r.opts.Hands = 8
		r.opts.TrumpMode = mode
		r.opts.Rules = game.Rotterdams
		s.mu.Lock()
		s.rooms[r.code] = r
		s.mu.Unlock()
		go r.loop()
		done := make(chan [2]int, 1)
		r.post(func() {
			r.fillSeats()
			r.startMatch()
		})
		go func() {
			for {
				time.Sleep(5 * time.Millisecond)
				ok := r.post(func() {
					if r.phase == phaseGameOver {
						select {
						case done <- r.total:
						default:
						}
					}
				})
				if !ok {
					return
				}
			}
		}()
		select {
		case total := <-done:
			var sum [2]int
			var rows int
			call(r, func() {
				rows = len(r.scores)
				for _, row := range r.scores {
					sum[0] += row.Score[0]
					sum[1] += row.Score[1]
				}
			})
			if rows != 8 {
				t.Errorf("%s: %d hands scored, want 8", mode, rows)
			}
			if sum != total {
				t.Errorf("%s: total %v, rows add up to %v", mode, total, sum)
			}
		case <-time.After(60 * time.Second):
			t.Fatalf("%s: four bots did not finish", mode)
		}
		call(r, func() { r.close("test") })
	}
}

func TestHumansOverWebsocket(t *testing.T) {
	for _, tc := range []struct {
		name   string
		humans int
		opts   map[string]any
	}{
		{"two-utrechts-amsterdams", 2, map[string]any{"humans": 2, "hands": 4}},
		{"four-gedraaid-rotterdams", 4, map[string]any{"humans": 4, "hands": 4, "trumpMode": "gedraaid", "rules": "rotterdams"}},
		{"three-gedraaid", 3, map[string]any{"humans": 3, "hands": 4, "trumpMode": "gedraaid", "tempo": "snel"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, ts, _ := newTestServer(t)
			rng := rand.New(rand.NewPCG(3, uint64(tc.humans)))
			host := dial(t, ts)
			host.create("Host", tc.opts, false, false)
			clients := []*tclient{host}
			for k := 1; k < tc.humans; k++ {
				c := dial(t, ts)
				c.join(host.code, "Speler", "")
				clients = append(clients, c)
			}
			host.waitState("everyone seated", func(s *state) bool {
				n := 0
				for _, p := range s.Players {
					if p != nil && !p.Bot {
						n++
					}
				}
				return n == tc.humans
			})
			host.send(map[string]any{"t": "start"})
			playGame(t, rng, 4, clients...)
			// Rematch: same seats, a fresh match.
			host.send(map[string]any{"t": "rematch"})
			for _, c := range clients {
				c.waitState("rematch deal", func(s *state) bool { return s.Phase != phaseGameOver && s.HandNo == 1 })
				if len(c.s.Scores) != 0 || c.s.Total != [2]int{} {
					t.Errorf("rematch kept scores %v %v", c.s.Scores, c.s.Total)
				}
			}
		})
	}
}

func TestPauseWithoutHumans(t *testing.T) {
	s, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1, "hands": 4}, false, true)
	drive(t, func() bool { return c.s.Phase == phasePlay && c.s.Turn > 0 }, c)
	c.conn.CloseNow()
	s.mu.Lock()
	r := s.rooms[c.code]
	s.mu.Unlock()
	played := func() (n int) {
		call(r, func() { n = 32 - r.deal.HandLen(0) - r.deal.HandLen(1) - r.deal.HandLen(2) - r.deal.HandLen(3) })
		return
	}
	waitFor(t, "disconnect seen", func() bool {
		var n int
		call(r, func() { n = r.connectedHumans() })
		return n == 0
	})
	before := played()
	time.Sleep(300 * time.Millisecond) // dozens of bot moves at this pace
	paused := played()
	if paused > before+1 { // one move may have been on its way
		t.Fatalf("bots played on without a human: %d cards, then %d", before, paused)
	}
	c2 := dial(t, ts)
	c2.join(c.code, "Piet", c.token)
	waitFor(t, "play resumes", func() bool {
		for c2.poll() != nil {
		}
		return played() > paused || c2.myTurn()
	})
}

func TestReconnectMidGame(t *testing.T) {
	_, ts, _ := newTestServer(t)
	a := dial(t, ts)
	a.create("Anna", map[string]any{"humans": 2, "hands": 4}, false, false)
	b := dial(t, ts)
	b.join(a.code, "Bert", "")
	a.send(map[string]any{"t": "start"})
	drive(t, func() bool { return a.s != nil && a.s.Phase == phasePlay && a.s.Turn >= 0 }, a, b)
	hand := slices.Clone(a.s.Hand)
	seat, token := a.seat, a.token
	a.conn.CloseNow()

	b.until(5*time.Second, "away event", func(m *msg) bool {
		return m.T == "update" && m.evType() == "away" && int(m.ev["seat"].(float64)) == seat
	})
	if b.s.Players[seat].Connected {
		t.Errorf("seat %d still connected after close", seat)
	}

	a2 := dial(t, ts)
	a2.send(map[string]any{"t": "join", "code": a.code, "name": "Anna", "token": token})
	j := a2.waitType("joined")
	if j.Seat != seat || j.Token != token {
		t.Fatalf("rejoined at seat %d token %q, want %d", j.Seat, j.Token, seat)
	}
	a2.waitType("chatlog")
	u := a2.waitType("update")
	if u.ev != nil {
		t.Errorf("resync has event %v", u.ev)
	}
	if !u.state.Players[seat].Connected || u.state.Players[seat].Name != "Anna" {
		t.Errorf("after reconnect: %+v", u.state.Players[seat])
	}
	// The hand may have moved on if a substitute played; it never grows.
	for _, c := range u.state.Hand {
		if !slices.Contains(hand, c) {
			t.Errorf("card %v appeared in the hand after reconnect", c)
		}
	}
	b.waitEvent("back")
}

func TestAwaySubstitute(t *testing.T) {
	_, ts, _ := newTestServer(t, func(s *Server) { s.scale = 0.01 })
	a := dial(t, ts)
	a.create("Anna", map[string]any{"humans": 2, "hands": 4}, false, false)
	b := dial(t, ts)
	b.join(a.code, "Bert", "")
	a.send(map[string]any{"t": "start"})
	// Wait until it is Anna's turn, then drop her connection.
	drive(t, func() bool { return a.myTurn() }, a, b)
	seat := a.seat
	a.conn.CloseNow()
	start := time.Now()
	var awayAt time.Duration
	substituted := false
	drive(t, func() bool {
		s := b.s
		if awayAt == 0 && s.Players[seat].Away {
			awayAt = time.Since(start)
			if s.Players[seat].Connected {
				t.Errorf("away player shows as connected")
			}
		}
		// The substitute moves: it is no longer Anna's turn, or her hand shrank.
		if awayAt > 0 && (s.Turn != seat || s.Phase == phaseHandEnd) {
			substituted = true
		}
		return substituted
	}, b)
	if awayAt < 150*time.Millisecond {
		t.Errorf("substitute after %v, want about 20 s scaled (200 ms)", awayAt)
	}
	if !slices.Contains(b.events, "away") {
		t.Errorf("no away event: %v", b.events)
	}
	want := "Anna is even weg; een AI-speler speelt zolang voor Anna."
	if !slices.ContainsFunc(b.chats, func(m chatMsg) bool { return m.Sys && m.Seat == -1 && m.Text == want }) {
		t.Errorf("no system line about the substitute in %+v", b.chats)
	}
	// Back again: away clears.
	a2 := dial(t, ts)
	a2.join(a.code, "Anna", a.token)
	if a2.s.Players[seat].Away || !a2.s.Players[seat].Connected {
		t.Errorf("after return: %+v", a2.s.Players[seat])
	}
	b.waitEvent("back")
}

func TestIllegalPlayRejected(t *testing.T) {
	_, ts, _ := newTestServer(t)
	rng := rand.New(rand.NewPCG(7, 7))
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1, "hands": 4}, false, true)
	acted := 0
	for tries := 0; ; tries++ {
		if tries > 2000 {
			t.Fatal("never had a turn with an illegal card")
		}
		c.until(10*time.Second, "my turn", func(m *msg) bool { return c.myTurn() && c.seq > acted })
		acted = c.seq
		s := c.s
		if s.Phase == phasePlay && len(s.Legal) < len(s.Hand) {
			var bad game.Card
			for _, h := range s.Hand {
				if !slices.Contains(s.Legal, h) {
					bad = h
					break
				}
			}
			c.send(map[string]any{"t": "play", "card": bad.String()})
			e := c.waitError(errInvalid)
			want := game.ExplainIllegal(bad, s.Hand, *s.Trick, game.Seat(s.You), *s.Trump, game.Amsterdams)
			if e.errMsg() != want || want == "" {
				t.Fatalf("illegal %v: msg %q, want %q", bad, e.errMsg(), want)
			}
			// Not in hand, and not your turn.
			for _, card := range game.NewDeck() {
				if !slices.Contains(s.Hand, card) {
					c.send(map[string]any{"t": "play", "card": card.String()})
					if e := c.waitError(errInvalid); e.errMsg() != game.ErrNotInHand.Error() {
						t.Errorf("card not in hand: %q", e.errMsg())
					}
					break
				}
			}
			c.send(map[string]any{"t": "play", "card": s.Legal[0].String()})
			c.waitEvent("play")
			c.send(map[string]any{"t": "play", "card": s.Legal[0].String()})
			c.waitError(errNotTurn)
			return
		}
		c.actRandom(rng)
	}
}

func TestTrainingHintsAndTips(t *testing.T) {
	_, ts, ai := newTestServer(t)
	rng := rand.New(rand.NewPCG(9, 9))
	c := dial(t, ts)
	c.create("Leerling", map[string]any{"open": true, "hands": 4, "humans": 3}, true, true)
	s := c.s
	if !s.Training || s.Opts.Humans != 1 || s.Opts.Tempo != "rustig" || !s.Opts.Open {
		t.Fatalf("training opts: %+v training=%v", s.Opts, s.Training)
	}
	if p := s.Players[2]; p == nil || p.BotID != "ans" {
		t.Fatalf("partner is %+v, want Juf Ans", p)
	}
	ids := map[string]bool{}
	for _, p := range s.Players[1:] {
		ids[p.BotID] = true
	}
	if len(ids) != 3 {
		t.Errorf("bots not distinct: %v", ids)
	}
	hints := 0
	acted := 0
	for c.tips < 8 {
		c.until(10*time.Second, "my turn or a tip", func(m *msg) bool { return m.T == "tip" || (c.myTurn() && c.seq > acted) })
		if c.myTurn() && c.seq > acted {
			acted = c.seq
			s := c.s
			if s.Hint == nil || s.Hint.Text == "" {
				t.Fatalf("no hint on my turn in phase %s", s.Phase)
			}
			switch s.Phase {
			case phasePlay:
				if s.Hint.Card == nil || !slices.Contains(s.Legal, *s.Hint.Card) {
					t.Errorf("hint card %v not legal %v", s.Hint.Card, s.Legal)
				}
			case phaseTrump:
				if s.Hint.Suit == nil {
					t.Errorf("trump hint without suit")
				}
			}
			if s.Hands4 == nil {
				t.Fatal("open cards: no hands4")
			}
			n := 0
			for _, h := range s.Hands4 {
				n += len(h)
			}
			if len(s.Hands4[s.You]) != len(s.Hand) || n == 0 {
				t.Errorf("hands4 %v vs hand %v", s.Hands4, s.Hand)
			}
			hints++
			c.actRandom(rng)
		}
	}
	if hints == 0 || ai.advised.Load() == 0 || ai.explained.Load() < 8 {
		t.Errorf("hints %d, advised %d, explained %d", hints, ai.advised.Load(), ai.explained.Load())
	}
	// Nobody else can join a training game.
	d := dial(t, ts)
	d.send(map[string]any{"t": "join", "code": c.code, "name": "Indringer"})
	d.waitError(errFull)
}
