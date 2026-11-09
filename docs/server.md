# The table

`platform/server` is the table every game is played at: rooms and codes,
seats and the lobby, bots and their chat, calls, reconnects, the takeover
question, pacing, the game log and the limits. One server plays one game
(`Config.Game`): `cmd/klaverjas` passes `server.Klaverjas(ai)`, the
built-in game, and `cmd/toepen` toepen's `server.Game`
(`games/toepen/toepenserver`,
[games/toepen/README.md](../games/toepen/README.md)). The table imports no
game's bots: each game's main package (`cmd/<game>`, or `<folder>/cmd/<game>`
for a later game) has an `ai.go` that adapts the game's bot package to the
interfaces its server side needs (klaverjas: the table's `AI`; toepen:
`toepenserver.AI`). It does import klaverjas's rules,
for the built-in game (the `klaverjas_*.go` files;
[architecture.md, "What is not generic yet"](architecture.md#what-is-not-generic-yet)),
and `platform/cards` for the seats and cards every game uses. Server tests
use a fake AI (first legal card), so the packages build independently.

Each room is an actor: one goroutine owning all room state, fed by a command
channel; timers via `time.AfterFunc` posting back into the channel. Each
connection has a reader and a writer goroutine with a bounded send queue (a
client that falls behind is disconnected; it resyncs on reconnect).

The messages on the wire are in [protocol.md](protocol.md).

## Go API

### Config and New

```go
type Config struct {
    Game Game           // the game the server plays: Klaverjas(ai), or another (required)
    Fast bool           // scale all delays by 0.05 (tests)
    MaxRooms int        // default 1500
    AllowedOrigins []string // websocket Origin patterns besides same-host
    Version  string     // reported by /api/health {ok, version, rooms, players}
    Logger   *slog.Logger // nil: slog.Default()
    GameLog  string     // directory of the game log ("Game log" below); "" keeps none
}
func Klaverjas(ai AI) Game                // the built-in game, on the code of this package
func New(cfg Config) *Server
func (s *Server) Handler() http.Handler   // /ws, /api/health
func (s *Server) Shutdown(ctx context.Context)
```

`Klaverjas(ai)` takes klaverjas's bots and analysis through the interface
`AI` ([games/klaverjas/README.md, "The AI seam"](../games/klaverjas/README.md#the-ai-seam)).

### The Game API

Other games play on an exported API (`api.go`, `ext.go`): the table owns
codes and links, seats and the lobby, bots and their chat, calls,
reconnects, the takeover question, pacing, the hand summary, game over, the
game log and the limits; the game brings its rules, options, bots and
personas. Klaverjas runs on the table's own match code behind an unexported
seam (`games.go`), so its wire format and behaviour are exactly those of
[games/klaverjas/README.md](../games/klaverjas/README.md); nothing of
another game reaches it.

```go
type Game interface {
    Name() string
    Seats() (min, max, def int)             // at most 8
    Personas() []Persona                    // the game's bios; at least max − 1
    NewOptions() GameOptions                // the game's own options, at their defaults
    NewBrain(personaID, level string, seed uint64) any
    Chat(personaID string, ev ChatEvent, rng *rand.Rand) string
    New(t *Table) Play                      // one match at table t
}
type Opener interface {                     // optional: rooms of the game's own kind
    Open(m Msg, o GameOptions) Opening      // once, on create, after the options are set
}
type Opening struct {                       // the zero Opening: an ordinary room
    Seat   Seat                             // the creator's seat
    Bots   []string                         // a persona ID per seat ("" none), kept on rematch
    Start  bool                             // the match at once, as create's start
    Locked string                           // not "": a fixed table; joiners get vol with this text
}
type GameOptions interface {
    Set(fields map[string]json.RawMessage, lenient bool) error // the game's keys; Dutch errors
    Wire(TableOpts) any                     // the state's opts and the game log's: table's and game's
}
type TableOpts struct{ Players int; AI, Tempo string; Seed int }   // what every game has (below)
type Play interface {
    Start(); Next()                         // deal the first hand; the next one, or Table.GameOver
    Turn() Seat                             // the seat that decides, also for another seat's cards
    HandLen(i Seat) int; Single() bool
    State(i Seat) any                       // Table.Shared(i) embedded, and the game's own keys
    Move(i Seat, m Msg) error               // a human's message: ErrUnknownMsg, ErrIgnore,
                                            // NotYourTurn(err) or ErrPaused, or ongeldig
    Decision(i Seat, brain any) (think func() any, safe any) // a bot's, off the room goroutine
    Apply(i Seat, a any) error
    Resume(s Step)                          // after the game's pause s
    Variant() string                        // for the server log
}
type Shared struct{ Code, Phase string; Opts any; You, Host int; Roster; Players; Turn int; Takeover; NextAt int64 }
```

`Seat` is the seat of `platform/cards` (`games/klaverjas/game` re-exports
it as `game.Seat`, the same type), as are the cards a game deals
("platform/cards" below).
`Shared` is the part of the state every game sends
([protocol.md, "The shared state"](protocol.md#the-shared-state)).

`Turn` is the seat whose decision the match waits for, and that is the
seat that decides: when one player plays the cards of two seats (a
partner's hand laid open on the table, say) it is that player's seat while
the other seat's card is due, so its bot decides, its persona's think time
counts and the question about an absent player is about it ("Takeover
consent" below). Which hand to play from is the game's own state. A
partnership the others may not see yet is the game's too: `State(i)` is
per seat, and the table shows no sides.

A game that implements `Opener` may open rooms of its own kind, such as a
training table: `Open` reads the create message (`m.Raw`, the game's own
fields) and the game options create set, and says where the creator sits,
which bots sit where, whether the match starts at once and whether the
table is fixed ("Rooms without a lobby" below). A game without it gets
ordinary rooms.

### Table options

The options every game has (`TableOpts`), JSON keys on the wire; the
game's own options come after them in the state's `opts`:

| Key | Values | Default | Meaning |
|---|---|---|---|
| `players` | the game's seat range (`Game.Seats`) | the game's | Seats at the table. Empty seats at the start get random bots |
| `ai` | `makkelijk`, `normaal`, `sterk` | `normaal` | Strength of every bot in the room |
| `tempo` | `rustig`, `normaal`, `snel` | `normaal` | Pacing of bots and pauses ("Pacing" below) |
| `seed` | 1..999999999, or 0 / null | 0 | Every match deals from a seed: with this one the same cards for the same options and number of players, also on `rematch`; 0 draws a new seed per match. Before game over no message names a seed the server drew ("The seed" below). The client never remembers it in `kj.opts` |

The seed seeds every deal of a match and nothing else (`dealRNG`), so the
same seed and options give the same cards, whatever the players do.

### Table

`*Table` is the game's handle on its room: reads (`Code`, `Opts`,
`Options`, `Players`, `Deals`, `MatchID`, `DisplayName`,
`BotPlays`, `HumanCount`, `InHand`, `Pending`, `PauseEnds`, `Pace`,
`Logger`, `Shared`, `Current`) and the moves of the table (`SetPhase`,
`SetHand`, `Pause`, `EndPause`, `OpenTurn`, `Emit`, `Later`, `Think` for a
question everyone answers at once, `Background` for an analysis off the
room goroutine, `Trick`, `Summary`, `GameOver`, `SysChat`,
`BotSay`, `BotsReact`, `CoachChat`, `Send`, `Log`), every duration scaled
by the room's tempo.
`Later`, `Think` and `Background` call back unless a new match or the
lobby has replaced the match they were asked in, or the room has closed:
game over does not stop them, so a callback that must not act after
game over checks the game's own phase. `Current()` returns that test as a
func that is safe on any goroutine (the table's other methods run on the
room goroutine only), so a game's own workers can skip a job of a match
that is gone.
`CleanText(s, limit)`, a function of the package, cleans text a person
sent for the game's own use (feedback, as klaverjas's) line by line,
each line as the table cleans a chat line ("Limits" below), lines with
nothing visible left out, at most `limit` characters in all.
`CoachChat(i, text)` puts a line of the bot at seat `i` in the chat
outside the limits of bot chat, marked `coach` (a lesson step; "Bot chat"
below); for a seat without a bot it puts nothing, so no line goes in a
human's name. `Send(i, msg)` sends a message of the game's own to the human at
seat `i` alone, if connected, and reports whether it went: an answer for
that player only (the review of one hand), where `Emit`'s event goes to
everyone. Its `t` must be none of the table's (`joined`, `update`,
`chat`, `chatlog`, `refused`, `rtc`, `error`, `pong`); such a message, or
one without a `t`, is logged and not sent
([protocol.md, "Server → client"](protocol.md#server--client)).
A game never sees the seed, only the stream its deals come from (`Deals`);
`GameOver` names it in the chat ("The seed" below), so a game's own line
about the end goes before that call.
The table drives the match after every call into the game and every
callback; a game never schedules itself. For another game the table reads
`players`, `ai`, `tempo` and `seed` ("Kies N tot en met M spelers.", or
for a game of one table size "Dit spel speel je met N spelers.") and
hands the other keys to `Set`; `training`, `expert` and `seat` of `create`
are klaverjas's, and another game reads what it wants of `create` in
`Opener.Open`.

### servertest and the toy game

`servertest` is a test kit for a game's server tests (`Start`, a client
with `Create`, `Join`, `Until`, `WaitEvent`, `Poll` for several clients
in one loop, `Keep` to keep every message, …; `SeedAtEnd` checks a
client's messages for the seed, "The seed" below), and `toy_test.go` a toy
game ("hoogste kaart") that is the template for the next one. Its
variants show the rest of the API: `toyTable` a table of the game's own
(`Opener`) with coach lines (`CoachChat`) and messages to one seat
(`Send`), `toyThree` a game of one table size, and `toyLate` work that
outlives game over (`Later`, `Background`, `Think`), `Current` and
`CleanText`.

### Personas

Personas: their identities (name, emoji, colour, chattiness, speed) are
`platform/persona`'s, the same at every game; bios and chat are per game
(`games/klaverjas/bot` for klaverjas, `games/toepen/toepbot` for toepen).
A bot's display name is always `"<Name> (AI)"`, built by the server into
`players[i].name`. Eight personas (IDs fixed):

| ID | Name | Emoji |
|---|---|---|
| `dirk` | Opa Dirk | 👴 |
| `truus` | Tante Truus | 👵 |
| `sjaak` | Sjaak | 🎲 |
| `fatima` | Fatima | 🧠 |
| `kees` | Kees de Visser | 🎣 |
| `jannie` | Juf Jannie | 👩‍🏫 |
| `bram` | Bram | 🛹 |
| `vera` | Bakker Vera | 🥐 |

### platform/serve

`platform/serve` is what every binary shares: `serve.Main(Site{Game,
Title, Verb, Extras}, version, game)` (`Extras`: services a site runs
besides its table, each a path, a handler and a shutdown; toepen's score
sheets at `/api/score`,
[games/toepen/README.md, "Score bijhouden"](../games/toepen/README.md#score-bijhouden))
with the flags `-addr 127.0.0.1:8081`, `-games DIR` (the game log),
`-static DIR` (dev only: `DIR` is the repository, and the server also
serves the frontend, the union of `DIR/platform/web` and the `web/` of
the game's folder, `DIR/games/<game>` or, for a game of the overlay,
`DIR/extra/<game>` (the one with `<game>.mk`), a path in both or a missing directory being a
start-up error; the same `/^[A-Za-z]{4}$/` → index.html rule as nginx,
`Cache-Control: no-cache`, the nginx CSP and the game's 404 page),
`-fast`, `-origin PATTERN` (repeatable), `-healthcheck` (GET
`http://127.0.0.1:8081/api/health`, exit 0/1; the scratch image has no
curl). Logs with `log/slog` to stdout. Never log chat text or tokens.

### platform/cards

The seats and the 32-card deck (7 to ace) that every game uses, with their
wire codes and Dutch names; it imports nothing of the module
(`test/layout.test.mjs`). Klaverjas's `game` package re-exports these names
([games/klaverjas/README.md, "Package game"](../games/klaverjas/README.md#package-game)),
and toepen uses them as they are. A 52-card game brings its own `Card` and
`Rank`, and shares `Seat` and `Suit`.

```go
type Seat int                    // clockwise from 0; const NoSeat Seat = -1, nobody
func (s Seat) ValidFor(players int) bool   // 0 <= s < players
func (s Seat) Next() Seat; Partner() Seat; Team() int; Valid() bool   // a table of four only
type Suit uint8                  // Clubs, Diamonds, Hearts, Spades (wire "C","D","H","S"); NumSuits
type Rank uint8                  // Seven … Ace in natural order (wire "7","8","9","T","J","Q","K","A"); NumRanks
type Card struct{ Rank Rank; Suit Suit }   // wire "JH"; JSON and text as that code
type Played struct{ Seat Seat; Card Card } // JSON {"seat":2,"card":"JH"}
func ParseCard(s string) (Card, error)     // "JH", case-insensitive, "10H" too
func ParseSuit(s string) (Suit, error)     // "H", case-insensitive
func MustParseCards(s string) []Card       // space-separated codes; panics; for tests and fixed tables
func NewDeck() []Card                      // the 32 cards by suit, then rank
func (c Card) Index() int; CardFromIndex(i int) Card; (c Card) Valid() bool   // 0..31, suit-major
func (s Suit) Symbol() string; Red() bool  // "♥"; ruiten and harten
func (r Rank) NameNL() string; Letter() string             // "boer", "B"
func SuitNameNL(s Suit) string; CardNameNL(c Card) string; CardShortNL(c Card) string // "harten", "harten boer", "♥B"
```

### Benchmarks

`klaverjas_perf_test.go` measures the server's own cost: fake humans,
connections without a socket, play whole klaverjas matches in process with
random legal decisions. `go test -run '^$' -bench . ./platform/server` runs
`BenchmarkGame` (a match of 16 hands: solo, gedraaid, four humans, expert,
three and two players; and the lesson on the basic game, 8 hands),
`BenchmarkMarshalState`
(every update of a solo match encoded again), `BenchmarkStateGameOver` (the
state after 24 hands) and `BenchmarkWSGame` (a solo match over a real
websocket, with and without permessage-deflate, with the bytes on the
wire); `go test -run PerfWire -v ./platform/server -args -perf.wire` lists
what one connection receives in a match, per kind of message and per key
of the state (skipped without the flag).

## Rooms and codes

- Code: 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I, O), unique among live
  rooms, case-insensitive on input. Join link: `https://SITE/ABCD`
  (`https://klaverjas.kroes.dev/ABCD`).
- Creator sits at seat 0 (or where the game's `Opening` says) and is
  host. If the host leaves, the next human
  becomes host (a connected one first); if the host stays disconnected for
  30 s while another human is connected, the next connected human does. With
  nobody else connected the role stays, so a host who comes back first keeps
  it. This is checked when the host's 30 s are up, when a human joins or
  comes back, and when someone else gives a host command such as `rematch`
  or `lobby`; a check that finds the host gone for less than 30 s while
  someone else is connected (a leave may hand the role to a human gone a
  moment) runs again when the 30 s are up.
- A room is removed 30 min after game over (players
  still connected get `onbekend`) and at once when the last human leaves its
  lobby. With no human connected it is removed after 30 min while a game runs
  that still has a human seat, and after 5 min in the lobby, after game over,
  or once every human has left (a seat its player left counts as no human,
  here and for the host; it can be taken over until then). Max 1500 rooms
  (`Config.MaxRooms`): when full, a new game
  replaces the room that has had no human connected for longest (at least
  2 min), else error `te-veel-spellen`.

## Seats and the lobby

`players` seats (`0..players-1`). The lobby starts with only the
creator seated (and the bots of the game's `Opening`, "Rooms without a
lobby" below); nobody places bots by option. The host can put a bot (chosen
or random) on any empty seat and remove bots. Humans may move to any empty
seat. At start, empty seats get random distinct bots. Changing `players` in
the lobby keeps everyone whose seat stays; a human on a seat that goes moves
to the first free seat (a bot makes way if needed), a bot on it leaves; with
more humans seated than the new number, error `ongeldig` ("Er zitten al 3
mensen aan tafel.").

## Joining

- Joining a lobby: first empty seat; with none → error `vol`, whose text says
  what to ask the host: one bot less when bots fill a seat, else a seat more
  under *Spelers* (with as many people seated as the game allows, nothing
  can be done).
- Joining a running game, or one that is over: allowed only to take over a
  seat a human left, still waiting or played by the AI the others let in,
  else error `gestart` (after game over its text asks the host to set the
  table up again). A joiner with the name of a player who left gets that
  seat (their team, their cards), else the waiting seat whose turn it is
  goes first. The line is "Kees neemt de plaats van Anna over." (or "… van
  Opa Dirk (AI) over."), and "Anna neemt de plaats weer in." for the same
  name again (anyone with the code may type it, so the line claims no
  more).
- A fixed table (klaverjas's training and expert mode, a game's
  `Opening.Locked`) refuses every joiner with `vol`, whose text is the
  game's; only its own player gets back in after a lost connection, by
  the seat token or by name, and not after `leave` ("Reconnect, dropping
  out and leaving" below).
- A join refused from a full lobby or after game over is told to the table:
  the system line "… wilde aanschuiven, maar de tafel is vol." and, for the
  host only, a `refused` message
  ([protocol.md, "Server → client"](protocol.md#server--client)), at most
  once per 30 s per room whatever the name (names are free text; a code
  guesser must not flood the host).

## Rematch and back to the lobby

After game over the host chooses: `rematch` starts a new match at once with
the same seats and options; `lobby` takes the room back to phase `lobby`
under the same code and options. There the humans keep their seats (except
those disconnected for longer than the 30 s host grace), bots placed in the
lobby stay, and the seats humans left, or that bots filled at the start or
took over from a human who left, are empty again, so a late friend can join
and the host can change seats, bots and options before starting. Scores
and the previous hand are cleared.
The system line says "Wie wil, kan nu aanschuiven." only when a seat is
free. A game may have rooms without a lobby (klaverjas's training and
expert mode, and a game's fixed tables: "Rooms without a lobby" below);
there `lobby` is refused.

## Rooms without a lobby

A game that implements `Opener` says how each new room opens
(`Opening`): mostly a table of its own that starts at once and that
nobody else joins (a training table), though a fixed table may keep its
lobby. The zero `Opening` is an ordinary room, and so is every room of a
game without `Opener`. The table calls `Open` once, on `create`, after
the room's options are set, with the game's own options and the create
message. The table's options (`players`, `ai`, `tempo`, `seed`) are not
passed: a game that needs them, say for `Seat` or `Bots` on a table of
several sizes, reads them from `m.Raw`, unchecked, as `create` asked
for them.

- `Seat`: the creator's seat, and the host's (a seat off the table is
  logged, and the creator sits at 0).
- `Bots`: a persona ID per seat, "" for none. These bots sit down at once
  and stay, also on `rematch`, as bots placed in the lobby do; the seats
  left empty get random bots at the start as usual. A bot the table cannot
  seat (on the creator's seat or off the table, an unknown persona, one at
  the table already) is logged and left out.
- `Start`: the match starts at once, as with `create`'s `start` (the
  creator gets the lobby state first, as one update).
- `Locked`: when not empty, the table is fixed. A joiner who would take a
  seat, in the lobby, in a match or after it, gets `vol` with this text
  (a seat its player left is no exception, and nobody is told: the host
  cannot make room). In the lobby `sit`, `bot`, `unbot` and an `opts`
  that changes `players` get `ongeldig` "Deze tafel ligt vast.", and so
  does `lobby` after game over; the other options and `start` work in a
  fixed lobby, and `rematch` after game over. The room's own player gets
  back in after a lost connection: with the seat token, and without it by
  the same name once the seat has been disconnected for 3 min; one who
  left (`leave`) does not ("Reconnect, dropping out and leaving" below).

`o` is the room's own game options: `Open` may change them (a lesson that
fixes its form), and the state shows them from the first update. It
cannot change the table's options (`players`, `ai`, `tempo`, `seed`), nor
the texts of the refused lobby commands. A game that wants its bots at
one strength on such a table, whatever `ai` says, keeps brains of its own
for them and decides with those in `Play.Decision` instead of the
table's.

Klaverjas's training and expert mode are rooms of this kind, built in,
with their own texts
([games/klaverjas/README.md](../games/klaverjas/README.md)).

## Reconnect, dropping out and leaving

- Reconnect: `join` with the room's code and the seat token returns you to
  your seat, mid-game included. Without the token (another device, cleared
  storage), a `join` with exactly the same name takes back a human seat that
  has been disconnected for at least 3 min (a locked phone keeps its seat):
  the seat gets a new token, the old one then gets `onbekend`, and a system
  line says "… speelt verder op een ander apparaat".
- A human who disconnects keeps the seat (event `away`: the connection is
  lost, `connected: false`) and plays it again on return (`back`). A second
  connection that joins with the same token takes the seat over; the old one
  gets `onbekend`.
- An explicit `leave` in the lobby empties the seat; in a match or at game
  over it makes a *left* seat: no connection, no token, the name stays for
  display (`left: true`), event `leave`, system line "Anna is vertrokken."
  Nobody plays a left seat until a joiner takes it or the others let an AI
  take it; a rematch fills it with a random bot like an empty seat, and
  `lobby` frees it.

## Takeover consent

**No AI plays a human's seat without the consent of every other connected
human.** (Bots placed in the lobby or filling seats at the start, and games
of one person with bots, are not affected.) On the turn of a player who
dropped out or left (in a phase where the game waits for a player's
decision, each game's own; no pause pending) the game waits for them. The
others are asked whether an AI may play that seat
(state `takeover`, `{seat, left}`) at once for a left seat, and for a
player who dropped out once they have been gone 10 s (`askAfter`, scaled
by `-fast` like every delay), counted from the later of the turn opening
and the drop-out; as long as someone is connected to answer. Every
connected human answers with `vote` (`players[i].vote`), naming the
question (`seat`, `left`), and may change the answer while the question is
open. When all of them said yes, an AI takes over (event `takeover`): for
a player who dropped out the substitute (a neutral bot, level normaal,
`away: true`) plays until they return ("Iedereen is akkoord: een AI-speler
speelt zolang voor Anna."); a left seat goes to a random persona at the
room's level ("Iedereen is akkoord: Opa Dirk (AI) neemt de plaats van Anna
in."), which a joiner may still take over. A no keeps the game waiting.

Unanimity is checked after every vote and whenever the voters change: who
leaves takes their vote along, and so does who drops out, except that a no
holds for `askAfter` after its voter dropped out (a reload or a phone
switching apps must not let the AI in against it; back sooner, they still
have it); who connects or joins has not voted yet. The question closes,
every vote cleared, when the player returns, an AI takes over, or a joiner
or a reclaim by name takes the seat. While nobody else is connected it
rests (`takeover` null, nobody is asked, the game pauses) but keeps a no
that still holds: whoever is back first cannot let the AI in against it
before that no has run out (a blip that drops the whole table). Consent
lasts until the player returns, and for this match only: a later drop-out
asks again, and so does a rematch for a player still gone. With one human
(alone with bots) nobody can be asked: the game waits for the player.

## Background decisions

A bot (or substitute) decides once per turn, in the background: a strong
search may use all cores for a moment. Reconnects, window switches and a
seat changing hands during the turn reuse that decision; it is played when
the think time is up (counted from the turn, or from the takeover).

## Pauses

During a pause nobody may act (`turn` is -1). Humans have no time limit.
Which events start and end a pause is each game's (klaverjas:
[games/klaverjas/README.md, "Pauses"](../games/klaverjas/README.md#pauses)).

If no human is connected, the game pauses (bots do not play, the hand
summary waits, nobody is asked); when someone returns, bots think again and
the summary countdown restarts. If the game waits for an absent player, the
question is back at once when it had been asked or that player has been
gone 10 s by then (counted as above: the pause does not reset that clock),
else once they have.

## Bot chat

What a bot says is its game's (klaverjas:
[games/klaverjas/README.md, "Bot chat"](../games/klaverjas/README.md#bot-chat);
toepen: `toepbot.Chat`). The server allows a bot at most one line per trick
and one per 8 s, scaled by Chattiness (the gap is 8 s / max(Chattiness,
0.2)); per event at most one bot speaks (two for the greeting and game
end), and about 60% of human lines get a reply attempt. A game's coach
lines (`Table.CoachChat`: a lesson step) are outside these limits; the
game says them and decides how many. A bot does not
repeat one of its last two lines for the same kind of event (numbers aside:
"20 roem" and "50 roem" are one line); it asks for another line a few times
and otherwise stays silent.

## The seed

Every deal of a match follows from its seed alone (`dealRNG`). Whoever
knows the seed while the match runs can start a game of their own with it,
with open cards (klaverjas's Oefenen or expert mode), and see every hand of
this one. So no message to any client names a seed the server drew
before the match is over: not the chat, not the state (`opts.seed` is the
option, 0 then), not an event or another message. The game log
keeps it (`match`), on the server only. At game over, right after the
event `gameOver`, the table names it in the chat for every game: "De seed
van dit spel was 482913." Klaverjas's Spelanalyse, sent only at game over,
has it as well. What uses the seed afterwards starts from there: the
Spelanalyse, the expert mode, a new game with the seed typed in. A rematch
without a chosen seed draws a new one, named at its own end.

A seed chosen in the options is the table's own choice and stays visible
to it: `opts.seed` carries it from the lobby on (the lobby shows it), and
a rematch deals from it again. The start line names no seed, chosen or
drawn, and game over names a chosen one too.

Keeping the seed out of the messages takes away the easy way, not every
way: a seed has at most nine digits, and with the source at hand someone
can search the seeds for the one that deals the cards they hold. Nothing
that needs deals nobody can know in advance (a ranking, a daily challenge)
can rest on the seed alone.

## System chat lines

System chat lines (`sys`, seat -1) from the table: joining, a join refused
because the table is full, leaving, an AI taking a seat with everyone's
consent, a player back from a substitute ("… is terug."), a seat taken back
on another device, host changes, rematch, back to the lobby (and a gone
player's seat freed), and the seed of the match at game over ("The seed"
above). Each game writes the start of every match, rematches included,
without the seed (klaverjas:
[games/klaverjas/README.md, "Chat at the start of a match"](../games/klaverjas/README.md#chat-at-the-start-of-a-match);
toepen: [games/toepen/README.md, "Server"](../games/toepen/README.md#server)).

## Calls

The people at a table may call each other with sound and video (`call.go`).
The media go directly between their browsers (WebRTC, a connection for
every two of them in the call); the server only keeps who is in the call
and passes the session descriptions on, and it logs nothing of a call. A
connected human joins with `call`, naming a session the browser makes up
(8–32 letters and digits, none another seat's), with `mic` and `cam` on or
off, and changes them with the same message; `call` with `id` "" hangs up.
Every change is an update without event (`players[i].call`; in the lobby a
`lobby` event). The call belongs to the connection: it ends when the
connection goes (`away`), when another connection takes the seat (a second
window, a reconnect, a reclaim by name) and when the seat is left or taken
over; a seat moved in the lobby keeps it, and so do a rematch and the way
back to the lobby. `rtc` passes a description (an offer or an answer, with
every address found, at most 12000 bytes) from a seat in the call to the
session it names (`to`), as `rtc` with the sender's session and seat; a
description for a session that is no longer in the call, or from a seat
that is not in it, is dropped. `call` and `rtc` share a bucket per seat:
10, then 2 a second (more: error `limiet`). The page's side is in
[frontend.md, "Calling"](frontend.md#calling).

## Game log

With the flag `-games DIR` (each pod keeps it in the volume `<game>-games`,
[deployment.md, "The game log"](deployment.md#the-game-log)), the server
writes one JSON line per event, appended to `games-YYYY-MM.jsonl` (UTC
month) by one writer goroutine behind a queue of 4096 lines (a full queue
drops a line and says so in the server log; so does a directory that
cannot be written). Used for statistics and to improve the game, and kept
for at most 12 months: the writer removes the month files older than the
current month and the eleven before it, at its start and every hour
(`gameLogMonths`).

Records, each with `t`, the `match` id and `at` (UTC):

- `match`: `version` (the commit the server was built from, as in
  `/api/health`, "dev" from source), `room`, `seed`, `game` (the game's
  name), `opts` (`GameOptions.Wire`), and `players`: `{seat, name, ip,
  device}` for people, the browser's User-Agent cut at 300 bytes, or
  `{seat, name, bot, level}`. Klaverjas's has no `game`; it always has
  `training`, and `expert` when set
  ([games/klaverjas/README.md, "Game log records"](../games/klaverjas/README.md#game-log-records)).
- `seat`: a seat that changed hands mid-match (`hand`, `player`).
- `end`: `total`, `winner`.
- `close`: a room removed before game over (`hand`, `reason`); a match cut
  short by a server restart has neither `end` nor `close`.

A game on the Game API adds its own records with `Table.Log` (toepen:
`round`); klaverjas writes `hand`, `review` and `feedback`
([games/klaverjas/README.md, "Game log records"](../games/klaverjas/README.md#game-log-records)).

## Pacing

The table's pace of a tempo (`Table.Pace`), in ms, scaled by tempo;
`-fast` multiplies everything by 0.05. Klaverjas plays by it; a game may
have pauses of its own (toepen:
[games/toepen/README.md, "Server"](../games/toepen/README.md#server)).

| | rustig | normaal | snel |
|---|---|---|---|
| bot think time (× persona Speed, ± 30%) | 1500 | 900 | 450 |
| deal animation before first action | 2000 | 1500 | 900 |
| trump/bid announcement pause | 1200 | 900 | 500 |
| completed trick on table before collect | 2200 | 1500 | 800 |
| hand summary before auto-continue (unless all humans `ready`) | 15000 | 12000 | 8000 |

The hand summary also ends as soon as every human still connected is
`ready`, including when the last one not ready leaves or drops. A game on
the Game API says how long its summary waits (`Table.Summary`); klaverjas's
waits for `ready` when one person is at the table
([games/klaverjas/README.md, "Pauses"](../games/klaverjas/README.md#pauses)).

## Limits

WebSocket messages ≤ 16 KiB (a call's session description takes several);
per connection ≤ 20 messages/s (excess:
disconnect) and ≤ 1 `join` per second (burst 3; more: error `limiet`); chat
≤ 200 characters, 1 per second with burst 5; names 1–20 characters (nothing
visible → "Speler") and never with "(AI)" in them, in any spelling (case, full
width, look-alike letters or brackets, spaces or invisible characters in
between): only bots carry it. Names and chat lose control and format
characters (bidi controls, zero-width spaces, soft hyphens, tag characters; a
zero-width joiner stays between visible characters, as in 👩‍🏫), blank fillers
(Hangul fillers, the empty Braille pattern) count as spaces, runs of whitespace
become one space, trimmed, and a character keeps at most 3 combining marks; a
chat line with nothing visible is dropped. Room creation ≤ 60 per 10 minutes
and ≤ 60 live rooms per client IP (`X-Real-IP` from nginx, else remote address;
over a limit, or `MaxRooms` reached with no idle room to replace: error
`te-veel-spellen`); ≤ 150 websocket connections per IP (more: HTTP 429 before
the upgrade). Failed joins (`onbekend`, `vol`, `gestart`) ≤ 200 per minute per
IP; then joins from that IP get `limiet` for 5 minutes, except a `join` with a
valid seat token (guessing room codes stays slow). These limits leave room for
a club on one wifi: 25 tables of four, sockets of phones that dropped out, the
old tables during a new round, a failed join per phone. Chat over the limit: error
`limiet`; over the message rate: error `limiet`, then the server closes the
connection (status 1008). WebSocket `Origin` must match
the Host (coder/websocket default) or an `-origin` pattern. The server pings a
connection that it has heard nothing from, or sent nothing to, for 25 s
(checked every 5 s; nginx and reverse proxies commonly time out idle
proxied connections at 60 s), and closes it when the pong does not come
within 20 s. The browser pings every
20 s itself and gets a `pong`, so a page that runs gets no server pings, and a
phone's radio wakes for one keepalive rather than two on clocks of their own.
