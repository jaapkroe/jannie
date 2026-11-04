// Command klaverjas is the klaverjas game server: websocket rooms at /ws
// and a health check at /api/health. In production nginx serves the
// frontend; with -static WEB it serves WEB/shared and WEB/klaverjas itself
// (development). The flags are package serve's.
package main

import (
	"jannie/platform/serve"
	"jannie/platform/server"
)

// version is set at build time: -ldflags "-X main.version=<git sha>".
var version = "dev"

func main() {
	serve.Main(serve.Site{Game: "klaverjas", Title: "Klaverjas", Verb: "klaverjassen"}, version, server.Klaverjas(botAI{}))
}
