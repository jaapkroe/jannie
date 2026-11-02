# More card games on the same table

An investigation of how this repository can carry other card games besides
klaverjas — bridge, rikken, pesten, toepen and presidenten — and of what the
first one, toepen, needed. The contracts themselves stay in
[`design.md`](design.md); toepen's are its §11.

## 1. Summary

About half of the code is not about klaverjas at all: rooms with codes and
links, seats and the lobby, bots with a face and a name, chat, video calls,
reconnects, the rule that no AI takes a human's seat without the others'
consent, pacing, limits and the game log. That part is worth reusing as it
is. The other half — rules, bots, hints, the review, lessons, the expert
mode and the table on screen — is klaverjas through and through, and should
stay so: each game gets its own.

The seam between the two now exists in the code. A room is the **table**;
the game on it is a **`gameplay`** (`internal/server/games.go`) with eleven
methods (deal the first hand, whose turn it is, a seat's card count, the
state for a seat, the game's messages, a bot's decision and applying it,
resuming after a pause, the next hand, the start line). Klaverjas sits
behind it on its unchanged match code; **toepen is the second
implementation** and is playable now: with two to six players, against bots
at three strengths, with friends, in the browser.

Of the other four games, **presidenten** and **pesten** fit the seam with
modest additions (a 52-card deck, big hands, piles), **rikken** needs hidden
partnerships and many contracts, and **bridge** needs one person to play two
seats and a bidding system the bots understand. §6 suggests an order.

## 2. What the repository is made of

| Layer | Generic (any card game) | Klaverjas only |
|---|---|---|
| Cards | the card type and its wire codes (`"JH"`), the card faces (`web/js/cards.js`) — but only for the 32 cards 7–A | points, roem, trump order (`internal/game`) |
| Rules | — | `internal/game`: legal moves, tricks, roem, scoring, the hand for 2, 3 and 4 players (4,900 lines) |
| Bots | personas (names, faces, chattiness, boldness) | `internal/bot`: play at three levels, Monte Carlo search, signals, hints, grades, explanations, chat lines (10,400 lines) |
| Server | `room.go` (codes, seats, lobby, host, reconnect, leave, rematch), `takeover.go`, `call.go`, `conn.go`, `server.go`, limits, the game log writer | `match.go`, `state.go`, `review.go`, `lesson.go`, `expert.go`, `botchat.go`'s events, the wire state `s` |
| Frontend | `main.js` (routing, the update queue), `net.js`, `home.js` (home, lobby), `panels.js` (modals, chat, settings), `call.js`, `sound.js`, `util.js` | `table.js` (1,700 lines), the score sheet, review and replay in `panels.js`, `expert.js`, `manual.js` |

Where klaverjas reached into the generic part before this change:

- the room's seats were an array of four, and `game.Seat.Next()` steps
  modulo four;
- the room asked `r.deal` (a `*game.Deal`) whose turn it was, from the
  scheduler (`drive`), the takeover question and the state;
- `handle` switched over klaverjas messages (`trump`, `bid`, `auction`…)
  next to the table's own (`sit`, `chat`, `vote`…);
- the update carried a `*state`, a klaverjas struct;
- the AI interface the server needs (`Brain`, `Advise`, `Grade`, …) is
  klaverjas's;
- the frontend lays out at most four seats (`POS`), and the hand summary
  and game over are klaverjas's.

## 3. What each game needs

| | Klaverjas | Toepen | Presidenten | Pesten | Rikken | Bridge |
|---|---|---|---|---|---|---|
| Players | 2–4 | 2–8 (6 here) | 3–8 | 2–8 | 4 | 4 |
| Cards | 32 | 32 | 52 (+ jokers) | 52 + 2 jokers, two decks for many | 52 | 52 |
| Hand | 8 (10, 16) | 4 | all cards dealt: 6–18 | 7 (5 with many), grows | 13 | 13 |
| Kind | tricks, trump | tricks, only the last counts | climbing: sets on a pile | shedding: match suit or rank, specials | tricks, trump | tricks, trump or NT |
| Sides | 2 teams | each alone | each alone, ranks between rounds | each alone | contract-dependent, **hidden** partner (the called ace) | 2 fixed pairs |
| Before play | trump or bids | **was** (all at once), armoede | **card exchange** between ranks | — | auction of contracts (rik, alleen, troela, misère, piek…) | **auction** with doubles, conventions |
| Special | roem, signals | **stakes**: toep, go along or pass mid-trick | pass rounds, multi-card plays | draw pile, direction, skips, stacked penalties, choose a suit | misère (no tricks), open misère (shown hand) | **dummy**: declarer plays two hands, one shown |
| Match | fixed number of hands | until one is left | rounds, ranks | first out (or points) | points per contract | rubber, Chicago or duplicate |
| Bots | hard (search, signals) | easy–medium | medium | easy | medium–hard | hard (bidding systems) |

