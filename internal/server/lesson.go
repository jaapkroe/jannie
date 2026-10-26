package server

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"klaverjas/internal/game"
)

// Lessons (issue #41, design §6): with option lessons Juf Ans teaches the
// game in training, a step at a time. After the first deal she says who
// sits where and what the screen shows; after the first trump how the
// cards rank and what they are worth; on the player's turn, the first time
// they lead, must follow suit, must trump or may play anything, which
// cards may be played. In the first hand every trick waits for its
// explanation, and the last one also says how the hand was scored. Roem is
// explained the first time it falls, and from the second hand the first
// signal. Every step is a line of Juf Ans in the chat too.
//
// A step stays on screen until the player reads it (tipRead), without a
// timer: during a pause the game waits for it, on the player's own turn
// only the hint does.

// The lessons given once per room (room.taught), besides the turns of
// playLesson.
const (
	lessonIntro  = "intro"
	lessonTrump  = "trump"
	lessonRoem   = "roem"
	lessonSignal = "signal"
	lessonScore  = "score"
)

// lessonStep is one thing Juf Ans explains. N numbers the steps of a room,
// so a late tap cannot skip the step after the one it was meant for; Spot
// names the part of the screen it is about (design §9).
type lessonStep struct {
	N    int    `json:"n"`
	Text string `json:"text"`
	Spot string `json:"spot,omitempty"`
}

func (r *room) lessonsOn() bool { return r.training && r.opts.Lessons }

// learner is the seat of the person in training.
func (r *room) learner() game.Seat {
	for i := range r.seats {
		if r.seats[i].kind == seatHuman {
			return game.Seat(i)
		}
	}
	return 0
}

// once reports whether lesson key is still to be given in this room, and
// marks it given.
func (r *room) once(key string) bool {
	if r.taught[key] {
		return false
	}
	if r.taught == nil {
		r.taught = make(map[string]bool)
	}
	r.taught[key] = true
	return true
}

// startLesson numbers steps and shows the first one.
func (r *room) startLesson(steps []lessonStep) {
	for k := range steps {
		r.lessonN++
		steps[k].N = r.lessonN
	}
	r.lessons = steps
	r.nextStep()
}

// nextStep shows the next step of the lesson and reports whether there was
// one.
func (r *room) nextStep() bool {
	r.lesson, r.lessonChat = nil, false
	if len(r.lessons) == 0 {
		return false
	}
	st := r.lessons[0]
	r.lesson, r.lessons = &st, r.lessons[1:]
	return true
}

// clearLesson takes the lesson off the screen unread.
func (r *room) clearLesson() {
	r.lesson, r.lessons = nil, nil
}

// teach starts the lesson due as the current pause ends: the intro after
// the first deal, the trump lesson after the first announcement. The pause
// then waits for it to be read (readLesson). It reports whether it did.
func (r *room) teach() bool {
	if !r.lessonsOn() || r.lesson != nil {
		return false
	}
	var steps []lessonStep
	switch {
	case r.pending == stepDealt && r.once(lessonIntro):
		steps = r.introSteps()
	case r.pending == stepAnnounced && r.once(lessonTrump):
		steps = r.trumpSteps()
	default:
		return false
	}
	r.pendingAt = time.Time{}
	r.startLesson(steps)
	r.emit(nil)
	return true
}

// readLesson moves on from the step on screen, read by the player: to the
// next step, or the pause it held ends, or on the player's turn the hint
// shows. A tap for another step than the one on screen came late and
// changes nothing. It reports whether a lesson was on screen.
func (r *room) readLesson(n *int) bool {
	if r.lesson == nil {
		return false
	}
	if n != nil && *n != r.lesson.N {
		return true
	}
	if r.nextStep() {
		r.emit(nil)
		return true
	}
	if r.pending == stepNone {
		r.openedAt = time.Now() // the think time of the turn (review) starts now
		r.emit(nil)
		return true
	}
	r.runPending()
	return true
}

// chatLesson puts the step on screen in the chat, once: the first update
// that shows it has gone out.
func (r *room) chatLesson() {
	if r.lesson == nil || r.lessonChat {
		return
	}
	r.lessonChat = true
	r.coachChat(r.lesson.Text)
}

