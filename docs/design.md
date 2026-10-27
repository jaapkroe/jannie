# Klaverjas — design and contracts

This document is the contract between the parts of the system. Code that
deviates from it must update it in the same change. English for code, comments
and docs; **every user-visible string is Dutch**.

Hosted at `https://klaverjas.kroes.dev` on `shrek` (see `/storage/shrek-infra`):
Nginx Proxy Manager (NPM) terminates TLS and forwards plain HTTP to
`127.0.0.1:8093`, where a rootless podman **pod** (owned by `jaap`) runs two
containers:

| Container | Image | Role |
|---|---|---|
| `klaverjas-web` | `localhost/klaverjas-web:current`, from `nginxinc/nginx-unprivileged` (Alpine; tag in the `Containerfile`) | Serves `web/` on `:8080`; proxies `/ws` and `/api/` to the server |
| `klaverjas-server` | `localhost/klaverjas-server:current`, `FROM scratch`, static Go binary | Game server on `127.0.0.1:8081` inside the pod |

No database, no accounts, no persistence: games live in memory and vanish on
restart. Everything is same-origin (no CDN, no web fonts, no analytics), so a
strict CSP is possible.

## 1. Repository layout

```
go.mod                     module klaverjas (Go 1.27), one dependency: github.com/coder/websocket
cmd/klaverjas/main.go      flags, HTTP server, graceful shutdown, -healthcheck
internal/game/             pure rules engine: cards, legal moves, tricks, roem, scoring, deal state machine
internal/bot/              bot personalities, play levels, hints/advice, chat lines
internal/server/           rooms, codes, websocket protocol, pacing, chat, limits
web/                       static frontend, vanilla ES modules, no build step
  index.html  favicon.svg  manifest.webmanifest  og.png (link preview)
  icon-full.svg  apple-touch-icon.png  icon-192.png  icon-512.png  icon-maskable-512.png
  css/app.css  css/cards.css  css/manual.css
  js/main.js … (app modules)  js/cards.js  js/sound.js  js/manual.js
  js/expert.js               the expert mode's tools, loaded only when an expert game needs them
  js/call.js                 the call with the others at the table, loaded once another person sits there
test/e2e/                  node scripts that play full games over the websocket
test/ui/                   puppeteer-core browser checks (npm install done; node_modules ignored),
                           and og-image.mjs, which renders web/og.png
deploy/                    nginx.conf, quadlet templates (*.in), npm-advanced.conf, README-deploy.md
scripts/go                 Go toolchain in a container: `scripts/go test ./...`
scripts/dev-server PORT    run the server from source on 127.0.0.1:PORT serving web/ (flags after PORT)
scripts/chrome PORT        headless Chromium with CDP on 127.0.0.1:PORT, with a fake camera and microphone
scripts/pod-check [ADDR [SITE]]  check a running pod without NPM: pages, websocket, link preview,
                           security headers (`make check`)
scripts/deploy-test        `make test`: the units through podman's quadlet generator, and how
                           `make deploy` labels, tags and refuses builds (stubbed podman/systemd)
Containerfile  Makefile  README.md
```

There is no Go toolchain on the host: always use `scripts/go`. It has no
`-race` (no cgo in the Alpine image); for that, use the Debian image:
`podman run --rm --network host -v $PWD:/src -w /src -e GOFLAGS=-buildvcs=false
docker.io/library/golang:1.27 go test -race ./...`. Node 26 is on the host for
JS tests (`node --test`).

## 2. Rules as implemented

Source: <https://nl.wikipedia.org/wiki/Klaverjassen>. Four players, two pairs;
partners sit opposite. 32 cards (7–A in four suits), 8 cards each, dealt 3-2-3.
Tables of three and two players follow the same rules with the changes in
"Three players" and "Two players" at the end of this section.

### Cards

| Code | Suit | Dutch | Symbol |
|---|---|---|---|
| `C` | clubs | klaveren | ♣ |
| `D` | diamonds | ruiten | ♦ |
| `H` | hearts | harten | ♥ |
| `S` | spades | schoppen | ♠ |

Rank codes `7 8 9 T J Q K A`; Dutch names 7, 8, 9, 10, boer (B), vrouw (V),
heer (H), aas (A). A card code is rank then suit: `JH` = harten boer, `TS` =
schoppen 10. This is the wire format everywhere.

| | Trump order (high→low) and points | Non-trump order and points |
|---|---|---|
| | B 20 · 9 (nel) 14 · A 11 · 10 10 · H 4 · V 3 · 8 0 · 7 0 | A 11 · 10 10 · H 4 · V 3 · B 2 · 9 0 · 8 0 · 7 0 |

Card points total 152; the last trick adds 10: **162** per hand.

### Seats, dealer, voorhand

Seats `0..3` clockwise; play passes to `(s+1)%4`. Team of a seat is `s % 2`
(team 0 = seats 0 and 2). The first dealer of a match is random; the dealer
moves one seat clockwise every hand. **Voorhand** = `(dealer+1)%4`; voorhand **always leads the first trick**.
The winner of a trick leads the next.

### Choosing trump (`trumpMode`)

- `utrechts` (default, "verplicht spelen"): voorhand must choose one of the four
  suits. Voorhand's team is the playing team (`spelende partij`).
- `gedraaid` ("vrij"): a random suit is turned (`turnedSuit`). Starting with
  voorhand, each player in turn says *spelen* or *passen*. The first *spelen*
  makes that suit trump and that player's team the playing team (the rest are
  skipped). If all four pass, voorhand **must** choose one of the **other three**
  suits (`forced`).

### Following suit (`rules`)

Let `led` be the suit of the first card in the trick.

1. **Trump led**: if you have trump you must play it; if you can beat the
   highest trump in the trick you must (*overtroeven*); otherwise any trump
   (*ondertroeven* is then compulsory). No trump: any card.
2. **Other suit led, you have that suit**: play any card of that suit
   (no obligation to go higher).
3. **Other suit led, you don't have it, no trumps**: any card.
4. **Other suit led, you don't have it, you have trumps**:
   - `rotterdams`: you must trump, always (also when your partner is winning).
     Must overtrump if you can beat the highest trump in the trick; if you cannot,
     you must still trump: any trump, so *ondertroeven* is then compulsory. A
     non-trump card only when you hold no trump at all. (Wikipedia's
     "Schematisch overzicht" for Rotterdams: 1 kleur bekennen, 2 in-/overtroeven,
     3 ondertroeven, 4 anders spelen; pagat.com agrees. Wikipedia's general
     sentence "Ondertroeven mag alléén als men geen andere kleur kaarten dan
     lagere troeven in handen heeft" is the Amsterdams rule below.)
   - `amsterdams` (default):
     - partner currently winning the trick: free choice among non-trump cards and
       trumps that beat the highest trump in the trick; *ondertroeven* (a trump
       that does not beat the trick's highest trump) only if nothing else is
       allowed.
     - otherwise: must play a trump that beats the trick's highest trump (any
       trump if none in the trick); if you can't, play a non-trump card; only if
       you hold nothing but lower trumps, undertrump.

The winner is the highest trump in the trick, else the highest card of `led`.
Illegal moves are impossible (no *verzaken*); the server rejects them.

### Roem (bonus points, "roem op tafel")

Counted per trick from the four cards in it, for the team that wins the trick,
automatically (no claiming):

| Roem | Points |
|---|---|
| Driekaart: 3 consecutive in one suit | 20 |
| Vierkaart: 4 consecutive in one suit | 50 |
| Stuk: heer + vrouw of trump in the trick | 20 (adds to a sequence) |
| Vier gelijke: four aces, tens, kings or queens | 100 |
| Vier boeren | 200 |

Sequences use the natural order 7-8-9-10-B-V-H-A (not trump order). Four 7s, 8s
or 9s are worth nothing. Roem items are reported per kind:
`drie` (20), `vier` (50), `stuk` (20), `vierGelijk` (100), `vierBoeren` (200).

### Scoring a hand

- `points[t]`: card points of tricks won + 10 for the last trick.
- `roem[t]`: roem of tricks won. A team that wins all 8 tricks gets **pit**
  (also *doormars*): +100 roem.
- Playing team `P`, defenders `D`. `P` must score **strictly more than half** of
  `points[P]+points[D]+roem[P]+roem[D]`, i.e. `points[P]+roem[P] > total/2`.
  A tie is nat.
- **Nat**: `P` scores 0; `D` scores 162 + all roem of both teams (+100 pit if `D`
  took every trick, already in `roem[D]`).
- Otherwise each team scores its own `points + roem`.

A match is `hands` hands (default 16, *een boom*); highest total wins; a tie
is a draw ("gelijkspel").

### Three players (Wikipedia "Klaverjassen met drie personen")

- Seats `0..2` clockwise; every player has a score of their own. Each gets
  10 cards (dealt 3, then 2 to the **talon**, 4, 3); the talon's two cards
  lie closed on the table.
- **Auction** (phase `auction`), starting with voorhand, clockwise: a bid is
  the points (card points plus roem) one promises to make playing alone:
  at least `MinBid` 80, then each bid at least `BidStep` 10 higher, at most
  `MaxBid` 300; or pass. Who passed is out. Once two players passed, the
  third plays alone (the **soloist**) at its highest bid; when nobody bid,
  the last one left plays for 80 (`forced`). Trump mode does not apply.
- **Discards** (phase `discard`): the soloist takes the talon (12 cards) and
  lays two cards away face down; their card points count for the soloist at
  the end of the hand (roem in them does not). Then the soloist chooses
  trump (phase `trump`, any suit). Voorhand leads the first trick.
- Tricks of three cards; roem per trick as with four (driekaart and stuk can
  occur). The soloist's two opponents are partners for the hand: the
  Amsterdams partner rule applies between them.
- Sides: the soloist is side 0, the other two side 1 (`Deal.Side`).
  `points`, `roem` and `score` of a hand are per side; card points of both
  sides add up to 162 with the discards.
- **Scoring**: the soloist makes it when its points plus roem are at least
  the bid (`ScoreSolo`). Made: each side scores its own points plus roem.
  Nat: the soloist scores 0 and side 1 scores 162 plus all roem. Side 1's
  two players each get half of side 1's score, rounded up (`gains`). Pit
  (all 10 tricks): +100 roem for that side.
- Choices made where Wikipedia leaves room: the discards count for the
  soloist (one of its variants; the total stays 162), the minimum bid is 80
  in steps of 10, a forced soloist plays for 80, and nat gives the other two
  everything, as with four.

### Two players (Wikipedia "Klaverjassen met twee personen")

- Seats `0` and `1`, opposite. Each gets 16 cards laid out as **eight piles
  of two** in two rows of four: pile `i` (0..7) is cards `i` (on top) and
  `8+i` (under it) of the dealt 16; piles 0..3 are the front row, nearest
  the player. The top cards of the front rows are face up from the deal.
- Trump as `trumpMode` says (utrechts: voorhand chooses; gedraaid: a turned
  suit, voorhand then dealer say spelen or passen, both pass → voorhand
  chooses another suit). Then the top cards of the back rows turn face up.
- **Roem in the open cards**: the moment trump is known, the roem in each
  player's eight face-up cards counts for that player (`SetRoem`: every run
  of three (20) or four or more (50) in a suit, all four of a rank (100,
  boeren 200), stuk). In a two-card trick only stuk can still occur.
- Only face-up cards can be played; following suit and trumping apply to
  the face-up cards (no partner: Amsterdams and Rotterdams agree). When a
  trick is complete, the cards under the ones played turn face up.
- 16 tricks; last trick +10, pit (all 16) +100 roem. Scoring as with four:
  the player who made trump must make more than half, else nat. Sides are
  the seats.

## 3. Options

Set by the host in the lobby; JSON keys on the wire:

| Key | Values | Default | Meaning |
|---|---|---|---|
| `players` | 2, 3, 4 | 4 | Seats at the table: the game of §2 for four, three or two players. Empty seats at the start get random bots. Training is always 4 |
| `hands` | 4, 8, 12, 16, 20, 24 | 16 | Hands in the match |
| `trumpMode` | `utrechts`, `gedraaid` | `utrechts` | §2 |
| `rules` | `amsterdams`, `rotterdams` | `amsterdams` | §2 |
| `ai` | `makkelijk`, `normaal`, `sterk` | `normaal` | Strength of every bot in the room |
| `tempo` | `rustig`, `normaal`, `snel` | `normaal` | Pacing of bots and pauses (§6) |
| `open` | bool | false | Training only: show all hands face up |
| `lessons` | bool | false | Training only: Juf Jannie explains the game step by step (§6 Lessons; *Speluitleg*, on in the Oefenen sheet as last chosen, `kj.lessons`) |
| `signals` | `{"aas","kleintjeBoer","hoogLaag","boerOverBoer"}`, bools | all true but `boerOverBoer` | The table's agreements on signals (§8), for four players; keys left out keep their default |
| `seed` | 1..999999999, or 0 / null | 0 | Every match deals from a seed: with this one the same cards (first dealer, hands, talon, turned suit) for the same options and number of players, also on `rematch`; 0 draws a new seed per match. The start line in the chat and the Spelanalyse show the seed of the match. The client never remembers it in `kj.opts` |
| `from` | 1..24, or 0 / null | 0 | Expert only (else 0): the match is hand `from` of the seed's deals alone, dealt as in the whole match (the deals before it are drawn and passed over, the deal passing on as often) and numbered so; `hands` is raised to a length that holds it. 0: the whole match |

The UI label for the variant is "Utrechts/Amsterdams" etc.: `trumpMode` +
`rules`; with three players "Met z'n drieën, Amsterdams" (no trump mode: they
bid), with two "Met z'n tweeën, Utrechts" (no rules: nobody has a partner).

**Training mode** (`training: true` at create) is a solo room: 1 human at seat
0, partner bot **Juf Jannie** at seat 2, two random opponents, tempo `rustig` by
default, hints on, explanatory tips after every trick (the last trick of a
hand waits for its tip, §6; each tip is a line of Juf Jannie in the chat too),
nobody else can join. With option `lessons` Juf Jannie also teaches the game
step by step (§6 Lessons).

**Expert mode** (`expert: true` at create, issue #34; reached only by an
easter egg on the home screen, §9) is a solo room as well: 1 human at seat 0,
three random bots at the room's level, always four players, `open` allowed,
no hints or tips, nobody else can join ("Dit is een expertspel; daar kun je
niet aan meedoen."), no lobby (it starts at once; `lobby` is refused, a
`rematch` plays the same seed and hand again). It deals from `seed` and
`from`, and adds the state's `expert` part, `why`, `mark` for any seat and
feedback about one decision, while the match runs and after it (§6, §7).

## 4. Go API contracts

Exact names may gain helpers, but these exported identifiers and semantics are
what other packages use. Changing them means updating this section.

### 4.1 `internal/game`

