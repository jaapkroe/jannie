package serve

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

var (
	klaverjas = Site{Game: "klaverjas", Title: "Klaverjas", Verb: "klaverjassen"}
	toepen    = Site{Game: "toepen", Title: "Toepen", Verb: "toepen"}
)

// webDir writes files (path → content) into a fresh repository directory.
func webDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// web is the layout of the frontend: the shell in platform/web, each game
// in games/<game>/web.
var web = map[string]string{
	"platform/web/js/main.js":                  "export {main};",
	"platform/web/css/app.css":                 "body{}",
	"games/klaverjas/web/index.html":           "<!doctype html>klaverjas",
	"games/klaverjas/web/manifest.webmanifest": "{}",
	"games/klaverjas/web/js/game.js":           "export {klaverjas};",
	"games/toepen/web/index.html":              "<!doctype html>toepen",
	"games/toepen/web/js/game.js":              "export {toepen};",
}

// klaverjas404 is the 404 page of klaverjas.kroes.dev as it was.
const klaverjas404 = `<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Niet gevonden - Klaverjas</title><h1>Deze pagina bestaat niet</h1><p>Zoek je een spel? Een spelcode heeft vier letters, zoals /KQXB.</p><p><a href="/">Terug naar klaverjassen</a></p></html>` + "\n"

func TestStaticHandler(t *testing.T) {
	dir := webDir(t, web)
	h, err := StaticHandler(dir, klaverjas)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		status       int
		body, ctype  string
	}{
		{"GET", "/", 200, "klaverjas", "text/html"},
		{"GET", "/KQXB", 200, "klaverjas", "text/html"},
		{"GET", "/kqxb", 200, "klaverjas", "text/html"},
		{"GET", "/index.html", 200, "klaverjas", "text/html"},
		{"GET", "/js/game.js", 200, "export {klaverjas}", "text/javascript"},
		{"GET", "/js/main.js", 200, "export {main}", "text/javascript"},
		{"GET", "/css/app.css", 200, "body{}", "text/css"},
		{"GET", "/manifest.webmanifest", 200, "{}", "application/manifest+json"},
		{"HEAD", "/", 200, "", "text/html"},
		{"GET", "/ABCDE", 404, klaverjas404, "text/html"},
		{"GET", "/AB1D", 404, klaverjas404, "text/html"},
		{"GET", "/js/", 404, klaverjas404, "text/html"},
		{"GET", "/js", 404, klaverjas404, "text/html"},
		{"GET", "/platform/web/js/main.js", 404, klaverjas404, "text/html"},
		{"GET", "/games/toepen/web/index.html", 404, klaverjas404, "text/html"},
		{"GET", "/../games/toepen/web/index.html", 404, klaverjas404, "text/html"},
		{"GET", "/../platform/web/js/main.js", 404, klaverjas404, "text/html"}, // cleaned: /platform/web/js/main.js, not in the union
		{"POST", "/", 405, "", ""},
	} {
		req := httptest.NewRequest(tc.method, "http://x"+tc.path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		res := rec.Result()
		if res.StatusCode != tc.status {
			t.Errorf("%s %s: status %d, want %d", tc.method, tc.path, res.StatusCode, tc.status)
		}
		if body := rec.Body.String(); !strings.Contains(body, tc.body) || tc.body == klaverjas404 && body != klaverjas404 {
			t.Errorf("%s %s: body %q, want %q in it", tc.method, tc.path, body, tc.body)
		}
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, tc.ctype) {
			t.Errorf("%s %s: content type %q, want %q", tc.method, tc.path, ct, tc.ctype)
		}
		if res.Header.Get("Cache-Control") != "no-cache" || res.Header.Get("Content-Security-Policy") != csp ||
			res.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s %s: headers %v", tc.method, tc.path, res.Header)
		}
	}
}

