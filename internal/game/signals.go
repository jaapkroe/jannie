package game

// Signals are a table's agreements on signals (design §8): which plays
// tell the partner something. They are no rules of the game, so every card
// stays legal; bots give, read and explain only the signals agreed.
type Signals struct {
	Aas          bool `json:"aas"`          // aas vraagt 10: a side ace led says "ik heb de 10 ook"
	KleintjeBoer bool `json:"kleintjeBoer"` // a 7, 8 or 9 of a side suit, the first lead of the playing team, says "ik heb de troefboer"
	HoogLaag     bool `json:"hoogLaag"`     // on the partner's trick a low discard asks for its suit, a high one says "weinig in deze kleur"
	BoerOverBoer bool `json:"boerOverBoer"` // a side boer, the first lead of the playing team, says "ik heb de troefboer"
}

// DefaultSignals are the agreements of a new table: all but boer over
// boer.
var DefaultSignals = Signals{Aas: true, KleintjeBoer: true, HoogLaag: true}

// SignalsOf returns the agreements of the table of v: v.Signals, or the
// defaults when the view carries none.
func SignalsOf(v *View) Signals {
	if v.Signals != nil {
		return *v.Signals
	}
	return DefaultSignals
}