What toepen showed: the table copes with a game whose decisions are not
all a seat's turn (the **was** is answered by everyone at once, within a
time), with a stake that changes **in the middle of a trick**, with players
**leaving the round** (passing) and **leaving the match** (eliminated), and
with **more than four seats**. None of that needed a change to the table's
rules for consent, reconnects or chat.

## 4. The architecture

```
web/  shell: main.js · net.js · home.js (home, lobby, options per game) · panels.js · call.js · sound.js · cards.js
      per game, loaded when a table of it shows: table.js (klaverjas) · toepen.js + toepen-rules.js + toepen.css
          │  one websocket; the update's state carries "game"
internal/server   the table: room.go, takeover.go, call.go, conn.go … ── gameplay (games.go)
                                                                         ├── klaverjas: match.go, state.go, review.go, lesson.go, expert.go
                                                                         └── toepen:    toepen.go
internal/<game>      rules: a pure state machine with a View per seat   (internal/game, internal/toepen)
internal/<game>bot   bots on that View                                  (internal/bot,  internal/toepbot)
cmd/klaverjas        adapts each bot package to the server's interface for it (AI, ToepAI)
```

### 4.1 The table and the game (server)

`gameplay` is what the table needs from the game on it; every method runs on
the room goroutine:

```go
type gameplay interface {
	start()                                    // deal the first hand; seats are filled, the seed drawn
	turn() game.Seat                           // whose decision the game waits for; NoSeat: nobody's (a pause, or all at once)
	handLen(i game.Seat) int                   // players[i].cards
	state(i game.Seat) any                     // the state `s` of an update for seat i
	move(c *client, i game.Seat, m *inMsg) bool // the game's own messages; false: none of them
	decision(i game.Seat, bb *brainBox) (think func() action, safe action) // a bot's, worked out off the room goroutine
	apply(i game.Seat, a action) error         // play it
	single() bool                              // one option on turn: the bot thinks shorter
	resume(s step)                             // a pause ended
	next()                                     // after the summary: the next hand, or game over
	variant() string                           // for the start line in the chat
}
```

Everything else stays with the table: `drive` schedules pauses, bot moves
and the takeover question from `turn()`; `decide`/`applyBot` run any game's
bot once per turn; `emit` sends `state(i)` to each seat; `handle` passes
whatever it does not know to `move`. Options say which game a room plays
(`opts.game`), and changing it in the lobby swaps the gameplay.

A pattern toepen added that others will reuse: **a time in which everyone
answers at once** — a pause (`stepWas`) during which the game takes answers
from anyone; bots answer after their think time; it ends when all have
answered or the time is up (no answer is the default, not a decision made
for an absent player). Presidenten's card exchange and pesten's "last card"
call fit it.

### 4.2 Rules and bots per game

Each game has a pure rules package (no timing, no randomness inside, every
rule tested exhaustively and against random play) with a `View` per seat,
and a bot package on that View. The server defines the small interface it
needs from those bots (`ToepAI`/`ToepBrain` for toepen) and `cmd/klaverjas`
adapts them, so `internal/server` still builds and is tested without any
bot (a server without `Config.Toepen` plays toepen with `plainToep`, the
first legal card). The personas are shared: toepen's bots are Opa Dirk and
the others, with their boldness as how readily they toep and bluff, and
chat lines of their own for toepen's events.

### 4.3 The frontend

The shell renders the lobby for every game (option rows carry the game
they belong to; seats are drawn on an ellipse when there can be more than
four). A table of another game loads its own module and stylesheet the first
time one shows, like `expert.js` and `call.js`, so a page load still makes
13 requests of the 17 allowed. A game module exports `render`, `animate`,
`bubble`, `onError`, `staleVote`, `resync` and `resetRoom`; `main.js` routes
an update to it by `s.game`. Pure parts (layout, texts) sit in a separate
module so they can be unit-tested in Node.

## 5. What is not generic yet

- **Cards.** The card type has the ranks 7–A only, and `cards.js` draws
  those. Bridge, rikken, presidenten and pesten need 2–6 and the jokers.
  Proposed: an `internal/cards` package with the 52 cards plus two jokers
  (wire codes `2C`…`AS`, `X1`, `X2`; the 32 keep their codes), each game
  with its own order and points, and faces for the new ranks in
  `cards.js` (pips, and art for the jokers).
