package server

import (
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"klaverjas/internal/game"
)

// seenStep is a lesson step as the learner saw it, with the state around
// it.
type seenStep struct {
	lessonStep
	hand, turn, cards int // hand number, whose turn, cards in the trick on the table
	trump, hint       bool
	ev                string // the update's event
}

// lessonRun is what the learner saw in a training match with lessons.
type lessonRun struct {
	seen  []seenStep
	said  []string    // the texts of the steps and tips, in the order they came
	roem  []int       // the hand of every trick with roem
	tips  map[int]int // tips per hand
	hints map[int]int // turns with a hint per hand
	left  map[int][]int
	// left: per hand the trump counter of every update during play, with
	// the trumps the learner held then (as trumpsLeft+held: the trumps not
	// yet played, which only goes down)
}

// readLessons plays c's training match: it reads every lesson step once
// (tipRead with its n, after hook), follows the hint on c's turn (without
// one a random legal choice) and goes on from every summary, until done.
func readLessons(t *testing.T, c *tclient, done func() bool, hook func(seenStep)) (run lessonRun) {
	t.Helper()
	run.tips, run.hints, run.left = map[int]int{}, map[int]int{}, map[int][]int{}
	rng := rand.New(rand.NewPCG(1, 2))
	read, acted, readied := 0, 0, 0
	deadline := time.Now().Add(60 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("readLessons: not done in phase %s, hand %d", c.phase(), c.s.HandNo)
		}
		m := c.next(5 * time.Second)
		if m.T == "tip" {
			run.said = append(run.said, m.Text)
			run.tips[c.s.HandNo]++
			if c.s.HandNo == 1 {
				t.Errorf("tip in the first hand: %q", m.Text)
			}
			continue
		}
		if m.T != "update" {
			continue
		}
		checkUpdate(t, c, m)
		s := c.s
		if r, _ := m.ev["roem"].([]any); m.evType() == "trick" && len(r) > 0 {
			run.roem = append(run.roem, s.HandNo)
		}
		if n := s.TrumpsLeft; n != nil {
			held := 0
			for _, k := range s.Hand {
				if s.Trump != nil && k.Suit == *s.Trump {
					held++
				}
			}
			run.left[s.HandNo] = append(run.left[s.HandNo], *n+held)
			if s.Phase != phasePlay || *n < 0 {
				t.Errorf("hand %d: trump counter %d in phase %s", s.HandNo, *n, s.Phase)
			}
		}
		if l := s.Lesson; l != nil && l.N > read {
			read = l.N
			st := seenStep{lessonStep: *l, hand: s.HandNo, turn: s.Turn, trump: s.Trump != nil, hint: s.Hint != nil, ev: m.evType()}
			if s.Trick != nil {
				st.cards = len(s.Trick.Cards)
			}
			run.seen = append(run.seen, st)
			run.said = append(run.said, l.Text)
			if hook != nil {
				hook(st)
			}
			c.send(map[string]any{"t": "tipRead", "n": l.N})
			continue
		}
		switch {
		case s.Lesson == nil && c.myTurn() && c.seq > acted:
			acted = c.seq
			if s.Hint == nil {
				c.actRandom(rng)
				break
			}
			run.hints[s.HandNo]++
			c.actHint()
		case s.Phase == phaseHandEnd && readied < s.HandNo:
			readied = s.HandNo
			c.send(map[string]any{"t": "ready"})
		}
	}
	return run
}

