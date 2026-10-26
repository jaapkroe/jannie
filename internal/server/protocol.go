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
	Expert   bool            `json:"expert"`
	Start    bool            `json:"start"`
	Code     string          `json:"code"`
	Token    string          `json:"token"`
	Seat     *int            `json:"seat"` // also mark, why, feedback (expert): whose decision; default your own
	ID       string          `json:"id"`   // bot: the persona; call: the call session ("" hangs up)
	Suit     string          `json:"suit"`
	Play     *bool           `json:"play"`
	Bid      *int            `json:"bid"`
	Cards    []string        `json:"cards"`
	Card     string          `json:"card"`
	Text     string          `json:"text"`
	AI       *bool           `json:"ai"`
	Left     *bool           `json:"left"`  // vote, optional: the question it answers is about a seat its player left
	Hand     *int            `json:"hand"`  // mark, why, feedback: the hand (its number)
	Trick    *int            `json:"trick"` // mark, why, feedback: the trick (1–8; 0: the trump choice or bid)
	N        *int            `json:"n"`     // tipRead: the lesson step read (lesson.go)
	Mic      *bool           `json:"mic"`   // call: the microphone is on
	Cam      *bool           `json:"cam"`   // call: the camera is on
	To       string          `json:"to"`    // rtc: the call session it is for
	Desc     *rtcDesc        `json:"desc"`  // rtc: the session description (call.go)
}

// whyMsg is the engine's reasoning for one decision (expert): see
// cmdWhy.
type whyMsg struct {
	T        string       `json:"t"` // "why"
	Hand     int          `json:"hand"`
	Trick    int          `json:"trick"`
	Seat     game.Seat    `json:"seat"`
	Played   *choiceJSON  `json:"played"` // null: the decision awaited now
	Normaal  choiceJSON   `json:"normaal"`
	Rule     string       `json:"rule"`
	Sterk    choiceJSON   `json:"sterk"`
	Hint     choiceJSON   `json:"hint"`
	HintText string       `json:"hintText"`
	Worlds   int          `json:"worlds"`
	Options  []optionJSON `json:"options"`
}

// optionJSON is one option of an explanation, rounded to tenths.
type optionJSON struct {
	choiceJSON
	Value   float64   `json:"value"`
	SE      float64   `json:"se"`
	Us      float64   `json:"us"`
	Them    float64   `json:"them"`
	NatUs   float64   `json:"natUs"`   // share of deals
	NatThem float64   `json:"natThem"` // share of deals
	Parts   []float64 `json:"parts,omitempty"`
}

// savedMsg confirms that something the player sent was kept (feedback).
type savedMsg struct {
	T    string `json:"t"`
	What string `json:"what"`
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
	// Coach: training, a line of Juf Jannie that the coach bubble shows (a
	// lesson step or the explanation of a trick), not a speech bubble.
	Coach bool `json:"coach,omitempty"`
}

type chatOut struct {
	T   string  `json:"t"`
	Msg chatMsg `json:"msg"`
}

type chatlogMsg struct {
	T    string    `json:"t"`
	Msgs []chatMsg `json:"msgs"`
}

// refusedMsg tells the host that name could not join: the table is full.
type refusedMsg struct {
	T    string `json:"t"`
	Name string `json:"name"`
}

