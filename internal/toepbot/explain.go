package toepbot

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"klaverjas/internal/game"
	"klaverjas/internal/toepen"
)

// Explanation is the reasoning of the engine for one decision of a player
// (the expert's sheet Redenering van de AI): what sterk would do and why,
// the value of every option, and the rule of thumb of normaal. It is about
// the asker's own decision now, from what that player knows (its view):
// it gives nothing of the others' hands away.
type Explanation struct {
	Decision string     // "kaart", "antwoord", "was", "controle", "wegleggen"
	Advice   string     // what sterk would do, in Dutch
	Why      string     // why, in Dutch
	Rule     string     // the rule of thumb, in Dutch; "" when none applies
	RuleCard *game.Card // the rule's card, when it is one
	Chance   float64    // the chance to take the last trick (0..1); -1 when not asked
	Options  []Option   // every option with its value
	Worlds   int        // the deals sampled
}

// Option is one choice and its value: a share of the sampled deals in
// which it takes the last trick (or, for a check, the chance of a bluff),
// or expected penalty points (Points: lower is better); -1 for none.
type Option struct {
	Label  string      // a choice in words ("Meegaan"); "" for cards
	Cards  []game.Card // the card played, or the cards laid away
	Value  float64
	Points bool
	Best   bool // what sterk chooses
}

// explainWorlds is the deals sampled for an explanation: as many as sterk
// samples for a decision, more for laying away.
const explainWorlds = 240

// Explain works out the reasoning for v.Seat's decision now, as sterk of
// average boldness decides it, with the rule of thumb of normaal. seed
// makes the sampled deals repeatable.
func Explain(v toepen.View, seed uint64) Explanation {
	p := New(0.5, Sterk, seed)
	switch {
	case v.Phase == toepen.PhaseDiscard && v.Lay > 0:
		return p.explainDiscard(&v)
	case v.Phase == toepen.PhaseWas:
		return p.explainWas(&v)
	case v.Phase == toepen.PhaseCheck:
		return p.explainCheck(&v)
	case v.Phase == toepen.PhaseToep:
		return p.explainAnswer(&v)
	case v.Phase == toepen.PhasePlay:
		return p.explainPlay(&v)
	}
	return Explanation{Chance: -1}
}

// cardNL is a card as the table writes it: "♥10", "♠B".
func cardNL(c game.Card) string { return c.Suit.Symbol() + c.Rank.Letter() }

func cardsNL(cs []game.Card) string {
	out := make([]string, len(cs))
	for k, c := range cs {
		out[k] = cardNL(c)
	}
	return strings.Join(out, " ")
}

func pct(x float64) string { return fmt.Sprintf("%d%%", int(math.Round(100*x))) }

func pts(x float64) string {
	s := strings.Replace(fmt.Sprintf("%.1f", x), ".", ",", 1)
	return strings.TrimSuffix(s, ",0")
}

// ---- a card ----

// shares is, per card of legal, the weighted share of sampled deals in
// which v.Seat takes the last trick when it plays that card.
func (p *Player) shares(v *toepen.View, legal []game.Card) []float64 {
	s := newSampler(v)
	wins := make([]float64, len(legal))
	total := 0.0
	for range p.worlds() {
		w := s.draw(p.rng)
		weight := p.weight(v, &w)
		total += weight
		for k, c := range legal {
			if playout(v, &w, c) == v.Seat {
				wins[k] += weight
			}
		}
	}
	if total > 0 {
		for k := range wins {
			wins[k] /= total
		}
	}
	return wins
}

// ruleCard is normal's card with the rule of thumb that chose it.
func ruleCard(hand []game.Card, t toepen.Trick, in func(game.Seat) bool) (game.Card, string) {
	c := normalCard(hand, t, in)
	legal := toepen.Legal(hand, t)
	led, leads := t.Led()
	keep := strongest(hand)
	switch {
	case len(legal) == 1:
		return c, "Je kunt maar één kaart spelen."
	case !leads && c.Suit != keep.Suit:
		return c, "Kom laag uit, met een andere kleur dan je beste kaart: die bewaar je voor de laatste slag."
	case !leads:
		return c, "Kom laag uit: je beste kaart bewaar je voor de laatste slag."
	case legal[0].Suit != led:
		return c, "Je kunt niet bekennen: gooi je zwakste kaart weg."
	case len(hand) == 2 && c != keep && slices.ContainsFunc(t.Cards, func(p game.Played) bool { return toepen.Beats(c, p.Card) }):
		return c, "De voorlaatste slag: neem hem met een andere kaart dan je beste, dan kom je in de laatste slag uit met je beste."
	}
	return c, "Beken met je laagste kaart: je beste bewaar je voor de laatste slag."
}

// toepBar is the chance on the last trick above which sterk toeps.
func (p *Player) toepBar(v *toepen.View) float64 {
	return 0.5 + 0.06*float64(3-min(v.InCount(), 3)) - 0.1*p.aggr
}