// TestLessons: training with lessons, a whole match of sixteen hands. The
// intro after the first deal and the trump lesson hold the game until
// read, step by step; every trick of the first hand waits for its
// explanation, the last one also for the score; the learner's first turns
// get a lesson with the hint. The card points are introduced at the deal
// of the third hand, with the last trick's 10 the first two times; in the
// fifth the learner counts the trumps, with a counter. Roem before it is
// introduced is pointed out once; it is introduced at the deal of the
// seventh hand and pointed out the first three times, the signals at the
// deal of the ninth (before it the table plays without them), with the
// first three chances for the learner and the first three signals of the
// bots. Along the way she praises the learner's first trick and a hand
// won, once per two hands. The last four hands have no hints and no tips.
// Every step and tip is a line of Juf Jannie in the chat as well.
func TestLessons(t *testing.T) {
	_, ts, ai := newTestServer(t)
	c := dial(t, ts)
	c.create("Leerling", map[string]any{"lessons": true, "hands": 16, "seed": 7}, true, true)
	if !c.s.Opts.Lessons {
		t.Fatal("training without lessons")
	}
	collects := 0
	run := readLessons(t, c, func() bool { return c.phase() == phaseGameOver }, func(st seenStep) {
		switch {
		case st.N == 1:
			// A double tap: the second tipRead for step 1 must not skip
			// step 2 (the numbers seen stay without gaps).
			c.send(map[string]any{"t": "tipRead", "n": 1})
		case st.spotIs("trick") && collects == 0:
			// The trick waits for its explanation, however long it takes.
			collects = -1
			time.Sleep(150 * time.Millisecond)
			for m := c.poll(); m != nil; m = c.poll() {
				if m.evType() == "collect" {
					t.Errorf("the trick was collected before its explanation was read")
				}
			}
		}
	})
	seen := run.seen
	for k, st := range seen {
		if st.N != k+1 {
			t.Fatalf("step %d has n %d: %+v", k, st.N, seen)
		}
	}
	// The intro: who sits where and what the screen shows, before the
	// first turn.
	spots := []string{}
	for _, st := range seen[:6] {
		spots = append(spots, st.Spot)
		if st.hand != 1 || st.turn != -1 || st.trump || st.cards != 0 {
			t.Errorf("intro step %+v", st)
		}
	}
	if want := []string{"partner", "hand", "trick", "trump", "score", "chat"}; !slices.Equal(spots, want) {
		t.Errorf("intro spots %v, want %v", spots, want)
	}
	if text := seen[0].Text; !strings.Contains(text, "Juf Jannie") || !strings.Contains(text, "Verder") {
		t.Errorf("first step %q", text)
	}
	if !strings.Contains(seen[5].Text, "Mijn tip hoef je niet te volgen") {
		t.Errorf("the intro does not say the hint is free to ignore: %q", seen[5].Text)
	}
	byHand := func(hand int, pred func(seenStep) bool) (out []seenStep) {
		for _, st := range seen {
			if st.hand == hand && pred(st) {
				out = append(out, st)
			}
		}
		return out
	}
	with := func(part string) func(seenStep) bool {
		return func(st seenStep) bool { return strings.Contains(st.Text, part) }
	}
	all := func(pred func(seenStep) bool) (out []seenStep) {
		for _, st := range seen {
			if pred(st) {
				out = append(out, st)
			}
		}
		return out
	}
	// The trump lesson: one step once trump is known, while play waits,
	// with the manual for the order.
	trumps := byHand(1, func(st seenStep) bool { return st.trump && st.Spot == "trump" })
	if len(trumps) != 1 || trumps[0].turn != -1 || trumps[0].Manual != "punten" || !strings.Contains(trumps[0].Text, "handleiding") {
		t.Errorf("trump steps %+v", trumps)
	}
	// Every trick of the first hand: its explanation on the full trick,
	// the last one followed by the score.
	explained := byHand(1, func(st seenStep) bool { return st.cards == 4 && strings.HasSuffix(st.Text, " wint de slag.") })
	if len(explained) != 8 {
		t.Errorf("%d explained tricks in the first hand, want 8", len(explained))
	}
	score := all(func(st seenStep) bool { return strings.HasPrefix(st.Text, "Het potje is uit: ") })
	if len(score) != 1 || score[0].hand != 1 || score[0].Spot != "score" || score[0].cards != 4 || !strings.HasPrefix(score[0].Text, "Het potje is uit: wij hebben ") ||
		score[0].N != explained[len(explained)-1].N+1 {
		t.Errorf("score steps %+v", score)
	}
	// The learner's turns: a lesson with the hint, each situation once.
	situations := map[string]int{}
	for _, st := range all(func(st seenStep) bool { return st.Spot == "rule" }) {
		if st.turn != c.seat || !st.hint || st.cards == 4 {
			t.Errorf("turn lesson %+v", st)
		}
		situations[situation(st.Text)]++
	}
	if len(situations) == 0 || situations[""] > 0 {
		t.Errorf("turn lessons %v", situations)
	}
	for k, n := range situations {
		if n > 1 {
			t.Errorf("turn lesson %s %d times", k, n)
		}
	}
	// The points: introduced at the deal of the third hand, with the
	// manual; then the last trick of the first two hands that follow
	// says what it brings, after its explanation.
	points := all(with("Vanaf dit potje let je ook op de punten"))
	if len(points) != 1 || points[0].hand != pointsHand || points[0].turn != -1 || points[0].cards != 0 || points[0].Manual != "punten" ||
		!strings.HasPrefix(seen[points[0].N].Text, "Alle kaarten samen zijn 152 punten") {
		t.Errorf("points introduced %+v", points)
	}
	last := all(with("Dit was de laatste slag: "))
	if len(last) != lastShows || last[0].hand != pointsHand || last[1].hand != pointsHand+1 {
		t.Errorf("last tricks pointed out %+v", last)
	}
	for _, st := range last {
		if prev := seen[st.N-2]; prev.cards != 4 || !strings.HasSuffix(prev.Text, "wint de slag.") {
			t.Errorf("last trick step %+v after %+v", st, prev)
		}
	}
	// Counting the trumps: in the fifth hand once trump is known, before
	// the first card; the counter only during play of that hand, and the
	// trumps not yet played (the counter and the learner's own) only go
	// down from 8.
	count := all(with("Tel in dit potje de troeven."))
	if len(count) != 1 || count[0].hand != countHand || count[0].turn != -1 || !count[0].trump || count[0].cards != 0 ||
		!strings.HasPrefix(seen[count[0].N].Text, "Het getal bij de troef") {
		t.Errorf("counting introduced %+v", count)
	}
	for h, out := range run.left {
		if h != countHand {
			t.Errorf("trump counter in hand %d", h)
		}
		if len(out) == 0 || out[0] != 8 || !slices.IsSortedFunc(out, func(a, b int) int { return b - a }) {
			t.Errorf("trumps not played, by the counter: %v", out)
		}
	}
	if len(run.left[countHand]) == 0 {
		t.Error("no trump counter in the counting hand")
	}
	for _, st := range all(with("De anderen hebben geen troef meer.")) {
		if st.hand != countHand || seen[st.N-2].cards != 4 {
			t.Errorf("no trump left %+v", st)
		}
	}
	// Roem: before it is introduced, the first trick with it says it can
	// wait. Introduced at the deal of the seventh hand, then pointed out
	// with the first three tricks that have it, after their explanation.
	early, later := 0, 0
	for _, h := range run.roem {
		if h < roemHand {
			early++
		} else {
			later++
		}
	}
	waits := all(with("In deze slag zit roem: "))
	if len(waits) != min(early, 1) || early == 0 || waits[0].hand >= roemHand || seen[waits[0].N-2].cards != 4 {
		t.Errorf("roem before its lesson pointed out %+v, with %d tricks with roem before hand %d", waits, early, roemHand)
	}
	intro := all(with("Vanaf dit potje let ik op roem"))
	if len(intro) != 1 || intro[0].hand != roemHand || intro[0].turn != -1 || intro[0].cards != 0 || !strings.Contains(seen[intro[0].N].Text, "Drie op een rij") {
		t.Errorf("roem introduced %+v", intro)
	}
	pointed := all(with("Roem in deze slag: "))
	if len(pointed) != min(later, lessonShows) || later == 0 {
		t.Errorf("roem pointed out %d times, with %d tricks with roem from hand %d (all: %v)", len(pointed), later, roemHand, run.roem)
	}
	for _, st := range pointed {
		if st.hand < roemHand || seen[st.N-2].cards != 4 || !strings.Contains(seen[st.N-2].Text, "wint de slag") {
			t.Errorf("roem step %+v after %+v", st, seen[st.N-2])
		}
	}
	// Signals: introduced at the deal of the ninth hand, each agreement of
	// the table (by default three) a step of its own, in the manual's order.
	intro = all(with("Vanaf dit potje let ik op seinen"))
	if len(intro) != 1 || intro[0].hand != signalHand || intro[0].turn != -1 ||
		!strings.Contains(intro[0].Text, "spreken we er drie af") || !strings.HasPrefix(seen[intro[0].N].Text, "Met de aas seinen: ") ||
		!strings.HasPrefix(seen[intro[0].N+1].Text, "Op- of afseinen: ") {
		t.Errorf("signals introduced %+v", intro)
	}
	// The fake reads every lead as kleintje boer: the first three tricks
	// a bot led explain it.
	bySignal := all(func(st seenStep) bool { return strings.HasPrefix(st.Text, "Dat was een sein. ") })
	if len(bySignal) != lessonShows || ai.signalled.Load() == 0 {
		t.Errorf("%d signals by bots pointed out (asked %d times)", len(bySignal), ai.signalled.Load())
	}
	for _, st := range bySignal {
		if st.hand < signalHand || strings.HasPrefix(st.Text, "Dat was een sein. Jij") || seen[st.N-2].cards != 4 {
			t.Errorf("signal step %+v", st)
		}
	}
	// The fake offers a chance on every turn that follows a lead: the first
	// three, with the card lit up, before the hint.
	chances := all(func(st seenStep) bool { return st.Spot == "card" })
	if len(chances) != lessonShows {
		t.Errorf("%d chances to signal pointed out", len(chances))
	}
	for _, st := range chances {
		if st.hand < signalHand || st.turn != c.seat || !st.hint || st.Card == nil || !strings.HasPrefix(st.Text, "Hier kun je seinen: gooi je "+game.CardShortNL(*st.Card)) {
			t.Errorf("chance step %+v", st)
		}
	}
	// Until the signals are introduced the table plays without them: the
	// hints see no agreements. The hands without hints ask for none.
	for h := 1; h <= lessonsEnd; h++ {
		if on, ok := ai.signalsIn.Load(h); !ok || on.(bool) != (h >= signalHand) {
			t.Errorf("hand %d: hints with signals %v (seen %v)", h, on, ok)
		}
	}
	// Praise: the learner's first trick, after its explanation, and the
	// last trick of a hand our side won, at most once per two hands of
	// the plan.
	won := all(with("Je eerste slag is binnen."))
	if len(won) != 1 || seen[won[0].N-2].cards != 4 || !strings.HasPrefix(seen[won[0].N-2].Text, "Jij wint de slag") {
		t.Errorf("first trick praised %+v", won)
	}
	praised := all(func(st seenStep) bool {
		return slices.Contains([]string{"Pit: alle acht slagen voor ons. Heel goed gespeeld.", "We hebben het gehaald. Goed gespeeld.",
			"Zij gaan nat. Goed verdedigd."}, st.Text)
	})
	blocks := map[int]bool{}
	for _, st := range praised {
		if st.hand > lessonsEnd || st.cards != 4 || blocks[(st.hand+1)/2] {
			t.Errorf("praise %+v (blocks so far %v)", st, blocks)
		}
		blocks[(st.hand+1)/2] = true
	}
	if len(praised) == 0 {
		t.Error("no hand praised")
	}
	// In the first hand the score already says what happened: the
	// compliment follows the result.
	s := score[0].Text
	good := strings.Contains(s, "wij moesten") && strings.Contains(s, "Dat is gelukt.") || strings.Contains(s, "zij gaan nat")
	if good != slices.ContainsFunc([]string{"gelukt. Goed gespeeld. Na ", "punten. Goed verdedigd. Na ", "gelukt. Heel goed gespeeld. Na "},
		func(p string) bool { return strings.Contains(s, p) }) {
		t.Errorf("the score of the first hand %q", s)
	}
	// After the first hand a trick waits only for one of its lessons.
	for _, st := range all(func(st seenStep) bool {
		return st.hand > 1 && st.cards == 4 && strings.HasSuffix(st.Text, "wint de slag.")
	}) {
		next := seen[st.N].Text
		if !slices.ContainsFunc([]string{"Roem in deze slag: ", "In deze slag zit roem: ", "Dat was een sein. ", "Dit was de laatste slag: ",
			"De anderen hebben geen troef meer.", "Je eerste slag is binnen.", "Pit: ", "We hebben het gehaald.", "Zij gaan nat."},
			func(p string) bool { return strings.HasPrefix(next, p) }) {
			t.Errorf("hand %d: a trick waits for %q", st.hand, next)
		}
	}
	// The last four hands: announced at the deal of the first, then no
	// hint, no tip and no other step.
	solo := all(with("De laatste vier potjes speel je zonder"))
	if len(solo) != 1 || solo[0].hand != 16-soloHands+1 || solo[0].turn != -1 || solo[0].N != len(seen) {
		t.Errorf("hands without tips announced %+v (of %d steps)", solo, len(seen))
	}
	for h := 2; h <= 16; h++ {
		if on := h <= 16-soloHands; on != (run.hints[h] > 0) || on != (run.tips[h] > 0) {
			t.Errorf("hand %d: %d hints, %d tips", h, run.hints[h], run.tips[h])
		}
	}
	// The chat: every step and tip once, in order, as Juf Jannie.
	var coach []string
	for _, m := range c.chats {
		if m.Coach {
			coach = append(coach, m.Text)
			if m.Seat != 2 || m.Name != "Juf Jannie (AI)" || !m.Bot {
				t.Errorf("coach line %+v", m)
			}
		}
	}
	if !slices.Equal(coach, run.said) {
		t.Errorf("coach lines in the chat:\n%q\nsaid:\n%q", coach, run.said)
	}
}

