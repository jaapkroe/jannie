package server

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"klaverjas/internal/game"
)

// TestGameLog plays a match of two people with the game log on, then marks
// their own choices and gives feedback, and reads the log back: the match
// with its seed and who played, every hand with its cards and moves, the
// end, both reviews, the marks and the feedback (design §6 Game log).
func TestGameLog(t *testing.T) {
	dir := t.TempDir()
	srv, ts := newTestServerWith(t, newGradeAI(false), func(s *Server) {
		s.games = startGameLog(dir, s.log, func() time.Time { return time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC) })
	})
	host := dial(t, ts)
	host.create("Host", map[string]any{"hands": 4, "seed": 4242}, false, false)
	guest := dial(t, ts)
	guest.join(host.code, "Gast", "")
	host.waitState("both seated", func(s *state) bool { return s.Players[guest.seat] != nil && !s.Players[guest.seat].Bot })
	host.send(map[string]any{"t": "start"})
	playGame(t, rand.New(rand.NewPCG(21, 22)), 4, host, guest)
	s := host.waitState("the review", func(s *state) bool { return s.Review != nil && !s.Review.Pending })
	if s.Review.Seed != 4242 {
		t.Errorf("review seed %d, want 4242", s.Review.Seed)
	}

	// The host's own choice: another legal card, then an illegal one.
	rh := s.Review.Replay[0]
	var trick int
	var own, played game.Card
	for k, legal := range rh.Legal {
		at := slices.IndexFunc(rh.Tricks[k].Cards, func(p game.Played) bool { return p.Seat == game.Seat(host.seat) })
		if len(legal) > 1 && at >= 0 {
			trick, played = k+1, rh.Tricks[k].Cards[at].Card
			own = legal[0]
			if own == played {
				own = legal[1]
			}
			break
		}
	}
	if trick == 0 {
		t.Fatal("no trick in hand 1 with a choice for the host")
	}
	host.send(map[string]any{"t": "mark", "hand": 1, "trick": trick, "card": own.String()})
	s = host.waitState("the mark", func(s *state) bool { return s.Review != nil && len(s.Review.Marks) == 1 })
	if m := s.Review.Marks[0]; m.Hand != 1 || m.Trick != trick || m.Card == nil || *m.Card != own {
		t.Errorf("mark %+v, want %v in trick %d", m, own, trick)
	}
	var illegal game.Card
	for _, c := range rh.Cards[(host.seat+1)%4] {
		illegal = c // another seat's card: never in the host's hand
		break
	}
	host.send(map[string]any{"t": "mark", "hand": 1, "trick": trick, "card": illegal.String()})
	host.waitError(errInvalid)
	host.send(map[string]any{"t": "mark", "hand": 9, "trick": 1, "card": own.String()})
	host.waitError(errInvalid)
	// A trump choice the host made, if any: a suit of their own.
	suitMarked := false
	for h, row := range s.Scores {
		if row.TrumpBy == game.Seat(host.seat) {
			host.send(map[string]any{"t": "mark", "hand": h + 1, "trick": 0, "suit": "S"})
			host.waitState("the suit mark", func(s *state) bool { return len(s.Review.Marks) == 2 })
			suitMarked = true
			break
		}
	}
	// Clearing the card mark.
	host.send(map[string]any{"t": "mark", "hand": 1, "trick": trick})
	host.waitState("the mark cleared", func(s *state) bool {
		return !slices.ContainsFunc(s.Review.Marks, func(m markJSON) bool { return m.Hand == 1 && m.Trick == trick })
	})

	host.send(map[string]any{"t": "feedback", "text": "Mooi spel.\n\nMaar  ♠A\tdaar?", "hand": 1, "trick": trick})
	host.waitType("saved")
	guest.send(map[string]any{"t": "feedback", "text": "   "})
	guest.waitError(errInvalid)
	guest.send(map[string]any{"t": "feedback", "text": "Alles goed"})
	guest.waitType("saved")

	srv.games.close()
	recs := readGameLog(t, filepath.Join(dir, "games-2026-10.jsonl"))
	kinds := map[string]int{}
	for _, r := range recs {
		kinds[r["t"].(string)]++
	}
	wantMarks := 2 // the card mark and its clearing
	if suitMarked {
		wantMarks = 3
	}
	if kinds["match"] != 1 || kinds["hand"] != 4 || kinds["end"] != 1 || kinds["review"] != 2 || kinds["mark"] != wantMarks || kinds["feedback"] != 2 {
		t.Errorf("records %v", kinds)
	}
	for _, r := range recs {
		switch r["t"] {
		case "match":
			var m logMatch
			remarshal(t, r, &m)
			if m.Seed != 4242 || m.Room != host.code || m.Opts.Seed != 4242 || len(m.Players) != 4 {
				t.Errorf("match record %+v", m)
			}
			for _, p := range m.Players {
				human := p.Seat == host.seat || p.Seat == guest.seat
				if human != (p.IP != "" && p.Device == "klaverjas-test/1.0" && p.Bot == "") || !human && (p.Bot == "" || p.Level != "normaal") {
					t.Errorf("player %+v", p)
				}
			}
		case "hand":
			var h logHand
			remarshal(t, r, &h)
			plays := 0
			for _, a := range strings.Fields(h.Acts) {
				if len(a) == 3 && a[1] != 't' && a[1] != 'b' {
					plays++
				}
			}
			all := ""
			for _, c := range h.Cards {
				all += c
			}
			if len(h.Cards) != 4 || len(all) != 64 || plays != 32 || h.Result.Players != 4 {
				t.Errorf("hand record %d: cards %v, %d plays in %q", h.Hand, h.Cards, plays, h.Acts)
			}
		case "review":
			var rv logReview
			remarshal(t, r, &rv)
			if rv.Review == nil || rv.Review.Pending || rv.Review.Replay != nil || rv.Review.Seed != 4242 {
				t.Errorf("review record %+v", rv)
			}
		case "feedback":
			var f logFeedback
			remarshal(t, r, &f)
			if f.Name == "Host" && (f.Text != "Mooi spel.\nMaar ♠A daar?" || f.Hand != 1 || f.Trick != trick || f.Device != "klaverjas-test/1.0") {
				t.Errorf("feedback record %+v", f)
			}
		}
	}
}

