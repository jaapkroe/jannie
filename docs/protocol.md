# Protocol

One websocket at `/ws` (same origin, `wss:` in production). All messages are
JSON objects with a type field `t`. Seats are absolute (`0..players-1`); the
client rotates so `you` is at the bottom.

This file has the table's part, which every game shares: the messages of
rooms, seats, the lobby, chat, calls and the takeover question, the error
codes, how updates work, the table's events and the shared keys of the
state. Each game adds its own moves, events and state keys
([games/klaverjas/README.md, "Protocol"](../games/klaverjas/README.md#protocol);
[games/toepen/README.md, "Protocol"](../games/toepen/README.md#protocol)).
A game's messages are unknown on another's server: they are answered with
`ongeldig`, "Dat bericht ken ik niet.". What the server does with the
table's messages is in [server.md](server.md).

## Client → server

| `t` | Fields | When |
|---|---|---|
| `create` | `name`, `opts` (partial ok), `start` bool; a game may read more (klaverjas: `training`, `expert`, `seat`) | Home. `start:true` starts at once (quick play vs bots); you sit at seat 0 |
| `join` | `code`, `name`, `token` (optional) | Join link, code entry, reconnect |
| `sit` | `seat` | Lobby: move to an empty seat |
| `bot` | `seat`, `id` ("" = random) | Host, lobby: put a bot on an empty seat (or replace a bot) |
| `unbot` | `seat` | Host, lobby: remove a bot |
| `opts` | `opts` (partial) | Host, lobby |
| `start` | | Host, lobby |
| `ready` | | Phase `handEnd`: continue now (ignored once the next hand is dealt: a late tap on the summary) |
| `vote` | `seat`, `ai` bool, `left` bool (optional) | While state `takeover` is set, every connected human: may an AI play that seat (`true`), or wait (`false`)? `seat`, and `left` when sent, as in `takeover`: the question it answers (the client sends `left`, so a yes for a stand-in never counts for a seat given away). Can change while the question is open ([server.md, "Takeover consent"](server.md#takeover-consent)); the same answer again changes nothing, so no `update` follows |
| `chat` | `text` | Any time |
| `call` | `id` (8–32 letters and digits; "" hangs up), `mic` bool, `cam` bool | Any time: join the call, switch the microphone or camera, hang up ([server.md, "Calls"](server.md#calls)). The same again changes nothing |
| `rtc` | `to` (a session in the call), `desc`: `{type: "offer"\|"answer", sdp}` | In the call: a session description for that session, passed on as `rtc` ([server.md, "Calls"](server.md#calls)) |
| `rematch` | | Host, phase `gameOver`: new match, same seats and options |
| `lobby` | | Host, phase `gameOver`: back to the lobby, same code and options ([server.md, "Rematch and back to the lobby"](server.md#rematch-and-back-to-the-lobby)); refused in a room without a lobby |
| `leave` | | Leave the room |
| `ping` | | Keepalive (server answers `pong`) |

The shell's feedback form (`panels.feedbackForm`,
[frontend.md](frontend.md)) sends `feedback` and waits for `saved`; those
are a game's messages, klaverjas's
([games/klaverjas/README.md, "Client → server"](../games/klaverjas/README.md#client--server)),
and toepen refuses them.

## Server → client

| `t` | Fields |
|---|---|
| `joined` | `code`, `seat`, `token` (store in localStorage under `kj.token.<code>`) |
| `update` | `seq`, `ev` (event or null), `s` (full state for you) |
| `chat` | `msg`: `{seat, name, text, ts, bot, sys}` (`sys`: system line, seat -1); a game may add a field (klaverjas: `coach`) |
| `chatlog` | `msgs`: last 50, sent after `joined` |
| `refused` | `name`: to the host only, someone could not join because the table is full ([server.md, "Joining"](server.md#joining)); no state change, so no `update` |
| `rtc` | `from` (the sender's session), `seat` (the sender's), `desc` as sent: to the session named only ([server.md, "Calls"](server.md#calls)) |
| `error` | `code`, `msg` (Dutch, ready to show) |
| `pong` | |

## Error codes

`onbekend` (no such room, or no longer in it: room removed, seat
taken over by another window, or taken back by name on another device), `vol`,
`gestart`, `geen-host`, `niet-jouw-beurt`, `ongeldig` (bad card/suit/fields;
`msg` is the game's Dutch explanation, for a card why it may not be played;
a `vote` with no open question about
that seat, or another one (`left` sent and different), also one that comes too late:
"Die vraag staat niet (meer) open."), `limiet` (rate limit, also for joins after too many failed ones),
`te-veel-spellen`, `herstart` (server restarting; client reconnects after a
delay).

## Updates and seq

Every state change is one `update`: the client queues updates, animates `ev`
from its previous state to `s`, then renders `s`. A resync (join, reconnect)
is an `update` with `ev: null`; so is a change without animation (a pause ends
and a turn opens, `ready` flags, a host change, the takeover question opening
after 10 s, a vote). `seq` increases per room with
every event; a resync carries the current `seq` (the joiner gets `ev: null`
where the others get `join`/`back` with the same `seq`). A game may send two
updates for one move, each with its event (klaverjas:
[games/klaverjas/README.md, "Events"](../games/klaverjas/README.md#events)).

## Events

The table's events (`ev.type`); each game adds its own.

| type | fields | client animation |
|---|---|---|
| `lobby` | | none (seat/option changes) |
| `gameOver` | `total` [per scorer], `winner` (scorer, or -1 when the top is shared); a system line in the chat with the match's seed follows ([server.md, "The seed"](server.md#the-seed)) | celebration |
| `join` / `leave` / `away` / `back` / `takeover` | `seat` | small toast |

`away`: the connection is lost; `back`: the player is at their seat again;
`leave`: they left (in a match the seat waits, `left`); `takeover`: an AI plays
the seat now, with everyone's consent (the substitute, `away: true`, or a
persona on a seat its player left). `away` comes once per lost connection.

## The shared state

Every game's state `s` starts with the keys the table owns (`server.Shared`);
the game's own keys follow:

```jsonc
{
  "code": "KQXB", "phase": "lobby|…|handEnd|gameOver",   // the game names the phases in between
  "opts": { "players":4, "ai":"normaal", "tempo":"normaal", "seed":0, … },   // the table's and the game's options
  "you": 0, "host": 0,
  "roster": [ {"id":"dirk","name":"Opa Dirk","emoji":"👴","color":"#8a5a2b","bio":"…"} ],  // lobby only: bot picker
  "players": [ // opts.players entries; null = empty seat
    { "name":"Piet", "bot":false, "botId":"", "emoji":"", "color":"",
      "connected":true, "away":false, "left":false, "vote":null,
      "call":{"id":"9f2c41d07a3b88e1","mic":true,"cam":false}, "cards":8, "ready":false },
    { "name":"Anna", "bot":false, "botId":"", "emoji":"", "color":"",
      "connected":false, "away":false, "left":false, "vote":null, "call":null, "cards":8, "ready":false },
    { "name":"Opa Dirk (AI)", "bot":true, "botId":"dirk", "emoji":"👴", "color":"#8a5a2b",
      "connected":true, "away":false, "left":false, "vote":null, "call":null, "cards":8, "ready":false }, null ],
  "turn": 0,                       // -1 while paused or nobody's turn
  "takeover": null,                // {"seat":1,"left":false}: the game waits for that absent seat; may an AI play it?
  "nextAt": 0                      // handEnd: unix ms of auto-continue (0: waits for ready); a game may use it for a countdown of its own
}
```

Every key above is always present, except `roster` (lobby only). Further:

- `opts.seed` is the option: the seed chosen for the table, 0 when the
  server draws one per match. A drawn seed is in no message before game
  over ([server.md, "The seed"](server.md#the-seed)).
- `players[i].cards` is the number of cards the seat holds (0 outside a
  hand); `ready` only counts in `handEnd`.
- `takeover` is set while the game waits for seat `seat` (it is its turn:
  `turn` = `seat`) and someone else is connected: `left` false for a player
  who dropped out (asked after 10 s), true for a seat its player left (asked
  at once). Everyone connected is asked; the absent player is not connected,
  so never sees it. Else null ([server.md, "Takeover consent"](server.md#takeover-consent)).
- `players[i].left`: a seat its player left in a match or at game over
  (`connected` false, the name kept, nobody plays it). `players[i].vote`: a
  connected human's answer to the question, `true` (an AI may play) or
  `false` (wait); null before answering and whenever `takeover` is null, and
  always for bots and absent players, except a no that still holds for a
  moment after its voter dropped out. `away`: the substitute plays for a
  player who dropped out, with everyone's consent, until they return (or the
  match ends).
- `players[i].call`: `{id, mic, cam}` while that human is in the call
  ([server.md, "Calls"](server.md#calls)), else null; always null for bots
  and for seats nobody is connected to.
