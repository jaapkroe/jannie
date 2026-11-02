package serve

import (
	"fmt"
	"html"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// joinLink is a game link, /ABCD: it serves index.html, like nginx.
var joinLink = regexp.MustCompile(`^/[A-Za-z]{4}$`)

// csp mirrors deploy/nginx.conf, so CSP mistakes show up in development.
const csp = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
	"script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
	"object-src 'none'; form-action 'none'"

// notFoundPage is the site's 404 page, as nginx serves it.
func notFoundPage(site Site) string {
	return `<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Niet gevonden - ` +
		html.EscapeString(site.Title) + `</title><h1>Deze pagina bestaat niet</h1><p>Zoek je een spel? Een spelcode heeft vier letters, zoals /KQXB.</p><p><a href="/">Terug naar ` +
		html.EscapeString(site.Verb) + `</a></p></html>` + "\n"
}

// StaticHandler serves the frontend of site for development from the web
// directory dir: the union of dir/shared (the shell every game shares) and
// dir/<game>, as the image's web stage puts them together. A path in both
// is an error, as are missing directories. No directory listings; / and
// join links serve <game>/index.html; nothing is cached, so edits show at
// once; the CSP is nginx's.
func StaticHandler(dir string, site Site) (http.Handler, error) {
	shared, own := filepath.Join(dir, "shared"), filepath.Join(dir, site.Game)
	for _, d := range []string{shared, own} {
		if info, err := os.Stat(d); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("-static %s: no directory %s", dir, d)
		}
	}
	if both, err := clashes(shared, own); err != nil {
		return nil, err
	} else if len(both) > 0 {
		return nil, fmt.Errorf("-static %s: in both shared/ and %s/: %s", dir, site.Game, strings.Join(both, ", "))
	}
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
	roots := []http.Dir{http.Dir(own), http.Dir(shared)}
	page := notFoundPage(site)
	notFound := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, page)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cache-Control", "no-cache")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			h.Set("Allow", "GET, HEAD")
			http.Error(w, "Methode niet toegestaan", http.StatusMethodNotAllowed)
			return
		}
		name := path.Clean("/" + r.URL.Path)
		if name == "/" || joinLink.MatchString(name) {
			name = "/index.html"
		}
		for _, root := range roots {
			f, err := root.Open(name)
			if err != nil {
				continue
			}
			info, err := f.Stat()
			if err != nil || info.IsDir() {
				f.Close()
				continue
			}
			defer f.Close()
			http.ServeContent(w, r, info.Name(), info.ModTime(), f)
			return
		}
		notFound(w)
	}), nil
}

// clashes lists the paths of a file in one of the trees a and b that the
// other has too, sorted.
func clashes(a, b string) ([]string, error) {
	var both []string
	for _, pair := range [][2]string{{a, b}, {b, a}} {
		err := filepath.WalkDir(pair[0], func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, err := filepath.Rel(pair[0], p)
			if err != nil {
				return err
			}
			if _, err := os.Lstat(filepath.Join(pair[1], rel)); err == nil {
				both = append(both, filepath.ToSlash(rel))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(both)
	return slices.Compact(both), nil
}
