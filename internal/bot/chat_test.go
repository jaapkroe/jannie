package bot

import (
	"math/rand/v2"
	"strings"
	"testing"
	"unicode/utf8"
)

var eventKinds = []string{"greet", "trump", "pass", "play", "wonTrick", "roem", "nat", "natOpp", "pit",
	"handWon", "handLost", "gameWon", "gameLost", "partnerGood"}

var replyKindNames = []string{"hello", "praise", "gg", "laugh", "help", "nat", "pech", "sorry", "thanks", "bye", "name"}

func TestVoicesComplete(t *testing.T) {
	for _, p := range roster {
		v, ok := voices[p.ID]
		if !ok {
			t.Fatalf("no voice for %s", p.ID)
		}
		for _, k := range append(eventKinds, "wonTrick/opp", "roem/opp", "pit/opp", "trump/opp") {
			if n := len(v.lines[k]); n < 4 {
				t.Errorf("%s has %d lines for %q, want at least 4", p.ID, n, k)
			}
		}
		for _, k := range replyKindNames {
			if n := len(v.replies[k]); n < 3 {
				t.Errorf("%s has %d replies for %q, want at least 3", p.ID, n, k)
			}
		}
		for k, lines := range v.lines {
			if !strings.Contains(k, "/") && !contains(eventKinds, k) {
				t.Errorf("%s: unknown event kind %q", p.ID, k)
			}
			plain := 0
			for _, l := range lines {
				checkLine(t, p.ID, l)
				if !strings.Contains(l, "{p}") {
					plain++
				}
			}
			if plain == 0 {
				t.Errorf("%s %q: every line needs points", p.ID, k)
			}
		}
		for _, lines := range v.replies {
			for _, l := range lines {
				checkLine(t, p.ID, l)
			}
		}
	}
}