```go
type Suit uint8   // Clubs, Diamonds, Hearts, Spades  (wire "C","D","H","S")
type Rank uint8   // Seven, Eight, Nine, Ten, Jack, Queen, King, Ace (natural/sequence order)
type Card struct{ Rank Rank; Suit Suit }
func (c Card) String() string            // "JH"
func ParseCard(s string) (Card, error)
func (s Suit) String() string            // "H"
func ParseSuit(s string) (Suit, error)
func (c Card) MarshalJSON / UnmarshalJSON // as the string code; same for Suit
func NewDeck() []Card                    // 32 cards, ordered
func SuitNameNL(s Suit) string           // "harten"; also CardNameNL(c) "harten boer"

type Seat int                            // 0..3; func (s Seat) Next() Seat; Partner(); Team() int (four players)
type Rules uint8                         // Amsterdams, Rotterdams  (JSON "amsterdams"/"rotterdams")
type TrumpMode uint8                     // Utrechts, Gedraaid      (JSON "utrechts"/"gedraaid")

func Points(c Card, trump Suit) int
func Beats(a, b Card, led, trump Suit) bool          // a beats b in a trick with this led suit
type Played struct{ Seat Seat; Card Card }            // JSON {"seat":2,"card":"JH"}
type Trick struct {
    Leader Seat
    Cards  []Played
    Winner Seat      // valid when len(Cards)==4, else -1
    Points int       // card points (+10 if last trick) when complete
    Roem   []RoemItem
}
func (t Trick) Led() (Suit, bool)
func (t Trick) CurrentWinner(trump Suit) (Seat, bool)  // who is winning so far
type RoemItem struct{ Kind string; Points int }       // JSON {"kind":"stuk","points":20}
func TrickRoem(cards []Card, trump Suit) []RoemItem

// Legal cards for `seat` holding `hand`, given the current (incomplete) trick
// (four players: the partner is the seat opposite; a Deal knows every table).
func LegalMoves(hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) []Card
// Short Dutch explanation of the constraint, shown above the hand on your turn:
// "Je komt uit: speel wat je wilt", "Bekennen: speel ♦", "Troef gevraagd: overtroeven",
// "Je moet troeven", "Je moet overtroeven", "Je maat heeft de slag: vrije keuze",
// "Je kunt niet bekennen en hebt geen troef: vrije keuze", ...
func ExplainConstraint(hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) string
// Why a specific card is illegal (Dutch), "" if legal: "Je moet bekennen (♦).", ...
func ExplainIllegal(card Card, hand []Card, trick Trick, seat Seat, trump Suit, rules Rules) string

// Display order: suits alternate colour, trump (if known) first; within a suit low→high
// by the order that applies (trump order for trump).
func SortHand(hand []Card, trump Suit, trumpKnown bool) []Card

type Phase string // "auction", "discard" (three players), "trump", "bid", "play", "done"

// One hand ("potje") for 2, 3 or 4 players: a pure state machine. No timing,
// no randomness inside.
type Deal struct { /* unexported fields */ }
func NewDeal(dealer Seat, hands [4][]Card, mode TrumpMode, rules Rules, turned Suit) *Deal  // four players
func NewDealFor(players int, dealer Seat, hands [4][]Card, talon []Card, mode TrumpMode, rules Rules, turned Suit) *Deal
func Shuffle(rng *rand.Rand) [4][]Card   // math/rand/v2, deal 3-2-3
func ShuffleFor(players int, rng *rand.Rand) (hands [4][]Card, talon []Card) // §2: 3-2-3; 3, talon, 4, 3; 16 each (piles)
func (d *Deal) Phase() Phase
func (d *Deal) Turn() Seat               // whose action is awaited; -1 if done
func (d *Deal) ChooseTrump(seat Seat, s Suit) error   // utrechts, forced after all passed (not the turned suit), or the soloist
func (d *Deal) Bid(seat Seat, play bool) error        // gedraaid
func (d *Deal) Auction(seat Seat, bid int) error      // three players: bid (MinNextBid()..MaxBid, steps of BidStep) or 0 to pass
func (d *Deal) Discard(seat Seat, cards []Card) error // three players: the soloist lays two cards away
func (d *Deal) Play(seat Seat, c Card) error          // validates the rules (partner per table)
func (d *Deal) Hand(seat Seat) []Card                 // the cards seat can play: with two players its face-up ones
func (d *Deal) Trump() (Suit, bool)
func (d *Deal) TrumpBy() Seat            // -1 before trump is known
func (d *Deal) PlayingTeam() int         // side of the trump maker (Side), -1 before trump is known
func (d *Deal) Forced() bool             // gedraaid: all passed, voorhand must choose; three players: nobody bid
func (d *Deal) Players() int
func (d *Deal) Side(seat Seat) int       // team with four; with three 0 = soloist, 1 = the other two; with two the seat
func (d *Deal) Partner(seat Seat) Seat   // opposite with four; with three the other opponent of the soloist; else NoSeat
func (d *Deal) Contract() (Seat, int)    // three players: highest bid and bidder (the soloist once the auction is over)
func (d *Deal) MinNextBid() int
func (d *Deal) Talon() []Card            // three players: the two cards of the talon
func (d *Deal) Discards() []Card         // three players: what the soloist laid away (after phase discard)
func (d *Deal) Piles(seat Seat) [8]Pile  // two players: {N, Up, Card} per pile
func (d *Deal) OpenRoem(seat Seat) []RoemItem // two players: roem of the face-up cards once trump is known
func (d *Deal) Constraint() string       // ExplainConstraint for the seat on turn
func (d *Deal) Turned() Suit
func (d *Deal) Bids() [4]int             // -1 none yet, 0 pass, 1 play
func (d *Deal) Current() Trick           // trick in progress (may be complete until next Play)
func (d *Deal) Tricks() []Trick          // completed tricks, in order
func (d *Deal) Result() HandResult       // valid when Phase()=="done"
func (d *Deal) View(seat Seat) View      // everything `seat` may know

type HandResult struct {
    Players int; PlayingTeam int; TrumpBy Seat; Trump Suit; Dealer Seat
    Points [2]int; Roem [2]int            // per side, raw, before nat
    Score  [2]int                         // per side
    Nat bool; Pit bool; PitTeam int       // PitTeam -1 if none
    Bid int; Discards [2]Card             // three players
    Gains [4]int                          // per scorer (Scorers): what goes on the score sheet
}
func Scorers(players int) int             // 2 teams with four players, else one per player
func ScorerOf(seat Seat, players int) int
func ScoreSolo(bid int, points, roem [2]int) (score [2]int, nat bool) // three players
func SetRoem(cards []Card, trump Suit) []RoemItem // roem in up to eight open cards (two players)
type Pile struct{ N int; Up bool; Card Card }     // JSON {"n":2,"card":"JH"|null}

type View struct {
    Players int; Seat Seat; Hand []Card; Dealer Seat; Voorhand Seat
    Mode TrumpMode; Rules Rules; Phase Phase; Turn Seat   // Turn: NoSeat when done
    Trump Suit; TrumpKnown bool; TrumpBy Seat; PlayingTeam int; Partner Seat
    Turned Suit; Bids [4]int; Forced bool
    Bid int; Bidder Seat; Talon, Discards []Card   // three players (talon and discards: the soloist only)
    Piles [2][8]Pile; OpenRoem [2][]RoemItem       // two players
    Current Trick; Tricks []Trick          // full history of this hand (bots may remember)
    Legal []Card                           // when it is Seat's turn in phase play
    HandNo, HandsTotal int; MatchScore []int    // zero from Deal.View; the server fills them
}
```

Semantics and additions (implemented in `internal/game`):

- `View.Current` is the trick the next card goes into: once a trick is complete
  it is already the next, empty trick led by the winner (the completed one is the
  last of `View.Tricks`); when done it is the last trick. `Deal.Current()` keeps
  the complete trick until the next `Play` (for display). `LegalMoves` and friends
  treat a complete trick as empty (next card leads).
- `Deal.Tricks()` includes a completed trick that is still `Current()`.
- `HandResult.Roem` includes the `PitBonus` (100); `Deal.HandRoem()` does not.
- Errors (Dutch texts, safe to show): `ErrWrongPhase`, `ErrNotYourTurn`,
  `ErrBadSuit`, `ErrTurnedSuit`, `ErrNotInHand`, `ErrIllegal`, `ErrBadBid`
  (wrapped with the lowest bid allowed), `ErrBadDiscard`; `Play` returns
  `*IllegalError{Card, Reason}` (Reason = `ExplainIllegal` text,
  `errors.Is(err, ErrIllegal)`).
- Constants/names: `NumSuits`, `NumRanks`, `NoSeat` (-1), `PhaseTrump/Bid/Play/Done`,
  `RoemDrie/Vier/Stuk/VierGelijk/VierBoeren`, `PitBonus`, `LastTrickBonus`;
  `Suit.Symbol()` "♥", `Suit.Red()`, `Rank.NameNL()` "boer", `Rank.Letter()` "B",
  `CardShortNL(c)` "♥B", `RoemItem.NameNL()` "stuk"/"driekaart"/"vier gelijke",
  `Rules.NameNL()`/`TrumpMode.NameNL()`, `ParseRules`, `ParseTrumpMode`,
  `Seat.Valid()`, `Card.Valid()`, `Card.Index()`/`CardFromIndex` (0..31),
  `MustParseCards("JH 9H")` (tests); all these types also implement
  `encoding.TextMarshaler`.
- Rules helpers: `Order(c, trump)` (0..7 within suit), `TrumpOrder(r)`,
  `PlainOrder(r)`, `CardPoints(cards, trump)`, `ScoreHand(playingTeam, points,
  roem) (score, nat)`, `Trick.Complete()`, `Trick.Next()` (seat to play),
  `Trick.WinningCard(trump)`, `Trick.RoemTotal()`; `Trick` marshals empty
  `cards`/`roem` as `[]`.
- Fast paths for simulation (no allocations): `AppendLegalMoves(dst, hand, trick,
  seat, trump, rules)`, `IsLegal(card, hand, trick, seat, trump, rules)`,
  `AppendTrickRoem(dst, cards, trump)`, `RoemPoints(cards, trump)`;
  on card sets as bitmasks (`uint32`, bit `Card.Index` per card):
  `d.HandMask(seat)` (as `d.AppendHand`) and `d.LegalMask()` (as
  `d.AppendLegal`; 0 outside phase play);
  `Deal` holds no slices or maps, so `*dst = *src` (or `d.Clone()`) is a full
  independent copy; `d.AppendLegal(dst)`/`d.Legal()` for the seat on turn,
  `d.AppendHand(dst, seat)`, `d.HandLen(seat)`, `d.TrickCount()`.
  `Resume(v View, hands [4][]Card) (*Deal, error)` rebuilds a deal in phase play
  from a view plus every seat's remaining cards (e.g. sampled hidden hands);
  with three players `v.Discards` must hold the (sampled) discards, with two
  `hands[s]` holds only seat s's face-down cards, pile by pile.
  `ResumeInto(d *Deal, v *View, hands) error` is `Resume` into an existing
  Deal, which it overwrites (after an error d is unusable), so a search
  reuses one Deal per worker; `NewDeal`/`NewDealFor` are small enough to be
  inlined, so a deal that does not outlive its caller stays off the heap.
- A Deal holds every seat's cards at the places they were dealt (16 places
  per seat) with masks for played and face-up cards, so copying it stays a
  full copy for every table size. It also keeps each seat's playable cards
  as a mask (with the place of each), and the current trick's winning card
  and highest trump as cards are played, so the rules need no loop over the
  hand, and `Play` judges only a card that neither leads nor follows a side
  suit led (those are always allowed).
- Deal accessors for the server: `Dealer()`, `Voorhand()`, `Mode()`, `Rules()`,
  `TricksWon() [2]int`, `HandPoints() [2]int` (incl. last trick),
  `HandRoem() [2]int`.

Tests in `internal/game` are table-driven and exhaustive for: legal moves in
both rule sets (all branches above), trick winner, roem (each kind, combos,
stuk+sequence, four of a kind, no false positives), scoring (normal, nat, tie =
nat, pit, pit by defenders), deal state machine (both trump modes, forced
choice, turn order, last-trick bonus, 162 total); for three and two players
the auction, discards, piles, open roem, random deals against the reference
rules, and Resume. The random deals also check the bitmask fast paths
(`HandMask` for every seat, `LegalMask`) against the reference, and
`ResumeInto` against `Resume`. Benchmarks: `BenchmarkPlayout` (a hand of
random legal cards played out on a copy of a Deal), `BenchmarkLegalMoves`,
`BenchmarkRoemPoints`.

### 4.2 `internal/bot`