// coachChat puts text in the chat as a line of Juf Ans, the learner's
// partner. It is marked coach: the coach bubble shows it already, so the
// table shows no speech bubble for it.
func (r *room) coachChat(text string) {
	i := r.learner().Partner()
	r.addChat(chatMsg{Seat: int(i), Name: r.displayName(i), Text: text, TS: time.Now().UnixMilli(), Bot: true, Coach: true})
}

// who names seat i as Juf Ans speaks of it: "ik" for herself, "jij" for
// the learner, else the name at the table.
func (r *room) who(i game.Seat) string {
	switch me := r.learner(); i {
	case me:
		return "jij"
	case me.Partner():
		return "ik"
	}
	return r.displayName(i)
}

// whose names the trick seat i holds: "jouw slag", "mijn slag", "de slag
// van Bram (AI)".
func (r *room) whose(i game.Seat) string {
	switch me := r.learner(); i {
	case me:
		return "jouw slag"
	case me.Partner():
		return "mijn slag"
	}
	return "de slag van " + r.displayName(i)
}

func (r *room) introSteps() []lessonStep {
	me := r.learner()
	ans := me.Partner()
	return []lessonStep{
		{Spot: "partner", Text: "Ik ben " + r.seats[ans].persona.Name + ", je maat: ik zit tegenover je. Samen spelen we tegen " +
			r.displayName((me+1)%4) + " en " + r.displayName((me+3)%4) + ". Tik op Verder, of ergens op tafel, om door te gaan."},
		{Spot: "hand", Text: "Klaverjassen speel je met 32 kaarten: iedereen krijgt er 8. Onderaan zie je de jouwe."},
		{Spot: "trick", Text: "Om de beurt speelt iedereen een kaart op tafel. Die vier kaarten samen zijn een slag. " +
			"De hoogste kaart wint de slag, en wie wint, komt bij de volgende slag als eerste uit."},
		r.trumpIntro(),
		{Spot: "score", Text: "Elke slag levert punten op. Bovenaan staat de stand: Wij, dat zijn jij en ik, en Zij, de andere twee."},
		{Spot: "chat", Text: "Ben je aan de beurt, dan geef ik je een tip, en na elke slag leg ik uit wat er gebeurde. " +
			"Wat ik zeg, kun je teruglezen in de chat."},
	}
}

// trumpIntro says how trump is chosen in this hand.
func (r *room) trumpIntro() lessonStep {
	text := "Eén kleur wordt troef: een troefkaart wint van elke kaart van een andere kleur. "
	if r.deal.Mode() == game.Gedraaid {
		text += "Zo meteen wordt er een kleur omgedraaid. Om de beurt zeg je of je met die kleur als troef wilt spelen, of dat je past."
		return lessonStep{Spot: "trump", Text: text}
	}
	switch first := r.deal.Voorhand(); first {
	case r.learner():
		text += "Jij komt als eerste uit en kiest daarom de troef: neem een kleur waar je veel kaarten van hebt, het liefst met de boer en de 9 erbij."
	case r.learner().Partner():
		text += "Ik kom als eerste uit en kies daarom de troef."
	default:
		text += r.displayName(first) + " komt als eerste uit en kiest daarom de troef."
	}
	return lessonStep{Spot: "trump", Text: text}
}

func (r *room) trumpSteps() []lessonStep {
	trump, _ := r.deal.Trump()
	return []lessonStep{
		{Spot: "trump", Text: trump.Symbol() + " is troef. In troef is de boer de hoogste kaart, dan de 9, de aas en de 10. " +
			"In de andere kleuren is de aas de hoogste, dan de 10, de heer en de vrouw."},
		{Spot: "trump", Text: "De punten: troefboer 20, troefnegen 14, aas 11, tien 10, heer 4, vrouw 3 en een gewone boer 2. " +
			"De 7, de 8 en een gewone 9 zijn niets waard. De laatste slag levert 10 punten extra op."},
	}
}

// turnLesson starts the lesson for the learner's turn i in play, the first
// time they meet its situation (playLesson). Only the hint waits for it.
func (r *room) turnLesson(i game.Seat) {
	if !r.lessonsOn() || r.lesson != nil || r.pending != stepNone || i != r.learner() || r.deal.Phase() != game.PhasePlay {
		return
	}
	key, text := playLesson(r.deal.View(i))
	if key == "" || !r.once(key) {
		return
	}
	r.startLesson([]lessonStep{{Text: text, Spot: "rule"}})
}

