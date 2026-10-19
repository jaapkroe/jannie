package server

import (
	"encoding/json"

	"klaverjas/internal/game"
)

// inMsg is any client message; the fields used depend on T (design §7).
type inMsg struct {
	T        string          `json:"t"`
	Name     string          `json:"name"`
	Opts     json.RawMessage `json:"opts"`
	Training bool            `json:"training"`
	Start    bool            `json:"start"`
	Code     string          `json:"code"`
	Token    string          `json:"token"`
	Seat     *int            `json:"seat"`
	ID       string          `json:"id"`
	Suit     string          `json:"suit"`
	Play     *bool           `json:"play"`
	Card     string          `json:"card"`
	Text     string          `json:"text"`
}

// Error codes on the wire.
const (
	errUnknown    = "onbekend"
	errFull       = "vol"
	errStarted    = "gestart"
	errNotHost    = "geen-host"
	errNotTurn    = "niet-jouw-beurt"
	errInvalid    = "ongeldig"
	errLimit      = "limiet"
	errTooMany    = "te-veel-spellen"
	errRestarting = "herstart"
)

type errorMsg struct {
	T    string `json:"t"`
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

type joinedMsg struct {
	T     string `json:"t"`
	Code  string `json:"code"`
	Seat  int    `json:"seat"`
	Token string `json:"token"`
}

type updateMsg struct {
	T   string `json:"t"`
	Seq int    `json:"seq"`
	Ev  any    `json:"ev"`
	S   *state `json:"s"`
}

type chatMsg struct {
	Seat int    `json:"seat"`
	Name string `json:"name"`
	Text string `json:"text"`
	TS   int64  `json:"ts"`
	Bot  bool   `json:"bot"`
	Sys  bool   `json:"sys"`
}

type chatOut struct {
	T   string  `json:"t"`
	Msg chatMsg `json:"msg"`
}

type chatlogMsg struct {
	T    string    `json:"t"`
	Msgs []chatMsg `json:"msgs"`
}

type tipMsg struct {
	T    string `json:"t"`
	Text string `json:"text"`
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic("server: marshal: " + err.Error())
	}
	return b
}

func errorJSON(code, msg string) []byte {
	return mustJSON(errorMsg{T: "error", Code: code, Msg: msg})
}

var pongJSON = []byte(`{"t":"pong"}`)

// Events (ev.type), one struct per kind so zero values are always written.

type evLobby struct {
	Type string `json:"type"`
}

type evDeal struct {
	Type   string    `json:"type"`
	HandNo int       `json:"handNo"`
	Dealer game.Seat `json:"dealer"`
}

type evTurned struct {
	Type string    `json:"type"`
	Suit game.Suit `json:"suit"`
}

type evBid struct {
	Type string    `json:"type"`
	Seat game.Seat `json:"seat"`
	Play bool      `json:"play"`
}

type evTrump struct {
	Type   string    `json:"type"`
	Seat   game.Seat `json:"seat"`
	Suit   game.Suit `json:"suit"`
	Forced bool      `json:"forced"`
}

type evPlay struct {
	Type string    `json:"type"`
	Seat game.Seat `json:"seat"`
	Card game.Card `json:"card"`
}

type evTrick struct {
	Type   string          `json:"type"`
	Winner game.Seat       `json:"winner"`
	Points int             `json:"points"`
	Roem   []game.RoemItem `json:"roem"`
	Last   bool            `json:"last"`
}

type evCollect struct {
	Type   string    `json:"type"`
	Winner game.Seat `json:"winner"`
}

type evHandEnd struct {
	Type   string          `json:"type"`
	Result game.HandResult `json:"result"`
}

type evGameOver struct {
	Type   string `json:"type"`
	Total  [2]int `json:"total"`
	Winner int    `json:"winner"`
}

// evSeat is join, leave, away and back.
type evSeat struct {
	Type string    `json:"type"`
	Seat game.Seat `json:"seat"`
}

// state is the full per-seat state `s` of an update (design §7). Fields
// without omitempty are always present; roster, legal and rule only when
// they apply.
type state struct {
	Code        string          `json:"code"`
	Phase       string          `json:"phase"`
	Opts        Options         `json:"opts"`
	Training    bool            `json:"training"`
	You         int             `json:"you"`
	Host        int             `json:"host"`
	Roster      []rosterEntry   `json:"roster,omitempty"`
	Players     [4]*playerState `json:"players"`
	HandNo      int             `json:"handNo"`
	Hands       int             `json:"hands"`
	Dealer      int             `json:"dealer"`
	Voorhand    int             `json:"voorhand"`
	Turned      *game.Suit      `json:"turned"`
	Bids        [4]int          `json:"bids"`
	Forced      bool            `json:"forced"`
	Trump       *game.Suit      `json:"trump"`
	TrumpBy     int             `json:"trumpBy"`
	PlayingTeam int             `json:"playingTeam"`
	Turn        int             `json:"turn"`
	Hand        []game.Card     `json:"hand"`
	Legal       []game.Card     `json:"legal,omitempty"`
	Rule        string          `json:"rule,omitempty"`
	Trick       *game.Trick     `json:"trick"`
	LastTrick   *game.Trick     `json:"lastTrick"`
	TricksWon   [2]int          `json:"tricksWon"`
	HandPoints  [2]int          `json:"handPoints"`
	HandRoem    [2]int          `json:"handRoem"`
	Scores      []scoreRow      `json:"scores"`
	Total       [2]int          `json:"total"`
	PrevHand    *prevHand       `json:"prevHand"`
	NextAt      int64           `json:"nextAt"`
	Hint        *hint           `json:"hint"`
	Hands4      *[4][]game.Card `json:"hands4"`
	Winner      int             `json:"winner"`
}

type rosterEntry struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
	Color string `json:"color"`
	Bio   string `json:"bio"`
}

type playerState struct {
	Name      string `json:"name"`
	Bot       bool   `json:"bot"`
	BotID     string `json:"botId"`
	Emoji     string `json:"emoji"`
	Color     string `json:"color"`
	Connected bool   `json:"connected"`
	Away      bool   `json:"away"`
	Cards     int    `json:"cards"`
	Ready     bool   `json:"ready"`
}

// scoreRow is one line of the score sheet.
type scoreRow struct {
	Hand        int       `json:"hand"`
	Dealer      game.Seat `json:"dealer"`
	Trump       game.Suit `json:"trump"`
	TrumpBy     game.Seat `json:"trumpBy"`
	PlayingTeam int       `json:"playingTeam"`
	Points      [2]int    `json:"points"`
	Roem        [2]int    `json:"roem"`
	Score       [2]int    `json:"score"`
	Nat         bool      `json:"nat"`
	Pit         bool      `json:"pit"`
}

// prevHand is the review of the last finished hand.
type prevHand struct {
	Tricks []game.Trick    `json:"tricks"`
	Result game.HandResult `json:"result"`
}

// hint is a training hint; exactly one of Card, Suit and Play is set.
type hint struct {
	Card *game.Card `json:"card,omitempty"`
	Suit *game.Suit `json:"suit,omitempty"`
	Play *bool      `json:"play,omitempty"`
	Text string     `json:"text"`
}
