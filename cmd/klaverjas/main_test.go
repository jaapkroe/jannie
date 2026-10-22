package main

import (
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"klaverjas/internal/game"
	"klaverjas/internal/server"
)

func TestStaticHandler(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "js"), 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>start"), 0o644)
	os.WriteFile(filepath.Join(dir, "js", "app.js"), []byte("export {};"), 0o644)
	os.WriteFile(filepath.Join(dir, "manifest.webmanifest"), []byte("{}"), 0o644)
	h := staticHandler(dir)

	for _, tc := range []struct {
		method, path string
		status       int
		body, ctype  string
	}{
		{"GET", "/", 200, "start", "text/html"},
		{"GET", "/KQXB", 200, "start", "text/html"},
		{"GET", "/kqxb", 200, "start", "text/html"},
		{"GET", "/js/app.js", 200, "export", "text/javascript"},
		{"GET", "/manifest.webmanifest", 200, "{}", "application/manifest+json"},
		{"HEAD", "/", 200, "", "text/html"},
		{"GET", "/ABCDE", 404, "Deze pagina bestaat niet", "text/html"},
		{"GET", "/AB1D", 404, "Deze pagina bestaat niet", "text/html"},
		{"GET", "/js/", 404, "Deze pagina bestaat niet", "text/html"},
		{"GET", "/js", 404, "Deze pagina bestaat niet", "text/html"},
		{"GET", "/../main.go", 404, "", "text/html"},
		{"POST", "/", 405, "", ""},
	} {
		req := httptest.NewRequest(tc.method, "http://x"+tc.path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		res := rec.Result()
		if res.StatusCode != tc.status {
			t.Errorf("%s %s: status %d, want %d", tc.method, tc.path, res.StatusCode, tc.status)
		}
		if !strings.Contains(rec.Body.String(), tc.body) {
			t.Errorf("%s %s: body %q, want %q in it", tc.method, tc.path, rec.Body.String(), tc.body)
		}
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, tc.ctype) {
			t.Errorf("%s %s: content type %q, want %q", tc.method, tc.path, ct, tc.ctype)
		}
		if res.Header.Get("Cache-Control") != "no-cache" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "script-src 'self'") {
			t.Errorf("%s %s: headers %v", tc.method, tc.path, res.Header)
		}
	}
}

func TestHealthcheck(t *testing.T) {
	serve := func(status int, body string) string {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/health" {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(status)
			w.Write([]byte(body))
		}))
		t.Cleanup(ts.Close)
		return strings.TrimPrefix(ts.URL, "http://")
	}
	if code := healthcheck(serve(200, `{"ok":true,"version":"x","rooms":0,"players":0}`)); code != 0 {
		t.Errorf("healthy server: exit %d", code)
	}
	if code := healthcheck(serve(200, `{"ok":false}`)); code != 1 {
		t.Errorf("ok false: exit %d", code)
	}
	if code := healthcheck(serve(503, `{"ok":true}`)); code != 1 {
		t.Errorf("status 503: exit %d", code)
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	if code := healthcheck(addr); code != 1 {
		t.Errorf("nothing listening: exit %d", code)
	}
	if code := healthcheck("geen-adres"); code != 1 {
		t.Errorf("bad address: exit %d", code)
	}
}

// TestBotAI plays deals with the real bots through the adapter.
func TestBotAI(t *testing.T) {
	var ai server.AI = botAI{}
	personas := ai.Personas()
	if len(personas) != 8 || !slices.ContainsFunc(personas, func(p server.Persona) bool { return p.ID == "ans" }) {
		t.Fatalf("personas %+v", personas)
	}
	for _, p := range personas {
		if p.Name == "" || p.Emoji == "" || p.Color == "" || p.Bio == "" || p.Speed <= 0 || strings.HasSuffix(p.Name, "(AI)") {
			t.Errorf("persona %+v", p)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for k, level := range []string{"makkelijk", "normaal", "sterk", ""} {
		id := ""
		if level != "" {
			id = personas[k].ID
		}
		var brains [4]server.Brain
		for i := range brains {
			brains[i] = ai.NewBrain(id, level, uint64(k*4+i))
		}
		mode := game.TrumpMode(k % 2)
		d := game.NewDeal(game.Seat(k%4), game.Shuffle(rng), mode, game.Rules(k/2%2), game.Suit(k))
		if l := ai.HandLuck(d.View(0)); l == 0 || math.Abs(l) > 200 {
			t.Errorf("hand luck %v", l)
		}
		for d.Phase() != game.PhaseDone {
			s := d.Turn()
			v := d.View(s)
			var err error
			switch d.Phase() {
			case game.PhaseTrump:
				if a := ai.Advise(v); a.Suit == nil || a.Text == "" {
					t.Errorf("trump advice %+v", a)
				}
				err = d.ChooseTrump(s, brains[s].ChooseTrump(v))
			case game.PhaseBid:
				err = d.Bid(s, brains[s].Bid(v))
			case game.PhasePlay:
				a := ai.Advise(v)
				if a.Card == nil || !slices.Contains(v.Legal, *a.Card) {
					t.Errorf("play advice %+v for legal %v", a, v.Legal)
				}
				c := brains[s].Play(v)
				if g := ai.Grade(v, server.Choice{Card: &c}); g.Lost > 0 && (g.Better.Card == nil || *g.Better.Card != *a.Card || g.Text != a.Text) {
					t.Errorf("grade %+v of %v, advice %+v", g, c, a)
				}
				err = d.Play(s, c)
				if tr := d.Current(); tr.Complete() {
					if text := ai.ExplainTrick(tr, v.Trump, [4]string{"Jij", "Opa Dirk (AI)", "Juf Ans (AI)", "Bram (AI)"}); text == "" {
						t.Errorf("no explanation for trick %+v", tr)
					}
				}
			}
			if err != nil {
				t.Fatalf("level %q: %v", level, err)
			}
		}
	}
	if line := ai.Chat("bestaat-niet", server.ChatEvent{Kind: "greet"}, rng); line != "" {
		t.Errorf("unknown persona chats: %q", line)
	}
	said := false
	for range 50 {
		said = said || ai.Chat("truus", server.ChatEvent{Kind: "greet"}, rng) != ""
	}
	if !said {
		t.Error("Tante Truus never greets")
	}
}