func (st seenStep) spotIs(spot string) bool { return st.Spot == spot }

// situation tells the lessons of playLesson apart by their text.
func situation(text string) string {
	for _, k := range []struct{ key, has string }{
		{"lead", "Jij komt uit"}, {"follow", "dat heet bekennen"}, {"trumpLed", "Troef is gevraagd: speel"},
		{"trump", "dus je moet troeven"}, {"partner", "ik heb de slag"}, {"free", "dan mag je elke kaart spelen"},
	} {
		if strings.Contains(text, k.has) {
			return k.key
		}
	}
	return ""
}

// TestLessonResync: a rejoin in the middle of a lesson shows the same step.
func TestLessonResync(t *testing.T) {
	_, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.create("Leerling", map[string]any{"lessons": true}, true, true)
	s := c.waitState("the intro", func(s *state) bool { return s.Lesson != nil })
	c.send(map[string]any{"t": "tipRead", "n": s.Lesson.N})
	s = c.waitState("step 2", func(s *state) bool { return s.Lesson != nil && s.Lesson.N == 2 })
	d := dial(t, ts)
	d.send(map[string]any{"t": "join", "code": c.code, "name": "Leerling", "token": c.token})
	d.waitType("joined")
	log := d.waitType("chatlog")
	d.waitType("update")
	if l := d.s.Lesson; l == nil || *l != *s.Lesson {
		t.Errorf("rejoined with lesson %+v, want %+v", l, s.Lesson)
	}
	// Both steps so far are in the chat log, step 2 once.
	var coach []string
	for _, m := range log.Msgs {
		if m.Coach {
			coach = append(coach, m.Text)
		}
	}
	if len(coach) != 2 || coach[1] != s.Lesson.Text {
		t.Errorf("coach lines in the chat log %q", coach)
	}
}

