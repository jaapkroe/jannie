# End-to-end games over the websocket

`sim.mjs` plays complete klaverjas games against a running server, the way the
browser does: over `/ws` with the protocol of `docs/design.md` §7. Simulated
players create a room, join it with the code, make random legal choices (trump
suit, *spelen*/*passen*, cards), press *ready* after each hand and play on until
`gameOver`. Bots fill the other seats. Every message is checked; the first
broken invariant stops that game with a message saying who saw what, where.

It needs Node 22 or later (it uses the built-in `WebSocket`) and nothing else.

## Running it

The quickest way is `make e2e`: it starts the server from source with `-fast`
on port 18094, waits for `/api/health`, plays the standard suite and stops the
server again.

By hand, against a server of your own:

```sh
scripts/dev-server 18200 -fast              # all delays × 0.05; poll /api/health until it answers
node test/e2e/sim.mjs http://127.0.0.1:18200
podman stop kj-dev-18200
```

With only a URL it plays the standard suite: tables of four, three and two,
one to four humans, both ways of choosing trump, both rule sets, all AI
levels, a training game with open cards, a full *boom* of 16 hands, and
games where players drop their connection and come back while the others
vote on an AI playing for them. Any option below plays that one
configuration instead:

```sh
node test/e2e/sim.mjs --url ws://127.0.0.1:18200/ws --humans 2 --trump gedraaid \
  --rules rotterdams --ai sterk --hands 4 --games 3
node test/e2e/sim.mjs --url ws://127.0.0.1:18200/ws --training --open --hands 4
node test/e2e/sim.mjs --url ws://127.0.0.1:18200/ws --humans 3 --reconnect --games 4 --parallel
node test/e2e/sim.mjs --url ws://127.0.0.1:18200/ws --players 3 --humans 2 --rules rotterdams
```

| Option | Values | Default |
|---|---|---|
| `--url` (or a positional URL) | `ws://…/ws`, or `http://host:port` (then `/ws` is added) | `ws://127.0.0.1:18200/ws` |
| `--players` | 2, 3, 4: the seats at the table (§2 of the design) | 4 |
| `--humans` | 1 to `--players` simulated players; the other seats get bots | `--players` |
| `--trump` | `utrechts`, `gedraaid` | `utrechts` |
| `--rules` | `amsterdams`, `rotterdams` | `amsterdams` |
| `--ai` | `makkelijk`, `normaal`, `sterk` | `normaal` |
| `--hands` | 4, 8, 12, 16, 20, 24 | 4 |
| `--tempo` | `rustig`, `normaal`, `snel` | `normaal` (`rustig` in training) |
| `--training` | training game: one player, Juf Jannie as partner, hints and tips | off |
| `--open` | training with open cards (`hands4`) | off |
| `--reconnect` | players sometimes drop the connection for up to 1.5 s and rejoin with their seat token; the others answer the question whether an AI may play for them (mostly yes, now and then a no that may turn into a yes) | off |
| `--games` | games per configuration | 1 |
| `--parallel` | play all games at the same time instead of one after another | off |
| `--verbose` | print every event | off |

The exit status is 0 when every game finished cleanly, 1 when any failed and 2
for bad arguments. Use `-fast` on the server: at normal pace a hand takes about
a minute.

Each connection sends its own `X-Real-IP`, so many simulated players do not
run into the per-address limits (16 connections, 20 new rooms per 10 minutes).
The server trusts that header because in production only nginx can reach it.

## What is checked

On every update:

- `seq` increases with each event and never goes back on a resync; a state is
  present; `you`, `code`, options and training flag are right; the own seat is
  a connected human and every bot's name ends in " (AI)".
- During a hand, every seat's card count is 8 minus its cards played (tricks
  taken plus a card in the open trick); the own hand matches it, has no
  duplicates and never gains a card; outside a hand `turn` is -1 and the hand
  is empty; in gedraaid the turned suit is known while bidding.
- On your turn in phase `play`: `legal` is non-empty and part of the hand, and
  `rule` is set; otherwise neither is present. In training, every turn has a
  hint (a hinted card is legal); with open cards `hands4` matches the card
  counts.
- No AI plays for an absent human without everyone's consent: a trump, bid or
  card of a human seat comes from its connected player, or from the
  substitute the others let in (`away`), never for a seat its player left.
  `away` turns true only with a `takeover` event about that seat, and that
  event comes only for the question that was open, after this player's own
  last answer to it was yes; the event `away` comes once per lost
  connection. `takeover` is set only on the turn of an absent human (`left`
  as on the seat), never about yourself; votes are only there while it is,
  from connected humans (a no may outlast its voter's drop-out a moment);
  the turn of a seat its player left always comes with the question. A vote
  refused as too late ("Die vraag staat niet (meer) open.") is fine only
  when the question it answered has closed or changed by then.
- The score sheet has one row per finished hand, numbered in order, and
  `total` is the sum of the rows.

In training, after each trick: a trick's tip says what the hint advised
when the player played another card ("♣9 aangeraden"), and the first trick's
tip does so too for a trump choice or bid against the hint ("♥ als troef
aangeraden", "aangeraden om te passen"); a tip after following every hint
says nothing of the kind (not checked with `--reconnect`).

At each hand end: the card points add up to 162; nat exactly when the playing
team does not get more than half of points plus roem, with 0 for them and
162 + all roem for the others; otherwise each team scores points + roem; pit
only with all eight tricks; the eight tricks hold the 32 different cards and
their points match the result; the last score row is this hand; `nextAt` is
set (0 in training, where the summary waits for *ready*).

At game over: exactly `--hands` hands were played (and seen), the totals and
the winner agree, and in training a tip arrived after every trick.

Any `error` message from the server fails the game too (except the answer to
a vote that crossed the end of its question, see above), as does a closed connection or 30 seconds without any message (a
stall). With `--reconnect` the result line counts the reconnects, the
questions, the votes (and those too late) and the takeovers.