```go
type Level int  // Makkelijk, Normaal, Sterk; String() "normaal"
func ParseLevel(s string) (Level, error)    // "makkelijk"|"normaal"|"sterk"; error → Normaal
type Persona struct {
    ID, Name, Emoji, Color, Bio string   // Name without "(AI)"; Bio is Dutch, one line
    Aggression float64  // 0..1: willingness to play/choose trump on weaker hands, to go for pit
    Chattiness float64  // 0..1: chance of commenting on events
    Speed      float64  // multiplier on think time (0.6 fast .. 1.4 slow)
}
func Roster() []Persona                       // 8 personas, §5
func ByID(id string) (Persona, bool)

type Player interface {
    ChooseTrump(v game.View) game.Suit       // utrechts, forced (must not return v.Turned when v.Forced), or the soloist
    Bid(v game.View) bool                    // gedraaid: play on v.Turned?
    Auction(v game.View) int                 // three players: a bid of at least v.MinNextBid(), or 0 to pass
    Discard(v game.View) [2]game.Card        // three players: two cards of v.Hand to lay away
    Play(v game.View) game.Card              // must be in v.Legal
}
func New(p Persona, lvl Level, seed uint64) Player

// Advice for the training hints, Dutch text. Trump and bid advice is the
// sterk choice. A play hint gives the reason of what chose its card, so
// the two cannot drift apart (why.go):
//   - The normaal policy returns with each card the rule that chose it
//     (decide: rule). The hint is that card with the rule's reason, and
//     what the rule's own costs weighed: the cheaper or richer card it
//     kept in hand and why ("Met ♠H zou je de tegenstanders 50 roem
//     geven", "♠A is de hoogste schoppen en kan zelf nog een slag halen"),
//     and for a lead the roem that decided it ("met ♠8 kunnen de
//     tegenstanders in deze slag roem maken: ♠7, ♠9 en ♠10 zijn nog in het
//     spel").
//   - Unless the sterk card is better by at least max(5 points, 2 paired
//     SE): then the hint is that card, with how much more it brings than
//     the rule's card and in which part of the value mainly. The search
//     keeps per card, from the same playouts, the points and the roem in
//     the card's own trick and in the later tricks (ours minus theirs) and
//     what nat and pit add; they sum to the value ("Speel ♠V: volgens de
//     berekening levert dat gemiddeld 9 punten meer op dan ♠8, vooral in
//     de roem van deze slag").
//   - What the card signals at the table (§8) is added: true, or a
//     warning when the partner would read something untrue.
// Every play hint opens with "Speel ♠V: ". The search values every option
// by the points it brings alone: the bots' appetite for pit (Aggression)
// plays no part.
type Advice struct {
    Card *game.Card; Suit *game.Suit; Play *bool
    Text string     // e.g. "Speel ♥A: je maat heeft de slag nog niet en de aas is hoog."
}
func Advise(v game.View) Advice
// Dutch explanation of a finished trick for training tips:
// "Fatima (AI) wint de slag met ♥B, de hoogste troef. 25 punten, roem: stuk (20)."
func ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
// The signals (§8) in the last completed trick of v at a table of four, as
// the table reads them (true or not), for the lessons: Kind
// "kleintjeBoer", "boerOverBoer" (a lead), "aas" or "hoogLaag" (a low
// discard); Means the card it says Seat holds (the trump boer, the 10, the
// highest card left in the suit). SignalChance: a signal the player of v
// can give truthfully with a legal card on their turn, prefer first.
type Signal struct{ Seat game.Seat; Card game.Card; Kind string; Means game.Card }
func TrickSignals(v game.View) []Signal
func SignalChance(v game.View, prefer game.Card) (Signal, bool)

// The review at the end of a match (§9 Spelanalyse). GradeChoice runs the
// search of Advise on the same view (same seed), so it agrees with the hint.
// Points are expected score differences between the teams, as in the hints:
// the player's team's score minus the opponents' at the end of the hand
// (nat and pit included), averaged over the sampled deals (400 for a card,
// 320 for a trump choice or bid), each played out by the normaal policy.
type Choice struct{ Card *game.Card; Suit *game.Suit; Play *bool } // exactly one set
type Grade struct {
    Stake   float64 // best minus worst option; 0 without a choice (one legal card)
    Lost    float64 // the hint's option minus the choice when that is at least
                    // max(5, 2 paired SE), the hint's tolerance; else 0
    Gain    float64 // a strong move: the choice is the hint's option, the normaal
                    // choice differs and is worse by at least max(10, 2 paired SE); else 0
    Better  Choice  // the hint's option, when Lost > 0
    Obvious Choice  // the normaal option, when Gain > 0
    Text    string  // the hint for Better (Lost > 0) or for the choice (Gain > 0)
    Nat     float64 // a bid to play: the estimated chance of going nat
    Played, Other Outcome // the choice and Better or Obvious, when Lost or Gain is set:
                    // Lost = Other.Us−Other.Them − (Played.Us−Played.Them), Gain the reverse
}
// What an option leads to, averaged over the sampled deals: the final score
// of the player's team and of the opponents, and the chance that the one or
// the other plays and goes nat.
type Outcome struct{ Us, Them, NatUs, NatThem float64 }
func GradeChoice(v game.View, c Choice) Grade
// The expert mode's reasoning for one decision of v.Seat (on its turn, a
// table of four; else, or should the search fail, empty). It searches as
// Advise (same view, same seed, the same 400 or 320 deals, points alone),
// so it agrees with the hint and the review.
type Explanation struct {
    Normaal  Choice   // the normaal choice (the rule-based card, bestTrumpNormal, the bid threshold at aggression 0.5)
    Rule     string   // a card: the hint text of the rule that chose it ("Speel ♠A: …"); else ""
    Sterk    Choice   // sterk's pick from this search at average aggression (sterkPick, the bid without bias)
    Hint     Choice   // the hint (Advise)
    HintText string
    Worlds   int      // deals per option; 0 with one legal card (no search)
    Options  []Option // the legal cards (in v.Legal order), the allowed suits, or spelen then passen
}
type Option struct {
    Choice
    Value float64   // expected score difference, as in Grade
    SE    float64   // paired standard error of its difference with the best option; 0 for the best
    Outcome
    Parts []float64 // a card: points in its trick, in later tricks, roem in its trick, in later tricks,
                    // nat and pit (searchWhy's parts); they sum to Value less what was scored before it
}
func Explain(v game.View) Explanation
// What the cards dealt to v.Seat are worth to its team against an average
// hand in the same seat: the mean score difference when the hand is played
// from the deal by the normaal policy (bids and trump choice included) over
// 320 sampled deals of the other cards, minus the same over 20000 random
// deals (computed once per trump mode and rules). v is the view at the deal.
func HandLuck(v game.View) float64

// Personality chat. Returns "" for silence; the server rate-limits on top.
type ChatEvent struct {
    Kind string   // "greet","trump","pass","play","wonTrick","roem","nat","natOpp","pit","handWon",
                  // "handLost","gameWon","gameLost","partnerGood","reply"
    Mine bool     // about the bot itself / its team; "reply": the bot is the speaker's partner
    Text string   // for "reply": the human chat line being answered
    Points int    // roem/points involved
    InHand, Playing bool // "reply": tricks are being played; the bot's team made trump
}
func Chat(p Persona, ev ChatEvent, rng *rand.Rand) string
```

Strength levels:

- **makkelijk**: legal moves with simple heuristics and deliberate mistakes
  (~30% random legal card), naive trump choice (longest suit) and bidding (on
  the boer or on length; Aggression moves the bar, e.g. cautious personas want
  the boer with another trump, bold ones also play on the nel with two more).
- **normaal**: rule-based play: win tricks with the cheapest winning card (a
  cheap side-suit trick is ruffed with the lowest trump that wins, not with
  the boer or nel), give points (*spekken*, also *smeren*: a 10 or ace) when
  the partner is winning, discard low otherwise, pull trumps when playing
  team, keep the nel/boer guarded, count trumps played, sensible trump choice
  (boer/nel/aas/length). Gives and reads kleintje boer (§8) and never leads a
  small side card that would falsely promise the boer when it has another
  lead. Holding the ace and the 10 of a side suit it leads the 10 first: it
  wins just as surely, can still bring roem (the ace only with heer and
  vrouw), and leaves the ace on top (in self-play +1.2 points per hand over
  ace first). It never leads under its own ace, gives the ace with its 10
  to the partner's trick (aas vraagt 10, §8) but avoids an ace without it,
  avoids a low discard that would falsely claim the highest card of its
  suit (laag bijspelen), and leads into a suit whose highest card the
  partner signalled. Leading, it weighs roem: every side card is a
  candidate, and each run of three through it whose two other cards are
  still out with two other players counts 8 points for the team that
  probably takes the trick: the mover's with the highest card of the suit
  or in the suit of the partner's signalled highest card (when nobody is
  known to ruff it), else the opponents'. So it leads ♦H from ♦H ♦V
  rather than ♠8 with ♠7 ♠9 ♠10 out. In duplicate self-play against the
  lead without roem this gains normaal 3.3 points per hand. Sterk already
  weighs roem at its own lead through the search's score; that its
  playouts now lead the same way changes it by −0.2 ± 0.65 points per
  hand (24,000 deals), nothing measurable.
- **sterk**: card tracking with inference (voids from not following suit,
  trump obligations), determinised Monte Carlo: sample hidden hands consistent
  with everything known, evaluate each legal move by playouts with the normaal
  policy, ~150–400 samples within ~150 ms; trump choice by simulation; reads the
  signals of §8 (aas vraagt 10, kleintje boer, laag bijspelen) as soft
  evidence. It gives kleintje boer when that costs at most a few points, and
  fakes it (a small side card without the boer) only when that gains clearly
  (≥ 10 points), a false laag bijspelen or aas vraagt 10 only for ≥ 20
  points, since partners and humans read the signals as promises. Between
  cards that win and lose alike (no card still out lies between them, as
  ♥A and ♥10 in one hand), it plays the normaal card unless the search
  rates the other higher by more than the hints' tolerance (5 points, or
  two paired standard errors); the hints and the Spelanalyse do the same. Exactly equal search
  results go to the rule-based card, then to the cheaper card.

Each persona modulates its level's choices (Aggression shifts thresholds) and
chat. `internal/bot` has an arena test (skipped with `-short`) that plays many
hands between levels and asserts sterk > normaal > makkelijk in average points.
Its benchmarks (`bench_test.go`) time the sterk decisions: with four players
the first lead (also on one core), a card mid-hand, the trump choice and the
bid; at the smaller tables a card, the trump choice, the bid with two, the
auction and the discard with three; a training hint, the grades of one
player's hand and the same with a hint before each, `HandLuck`; and a whole
hand of sterk bots at four, three and two players on one core each, the CPU
a table of bots costs per hand. `TestIdentity`, skipped without
`-identity.out=FILE`, writes for 384 seeded deals every decision of every
level, the hints, grades and explanations and the raw search statistics to
FILE: a change that must keep every decision (a speed-up) leaves it byte for
byte the same.

At a table of three or two (`internal/bot/small.go`, `smallsearch.go`) the
levels keep their meaning with their own policy; the signals of §8 play no
part. Normaal plays by rules of thumb: the side that made trump draws trumps
while it holds the strongest, everyone cashes cards that win for sure (with
two players the opponent's answers are known from its face-up cards), the
soloist's opponents give points to each other's sure tricks, otherwise win
cheaply or throw the least useful card. Sterk samples the hidden cards
(three players: the others' hands and, for the opponents, the soloist's
discards, within the voids play has shown; two players: the face-down cards)
and plays every legal card out with that policy, three times as many deals
as with four (the playouts are short). In the auction every level plays out
deals in which it plays alone with the talon (soloPlan lays away a bare 10
or a short side suit and picks trump) and bids while playing alone is worth
more than defending (fitted in self-play); makkelijk with few deals and too
boldly. The arena test also checks sterk > normaal > makkelijk at both
smaller tables.

### 4.3 `internal/server`

`internal/server` does **not** import `internal/bot`: it defines the interface
it needs, and `cmd/klaverjas/ai.go` adapts package `bot` to it. Server tests
use a fake AI (first legal card), so the two packages build independently.

```go
type Persona struct{ ID, Name, Emoji, Color, Bio string; Chattiness, Speed float64 }
type Brain interface {
    ChooseTrump(v game.View) game.Suit
    Bid(v game.View) bool
    Auction(v game.View) int            // three players
    Discard(v game.View) [2]game.Card   // three players
    Play(v game.View) game.Card
}
type Advice struct{ Card *game.Card; Suit *game.Suit; Play *bool; Text string }
type Choice struct{ Card *game.Card; Suit *game.Suit; Play *bool }                   // as bot.Choice
type Grade struct{ Stake, Lost, Gain float64; Better Choice; Text string; Nat float64 } // as bot.Grade
type Explanation struct{ Normaal Choice; Rule string; Sterk, Hint Choice; HintText string; Worlds int; Options []Option } // as bot.Explanation
type Option struct{ Choice; Value, SE float64; Outcome; Parts []float64 }
type ChatEvent struct{ Kind string; Mine bool; Text string; Points int; InHand, Playing bool } // as bot.ChatEvent
type Signal struct{ Seat game.Seat; Card game.Card; Kind string; Means game.Card }           // as bot.Signal
type AI interface {
    Personas() []Persona
    NewBrain(personaID, level string, seed uint64) Brain   // level "makkelijk"|"normaal"|"sterk";
                                                           // personaID "" = neutral substitute for a human who
                                                           // dropped out, once the others agreed (§6)
    Advise(v game.View) Advice
    Grade(v game.View, c Choice) Grade    // the review (§6 Spelanalyse)
    HandLuck(v game.View) float64
    Explain(v game.View) Explanation      // the expert's why (§7)
    ExplainTrick(t game.Trick, trump game.Suit, names [4]string) string
    TrickSignals(v game.View) []Signal                    // the lessons (§6)
    SignalChance(v game.View, prefer game.Card) (Signal, bool)
    Chat(personaID string, ev ChatEvent, rng *rand.Rand) string
}
type Config struct {
    AI   AI
    Fast bool           // scale all delays by 0.05 (tests)
    MaxRooms int        // default 500
    AllowedOrigins []string // websocket Origin patterns besides same-host
    Version  string     // reported by /api/health {ok, version, rooms, players}
    Logger   *slog.Logger // nil: slog.Default()
}
func New(cfg Config) *Server
func (s *Server) Handler() http.Handler   // /ws, /api/health
func (s *Server) Shutdown(ctx context.Context)
```

`cmd/klaverjas` flags: `-addr 127.0.0.1:8081`, `-static DIR` (dev only: also
serve the frontend, with the same `/^[A-Za-z]{4}$/` → index.html rule as nginx,
`Cache-Control: no-cache` and the nginx CSP),
`-fast`, `-origin PATTERN` (repeatable), `-healthcheck` (GET
`http://127.0.0.1:8081/api/health`, exit 0/1; the scratch image has no curl).
Logs with `log/slog` to stdout. Never log chat text or tokens.

Each room is an actor: one goroutine owning all room state, fed by a command
channel; timers via `time.AfterFunc` posting back into the channel. Each
connection has a reader and a writer goroutine with a bounded send queue (a
client that falls behind is disconnected; it resyncs on reconnect).

## 5. Bots

Display name is always `"<Name> (AI)"`, built by the server into
`players[i].name`. Eight personas (IDs fixed):

| ID | Name | Emoji | Character |
|---|---|---|---|
| `dirk` | Opa Dirk | 👴 | Speelt al zestig jaar in café De Klaver. Voorzichtig en degelijk; spreekwoorden. |
| `truus` | Tante Truus | 👵 | Kletst honderduit en is dol op roem; optimistisch. |
| `sjaak` | Sjaak | 🎲 | Gokker: speelt op dunne handen en gaat voor de pit. |
| `fatima` | Fatima | 🧠 | Wiskundestudent die elke kaart telt; kort van stof. |
| `kees` | Kees de Visser | 🎣 | Mopperkont, maar eerlijk; moppert als hij nat gaat. |
| `jannie` | Juf Jannie | 👩‍🏫 | Geduldige juf die graag uitlegt; partner in de oefenmodus. |
| `bram` | Bram | 🛹 | Jong en snel, speelt op gevoel, chat met emoji. |
| `vera` | Bakker Vera | 🥐 | Staat om vijf uur op, speelt scherp en vriendelijk. |

Chat lines are Dutch, short, in character, varied (≥ 4 lines per event kind
per persona where it fits), never revealing a bot's hidden cards. `ChatEvent`
carries no time of day and no trump mode, so lines fit any hour (no
"goedenavond") and both modes (no passing outside "pass" lines: utrechts has
none). Bots greet on game start, react to roem, nat, pit and game end, and
occasionally reply to human chat ("hoi", "goed gespeeld", "gg", "haha"…). For
a trump choice or a big trick the bot that made it speaks (`Mine`); if it says
nothing, or a human made it, a bot of the other team may (`Mine: false`, the
"/opp" lines; for these sided kinds a voice without "/opp" lines stays
silent). A reply knows whether the bot is the speaker's partner and, while
tricks are played, whether its team made trump: "Nat!" is answered only then,
by the partner agreeing ("nat/maat") or by a bot of the playing team
protesting; after the hand, or from a player whose own team plays, it gets no
answer. The
server allows a bot at most one line per trick and one per 8 s, scaled by
Chattiness (the gap is 8 s / max(Chattiness, 0.2)); per event at most one bot
speaks (two for the greeting and game end), and about 60% of human lines get a
reply attempt.

## 6. Server behaviour

### Rooms and codes

- Code: 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I, O), unique among live
  rooms, case-insensitive on input. Join link: `https://klaverjas.kroes.dev/ABCD`.