// TestLateLessonTap: a tap for a lesson step that came once the step was
// gone (the learner's card ended the turn's lesson) is no tip read: the
// last trick of the hand still waits for its tip.
func TestLateLessonTap(t *testing.T) {
	r := lessonRoom(t)
	r.phase = phasePlay
	r.lessonN = 7 // steps 1 to 7 were shown; none is on screen now
	r.pause(stepCollect, time.Hour)
	r.nextAt = r.pendingAt // the last trick waits for its tip
	n := 7
	r.cmdTipRead(&n)
	if r.pending != stepCollect {
		t.Errorf("the late tap for step %d ended the wait for the tip: pending %d", n, r.pending)
	}
}

// TestLessonsOnlyInTraining: the option means nothing outside training,
// and training without it has no lessons.
func TestLessonsOnlyInTraining(t *testing.T) {
	_, ts, _ := newTestServer(t)
	c := dial(t, ts)
	c.create("Speler", map[string]any{"lessons": true}, false, true)
	if c.s.Opts.Lessons {
		t.Error("lessons outside training")
	}
	d := dial(t, ts)
	d.create("Leerling", map[string]any{"hands": 4}, true, true)
	drive(t, func() bool {
		if d.s.Lesson != nil {
			t.Fatalf("a lesson without the option: %+v", d.s.Lesson)
		}
		return d.phase() == phaseHandEnd // the training summary waits for ready
	}, d)
}

