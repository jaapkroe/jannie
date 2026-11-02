// Command toepen is the toepen game server: websocket rooms at /ws and a
// health check at /api/health. In production nginx serves the frontend;
// with -static WEB it serves WEB/shared and WEB/toepen itself
// (development). The flags are package serve's.
package main

import (
	"klaverjas/internal/serve"
	"klaverjas/internal/toepenserver"
)

// version is set at build time: -ldflags "-X main.version=<git sha>".
var version = "dev"

func main() {
	serve.Main(serve.Site{Game: "toepen", Title: "Toepen", Verb: "toepen"}, version, toepenserver.New(toepAI{}))
}
