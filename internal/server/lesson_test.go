package server

import (
	"math/rand/v2"
	"slices"
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

// readLessons plays c's training match: it reads every lesson step once
// (tipRead with its n, after hook), follows the hint on c's turn and goes
// on from every summary, until done. It returns the steps seen, and the
// texts of the steps and tips in the order they came.
func readLessons(t *testing.T, c *tclient, done func() bool, hook func(seenStep)) (seen []seenStep, said []string) {
	t.Helper()
	read, acted, readied := 0, 0, 0
	deadline := time.Now().Add(30 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("readLessons: not done in phase %s, hand %d", c.phase(), c.s.HandNo)
		}
		m := c.next(5 * time.Second)
		if m.T == "tip" {
			said = append(said, m.Text)
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
		if l := s.Lesson; l != nil && l.N > read {
			read = l.N
			st := seenStep{lessonStep: *l, hand: s.HandNo, turn: s.Turn, trump: s.Trump != nil, hint: s.Hint != nil, ev: m.evType()}
			if s.Trick != nil {
				st.cards = len(s.Trick.Cards)
			}
			seen = append(seen, st)
			said = append(said, l.Text)
			if hook != nil {
				hook(st)
			}
			c.send(map[string]any{"t": "tipRead", "n": l.N})
			continue
		}
		switch {
		case s.Lesson == nil && c.myTurn() && c.seq > acted:
			acted = c.seq
			c.actHint()
		case s.Phase == phaseHandEnd && readied < s.HandNo:
			readied = s.HandNo
			c.send(map[string]any{"t": "ready"})
		}
	}
	return seen, said
}

// TestLessons: training with lessons, a whole match of four hands. The
// intro after the first deal and the trump lesson hold the game until
// read, step by step; every trick of the first hand waits for its
// explanation, the last one also for the score; the learner's first turns
// get a lesson with the hint; the first signal is explained in the second
// hand, and nothing twice. Every step and tip is a line of Juf Ans in the
// chat as well.
func TestLessons(t *testing.T) {
	_, ts, ai := newTestServer(t)
	c := dial(t, ts)
	c.create("Leerling", map[string]any{"lessons": true, "hands": 4, "seed": 7}, true, true)
	if !c.s.Opts.Lessons {
		t.Fatal("training without lessons")
	}
	collects := 0
	seen, said := readLessons(t, c, func() bool { return c.phase() == phaseGameOver }, func(st seenStep) {
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
	if text := seen[0].Text; !strings.Contains(text, "Juf Ans") || !strings.Contains(text, "Verder") {
		t.Errorf("first step %q", text)
	}
	byHand := func(hand int, pred func(seenStep) bool) (out []seenStep) {
		for _, st := range seen {
			if st.hand == hand && pred(st) {
				out = append(out, st)
			}
		}
		return out
	}
	// The trump lesson: two steps once trump is known, while play waits.
	trumps := byHand(1, func(st seenStep) bool { return st.trump && st.Spot == "trump" })
	if len(trumps) != 2 || trumps[0].turn != -1 || !strings.HasPrefix(trumps[1].Text, "De punten:") {
		t.Errorf("trump steps %+v", trumps)
	}
	// Every trick of the first hand: its explanation on the full trick,
	// the last one followed by the score.
	explained := byHand(1, func(st seenStep) bool { return st.cards == 4 && strings.HasSuffix(st.Text, " wint de slag.") })
	if len(explained) != 8 {
		t.Errorf("%d explained tricks in the first hand, want 8", len(explained))
	}
	score := byHand(1, func(st seenStep) bool { return st.Spot == "score" && st.cards == 4 })
	if len(score) != 1 || !strings.HasPrefix(score[0].Text, "Het potje is uit: wij hebben ") || score[0].N != explained[len(explained)-1].N+1 {
		t.Errorf("score steps %+v", score)
	}
	// The learner's turns: a lesson with the hint, each situation once.
	situations := map[string]int{}
	for _, st := range seen {
		if st.Spot != "rule" {
			continue
		}
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
	// The fake AI reads every lead as kleintje boer: the first trick of the
	// second hand explains it, after the trick's explanation, and no other
	// trick does.
	var signals []seenStep
	for _, st := range seen {
		if strings.HasPrefix(st.Text, "Dat was een sein. ") {
			signals = append(signals, st)
		}
	}
	if len(signals) != 1 || signals[0].hand != 2 || seen[signals[0].N-2].cards != 4 || ai.signalled.Load() == 0 {
		t.Errorf("signal steps %+v (asked %d times)", signals, ai.signalled.Load())
	}
	// Later tricks wait only for roem, the first time.
	trick := func(st seenStep) bool { return st.Spot != "rule" }
	if n := len(byHand(3, trick)) + len(byHand(4, trick)); n > 2 {
		t.Errorf("%d steps with tricks in hands 3 and 4: only roem may come there", n)
	}
	roem := 0
	for _, st := range seen {
		if strings.HasPrefix(st.Text, "Dat was roem: ") {
			roem++
		}
	}
	if roem > 1 {
		t.Errorf("roem explained %d times", roem)
	}
	// The chat: every step and tip once, in order, as Juf Ans.
	var coach []string
	for _, m := range c.chats {
		if m.Coach {
			coach = append(coach, m.Text)
			if m.Seat != 2 || m.Name != "Juf Ans (AI)" || !m.Bot {
				t.Errorf("coach line %+v", m)
			}
		}
	}
	if !slices.Equal(coach, said) {
		t.Errorf("coach lines in the chat:\n%q\nsaid:\n%q", coach, said)
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
	// Hearts are trump; the learner is seat 0, Juf Ans seat 2.
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

// TestSignalStep: Juf Ans explains a signal by whom it came from: her own
// with what follows for the learner, the learner's with whether it is
// true, an opponent's as it is.
func TestSignalStep(t *testing.T) {
	r := lessonRoom(t)
	opp := r.displayName(1)
	jack := game.Card{Rank: game.Jack, Suit: game.Hearts}
	held := r.deal.Hand(0)[0]
	missing := jack // a jack the learner does not hold
	for slices.Contains(r.deal.Hand(0), missing) {
		missing.Suit++
	}
	for _, c := range []struct {
		sig  Signal
		want string
	}{
		{Signal{Seat: 2, Card: game.Card{Rank: game.Ace, Suit: game.Spades}, Kind: "aas", Means: game.Card{Rank: game.Ten, Suit: game.Spades}},
			"Dat was een sein. Ik gooide ♠A bij op jouw slag, en aan deze tafel betekent dat: “ik heb ♠10 ook” (aas vraagt 10). " +
				"Speel later schoppen, dan kan mijn ♠10 de slag halen. Met seinen vertel je je maat iets over je kaarten."},
		{Signal{Seat: 0, Card: game.Card{Rank: game.Seven, Suit: game.Clubs}, Kind: "hoogLaag", Means: held},
			"Dat was een sein. Jij gooide ♣7 bij op mijn slag, een laag kaartje, en aan deze tafel betekent dat: “speel klaveren, daar heb ik de hoogste van” (hoog/laag bijspelen). " +
				"Dat klopt, dus ik speel later klaveren naar je toe. Met seinen vertel je je maat iets over je kaarten."},
		{Signal{Seat: 0, Card: game.Card{Rank: game.Seven, Suit: game.Clubs}, Kind: "kleintjeBoer", Means: missing},
			"Dat was een sein. Jij kwam voor het eerst uit, met ♣7: een kleintje van een bijkleur. Van het koppel dat troef koos, betekent dat aan deze tafel: “ik heb de troefboer” (kleintje boer). " +
				"Let op: ik lees het zo, ook als je de troefboer niet hebt. Met seinen vertel je je maat iets over je kaarten."},
		{Signal{Seat: 1, Card: game.Card{Rank: game.Jack, Suit: game.Spades}, Kind: "boerOverBoer", Means: jack},
			"Dat was een sein. " + opp + " kwam voor het eerst uit, met ♠B: de boer van een bijkleur. Van het koppel dat troef koos, betekent dat aan deze tafel: “ik heb de troefboer” (boer over boer). " +
				"Met seinen vertel je je maat iets over je kaarten."},
	} {
		if got := r.signalStep(c.sig).Text; got != c.want {
			t.Errorf("got  %q\nwant %q", got, c.want)
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
	text := r.scoreStep().Text
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
}