// TestPlayLesson: which cards may be played, for the situations a
// beginner meets first; the others are left to the rule above the hand.
func TestPlayLesson(t *testing.T) {
	// Hearts are trump; the learner is seat 0, Juf Jannie seat 2.
	view := func(hand, legal, trick string, leader game.Seat) game.View {
		v := game.View{Players: 4, Seat: 0, Trump: game.Hearts, TrumpKnown: true, Hand: game.MustParseCards(hand), Legal: game.MustParseCards(legal)}
		v.Current.Leader = leader
		for k, c := range game.MustParseCards(trick) {
			v.Current.Cards = append(v.Current.Cards, game.Played{Seat: (leader + game.Seat(k)) & 3, Card: c})
		}
		return v
	}
	for _, c := range []struct {
		name string
		v    game.View
		key  string
		has  string
	}{
		{"lead", view("7S 8D", "7S 8D", "", 0), "lead", "je mag elke kaart spelen"},
		{"follow", view("7S 8S 8D", "7S 8S", "AS", 1), "follow", "♠ is gevraagd en je hebt ♠"},
		{"trump led", view("7H 8D", "7H", "AH", 1), "trumpLed", "overtroeven"},
		{"trump led, none held", view("7S 8D", "7S 8D", "AH", 1), "free", "geen troef"},
		{"void, no trump", view("7C 8D", "7C 8D", "AS", 1), "free", "Je hebt geen ♠ en ook geen troef"},
		{"must trump", view("7H 8D", "7H", "AS", 3), "trump", "speel een ♥"},
		{"must overtrump", view("JH 8D", "JH", "AS 9H", 2), "trump", "Er ligt al troef"},
		{"partner's trick", view("7H 8D", "7H 8D", "AS 7S", 2), "partner", "ik heb de slag"},
		{"cannot overtrump", view("7H 8D", "8D", "AS JH", 2), "", ""},
	} {
		key, text := playLesson(c.v)
		if key != c.key || !strings.Contains(text, c.has) {
			t.Errorf("%s: %s %q, want %s with %q", c.name, key, text, c.key, c.has)
		}
	}
}