// checkLine: tidy, short, and never about specific cards.
func checkLine(t *testing.T, id, l string) {
	t.Helper()
	if l == "" || strings.TrimSpace(l) != l || utf8.RuneCountInString(l) > 110 {
		t.Errorf("%s: badly formed line %q", id, l)
	}
	low := strings.ToLower(l)
	for _, bad := range []string{"♠", "♥", "♦", "♣", "harten", "ruiten", "klaveren", "schoppen", "ik heb de boer", "ik heb de nel", "ik heb de aas", "ik heb troef", "mijn boer", "mijn nel", "mijn aas", "mijn troeven"} {
		if strings.Contains(low, bad) {
			t.Errorf("%s: line %q mentions cards (%q)", id, l, bad)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestChatEvents(t *testing.T) {
	rng := rand.New(rand.NewPCG(61, 62))
	for _, p := range roster {
		chatty := p
		chatty.Chattiness = 1
		for _, k := range eventKinds {
			for _, mine := range []bool{true, false} {
				seen := map[string]bool{}
				for range 200 {
					line := Chat(chatty, ChatEvent{Kind: k, Mine: mine, Points: 20}, rng)
					if strings.Contains(line, "{p}") {
						t.Fatalf("%s: placeholder left in %q", p.ID, line)
					}
					if line != "" {
						seen[line] = true
					}
				}
				if len(seen) < 3 {
					t.Errorf("%s %s: only %d different lines", p.ID, k, len(seen))
				}
			}
			for range 30 {
				if line := Chat(chatty, ChatEvent{Kind: k, Mine: true}, rng); strings.Contains(line, "{p}") {
					t.Fatalf("%s %s without points: %q", p.ID, k, line)
				}
			}
		}
		// Mine selects the side: our roem is celebrated, theirs is not.
		if v := voices[p.ID]; contains(v.lines["roem"], Chat(chatty, ChatEvent{Kind: "roem"}, rng)) {
			t.Errorf("%s used its own roem line for the opponents' roem", p.ID)
		}
	}
	if Chat(Persona{ID: "henk"}, ChatEvent{Kind: "pit", Mine: true}, rng) != "" {
		t.Error("a persona without chattiness spoke")
	}
	if Chat(roster[0], ChatEvent{Kind: "greet"}, nil) != "" {
		t.Error("spoke without a random source")
	}
	if Chat(Persona{ID: "custom", Name: "Klaas", Chattiness: 1}, ChatEvent{Kind: "greet"}, rng) == "" {
		t.Error("unknown persona has no generic voice")
	}
}

func TestChatChattiness(t *testing.T) {
	rng := rand.New(rand.NewPCG(63, 64))
	rate := func(p Persona, kind string) float64 {
		n := 0
		for range 2000 {
			if Chat(p, ChatEvent{Kind: kind, Mine: true, Points: 20}, rng) != "" {
				n++
			}
		}
		return float64(n) / 2000
	}
	truus, _ := ByID("truus")
	fatima, _ := ByID("fatima")
	if a, b := rate(truus, "handWon"), rate(fatima, "handWon"); a <= b+0.2 {
		t.Errorf("Tante Truus (%.2f) should talk much more than Fatima (%.2f)", a, b)
	}
	if r := rate(truus, "roem"); r < 0.99 {
		t.Errorf("Tante Truus comments on roem only %.2f of the time", r)
	}
	if r := rate(fatima, "play"); r > 0.15 {
		t.Errorf("Fatima comments on %.2f of her plays", r)
	}
}

func TestPersonaStyle(t *testing.T) {
	for _, l := range allLines("bram") {
		emoji := false
		for _, r := range l {
			if r >= 0x2190 {
				emoji = true
			}
		}
		if !emoji && l != ":)" {
			t.Errorf("Bram line without emoji: %q", l)
		}
	}
	total, n := 0, 0
	for _, l := range allLines("fatima") {
		total += utf8.RuneCountInString(l)
		n++
	}
	if avg := float64(total) / float64(n); avg > 24 {
		t.Errorf("Fatima talks too much: %.1f characters per line", avg)
	}
	digits := 0
	for _, l := range allLines("fatima") {
		if strings.ContainsAny(l, "0123456789") {
			digits++
		}
	}
	if digits < 10 {
		t.Errorf("Fatima uses numbers in only %d lines", digits)
	}
}

func allLines(id string) []string {
	var out []string
	for _, lines := range voices[id].lines {
		out = append(out, lines...)
	}
	for _, lines := range voices[id].replies {
		out = append(out, lines...)
	}
	return out
}

func TestClassifyReply(t *testing.T) {
	cases := map[string]string{
		"Hoi allemaal!": "hello",
		"goedenavond":   "hello", "Hoi, hoe gaat het?": "hello",

		"Goed gespeeld!":          "praise",
		"mooi zo":                 "praise",
		"gg":                      "gg",
		"GG WP":                   "gg",
		"hahaha":                  "laugh",
		"lol":                     "laugh",
		"😂😂":                      "laugh",
		"hoe werkt roem?":         "help",
		"help":                    "help",
		"NAT!":                    "nat",
		"pech":                    "pech",
		"jammer joh":              "pech",
		"sorry maat":              "sorry",
		"bedankt":                 "thanks",
		"doei":                    "bye",
		"natuurlijk":              "",
		"de kat krabt de krullen": "",
		"":                        "",
	}
	for text, want := range cases {
		if got := classifyReply(text); got != want {
			t.Errorf("classifyReply(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestChatReplies(t *testing.T) {
	rng := rand.New(rand.NewPCG(65, 66))
	for _, p := range roster {
		answered := 0
		for range 200 {
			if Chat(p, ChatEvent{Kind: "reply", Text: "hoi allemaal"}, rng) != "" {
				answered++
			}
		}
		if answered < 20 || answered > 199 {
			t.Errorf("%s answered hoi %d of 200 times", p.ID, answered)
		}
		for range 50 {
			if line := Chat(p, ChatEvent{Kind: "reply", Text: "de kat krabt de krullen"}, rng); line != "" {
				t.Fatalf("%s replied %q to an unrelated line", p.ID, line)
			}
		}
	}
	fatima, _ := ByID("fatima")
	henk, _ := ByID("henk")
	named := 0
	for range 100 {
		if line := Chat(fatima, ChatEvent{Kind: "reply", Text: "Fatima, wat denk jij?"}, rng); line != "" {
			named++
			if !contains(voices["fatima"].replies["name"], line) {
				t.Fatalf("unexpected reply %q", line)
			}
		}
		if line := Chat(henk, ChatEvent{Kind: "reply", Text: "Fatima, wat denk jij?"}, rng); line != "" {
			t.Fatalf("Henk answered a question for Fatima: %q", line)
		}
	}
	if named < 80 {
		t.Errorf("Fatima answered being named only %d of 100 times", named)
	}
	if !mentions(henk, "opa henk, help!") || mentions(henk, "henkie") {
		t.Error("mentions does not match whole names")
	}
}