func readGameLog(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var r map[string]any
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatalf("line %q: %v", sc.Text(), err)
		}
		out = append(out, r)
	}
	return out
}

func remarshal(t *testing.T, from map[string]any, to any) {
	t.Helper()
	b, _ := json.Marshal(from)
	if err := json.Unmarshal(b, to); err != nil {
		t.Fatal(err)
	}
}

// TestSeedDeals: the same seed deals the same cards, first dealer and
// turned suit included; without a fixed seed every match draws its own.
func TestSeedDeals(t *testing.T) {
	s, _, _ := newTestServer(t)
	deal := func(seed int) (uint64, dealtCards, game.Seat, game.Suit) {
		r := newRoom(s, "TEST")
		defer r.stop()
		r.seats[0] = newHuman("A")
		r.opts.Seed = seed
		r.startMatch()
		return r.seed, r.dealt, r.deal.Dealer(), r.deal.Turned()
	}
	s1, d1, dealer1, turned1 := deal(77)
	s2, d2, dealer2, turned2 := deal(77)
	if s1 != 77 || s2 != 77 || dealer1 != dealer2 || turned1 != turned2 {
		t.Errorf("seeds %d %d, dealers %v %v, turned %v %v", s1, s2, dealer1, dealer2, turned1, turned2)
	}
	for i := range d1.hands {
		if !slices.Equal(d1.hands[i], d2.hands[i]) {
			t.Errorf("seat %d: %v, then %v", i, d1.hands[i], d2.hands[i])
		}
	}
	_, d3, _, _ := deal(78)
	if slices.Equal(d1.hands[0], d3.hands[0]) {
		t.Error("another seed deals the same cards")
	}
	r1, _, _, _ := deal(0)
	r2, _, _, _ := deal(0)
	if r1 == r2 || r1 < 1 || r1 > maxSeed || r2 < 1 || r2 > maxSeed {
		t.Errorf("drawn seeds %d and %d", r1, r2)
	}
}

// TestSeedOption: a seed is a number from 1 to 999999999; null or 0 means a
// new seed per match.
func TestSeedOption(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
		ok   bool
	}{
		{`{"seed":4242}`, 4242, true},
		{`{"seed":null}`, 0, true},
		{`{"seed":0}`, 0, true},
		{`{"seed":999999999}`, 999999999, true},
		{`{"seed":1000000000}`, 0, false},
		{`{"seed":-1}`, 0, false},
		{`{"seed":"12"}`, 0, false},
		{`{"seed":1.5}`, 0, false},
	} {
		p, err := parseOpts(json.RawMessage(tc.raw), false)
		if (err == nil) != tc.ok || tc.ok && (p.Seed == nil || *p.Seed != tc.want) {
			t.Errorf("%s: patch %v, err %v", tc.raw, p.Seed, err)
		}
	}
}

