// Command toepen is the toepen game server: websocket rooms at /ws, the
// score sheets of games at a real table at /api/score (a websocket too)
// and a health check at /api/health. In production nginx serves the
// frontend; with -static WEB it serves WEB/shared and WEB/toepen itself
// (development). The flags are package serve's; the score sheets are kept
// in the game log's directory (-games), under scores/.
package main

import (
	"log/slog"
	"path/filepath"

	"jannie/games/toepen/scoresheet"
	"jannie/games/toepen/toepenserver"
	"jannie/platform/serve"
)

// version is set at build time: -ldflags "-X main.version=<git sha>".
var version = "dev"

func main() {
	serve.Main(serve.Site{Game: "toepen", Title: "Toepen", Verb: "toepen", Extras: scores}, version, toepenserver.New(toepAI{}))
}

// scores is the score sheets' service, kept next to the game log.
func scores(log *slog.Logger, f serve.Flags) []serve.Extra {
	dir := ""
	if f.Games != "" {
		dir = filepath.Join(f.Games, "scores")
	}
	s := scoresheet.New(scoresheet.Config{Dir: dir, Origins: f.Origins, Logger: log})
	return []serve.Extra{{Path: "/api/score", Handler: s.Handler(), Shutdown: s.Shutdown}}
}