// raiseBar is the chance above which sterk overtoeps.
func (p *Player) raiseBar(v *toepen.View) float64 {
	return 0.68 + 0.06*float64(v.Stake-2) + 0.05*float64(3-min(v.InCount(), 3)) - 0.08*p.aggr
}

func (p *Player) explainPlay(v *toepen.View) Explanation {
	legal := v.Legal
	if len(legal) == 0 {
		legal = toepen.Legal(v.Hand, v.Current)
	}
	e := Explanation{Decision: "kaart", Worlds: p.worlds()}
	rc, rule := ruleCard(v.Hand, v.Current, v.In)
	e.Rule, e.RuleCard = rule, &rc
	sh := p.shares(v, legal)
	best := 0
	for k := range legal {
		if sh[k] > sh[best]+1e-9 || math.Abs(sh[k]-sh[best]) <= 1e-9 && legal[k] == rc {
			best = k
		}
	}
	for k, c := range legal {
		e.Options = append(e.Options, Option{Cards: []game.Card{c}, Value: sh[k], Best: k == best})
	}
	q := sh[best]
	e.Chance = q
	play := cardNL(legal[best])
	e.Advice = "Speel " + play
	e.Why = fmt.Sprintf("Met %s haal je in %s van de %d nagespeelde verdelingen de laatste slag.", play, pct(q), e.Worlds)
	if len(legal) == 1 {
		e.Why = "Je kunt maar één kaart spelen. " + e.Why
	}
	if v.CanToep {
		bar := p.toepBar(v)
		e.Options = append(e.Options, Option{Label: "Toepen", Value: q, Best: q >= bar})
		if q >= bar {
			e.Advice = "Toep, en speel dan " + play
			e.Why += fmt.Sprintf(" Dat is meer dan de grens om te toepen (%s): de anderen moeten dan meer betalen of passen.", pct(bar))
		} else {
			e.Why += fmt.Sprintf(" Te weinig om te toepen: de grens is %s (hoger met minder spelers). Een bluf met een kansloze hand kan af en toe, ook bij een hogere inzet.", pct(bar))
		}
	}
	return e
}

// ---- going along, passing, overtoepen ----

func (p *Player) explainAnswer(v *toepen.View) Explanation {
	e := Explanation{Decision: "antwoord", Worlds: p.worlds()}
	q := p.winChance(v)
	e.Chance = q
	me, limit := v.Points[v.Seat], v.Rules.Limit
	fold := cost(me, v.Stake-1, limit)
	stay := cost(me, v.Stake, limit)
	risk := (1.05 - 0.15*p.aggr) * p.distrust(v)
	lose := (1 - q) * stay
	e.Options = []Option{{Label: "Meegaan", Value: lose, Points: true}}
	raise := v.CanRaise && v.Stake < 5 && q >= p.raiseBar(v)
	if v.CanRaise {
		e.Options = append(e.Options, Option{Label: "Overtoepen", Value: q, Best: raise})
	}
	if !v.MustStay {
		e.Options = append(e.Options, Option{Label: "Passen", Value: fold, Points: true})
	}
	out := ""
	if me+v.Stake >= limit {
		out = " Verlies je, dan lig je eruit: dat telt hier als vijf strafpunten extra."
	}
	why := fmt.Sprintf("Je kans op de laatste slag is %s. Meegaan kost gemiddeld %s strafpunten (de inzet %d maal je kans om te verliezen), passen kost er %s.%s",
		pct(q), pts(lose), v.Stake, pts(fold), out)
	if o := v.Toeper; o != game.NoSeat && v.Record[o].Toeps > 0 {
		r := v.Record[o]
		why += fmt.Sprintf(" Van de %d toeps van de toeper die op tafel kwamen, waren er %d bluf: zo vaak telt een zwakke hand mee in die kans.",
			r.Toeps, r.ToepBluffs)
	}
	stays := true
	switch {
	case v.MustStay:
		e.Advice = "Ga mee: anti-lijntoep"
		why = "Je paste al twee keer achter elkaar, dus nu moet je mee (of overtoepen). " + why
	case raise:
		e.Advice = "Overtoep"
		why += fmt.Sprintf(" Met zoveel kans (de grens is %s) zet je de inzet nog hoger.", pct(p.raiseBar(v)))
	case v.InCount() <= 1 || fold >= stay:
		e.Advice = "Ga mee"
		why += " Passen kost evenveel als verliezen: meegaan dus."
	case lose*risk < fold:
		e.Advice = "Ga mee"
	default:
		e.Advice, stays = "Pas", false
	}
	for k := range e.Options {
		switch e.Options[k].Label {
		case "Meegaan":
			e.Options[k].Best = stays && !raise
		case "Passen":
			e.Options[k].Best = !stays
		}
	}
	if v.CanRaise && !raise {
		why += fmt.Sprintf(" Overtoepen pas boven %s kans%s.", pct(p.raiseBar(v)), map[bool]string{true: ", en nooit vanaf inzet 5", false: ""}[v.Stake >= 4])
	}
	e.Why = why
	e.Rule = "Vergelijk wat passen kost met de nieuwe inzet maal je kans om te verliezen; eruit gaan weegt extra zwaar."
	return e
}