// playLesson is the lesson for the turn of v in play: which cards may be
// played, and why, for the situations a beginner meets first. key names
// the situation; "" for the others (the rule above the hand says those).
func playLesson(v game.View) (key, text string) {
	trick := v.Current.Cards
	if len(trick) == 0 {
		return "lead", "Jij komt uit: je mag elke kaart spelen. Wie na je komt, moet die kleur bekennen: ook die kleur spelen, als dat kan."
	}
	led, trump := trick[0].Card.Suit, v.Trump
	has := func(s game.Suit) bool {
		return slices.ContainsFunc(v.Hand, func(c game.Card) bool { return c.Suit == s })
	}
	const dim = " De kaarten die niet mogen, zijn donkerder."
	sym := led.Symbol()
	switch {
	case led == trump && has(trump):
		return "trumpLed", "Troef is gevraagd: speel ook troef, en hoger dan de hoogste troef op tafel als je kunt (overtroeven)." + dim
	case led == trump:
		return "free", "Troef is gevraagd, maar je hebt geen troef: dan mag je elke kaart spelen."
	case has(led):
		return "follow", sym + " is gevraagd en je hebt " + sym + ", dus je moet " + sym + " spelen: dat heet bekennen." + dim
	case !has(trump):
		return "free", "Je hebt geen " + sym + " en ook geen troef: dan mag je elke kaart spelen."
	case !slices.ContainsFunc(v.Legal, func(c game.Card) bool { return c.Suit != trump }):
		text = "Je hebt geen " + sym + ", dus je moet troeven: speel een " + trump.Symbol() + ". Een troef wint van elke " + sym + "."
		if slices.ContainsFunc(trick, func(p game.Played) bool { return p.Card.Suit == trump }) {
			text += " Er ligt al troef: troef hoger als je kunt (overtroeven)."
		}
		return "trump", text + dim
	case winning(trick, trump) == v.Seat.Partner():
		return "partner", "Je hebt geen " + sym + ", maar ik heb de slag. Dan hoef je niet te troeven: je mag ook een andere kleur bijgooien."
	}
	return "", ""
}

// winning is the seat whose card wins the cards of a trick so far.
func winning(cards []game.Played, trump game.Suit) game.Seat {
	best := cards[0]
	for _, p := range cards[1:] {
		if game.Beats(p.Card, best.Card, cards[0].Card.Suit, trump) {
			best = p
		}
	}
	return best.Seat
}

// trickLessons returns the steps that come with trick t, just completed:
// roem the first time it falls, the first signal from the second hand on,
// and after the last trick of the first hand how it was scored. In the
// first hand, and before another step, the explanation of the trick (tips)
// comes first. The trick waits until all are read; nil: it goes as usual.
func (r *room) trickLessons(t game.Trick, tips [4]string) []lessonStep {
	if !r.lessonsOn() {
		return nil
	}
	var steps []lessonStep
	if t.RoemTotal() > 0 && r.once(lessonRoem) {
		steps = append(steps, lessonStep{Spot: "trick", Text: "Dat was roem: extra punten voor kaarten die samen in één slag liggen. " +
			"Drie op een rij van één kleur (zoals 9, 10 en boer) is 20, vier op een rij 50, en heer en vrouw van troef (stuk) 20. " +
			"Wie de slag wint, krijgt de roem."})
	}
	if r.lessonHands >= 2 && !r.taught[lessonSignal] {
		if sig, ok := r.trickSignal(); ok && r.once(lessonSignal) {
			steps = append(steps, r.signalStep(sig))
		}
	}
	first := r.lessonHands == 1
	if first && r.deal.Phase() == game.PhaseDone && r.once(lessonScore) {
		steps = append(steps, r.scoreStep())
	}
	if len(steps) == 0 && !first {
		return nil
	}
	if text := tips[r.learner()]; text != "" {
		steps = append([]lessonStep{{Spot: "trick", Text: text}}, steps...)
	}
	return steps
}

func (r *room) trickSignal() (s Signal, ok bool) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("TrickSignal panicked", "panic", fmt.Sprint(p))
			s, ok = Signal{}, false
		}
	}()
	return r.srv.cfg.AI.TrickSignal(r.viewFor(r.learner()))
}