// TestGameLogClosed: writes after close are dropped, and a nil log takes
// any write.
func TestGameLogClosed(t *testing.T) {
	g := newGameLog(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	g.write(logEnd{T: "end"})
	g.close()
	g.write(logEnd{T: "end"}) // must not panic
	g.close()
	var none *gameLog
	none.write(logEnd{T: "end"})
	none.close()
}

// TestMarkBid: a bid of the player's can get a mark of their own (here
// passen, where seat 3 played); someone who did not bid in that hand cannot
// mark one.
func TestMarkBid(t *testing.T) {
	dir := t.TempDir()
	s, _, _ := newTestServer(t, func(s *Server) { s.games = newGameLog(dir, s.log) })
	r := newRoom(s, "TEST")
	defer r.stop()
	for i := range 4 {
		r.seats[i] = newHuman(string(rune('A' + i)))
	}
	r.phase = phaseGameOver
	r.matchID = "m1"
	r.handTricks = [][]game.Trick{{}}
	r.handActs = []string{"1b0 2b0 3b1 3tH"}
	r.scores = []scoreRow{{Hand: 1, Trump: game.Hearts, TrumpBy: 3}}
	hand, trick, play := 1, 0, false
	for _, seat := range []game.Seat{3, 0} {
		c := newClient(s, nil, "1.2.3.4", "test")
		r.reviewOf(seat)
		r.cmdMark(c, seat, &inMsg{Hand: &hand, Trick: &trick, Play: &play})
		got := r.seats[seat].review.marks[[2]int{1, 0}]
		if seat == 3 && (got.Play == nil || *got.Play) {
			t.Errorf("seat 3 played and marks passen: %+v", got)
		}
		if seat == 0 && got != (choiceJSON{}) {
			t.Errorf("seat 0 did not bid, yet marks %+v", got)
		}
	}
	s.games.close()
	recs := readGameLog(t, filepath.Join(dir, "games-"+time.Now().UTC().Format("2006-01")+".jsonl"))
	if len(recs) != 1 || recs[0]["t"] != "mark" {
		t.Fatalf("log %v", recs)
	}
	var m logMark
	remarshal(t, recs[0], &m)
	if m.Seat != 3 || m.Played == nil || m.Played.Play == nil || !*m.Played.Play || m.Mark.Play == nil || *m.Mark.Play {
		t.Errorf("mark record %+v (played %+v)", m, m.Played)
	}
}

// TestGameLogRetention: the writer keeps the current month and the eleven
// before it, at its start and as time goes on; other files stay.
func TestGameLogRetention(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"games-2025-09.jsonl", "games-2025-10.jsonl", "games-2025-11.jsonl", "games-2026-10.jsonl", "games-x.jsonl", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files := func() []string {
		es, _ := os.ReadDir(dir)
		var out []string
		for _, e := range es {
			out = append(out, e.Name())
		}
		return out
	}
	var mu sync.Mutex
	at := time.Date(2026, 10, 31, 23, 0, 0, 0, time.UTC)
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return at }
	g := startGameLog(dir, slog.New(slog.NewTextHandler(io.Discard, nil)), clock)
	g.write(map[string]string{"t": "test"}) // after the prune at the start
	g.close()
	if got, want := files(), []string{"games-2025-11.jsonl", "games-2026-10.jsonl", "games-x.jsonl", "notes.txt"}; !slices.Equal(got, want) {
		t.Errorf("on 31 Oct 2026: %v, want %v", got, want)
	}
	// A month later the oldest month goes; the prune is the same one the
	// writer runs every pruneEvery.
	mu.Lock()
	at = time.Date(2026, 11, 1, 0, 30, 0, 0, time.UTC)
	mu.Unlock()
	g.prune()
	if got, want := files(), []string{"games-2026-10.jsonl", "games-x.jsonl", "notes.txt"}; !slices.Equal(got, want) {
		t.Errorf("on 1 Nov 2026: %v, want %v", got, want)
	}
}
