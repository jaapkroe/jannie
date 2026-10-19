package server

import (
	crand "crypto/rand"
	"encoding/binary"
	"fmt"
	"log/slog"
	"math/bits"
	"math/rand/v2"
	"runtime/debug"
	"sync"
	"time"

	"klaverjas/internal/game"
)

// Room phases on the wire.
const (
	phaseLobby    = "lobby"
	phaseTrump    = "trump"
	phaseBid      = "bid"
	phasePlay     = "play"
	phaseHandEnd  = "handEnd"
	phaseGameOver = "gameOver"
)

const (
	awayAfter = 20 * time.Second // a disconnected human's turn before a substitute plays
	hostGrace = 30 * time.Second // a disconnected host before another human takes over
	chatLog   = 50
)

type seatKind uint8

const (
	seatEmpty seatKind = iota
	seatHuman
	seatBot
)

// seat is one place at the table.
type seat struct {
	kind seatKind

	// Humans.
	name   string
	token  string
	client *client   // nil while disconnected
	leftAt time.Time // when the connection went
	away   bool      // a substitute plays for them
	awayAt time.Time
	ready  bool
	chat   tokenBucket

	// Bots, and the substitute of a human.
	persona  Persona
	vacated  bool // a bot that took over a human who left; joiners may take it
	brain    *brainBox
	lastChat time.Time
	chatAt   int // trick number of the last line
}

// room is one table. All fields below the channel block are owned by the
// room goroutine (loop) and must only be touched from commands it runs.
type room struct {
	srv  *Server
	code string
	log  *slog.Logger

	cmds     chan func()
	done     chan struct{}
	stopOnce sync.Once

	rng       *rand.Rand
	opts      Options
	training  bool
	alwaysOn  bool // tests: bots play on without a connected human
	seats     [4]seat
	host      game.Seat
	phase     string
	seq       int
	chat      []chatMsg
	idleSince time.Time
	overAt    time.Time

	// The match.
	handNo    int
	deal      *game.Deal
	collected bool      // the completed current trick has been collected
	pending   step      // a pause in progress (turn -1), ended by runPending
	pendingAt time.Time // when the pause ends
	turnAt    time.Time // when the current turn opened
	think     time.Duration
	gen       uint64 // bumped by drive; stale timers compare it
	step      int    // bumped when a turn opens (hint cache key)
	hintStep  int
	hintVal   *hint
	scores    []scoreRow
	total     [2]int
	prev      *prevHand
	lastTrick *game.Trick
	winner    int
	nextAt    time.Time
	trickNo   int // tricks completed in this room, for bot chat limits
}

func newRoom(s *Server, code string) *room {
	var seed [16]byte
	crand.Read(seed[:])
	return &room{
		srv:    s,
		code:   code,
		log:    s.log.With("room", code),
		cmds:   make(chan func(), 64),
		done:   make(chan struct{}),
		rng:    rand.New(rand.NewPCG(binary.LittleEndian.Uint64(seed[:8]), binary.LittleEndian.Uint64(seed[8:]))),
		opts:   defaultOptions(),
		host:   game.NoSeat,
		phase:  phaseLobby,
		winner: -1,
	}
}

// loop runs the room's commands until it stops.
func (r *room) loop() {
	for {
		select {
		case f := <-r.cmds:
			r.run(f)
		case <-r.done:
			return
		}
	}
}

