package server

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"klaverjas/internal/game"
)

// gameLog keeps a compact record of every match (design §6 Game log): one
// JSON line per event in a file per month, games-2026-10.jsonl, in dir. It
// holds what was dealt and played, the reviews, the players' own choices
// and feedback, and who played (name, address, device), so games can be
// looked at again, shown as statistics and the engine tuned on them. Lines
// go through a bounded queue to one writer goroutine: a slow disk never
// holds up a room, and a full queue drops lines (and says so in the server
// log) rather than block. The writer keeps gameLogMonths of files (prune).
type gameLog struct {
	dir  string
	log  *slog.Logger
	ch   chan []byte
	done chan struct{}
	now  func() time.Time // tests

	mu     sync.RWMutex // guards closed against writes racing close
	closed bool
}

const gameLogQueue = 4096

// gameLogMonths is how many month files the game log keeps: the current
// month and the eleven before it, so no record is kept longer than twelve
// months. The writer prunes at its start and every pruneEvery.
const (
	gameLogMonths = 12
	pruneEvery    = time.Hour
)

// newGameLog starts the writer for dir, or returns nil (no game log) when
// dir is empty. A nil *gameLog accepts and ignores every write.
func newGameLog(dir string, log *slog.Logger) *gameLog {
	return startGameLog(dir, log, time.Now)
}

// startGameLog is newGameLog on clock now (tests).
func startGameLog(dir string, log *slog.Logger, now func() time.Time) *gameLog {
	if dir == "" {
		return nil
	}
	g := &gameLog{dir: dir, log: log, ch: make(chan []byte, gameLogQueue), done: make(chan struct{}), now: now}
	go g.run()
	return g
}