// rtcOut passes a session description on from one call session to
// another (call.go).
type rtcOut struct {
	T    string   `json:"t"` // "rtc"
	From string   `json:"from"`
	Seat int      `json:"seat"`
	Desc *rtcDesc `json:"desc"`
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

// evAuction is a bid (bid > 0) or a pass (bid 0) with three players.
type evAuction struct {
	Type string    `json:"type"`
	Seat game.Seat `json:"seat"`
	Bid  int       `json:"bid"`
}

// evContract ends the auction: seat plays alone for bid (forced: the
// others passed and nobody bid) and takes the talon.
type evContract struct {
	Type   string    `json:"type"`
	Seat   game.Seat `json:"seat"`
	Bid    int       `json:"bid"`
	Forced bool      `json:"forced"`
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
	Total  []int  `json:"total"`
	Winner int    `json:"winner"`
}

// evSeat is join, leave, away, back and takeover, and with three players
// discard.
type evSeat struct {
	Type string    `json:"type"`
	Seat game.Seat `json:"seat"`
}

// state is the full per-seat state `s` of an update (design §7). Fields
// without omitempty are always present; roster, legal and rule only when
// they apply.
type state struct {
	Code        string              `json:"code"`
	Phase       string              `json:"phase"`
	Opts        Options             `json:"opts"`
	Training    bool                `json:"training"`
	Expert      *expertState        `json:"expert"`
	You         int                 `json:"you"`
	Host        int                 `json:"host"`
	Roster      []rosterEntry       `json:"roster,omitempty"`
	Players     []*playerState      `json:"players"`
	HandNo      int                 `json:"handNo"`
	Hands       int                 `json:"hands"`
	Dealer      int                 `json:"dealer"`
	Voorhand    int                 `json:"voorhand"`
	Turned      *game.Suit          `json:"turned"`
	Bids        []int               `json:"bids"`
	Forced      bool                `json:"forced"`
	Bid         int                 `json:"bid"`
	Bidder      int                 `json:"bidder"`
	Soloist     int                 `json:"soloist"`
	Talon       []game.Card         `json:"talon"`
	Discards    []game.Card         `json:"discards"`
	Piles       *[2][8]game.Pile    `json:"piles"`
	OpenRoem    *[2][]game.RoemItem `json:"openRoem"`
	Trump       *game.Suit          `json:"trump"`
	TrumpBy     int                 `json:"trumpBy"`
	PlayingTeam int                 `json:"playingTeam"`
	Turn        int                 `json:"turn"`
	Takeover    *takeoverState      `json:"takeover"`
	Hand        []game.Card         `json:"hand"`
	Legal       []game.Card         `json:"legal,omitempty"`
	Rule        string              `json:"rule,omitempty"`
	Trick       *game.Trick         `json:"trick"`
	LastTrick   *game.Trick         `json:"lastTrick"`
	TricksWon   [2]int              `json:"tricksWon"`
	HandPoints  [2]int              `json:"handPoints"`
	HandRoem    [2]int              `json:"handRoem"`
	Scores      []scoreRow          `json:"scores"`
	Total       []int               `json:"total"`
	PrevHand    *prevHand           `json:"prevHand"`
	NextAt      int64               `json:"nextAt"`
	Hint        *hint               `json:"hint"`
	Lesson      *lessonStep         `json:"lesson"`
	Hands4      *[4][]game.Card     `json:"hands4"`
	Winner      int                 `json:"winner"`
	Review      *reviewState        `json:"review"`
}

type rosterEntry struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
	Color string `json:"color"`
	Bio   string `json:"bio"`
}

type playerState struct {
	Name      string     `json:"name"`
	Bot       bool       `json:"bot"`
	BotID     string     `json:"botId"`
	Emoji     string     `json:"emoji"`
	Color     string     `json:"color"`
	Connected bool       `json:"connected"`
	Away      bool       `json:"away"`
	Left      bool       `json:"left"`
	Vote      *bool      `json:"vote"`
	Call      *callState `json:"call"`
	Cards     int        `json:"cards"`
	Ready     bool       `json:"ready"`
}

// takeoverState is the question to the table: may an AI play the seat the
// game waits for? Left: its player left (else they dropped out).
type takeoverState struct {
	Seat game.Seat `json:"seat"`
	Left bool      `json:"left"`
}

// scoreRow is one line of the score sheet. Points, roem and score are per
// side, gains per scorer (game.HandResult).
type scoreRow struct {
	Hand        int       `json:"hand"`
	Dealer      game.Seat `json:"dealer"`
	Trump       game.Suit `json:"trump"`
	TrumpBy     game.Seat `json:"trumpBy"`
	PlayingTeam int       `json:"playingTeam"`
	Bid         int       `json:"bid"`
	Points      [2]int    `json:"points"`
	Roem        [2]int    `json:"roem"`
	Score       [2]int    `json:"score"`
	Gains       []int     `json:"gains"`
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