- **Options.** `Options` is flat and now holds klaverjas's and toepen's
  fields side by side. With a third game it should become the common part
  (`game`, `players`, `ai`, `tempo`, `seed`) plus a per-game object the
  game validates.
- **The AI interface.** `AI` is klaverjas's; toepen got its own `ToepAI`. A
  common part (personas, chat) and a per-game part would keep this from
  growing a branch per game.
- **Klaverjas's own fields on the room.** The deal, scores, lessons, reviews
  and expert state are still fields of `room`, used by the klaverjas
  adapter. Moving them into a `klaverjas` struct like `toepPlay` would make
  the room only the table.
- **The extras.** Hints, the review after a match, lessons and the expert
  mode are klaverjas-only. They could become optional capabilities a game
  offers (an `Advisor` the table asks when the game has one).
- **Seats.** Six at most (`maxSeats`). Pesten and toepen with seven or eight
  need the number raised and the lobby's and table's ellipses checked at
  that size.
- **Seats that are not a person's own.** Bridge's dummy: the declarer plays
  two seats. The table's idea of "whose turn" and "who may send this card"
  would need a `controller(seat)` — the dummy's turn belongs to the
  declarer's connection.
- **Secret sides.** Rikken's called ace makes a partnership nobody but the
  partner knows until the ace falls; `View` must not reveal it (klaverjas's
  `Side` is public), and chat replies ("Goed gedaan, maat!") must not
  either.
- **Big hands and piles.** Presidenten deals up to 18 cards and pesten's
  hands grow; the hand needs to scroll or fan tighter, and the table needs
  a draw pile and a discard pile instead of trick slots.
- **The manual.** `manual.js` is klaverjas's; toepen has its rules in a
  sheet of its own on the table. A manual per game, with a shared
  *Bediening* part, would suit more games.

## 6. Per game: what to build, and an order

1. **Presidenten** next: a new kind of rules (sets on a pile, passing,
   ranks), the 52-card deck (`internal/cards`) and the card exchange as a
   "time in which everyone answers" between two seats. Bots by rules of
   thumb, then sampling as toepen's. Medium.
2. **Pesten**: shedding with special cards and many house rules (make the
   specials options, as toepen's was and armoede); draw pile and direction;
   bots are easy. Needs the jokers and big hands. Medium.
3. **Rikken**: a trick-taking engine like klaverjas's without its trumping
   obligations (a shared trick kit is worth extracting then), the contracts
   with their scores, the hidden partner, and open misère's shown hand.
   Bots: sampling as klaverjas's sterk, with the auction by thresholds.
   Medium to large.
4. **Bridge** last: the auction (bids, double, redouble, three passes) with
   a bidding system the bots and the hints share (e.g. a simple standard
   system), the dummy, and rubber or Chicago scoring; card play by sampling
   as klaverjas's sterk. Large; the bidding system is most of it.

For each: the rules package with its tests first (as `internal/toepen`:
table-driven rules plus thousands of random matches), then the bots with an
arena test (stronger beats weaker), then the gameplay and its server tests,
then the table module, checked in a browser at phone and desktop sizes.

## 7. Toepen, as built here

| Part | Files |
|---|---|
| Rules: a round as a pure state machine, the match until one is left | `internal/toepen` (`cards.go`, `deal.go`, `view.go`; tests with 3,000 random matches at 2–8 players) |
| Bots: rules of thumb; sterk samples the hidden cards and plays every card out; toepen, going along and the was by the chance to take the last trick, weighed against the points and the risk of going out; chat | `internal/toepbot` (arena: sterk 2.38 vs normaal 2.69 penalty points per round for two seats; normaal 2.44 vs makkelijk 2.79) |
| Server: the gameplay, the was window, events, state, game log | `internal/server/toepen.go`, `games.go` (tests in `toepen_test.go`, race-clean) |
| Frontend: game choice on the home screen and in the new-game sheet and lobby, the table for 2–6, summary, game over, stand, rules | `web/js/toepen.js`, `toepen-rules.js`, `web/css/toepen.css`, `home.js`, `main.js` (unit tests in `test/ui/toepen.test.mjs`) |

The rules are those of the Dutch Wikipedia article and the common house
rules; where groups differ, the choice is written down in `design.md` §11
and the most common variants are options (the limit of 10 or 15, the was,
armoede).
