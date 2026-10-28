# Klaverjas

Klaverjassen in the browser: the Dutch trick-taking card game for four players
in two pairs, or for three or two, with friends, with bots, or both. The
interface is entirely in Dutch. It runs at <https://klaverjas.kroes.dev>.

## Features

- **Start in one tap.** *Snel spelen* starts a game against bots at once,
  without even asking for a name (as does *Oefenen*). A hosted game gets a
  four-letter code and a link (`/ABCD`); friends join by typing the code or
  opening the link, and only need to give a name.
- **The rules as played in Dutch cafés**: Utrechts (voorhand chooses trump) or
  gedraaid (a turned suit to play or pass), with Amsterdams or Rotterdams
  trumping; roem on the table, nat and pit, scored over a *boom* of 16 hands
  or another length. Illegal cards cannot be played, and the game says why.
- **Two, three or four players** (*Spelers*): with three, everyone for
  themselves: ten cards each, an auction on points, and the highest bidder
  takes the two cards on the table, lays two away and plays alone against
  the other two; with two, each plays from eight piles of two cards on the
  table, the top ones face up for both to see. Seats nobody takes get bots.
- **Eight bots with a character of their own**, from Opa Dirk to Bakker Vera,
  shown as "Naam (AI)", at three strengths. The strongest counts cards, infers
  voids and gives and reads signals. They fill empty seats and chat in
  character.
- **No AI plays a seat unasked.** When a player loses the connection or
  leaves, the game waits for them; an AI stands in only when everyone else at
  the table agrees, and a friend with the code can take a seat that was left.
- **Easy to follow**: cards fly to the table, the winning card lights up, tricks
  slide to their winner, roem and trump get a banner, and short pauses let
  every move register. Sound effects are synthesised in the browser.
- **Score sheet, last trick and the whole previous hand** to look back on;
  chat with quick reactions.
- **Calling the table**: a game with friends starts with the question
  whether to call along, with sound and, if you like, video, which then
  takes the place of your face at your seat. Microphone and camera switch
  with one tap during the game and are remembered for the next one. Sound
  and video go from browser to browser (WebRTC), not through the server.
- **Spelanalyse** at the end of a game of four, for each player alone: a
  percentage for their own choices, judged by the strongest bot from what
  they knew at the time, how good their cards were, and the moves that
  gained or left the most points, each with its trick.
- **Expert mode**, behind an easter egg (five taps on the version under the
  home screen): replay a game, or one hand of it, from its seed (the chat
  names it at the start of every game), step through every card of every
  hand while it is played and after, ask the engine's reasoning for any
  seat's decision (the rule, the hint and the value of every option), and
  give your own choice and a comment, kept in the game log to improve the
  bots.
- **Handleiding**: the controls, the rules (also for two and three players),
  card values, roem, signals (*seinen*, also called *voorkaarten*), tips, how
  the game engine Juf Jannie plays and how strong it is, and a glossary.
- **Oefenen**: a training game with Juf Jannie as partner, hints on every turn,
  an explanation after every trick (also in the chat, to read back), and
  optionally all cards face up. With *Speluitleg* she teaches the game step by
  step, with two hands to practise each new lesson: the table and the
  screen, trump, which cards may be played and the score in the first hand,
  the card points from the third, counting the trumps in the fifth (with a
  counter), roem from the seventh and the table's signals from the ninth
  (until then nobody signals), pointed out the first few times; the game
  waits for each step. After twelve hands the last four of a match are
  played without tips.
- Built for phones (touch, portrait and landscape), tablets and desktop
  browsers (mouse and keyboard).

## Playing it locally

The host needs only podman and make: the Go toolchain runs in a container
(`scripts/go`).

```sh
make dev     # the server from source, serving web/, on http://127.0.0.1:18093/
```

The first start compiles for a minute; Ctrl-C stops it. Other players on your
network cannot join this one, because it listens on loopback.

## Tests

```sh
make test       # go vet, the Go tests (-short), the JS unit tests and the deployment files
make test-all   # also the bot arena: sterk must beat normaal must beat makkelijk
make e2e        # full games over the websocket against the server from source
scripts/go test -run '^$' -bench . ./internal/bot ./internal/game   # CPU per bot decision and per hand
```

The server's own cost per match, and what a connection receives, are
measured by `scripts/go test -run '^$' -bench . ./internal/server` and
`scripts/go test -run PerfWire -v ./internal/server -args -perf.wire`
(`docs/design.md` §4.3).

Browser checks with Puppeteer live in `test/ui` and run against a server
(`scripts/dev-server PORT`) and a headless Chromium (`scripts/chrome PORT`):

```sh
cd test/ui
node app-play.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303     # full games by tapping, reload, rematch
node app-play.mjs ... --gedraaid | --multi | --training                          # bidding, two players with chat, hints
node app-play.mjs ... --players 3 | --players 2                                  # the auction and laying away; the piles
node app-screens.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303  # every screen at six sizes, into test/ui/out/
node app-checks.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303   # 32 behaviour checks (coach, lessons, taps, back button, lost socket, chat during animations, full table, takeover vote, summary on a phone, card corners, expert mode, a call…); needs -fast, ~15 min
node og-image.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303     # renders web/og.png, the link preview image
node app-perf.mjs --url http://127.0.0.1:18300 --cdp http://127.0.0.1:9303     # main-thread work per second and chat keystroke times on two emulated phones
```

`make test` also runs the JS unit tests in `test/*.test.mjs` and
`test/ui/*.test.mjs` (the manual against the rules, sounds, cards,
`app-util.test.mjs` for the storage fallback and text helpers, and
`app-icons.test.mjs` for the home-screen icons and the link preview), and
`scripts/deploy-test`, which puts the units through podman's quadlet generator
and checks how `make deploy` labels, tags and refuses builds, with stubs in
place of podman and systemd.

## How it is built

- `internal/game`: the rules engine, pure and exhaustively tested: legal moves
  for both rule sets, tricks, roem, scoring and the state machine of one hand.
- `internal/bot`: the personalities, the three playing strengths (the strongest
  uses determinised Monte Carlo playouts), the training hints and chat.
- `internal/server`: rooms with codes, the websocket protocol, pacing, chat and
  limits. Each room is one goroutine; all state is in memory.
- `cmd/klaverjas`: the binary, which ties the bots to the server.
- `web/`: the frontend, plain ES modules and CSS with no build step and nothing
  loaded from other sites, so a strict Content Security Policy applies.

[`docs/design.md`](docs/design.md) is the contract between these parts: the
rules as implemented, the Go APIs, the wire protocol, the interface and the
deployment.

## Deployment

Two images from one `Containerfile`, a static Go binary `FROM scratch` and
nginx-unprivileged with the frontend, run as one rootless podman pod from
quadlet units, behind Nginx Proxy Manager:

```sh
make install    # the pod and container units, for your user
make deploy     # build both images, restart, check health
```

[`deploy/README-deploy.md`](deploy/README-deploy.md) covers the first setup,
the proxy host, day-to-day operation and what is exposed.
