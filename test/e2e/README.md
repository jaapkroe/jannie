# End-to-end games over the websocket

Every game has a simulation that plays complete games against a running
server, the way the browser does: over `/ws` with the table's protocol
([docs/protocol.md](../../docs/protocol.md)) and the game's own messages
(the README in the game's folder). Simulated players create a room, join it with
the code, make random legal choices, press *ready* after a hand or round
and play on until `gameOver`. Bots fill the other seats. Every message is
checked; the first broken invariant stops that game with a message saying
who saw what, where.

The simulations need Node 22 or later (they use the built-in `WebSocket`)
and nothing else. What they share is in `lib.mjs`: a seat's connection
(`Seat`), seating a table of people (`seatTable`), and the wait for game
over with its watch for a game that stalls (`untilOver`). Toepen's
simulation extends `Seat` with its own checks and choices, and a later
game's does the same; `sim.mjs`, the oldest, has its own player and loop
and takes only the URL and the seed's line from it.

## Running it

Every game has a simulation of its own, named by `E2E_SIM` in its
`<game>.mk`, which takes the server's URL as its one argument. Klaverjas's
and toepen's are here, `sim.mjs` and `toepen.mjs`, and described below; a
later game keeps its simulation in its folder (say
`games/<game>/test/e2e.mjs`) and describes it in its README
([docs/adding-a-game.md, "The folder"](../../docs/adding-a-game.md#the-folder)).

The quickest way is `make e2e`: for every game in turn it starts the game's
server from source with `-fast` on the game's `E2E_PORT`, waits for
`/api/health`, plays the game's simulation and stops the server again, and it
stops at the first game that fails. One game alone:

```sh
make e2e GAME=klaverjas     # sim.mjs on 18094
make e2e GAME=toepen        # toepen.mjs on 18096
```

By hand, against a server of your own (`GAME` says which game's server):

```sh
GAME=klaverjas scripts/dev-server 18200 -fast   # all delays × 0.05; poll /api/health until it answers
node test/e2e/sim.mjs http://127.0.0.1:18200
podman stop kj-dev-18200
```

A simulation plays only its own game: a klaverjas server answers toepen's
messages with "Dat bericht ken ik niet.", and the other way round.

## sim.mjs (klaverjas)

It plays klaverjas: its players choose a trump suit, *spelen* or *passen*,
a bid and the cards to lay away at a table of three, and cards, at random
among the legal ones.

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
| `--players` | 2, 3, 4: the seats at the table ([games/klaverjas/README.md, "Rules as implemented"](../../games/klaverjas/README.md#rules-as-implemented)) | 4 |
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
run into the per-address limits (150 connections, 60 new rooms per 10 minutes).
The server trusts that header because in production only nginx can reach it.

### What is checked

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
set (0 in training, where the summary waits for *ready*). At a table of
four each simulated player then asks to look back at the hand
(`handReview`): the answer, and every one the server sends again as a grade
of it comes in, holds the 32 cards dealt and played and the player's graded
decisions by trick (0 to 8, each card one they played in that trick), with
never fewer decisions and never more still being graded than before; at a
table of three or two the first hand's question is refused.

At game over: exactly `--hands` hands were played (and seen), the totals and
the winner agree, in training a tip arrived after every trick, and every
hand before the last that was asked to look back at came back, as did the
refusal (not checked with `--reconnect`). Once
the review is complete, its replay has every hand with the player's graded
decisions, at least as many as the hand's last `handReview` had. Right after
`gameOver` the chat names the seed ("De seed van dit spel was 482913.";
for a player back after game over, in the chat log), the review's `seed` is
that one, and no message the player got before game over named it (the
update at game over may: its review has it;
[docs/server.md, "The seed"](../../docs/server.md#the-seed); a seed under
10000 might be a score, so it is not looked for). A player is done with
that line.

Any `error` message from the server fails the game too (except the answer to
a vote that crossed the end of its question, see above, and the refusal of
`handReview` at a table of three or two), as does a closed connection or 30 seconds without any message (a
stall). With `--reconnect` the result line counts the reconnects, the
questions, the votes (and those too late) and the takeovers.

## toepen.mjs

With only the URL as its argument (no `--url`) it plays five matches: tables of 2 to 6 with one to four
humans, every AI level, a limit of 10 or 15, and the extra rules on and
off (vuile was, armoede, koningsspel, boer, anti-lijntoep, open after a
bluff). Simulated players lay away random cards in the koningsspel, claim
a vuile was now and then (bluffs included, again with new cards), check,
toep, overtoep, go along or pass
at random (going along when anti-lijntoep says so), play a random legal
card, and press *ready* after half the rounds (the others wait for the
summary's own time). Any option plays that one configuration instead:

```sh
node test/e2e/toepen.mjs --url ws://127.0.0.1:18096/ws --players 5 --humans 2 --ai sterk --limit 15 \
  [--no-was] [--no-armoede] [--no-koning] [--no-boer] [--lijntoep] [--no-bluf]
```

On every update it checks that the state has exactly toepen's keys (no
`game`, `training` or `expert`) and `opts` exactly its eleven, the phase is
one of toepen's, a hand never holds more than four cards (eight in the
koningsspel, and only with that rule) and `legal` is in it, `canRaise`
only on a toep and `mustStay` only with anti-lijntoep, a hand played face
up only with rule `bluf` and of a seat still in (yours: your hand), no
bluff offered on armoede, before the first card the turn of the player on
armoede (of two or more the first after the dealer, else voorhand),
armoede's question going round from that player's left without a seat on
armoede, `courses` empty before game over and at game over one per round,
with only what everyone saw (no cards of a vuile was nobody checked),
your hand unchanged once you are out of a round that goes on (passed, a
bluff caught, out by a check), nobody's points go down within a round (but for
the boer's point off the last trick's winner), and at game over exactly one
player is left, the winner, under the limit. Then every simulated player
gets the line with the seed, after `gameOver`, and no message before game
over named that seed, as for klaverjas. Any `error` fails the match,
except a move that crossed a change of turn (`niet-jouw-beurt`, "Die vraag
staat niet (meer) open.") and a *ready* that crossed the last summary
moving on into game over; so does 30 seconds without progress.