- Creator sits at seat 0 and is host. If the host leaves, or stays disconnected
  for 30 s while another human is connected, the next human becomes host
  (checked when the 30 s are up, and again when someone else gives a host
  command such as `rematch` or `lobby`). A room is removed 30 min after game over (players
  still connected get `onbekend`) and at once when the last human leaves its
  lobby. With no human connected it is removed after 30 min while a game runs
  that still has a human seat, and after 5 min in the lobby, after game over,
  or once every human has left (a seat its player left counts as no human,
  here and for the host; it can be taken over until then). Max 500 rooms
  (`Config.MaxRooms`): when full, a new game
  replaces the room that has had no human connected for longest (at least
  2 min), else error `te-veel-spellen`.
- Seats: `players` seats (`0..players-1`). The lobby starts with only the
  creator seated; nobody places bots by option. The host can put a bot (chosen
  or random) on any empty seat and remove bots. Humans may move to any empty
  seat. At start, empty seats get random distinct bots. Changing `players` in
  the lobby keeps everyone whose seat stays; a human on a seat that goes moves
  to the first free seat (a bot makes way if needed), a bot on it leaves; with
  more humans seated than the new number, error `ongeldig` ("Er zitten al 3
  mensen aan tafel.").
- Joining a lobby: first empty seat; with none → error `vol`, whose text says
  what to ask the host: one bot less when bots fill a seat, else a seat more
  under *Spelers* (with four people seated, nothing can be done). Joining a
  running game, or one that is over: allowed only to take over a seat a human
  left, still waiting or played by the AI the others let in, else error
  `gestart` (after game over its text asks the host to set the table up
  again). A joiner with the name of a player who left gets that seat (their
  team, their cards), else the waiting seat whose turn it is goes first. The
  line is "Kees neemt de plaats van Jaap over." (or "… van Opa Dirk (AI)
  over."), and "Jaap neemt de plaats weer in." for the same name again
  (anyone with the code may type it, so the line claims no more).
- A join refused from a full lobby or after game over is told to the table:
  the system line "… wilde aanschuiven, maar de tafel is vol." and, for the
  host only, a `refused` message (§7), at most once per 30 s per room whatever
  the name (names are free text; a code guesser must not flood the host).
- After game over the host chooses: `rematch` starts a new match at once with
  the same seats and options; `lobby` takes the room back to phase `lobby`
  under the same code and options. There the humans keep their seats (except
  those disconnected for longer than the 30 s host grace), bots placed in the
  lobby stay, and the seats humans left, or that bots filled at the start or
  took over from a human who left, are empty again, so a late friend can join
  and the host can change seats, bots and options before starting. Scores
  and the previous hand are cleared.
  The system line says "Wie wil, kan nu aanschuiven." only when a seat is
  free. Training has no lobby.
- Reconnect: `join` with the room's code and the seat token returns you to your
  seat, mid-game included. Without the token (another device, cleared storage),
  a `join` with exactly the same name takes back a human seat that has been
  disconnected for at least 3 min (a locked phone keeps its seat): the seat
  gets a new token, the old one then gets `onbekend`, and a system line says
  "… speelt verder op een ander apparaat".
- A human who disconnects keeps the seat (event `away`: the connection is
  lost, `connected: false`) and plays it again on return (`back`). A second
  connection that joins with the same token takes the seat over; the old one
  gets `onbekend`. An explicit `leave` in the lobby empties the seat; in a
  match (any phase from `auction` or `trump` to `handEnd`) or at game over
  it makes a *left* seat: no connection, no token, the name stays for display (`left: true`),
  event `leave`, system line "Jaap is vertrokken." Nobody plays a left seat
  until a joiner takes it or the others let an AI take it; a rematch fills
  it with a random bot like an empty seat, and `lobby` frees it.
- **No AI plays a human's seat without the consent of every other connected
  human.** (Bots placed in the lobby or filling seats at the start, and
  training and solo games, are not affected.) On the turn of a player who
  dropped out or left (phase `auction`, `discard`, `trump`, `bid` or `play`,
  no pause pending) the game waits for them. The others are asked whether an AI may play that seat
  (state `takeover`, `{seat, left}`) at once for a left seat, and for a
  player who dropped out once they have been gone 10 s (`askAfter`, scaled
  by `-fast` like every delay), counted from the later of the turn opening
  and the drop-out; as long as someone is connected to answer. Every
  connected human answers with `vote` (`players[i].vote`), naming the
  question (`seat`, `left`), and may change the answer while the question is
  open. When all of them said yes, an AI takes over (event `takeover`): for
  a player who dropped out the substitute (a neutral bot, level normaal,
  `away: true`) plays until they return ("Iedereen is akkoord: een AI-speler
  speelt zolang voor Jaap."); a left seat goes to a random persona at the
  room's level ("Iedereen is akkoord: Opa Dirk (AI) neemt de plaats van Jaap
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
  (training, solo) nobody can be asked: the game waits for the player.
- A bot (or substitute) decides once per turn, in the background: a sterk
  search uses all cores for a moment. Reconnects, window switches and a seat
  changing hands during the turn reuse that decision; it is played when the
  think time is up (counted from the turn, or from the takeover).
- If no human is connected, the game pauses (bots do not play, the hand summary
  waits, nobody is asked); when someone returns, bots think again and the
  summary countdown restarts. If the game waits for an absent player, the
  question is back at once when it had been asked or that player has been
  gone 10 s by then (counted as above: the pause does not reset that clock),
  else once they have.
- Spelanalyse (§9), at a table of four only (three and two players get no
  review: `review` stays null): every decision a connected human makes with a
  choice (a card when more than one is legal, a trump choice, a bid) is
  graded in the background with `AI.Grade` on the view it was made on, and
  each human's cards with `AI.HandLuck` at the deal. A substitute's decisions are not
  graded. At most GOMAXPROCS/4 analyses (at least 1) run at once over all
  rooms, each on one core; one whose match is over, or whose room is gone,
  is skipped when its turn comes. The roem a human's card adds to the
  cards on the table, beyond the least that one of their legal cards would
  add, counts as given away when the opponents take the trick. Every
  decision of a connected human (also a lone legal card) is timed, from the
  turn opening (after the pause before it) to the decision, if they were
  connected all along: a turn that opened while they were away, or in which
  their connection dropped, is not. A match starts
  every review afresh; a seat that changes hands starts a new one. At game
  over each human's state carries their own review and nobody else's
  (`review`, §7); while grades are still out it is `{"pending": true, …}`,
  and the player gets an update without event once the last one is in.
- Expert mode (§3; `expert.go`): the state's `expert` part carries the hand
  in play, or just played (`handEnd`), as the replay shows it, with each
  seat's bids and trump choice before the first card (`pre`) and per card
  played the cards its player could play (`legal`); at game over every hand
  of the match; and the expert's own choices (`marks`). A decision is named
  by hand, trick (1–8; 0: the seat's last bid or trump choice before the
  first card) and seat. The server rebuilds any moment of a hand from the
  cards as dealt and the decisions (`acts`, as in the game log) up to it,
  and so validates a `mark` (a card legal there, a suit allowed there, the
  bid) and works out a `why`: `AI.Explain` on the view of that seat then,
  match fields filled in as for the bots. A `why` names a decision made, or
  the one awaited now in the hand in play; it runs in the background, one
  at a time per room (another meanwhile: error `limiet`), and the answer
  goes to the asker alone. At most 500 marks and 200 feedback lines per
  match.
- Bot chat (limits in §5): a bot does not repeat one of its last two lines for
  the same kind of event (numbers aside: "20 roem" and "50 roem" are one line);
  it asks for another line a few times and otherwise stays silent.
- System chat lines (`sys`, seat -1): the start of every match, rematches
  included, with its seed, so nobody has to play to the end to see it
  ("Spel (482913) begint: 16 potjes, Utrechts/Amsterdams. Veel plezier!";
  with `from` "… begint: potje 5, …"), joining, a join refused because
  the table is full, leaving, an AI taking a seat with everyone's consent, a
  player back from a substitute ("… is terug."), a seat taken back on another
  device, host changes, rematch, back to the lobby (and a gone player's seat
  freed).

- **Calls** (issue #43, `call.go`): the people at a table may call each
  other with sound and video. The media go directly between their browsers
  (WebRTC, a connection for every two of them in the call); the server only
  keeps who is in the call and passes the session descriptions on, and it
  logs nothing of a call. A connected human joins with `call`, naming a
  session the browser makes up (8–32 letters and digits, none another
  seat's), with `mic` and `cam` on or off, and changes them with the same
  message; `call` with `id` "" hangs up. Every change is an update without
  event (`players[i].call`; in the lobby a `lobby` event). The call belongs
  to the connection: it ends when the connection goes (`away`), when another
  connection takes the seat (a second window, a reconnect, a reclaim by
  name) and when the seat is left or taken over; a seat moved in the lobby
  keeps it, and so do a rematch and the way back to the lobby. `rtc` passes
  a description (an offer or an answer, with every address found, at most
  12000 bytes) from a seat in the call to the session it names (`to`), as
  `rtc` with the sender's session and seat; a description for a session
  that is no longer in the call, or from a seat that is not in it, is
  dropped. `call` and `rtc` share a bucket per seat: 10, then 2 a second
  (more: error `limiet`).

- **Game log** (flag `-games DIR`; the pod keeps it in the volume
  `klaverjas-games`, §10): one JSON line per event, appended to
  `games-YYYY-MM.jsonl` (UTC month) by one writer goroutine behind a queue
  of 4096 lines (a full queue drops a line and says so in the server log;
  so does a directory that cannot be written). Used for statistics and to
  improve the game, and kept for at most 12 months: the writer removes the
  month files older than the current month and the eleven before it, at its
  start and every hour (`gameLogMonths`). The P2P apps have no server and
  keep none. Records, each with `t`, the
  `match` id and `at` (UTC):
  `match` (`version`: the commit the server was built from, as in
  `/api/health`, "dev" from source; `room`, `seed`, `training`, `expert`
  when set, `opts`, `players`: `{seat, name, ip,
  device}` for people, the browser's User-Agent cut at 300 bytes, or `{seat,
  name, bot, level}`), `seat` (a seat that changed hands mid-match: `hand`,
  `player`), `hand` (`hand`, `dealer`, `turned`, `cards` per seat as one
  string "7SAS9H…", `talon` with three players, `acts`, `result`: the
  HandResult), `end` (`total`, `winner`), `close` (a room removed before game
  over: `hand`, `reason`; a match cut short by a server restart has neither
  `end` nor `close`), `review` (`seat`, `name`, `review`: the review state of
  §7 without `replay`, once every grade is in), `mark` (the expert's own
  choice: `seat` and `name` of the expert, `hand`, `trick`, `by`: the seat
  whose decision it is, `mark` and `played`: card, suit or play; a mark
  without one clears it) and `feedback` (`seat`, `name`, `ip`, `device`,
  `text`; from the expert also `hand`, `trick` and `by` when about one
  decision). `acts` lists the hand's decisions in order,
  space-separated: the seat, then a card ("2AS"), or `b1`/`b0` (spelen,
  passen), `tH` (trump), `a90` (auction bid; `a0` pass), `dJS7H` (laid away).

### Pacing (ms, scaled by tempo; `-fast` multiplies everything by 0.05)

| | rustig | normaal | snel |
|---|---|---|---|
| bot think time (× persona Speed, ± 30%) | 1500 | 900 | 450 |
| deal animation before first action | 2000 | 1500 | 900 |
| trump/bid announcement pause | 1200 | 900 | 500 |
| completed trick on table before collect | 2200 | 1500 | 800 |
| hand summary before auto-continue (unless all humans `ready`) | 15000 | 12000 | 8000 |

The hand summary also ends as soon as every human still connected is `ready`,
including when the last one not ready leaves or drops. Alone at the table
(training, or one person with bots) it does not auto-continue at all: the
player looks back at the hand and goes on with `ready` (`nextAt` is 0). That
can change during the summary (`timeSummary`): when a leave leaves one person,
the countdown stops; when a joiner makes two, it starts in full.

In training the last trick of a hand, which comes with a tip, stays on the
table until the tip is read: the trick pause, or longer for a longer tip
(`readTime`: 2 s plus 250 ms a word of the longest tip, at most 20 s, not by
tempo), or until `tipRead`. `nextAt` says when it goes; the summary would
otherwise cover the tip at once.

### Lessons (training with option `lessons`, issue #41)

Juf Jannie teaches the game a step at a time, and a little more each time
(`lesson.go`). A step is the state's `lesson`, `{n, text, spot, card}`, for
the learner alone; `spot` names the part of the screen it is about (§9),
`card` the card in the hand for spot `card`. The game waits for it without a timer: the pause
it comes in (`turn` -1, `nextAt` 0) ends only when the learner has read every
step of it, each with `tipRead` and its `n` (a `tipRead` for another `n` came
late and changes nothing). On the learner's own turn a step needs no pause:
the turn is open, the hint follows once it is read, and playing a card reads
it too. Every step is a line of Juf Jannie in the chat (`coach`), after the first
update that shows it. What is taught, per room (the hands counted from the
first one dealt with lessons):

- **Intro**, after the deal of the room's first hand, before the first turn:
  six steps: Juf Jannie is your partner, opposite (`partner`; how to go on), 32
  cards, 8 each (`hand`), a trick and who leads the next (`trick`), trump and
  who chooses it in this hand, or in gedraaid that a suit will be turned up
  (`trump`), points and Wij/Zij (`score`), tips, explanations and the chat
  (`chat`).
- **Trump**, when the first trump announcement ends: how trump and the other
  suits rank, and the card points (`trump`, two steps).
- **The learner's turn** in play, the first time they lead (`lead`), must
  follow suit (`follow`), trump was led and they hold trump (`trumpLed`), may
  play anything (`free`: no card of the suit led and no trump, or trump led
  and none held), must trump (`trump`, with overtroeven when a trump lies),
  or need not trump on the partner's trick (`partner`); spot `rule`. Other
  situations are left to the rule above the hand.
- **The first hand**: every trick waits for its explanation (the tip as a
  step, spot `trick`; no `tip` message), and the last one also for the score:
  points and roem per side, who made trump and had to get more, gehaald or
  nat (`score`).
- **Roem**, from the third hand (`roemHand`): at its deal, before the first
  turn, what roem is, who gets it, and what each kind is worth (two steps);
  then the first three tricks with roem (`lessonShows`): the cards it is made
  of ("♠9, ♠10 en ♠B op een rij (driekaart, 20)", "♥V en ♥H van troef
  (stuk, 20)") and which side gets it (spot `trick`).
- **Signals**, from the fifth hand (`signalHand`), at a table that agreed on
  any: at its deal what a signal is, then each agreement of the table in a
  step of its own. Until then the table plays without them: every view
  (bots, hints, the review) has no agreements (`room.signals`), so nobody
  gives or reads a signal and no hint mentions one. Then the first three
  chances the learner has to signal truthfully (`SignalChance`, the hint's
  card first): on their turn, before the hint, what the card would say and
  what Juf Jannie does with it, and "Mijn tip is een andere kaart." when the
  hint is another (spot `card`, the card lit up in the hand); and the first
  three signals by a bot (`TrickSignals`, the learner's own left out): who
  gave it, what it says at this table, and when Juf Jannie gave it what
  follows for the learner (spot `trick`).

A trick with a roem or signal step waits for its explanation first, then for
the step. Juf Jannie does not greet in chat when she is about to introduce
herself.

During a pause nobody may act (`turn` is -1). Humans have no time limit.
Pauses start with `deal`, `trump` (and a `bid` with `play: true`), `contract`
(three players: the announcement pause, then the soloist lays away), `trick`
and `handEnd`. A pause ends with the event that follows it (`turned` opens the
bidding in gedraaid, `collect` gives the lead to the winner, `deal` or
`gameOver` after the summary), or else with an update whose `ev` is null that
opens the turn (utrechts and the auction after the deal; the soloist's
discards after the contract; voorhand's first lead after trump).

### Limits

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
chat line with nothing visible is dropped. Room creation ≤ 20 per 10 minutes
and ≤ 10 live rooms per client IP (`X-Real-IP` from nginx, else remote address;
over a limit, or `MaxRooms` reached with no idle room to replace: error
`te-veel-spellen`); ≤ 16 websocket connections per IP (more: HTTP 429 before
the upgrade). Failed joins (`onbekend`, `vol`, `gestart`) ≤ 10 per minute per
IP; then joins from that IP get `limiet` for 5 minutes, except a `join` with a
valid seat token (room codes cannot be guessed). Chat over the limit: error
`limiet`; over the message rate: error `limiet`, then the server closes the
connection (status 1008). WebSocket `Origin` must match
the Host (coder/websocket default) or an `-origin` pattern. Server pings every
25 s (nginx and NPM time out idle proxied connections at 60 s).

## 7. Wire protocol

One websocket at `/ws` (same origin, `wss:` in production). All messages are
JSON objects with a type field `t`. Seats are absolute (`0..players-1`); the
client rotates so `you` is at the bottom.

### Client → server

| `t` | Fields | When |
|---|---|---|
| `create` | `name`, `opts` (partial ok), `training` bool, `expert` bool, `start` bool | Home. `start:true` starts at once (quick play vs bots); an expert game always does |
| `join` | `code`, `name`, `token` (optional) | Join link, code entry, reconnect |
| `sit` | `seat` | Lobby: move to an empty seat |
| `bot` | `seat`, `id` ("" = random) | Host, lobby: put a bot on an empty seat (or replace a bot) |
| `unbot` | `seat` | Host, lobby: remove a bot |
| `opts` | `opts` (partial) | Host, lobby |
| `start` | | Host, lobby |
| `trump` | `suit` | Your turn, phase `trump` |
| `bid` | `play` bool | Your turn, phase `bid` |
| `auction` | `bid` (points; 0 = pass) | Three players: your turn, phase `auction` |
| `discard` | `cards` [2] | Three players: you play alone, phase `discard` |
| `play` | `card` | Your turn, phase `play` |
| `ready` | | Phase `handEnd`: continue now (ignored once the next hand is dealt: a late tap on the summary) |
| `tipRead` | `n` (optional) | Training, a lesson step on screen (`lesson`, §6 Lessons): read, on to the next (ignored when `n` is another step's: a late tap); else the last trick of a hand waiting for its tip (`nextAt` set in phase `play`): on to the summary now (ignored once it is up: a late tap) |
| `vote` | `seat`, `ai` bool, `left` bool (optional) | While state `takeover` is set, every connected human: may an AI play that seat (`true`), or wait (`false`)? `seat`, and `left` when sent, as in `takeover`: the question it answers (the client sends `left`, so a yes for a stand-in never counts for a seat given away). Can change while the question is open (§6); the same answer again changes nothing, so no `update` follows |
| `chat` | `text` | Any time |
| `call` | `id` (8–32 letters and digits; "" hangs up), `mic` bool, `cam` bool | Any time: join the call, switch the microphone or camera, hang up (§6 Calls). The same again changes nothing |
| `rtc` | `to` (a session in the call), `desc`: `{type: "offer"\|"answer", sdp}` | In the call: a session description for that session, passed on as `rtc` (§6 Calls) |
| `rematch` | | Host, phase `gameOver`: new match, same seats and options |
| `lobby` | | Host, phase `gameOver`, not training: back to the lobby, same code and options (§6) |
| `leave` | | Leave the room |
| `mark` | `hand`, `trick` (1–8, or 0: the seat's last bid or trump choice before the first card), `seat` (whose decision; default your own), and `card`, `suit` or `play` (none: clear) | Expert, once the match started (also at game over): the expert's own choice for a decision made, of any seat. A card must have been legal for that seat there, a suit allowed for its trump choice, `play` for a bid. At most 500; each one goes to the game log (§6), and an `update` without event shows it in `expert.marks`. Elsewhere error `ongeldig` |
| `why` | `hand`, `trick`, `seat` (as `mark`) | Expert: the engine's reasoning for a decision made, or the one awaited now in the hand in play; answered with `why` to you alone, one at a time per room (§6) |
| `feedback` | `text` (at most 2000 characters, cleaned per line); the expert also `hand`, `trick` and `seat` (optional: about that decision) | Phase `gameOver`, with a review: free text for the game log (§6), about the game; the expert also while the match runs. Answered with `saved`. At most 20 per player and match, 200 for the expert |
| `ping` | | Keepalive (server answers `pong`) |

### Server → client

| `t` | Fields |
|---|---|
| `joined` | `code`, `seat`, `token` (store in localStorage under `kj.token.<code>`) |
| `update` | `seq`, `ev` (event or null), `s` (full state for you) |
| `chat` | `msg`: `{seat, name, text, ts, bot, sys, coach}` (`sys`: system line, seat -1; `coach`: training, a line of Juf Jannie that the coach bubble shows, a lesson step or a trick's tip, not a speech bubble) |
| `chatlog` | `msgs`: last 50, sent after `joined` |
| `tip` | `text` (training: explanation after a trick, Dutch, also a `coach` chat line; not while the trick waits for it as a lesson step (§6 Lessons); when you played another card than the hint, it ends with the advised card and why: "Juf Jannie had ♣9 aangeraden: …"; the first trick's tip of a hand also says so of a trump choice or bid against the hint, before any card: "Juf Jannie had ♥ als troef aangeraden: …", "Juf Jannie had aangeraden om te passen: …") |
| `refused` | `name`: to the host only, someone could not join because the table is full (§6); no state change, so no `update` |
| `saved` | `what`: `"feedback"`: kept in the game log |
| `rtc` | `from` (the sender's session), `seat` (the sender's), `desc` as sent: to the session named only (§6 Calls) |
| `why` | Expert: `hand`, `trick`, `seat` (as asked), `played` (the choice made, null: awaited now), `normaal`, `rule`, `sterk`, `hint`, `hintText`, `worlds`, `options`: `[{card\|suit\|play, value, se, us, them, natUs, natThem, parts}]` — `Explanation` (§4.2) with points rounded to tenths and nat as shares of the deals (to thousandths); `parts` for cards only |
| `error` | `code`, `msg` (Dutch, ready to show) |
| `pong` | |

Error codes: `onbekend` (no such room, or no longer in it: room removed, seat
taken over by another window, or taken back by name on another device), `vol`,
`gestart`, `geen-host`, `niet-jouw-beurt`, `ongeldig` (bad card/suit/fields;
`msg` from `ExplainIllegal` for cards; a `vote` with no open question about
that seat, or another one (`left` sent and different), also one that comes too late:
"Die vraag staat niet (meer) open."), `limiet` (rate limit, also for joins after too many failed ones),
`te-veel-spellen`, `herstart` (server restarting; client reconnects after a
delay).

Every state change is one `update`: the client queues updates, animates `ev`
from its previous state to `s`, then renders `s`. A resync (join, reconnect)
is an `update` with `ev: null`; so is a change without animation (a pause ends
and a turn opens, `ready` flags, a host change, the takeover question opening
after 10 s, a vote). `seq` increases per room with
every event; a resync carries the current `seq` (the joiner gets `ev: null`
where the others get `join`/`back` with the same `seq`). A choice by `bid` with
`play: true` sends `bid`, then `trump`; the bid that ends an auction sends
`auction`, then `contract`.

### Events (`ev.type`)

| type | fields | client animation |
|---|---|---|
| `lobby` | | none (seat/option changes) |
| `deal` | `handNo`, `dealer` | cards fly from the dealer to each seat, 3-2-3 (three players: 3, the talon, 4, 3; two: to the piles, then the front rows turn) |
| `turned` | `suit` | gedraaid: show the turned suit |
| `bid` | `seat`, `play` | speech bubble "Spelen!"/"Pas" at the seat |
| `auction` | `seat`, `bid` (0 = pass) | three players: speech bubble "90"/"Pas" at the seat |
| `contract` | `seat`, `bid`, `forced` | three players: banner "Opa Dirk (AI) speelt alleen" with the bid; the talon flies to the soloist |
| `discard` | `seat` | three players: two closed cards leave the soloist |
| `trump` | `seat`, `suit`, `forced` | banner "Opa Dirk (AI) kiest ♥ als troef"; two players: the back rows turn, then the roem of each side's open cards bursts |
| `play` | `seat`, `card` | card flies from the seat to its trick slot |
| `trick` | `winner`, `points`, `roem` [], `last` bool | highlight winning card; roem burst "+20 Stuk!" |
| `collect` | `winner` | trick slides to the winner and fades |
| `handEnd` | `result` (HandResult as JSON, below) | summary overlay: gehaald/nat/pit, seen from the viewer's team (§9 Review) |
| `gameOver` | `total` [per scorer], `winner` (scorer, or -1 when the top is shared) | celebration |
| `join` / `leave` / `away` / `back` / `takeover` | `seat` | small toast |

`away`: the connection is lost; `back`: the player is at their seat again;
`leave`: they left (in a match the seat waits, `left`); `takeover`: an AI plays
the seat now, with everyone's consent (the substitute, `away: true`, or a
persona on a seat its player left). `away` comes once per lost connection.

### State `s`

```jsonc
{
  "code": "KQXB", "phase": "lobby|auction|discard|trump|bid|play|handEnd|gameOver",
  "opts": { "players":4, "hands":16, "trumpMode":"utrechts", "rules":"amsterdams",
            "ai":"normaal", "tempo":"normaal", "open":false, "lessons":false,
            "signals":{"aas":true,"kleintjeBoer":true,"hoogLaag":true,"boerOverBoer":false}, "seed":0, "from":0 },
  "training": false, "you": 0, "host": 0,
  "expert": null,                  // an expert match: {"hands":[hand…],"marks":[…]}, below
  "roster": [ {"id":"dirk","name":"Opa Dirk","emoji":"👴","color":"#8a5a2b","bio":"…"} ],  // lobby only: bot picker
  "players": [ // opts.players entries; null = empty seat
    { "name":"Piet", "bot":false, "botId":"", "emoji":"", "color":"",
      "connected":true, "away":false, "left":false, "vote":null,
      "call":{"id":"9f2c41d07a3b88e1","mic":true,"cam":false}, "cards":8, "ready":false },
    { "name":"Jaap", "bot":false, "botId":"", "emoji":"", "color":"",
      "connected":false, "away":false, "left":false, "vote":null, "call":null, "cards":8, "ready":false },
    { "name":"Opa Dirk (AI)", "bot":true, "botId":"dirk", "emoji":"👴", "color":"#8a5a2b",
      "connected":true, "away":false, "left":false, "vote":null, "call":null, "cards":8, "ready":false }, null ],
  "handNo": 3, "hands": 16, "dealer": 1, "voorhand": 2,
  "turned": null, "bids": [-1,-1,-1,-1], "forced": false,   // bids: one per seat
  "bid": 0, "bidder": -1, "soloist": -1,   // three players: highest bid and bidder; the soloist once the auction is over
  "talon": [], "discards": [],             // three players, the soloist only: the talon it took, what it laid away
  "piles": null, "openRoem": null,         // two players: [[8 × {"n":2,"card":"JH"|null}], [...]], [[roem items], [...]]
  "trump": "H", "trumpBy": 2, "playingTeam": 0,
  "turn": 0,                       // -1 while paused or nobody's turn
  "takeover": null,                // {"seat":1,"left":false}: the game waits for that absent seat; may an AI play it?
  "hand": ["AH","9H","JH","KS","TS","8C","7D","AD"],   // yours, display-sorted
  "legal": ["9H","JH"],            // only on your turn in phase play
  "rule": "Troef gevraagd: overtroeven",   // ExplainConstraint, on your turn
  "trick": { "leader":3, "cards":[{"seat":3,"card":"QH"}], "winner":-1 },
  "lastTrick": { "leader":2, "cards":[...4], "winner":3, "points":21, "roem":[] },   // or null
  "tricksWon": [2,1], "handPoints": [43,21], "handRoem": [20,0],
  "scores": [ { "hand":1, "dealer":0, "trump":"S", "trumpBy":1, "playingTeam":1, "bid":0,
                "points":[70,92], "roem":[0,20], "score":[70,112], "gains":[70,112], "nat":false, "pit":false } ],
  "total": [ 418, 391 ],           // per scorer: two teams, or one per player with three or two
  "prevHand": { "tricks":[ /* 8 completed tricks */ ], "result": { /* HandResult */ } }, // after a hand ends, until the next hand ends
  "nextAt": 0,                     // handEnd: unix ms of auto-continue (0 alone at the table: waits for ready); training, play: when the last trick, waiting for its tip, goes (§6)
  "hint": null,                    // training, your turn: {"card":"AH"} | {"suit":"H"} | {"play":true}, plus "text"
  "lesson": null,                  // training with lessons: the step on screen, {"n":3,"text":"…","spot":"trick"}, spot "card" with "card":"8D" (§6 Lessons)
  "hands4": null,                  // training or expert with open: all four hands [[...],...]
  "winner": -1,                    // gameOver
  "review": null                   // gameOver: your own review (§6, §9 Spelanalyse), below
}
```

`review` (null before game over, at a table of three or two, and for a
player without a graded decision, or one on its way):
`{"id":"9f2c…","pending":false,"pct":87,"hands":16,"choices":118,"luck":-6,
"lost":41,"lostN":3,"strongN":2,"leads":[9,11],"trumps":[4,5],"roem":[40,2],
"risky":[2,1],"strong":[moment…],"missed":[moment…],"speed":{…},"replay":[hand…]}`: `id` names the match
(for the history on the device), `pct` is 100 × (1 − Σ lost / Σ stake),
rounded, `luck` the mean HandLuck per hand, `lost` and `lostN` the points
and decisions with `Lost > 0`, `strongN` those with `Gain > 0`, `leads` and
`trumps` [graded without loss, graded] for leads and for trump choices and
bids, `roem` [points, times] given away, `risky` [bids to play with more than
40% chance of nat, of which nat]. `strong` and `missed` list at most three
moments each, those with the most points, in the order played:
`{"hand":5,"trick":3,"played":{"card":"TS"},"better":{"card":"AS"},"points":18,
"us":11,"them":-7,"nat":[31,18],"natThem":[0,0],
"why":"je maat heeft de slag nog niet …","text":"Speel ♠A: je maat …","table":Trick}`
— `trick` 0 and `cards` (the player's hand, display-sorted) instead of
`table` for a trump choice or bid; `played` and `better` hold one of `card`,
`suit` or `play`; `better` only in `missed`, and `alt` (the normaal option it
beat, same form) only in `strong`; `us` and `them` are what the stronger of
the two options (`better`, or the strong move) brought the player's team and
the opponents more than the weaker one (`us` rounded, `them` = `us` −
`points`), `nat` and `natThem` the chance in percent that the player's team,
or the opponents, played and went nat, with the weaker option and with the
stronger one (the grade's Outcomes); `why` is the hint's reason
without its opening ("Speel ♠A: ", "Kies ♣ als troef: ", "Passen: "). While `pending` is
true only `id` and `pending` mean anything. `hands` is 0 for a player who
took a seat over during a hand and saw no deal: no *Jouw kaarten* then.
`speed` (null when none of the player's decisions was timed, §6), times in
ms: `{"n":118,"median":2400,"total":372000,"slowest":{"hand":4,"trick":2,"ms":48000},
"others":{"n":230,"median":2100,"total":612000}}` — the player's decisions,
the median and summed think time, the slowest one (`trick` 0: a trump choice
or bid), and the same sums over the other humans of the match (null without
one). `replay` lists every finished hand of the match:
`{"hand":4,"cards":[[8 cards]×4],"tricks":[8 Tricks]}`, its number, the cards
dealt to each seat (display-sorted under that hand's trump) and its tricks;
the hand's result is the score sheet's row (`hand`). In an expert match each
hand also has `pre` and `legal` (as in `expert.hands`). `seed` is the
match's seed (§3).

`expert` (null outside an expert match and in its lobby):
`{"hands":[hand…],"marks":[{"hand":5,"trick":3,"seat":1,"card":"AS"},{"hand":5,"trick":0,"seat":2,"play":false}]}`.
`hands` holds the hand in play, or just played (`handEnd`), and at game over
every hand of the match, each as in `replay` with the trick in progress
included (fewer than four cards, `winner` -1) and `pre`: the bids and trump
choices before the first card in order, `[{"seat":1,"play":false},
{"seat":0,"suit":"H"}]`, and `legal`: per card played so far, the cards its
player could play there. `marks` are the expert's own choices (§7 `mark`),
in hand, trick and seat order.

`HandResult` JSON: `{"players":4,"playingTeam":0,"trumpBy":2,"trump":"H","dealer":1,
"points":[104,58],"roem":[20,0],"score":[124,58],"nat":false,"pit":false,"pitTeam":-1,
"bid":0,"discards":[],"gains":[124,58]}`; `points`, `roem` and `score` are per
side (§2), `gains` per scorer, `discards` the soloist's two cards with three
players.

Every key above is always present, except `roster` (lobby only) and `legal` and
`rule` (only on your turn in phase `play`). Further:

- `turned`: the turned suit in gedraaid from the deal on (the `turned` event
  opens the bidding), else null.
- `trick`: null outside a hand (`auction` to `play`); a complete trick stays until
  `collect`, then it is the empty next trick led by the winner (`turn` = winner).
  Tricks carry `points` and `roem` too (0 and `[]` while in progress).
- `lastTrick`: the latest completed trick of this hand (null after a new deal;
  kept through `handEnd` and `gameOver`).
- `hand` is `[]` and `turn` -1 outside a hand; during `handEnd`/`gameOver`,
  `dealer`, `voorhand`, `trump`, `trumpBy`, `playingTeam`, `tricksWon`,
  `handPoints` and `handRoem` still describe the finished hand.
- `players[i].cards` is 0 outside a hand (with two players it counts the
  face-down cards too; `hand` is then the face-up ones); `ready` only counts
  in `handEnd`.
- With three players `playingTeam` is 0 (the soloist's side) once trump is
  known; `tricksWon`, `handPoints` and `handRoem` are per side.
- `hint` and `hands4` are null unless they apply; `hint.text` is always set.
- `takeover` is set while the game waits for seat `seat` (it is its turn:
  `turn` = `seat`) and someone else is connected: `left` false for a player
  who dropped out (asked after 10 s), true for a seat its player left (asked
  at once). Everyone connected is asked; the absent player is not connected,
  so never sees it. Else null (§6).
- `players[i].left`: a seat its player left in a match or at game over
  (`connected` false, the name kept, nobody plays it). `players[i].vote`: a
  connected human's answer to the question, `true` (an AI may play) or
  `false` (wait); null before answering and whenever `takeover` is null, and
  always for bots and absent players, except a no that still holds for a
  moment after its voter dropped out (§6). `away`: the substitute plays for a
  player who dropped out, with everyone's consent, until they return (or the
  match ends).
- `players[i].call`: `{id, mic, cam}` while that human is in the call (§6
  Calls), else null; always null for bots and for seats nobody is connected
  to.

## 8. Seinen (signals) — used by normaal and sterk bots and explained in the manual

The manual's section is titled *Seinen*; its text and the glossary also give
the other name, *voorkaarten*.

Which signals hold is agreed per table (option `signals`, §3): aas vraagt
10, kleintje boer and hoog/laag are on by default, boer over boer is off.
The server puts the table's agreements in every view (`game.View.Signals`;
a view without them means the defaults), and the bots, the hints, the
search's playouts and the Spelanalyse give, read and explain only the
signals agreed. Tegenkleur is described in the manual but never agreed.

- **Aas vraagt 10** (`aas`): on the **partner's trick**, discarding the ace
  of a side suit that nobody has led yet says "ik heb ook de 10 van deze
  kleur". The ace's 11 points go to the partner's trick, and after the ace
  that 10 is the highest card of the suit, so it can still win a trick: the
  partner leads the suit to it. An ace given without the 10 breaks the
  promise. Leading an ace says nothing: with the ace and the 10 one leads
  the 10 first (§6 normaal). Bots read it while the 10 is out, in the first
  six tricks, and lead the suit with a low card; they give the ace with its
  10 rather than keep it, and avoid an ace without it (sterk only for ≥ 20
  points).
- **Kleintje boer** (`kleintjeBoer`): leading a small card (7, 8, 9) of a side suit signals "ik heb de
  troefboer"; partner wins and returns trump. It is given by the trump maker
  on its first lead (in utrechts the opening lead of the hand; bots as maker
  give it only then, with the boer and at most one other trump, no nel), or by
  the maker's partner on its first lead, while the boer is still out. Bots of
  the playing team do not lead such a card without the boer when they have
  another sensible lead, so they read it as a promise.
- **Boer over boer** (`boerOverBoer`, off by default): leading a side-suit
  boer while holding the trump boer, on the same first lead as kleintje
  boer. When agreed, bots read it like kleintje boer, avoid it without the
  boer, and hints name it (and warn when a side-boer lead could be read as
  one). Not agreed, a side boer says nothing.
- **Hoog/laag bijspelen** (`hoogLaag`): on the **partner's trick** (the
  partner holds it when the card is played), discarding a small card (7, 8
  or 9: cards without points) says "speel deze kleur, daar heb ik de
  hoogste van"; discarding a 10 or picture card says the opposite, "ik heb
  weinig in deze kleur". Bots give and read the low one in the first six
  tricks (the discarder holds the highest card of that suit still out;
  sterk fakes it only for ≥ 20 points), not the high one; a hint names the
  high one for a discard that tells the truth (at most one other card of
  the suit left, not its ace). A discard into a trick the opponents hold
  says nothing: there the cheapest card goes.
- **Tegenkleur seinen**: discarding a suit to ask for the suit of the other colour of
  the same shade (harten ↔ ruiten, klaveren ↔ schoppen).
- **Spekken (ook wel smeren)**: give points (10, aas) to a trick your partner
  is sure to win (*je maat spekken*).
- **Maat heeft de slag** (Amsterdams): no need to trump; give points
  (spekken) instead.

## 9. Frontend

Vanilla ES modules, no framework, no build step, no inline `<script>`/`<style>`
and no `style="…"` attributes or `setAttribute('style')` (CSP `style-src
'self'`; setting `el.style.x` from JS is fine). Build DOM with
`document.createElement`/`textContent`; never `innerHTML` with user or server
text. At most 17 requests per page load in total, the websocket included
(NPM's rate limit for the name is in shrek-infra, `docs/services/klaverjas.md`):
html, 3 css, favicon, manifest, one PNG icon (Chrome's install check),
≤ 6 app modules, cards.js, sound.js, manual.js, the websocket; `expert.js` is
imported only when an expert game first needs it, and `call.js` once another
person sits at the table, so a page load never fetches them. No service
worker. System font stack.
`localStorage` access wrapped in try/catch (keys prefixed `kj.`).
Icons: `favicon.svg` (tab; manifest `any`), `icon-192.png` and `icon-512.png`
(manifest `any`, rendered from favicon.svg), and from the full-bleed
`icon-full.svg` (felt to every edge, artwork inside the central 80% circle)
the opaque `apple-touch-icon.png` (180 px; iOS fills transparency black and
also asks for this path by itself) and `icon-maskable-512.png` (manifest
`maskable`). The PNGs are rendered once with `rsvg-convert` (commands in
icon-full.svg) and committed; `test/ui/app-icons.test.mjs` checks them.
Link preview: `index.html` has Open Graph tags (`og:title`, `og:description`,
`og:image` and its size and alt text, `og:locale` `nl_NL`; no `og:url`, since
the same file serves `/` and every `/ABCD`). `og:image` must be absolute:
the file says `https://@SITE@/og.png` and the web image build fills in the
host name (the dev server keeps the placeholder). `og.png` is an opaque
1200×630 PNG under 300 KB (WhatsApp skips larger ones) of the felt, the
clover and a fan of real card faces, rendered by `test/ui/og-image.mjs` and
committed. Browsers never fetch it, so the request budget is unchanged.
WhatsApp and iMessage build the preview on the sender's phone; iMessage's
fetcher calls itself `facebookexternalhit`, which NPM's bot filter refuses
outside the house, so its previews show the image only for a sender at home.
Server-side previewers (Telegram, Slack, Discord) fetch from datacenter
addresses that shrek's firewall drops.

### Module contracts shared between agents

```js
// web/js/cards.js — card faces and backs (with web/css/cards.css)
export const SUITS = { C:{name:'klaveren',symbol:'♣',color:'black'}, D:{name:'ruiten',symbol:'♦',color:'red'},
                       H:{name:'harten',symbol:'♥',color:'red'}, S:{name:'schoppen',symbol:'♠',color:'black'} };
export const RANKS = { '7':'7','8':'8','9':'9','T':'10','J':'B','Q':'V','K':'H','A':'A' };  // face letters
export function cardName(code)            // "harten boer"
export function cardShort(code)           // "♥B"
export function createCard(code, opts={}) // → HTMLElement .card; opts: {size:'sm'|'md'|'lg'} (default md);
                                          //   dataset.card = code; aria-label = cardName
export function createBack(opts={})       // → HTMLElement .card.back
// Card size scales with the CSS custom property --card-w on any ancestor (height = 1.4 × width).
// Four-colour deck when an ancestor has class .four-color (♣ green, ♦ blue/orange). In the
//   two-colour deck the courts of ♣ and ♦ wear those inks on a garment (tunic, bodice, doublet
//   and beret), so the courts of every suit look different; the spade (needle point over low,
//   wide lobes, broad foot) and the club (three wide-set round lobes, slim stem) stay apart
//   as small or distant blurs.
// Extras: parseCard(code) → {rank,suit}|null; suitIcon(suit, {colored}) → <svg.suit-icon> (1em);
//   createBack({size, color:'blue'|'red'}). State classes: .legal .selected (lifted) .disabled
//   .hint (pulsing glow) .winner (gold ring) .selectable (hover/press only); they use the
//   individual `translate`/`scale` properties, so layout may use `transform`. Every face, at any
//   size, shows its picture (pips, ace medallion, court figure) and the index (rank over suit) in
//   the top-left and, turned, the bottom-right corner; the boer's B has a square-cornered stem.
//   Below 60, 40 and 30 px wide the index grows to 1.25, 1.4 and 1.6 times its regular size and
//   the picture shrinks to keep clear of it. --card-index-max on an ancestor caps that growth
//   where cards overlap at their corners or show only a strip (the trick: 1, the regular index).
//   The scale a face shows is --_index on its .card-svg, a registered <number> that an
//   animation may tween (a flight from a hand to the trick does).

// web/js/sound.js — synthesised with WebAudio, no audio files
export const sound = {
  unlock(),            // call on the first user gesture (also self-armed on any gesture); Promise, never rejects
  play(name),          // 'card','deal','shuffle','trick','trickWon','roem','trump','turn','chat',
                       // 'nat','pit','handWon','handLost','win','lose','click','error','join'
  setMuted(bool), isMuted(), setVolume(0..1), getVolume()   // persisted in localStorage kj.sound
};

// web/js/manual.js — the in-game handleiding (Dutch content + renderer)
export const SECTIONS = [ {id:'bediening',title:'Bediening'}, {id:'regels',title:'Spelregels'},
  {id:'twee-drie',title:'Met 2 of 3'}, {id:'punten',title:'Kaartwaarden'}, {id:'roem',title:'Roem'},
  {id:'seinen',title:'Seinen'}, {id:'tips',title:'Tips'}, {id:'woorden',title:'Woordenlijst'} ];
export function renderManual(sectionId, opts = {}) // → HTMLElement with that section's content (uses cards.js for illustrations);
                                                  // opts.icon(name) (util.icon) puts the buttons' pictograms in the Bediening chips
// Styles for the manual content live in web/css/manual.css (classes prefixed man-).
```

### Screens and flows (minimal clicks)

- **Home**: name field (remembered), and big buttons: *Snel spelen*
  (one tap: solo vs bots, starts immediately, straight from home to the table
  without showing the lobby; it uses the options last chosen for a new game,
  the number of players included, named under the button when they differ
  from the defaults: "Twee AI-spelers · 8 potjes"; "AI-spelers" never breaks
  at its hyphen), *Nieuw spel*
  (options sheet with defaults → *Maak spel*; rows that do not apply to the
  number of players hide: *Troef* with three, *Regels* with two, *Seinen*
  (four toggles, two per line: *Aas vraagt 10*, *Kleintje boer*, *Hoog/laag*,
  *Boer over boer*) with three or two), *Meedoen* (4-letter code field;
  joins as soon as 4 letters are typed), *Oefenen* (training), *Handleiding*.
  Snel spelen and Oefenen (bots only) never ask for a name: without one the
  player is "Speler", which is not stored as their name. Under the footer,
  small: "Versie a05a087", the commit the web image was built from (the
  Containerfile fills in index.html's `<meta name="version">`; `versionText`
  shortens it, "dev" when run from source; `pod-check` compares it with
  `/api/health`). Five quick taps on that line (each within 1.5 s of the
  last) open the expert mode's sheet, *Expert*: the only way in, and not
  named anywhere (§3; in short landscape the footer, and so the line, is
  hidden). The sheet has a line on what the mode does, *Open kaarten*,
  *Seed*, *Potje* (`from`, 1–24, empty: *Hele spel*; with a number the
  *Potjes* row hides), *Potjes*, *Troef*, *Regels*, *Seinen*, *AI-sterkte*
  and *Tempo*, all kept on the device in `kj.expert`, the seed included,
  and *Start expertspel* (`create` with `expert`, `start`, without asking
  for a name). *Nieuw spel* and
  *Meedoen*, where others see the name, ask for it first, gently: the name
  field takes the focus with a soft glow and a toast "Hoe heet je?" says why.
  Opening a join link `/ABCD` goes straight to joining (asks only for a name if
  none is stored and the browser holds no seat token for that room, so a
  reload in a game without a name goes back to the seat). Enter (the keyboard's go key) in the name field joins that
  invite, or the code typed before the name was asked for.
- **Lobby**: big code + *Kopieer link* + *Delen* (`navigator.share` where
  available; when copying fails the link is shown in a field to copy by hand);
  a mini table with the seats of `players` around it (with four the teams
  visible; with three bottom, left and right, raised a little; with two
  opposite), "2 van de 4 plaatsen bezet"; tap an empty seat to
  sit there; host taps an empty seat to add a bot (choose a character or random),
  ✕ to remove one; host edits options; *Start* (ignores taps for 0.8 s after
  the lobby first shows, so a double tap on *Maak spel* cannot start the game
  before friends can join). The hint under the code says when every seat is
  taken, and how the host makes room (a bot away, or "Zet Spelers hoger als
  er nog iemand mee wil doen."). A `refused` gives the host a toast "… wil
  meedoen, maar de tafel is vol" with what to do (a bot away, *Zet Spelers
  op 3*; after game over *Spelers of regels wijzigen*). A joiner turned away with `vol` or `gestart` lands on home with
  the code back in the *Meedoen* field, so trying again is one tap.
- **Table**: you at the bottom with your hand as a fan; partner on top, opponents
  left/right with card backs and names; dealer chip; turn glow; trump indicator;
  score bar *Wij – Zij* with names (with three or two players one part per
  player: *Jij* and the others' faces, emoji or initial as on their seats);
  potje n/16; buttons for chat (with unread
  badge), score sheet, last trick, help, settings, sound (a toggle:
  `aria-pressed` while the sound is on, tooltip "Geluid aan" / "Geluid uit",
  icon to match; on phones it is in the ⋯ menu). Where a name must
  shorten (lobby seat, score bar, *Laatste slag*), only the name does: its
  "(AI)" stays readable ("Kees de Vi… (AI)"). The trump badge's details show
  what the badge shows, also during the trump banner. Whatever the order of
  play, every card in the trick keeps one corner index in view, also under a
  winner scaled up with its ring: the top and left cards their top-left one,
  the bottom and right cards their bottom-right one (the left card sits a
  little low, the right card a little high). Open hands and your own hand
  show each card's whole index (`app-checks.mjs --only corners` measures
  the trick and the hands). A card flying from a hand to the trick takes
  off with that hand's index and grows or shrinks it to the trick's on the
  way.
  Playing: on fine pointers one click plays a legal card; on touch the first tap
  lifts the card and a second tap (or swipe up) plays it (setting: one tap /
  two taps); the prompt then says so ("Tik nog eens om ♠A te spelen"), and the
  only legal card plays on the first tap. A tap beside the hand (the felt, a
  seat, the trick; not a button) puts a lifted card down again, as does
  lifting another card. Illegal cards are dimmed; tapping one
  shows `ExplainIllegal`-style text (the client may derive it from `rule`); a
  tap during a pause (`turn` -1) says to wait. Keyboard: ←/→ select, Enter
  plays; the trump/bid panel, the takeover question and the hand summary
  focus their main button on fine pointers, and dialogs keep Tab inside.
  Trump choice: four big suit buttons (forced: turned suit disabled).
  Bidding: *Spelen* / *Passen*.
- **Three players**: the others sit left and right, raised towards the top
  (their speech bubbles open downwards); the trick is a triangle. During the
  auction the talon lies closed in the middle, every seat shows its bid
  ("bod 90", "pas") under its name, and on our turn a panel shows the
  highest bid, a bid to offer with − and + (from the lowest allowed, steps
  of 10, at most 300), *Bied 90* and *Passen*. The contract banner shows the
  bid; the soloist's seat says "alleen voor 100" for the rest of the hand.
  Playing alone, the talon's two cards come into the hand with a gold edge;
  tapping two cards chooses them (lifted), *Wegleggen* sends them, then the
  trump panel ("Jij speelt alleen en moet minstens 100 punten halen, roem
  telt mee.").
- **Two players**: our eight piles take the hand's place, two rows of four,
  the front row nearest us, each pile showing the closed card under its top
  card; the opponent's piles mirror ours in the top seat, beside its name.
  Face-up cards of ours play like hand cards (tap or click, keyboard). After
  the trump choice the back rows turn over and each side's open-card roem
  bursts with whose it is. A freed card shows face up once its trick is
  complete.
- **Someone gone** (§6): a seat says *verbinding weg* while its player is
  disconnected, *vertrokken* once they left (the name stays until a joiner
  or an AI takes the seat) and *AI speelt even mee* while an AI plays for
  them (`away`); on a narrow side seat the status wraps inside its plate.
  While `takeover` is set, everyone asked (connected, so never the one it
  is about) sees the question in the centre stage, instead of the waiting
  text, in a panel like the trump and bid panels: "Jaap is weg" with "Het
  spel wacht op Jaap. Mag een AI-speler zolang voor Jaap spelen?", or for a
  seat left "Jaap is vertrokken" with "Mag een AI-speler de plaats van Jaap
  innemen? Jullie kunnen ook wachten tot iemand anders met de code
  aanschuift." ("Je kunt ook wachten …" when you are the only one asked);
  then "Iedereen moet akkoord zijn:" with a chip for everyone asked (you
  first, then anyone whose no still holds after a drop-out): *akkoord*,
  *wil wachten*, or three thinking dots ("nog niet gekozen" for screen
  readers) for no answer yet; with you the only one asked, rule and chips
  are left out. Last *AI laten spelen* and *Wachten* (`vote`, with the
  question's `seat` and `left`), the answer given marked (tick, a dark ring
  inside the button, `aria-pressed`; the other one duller but readable)
  and open to change. Once you answered, the question text steps out of
  sight (still read with the buttons), so the panel covers less of the
  table while the others think. The panel is a `group` named by its title
  and described by the question; a polite live region says the question
  when it opens. It opens with the turn sound and buzz, and on fine
  pointers focuses *AI laten spelen*; answers change in place, so the focus
  stays. While it is open the stage also takes the prompt row, whose "…
  is aan de beurt" steps aside (the panel says it), and the panel sits as
  low as it goes, just above the hand, so the trick and the side seats
  stay in view (on phones your own seat and the last-trick button are
  under it meanwhile). The answers come last, so they stay put when what
  is above them changes (the question stepping aside, chips getting longer
  as people answer). On phones upright it is compact; in short landscape
  title, question and chips go beside the answers. `app-checks.mjs --only
  takeover` checks what stays in view at each size.
  A vote refused as too late (the question closed as you answered) passes
  without the error sound and toast. Toasts: "Jaap is even weg" (`away`),
  "Jaap is vertrokken" (mid-game with "Een AI-speler neemt de plaats pas in
  als iedereen akkoord is."), "Jaap is terug", "Jaap doet weer mee" (a
  joiner with the name of who left that seat), and for `takeover` "Een
  AI-speler speelt nu voor Jaap" or "Opa Dirk (AI) neemt het over". Back
  after an AI played for you (a decision for your seat you did not send),
  you get "Een AI-speler speelde even voor je". *Spel verlaten?* says
  mid-game "De anderen beslissen samen of een AI-speler je plaats inneemt."
  ("Je verlaat de tafel." with nobody else to ask). `app-checks.mjs --only
  takeover` plays it through, also on the mock.
- **Back button**: every closable overlay (dialog, chat drawer) has a history
  entry, so back (the Android gesture) closes the top one; at a table one more
  entry makes back ask *Spel verlaten?* instead of leaving the page.
- **On-screen keyboard**: `index.html` sets `interactive-widget=resizes-content`,
  so an open keyboard shrinks the viewport, and an upright phone turns short
  and wide. The keyboard counts as open while a text field (not read-only)
  has the focus on a touch screen (`pointer: coarse`) that is not turned
  sideways (`screen.orientation`), and the viewport is at least 120 px
  shorter than its height without a field focused; after a blur the state
  holds until the viewport grows back (at most 0.9 s), so nothing moves under
  the finger. Then `html.kb` is set (`watchKeyboard` in util.js): every rule
  for `(orientation: landscape)` phones starts with `:where(html:not(.kb))`,
  so the upright layout stays (home, the table behind the chat drawer),
  the home screen hides its banner and footer, and the focused field is
  scrolled into view when the keyboard covers it. A phone on its side keeps
  its landscape layout. `app-checks.mjs --only keyboard` emulates it.
- **Connection**: a `play`, `trump`, `bid`, `auction`, `discard` or `vote`
  (sent only when it changes the answer) without any answer within 4 s means
  a dead socket: the client reconnects. Every rejoin drops what was sent
  but unanswered and renders purely from the resync. A tab in the background still sounds
  the turn (and the takeover question) and shows "● Jouw beurt" in its
  title on your turn, and "● Vraag aan tafel" while the question waits for
  your answer. Leaving while offline sends `join` (with the seat
  token) + `leave` over a short-lived connection of its own once the network
  is back. Without `localStorage` the name and seat tokens live in memory
  for the life of the page. A rejoin of a page in the call joins it again
  with a new session (the server ended the old one with its connection).
- **Game over**: final score with the team names (with three or two players
  one score per player, the top one marked); the host gets *Nog een
  partij* (`rematch`) and, outside training and the expert mode, *Spelers of regels wijzigen*
  (`lobby`: back to *Klaarzetten* under the same code, where the start guard
  runs again); everyone gets *Scorebord* and *Naar start*.
- **Feedback**: card fly-in animations, winner highlight, trick collection
  toward the winner, roem burst, trump banner, speech bubbles for bids and bot
  chat, nat/pit splash, animated score count-up, confetti on winning; short
  waits so every move can be followed; `prefers-reduced-motion` shortens all.
- **Score sheet**: per hand: trump suit, who played (marker; with three
  players the bid too), points+roem per team (with three or two players a
  column per player, the gains; roem under the soloist only, as the other
  two share theirs), nat (red) / pit (gold), running totals ("stand" under
  each hand).
  Team names keep "(AI)", one name per line.
- **Review**: *Laatste slag* shows the previous trick at the seats with winner,
  points and roem; the hand summary (and the score sheet for the previous hand,
  which stays open while updates arrive) shows all 8 tricks of the finished
  hand in play order, each card underlined in its team's colour; tapping a
  trick shows it at the seats like *Laatste slag*. The summary's headline
  speaks from the viewer's team (`handHeadline` in util.js): we played and
  made it *Gehaald!*, went nat *Nat!*; they made it *Zij halen het*, went nat
  *Zij gaan nat!*; our pit *Pit!* (gold, also when they went nat), theirs
  *Zij halen pit*; good news for us in our colour, bad news in red. With two
  players the sides are *Jij* and the other's name ("Opa Dirk (AI) haalt
  het"); with three the headline names the soloist, the bid and what it made
  ("Kees speelde alleen voor 100 en haalde 110. Jullie delen de rest."), the
  table has a column per player (faces as in the score bar; points and roem
  of the two who played together, marked "samen"; then each one's gains and
  stand) and a line shows the discards and their points. The
  whole summary fits without scrolling: on phones (< 600 px wide) the tricks
  are a 4 × 2 grid of small tiles (number and points over the cards; 5 × 2
  with three players, 8 × 2 with two), in short landscape they sit beside
  the score; the ready chips show only with another person at the table
  (who left no longer counts), and alone at the table there is no
  countdown ring either (`nextAt` 0).
- **Chat**: drawer (side panel on wide screens), quick reactions (👍 😂 😱 😭
  "Mooi!" "Nat!" "Goed gespeeld"), bot lines, system lines, unread badge (counts what
  people write; system lines and bot chatter, shown as speech bubbles, do not).
  Speech bubbles stay behind the cards of the trick and never overlap each
  other: a chat line in the way of another bubble waits for room (dropped
  after 6 s; it is in the chat log), while a bid (*Ik speel!*, *Pas*) shows at
  once and ends a chat bubble in its way.
- **Calling** (issue #43, `call.js`, loaded once another person is at the
  table, in a browser with WebRTC and a camera API): at the start of a game
  with another person (the first update of a match, or the first at a table
  joined mid-game, once per room and page) a dialog *Meebellen?* proposes
  the call: "Gast zit ook aan tafel. Bel mee met geluid, en met beeld als je
  wilt." (or who already calls), switches *Microfoon* and *Camera* as last
  chosen, a line that sound and picture go from device to device, not
  through the server, and *Niet nu* / *Meebellen*. Not in the lobby, where
  the call is offered but not proposed, and not in training or alone with
  bots. *Meebellen* asks the browser for microphone and camera together;
  refused, for each on its own, so the microphone may still come when the
  camera is blocked. What cannot be had is a toast ("Geen toegang tot de
  camera", "Geen microfoon gevonden", "De camera is in gebruik"), and the
  player joins without it, still hearing and seeing the others. Then the
  page sends `call`; every two pages in the call connect, the lower session
  id offering, with one audio and one video transceiver from the start, so
  switching later only swaps tracks (the camera's track is stopped, its
  light goes off; the microphone's is muted). One description each way,
  with the addresses found within 2.5 s (no trickling, for the message
  limit); STUN from Google and Cloudflare, no TURN. A connection not up
  within 20 s, or lost for 8 s, failed: the offerer tries again three
  times, then the seat is marked. The call buttons sit in the prompt row
  right of the rule: *Microfoon* and *Camera* toggles (`aria-pressed`,
  coral while off) and a red *Ophangen*; while they show, a long rule wraps
  sooner, so the two never overlap. On phones under 600 px the two toggles
  stand in a row above the last-trick button, clear of the right seat and
  the trick, and *Ophangen* is in the ⋯ menu. Not in the call, one button
  *Bellen* (on phones also in the ⋯ menu) opens the dialog. In the lobby
  the same buttons sit under the table, *Bellen* and *Ophangen* with their
  label. In short landscape the dialog puts the two switches side by side,
  so its answers stay in view. A seat in the call shows that person's
  video in place of the face (in the ring, and in the lobby's avatar), ours
  mirrored, while the camera is on and pictures arrive, and a mark at the
  bottom left of the ring: a microphone, crossed out and coral while it is
  off, or a warning sign when no connection could be made. A toast says
  "Kees belt mee". The microphone and camera last chosen are kept in
  `kj.call` (`mic`, `cam`), with `ask`: Instellingen *Bellen voorstellen*
  ("Bij een spel met andere spelers vragen of je meebelt"). A browser that
  refuses to play the sound before a tap gets "Tik ergens om de anderen te
  horen". Leaving the room hangs up. `app-checks.mjs --only call` plays it through with the
  fake devices of `scripts/chrome`.
- **Training**: tip bubble with the hint text and a glow on the advised card;
  for the trump or bid choice the hint is inside the panel (in short landscape
  the bubble sits beside it); ✕ closes a hint until the next one; tips after
  each trick (`tip`), shown until you play your next card; while the last
  trick of a hand waits for its tip (`nextAt` in phase `play`) the bubble
  has *Verder* with a countdown ring, and *Verder*, ✕ or Enter sends
  `tipRead`; optional open cards; Juf Jannie as partner; the hand summary has
  no countdown ring (`nextAt` 0) and waits for *Volgend potje*. In short
  landscape the bubble sits in the top-left corner and never covers the left
  seat (who plays after you): a long text shows the lines that fit and *Lees
  verder* (then *Minder*); the tip of a hand's last trick shows in full, as
  nobody plays after it. Every tip is also a line of Juf Jannie in the chat
  (`coach`: tinted, no sound, no speech bubble at her seat).
- **Lessons** (Speluitleg, issue #41; the Oefenen sheet has the switch
  *Speluitleg*, "Juf Jannie legt het spel stap voor stap uit", on until turned
  off, kept in `kj.lessons`): the step on screen (`lesson`) is in the coach
  bubble, 👩‍🏫 without a label, with *Verder* without a ring; *Verder*, ✕,
  Enter or Space, or a tap anywhere on the table that is no button (also on
  a card while the game waits for the step) sends `tipRead` with its `n`,
  once per step and not in its first 450 ms (the second tap of a double tap,
  or a tap meant for the card that completed the trick, would skip it). A
  tap beside the hand with a card lifted puts the card down first. On the
  learner's turn the step comes before the hint: the advised card glows once
  it is read. The part of the screen a step is about lights up (`.spot`, a
  pulsing gold outline, steady with reduced motion): `partner` Juf Jannie's
  seat, `hand` the cards in the hand (their hint glow), `card` one card in
  the hand (the same glow; the hint's glow waits), `trick` a box round
  the trick, `trump` the trump badge, `score` the score pill, `rule` the
  rule above the hand, `chat` the chat button, or on wide screens the chat
  beside the table. Input handlers read the step on screen (`app.view`): the
  trick animation shows a trick's explanation before it becomes `app.s`.
- **Spelanalyse** (issues #6 and #18, four players only): under the final
  score, a line for the player alone: *Jouw spel volgens Juf Jannie: 87% (goed
  gespeeld) ›* (*Jouw spelanalyse wordt berekend…*, disabled, while grades
  are out; hidden without a review). Juf Jannie stands for the engine of the
  hints, so the numbers read as hers, not as a fact. The verdict is
  *sterk gespeeld* from 95%, *goed gespeeld* from 82%, else *kan beter*
  (`reviewVerdict`; the bounds fit the bots' averages in `TestGradeLevels`:
  sterk ≈ 99, normaal ≈ 87, makkelijk ≈ 76). It opens *Jouw spelanalyse*:
  *Volgens Juf Jannie* over the percentage with ⓘ (who Juf Jannie is, how she
  plays every option out over deals of the unseen cards, what a point is:
  the difference between the two teams' scores, so a point that goes to
  the opponents counts twice and a higher chance of nat costs much, that it
  stays an estimate, and how the percentage, *Laten liggen* and *Sterke
  zet* follow), potjes and keuzes, then
  *Jouw kaarten* (*Boven gemiddeld (+8)*, *Gemiddeld (+1)* within ±4,
  *Onder gemiddeld (−6)*: points per potje, ⓘ), *Sterke zetten*, *Laten
  liggen* (points in zetten), *Uitkomen* (*9 van 11 keer de beste kaart*),
  *Troefkeuze* (*4 van 5 keer de beste keuze*), *Roem weggegeven* (ⓘ), and
  in gedraaid when it happened *Gespeeld met meer dan 40% kans op nat: 2
  keer, 1 keer nat*. Then *Snelheid* (`speed`): *Bedenktijd per zet* (the
  median, ⓘ), *Langste bedenktijd 48 s (potje 4, slag 2)*, *De tafel
  wachtte op jou 6 min 10 s*, and with other people at the table *Anderen
  per zet* and *Jij wachtte op de anderen* (`timeText`: "0,8 s", "48 s",
  "6 min 10 s"). Below, the listed moments: *Potje 3, slag 2 · ♠A: …*
  and *Potje 5, slag 3 · ♠10 gespeeld, ♠A 18 punten beter: …* (*♥ als
  troef, ♣ 14 punten beter: …*, *Gepast, spelen 12 punten beter: …*), each
  with a line that splits the points (`outcomeLine`): *Jullie +11, zij −7;
  kans dat jullie nat gaan 31% → 18%* (a chance that moves by less than 5
  is left out), for a strong move *Tegenover ♠8: jullie +6, zij −6*. A tap
  opens the replay at that moment; *Potjes terugkijken* opens it at the
  first hand. The header line under the percentage ends with the seed:
  *16 potjes · 118 keuzes · seed 482913*. Then
  *Vorige partijen 79% · 83%* (the percentages of up to five earlier matches
  on this device, `kj.reviews`, the last 20 kept) and the line *Disclaimer:
  Dit is slechts de mening van Juf Jannie.*, and last *Opmerkingen*: a text
  field (*Wat viel je op? Wat klopt er volgens jou niet?*) with *Versturen*
  (`feedback`; *Bewaard.* on `saved`) and the line *Je opmerking wordt met
  je naam bewaard, net als de partij zelf: hooguit 12 maanden, voor
  statistieken en om het spel te verbeteren.* Apart from the verdict, the wording is plain and factual:
  numbers, cards and the hint's reasons, no praise or consolation. The game-over buttons stay in view with
  the line: on a short phone it takes the place of the emoji (portrait up to
  760 px high) and of *Laatste potje* (up to 680 px); in short landscape the
  sub-line goes and the title and score shrink.
- **Terugkijken** (the replay, `replay`): a finished hand card by card with
  all four hands open. On top *Potje 4 van 16* with ‹ › for the other hands
  and "♥ troef · Kees speelt"; from a moment, the moment and its split
  (*Naar dit moment* once stepped away). The trick lies at the seats with
  every name, whose turn it is marked, then "Kees is aan de beurt" or, with
  the trick complete, "Kees neemt de slag · 21 punten · roem: …", and *Stand
  in dit potje: Wij 34 – Zij 12* (card points and roem of the tricks taken),
  after the last card *Uitslag: Wij 0 – Zij 182 · Wij nat*. Below, the
  hands left, the player's first: at the moment the card played and the
  better (or obvious) one are marked in it, with a key. A bar under the
  scrolling body keeps ‹ *Slag 4 · 2 van 4 kaarten* › (also ←/→) and the
  eight tricks (each in its taker's colour; a tap shows it complete) in
  view. A moment opens just before the player's card (a lead: with the
  previous trick still on the table), a trump choice or bid before the
  first card. In short landscape the table sits beside the moment and the
  hands, and the bar is one line. Outside the expert mode the replay has no
  choices of the player's own and no feedback per situation (issue #34):
  the review's *Opmerkingen* is about the game as a whole.
- **Expert** (§3 Expert mode; `expert.js`): the replay with the expert's
  tools, titled *Expert: terugkijken*, wider on large screens. It opens from
  the table's search button (top bar, only in an expert game: the hand in
  play, after its latest card, and it follows the cards played while it is
  open), from *Dit potje terugkijken* on the hand summary (at the deal),
  and at game over from *Potjes terugkijken* or a moment of the review (all
  hands, `expert.hands`). Under the table a box shows the decision at that
  step: before the first card a chip per seat's bid or trump choice and one
  for the first card (*Kees (AI): ♥ als troef*, *Kees (AI) speelde ♦7*), the
  card chosen by default; after the latest card of the hand in play the
  decision awaited now (*Slag 3 · Jij bent aan de beurt*). For the decision
  chosen: the head (*Slag 3 · Bram (AI) speelde ♠8*); the expert's own
  choice (the decider's card is lifted with a gold ring, the cards it could
  play are tappable, a tap sends `mark` and gives a blue ring, *Jouw keuze:
  ♠9. Tik er nog eens op om hem weg te halen.*; four suit buttons for a
  trump choice, *Spelen* and *Passen* for a bid); *Redenering van de AI*
  (`why`; *De AI denkt na…* until the answer), which shows *Normaal:* the
  normaal choice with its rule's reason, *Sterk:*, *Tip:* the hint, a table
  of every option (*Waarde*, *±*, for a card *Punten slag*, *Punten
  later*, *Roem slag*, *Roem later*, *Nat, pit*, and *Nat wij*, *Nat zij*;
  the option played marked *gespeeld* or *gekozen*, the best value in gold;
  on a phone the table scrolls sideways) and *Over 400 verdelingen van de
  kaarten die Bram (AI) niet kon zien.* with an ⓘ on what the numbers mean;
  answers are kept per situation while the page lives. Last a fold-out
  *Commentaar bij ♠8 van Bram (AI)*: one feedback form for the whole
  replay (typed text stays across steps), sent with the hand, trick and
  seat of the decision shown. Values read as numbers, plainly.
- **Help**: the manual (SECTIONS) in a modal, plus `title` tooltips and small ⓘ
  explanations on UI elements.
- **Responsive**: phones portrait (360×640 up, and an iPhone SE in Safari:
  375×548) and landscape (≥ 640×360), tablets and desktop; touch targets
  ≥ 44 px; no horizontal scroll.
- **Look**: green felt table with vignette, wooden rim, gold accents, team colours
  (Wij teal/blue, Zij coral/red), dark UI chrome; four-colour deck option.

## 10. Deployment

- `Containerfile` stages: `build` (the official golang Alpine image: `go vet`,
  `go test -short ./...`, static build with `-trimpath -ldflags "-s -w -X
  main.version=$GIT_SHA"`), `server` (`FROM scratch`, binary + CA-less, `USER
  65532:65532`), `web` (`nginxinc/nginx-unprivileged`, Alpine, `deploy/nginx.conf`,
  `web/`). The base tags (minor versions) live only in the `Containerfile`;
  `scripts/go` and `scripts/dev-server` read the build image from its `FROM … AS
  build` line, and `make image` builds with `--pull=newer`, so a fix re-published
  under the same tag reaches the next deploy. The `web-conf` stage renders
  `@SITE@` into `nginx.conf` (checked with `nginx -t`) and into `index.html`
  (`og:image`), which the `web` stage copies over the one from `web/`.
- `deploy/nginx.conf`: listen 8080; `/ws` → `http://127.0.0.1:8081` with Upgrade
  headers and long read timeout; `/api/` → same; `location ~ "^/[A-Za-z]{4}$"` →
  `/index.html`; security headers in one place (CSP `default-src 'self';
  connect-src 'self' wss://@SITE@; img-src 'self' data:; style-src 'self';
  script-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self';
  object-src 'none'; form-action 'none'`, nosniff, Referrer-Policy,
  Permissions-Policy (camera and microphone for the page itself, for the
  call; geolocation, payment and USB for nobody), COOP, HSTS
  `max-age=31536000; includeSubDomains`), each sent
  once on every path (`scripts/pod-check`); `Cache-Control: no-cache` for html/js/css (ETag
  revalidation) so a deploy is picked up at once, a day for images, but never
  for a 404, which is `text/html` whatever the path's extension; gzip; `X-Real-IP` forwarding:
  NPM's `X-Real-IP` is trusted from `127.0.0.1` only and passed on as the one
  client address (`X-Forwarded-For` is dropped); `Host` is passed unchanged
  (`$http_host`), which the websocket Origin check compares against.
- Quadlets rendered by `make install` into `~/.config/containers/systemd/`:
  `klaverjas.pod` (`PublishPort=127.0.0.1:8093:8080`; `Network=pasta:--host-lo-to-ns-lo`,
  so NPM's connections arrive from `127.0.0.1` instead of the host's LAN
  address; `ExitPolicy=continue`, so both containers dying at once does not
  stop the pod for good), `klaverjas-web.container`,
  `klaverjas-server.container` (`Pod=klaverjas.pod`, `Pull=never`, `ReadOnly`,
  `NoNewPrivileges`, `DropCapability=ALL`, health checks; the server's unit
  mounts the named volume `klaverjas-games` at `/data`, owned by the server's
  user (`:U`), and runs `-addr 127.0.0.1:8081 -games /data`: the game log of
  §6, which `make uninstall` keeps; `deploy/README-deploy.md` says how to read
  it).
- `Makefile` like `/storage/CLIC/ISMS/Makefile`: `help test test-all e2e dev
  dev-stop image install deploy check status logs uninstall quadlet`, settings
  `SITE ?= klaverjas.kroes.dev`, `ADDR ?= 127.0.0.1:8093`. The revision
  (`GIT_SHA`, the image label and `/api/health`'s version) is `HEAD`, with
  `-dirty` when `git status` lists anything; each build tags both images
  `<GIT_SHA>-YYYYmmdd-HHMMSS`, and only `make deploy` then moves `:current`
  (what the units run) to it, so `make image` alone never changes what a
  restart starts. `make deploy` refuses a dirty tree unless `ALLOW_DIRTY=1`,
  and ends with `make check`.
- NPM proxy host (made by hand; it exists, ID 37): `klaverjas.kroes.dev` →
  `http://127.0.0.1:8093`, wildcard certificate, Force SSL, Block Common
  Exploits, **Websockets Support ON**, no access list, HTTP/2 off (either
  works); Advanced empty and NPM's HSTS box off, since HSTS comes from
  `deploy/nginx.conf` (recorded in `deploy/npm-advanced.conf`).