// ---- the vuile was ----

func (p *Player) explainWas(v *toepen.View) Explanation {
	e := Explanation{Decision: "was", Worlds: p.worlds()}
	kind := toepen.Was(v.Hand)
	q := p.winChance(v)
	e.Chance = q
	poor := v.Armoede[v.Seat]
	claim := kind != toepen.NoWas && v.CanClaim
	e.Options = []Option{{Label: "Vuile was!", Value: -1, Best: claim}, {Label: "Geen", Value: -1, Best: !claim}}
	e.Rule = "Lever een echte vuile was altijd in; bluf af en toe met een kansloze hand, nooit op armoede."
	switch {
	case !v.CanClaim && kind != toepen.NoWas:
		e.Advice = "Geen: de stapel is op"
		e.Why = "Je hebt een " + kind.NameNL() + ", maar de stapel heeft geen vier kaarten meer."
	case claim:
		e.Advice = "Lever in: een echte " + kind.NameNL()
		e.Why = fmt.Sprintf("Met deze hand haal je in %s van de verdelingen de laatste slag. Vier nieuwe kaarten zijn bijna altijd beter, en wie controleert, krijgt zelf een strafpunt.", pct(q))
		if poor {
			e.Why += " Op armoede leg je hem open op tafel."
		}
	case poor:
		e.Advice = "Geen: op armoede mag je niet bluffen"
		e.Why = fmt.Sprintf("Je hand is geen vuile was. Je kans op de laatste slag is %s.", pct(q))
	case q < 0.12:
		e.Advice = "Geen (een bluf kan)"
		e.Why = fmt.Sprintf("Je hand is geen vuile was en bijna kansloos (%s op de laatste slag). Sterk bluft dan zo'n %s van de keren, maar wordt het gecontroleerd, dan krijg je een strafpunt.",
			pct(q), pct(0.12*(0.5+p.aggr)))
	default:
		e.Advice = "Geen"
		e.Why = fmt.Sprintf("Je hand is geen vuile was, en met %s kans op de laatste slag te goed om weg te bluffen.", pct(q))
	}
	return e
}

// ---- a check ----

func (p *Player) explainCheck(v *toepen.View) Explanation {
	e := Explanation{Decision: "controle", Chance: -1}
	g := wasChance(unseen(v))
	bluff := claimBluffRate(v, v.Claimant)
	pb := bluff * (1 - g) / (bluff*(1-g) + g)
	bar := 0.5
	if cost(v.Points[v.Seat], 1, v.Rules.Limit) > 1 {
		bar = 0.85
	}
	check := pb > bar
	e.Options = []Option{{Label: "Controleren", Value: pb, Best: check}, {Label: "Laten gaan", Value: 1 - pb, Best: !check}}
	e.Advice = map[bool]string{true: "Controleer", false: "Laat gaan"}[check]
	seen := "De bots gaan uit van zo'n " + pct(bluff) + " bluf"
	if r := v.Record[v.Claimant]; r.Claims > 0 {
		seen = fmt.Sprintf("Van de %d gecontroleerde vuile wassen van deze speler waren er %d bluf: reken op zo'n %s", r.Claims, r.ClaimBluffs, pct(bluff))
	}
	e.Why = fmt.Sprintf("Van de kaarten die jij niet ziet, vormt %s van de handen van vier een vuile was. %s. Samen is de kans dat dit bluf is %s; controleer boven %s",
		pct(g), seen, pct(pb), pct(bar))
	if bar > 0.5 {
		e.Why += ", want een verkeerde controle zet je eruit."
	} else {
		e.Why += "."
	}
	e.Rule = "Heb je zelf veel plaatjes en zevens, dan is een echte vuile was onwaarschijnlijk: controleer. Wees voorzichtig als een fout je eruit zet."
	return e
}

// ---- laying away ----

func (p *Player) explainDiscard(v *toepen.View) Explanation {
	e := Explanation{Decision: "wegleggen", Worlds: 48}
	lays, wins := p.discardScores(v, v.Lay, e.Worlds)
	order := make([]int, len(lays))
	for k := range order {
		order[k] = k
	}
	slices.SortStableFunc(order, func(a, b int) int { return wins[b] - wins[a] })
	for k, i := range order[:min(5, len(order))] {
		e.Options = append(e.Options, Option{Cards: lays[i], Value: float64(wins[i]) / float64(e.Worlds), Best: k == 0})
	}
	best := lays[order[0]]
	e.Chance = float64(wins[order[0]]) / float64(e.Worlds)
	e.Advice = "Leg weg: " + cardsNL(best)
	e.Why = fmt.Sprintf("Elke keuze van %d kaarten is uitgespeeld in dezelfde %d verdelingen van de kaarten die je niet ziet. Met de overige %d haal je zo in %s de laatste slag.",
		v.Lay, e.Worlds, len(v.Hand)-v.Lay, pct(e.Chance))
	weak := weakestN(v.Hand, v.Lay)
	e.Rule = "Leg je zwakste kaarten weg: " + cardsNL(weak) + "."
	return e
}