// signalStep explains sig, the first signal of the room: what the card
// says at this table, and for Juf Ans's partner what follows from it.
func (r *room) signalStep(sig Signal) lessonStep {
	me := r.learner()
	who := capital(r.who(sig.Seat))
	card, means := game.CardShortNL(sig.Card), game.CardShortNL(sig.Means)
	suit := game.SuitNameNL(sig.Card.Suit)
	var said, then string
	switch sig.Kind {
	case "aas":
		said = who + " gooide " + card + " bij op " + r.whose(sig.Seat.Partner()) +
			", en aan deze tafel betekent dat: “ik heb " + means + " ook” (aas vraagt 10)."
		then = "Speel later " + suit + ", dan kan mijn " + means + " de slag halen."
	case "hoogLaag":
		said = who + " gooide " + card + " bij op " + r.whose(sig.Seat.Partner()) +
			", een laag kaartje, en aan deze tafel betekent dat: “speel " + suit + ", daar heb ik de hoogste van” (hoog/laag bijspelen)."
		then = "Speel later " + suit + ", dan haal ik die slag."
	default: // kleintjeBoer, boerOverBoer
		what, name := "een kleintje van een bijkleur", "kleintje boer"
		if sig.Kind == "boerOverBoer" {
			what, name = "de boer van een bijkleur", "boer over boer"
		}
		means = "de troefboer"
		said = who + " kwam voor het eerst uit, met " + card + ": " + what +
			". Van het koppel dat troef koos, betekent dat aan deze tafel: “ik heb de troefboer” (" + name + ")."
		then = "Kom jij aan slag, speel dan troef: dan haal ik met de boer de troeven op."
	}
	switch {
	case sig.Seat == me && slices.Contains(r.deal.Hand(me), sig.Means) && means == "de troefboer":
		then = "Dat klopt, dus ik speel troef terug als ik aan slag kom."
	case sig.Seat == me && slices.Contains(r.deal.Hand(me), sig.Means):
		then = "Dat klopt, dus ik speel later " + suit + " naar je toe."
	case sig.Seat == me:
		then = "Let op: ik lees het zo, ook als je " + means + " niet hebt."
	case sig.Seat != me.Partner():
		then = ""
	}
	parts := []string{"Dat was een sein.", said, then, "Met seinen vertel je je maat iets over je kaarten."}
	return lessonStep{Spot: "trick", Text: strings.Join(slices.DeleteFunc(parts, func(s string) bool { return s == "" }), " ")}
}

// scoreStep says how the first hand was scored, after its last trick.
func (r *room) scoreStep() lessonStep {
	res := r.deal.Result()
	we := r.learner().Team()
	they := 1 - we
	side := func(k int) string {
		s := strconv.Itoa(res.Points[k]) + " punten"
		if res.Roem[k] > 0 {
			s += " en " + strconv.Itoa(res.Roem[k]) + " roem"
		}
		return s
	}
	pick := func(us bool, a, b string) string {
		if us {
			return a
		}
		return b
	}
	parts := []string{"Het potje is uit: wij hebben " + side(we) + ", zij " + side(they) + "."}
	if res.Pit {
		parts = append(parts, pick(res.PitTeam == we, "Wij", "Zij")+" hebben alle acht slagen: dat is pit, 100 roem extra.")
	}
	us := res.PlayingTeam == we
	parts = append(parts, capital(r.who(res.TrumpBy))+" koos troef, dus "+pick(us, "wij", "zij")+" moesten meer halen dan "+
		pick(us, "zij", "wij")+", roem meegeteld.")
	switch {
	case !res.Nat:
		parts = append(parts, "Dat is gelukt.")
	case us:
		parts = append(parts, "Dat is niet gelukt: wij gaan nat, en zij krijgen alle "+strconv.Itoa(res.Score[they])+" punten.")
	default:
		parts = append(parts, "Dat is niet gelukt: zij gaan nat, en wij krijgen alle "+strconv.Itoa(res.Score[we])+" punten.")
	}
	parts = append(parts, "Na "+strconv.Itoa(r.opts.Hands)+" potjes wint het koppel met de meeste punten.")
	return lessonStep{Spot: "score", Text: strings.Join(parts, " ")}
}

// capital makes the first letter of s upper case.
func capital(s string) string {
	c, n := utf8.DecodeRuneInString(s)
	return string(unicode.ToUpper(c)) + s[n:]
}