// lessonRoom is a training room with lessons and a deal, outside the
// room's goroutine.
func lessonRoom(t *testing.T) *room {
	s, _, _ := newTestServer(t)
	r := newRoom(s, "LESS")
	r.training, r.opts.Lessons = true, true
	r.seats[0] = newHuman("Leerling")
	r.seatTraining()
	hands, talon := game.ShuffleFor(4, rand.New(rand.NewPCG(4, 1)))
	r.deal = game.NewDealFor(4, 3, hands, talon, game.Utrechts, game.Amsterdams, 0)
	return r
}

// TestSignalStep: Juf Jannie explains a signal by a bot: her own with
// what follows for the learner, an opponent's as it is.
func TestSignalStep(t *testing.T) {
	r := lessonRoom(t)
	opp := r.displayName(1)
	for _, c := range []struct {
		sig  Signal
		want string
	}{
		{Signal{Seat: 2, Card: game.Card{Rank: game.Ace, Suit: game.Spades}, Kind: "aas", Means: game.Card{Rank: game.Ten, Suit: game.Spades}},
			"Dat was een sein. Ik gooide ♠A bij op jouw slag, en aan deze tafel betekent dat: “ik heb ♠10 ook” (met de aas seinen). " +
				"Speel later schoppen, dan kan mijn ♠10 de slag halen."},
		{Signal{Seat: 2, Card: game.Card{Rank: game.Seven, Suit: game.Clubs}, Kind: "hoogLaag", Means: game.Card{Rank: game.Ace, Suit: game.Clubs}},
			"Dat was een sein. Ik gooide ♣7 bij op jouw slag, een laag kaartje, en aan deze tafel betekent dat: “speel klaveren, daar heb ik de hoogste van” (opseinen). " +
				"Speel later klaveren, dan haal ik die slag."},
		{Signal{Seat: 3, Card: game.Card{Rank: game.Seven, Suit: game.Clubs}, Kind: "kleintjeBoer", Means: game.Card{Rank: game.Jack, Suit: game.Hearts}},
			"Dat was een sein. " + r.displayName(3) + " kwam voor het eerst uit, met ♣7: een kleintje van een bijkleur. Van het koppel dat troef koos, betekent dat aan deze tafel: “ik heb de troefboer” (kleintje boer)."},
		{Signal{Seat: 1, Card: game.Card{Rank: game.Jack, Suit: game.Spades}, Kind: "boerOverBoer", Means: game.Card{Rank: game.Jack, Suit: game.Hearts}},
			"Dat was een sein. " + opp + " kwam voor het eerst uit, met ♠B: de boer van een bijkleur. Van het koppel dat troef koos, betekent dat aan deze tafel: “ik heb de troefboer” (boer over boer)."},
	} {
		if got := r.signalStep(c.sig).Text; got != c.want {
			t.Errorf("got  %q\nwant %q", got, c.want)
		}
	}
}