func (r *room) run(f func()) {
	defer func() {
		if v := recover(); v != nil {
			r.log.Error("room command panicked", "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
		}
	}()
	f()
}

// post queues f for the room goroutine; false if the room has stopped.
func (r *room) post(f func()) bool {
	select {
	case <-r.done:
		return false
	default:
	}
	select {
	case r.cmds <- f:
		return true
	case <-r.done:
		return false
	}
}

// stop ends the room goroutine; pending timers and posts become no-ops.
func (r *room) stop() {
	r.stopOnce.Do(func() { close(r.done) })
}

// after runs f on the room goroutine after d, unless drive ran meanwhile.
func (r *room) after(d time.Duration, f func()) {
	gen := r.gen
	r.later(d, func() {
		if r.gen == gen {
			f()
		}
	})
}

// later runs f on the room goroutine after d.
func (r *room) later(d time.Duration, f func()) {
	time.AfterFunc(max(d, 0), func() { r.post(f) })
}

// scaled applies the server's time scale (-fast) to a game delay.
func (r *room) scaled(d time.Duration) time.Duration {
	return time.Duration(float64(d) * r.srv.scale)
}

func (r *room) pace() pacing {
	if p, ok := pacings[r.opts.Tempo]; ok {
		return p
	}
	return pacings["normaal"]
}

// ---- seats ----

func (r *room) seatOf(c *client) game.Seat {
	for i := range r.seats {
		if r.seats[i].kind == seatHuman && r.seats[i].client == c {
			return game.Seat(i)
		}
	}
	return game.NoSeat
}

func (r *room) seatByToken(token string) game.Seat {
	if token == "" {
		return game.NoSeat
	}
	for i := range r.seats {
		if r.seats[i].kind == seatHuman && r.seats[i].token == token {
			return game.Seat(i)
		}
	}
	return game.NoSeat
}

// setClient binds a connection to a human seat (nil: disconnected) and
// keeps the server's player count.
func (r *room) setClient(i game.Seat, c *client) {
	st := &r.seats[i]
	switch {
	case st.client == nil && c != nil:
		r.srv.players.Add(1)
	case st.client != nil && c == nil:
		r.srv.players.Add(-1)
	}
	resumed := c != nil && r.connectedHumans() == 0
	st.client = c
	if c != nil {
		r.idleSince = time.Time{}
	} else if r.connectedHumans() == 0 {
		r.idleSince = time.Now()
	}
	if resumed {
		r.resume()
	}
}

// resume restarts the clock when a player returns to a room where nobody
// was connected: bots think again and the hand summary shows in full.
func (r *room) resume() {
	now := time.Now()
	r.turnAt = now
	if r.pending == stepNextHand {
		r.pendingAt = now.Add(r.scaled(r.pace().summary))
		r.nextAt = r.pendingAt
	}
}

func (r *room) humanCount() int {
	n := 0
	for i := range r.seats {
		if r.seats[i].kind == seatHuman {
			n++
		}
	}
	return n
}

func (r *room) connectedHumans() int {
	n := 0
	for i := range r.seats {
		if r.seats[i].kind == seatHuman && r.seats[i].client != nil {
			n++
		}
	}
	return n
}

func newHuman(name string) seat {
	return seat{
		kind:  seatHuman,
		name:  name,
		token: newToken(),
		chat:  tokenBucket{tokens: 5, max: 5, rate: 1},
	}
}

func (r *room) newBot(p Persona) seat {
	return seat{kind: seatBot, persona: p, brain: r.newBrain(p.ID, r.opts.AI), chatAt: -1}
}

func (r *room) newBrain(personaID, level string) *brainBox {
	return &brainBox{b: r.srv.cfg.AI.NewBrain(personaID, level, r.rng.Uint64()), log: r.log}
}

// persona looks up a persona by ID.
func (r *room) persona(id string) (Persona, bool) {
	for _, p := range r.srv.personas {
		if p.ID == id {
			return p, true
		}
	}
	return Persona{}, false
}

// randomPersona picks a persona not seated at the table and not in skip.
func (r *room) randomPersona(skip ...string) Persona {
	used := map[string]bool{}
	for i := range r.seats {
		if r.seats[i].kind == seatBot {
			used[r.seats[i].persona.ID] = true
		}
	}
	for _, id := range skip {
		used[id] = true
	}
	var free []Persona
	for _, p := range r.srv.personas {
		if !used[p.ID] {
			free = append(free, p)
		}
	}
	if len(free) == 0 {
		free = r.srv.personas
	}
	return free[r.rng.IntN(len(free))]
}

func botName(p Persona) string { return p.Name + " (AI)" }

// displayName is how a seat appears in chat and texts.
func (r *room) displayName(i game.Seat) string {
	st := &r.seats[i]
	switch st.kind {
	case seatHuman:
		return st.name
	case seatBot:
		return botName(st.persona)
	}
	return "Lege plaats"
}

// arrangeBots sets the number of bot seats to 4-humans in the lobby. It
// never moves humans, keeps existing bots where it can, and otherwise puts
// bots so the seats left for humans are partners (humans 2: bots at 1 and
// 3; 3: bot at 3; 1: bots at 1, 2 and 3).
func (r *room) arrangeBots() {
	want := 4 - r.opts.Humans
	pref := [4]int{0, 2, 1, 3} // preference for a bot at each seat
	best, bestScore := -1, -1
	for mask := 0; mask < 16; mask++ {
		if bits.OnesCount(uint(mask)) != want {
			continue
		}
		score, ok := 0, true
		for i := range 4 {
			bot := mask&(1<<i) != 0
			switch r.seats[i].kind {
			case seatHuman:
				ok = ok && !bot
			case seatBot:
				if bot {
					score += 100
				}
			}
			if bot {
				score += pref[i]
			} else if mask&(1<<((i+2)%4)) == 0 {
				score += 10
			}
		}
		if ok && score > bestScore {
			best, bestScore = mask, score
		}
	}
	if best < 0 {
		return
	}
	for i := range 4 {
		bot := best&(1<<i) != 0
		switch {
		case bot && r.seats[i].kind == seatEmpty:
			r.seats[i] = r.newBot(r.randomPersona())
		case !bot && r.seats[i].kind == seatBot:
			r.seats[i] = seat{}
		}
	}
}

// fillSeats puts random distinct bots on every empty seat.
func (r *room) fillSeats() {
	for i := range r.seats {
		if r.seats[i].kind == seatEmpty {
			r.seats[i] = r.newBot(r.randomPersona())
		}
	}
}

// seatTraining sets up the training table: Juf Ans opposite the player,
// two random opponents.
func (r *room) seatTraining() {
	ans, ok := r.persona("ans")
	if !ok {
		ans = r.randomPersona()
	}
	r.seats[2] = r.newBot(ans)
	r.seats[1] = r.newBot(r.randomPersona(ans.ID))
	r.seats[3] = r.newBot(r.randomPersona(ans.ID))
}

// ---- messages to clients ----

// emit sends an update with ev to every connected human; fresh (a client
// that just joined) gets ev null instead, as a resync.
func (r *room) emit(ev any) { r.emitTo(ev, nil) }

func (r *room) emitTo(ev any, fresh *client) {
	r.seq++
	for i := range r.seats {
		st := &r.seats[i]
		if st.kind != seatHuman || st.client == nil {
			continue
		}
		e := ev
		if st.client == fresh {
			e = nil
		}
		st.client.send(mustJSON(updateMsg{T: "update", Seq: r.seq, Ev: e, S: r.stateFor(game.Seat(i))}))
	}
}

// resync sends c its full state without an event.
func (r *room) resync(c *client, i game.Seat) {
	c.send(mustJSON(updateMsg{T: "update", Seq: r.seq, Ev: nil, S: r.stateFor(i)}))
}

// welcome sends joined and the chat log.
func (r *room) welcome(c *client, i game.Seat) {
	c.send(mustJSON(joinedMsg{T: "joined", Code: r.code, Seat: int(i), Token: r.seats[i].token}))
	msgs := r.chat
	if msgs == nil {
		msgs = []chatMsg{}
	}
	c.send(mustJSON(chatlogMsg{T: "chatlog", Msgs: msgs}))
}

func (r *room) broadcast(b []byte) {
	for i := range r.seats {
		if c := r.seats[i].client; r.seats[i].kind == seatHuman && c != nil {
			c.send(b)
		}
	}
}

func (r *room) addChat(m chatMsg) {
	if len(r.chat) >= chatLog {
		r.chat = append(r.chat[:0], r.chat[len(r.chat)-chatLog+1:]...)
	}
	r.chat = append(r.chat, m)
	r.broadcast(mustJSON(chatOut{T: "chat", Msg: m}))
}

func (r *room) sysChat(format string, args ...any) {
	r.addChat(chatMsg{Seat: -1, Text: fmt.Sprintf(format, args...), TS: time.Now().UnixMilli(), Sys: true})
}

// ---- joining and leaving ----

func (r *room) handleCreate(c *client, m *inMsg) {
	patch, _ := parseOpts(m.Opts, true)
	r.training = m.Training
	if r.training {
		r.opts.Tempo = "rustig"
	}
	patch.apply(&r.opts)
	if patch.Humans != nil {
		r.opts.Humans = *patch.Humans
	}
	if r.training {
		r.opts.Humans = 1
	} else {
		r.opts.Open = false
	}
	r.seats[0] = newHuman(cleanName(m.Name))
	r.setClient(0, c)
	r.host = 0
	if r.training {
		r.seatTraining()
	} else {
		r.arrangeBots()
	}
	r.log.Info("room created", "training", r.training, "humans", r.opts.Humans, "start", m.Start)
	r.welcome(c, 0)
	r.emitTo(evLobby{Type: "lobby"}, c)
	if m.Start {
		r.startMatch()
	}
}

func (r *room) handleJoin(c *client, m *inMsg) {
	if i := r.seatOf(c); i != game.NoSeat {
		r.welcome(c, i)
		r.resync(c, i)
		return
	}
	if i := r.seatByToken(m.Token); i != game.NoSeat {
		r.reconnect(c, i)
		return
	}
	fail := func(code, msg string) {
		c.leaveRoom(r)
		c.sendError(code, msg)
	}
	name := cleanName(m.Name)
	if r.training {
		fail(errFull, "Dit is een oefenspel; daar kun je niet aan meedoen.")
		return
	}
	if r.phase == phaseLobby {
		if r.humanCount() >= r.opts.Humans {
			fail(errFull, "Deze tafel is vol.")
			return
		}
		i := r.firstSeat(func(st *seat) bool { return st.kind == seatEmpty })
		if i == game.NoSeat {
			fail(errFull, "Deze tafel is vol.")
			return
		}
		r.seats[i] = newHuman(name)
		r.setClient(i, c)
		if r.host == game.NoSeat {
			r.host = i
		}
		r.welcome(c, i)
		r.sysChat("%s schuift aan.", name)
		r.emitTo(evSeat{Type: "join", Seat: i}, c)
		r.checkHost()
		return
	}
	// A running game: only a seat a human left can be taken over.
	i := r.firstSeat(func(st *seat) bool { return st.kind == seatBot && st.vacated })
	if i == game.NoSeat {
		fail(errStarted, "Dit spel is al begonnen.")
		return
	}
	old := botName(r.seats[i].persona)
	r.seats[i] = newHuman(name)
	r.setClient(i, c)
	if r.host == game.NoSeat {
		r.host = i
	}
	r.welcome(c, i)
	r.sysChat("%s neemt de plaats van %s over.", name, old)
	r.emitTo(evSeat{Type: "join", Seat: i}, c)
	r.checkHost()
	r.drive()
}

func (r *room) firstSeat(ok func(*seat) bool) game.Seat {
	for i := range r.seats {
		if ok(&r.seats[i]) {
			return game.Seat(i)
		}
	}
	return game.NoSeat
}

// reconnect returns c to its seat (join with the seat token).
func (r *room) reconnect(c *client, i game.Seat) {
	st := &r.seats[i]
	wasConnected := st.client != nil
	if old := st.client; old != nil && old != c {
		old.leaveRoom(r)
		old.sendError(errUnknown, "Je speelt nu verder in een ander venster.")
	}
	wasAway := st.away
	if wasConnected {
		st.client = c // a new connection replaces the old one
	} else {
		r.setClient(i, c)
	}
	st.away = false
	r.welcome(c, i)
	if wasAway {
		r.sysChat("%s is terug.", st.name)
	}
	if wasConnected {
		r.resync(c, i)
	} else {
		r.emitTo(evSeat{Type: "back", Seat: i}, c)
	}
	r.checkHost()
	r.drive()
}

// disconnected handles a connection that went away; the seat is kept.
func (r *room) disconnected(c *client) {
	i := r.seatOf(c)
	if i == game.NoSeat {
		return
	}
	r.setClient(i, nil)
	r.seats[i].leftAt = time.Now()
	if r.phase == phaseHandEnd && r.allReady() {
		r.nextHand()
		return
	}
	r.emit(evSeat{Type: "away", Seat: i})
	if i == r.host {
		r.later(r.scaled(hostGrace), r.checkHost)
	}
	r.drive()
}

// leave handles an explicit leave: in the lobby the seat empties, in a
// game a bot takes it over until someone joins in that place.
func (r *room) leave(c *client, i game.Seat) {
	c.leaveRoom(r)
	name := r.seats[i].name
	r.setClient(i, nil)
	if r.phase == phaseLobby {
		r.seats[i] = seat{}
		if r.humanCount() == 0 {
			r.close("leeg")
			return
		}
		r.sysChat("%s is vertrokken.", name)
	} else {
		p := r.randomPersona()
		r.seats[i] = r.newBot(p)
		r.seats[i].vacated = true
		r.sysChat("%s is vertrokken; %s neemt het over.", name, botName(p))
	}
	if i == r.host {
		r.host = game.NoSeat
		r.pickHost(i)
	}
	r.emit(evSeat{Type: "leave", Seat: i})
	r.drive()
}

// checkHost hands the host role to a connected human when the host has
// left or has been disconnected longer than the grace period.
func (r *room) checkHost() {
	if r.host != game.NoSeat {
		st := &r.seats[r.host]
		if st.kind == seatHuman && (st.client != nil || time.Since(st.leftAt) < r.scaled(hostGrace)) {
			return
		}
	}
	if r.pickHost(max(r.host, 0)) {
		r.emitState()
	}
}

// pickHost makes the first connected human after seat `from` the host,
// else the first human; it reports whether the host changed.
func (r *room) pickHost(from game.Seat) bool {
	pick := game.NoSeat
	for k := 1; k <= 4 && pick == game.NoSeat; k++ {
		i := (from + game.Seat(k)) & 3
		if st := &r.seats[i]; st.kind == seatHuman && st.client != nil {
			pick = i
		}
	}
	for k := 1; k <= 4 && pick == game.NoSeat; k++ {
		if i := (from + game.Seat(k)) & 3; r.seats[i].kind == seatHuman {
			pick = i
		}
	}
	if pick == game.NoSeat || pick == r.host {
		return false
	}
	r.host = pick
	r.sysChat("%s is nu de host.", r.seats[pick].name)
	return true
}

// checkIdle removes the room when it has been empty or finished too long.
func (r *room) checkIdle() {
	now := time.Now()
	switch {
	case r.phase == phaseGameOver && now.Sub(r.overAt) >= r.srv.overTimeout:
		r.close("afgelopen")
	case r.connectedHumans() == 0 && !r.idleSince.IsZero() && now.Sub(r.idleSince) >= r.srv.idleTimeout:
		r.close("verlaten")
	}
}

// close unregisters and stops the room, telling anyone still connected.
func (r *room) close(reason string) {
	for i := range r.seats {
		if c := r.seats[i].client; r.seats[i].kind == seatHuman && c != nil {
			c.leaveRoom(r)
			c.sendError(errUnknown, "Dit spel is afgelopen en opgeruimd.")
			r.setClient(game.Seat(i), nil)
		}
	}
	r.srv.removeRoom(r)
	r.stop()
	r.log.Info("room removed", "reason", reason, "hands", r.handNo)
}

// ---- commands from seated players ----

func (r *room) handle(c *client, m *inMsg) {
	i := r.seatOf(c)
	if i == game.NoSeat {
		c.leaveRoom(r)
		if m.T != "leave" {
			c.sendError(errUnknown, "Je zit niet (meer) aan deze tafel.")
		}
		return
	}
	switch m.T {
	case "sit":
		r.cmdSit(c, i, m)
	case "bot":
		r.cmdBot(c, i, m)
	case "unbot":
		r.cmdUnbot(c, i, m)
	case "opts":
		r.cmdOpts(c, i, m)
	case "start":
		if r.lobbyHost(c, i) {
			r.startMatch()
		}
	case "trump":
		s, err := game.ParseSuit(m.Suit)
		if err != nil {
			c.sendError(errInvalid, "Kies een kleur: klaveren, ruiten, harten of schoppen.")
			return
		}
		r.humanAct(c, i, action{kind: actTrump, suit: s})
	case "bid":
		if m.Play == nil {
			c.sendError(errInvalid, "Kies spelen of passen.")
			return
		}
		r.humanAct(c, i, action{kind: actBid, play: *m.Play})
	case "play":
		card, err := game.ParseCard(m.Card)
		if err != nil {
			c.sendError(errInvalid, "Die kaart bestaat niet.")
			return
		}
		r.humanAct(c, i, action{kind: actPlay, card: card})
	case "ready":
		r.cmdReady(c, i)
	case "chat":
		r.cmdChat(c, i, m)
	case "rematch":
		r.cmdRematch(c, i)
	case "leave":
		r.leave(c, i)
	default:
		c.sendError(errInvalid, "Dat bericht ken ik niet.")
	}
}

// lobbyHost checks that a lobby command comes from the host.
func (r *room) lobbyHost(c *client, i game.Seat) bool {
	if r.phase != phaseLobby {
		c.sendError(errStarted, "Het spel is al begonnen.")
		return false
	}
	if i != r.host {
		c.sendError(errNotHost, "Alleen de host kan dat doen.")
		return false
	}
	return true
}

func seatArg(m *inMsg) (game.Seat, bool) {
	if m.Seat == nil || *m.Seat < 0 || *m.Seat > 3 {
		return game.NoSeat, false
	}
	return game.Seat(*m.Seat), true
}

func (r *room) cmdSit(c *client, i game.Seat, m *inMsg) {
	if r.phase != phaseLobby {
		c.sendError(errStarted, "Het spel is al begonnen.")
		return
	}
	to, ok := seatArg(m)
	switch {
	case !ok:
		c.sendError(errInvalid, "Die plaats bestaat niet.")
		return
	case r.training:
		c.sendError(errInvalid, "In de oefenmodus ligt de tafel vast.")
		return
	case to == i:
		return
	case r.seats[to].kind != seatEmpty:
		c.sendError(errInvalid, "Die plaats is bezet.")
		return
	}
	r.seats[to], r.seats[i] = r.seats[i], seat{}
	if r.host == i {
		r.host = to
	}
	r.emit(evLobby{Type: "lobby"})
}

func (r *room) cmdBot(c *client, i game.Seat, m *inMsg) {
	if !r.lobbyHost(c, i) {
		return
	}
	to, ok := seatArg(m)
	switch {
	case !ok:
		c.sendError(errInvalid, "Die plaats bestaat niet.")
		return
	case r.training:
		c.sendError(errInvalid, "In de oefenmodus ligt de tafel vast.")
		return
	case r.seats[to].kind == seatHuman:
		c.sendError(errInvalid, "Daar zit al iemand.")
		return
	}
	var p Persona
	if m.ID == "" {
		var skip []string
		if r.seats[to].kind == seatBot {
			skip = append(skip, r.seats[to].persona.ID)
		}
		p = r.randomPersona(skip...)
	} else {
		var found bool
		if p, found = r.persona(m.ID); !found {
			c.sendError(errInvalid, "Die AI-speler ken ik niet.")
			return
		}
		for k := range r.seats {
			if game.Seat(k) != to && r.seats[k].kind == seatBot && r.seats[k].persona.ID == p.ID {
				c.sendError(errInvalid, botName(p)+" zit al aan tafel.")
				return
			}
		}
		if r.seats[to].kind == seatBot && r.seats[to].persona.ID == p.ID {
			return
		}
	}
	r.seats[to] = r.newBot(p)
	r.emit(evLobby{Type: "lobby"})
}

func (r *room) cmdUnbot(c *client, i game.Seat, m *inMsg) {
	if !r.lobbyHost(c, i) {
		return
	}
	to, ok := seatArg(m)
	switch {
	case !ok:
		c.sendError(errInvalid, "Die plaats bestaat niet.")
		return
	case r.training:
		c.sendError(errInvalid, "In de oefenmodus ligt de tafel vast.")
		return
	case r.seats[to].kind != seatBot:
		c.sendError(errInvalid, "Daar zit geen AI-speler.")
		return
	}
	r.seats[to] = seat{}
	r.emit(evLobby{Type: "lobby"})
}

func (r *room) cmdOpts(c *client, i game.Seat, m *inMsg) {
	if !r.lobbyHost(c, i) {
		return
	}
	patch, err := parseOpts(m.Opts, false)
	if err != nil {
		c.sendError(errInvalid, err.Error())
		return
	}
	if n := patch.Humans; n != nil && *n != r.opts.Humans {
		if r.training {
			c.sendError(errInvalid, "In de oefenmodus speel je altijd samen met Juf Ans.")
			return
		}
		if h := r.humanCount(); *n < h {
			c.sendError(errInvalid, fmt.Sprintf("Er zitten al %d mensen aan tafel.", h))
			return
		}
		r.opts.Humans = *n
		r.arrangeBots()
	}
	patch.apply(&r.opts)
	if !r.training {
		r.opts.Open = false
	}
	r.emit(evLobby{Type: "lobby"})
}

func (r *room) cmdReady(c *client, i game.Seat) {
	if r.phase != phaseHandEnd {
		c.sendError(errInvalid, "Dat kan nu niet.")
		return
	}
	if r.seats[i].ready {
		return
	}
	r.seats[i].ready = true
	if r.allReady() {
		r.pending = stepNone
		r.nextHand()
		return
	}
	r.emitState()
}

// allReady reports whether every connected human pressed ready.
func (r *room) allReady() bool {
	n := 0
	for i := range r.seats {
		st := &r.seats[i]
		if st.kind == seatHuman && st.client != nil {
			if !st.ready {
				return false
			}
			n++
		}
	}
	return n > 0
}

func (r *room) cmdChat(c *client, i game.Seat, m *inMsg) {
	text := cleanChat(m.Text)
	if text == "" {
		return
	}
	st := &r.seats[i]
	if !st.chat.take(time.Now()) {
		c.sendError(errLimit, "Rustig aan met chatten; wacht even.")
		return
	}
	r.addChat(chatMsg{Seat: int(i), Name: st.name, Text: text, TS: time.Now().UnixMilli()})
	r.botReply(i, text)
}

func (r *room) cmdRematch(c *client, i game.Seat) {
	if r.phase != phaseGameOver {
		c.sendError(errInvalid, "Het spel is nog niet afgelopen.")
		return
	}
	if i != r.host {
		c.sendError(errNotHost, "Alleen de host kan een nieuw spel starten.")
		return
	}
	r.sysChat("Nog een keer! Zelfde tafel, zelfde regels.")
	r.startMatch()
}
