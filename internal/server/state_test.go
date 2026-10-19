package server

import (
	"encoding/json"
	"math/rand/v2"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

// Keys of `s` (design §7) present in every phase.
var baseKeys = []string{
	"code", "phase", "opts", "training", "you", "host", "players", "handNo", "hands",
	"dealer", "voorhand", "turned", "bids", "forced", "trump", "trumpBy", "playingTeam",
	"turn", "hand", "trick", "lastTrick", "tricksWon", "handPoints", "handRoem", "scores",
	"total", "prevHand", "nextAt", "hint", "hands4", "winner",
}

func keysOf(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("not an object: %s", raw)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func wantKeys(t *testing.T, what string, raw json.RawMessage, want []string) {
	t.Helper()
	w := slices.Clone(want)
	sort.Strings(w)
	if got := keysOf(t, raw); !slices.Equal(got, w) {
		t.Errorf("%s keys:\n got  %v\n want %v", what, got, w)
	}
}

func field(t *testing.T, raw json.RawMessage, key string) json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	json.Unmarshal(raw, &m)
	return m[key]
}

func TestStateKeys(t *testing.T) {
	_, ts, _ := newTestServer(t)
	rng := rand.New(rand.NewPCG(11, 11))
	c := dial(t, ts)
	c.send(map[string]any{"t": "create", "name": "Piet", "opts": map[string]any{"humans": 1, "hands": 4}})
	c.waitType("joined")
	c.waitType("chatlog")
	lobby := c.waitType("update")
	if string(lobby.Ev) != "null" {
		t.Errorf("first update ev %s, want null", lobby.Ev)
	}
	wantKeys(t, "lobby", lobby.S, append(slices.Clone(baseKeys), "roster"))
	wantKeys(t, "opts", field(t, lobby.S, "opts"), []string{"humans", "hands", "trumpMode", "rules", "ai", "tempo", "open"})
	var players []json.RawMessage
	json.Unmarshal(field(t, lobby.S, "players"), &players)
	if len(players) != 4 {
		t.Fatalf("players has %d entries", len(players))
	}
	playerKeys := []string{"name", "bot", "botId", "emoji", "color", "connected", "away", "cards", "ready"}
	for i, p := range players {
		wantKeys(t, "player", p, playerKeys)
		if i > 0 && !strings.Contains(string(p), `"bot":true`) {
			t.Errorf("seat %d is no bot: %s", i, p)
		}
	}
	var roster []json.RawMessage
	json.Unmarshal(field(t, lobby.S, "roster"), &roster)
	wantKeys(t, "roster entry", roster[0], []string{"id", "name", "emoji", "color", "bio"})
	for _, k := range []string{"trick", "lastTrick", "prevHand", "hint", "hands4", "turned", "trump"} {
		if v := string(field(t, lobby.S, k)); v != "null" {
			t.Errorf("lobby %s = %s, want null", k, v)
		}
	}
	if v := string(field(t, lobby.S, "scores")); v != "[]" {
		t.Errorf("lobby scores = %s", v)
	}
	if v := string(field(t, lobby.S, "hand")); v != "[]" {
		t.Errorf("lobby hand = %s", v)
	}

	c.send(map[string]any{"t": "start"})
	seen := map[string]bool{}
	acted := 0
	for !seen["gameOver"] {
		m := c.next(10 * time.Second)
		if m.T != "update" {
			continue
		}
		s := m.state
		mine := c.myTurn()
		key := s.Phase
		if mine {
			key += "/mine"
		}
		switch {
		case s.Phase == phasePlay && mine:
			wantKeys(t, key, m.S, append(slices.Clone(baseKeys), "legal", "rule"))
		default:
			wantKeys(t, key, m.S, baseKeys)
		}
		if !seen[key] {
			seen[key] = true
			checkPhaseValues(t, key, m)
		}
		switch {
		case mine && c.seq > acted:
			acted = c.seq
			c.actRandom(rng)
		case s.Phase == phaseHandEnd && !s.Players[s.You].Ready:
			c.send(map[string]any{"t": "ready"})
		}
	}
	for _, k := range []string{"trump", "play", "play/mine", "handEnd", "gameOver"} {
		if !seen[k] {
			t.Errorf("never saw a state in %s", k)
		}
	}
}

func checkPhaseValues(t *testing.T, key string, m *msg) {
	t.Helper()
	s := m.state
	switch s.Phase {
	case phaseTrump, phasePlay:
		if s.Trick == nil || s.Dealer < 0 || s.Voorhand != (s.Dealer+1)%4 {
			t.Errorf("%s: trick %v dealer %d voorhand %d", key, s.Trick, s.Dealer, s.Voorhand)
		}
		wantKeys(t, key+" trick", field(t, m.S, "trick"), []string{"leader", "cards", "winner", "points", "roem"})
	case phaseHandEnd:
		if s.NextAt <= time.Now().Add(-time.Minute).UnixMilli() || s.PrevHand == nil || s.Turn != -1 {
			t.Errorf("handEnd: nextAt %d prevHand %v turn %d", s.NextAt, s.PrevHand != nil, s.Turn)
		}
		wantKeys(t, "prevHand", field(t, m.S, "prevHand"), []string{"tricks", "result"})
		wantKeys(t, "result", field(t, field(t, m.S, "prevHand"), "result"),
			[]string{"playingTeam", "trumpBy", "trump", "dealer", "points", "roem", "score", "nat", "pit", "pitTeam"})
		var rows []json.RawMessage
		json.Unmarshal(field(t, m.S, "scores"), &rows)
		wantKeys(t, "score row", rows[0], []string{"hand", "dealer", "trump", "trumpBy", "playingTeam", "points", "roem", "score", "nat", "pit"})
		if s.Trick != nil || len(s.Hand) != 0 {
			t.Errorf("handEnd: trick %v hand %v", s.Trick, s.Hand)
		}
	case phaseGameOver:
		if s.NextAt != 0 || s.Turn != -1 {
			t.Errorf("gameOver: nextAt %d turn %d", s.NextAt, s.Turn)
		}
		var ev map[string]json.RawMessage
		json.Unmarshal(m.Ev, &ev)
		if len(ev) != 3 || ev["total"] == nil || ev["winner"] == nil {
			t.Errorf("gameOver event %s", m.Ev)
		}
	}
	if strings.HasSuffix(key, "/mine") && s.Phase == phasePlay {
		if s.Rule == "" || len(s.Legal) == 0 {
			t.Errorf("%s: rule %q legal %v", key, s.Rule, s.Legal)
		}
	}
}

// TestEventShapes checks the fields of each event kind.
func TestEventShapes(t *testing.T) {
	_, ts, _ := newTestServer(t)
	rng := rand.New(rand.NewPCG(13, 13))
	c := dial(t, ts)
	c.create("Piet", map[string]any{"humans": 1, "hands": 4, "trumpMode": "gedraaid"}, false, true)
	want := map[string][]string{
		"deal":     {"type", "handNo", "dealer"},
		"turned":   {"type", "suit"},
		"bid":      {"type", "seat", "play"},
		"trump":    {"type", "seat", "suit", "forced"},
		"play":     {"type", "seat", "card"},
		"trick":    {"type", "winner", "points", "roem", "last"},
		"collect":  {"type", "winner"},
		"handEnd":  {"type", "result"},
		"gameOver": {"type", "total", "winner"},
	}
	seen := map[string]bool{}
	acted, readied := 0, 0
	for !seen["gameOver"] {
		m := c.next(10 * time.Second)
		if m.T != "update" {
			continue
		}
		if e := m.evType(); e != "" {
			keys, ok := want[e]
			if !ok {
				t.Fatalf("unexpected event %s", m.Ev)
			}
			wantKeys(t, "event "+e, m.Ev, keys)
			if e == "trick" && !strings.Contains(string(m.Ev), `"roem":[`) {
				t.Errorf("trick roem is not a list: %s", m.Ev)
			}
			seen[e] = true
		}
		switch {
		case c.myTurn() && c.seq > acted:
			acted = c.seq
			c.actRandom(rng)
		case m.state.Phase == phaseHandEnd && readied < m.state.HandNo:
			readied = m.state.HandNo
			c.send(map[string]any{"t": "ready"})
		}
	}
	for e := range want {
		if !seen[e] {
			t.Errorf("never saw event %s", e)
		}
	}
}