// TestChanceStep: a chance for the learner to signal names the card, what
// it would say and what Juf Jannie does with it, and whether the tip is
// another card.
func TestChanceStep(t *testing.T) {
	as, tc := game.Card{Rank: game.Ace, Suit: game.Spades}, game.Card{Rank: game.Ten, Suit: game.Clubs}
	for _, c := range []struct {
		sig    Signal
		hinted *game.Card
		want   string
	}{
		{Signal{Seat: 0, Card: as, Kind: "aas", Means: game.Card{Rank: game.Ten, Suit: game.Spades}}, &as,
			"Hier kun je seinen: gooi je ♠A bij op mijn slag, dan weet ik dat je ♠10 ook hebt (met de aas seinen). Dan speel ik later schoppen naar je toe."},
		{Signal{Seat: 0, Card: game.Card{Rank: game.Eight, Suit: game.Spades}, Kind: "hoogLaag", Means: as}, &tc,
			"Hier kun je seinen: gooi je ♠8 bij op mijn slag, een laag kaartje, dan weet ik dat je de hoogste schoppen hebt (opseinen). " +
				"Dan speel ik later schoppen naar je toe. Mijn tip is een andere kaart."},
		{Signal{Seat: 0, Card: game.Card{Rank: game.Seven, Suit: game.Diamonds}, Kind: "kleintjeBoer", Means: game.Card{Rank: game.Jack, Suit: game.Hearts}}, nil,
			"Hier kun je seinen: kom je uit met ♦7, een kleintje van een bijkleur, dan weet ik dat je de troefboer hebt (kleintje boer). Dan speel ik troef terug als ik aan slag kom."},
	} {
		st := chanceStep(c.sig, c.hinted)
		if st.Text != c.want || st.Spot != "card" || st.Card == nil || *st.Card != c.sig.Card {
			t.Errorf("got  %+v\nwant %q", st, c.want)
		}
	}
}

// TestSignalSteps: the introduction names each agreement of the table.
func TestSignalSteps(t *testing.T) {
	r := lessonRoom(t)
	steps := r.signalSteps()
	if len(steps) != 4 || !strings.Contains(steps[0].Text, "spreken we er drie af") || !strings.HasPrefix(steps[1].Text, "Met de aas seinen: ") ||
		!strings.HasPrefix(steps[2].Text, "Op- of afseinen: ") || !strings.HasPrefix(steps[3].Text, "Kleintje boer: ") {
		t.Errorf("default signals: %+v", steps)
	}
	r.opts.Signals = game.Signals{BoerOverBoer: true}
	if steps := r.signalSteps(); len(steps) != 2 || !strings.Contains(steps[0].Text, "spreken we er één af") || !strings.HasPrefix(steps[1].Text, "Boer over boer: ") {
		t.Errorf("boer over boer alone: %+v", steps)
	}
}

// TestSignalChat: a match of four starts with the table's agreements on
// signals in the chat, each with what it says, or a line that there are
// none; with lessons they wait for Juf Jannie's lesson, and with two or
// three players signals play no part.
func TestSignalChat(t *testing.T) {
	s, _, _ := newTestServer(t)
	lines := func(set func(r *room)) []string {
		r := newRoom(s, "SEIN")
		defer r.stop()
		set(r)
		r.signalChat()
		var out []string
		for _, m := range r.chat {
			if !m.Sys || m.Seat != -1 {
				t.Errorf("not a system line: %+v", m)
			}
			out = append(out, m.Text)
		}
		return out
	}
	got := lines(func(*room) {})
	if len(got) != 4 || got[0] != "Seinen aan deze tafel:" || !strings.HasPrefix(got[1], "Met de aas seinen: ") ||
		got[2] != "Op- of afseinen: heeft je maat de slag en kun je niet bekennen, dan zeg je met een 7, 8 of 9: speel deze kleur, daar heb ik de hoogste van (opseinen). "+
			"Met een 10, boer, vrouw of heer zeg je: de hoogste van deze kleur heb ik niet (afseinen)." || !strings.HasPrefix(got[3], "Kleintje boer: ") {
		t.Errorf("default signals: %q", got)
	}
	if got := lines(func(r *room) { r.opts.Signals = game.Signals{} }); !slices.Equal(got, []string{"Aan deze tafel spreken we geen seinen af."}) {
		t.Errorf("no signals: %q", got)
	}
	if got := lines(func(r *room) { r.opts.Players = 3 }); got != nil {
		t.Errorf("three players: %q", got)
	}
	for _, sig := range []game.Signals{game.DefaultSignals, {}} {
		if got := lines(func(r *room) { r.training, r.opts.Lessons, r.opts.Signals = true, true, sig }); got != nil {
			t.Errorf("%+v before the lesson on signals: %q", sig, got)
		}
	}
	if got := lines(func(r *room) {
		r.training, r.opts.Lessons = true, true
		r.taught = map[string]int{lessonSignals: 1}
	}); len(got) != 4 {
		t.Errorf("after the lesson on signals: %q", got)
	}
	// A match, rematches too, puts them right after its start line.
	r := newRoom(s, "SEIN")
	defer r.stop()
	r.seats[0] = newHuman("A")
	r.opts.Seed = 55
	for range 2 {
		r.chat = nil
		r.startMatch()
		if len(r.chat) < 2 || r.chat[0].Text != "Spel (55) begint: 16 potjes, Utrechts/Amsterdams. Veel plezier!" || r.chat[1].Text != "Seinen aan deze tafel:" {
			t.Errorf("start of a match: %+v", r.chat)
		}
	}
}