// write queues record rec as one line; rec is a struct of the log* kinds
// below.
func (g *gameLog) write(rec any) {
	if g == nil {
		return
	}
	b, err := json.Marshal(rec)
	if err != nil {
		g.log.Error("game log: unencodable record", "err", err.Error())
		return
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.closed {
		return
	}
	select {
	case g.ch <- append(b, '\n'):
	default:
		g.log.Error("game log: queue full, record dropped")
	}
}

// close writes what is queued and stops the writer; later writes are
// dropped.
func (g *gameLog) close() {
	if g == nil {
		return
	}
	g.mu.Lock()
	if !g.closed {
		g.closed = true
		close(g.ch)
	}
	g.mu.Unlock()
	<-g.done
}

func (g *gameLog) run() {
	defer close(g.done)
	g.prune()
	tick := time.NewTicker(pruneEvery)
	defer tick.Stop()
	var f *os.File
	defer func() {
		if f != nil {
			f.Close()
		}
	}()
	month := ""
	failing := false
	for {
		var line []byte
		select {
		case <-tick.C:
			g.prune()
			continue
		case l, ok := <-g.ch:
			if !ok {
				return
			}
			line = l
		}
		if m := g.now().UTC().Format("2006-01"); m != month || f == nil {
			if f != nil {
				f.Close()
				f = nil
			}
			month = m
			var err error
			if err = os.MkdirAll(g.dir, 0o755); err == nil {
				f, err = os.OpenFile(filepath.Join(g.dir, "games-"+m+".jsonl"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
			}
			if err != nil {
				if !failing {
					g.log.Error("game log: cannot open", "dir", g.dir, "err", err.Error())
				}
				failing = true
				continue
			}
			failing = false
		}
		if _, err := f.Write(line); err != nil && !failing {
			g.log.Error("game log: write failed", "err", err.Error())
			failing = true
		}
	}
}

// prune removes the month files older than the last gameLogMonths months
// (the current one included); other files in dir stay.
func (g *gameLog) prune() {
	now := g.now().UTC()
	oldest := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1-gameLogMonths, 0).Format("2006-01")
	entries, err := os.ReadDir(g.dir)
	if err != nil {
		return // not there yet: nothing to prune
	}
	for _, e := range entries {
		m, ok := strings.CutPrefix(e.Name(), "games-")
		if m, ok = strings.CutSuffix(m, ".jsonl"); !ok || e.IsDir() {
			continue
		}
		if _, err := time.Parse("2006-01", m); err != nil || m >= oldest {
			continue
		}
		if err := os.Remove(filepath.Join(g.dir, e.Name())); err != nil {
			g.log.Error("game log: cannot remove an old month", "file", e.Name(), "err", err.Error())
			continue
		}
		g.log.Info("game log: removed an old month", "file", e.Name())
	}
}

// ---- records (design §6 Game log) ------------------------------------------

// logPlayer is who sits at a seat: a person with name, address and device,
// or a bot by persona and level.
type logPlayer struct {
	Seat   int    `json:"seat"`
	Name   string `json:"name"`
	IP     string `json:"ip,omitempty"`
	Device string `json:"device,omitempty"`
	Bot    string `json:"bot,omitempty"`
	Level  string `json:"level,omitempty"`
}

type logMatch struct {
	T        string      `json:"t"` // "match"
	Match    string      `json:"match"`
	Room     string      `json:"room"`
	At       time.Time   `json:"at"`
	Version  string      `json:"version"` // of the server: the git commit it was built from ("dev" from source)
	Seed     uint64      `json:"seed"`
	Training bool        `json:"training"`
	Expert   bool        `json:"expert,omitempty"`
	Opts     Options     `json:"opts"`
	Players  []logPlayer `json:"players"`
}

// logSeat: a seat changed hands during the match (a joiner, someone back
// on another device, an AI everyone agreed to).
type logSeat struct {
	T      string    `json:"t"` // "seat"
	Match  string    `json:"match"`
	At     time.Time `json:"at"`
	Hand   int       `json:"hand"`
	Player logPlayer `json:"player"`
}

// logHand is a finished hand: the cards dealt per seat (and the talon with
// three players), every decision in order (see actToken) and the result.
type logHand struct {
	T      string          `json:"t"` // "hand"
	Match  string          `json:"match"`
	At     time.Time       `json:"at"`
	Hand   int             `json:"hand"`
	Dealer game.Seat       `json:"dealer"`
	Turned game.Suit       `json:"turned"`
	Cards  []string        `json:"cards"`
	Talon  string          `json:"talon,omitempty"`
	Acts   string          `json:"acts"`
	Result game.HandResult `json:"result"`
}

type logEnd struct {
	T      string    `json:"t"` // "end"
	Match  string    `json:"match"`
	At     time.Time `json:"at"`
	Total  []int     `json:"total"`
	Winner int       `json:"winner"`
}

// logClose: the room went before its match was over.
type logClose struct {
	T      string    `json:"t"` // "close"
	Match  string    `json:"match"`
	At     time.Time `json:"at"`
	Hand   int       `json:"hand"`
	Reason string    `json:"reason"`
}

// logReview is a player's review once every grade is in, without the
// replay (the hand records hold the cards).
type logReview struct {
	T      string       `json:"t"` // "review"
	Match  string       `json:"match"`
	At     time.Time    `json:"at"`
	Seat   int          `json:"seat"`
	Name   string       `json:"name"`
	Review *reviewState `json:"review"`
}

// logMark: the expert's own choice for a decision of seat By (theirs or a
// bot's), given while looking back; a mark without card, suit or play
// clears it.
type logMark struct {
	T      string      `json:"t"` // "mark"
	Match  string      `json:"match"`
	At     time.Time   `json:"at"`
	Seat   int         `json:"seat"`
	Name   string      `json:"name"`
	Hand   int         `json:"hand"`
	Trick  int         `json:"trick"`
	By     int         `json:"by"`
	Mark   choiceJSON  `json:"mark"`
	Played *choiceJSON `json:"played,omitempty"`
}

type logFeedback struct {
	T      string    `json:"t"` // "feedback"
	Match  string    `json:"match"`
	At     time.Time `json:"at"`
	Seat   int       `json:"seat"`
	Name   string    `json:"name"`
	IP     string    `json:"ip"`
	Device string    `json:"device"`
	Hand   int       `json:"hand,omitempty"` // 0: about the game as a whole
	Trick  int       `json:"trick,omitempty"`
	By     *int      `json:"by,omitempty"` // expert: the seat of the decision commented on
	Text   string    `json:"text"`
}

// actToken is one decision of a hand in the "acts" of a hand record: the
// seat, then for a card the card ("2AS"), else a letter and its value:
// b1/b0 spelen or passen (gedraaid), tH a trump suit, a90 a bid in the
// auction (a0: pas), dJS7H the two cards laid away.
func actToken(i game.Seat, a action) string {
	s := string(rune('0' + i))
	switch a.kind {
	case actPlay:
		return s + a.card.String()
	case actBid:
		if a.play {
			return s + "b1"
		}
		return s + "b0"
	case actTrump:
		return s + "t" + a.suit.String()
	case actAuction:
		return s + "a" + strconv.Itoa(a.bid)
	case actDiscard:
		return s + "d" + a.cards[0].String() + a.cards[1].String()
	}
	return s + "?"
}

// cardsString is cards as one compact string: "7SAS9H".
func cardsString(cards []game.Card) string {
	var b strings.Builder
	for _, c := range cards {
		b.WriteString(c.String())
	}
	return b.String()
}

// maxDevice is how much of a browser's User-Agent the log keeps.
const maxDevice = 300

func deviceOf(ua string) string {
	ua = strings.TrimSpace(ua)
	if len(ua) > maxDevice {
		ua = ua[:maxDevice]
	}
	return ua
}
