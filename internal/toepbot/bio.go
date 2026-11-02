package toepbot

// bios are what the personas (package persona) say about themselves at a
// table of toepen: one Dutch line each, about toepen only.
var bios = map[string]string{
	"dirk":   "Toept al zestig jaar aan de stamtafel; voorzichtig, degelijk en altijd een spreekwoord paraat.",
	"truus":  "Kletst honderduit, gaat graag mee en ziet altijd de zonnige kant.",
	"sjaak":  "Gokker in hart en nieren: toept op niks en bluft een was zonder blikken of blozen.",
	"fatima": "Wiskundestudent die elke kaart telt en pas toept als de kansen goed staan.",
	"kees":   "Mopperkont met een hart van goud; eerlijk, maar wee je gebeente als hij moet passen.",
	"jannie": "Geduldige juf die graag uitlegt waarom je de beste kaart voor de laatste slag bewaart.",
	"bram":   "Jong en snel, toept op gevoel en praat het liefst in emoji.",
	"vera":   "Staat om vijf uur op voor het brood en controleert elke was, maar altijd vriendelijk.",
}

// Bio is the toepen bio of a persona, "" for an unknown one.
func Bio(personaID string) string { return bios[personaID] }