// Each game's site serves its own directory with the shell, and its own
// 404 page.
func TestStaticHandlerToepen(t *testing.T) {
	h, err := StaticHandler(webDir(t, web), toepen)
	if err != nil {
		t.Fatal(err)
	}
	get := func(p string) (int, string) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x"+p, nil))
		return rec.Code, rec.Body.String()
	}
	if code, body := get("/QXBK"); code != 200 || body != "<!doctype html>toepen" {
		t.Errorf("join link: %d %q", code, body)
	}
	if code, body := get("/js/game.js"); code != 200 || body != "export {toepen};" {
		t.Errorf("game.js: %d %q", code, body)
	}
	if code, body := get("/js/main.js"); code != 200 || body != "export {main};" {
		t.Errorf("main.js: %d %q", code, body)
	}
	code, body := get("/manifest.webmanifest") // klaverjas's
	if code != 404 || !strings.Contains(body, "<title>Niet gevonden - Toepen</title>") ||
		!strings.Contains(body, `<a href="/">Terug naar toepen</a>`) || strings.Contains(body, "laverjas") {
		t.Errorf("404: %d %q", code, body)
	}
}

// A path in both platform/web and the game's web directory, or a missing
// one, is an error at start-up.
func TestStaticHandlerErrors(t *testing.T) {
	clash := map[string]string{"games/klaverjas/web/js/main.js": "x", "games/klaverjas/web/css": "a file where shared has a directory"}
	for k, v := range web {
		clash[k] = v
	}
	_, err := StaticHandler(webDir(t, clash), klaverjas)
	if err == nil || !strings.Contains(err.Error(), "css, js/main.js") {
		t.Errorf("clash: %v", err)
	}
	if _, err := StaticHandler(webDir(t, clash), toepen); err != nil {
		t.Errorf("toepen has no clash: %v", err)
	}
	if _, err := StaticHandler(webDir(t, web), Site{Game: "pesten"}); err == nil || !strings.Contains(err.Error(), "pesten") {
		t.Errorf("no pesten: %v", err)
	}
	if _, err := StaticHandler(webDir(t, map[string]string{"games/klaverjas/web/index.html": "x"}), klaverjas); err == nil || !strings.Contains(err.Error(), "platform/web") {
		t.Errorf("no platform/web: %v", err)
	}
}

func TestParse(t *testing.T) {
	f, err := Parse("toepen", []string{"-addr", "127.0.0.1:9", "-static", ".", "-fast", "-games", "/data",
		"-origin", "a.kroes.dev", "-origin", "*.kroes.dev"})
	if err != nil || f.Addr != "127.0.0.1:9" || f.Static != "." || !f.Fast || f.Games != "/data" || f.Healthcheck ||
		!slices.Equal(f.Origins, []string{"a.kroes.dev", "*.kroes.dev"}) {
		t.Errorf("flags %+v, %v", f, err)
	}
	if f, err := Parse("klaverjas", []string{"-healthcheck"}); err != nil || f.Addr != "127.0.0.1:8081" || !f.Healthcheck {
		t.Errorf("defaults %+v, %v", f, err)
	}
	if _, err := Parse("klaverjas", []string{"-nope"}); err == nil {
		t.Error("unknown flag accepted")
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
	if code := Healthcheck(serve(200, `{"ok":true,"version":"x","rooms":0,"players":0}`)); code != 0 {
		t.Errorf("healthy server: exit %d", code)
	}
	if code := Healthcheck(serve(200, `{"ok":false}`)); code != 1 {
		t.Errorf("ok false: exit %d", code)
	}
	if code := Healthcheck(serve(503, `{"ok":true}`)); code != 1 {
		t.Errorf("status 503: exit %d", code)
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	if code := Healthcheck(addr); code != 1 {
		t.Errorf("nothing listening: exit %d", code)
	}
	if code := Healthcheck("geen-adres"); code != 1 {
		t.Errorf("bad address: exit %d", code)
	}
}