// TestRoemParts: the roem of a trick by the cards it is made of, as
// game.TrickRoem finds it.
func TestRoemParts(t *testing.T) {
	for _, c := range []struct {
		cards string
		want  []string
	}{
		{"9S TS JS 7H", []string{"♠9, ♠10 en ♠B op een rij (driekaart, 20)"}},
		{"TC JC QC KC", []string{"♣10, ♣B, ♣V en ♣H op een rij (vierkaart, 50)"}},
		{"QH KH 7S AD", []string{"♥V en ♥H van troef (stuk, 20)"}},
		{"KH JH QH 9C", []string{"♥B, ♥V en ♥H op een rij (driekaart, 20)", "♥V en ♥H van troef (stuk, 20)"}},
		{"JS JH JD JC", []string{"vier boeren (200)"}},
		{"AS AH AD AC", []string{"vier azen (100)"}},
		{"9S 9H 9D 9C", nil},
		{"9S TS 8H AD", nil},
		{"QS KS 7S AD", nil}, // heer en vrouw, but not of trump
	} {
		cards := game.MustParseCards(c.cards)
		got := roemParts(cards, game.Hearts)
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: %q, want %q", c.cards, got, c.want)
		}
		points := 0
		for _, part := range got {
			n, _ := strconv.Atoi(part[strings.LastIndexAny(part, "( ")+1 : len(part)-1])
			points += n
		}
		if want := game.RoemPoints(cards, game.Hearts); points != want {
			t.Errorf("%s: parts add up to %d, roem is %d", c.cards, points, want)
		}
	}
}

// TestScoreStep: the score of the first hand, with roem, pit and nat.
func TestScoreStep(t *testing.T) {
	r := lessonRoom(t)
	d := r.deal
	if err := d.ChooseTrump(d.Turn(), game.Hearts); err != nil {
		t.Fatal(err)
	}
	for d.Phase() == game.PhasePlay {
		if err := d.Play(d.Turn(), d.Legal()[0]); err != nil {
			t.Fatal(err)
		}
	}
	res := d.Result()
	text := r.scoreStep("").Text
	who := capital(r.who(res.TrumpBy))
	for _, part := range []string{
		"Het potje is uit: wij hebben ",
		who + " koos troef, dus ",
		"Na 16 potjes wint het koppel met de meeste punten.",
	} {
		if !strings.Contains(text, part) {
			t.Errorf("%q lacks %q", text, part)
		}
	}
	if res.Nat != strings.Contains(text, "Dat is niet gelukt") || res.Pit != strings.Contains(text, "pit") {
		t.Errorf("%q for %+v", text, res)
	}
	// A compliment goes after the result, before the rule of the match.
	if text := r.scoreStep("Goed gespeeld.").Text; !strings.Contains(text, ". Goed gespeeld. Na 16 potjes") {
		t.Errorf("with a compliment: %q", text)
	}
}

// TestSharedSteps: the step lists every room shares stay unnumbered when a
// room starts them, so one room's numbers never show up in another's.
func TestSharedSteps(t *testing.T) {
	r := lessonRoom(t)
	r.lessonN = 40
	for _, steps := range [][]lessonStep{pointsSteps, roemSteps, soloSteps} {
		r.startLesson(steps)
		if steps[0].N != 0 || r.lesson == nil || r.lesson.N != r.lessonN-len(steps)+1 {
			t.Errorf("startLesson numbered the shared list: %+v, on screen %+v", steps[0], r.lesson)
		}
		r.clearLesson()
	}
}
