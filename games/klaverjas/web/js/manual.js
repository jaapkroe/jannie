// In-game manual (handleiding): Dutch content as data blocks plus a small DOM renderer.
import { createCard, SUITS, cardShort } from './cards.js';

export const SECTIONS = [
  { id: 'bediening', title: 'Bediening' },
  { id: 'regels', title: 'Spelregels' },
  { id: 'twee-drie', title: 'Met 2 of 3' },
  { id: 'punten', title: 'Kaartwaarden' },
  { id: 'roem', title: 'Roem' },
  { id: 'seinen', title: 'Seinen' },
  { id: 'tips', title: 'Tips' },
  { id: 'jannie', title: 'Juf Jannie' },
  { id: 'woorden', title: 'Woordenlijst' },
];

const RANK_NAMES = { 7: '7', 8: '8', 9: '9', T: '10', J: 'boer', Q: 'vrouw', K: 'heer', A: 'aas' };

// Card order from high to low with points (games/klaverjas/README.md#cards);
// rank codes as on the wire.
export const CARD_VALUES = {
  trump: [['J', 20], ['9', 14], ['A', 11], ['T', 10], ['K', 4], ['Q', 3], ['8', 0], ['7', 0]],
  plain: [['A', 11], ['T', 10], ['K', 4], ['Q', 3], ['J', 2], ['9', 0], ['8', 0], ['7', 0]],
};

// Roem kinds as reported by the server
// (games/klaverjas/README.md#roem-bonus-points-roem-op-tafel).
export const ROEM_VALUES = [
  { kind: 'drie', name: 'Driekaart', what: 'Drie opeenvolgende kaarten van dezelfde kleur', points: 20 },
  { kind: 'vier', name: 'Vierkaart', what: 'Vier opeenvolgende kaarten van dezelfde kleur', points: 50 },
  { kind: 'stuk', name: 'Stuk', what: 'Heer en vrouw van troef', points: 20 },
  { kind: 'vierGelijk', name: 'Vier gelijke', what: 'Vier azen, vier heren, vier vrouwen of vier tienen', points: 100 },
  { kind: 'vierBoeren', name: 'Vier boeren', what: 'Alle vier de boeren in één slag', points: 200 },
];

const ROLES = { jij: 'Jij', links: 'Links', maat: 'Maat', rechts: 'Rechts' };
const TEAM_OF = { jij: 'Wij', maat: 'Wij', links: 'Zij', rechts: 'Zij' };
const RULE_LABELS = { amsterdams: 'Amsterdams', rotterdams: 'Rotterdams', beide: 'Amsterdams en Rotterdams' };
const BOX_LABELS = { tip: 'Tip', note: 'Goed om te weten', warn: 'Let op' };

/*
 * Content. Each section is a list of blocks; the key names the block type:
 *   lead, p, h (h3), h4, ul, ol, tip, note, warn, dl, cards, compare,
 *   legal, trick, roem, score, values, roemTable, glossary.
 * Inline markup in text: **vet**, {JH} card, {H} suit symbol, [Knop] UI label.
 * A dl row may name an icon as its third item: renderManual shows it in the
 * chip when the caller passes an icon factory (the app's util.icon).
 */
export const CONTENT = {
  bediening: [
    { lead: 'Zo speel je: tik op [Snel spelen], kies een kaart en speel hem. Hieronder lees je wat alle knoppen doen.' },

    { h: 'Een spel beginnen' },
    {
      dl: [
        ['Snel spelen', 'Eén tik en je zit aan tafel met AI-spelers. Het spel begint meteen, met de spelregels die je het laatst bij Nieuw spel koos, ook het aantal spelers.', 'bolt'],
        ['Nieuw spel', 'Speel met vrienden. Kies de spelregels (zie hieronder) en tik op [Maak spel]. Je krijgt een spelcode en een link om te delen.', 'users'],
        ['Meedoen', 'Typ de spelcode van vier letters bij **Meedoen met een code**. Zodra de vierde letter staat, schuif je aan. Een link zoals **klaverjas.kroes.dev/ABCD** werkt ook: openen en je zit erin.', 'enter'],
        ['Oefenen', 'Leer het spel in losse lessen met Juf Jannie (AI) als maat, of speel vrij met een tip bij elke zet. Meer daarover onderaan.', 'school'],
        ['Handleiding', 'Deze uitleg. Aan tafel open je hem met de knop Handleiding.', 'book'],
      ],
      chips: true,
    },
    { p: 'Voor Snel spelen en Oefenen hoef je geen naam in te vullen. Speel je met anderen, dan vraagt het spel er één keer om, want zij zien hem aan tafel; je browser onthoudt hem. Bij Instellingen kun je hem altijd aanpassen.' },

    { h4: 'Spelregels bij Nieuw spel' },
    {
      dl: [
        ['Spelers', 'Met hoeveel spelers je klaverjast, jij meegerekend: **2**, **3** of **4** (standaard). Met z’n vieren speel je in koppels; met z’n drieën en tweeën gaat het anders, zie Met 2 of 3. Een plaats waar bij de start niemand zit, krijgt een AI-speler.'],
        ['Potjes', '4 tot 24 (standaard **16**, een boom).'],
        ['Troef', '**Utrechts** (standaard): voorhand moet troef kiezen. **Gedraaid**: spelen of passen op een gedraaide kleur. Met z’n drieën wordt er geboden; dan staat deze keus er niet.'],
        ['Regels', '**Amsterdams** (standaard) of **Rotterdams**: wanneer je moet troeven. De standaardvariant is dus Utrechts/Amsterdams. Met z’n tweeën heb je geen maat; dan staat deze keus er niet.'],
        ['AI-sterkte', '**Makkelijk**, **Normaal** (standaard) of **Sterk**: hoe goed de AI-spelers spelen.'],
        ['Tempo', '**Rustig**, **Normaal** (standaard) of **Snel**: hoe vlot de AI-spelers spelen en hoe lang een slag blijft liggen.'],
        ['Seinen', 'Met z’n vieren: welke seinen aan tafel gelden. Tik een afspraak aan of uit: **Met de aas seinen**, **Op- en afseinen** en **Kleintje boer** staan standaard aan, **Boer over boer** uit. De AI-spelers op Normaal en Sterk en de tips houden zich eraan, zie Seinen. Bij de start van een spel staan de afspraken in de chat.'],
        ['Seed', 'Leeg laten (standaard) geeft elke partij nieuwe kaarten. Met een getal krijg je bij dezelfde spelregels dezelfde kaarten, ook bij [Nog een partij]: zo speel je een partij nog eens. De seed van een partij staat pas aan het eind in de chat, en in de spelanalyse.'],
      ],
    },

    { h: 'Klaarzetten (de lobby)' },
    {
      ul: [
        'Bovenaan staat de **spelcode**. Met [Kopieer link] of [Delen] stuur je de uitnodiging door, bijvoorbeeld via WhatsApp.',
        'Je ziet de plaatsen rond de tafel, zoveel als bij **Spelers** staat. Met z’n vieren is wie tegenover je zit je **maat**; de kleuren laten zien wie bij Wij en wie bij Zij hoort.',
        'Tik op een vrije plaats om daar te gaan zitten.',
        'Zijn alle plaatsen bezet, dan kan er niemand meer bij: wie de link dan nog opent, hoort dat de tafel vol is, en de host krijgt een melding. Haal dan een AI-speler weg of zet Spelers hoger.',
        'De **host** (wie het spel heeft gemaakt) kan op een vrije plaats ook een AI-speler zetten: kies een karakter of laat het toeval beslissen. Tik op een AI-speler om een ander karakter te kiezen; met ✕ gaat hij weer weg.',
        'AI-spelers herken je aan **(AI)** achter de naam, zoals Opa Dirk (AI). Ieder heeft een eigen karakter en kletst op zijn eigen manier mee.',
        'Plaatsen die bij de start nog vrij zijn, krijgen vanzelf een willekeurige AI-speler. De host tikt op [Start spel] en er wordt gedeeld.',
        'Alleen de host kan de spelregels veranderen. Gaat de host weg, dan neemt een andere speler het over.',
      ],
    },

    { h: 'Aan tafel' },
    {
      ul: [
        'Jouw kaarten liggen onderaan als een waaier. Je **maat** zit tegenover je, de tegenstanders links en rechts. Met z’n drieën zitten de twee anderen links en rechts; met z’n tweeën liggen jouw stapeltjes onderaan en die van de ander bovenaan.',
        'Er wordt met de klok mee gespeeld: na jou is links aan de beurt.',
        'Wie aan de beurt is, licht op. Het fiche met de **G** staat bij de gever.',
        'De terugknop van je telefoon of browser sluit eerst wat er openstaat, zoals het scorebord of de chat. Aan tafel vraagt hij of je het spel wilt verlaten.',
      ],
    },
    { h4: 'Een kaart spelen' },
    {
      ul: [
        '**Met de muis**: klik op een kaart en hij ligt op tafel.',
        '**Op een touchscreen**: tik een kaart aan, dan schuift hij omhoog en staat boven je kaarten welke kaart klaarligt. Tik nog een keer of veeg omhoog om hem te spelen. Tik naast je kaarten, bijvoorbeeld op tafel, om hem terug te leggen. Mag je maar één kaart spelen, dan gaat hij met één tik. Liever altijd meteen? Kies bij Instellingen voor **Eén tik**.',
        '**Met het toetsenbord**: kies een kaart met ← en → en speel hem met Enter of de spatiebalk.',
        'Kaarten die je niet mag spelen, zijn **donkerder**. Tik je er toch op, dan zie je waarom niet.',
        'Boven je kaarten staat steeds wat er van je verwacht wordt, bijvoorbeeld “Bekennen: speel {D}” of “Je maat heeft de slag: vrije keuze”.',
      ],
    },
    { h4: 'Troef kiezen' },
    { p: 'Moet jij troef maken, dan verschijnen vier grote knoppen met de kleuren: tik er één aan. Bij Gedraaid kies je [Spelen] of [Passen] voor de gedraaide kleur. Past iedereen, dan moet voorhand toch kiezen; de gedraaide kleur kan dan niet meer.' },
    { h4: 'Bieden en wegleggen (met z’n drieën)' },
    { p: 'Ben je aan de beurt om te bieden, dan zet je met − en + je bod en tik je op [Bied], of je tikt op [Passen]. Speel jij alleen, dan zitten de twee kaarten van tafel in je hand, met een gouden rand. Tik twee kaarten aan die je weglegt en tik op [Wegleggen]; daarna kies je troef.' },

    { h: 'Knoppen tijdens het spel' },
    { p: 'Bovenaan zie je de stand, het potje en de troef, met daarnaast de knoppen hieronder. Die tonen alleen een pictogram. Op een smalle telefoon staan sommige onder de knop ⋯ (Meer).' },
    {
      dl: [
        ['Wij – Zij', 'De stand van de partij. Wij zijn jij en je maat, Zij de tegenstanders. Met z’n drieën of tweeën heeft ieder een eigen stand: Jij, en de anderen met hun gezicht zoals op hun plaats. Tik erop voor het scorebord.'],
        ['Potje 3/16', 'Het hoeveelste potje dit is.'],
        ['Troef', 'De troefkleur van dit potje. Tik erop om te zien wie hem koos, hoe het potje ervoor staat en welke variant jullie spelen.'],
        ['Redenering van de AI', 'Alleen bij **Oefenen**. Wat de AI op jouw plaats zou kiezen, en waarom: wat de AI-spelers op Normaal (met hun regel) en op Sterk zouden spelen, de tip, en per kaart (of troefkleur, of spelen en passen) wat die volgens de berekening oplevert. Tik op een kaart in de tabel: dan staat eronder waarom de beste kaart meer oplevert. Met ‹ › bekijk je je andere zetten van dit potje. Onderaan kun je er een opmerking bij schrijven.', 'bot'],
        ['Laatste slag', 'Bekijk de vorige slag nog eens: wie wat speelde, wie hem won en hoeveel punten en roem erin zaten.', 'history'],
        ['Scorebord', 'Alle potjes op een rij: troef, wie er speelde, punten en roem per koppel, **nat** en **pit** duidelijk gemarkeerd, en de stand. Tik op het laatste potje om de slagen terug te zien, en op een slag om te zien wie wat speelde.', 'score'],
        ['Chat', 'Kletsen met de tafel. Met de snelle reacties (👍 😂 😱 😭 Mooi! Nat! Goed gespeeld!) ben je in één tik klaar. Schrijft een andere speler iets, dan staat er een bolletje met het aantal nieuwe berichten op de knop. De AI-spelers praten ook terug.', 'chat'],
        ['Handleiding', 'Deze uitleg, ook midden in een potje.', 'help'],
        ['Instellingen', 'Geluidseffecten en volume, **Bellen voorstellen** en **Automatisch meebellen**, vierkleurenspel (klaveren groen, ruiten blauw), **Eén tik** of **Twee tikken** om een kaart te spelen, minder animaties en je naam.', 'settings'],
        ['Geluid', 'Zet het geluid in één tik aan of uit.', 'soundOn'],
        ['Meer', 'Alleen op een smalle telefoon. Achter deze knop zitten het scorebord, de handleiding, de instellingen, het geluid, **Bellen** of **Ophangen** en **Spel verlaten**. De knop voor de laatste slag staat dan naast je kaarten.', 'menu'],
      ],
      chips: true,
    },
    { tip: 'Zie je ergens een ⓘ? Tik erop voor een korte uitleg.' },

    { h: 'Bellen' },
    { p: 'Speel je met anderen, dan vraagt het spel bij de start of je meebelt: met je microfoon, en met je camera als je wilt. Je browser vraagt daarna om toestemming. Bel je niet meteen mee, dan kan het later met de knop Bellen. In het gesprek hoor en zie je wie de microfoon of camera aanheeft, ook als die van jou uitstaan.' },
    { p: 'De eerste keer dat je meebelt, kun je ook **Automatisch meebellen** aanzetten. Dan zit je voortaan bij een spel met anderen meteen in het gesprek, al bij Klaarzetten, met je microfoon en camera zoals de vorige keer.' },
    {
      dl: [
        ['Bellen', 'Meebellen met wie er aan tafel zit. De knop staat rechts boven je kaarten (op een smalle telefoon boven de knop voor de laatste slag) zodra er iemand anders aan tafel zit, en bij Klaarzetten onder de tafel.', 'phone'],
        ['Microfoon', 'Zet je microfoon aan of uit.', 'mic'],
        ['Camera', 'Zet je camera aan of uit. Staat hij aan, dan zien de anderen jou op je plaats aan tafel, in plaats van je letter, en zie je jezelf daar ook.', 'cam'],
        ['Ophangen', 'Uit het gesprek. Aan deze tafel kom je er daarna alleen met Bellen weer in, tot je de pagina opnieuw laadt of opnieuw aan tafel gaat. Op een smalle telefoon staat deze knop onder ⋯ (Meer).', 'hangup'],
      ],
      chips: true,
    },
    {
      ul: [
        'Staat bij iemand in het gesprek de microfoon uit, dan staat er een doorgestreept microfoontje in de cirkel op die plaats aan tafel.',
        'Of je microfoon en camera aanstonden, wordt onthouden voor het volgende spel. Krijgt het spel geen toegang tot je microfoon of camera, dan staat die de volgende keer uit. Wil je het niet meer gevraagd krijgen, zet dan **Bellen voorstellen** uit bij Instellingen. Daar zet je ook **Automatisch meebellen** aan of uit.',
      ],
    },
    { note: 'Beeld en geluid gaan rechtstreeks van toestel naar toestel, niet via de server van het spel. De spelers in het gesprek krijgen daarbij elkaars IP-adres te zien; met Automatisch meebellen aan zit je meteen in het gesprek. Sommige netwerken laten geen rechtstreekse verbinding toe, vooral mobiel internet: dan staat er een waarschuwingsteken bij die speler en horen jullie elkaar niet.' },

    { h: 'Na elk potje' },
    { p: 'Na de laatste slag zie je de uitslag: **gehaald**, **nat** of **pit**, met de punten, de roem, de stand en alle slagen. Tik op een slag om te zien wie wat speelde. Met z’n vieren staat onder die slag de knop [Dit potje terugkijken]: je ziet het potje dan kaart voor kaart, met alle kaarten open, en bij elke keuze van jou wat Juf Jannie ervan vindt. Rekent ze nog, dan komt het er vanzelf bij. Dat terugkijken kan ook nog tijdens het volgende potje: tik op het scorebord op het laatste potje en dan op een slag. Speel je met anderen, dan begint het volgende potje na een korte aftelling vanzelf, of eerder als iedereen op [Volgend potje] heeft getikt. Speel je alleen met AI-spelers, dan wacht het spel tot je op [Volgend potje] tikt, zodat je de slagen rustig kunt nalopen.' },
    { p: 'Na het laatste potje wint het koppel met de meeste punten, of met z’n drieën of tweeën de speler met de meeste punten. De host kan met [Nog een partij] meteen opnieuw beginnen, met dezelfde spelers en spelregels.' },
    { p: 'Onder de eindstand staat **Jouw spel volgens Juf Jannie**: een percentage voor je eigen keuzes. Juf Jannie is de game-engine die ook de AI-spelers en de tips aanstuurt; ze rekent met alleen wat jij op dat moment wist. Tik erop voor hoe je kaarten waren, je bedenktijd, je sterkste zetten en waar punten bleven liggen. Tik op zo’n zet om het potje kaart voor kaart terug te kijken, met alle kaarten open en bij elke keuze van jou wat Juf Jannie ervan vindt. Alleen jij ziet je eigen analyse. De analyse is er alleen bij een spel met z’n vieren.' },
    { p: 'Onder de spelanalyse kun je een **opmerking** achterlaten. De **seed** van de partij staat aan het eind in de chat (“De seed van dit spel was 482913.”) en bovenaan de analyse: vul die bij Nieuw spel in om dezelfde kaarten nog eens te spelen.' },
    { p: 'De server bewaart van elke partij de kaarten, de zetten, de spelanalyse, je opmerkingen, de versie van het spel, en de naam, het IP-adres en het apparaat van de spelers. Die gegevens gebruiken we voor statistieken en om het spel te verbeteren. Ze worden na hooguit 12 maanden verwijderd.' },
    { p: 'Wil je eerst iets veranderen, of is er nog iemand bijgekomen? Met [Spelers of regels wijzigen] gaat de tafel terug naar Klaarzetten, met dezelfde spelcode. De AI-spelers die bij de start de lege plaatsen opvulden, staan dan weer op, zodat vrienden kunnen aanschuiven (zet zo nodig **Spelers** hoger), en de host kan de spelregels aanpassen.' },

    { h: 'Oefenen' },
    { p: 'Tik op [Oefenen], kies een les en tik op [Start les]. Je speelt alleen met AI-spelers: **Juf Jannie (AI)** is je maat en niemand anders kan aanschuiven. Een les duurt 8 potjes. Juf Jannie legt het stap voor stap uit, en het spel wacht tot je op [Verder] of ergens op tafel tikt.' },
    {
      dl: [
        ['Basisspel', 'Wie waar zit en wat je op het scherm ziet, troef, welke kaarten je mag spelen en hoe een potje telt. In het eerste potje blijft elke slag liggen tot je de uitleg hebt gelezen. Bij het derde potje legt ze de **punten** uit.'],
        ['Roem en tellen', 'Wat **roem** is en wat het oplevert. De eerste keren wijst ze het aan in een slag. In het vijfde potje tel je de **troeven**, met een teller bij de troef.'],
        ['Seinen', 'De **seinen** van de tafel. De eerste keren wijst ze ze aan: een kans om zelf te seinen (de kaart licht op) en een sein van een ander. De AI-spelers spelen in deze les minstens op Normaal. Staan alle seinen uit, dan gelden in deze les de standaardafspraken.'],
        ['Vrij spelen', 'Geen les, maar een spel dat je start met [Start oefenspel]: een tip bij elke beurt en uitleg na elke slag. Standaard zijn het 8 potjes.'],
      ],
    },
    {
      ul: [
        'In Basisspel en Roem en tellen speelt niemand met seinen.',
        'Aan het eind van een les zegt Juf Jannie wat je daarna kunt kiezen. Met [Nog een partij] doe je dezelfde les nog eens.',
        'Na elk potje wacht het spel tot je op [Volgend potje] tikt, zodat je de slagen rustig kunt nalopen.',
      ],
    },

    { h4: 'Spelopties' },
    {
      ul: [
        'Onder **Spelopties** staan **Tips**, **Open kaarten** en de spelregels, zoals bij Nieuw spel. **Potjes** staat er alleen bij Vrij spelen, **Seinen** alleen bij de les Seinen en Vrij spelen. Je browser onthoudt je keuzes.',
        'Dit menu is ingeklapt. Het staat vanzelf open als Tips uitstaat, Open kaarten aanstaat of er een seed is ingevuld.',
        'Zet je **Tips** uit, dan krijg je geen tip bij je beurt en geen uitleg na de slag. Een les gaat gewoon door. De robot bovenin blijft werken.',
        'Zet **Open kaarten** aan als je alle vier de handen wilt zien. Zo snap je beter waarom iemand iets speelt.',
        'Het tempo staat standaard op rustig, zodat je alles goed kunt volgen.',
      ],
    },

    { h4: 'Tips en uitleg' },
    {
      ul: [
        'Ben je aan de beurt, dan geeft een tipballon advies en licht de aangeraden kaart op. Moet je troef kiezen, dan staat de tip in het venster met de kleuren. Met ✕ verberg je de tip tot je volgende beurt.',
        'Wil je weten waarom, tik dan bovenin op de robot: **Redenering van de AI** laat zien wat de AI-spelers zouden spelen en wat elke kaart volgens de berekening oplevert, ook bij je eerdere zetten van dit potje.',
        'Je mag het advies ook in de wind slaan: zo leer je het meest. Speel je een andere kaart, dan vertelt Juf Jannie na de slag welke kaart zij had aangeraden en waarom. Kies je een andere troef, of speel of pas je tegen haar advies in, dan hoor je dat na de eerste slag.',
        'Na elke slag legt Juf Jannie uit wat er gebeurde: wie er won, met welke kaart en hoeveel punten en roem erin zaten. Wat ze uitlegt, kun je teruglezen in de chat.',
        'Na de laatste slag van een potje blijft die slag even liggen, zodat je de uitleg kunt lezen. Met [Verder] ga je meteen door naar de uitslag.',
      ],
    },

    { h: 'Verbinding kwijt?' },
    {
      ul: [
        'Je plaats blijft van jou. Open het spel opnieuw in dezelfde browser en je zit weer op je plek, ook midden in een potje.',
        'Op een ander apparaat of in een andere browser? Doe mee met de spelcode en precies dezelfde naam. Ben je minstens drie minuten weg geweest, dan krijg je je plaats terug.',
        'Niemand speelt zomaar voor je. Ben je weg terwijl je aan de beurt bent, dan wacht het spel op je. Na tien seconden vraagt het de anderen of een AI-speler zolang voor je mag spelen. Dat gebeurt alleen als iedereen akkoord is. Ben je terug, dan speel je zelf weer.',
        'Kies je **Spel verlaten**, dan blijft je plaats vrij voor wie met de spelcode aanschuift. Op jouw beurt vraagt het spel de anderen of een AI-speler je plaats mag innemen, ook dan alleen als iedereen akkoord is.',
        'Is iemand anders weg of vertrokken, dan krijg jij die vraag. Tik op [AI laten spelen] of [Wachten]. Je ziet wie al akkoord is, en je kunt van gedachten veranderen zolang de vraag openstaat.',
        'Speel je alleen met AI-spelers, zoals bij Snel spelen of Oefenen, dan valt er niets te vragen: het spel wacht tot je terug bent.',
        'Zit er geen enkele mens meer aan tafel, dan wacht het spel, tot een half uur lang. Is het spel nog niet begonnen of al afgelopen, dan wordt de tafel na vijf minuten zonder spelers opgeruimd.',
      ],
    },
  ],

  regels: [
    { lead: 'Klaverjassen speel je met z’n vieren, in twee koppels. Je **maat** zit tegenover je. Dit zijn de regels zoals ze in dit spel gelden; aan de cafétafel bestaan nog veel meer varianten.' },

    { h: 'Doel' },
    { p: 'Samen met je maat haal je slagen binnen; in dit spel heet jullie koppel **Wij** en het andere koppel **Zij**. Elke slag levert **kaartpunten** op en soms **roem** (bonuspunten). Het koppel dat troef maakt, moet meer dan de helft van alle punten halen; lukt dat niet, dan gaat het **nat**. Na het afgesproken aantal potjes wint het koppel met de meeste punten.' },

    { h: 'Kaarten en delen' },
    { p: 'Je speelt met 32 kaarten in vier kleuren: klaveren {C}, ruiten {D}, harten {H} en schoppen {S}. Iedereen krijgt acht kaarten, gedeeld per drie, twee en drie.' },
    { cards: ['7H', '8H', '9H', 'TH', 'JH', 'QH', 'KH', 'AH'], caption: 'De acht kaarten van één kleur: 7, 8, 9, 10, boer (B), vrouw (V), heer (H) en aas (A).' },
    { p: 'Er wordt met de klok mee gespeeld en na elk potje schuift de gever één plaats door. De speler links van de gever is **voorhand**: die komt bij de eerste slag altijd uit, ook als iemand anders troef heeft gemaakt.' },

    { h: 'Troef bepalen' },
    { p: '**Troef** is de sterkste kleur van het potje: elke troef wint van elke kaart van een andere kleur. Wie troef maakt, is met zijn maat de **spelende partij** en moet het potje halen.' },
    { h4: 'Utrechts (verplicht) – standaard' },
    { p: 'Voorhand bekijkt zijn kaarten en **moet** een troefkleur kiezen. Passen kan niet.' },
    { h4: 'Gedraaid' },
    { p: 'Er wordt een kleur opengedraaid. Te beginnen bij voorhand zegt iedereen om de beurt **spelen** of **passen**. Wie als eerste “spelen” zegt, maakt die kleur troef; zijn koppel is de spelende partij.' },
    { p: 'Past iedereen, dan **moet** voorhand toch spelen en kiest hij een van de **drie andere** kleuren. De gedraaide kleur mag dan niet meer.' },
    { tip: 'Zeg bij Gedraaid alleen “spelen” als je denkt dat je het haalt. Met een zwakke hand is passen verstandiger dan nat gaan.' },

    { h: 'Bekennen en troeven' },
    { p: 'Wie uitkomt, legt een kaart neer; daarna speelt iedereen met de klok mee één kaart bij. Vier kaarten samen vormen een **slag**. Wie de slag wint, komt uit voor de volgende.' },
    { h4: 'Bekennen' },
    { p: 'Heb je de gevraagde kleur, dan **moet** je die bijspelen: dat heet bekennen. Je hoeft dan niet hoger te gaan, behalve als er troef gevraagd is.' },
    { h4: 'Troef gevraagd' },
    { p: 'Komt iemand uit met troef, dan moet je troef bekennen **én overtroeven** als dat kan: een troef spelen die hoger is dan de hoogste troef in de slag. Kun je niet hoger, dan speel je toch een lagere troef (**ondertroeven**). Heb je geen troef, dan mag je alles bijspelen.' },
    {
      legal: {
        title: 'Voorbeeld: troef gevraagd',
        trump: 'H',
        table: [['rechts', '9H']],
        winning: 'rechts',
        hand: ['JH', 'AH', '7H', 'TS'],
        variants: [
          { rules: 'beide', allowed: ['JH'], text: 'Alleen {JH} is hoger dan de nel, dus die moet je spelen.' },
        ],
        after: 'Had je {JH} niet gehad, dan moest je {AH} of {7H} bijspelen: ondertroeven is dan verplicht. {TS} mag niet zolang je troef hebt.',
      },
    },
    { h4: 'Je kunt niet bekennen' },
    { p: 'Heb je de gevraagde kleur niet, dan moet je in principe **troeven** (introeven). Ligt er al troef in de slag, dan moet je daar overheen als je kunt. Hier verschillen de twee varianten:' },
    {
      compare: [
        {
          title: 'Amsterdams (standaard)',
          items: [
            '**Tegenstander heeft de slag**: troeven, en overtroeven als er al troef ligt. Kun je niet over, speel dan een andere kleur bij. Ondertroeven alleen als je niets anders hebt.',
            '**Je maat heeft de slag**: vrije keuze. Elke andere kleur mag, net als een troef die hoger is dan de hoogste troef in de slag. Ondertroeven alleen als je niets anders hebt.',
          ],
        },
        {
          title: 'Rotterdams',
          items: [
            '**Altijd troeven**, ook als je maat de slag al heeft.',
            'Ligt er al troef, dan **overtroeven** als je kunt, ook over je maat heen. Kun je niet over, dan toch troeven: **ondertroeven**. Een andere kleur alleen als je geen troef hebt.',
          ],
        },
      ],
    },
    { p: 'Heb je de gevraagde kleur niet en ook geen troef, dan mag je in beide varianten alles bijspelen.' },
    {
      legal: {
        title: 'Voorbeeld 1: je maat heeft de slag',
        trump: 'S',
        table: [['links', '7H'], ['maat', 'AH'], ['rechts', '8H']],
        winning: 'maat',
        hand: ['9S', '8S', 'TD', '7C'],
        note: 'Je hebt geen harten.',
        variants: [
          { rules: 'amsterdams', allowed: ['9S', '8S', 'TD', '7C'], text: 'Vrije keuze. Je speelt als laatste, dus de slag is zeker van je maat: spek de slag met {TD}.' },
          { rules: 'rotterdams', allowed: ['9S', '8S'], text: 'Je moet troeven, ook al heeft je maat de slag al.' },
        ],
      },
    },
    {
      legal: {
        title: 'Voorbeeld 2: de tegenstander heeft ingetroefd',
        trump: 'S',
        table: [['maat', 'AD'], ['rechts', 'QS']],
        winning: 'rechts',
        hand: ['8S', '7S', 'TC', 'KH'],
        note: 'Je hebt geen ruiten.',
        variants: [
          { rules: 'amsterdams', allowed: ['TC', 'KH'], text: 'Je kunt niet over {QS} heen. Speel een andere kleur bij; ondertroeven met {8S} of {7S} mag niet zolang je iets anders hebt.' },
          { rules: 'rotterdams', allowed: ['8S', '7S'], text: 'Je kunt niet over {QS} heen, maar je moet toch troeven: ondertroeven met {8S} of {7S}.' },
        ],
        after: 'Bij Amsterdams geldt: had je alleen {8S} en {7S} gehad, dan moest je wel ondertroeven.',
      },
    },
    {
      legal: {
        title: 'Voorbeeld 3: je maat heeft ingetroefd',
        trump: 'S',
        table: [['links', 'AC'], ['maat', 'TS'], ['rechts', '8C']],
        winning: 'maat',
        hand: ['JS', '7S', 'AH', '8D'],
        note: 'Je hebt geen klaveren.',
        variants: [
          { rules: 'amsterdams', allowed: ['JS', 'AH', '8D'], text: 'Spek de slag met {AH} of speel {8D}; overtroeven met {JS} mag ook. Alleen {7S} mag niet: dat is ondertroeven terwijl je iets anders hebt.' },
          { rules: 'rotterdams', allowed: ['JS'], text: 'Je moet overtroeven als het kan, dus {JS}, ook over je eigen maat heen.' },
        ],
      },
    },

    { h: 'Wie wint de slag?' },
    {
      ul: [
        'Ligt er troef in de slag, dan wint de **hoogste troef**.',
        'Zonder troef wint de **hoogste kaart van de gevraagde kleur**.',
        'Een kaart van een andere kleur wint nooit, ook een aas niet.',
      ],
    },
    {
      trick: {
        trump: 'C',
        cards: [['links', 'TD'], ['maat', 'AD'], ['rechts', 'AS'], ['jij', 'KD']],
        winner: 'maat',
        points: 36,
        text: 'Ruiten gevraagd. {AD} wint: {AS} telt niet mee, want dat is geen ruiten en geen troef.',
      },
    },
    {
      trick: {
        trump: 'C',
        cards: [['links', 'TD'], ['maat', 'AD'], ['rechts', '7C'], ['jij', 'KD']],
        winner: 'rechts',
        points: 25,
        text: 'Rechts heeft geen ruiten en troeft met {7C}. Zelfs de kleinste troef wint van {AD}.',
      },
    },

    { h: 'Punten tellen' },
    { p: 'Na het potje telt elk koppel de kaartpunten in zijn slagen (zie Kaartwaarden). De **laatste slag** is **10 punten** extra waard. Samen is dat altijd **162**. Daar komt de roem nog bij.' },

    { h: 'Halen of nat' },
    { p: 'De spelende partij moet **meer dan de helft** van alle punten halen, roem van beide koppels meegeteld. Precies de helft is niet genoeg.' },
    {
      ul: [
        'Zonder roem heb je minstens **82** van de 162 punten nodig. Bij 81 tegen 81 ga je nat.',
        'Gehaald? Dan krijgt elk koppel zijn eigen punten plus roem.',
        'Ga je **nat**, dan krijg je 0 en krijgen de tegenstanders alles: 162 plus de roem van **beide** koppels.',
      ],
    },
    {
      score: {
        title: 'Voorbeeld: gehaald',
        playing: [90, 20],
        defending: [72, 0],
        nat: false,
        score: [110, 72],
        text: '110 is meer dan 91: gehaald. Elk koppel krijgt wat het zelf heeft binnengehaald.',
      },
    },
    {
      score: {
        title: 'Voorbeeld: nat door roem',
        playing: [85, 0],
        defending: [77, 50],
        nat: true,
        score: [0, 212],
        text: '85 is niet meer dan 106: Wij gaan nat, ook al hadden we de meeste kaartpunten. Zij krijgen 162 + 50 = 212.',
      },
    },

    { h: 'Pit' },
    { p: 'Haalt een koppel **alle acht slagen**, dan is dat **pit** (ook wel doormars): 100 punten extra roem. Een pit zonder andere roem levert dus 162 + 100 = **262** punten op. Halen de tegenstanders alle slagen, dan is de spelende partij natuurlijk nat en krijgt de tegenpartij die 100 er ook bij.' },

    { h: 'De partij' },
    { p: 'Een partij bestaat uit een aantal potjes, standaard 16: **een boom**, waarin iedereen vier keer deelt. Het koppel met het hoogste totaal wint. Staat het gelijk, dan is het gelijkspel.' },
    { note: '**Verzaken** (een kaart spelen die niet mag) kan in dit spel niet: de computer laat alleen toegestane kaarten toe. Aan de cafétafel kost verzaken je meestal het hele potje.' },
  ],

  'twee-drie': [
    { lead: 'Bij **Spelers** kies je met hoeveel je klaverjast. Met z’n vieren speel je in koppels, zoals bij Spelregels. Met z’n drieën of tweeën blijven de kaartwaarden, de roem en de regels voor bekennen en troeven gelijk; dit is wat er anders is.' },

    { h: 'Met z’n drieën' },
    { p: 'Iedereen speelt voor zich en heeft een eigen stand. Iedereen krijgt **tien kaarten**; de twee die overblijven, liggen **dicht op tafel**.' },
    { h4: 'Bieden' },
    { p: 'Te beginnen bij voorhand bied je om de beurt een aantal punten, of je past. Het eerste bod is minstens **80**, elk volgend bod **10 hoger**. Wie gepast heeft, doet niet meer mee. Hebben twee spelers gepast, dan is het bieden voorbij.' },
    { p: 'Wie het hoogst bood, speelt **alleen** tegen de andere twee. Heeft niemand geboden, dan speelt de laatste die nog niet paste, voor 80.' },
    { h4: 'Wegleggen en troef kiezen' },
    { p: 'Wie alleen speelt, pakt de twee dichte kaarten, **legt er twee weg** (dat mogen ook de opgepakte zijn) en kiest dan troef. De punten van de weggelegde kaarten tellen aan het eind mee voor wie alleen speelt; roem tellen ze niet.' },
    { tip: 'Leg een kale 10 weg: dan zijn die 10 punten binnen. Of maak een bijkleur leeg, zodat je die later kunt introeven.' },
    { h4: 'Spelen' },
    { p: 'Voorhand komt uit, ook als iemand anders alleen speelt. Een slag heeft drie kaarten. De twee tegenspelers zijn dit potje elkaars **maat**: bij Amsterdams hoeven ze niet te troeven als de ander de slag al heeft.' },
    { h4: 'Tellen' },
    {
      ul: [
        'Wie alleen speelt, moet minstens het **bod** halen: kaartpunten plus roem, de weggelegde kaarten meegeteld.',
        'Gehaald? Dan krijgt die speler zijn punten plus roem. De andere twee **delen** wat zij samen haalden: ieder de helft, naar boven afgerond.',
        'Niet gehaald? Dan is het **nat**: wie alleen speelde, krijgt 0, de andere twee delen alles, 162 plus alle roem.',
        'Alle tien slagen halen is **pit**: 100 roem extra.',
      ],
    },

    { h: 'Met z’n tweeën' },
    { p: 'Jullie zitten tegenover elkaar. Iedereen krijgt **zestien kaarten**, op tafel in **acht stapeltjes van twee**: twee rijen van vier. Van de voorste rij, het dichtst bij je, liggen de bovenste kaarten open; de rest ligt dicht.' },
    { h4: 'Troef en de achterste rij' },
    { p: 'Troef bepalen gaat zoals bij **Troef** ingesteld: bij Utrechts kiest voorhand, bij Gedraaid zeg je om de beurt spelen of passen op de gedraaide kleur. Daarna gaan ook de bovenste kaarten van de achterste rijen open. Iedereen heeft er dan acht openliggen en ziet die van de ander ook.' },
    { h4: 'Roem van je open kaarten' },
    { p: 'De roem in je **acht open kaarten**, zodra troef bekend is, telt voor jou: drie of vier op een rij, vier gelijke en stuk. In een slag van twee kaarten kan alleen nog stuk vallen.' },
    { h4: 'Spelen' },
    { p: 'Je speelt alleen kaarten die openliggen, en je bekent en troeft met wat er openligt. Is een slag af, dan gaan de kaarten open die vrijkwamen. Er zijn zestien slagen; de laatste is 10 punten extra waard.' },
    { p: 'Tellen gaat als met z’n vieren: wie troef maakte, moet meer dan de helft halen, anders is het nat. Alle zestien slagen halen is pit.' },
    { note: 'Met z’n tweeën heb je geen maat, dus maakt Amsterdams of Rotterdams geen verschil.' },
  ],

  punten: [
    { lead: 'Hoeveel een kaart waard is en hoe hoog hij is, hangt ervan af of hij troef is. Let vooral op de **boer** en de **9**: in troef zijn dat de twee hoogste kaarten.' },
    { h: 'Volgorde en punten' },
    { values: true },
    { p: 'Alle vier de kleuren samen: 62 + 3 × 30 = **152** kaartpunten. Met **10** voor de laatste slag erbij is er in elk potje **162** te verdienen.' },
    { tip: 'Ezelsbruggetje voor troef: **jas, nel, aas, tien**, dan heer, vrouw, 8 en 7. Buiten troef: aas, 10, heer, vrouw, boer, 9, 8, 7. De 10 is dus altijd hoger dan de heer!' },
    { h: 'Om te onthouden' },
    {
      ul: [
        'De troefboer (de **jas**) is de hoogste kaart van het potje en 20 punten waard.',
        'De troefnegen heet de **nel**: 14 punten en de op één na hoogste kaart.',
        'Buiten troef is de boer maar 2 punten en de 9 niets waard.',
        'Azen en tienen zijn veel waard, waar ze ook vallen. Spek je maat ermee en laat ze niet zomaar aftroeven.',
        'De laatste slag levert 10 punten extra op.',
      ],
    },
  ],

  roem: [
    { lead: 'Roem zijn bonuspunten voor mooie combinaties in één slag. Ze tellen mee voor halen of nat en kunnen een potje helemaal omgooien.' },

    { h: 'Roem op tafel' },
    {
      ul: [
        'Roem telt per slag: alleen de vier kaarten die samen op tafel liggen, wie ze ook gespeeld heeft.',
        'De roem gaat naar het koppel dat de slag **wint**. Maak je met jouw kaart roem in een slag van de tegenstander, dan schenk je hun die punten.',
        'In dit spel telt de computer de roem automatisch. Je ziet hem op tafel verschijnen, bijvoorbeeld “+20 Stuk!”.',
      ],
    },
    { note: 'Aan de cafétafel moet je roem zelf **melden** (“roem!”) voordat de slag wordt weggelegd. Wie het vergeet, is hem kwijt. Hier doet de computer dat voor je.' },

    { h: 'Soorten roem' },
    { roemTable: true },
    { p: 'Voor een reeks geldt de gewone volgorde **7‑8‑9‑10‑B‑V‑H‑A**, ook in troef. Een stuk dat in een reeks zit, telt er gewoon bij op. Vier zevens, achten of negens zijn niets waard.' },

    { h: 'Voorbeelden' },
    { roem: { trump: 'S', cards: ['8D', '9D', 'TD', 'AC'], items: ['drie'], text: '{8D} {9D} {TD}: drie op een rij.' } },
    { roem: { trump: 'H', cards: ['TC', 'JC', 'QC', 'KC'], items: ['vier'], text: 'Vier op een rij in klaveren.' } },
    { roem: { trump: 'H', cards: ['QH', 'KH', '7S', 'AD'], items: ['stuk'], text: 'Heer en vrouw van troef: stuk.' } },
    { roem: { trump: 'H', cards: ['JH', 'QH', 'KH', '9C'], items: ['drie', 'stuk'], text: 'Driekaart met het stuk erin: 20 + 20.' } },
    { roem: { trump: 'C', cards: ['JC', 'QC', 'KC', 'AC'], items: ['vier', 'stuk'], text: 'Vierkaart met het stuk erin: 50 + 20.' } },
    { roem: { trump: 'S', cards: ['JS', '9S', 'AS', 'TS'], items: ['drie'], text: 'De vier hoogste troeven, maar de troefvolgorde telt niet. Op gewone volgorde is alleen 9‑10‑B een reeks.' } },
    { roem: { trump: 'D', cards: ['AS', 'AH', 'AD', 'AC'], items: ['vierGelijk'], text: 'Vier azen.' } },
    { roem: { trump: 'D', cards: ['JS', 'JH', 'JD', 'JC'], items: ['vierBoeren'], text: 'Vier boeren: de hoogste roem die er is.' } },

    { h: 'Roem en je spel' },
    {
      ul: [
        'Wint je maat de slag en ligt de troefheer al op tafel? Leg dan je troefvrouw erbij: stuk voor jullie.',
        'Geef geen roem weg: leg geen kaart bij die een reeks of stuk maakt in een slag die de tegenstander wint.',
        'Roem verschuift de grens voor nat. Elke 20 roem van de tegenstander betekent dat de spelende partij 10 punten meer moet halen; eigen roem werkt precies andersom.',
      ],
    },
  ],

  seinen: [
    { lead: 'Met **seinen** (ook wel **voorkaarten**) vertel je je maat iets over je hand, alleen met de kaart die je speelt.' },
    { note: 'Seinen is een afspraak tussen maten, geen valsspelen: de kaart zelf is het signaal en iedereen aan tafel mag de afspraken kennen. Praten over je kaarten, knipogen of zuchten bij een slag hoort er niet bij.' },
    { p: 'Welke seinen gelden, spreek je per tafel af, onder **Seinen**: bij **Nieuw spel**, in de lobby en bij **Oefenen** onder Spelopties. Standaard staan **met de aas seinen**, **op- en afseinen** en **kleintje boer** aan en **boer over boer** uit. Bij de start van een spel staan de afspraken van de tafel in de chat. In de les Seinen legt Juf Jannie ze zelf uit. De AI-spelers op Normaal en Sterk en de tips houden zich eraan. In **Oefenen** op AI-sterkte Makkelijk speelt niemand met seinen. Komt een AI-speler van de spelende partij voor het eerst uit met een kleintje, dan heeft die (bijna altijd) de troefboer. Let dus goed op wat zij uitspelen en bijspelen.' },

    { h: 'Met de aas seinen' },
    { p: 'Heeft je **maat de slag**, en kun je niet bekennen en hoef je niet te troeven, gooi dan een **aas** bij van een **bijkleur** (geen troef) die nog niet gespeeld is. Daarmee zeg je: “ik heb ook de **10** van deze kleur”. De 11 punten van het aas zijn binnen, en zonder het aas is jouw 10 de hoogste kaart van de kleur. Je maat speelt die kleur later naar je toe, en dan pak jij de slag met je 10.' },
    { cards: [['AS', 'Bijgegooid'], ['TS', 'In je hand']], caption: 'Troef {D}: je maat heeft de slag in harten en jij hebt geen harten. Je gooit {AS} bij en hebt {TS} nog.' },
    { warn: 'Heb je de 10 er niet bij, dan klopt het sein niet. Je maat speelt de kleur dan naar je toe, terwijl de tegenpartij de slag met de 10 kan pakken.' },
    { p: 'Uitkomen met een aas zegt niets. Op een slag van de tegenpartij zegt een bijgegooid aas ook niets.' },

    { h: 'Op- en afseinen' },
    { p: 'Heeft je **maat de slag**, en kun je niet bekennen en hoef je niet te troeven, dan vertelt de kaart die je bijspeelt je maat iets:' },
    {
      ul: [
        '**Opseinen**: een **laag kaartje** (7, 8 of 9: kaarten zonder punten) bijspelen zegt: “speel deze kleur, daar heb ik de hoogste van”.',
        '**Afseinen**: een **middenkaart** (10, boer, vrouw of heer) bijspelen zegt juist: “de hoogste van deze kleur heb ik niet”.',
      ],
    },
    { cards: [['7C', 'Opseinen'], ['QS', 'Afseinen']], caption: 'Troef {H}: je maat heeft de slag in ruiten en jij hebt geen ruiten. Met {7C} zeg je: “speel klaveren, daar heb ik de hoogste van”. Met {QS} zeg je: “de hoogste schoppen heb ik niet”.' },
    { p: 'Op een slag van de **tegenpartij** zegt je bijkaart niets. Gooi daar je goedkoopste kaart weg, dan geef je de tegenpartij geen punten.' },

    { h: 'Kleintje boer' },
    { p: 'Ben je de troefmaker of zijn maat, en kom je voor het eerst uit met een **klein kaartje** (7, 8 of 9) van een bijkleur terwijl de troefboer nog niet gevallen is, dan zeg je: “ik heb de troefboer”. Je maat probeert de slag te winnen en speelt daarna **troef terug**. Zo kun jij met je boer de troeven ophalen.' },
    { warn: 'Een AI-maat leest jouw kleintje ook zo: speel je er een zonder de troefboer, dan speelt je maat toch troef terug.' },
    { cards: [['7C', 'Uitkomst'], ['JH', 'In je hand']], caption: 'Troef {H}: je komt uit met {7C} en hebt {JH}.' },

    { h: 'Boer over boer' },
    { p: 'Kom je uit met de **boer van een bijkleur** terwijl je de troefboer hebt, dan zeg je hetzelfde: “speel troef terug, ik heb de boer”. Deze afspraak staat standaard uit; zet hem aan bij **Seinen** als jullie hem spelen.' },
    { cards: [['JD', 'Uitkomst'], ['JH', 'In je hand']], caption: 'Troef {H}: je komt uit met {JD} en hebt {JH}.' },

    { h: 'Tegenkleur seinen (gebruiken wij niet)' },
    { warn: 'Dit sein gebruiken wij niet. De AI-spelers en de tips doen er niets mee, en bij **Seinen** kun je het niet aanzetten.' },
    { p: 'Aan andere tafels kom je het wel tegen: met je bijkaart vraag je om de **tegenkleur**, de andere kleur met dezelfde inktkleur: harten ↔ ruiten (rood) en klaveren ↔ schoppen (zwart).' },
    { cards: [['7H', 'Speel ruiten!'], ['8C', 'Speel schoppen!']] },
    { p: 'Tegenkleur seinen en op- en afseinen spreken elkaar tegen: aan een tafel geldt hooguit één van de twee.' },

    { h: 'Spekken (ook wel smeren)' },
    { p: 'Weet je zeker dat je maat de slag wint, leg er dan punten bij: een **10** of een **aas**. Dat heet je maat **spekken**.' },
    {
      trick: {
        trump: 'S',
        cards: [['links', '7S'], ['maat', 'JS'], ['rechts', '8S'], ['jij', 'TH']],
        winner: 'maat',
        points: 30,
        text: 'Je maat speelt de troefboer: die slag is binnen. Jij hebt geen troef meer en spekt de slag met {TH}.',
      },
    },

    { h: 'Maat heeft de slag' },
    { p: 'Bij Amsterdams hoef je niet te troeven als je maat de slag al heeft. Gebruik die vrijheid: spek de slag met een 10 of aas, of gooi een kaart weg die je toch niet nodig hebt. Bij Rotterdams moet je wel troeven (zie de voorbeelden bij Spelregels).' },
  ],

  tips: [
    { lead: 'Vuistregels van de cafétafel. Ze gelden niet altijd, maar wel heel vaak.' },

    { h: 'Troef kiezen' },
    {
      ul: [
        'Kies de kleur waarin je de **boer** of de **nel** hebt, liefst allebei, met nog een of twee troeven erbij.',
        'Lengte telt: drie of vier troeven is meestal beter dan twee hoge.',
        'Een aas in een bijkleur is een mooie extra: die slag heb je zo goed als binnen.',
        'Bij Utrechts moet je kiezen, ook met een slechte hand. Neem dan de kleur waarin je de meeste slagen verwacht.',
        'Bij Gedraaid: speel op boer en nel, of op boer met twee andere troeven en een aas. Twijfel je? Passen is geen schande.',
      ],
    },

    { h: 'Tijdens het spel' },
    {
      ul: [
        '**Tel de troeven.** Er zijn er acht. Houd bij hoeveel er gevallen zijn en of de boer en de nel al weg zijn.',
        '**Trek troef als spelende partij.** Haal de troeven bij de tegenstanders weg, dan kunnen ze je azen niet meer aftroeven.',
        '**Als tegenpartij** kom je liever niet uit met troef: daarmee help je de spelende partij alleen maar.',
        '**Houd de nel gedekt.** Met de nel en een kleine troef ernaast speel je de kleine bij als de boer komt. Zo blijft je nel staan.',
        '**Pas op met je tienen.** Zolang het aas van die kleur nog niet gevallen is, kan een tegenstander je 10 met dat aas pakken.',
        '**Aas en 10? Speel eerst de 10.** Het aas heb je zelf, dus de 10 wint net zo goed. Met de 10 kan er nog roem in de slag komen (8-9-10, 9-10-boer of 10-boer-vrouw), en daarna is je aas de hoogste kaart.',
        '**Spek je maat.** Wint je maat de slag zeker, leg er dan een 10 of een aas bij.',
        '**Geef geen roem weg.** Leg geen kaart bij die een reeks of stuk maakt in een slag van de tegenstander.',
        '**De laatste slag is 10 punten.** Bewaar zo mogelijk een hoge troef voor het eind.',
        '**Let op wie niet bekent.** Wie een kleur niet heeft, kan daarin troeven.',
      ],
    },

    { h: 'Halen of nat' },
    {
      ul: [
        'Als spelende partij heb je meer dan de helft nodig, roem meegeteld. Elke 20 roem voor de tegenstander kost je 10 punten extra.',
        'Als tegenpartij is iemand nat spelen het mooiste wat er is: 162 punten plus alle roem voor jullie.',
        'Een pit levert 100 extra op. Ga er alleen voor als het echt kan: één weggegeven slag en die 100 zijn weg.',
      ],
    },

    { h: 'Beter worden' },
    {
      ul: [
        'Speel tegen de AI-spelers op **Makkelijk**, dan **Normaal** en dan **Sterk**. Elke stap leert je iets nieuws.',
        'Gebruik **Oefenen**: volg de lessen van Juf Jannie, of speel vrij met een tip bij elke zet en uitleg na elke slag.',
        'Bekijk de **laatste slag** en het **scorebord** om te zien waar het potje gewonnen of verloren werd, en na de partij **Jouw spelanalyse**.',
      ],
    },
    { tip: 'Geen haast: je hebt alle tijd om na te denken. Niemand aan tafel heeft een klok.' },
  ],

  jannie: [
    { lead: '**Juf Jannie** is de game-engine van dit spel. Ze laat de AI-spelers spelen, geeft de tips bij **Oefenen** en maakt **Jouw spelanalyse**. Hier lees je hoe ze een kaart kiest, hoe sterk ze is en hoe ze gemaakt is.' },

    { h: 'Wat ze weet' },
    { p: 'Juf Jannie kijkt nooit in de kaarten van anderen. Ze weet wat jij aan tafel ook weet: haar eigen hand, de kaarten die gespeeld zijn en wie een kleur niet kon bekennen of niet kon troeven of overtroeven. Daaruit leidt ze af welke kaarten nog bij wie kunnen zitten. Met z’n vieren leest ze op Normaal en Sterk ook de seinen. Op Sterk, en bij de tips en Jouw spelanalyse, let ze daarnaast op wie troef koos, wie speelde of paste en met welke kaart iemand uitkwam.' },

    { h: 'Hoe ze een kaart kiest' },
    { p: 'Met z’n vieren verdeelt ze op **Sterk** bij elke beurt de kaarten die ze niet kan zien op **400** manieren. Elke verdeling klopt met de gespeelde kaarten en met wie welke kleur niet kon bekennen of niet kon troeven. Verdelingen die goed passen bij de troefkeuze, bij wie speelde of paste en bij de seinen, komen vaker voor. Voor elke kaart die ze mag spelen, speelt ze al die verdelingen tot het eind van het potje uit, met de vuistregels van Normaal voor alle vier de spelers. Ze speelt de kaart die gemiddeld het meest oplevert. Elke AI-speler heeft daarbij een eigen karakter: de een gaat eerder voor pit of speelt eerder dan de ander. Voor troef kiezen en spelen of passen doet ze hetzelfde met **320** verdelingen.' },
    { p: 'Op **Normaal** rekent ze met z’n vieren niets door: ze speelt volgens vaste vuistregels, houdt bij welke kaarten gevallen zijn en geeft en leest de seinen van de tafel. Op **Makkelijk** telt ze met z’n vieren geen kaarten. Ze kiest de langste kleur als troef en speelt ongeveer 1 op de 3 keer een willekeurige kaart.' },
    { note: 'Met z’n tweeën of drieën is een potje sneller uitgespeeld. Op Sterk speelt ze dan bij elke beurt **1.200** verdelingen uit, en seinen spelen geen rol. Op Makkelijk speelt ze haar kaarten dan volgens de vuistregels van Normaal, maar ongeveer 1 op de 3 keer speelt ze een willekeurige kaart. Ook dan kiest ze de langste kleur als troef. Bij het bieden met z’n drieën speelt ze op elk niveau verdelingen uit: 24 op Makkelijk, 96 op Normaal en 320 op Sterk. Op Makkelijk biedt ze daarbij vaker en hoger dan verstandig is.' },
    { note: 'Op Sterk geeft Juf Jannie een sein alleen als het haar weinig kost. Een vals sein speelt ze alleen als dat duidelijk meer oplevert, of als ze geen andere keus heeft. Op haar seinen met de aas en op haar kleintje boer kun je bijna altijd rekenen. Een klein kaartje dat ze bijspeelt (opseinen), is minder zeker: soms moet ze dat gewoon kwijt.' },

    { h: 'Hoe sterk ze is' },
    { p: 'Juf Jannie op Sterk speelde tegen **7** klaverjasprogramma’s van anderen. Hun broncode staat openbaar op internet: sommige komen uit onderzoek, andere zijn hobbyprojecten. Elk potje werd twee keer gespeeld met dezelfde kaarten: de tweede keer kregen de teams elkaars kaarten. Zo valt het geluk met de kaarten grotendeels weg. Per programma en instelling ging het om 400 tot 1.000 van zulke dubbele potjes. Juf Jannie koos daarbij voor beide teams troef en de seinen stonden uit, zodat alleen het spelen van de kaarten verschilde.' },
    { p: 'Tegen elk van die programma’s haalde Juf Jannie per potje **6 tot 34** punten meer dan de tegenpartij. Bij de programma’s die zetten doorrekenen, bepaalden we zelf hoeveel rekentijd ze kregen. Met meer rekentijd kwamen ze dichterbij, bijvoorbeeld van 23 naar 9 punten verschil, maar Juf Jannie bleef in elke vergelijking voor. Op dezelfde manier gemeten haalt Sterk per potje **27** punten meer dan Normaal en **57** meer dan Makkelijk.' },
    { p: 'Meer rekenen helpt haar zelf nauwelijks: met 3.200 verdelingen in plaats van 400 speelde ze niet meetbaar beter. Ook de seinen maakten voor haar weinig uit: Sterk met seinen speelde tegen Sterk zonder seinen niet meetbaar beter, en tegen de andere programma’s veranderden de seinen het verschil met hooguit ongeveer 2 punten per potje.' },

    { h: 'Hoe ze gemaakt is' },
    { p: 'De code en de tests van Juf Jannie en de rest van dit spel zijn geschreven door het taalmodel **Claude Opus 5.5** van Anthropic. Een mens bepaalde wat er gebouwd werd en welke afspraken aan tafel gelden, controleerde het werk en stuurde bij.' },

    { h: 'Grenzen' },
    { p: 'Elke keuze blijft een schatting. De verdelingen worden uitgespeeld met eenvoudige vuistregels, dus Juf Jannie kan een zet verkeerd inschatten. Daarom staat bij Jouw spelanalyse ook dat het slechts de mening van Juf Jannie is.' },
  ],

  woorden: [
    { lead: 'De belangrijkste woorden aan de klaverjastafel, van A tot Z.' },
    {
      glossary: [
        ['Aas', 'De hoogste kaart buiten troef, 11 punten. In troef de derde kaart, na boer en nel.'],
        ['Achterhand', 'Wie als laatste bijspeelt in een slag. Bij de eerste slag is dat de gever.'],
        ['Amsterdams', 'Variant waarin je niet hoeft te troeven als je maat de slag al heeft.'],
        ['Bekennen', 'De gevraagde kleur bijspelen. Moet als je die kleur hebt.'],
        ['Bieden', 'Met z’n drieën: zeggen hoeveel punten je denkt te halen als je alleen speelt. Wie het hoogst biedt, speelt alleen.'],
        ['Bijkleur', 'Een kleur die geen troef is.'],
        ['Boer (jas)', 'In troef de hoogste kaart, 20 punten; de troefboer heet ook **jas**. Buiten troef maar 2 punten.'],
        ['Boom', 'Een partij van 16 potjes, waarin iedereen vier keer deelt.'],
        ['Gedraaid', 'Troef bepalen door een kleur te draaien. Iedereen zegt om de beurt spelen of passen.'],
        ['Gever', 'Wie de kaarten deelt. Schuift elk potje één plaats door.'],
        ['Halen', 'Als spelende partij meer dan de helft van alle punten binnenhalen, roem meegeteld.'],
        ['Introeven', 'Troef spelen in een slag waarin een andere kleur gevraagd is, omdat je die kleur niet hebt.'],
        ['Kaal', 'Zonder dekking: een kale tien is een 10 zonder andere kaarten van die kleur ernaast.'],
        ['Maat', 'Je partner. Zit tegenover je.'],
        ['Nat', 'De spelende partij haalt niet meer dan de helft. Die krijgt 0, de tegenpartij 162 plus alle roem.'],
        ['Nel', 'De 9 van troef: 14 punten en de op één na hoogste kaart.'],
        ['Ondertroeven', 'Een troef bijspelen die lager is dan de hoogste troef die al in de slag ligt.'],
        ['Overtroeven', 'Een troef bijspelen die hoger is dan de hoogste troef in de slag.'],
        ['Pit (doormars)', 'Alle acht slagen halen: 100 punten extra roem.'],
        ['Potje', 'Eén spel van acht slagen, van het delen tot de laatste slag.'],
        ['Roem', 'Bonuspunten voor combinaties in één slag: reeksen, stuk, vier gelijke.'],
        ['Roem melden', 'Aan tafel hardop zeggen dat er roem in de slag zit. Hier doet de computer dat.'],
        ['Rotterdams', 'Variant waarin je altijd moet troeven als je niet kunt bekennen, ook als je maat de slag heeft.'],
        ['Seinen (voorkaarten)', 'Je maat iets vertellen met de kaart die je speelt.'],
        ['Slag', 'De vier kaarten van één ronde. Wie de slag wint, komt weer uit.'],
        ['Spekken (ook wel smeren)', 'Punten (een 10 of aas) bijspelen op een slag die je maat zeker wint.'],
        ['Spelende partij', 'Het koppel dat troef heeft gemaakt en moet halen.'],
        ['Stapeltje', 'Met z’n tweeën: twee kaarten op elkaar op tafel, de bovenste open. Je hebt er acht.'],
        ['Stuk', 'Heer en vrouw van troef in dezelfde slag: 20 roem.'],
        ['Troef', 'De sterkste kleur van het potje. Elke troef wint van elke kaart van een andere kleur.'],
        ['Troeven', 'Een troef spelen. Moet als je de gevraagde kleur niet hebt, met uitzonderingen bij Amsterdams.'],
        ['Uitkomen', 'De eerste kaart van een slag spelen.'],
        ['Verplicht (Utrechts)', 'Troef bepalen waarbij voorhand altijd een troefkleur moet kiezen.'],
        ['Verzaken', 'Een kaart spelen die niet mag, zoals niet bekennen terwijl het kon. Kan in dit spel niet.'],
        ['Voorhand', 'De speler links van de gever. Komt bij de eerste slag uit en maakt bij Utrechts troef.'],
        ['Wegleggen', 'Met z’n drieën: wie alleen speelt, pakt de twee dichte kaarten van tafel en legt er twee weg. Hun punten tellen voor die speler.'],
        ['Wij en Zij', 'Jouw koppel (jij en je maat) en de tegenstanders, zoals op het scoreblok.'],
      ],
    },
  ],
};

// ---- Rendering ----

const INLINE = /\*\*(.+?)\*\*|\{([789TJQKA]?)([CDHS])\}|\[([^\]]+)\]/g;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cardName(code) {
  return `${SUITS[code[1]].name} ${RANK_NAMES[code[0]]}`;
}

function cardRef(code) {
  const span = el('span', `man-c man-s-${code[1]}`, cardShort(code));
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', cardName(code));
  return span;
}

function suitRef(suit) {
  const span = el('span', `man-suit man-s-${suit}`, SUITS[suit].symbol);
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', SUITS[suit].name);
  return span;
}

// Parses the inline markup into DOM nodes (text only, never HTML).
function rich(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const strong = el('strong');
      strong.append(rich(m[1]));
      frag.append(strong);
    } else if (m[3]) {
      frag.append(m[2] ? cardRef(m[2] + m[3]) : suitRef(m[3]));
    } else {
      frag.append(el('span', 'man-ui', m[4]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function richEl(tag, cls, text) {
  const node = el(tag, cls);
  node.append(rich(text));
  return node;
}

// Lower case without diacritics, for ids and search.
function fold(text) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function slug(text) {
  return fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// A card with an optional caption and a highlighted status line under it.
function figure(code, caption, cls, badge) {
  const fig = el('figure', cls ? `man-fig ${cls}` : 'man-fig');
  fig.append(createCard(code, { size: 'sm' }));
  if (caption || badge) {
    const cap = el('figcaption');
    if (caption) cap.append(rich(caption));
    if (badge) cap.append(el('span', 'man-fig-badge', badge));
    fig.append(cap);
  }
  return fig;
}

function trumpBadge(suit) {
  const badge = el('span', 'man-trump', 'Troef ');
  badge.append(suitRef(suit));
  return badge;
}

function exampleHead(title, trump) {
  const head = el('div', 'man-ex-head');
  if (title) head.append(el('span', 'man-ex-title', title));
  if (trump) head.append(trumpBadge(trump));
  return head;
}

function list(tag, items) {
  const node = el(tag, 'man-list');
  for (const item of items) node.append(richEl('li', '', item));
  return node;
}

function box(kind, content, title) {
  const node = el('aside', `man-box man-${kind}`);
  node.append(el('span', 'man-box-label', title || BOX_LABELS[kind]));
  for (const text of [].concat(content)) node.append(richEl('p', '', text));
  return node;
}

function table(caption, head, rows, foot) {
  const wrap = el('div', 'man-tablewrap');
  const tbl = el('table', 'man-table');
  if (caption) tbl.append(richEl('caption', 'man-vh', caption));
  const thead = el('thead');
  const hr = el('tr');
  for (const h of head) {
    const th = richEl('th', h.cls || '', h.text);
    th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  tbl.append(thead);
  const tbody = el('tbody');
  for (const row of rows) tbody.append(row);
  tbl.append(tbody);
  if (foot) {
    const tfoot = el('tfoot');
    tfoot.append(foot);
    tbl.append(tfoot);
  }
  wrap.append(tbl);
  return wrap;
}

function cell(tag, content, cls) {
  const c = el(tag, cls || '');
  if (typeof content === 'string') c.append(rich(content));
  else if (content) c.append(content);
  return c;
}

function valueCell(code, name, points) {
  const wrap = el('div', 'man-vcell');
  wrap.append(createCard(code, { size: 'sm' }), el('span', 'man-vname', name), el('span', points ? 'man-pts' : 'man-pts man-zero', String(points)));
  return wrap;
}

function renderValues() {
  const rows = CARD_VALUES.trump.map(([tr, tp], i) => {
    const [pr, pp] = CARD_VALUES.plain[i];
    const row = el('tr');
    const rank = cell('th', String(i + 1), 'man-rank');
    rank.scope = 'row';
    const trumpName = tr === '9' ? 'nel' : RANK_NAMES[tr];
    row.append(rank, cell('td', valueCell(tr + 'H', trumpName, tp)), cell('td', valueCell(pr + 'S', RANK_NAMES[pr], pp)));
    return row;
  });
  const sum = (vals) => vals.reduce((t, [, p]) => t + p, 0);
  const foot = el('tr');
  const label = cell('th', 'Totaal');
  label.scope = 'row';
  foot.append(label, cell('td', `**${sum(CARD_VALUES.trump)}**`, 'man-num'), cell('td', `**${sum(CARD_VALUES.plain)}**`, 'man-num'));
  const head = [
    { text: '#', cls: 'man-rank' },
    // No-break space: on a narrow phone the header wraps as "Geen troef / (hier ♠)".
    { text: 'Troef (hier\u00a0{H})' },
    { text: 'Geen troef (hier\u00a0{S})' },
  ];
  const wrap = table('Volgorde van hoog naar laag en punten, voor troef en voor de andere kleuren', head, rows, foot);
  wrap.classList.add('man-values');
  return wrap;
}

function renderRoemTable() {
  const rows = ROEM_VALUES.map((r) => {
    const row = el('tr');
    const name = cell('th', r.name);
    name.scope = 'row';
    row.append(name, cell('td', r.what), cell('td', String(r.points), 'man-num man-pts'));
    return row;
  });
  return table('Soorten roem en wat ze waard zijn', [{ text: 'Roem' }, { text: 'Wat' }, { text: 'Punten', cls: 'man-num' }], rows);
}

function renderLegal(ex) {
  const node = el('div', 'man-ex');
  node.append(exampleHead(ex.title, ex.trump));
  const onTable = el('div', 'man-ex-part');
  onTable.append(el('span', 'man-ex-label', 'Op tafel'));
  const row = el('div', 'man-row');
  for (const [role, code] of ex.table) {
    const lead = role === ex.winning;
    row.append(figure(code, ROLES[role], lead ? 'man-win' : '', lead ? 'heeft de slag' : ''));
  }
  onTable.append(row);
  node.append(onTable);
  if (ex.note) node.append(richEl('p', 'man-ex-note', ex.note));
  const vars = el('div', ex.variants.length > 1 ? 'man-ex-vars man-two' : 'man-ex-vars');
  for (const v of ex.variants) {
    const part = el('div', 'man-ex-part');
    const label = el('span', `man-tag man-tag-${v.rules}`, ex.variants.length === 1 && v.rules === 'beide' ? 'Jouw hand' : RULE_LABELS[v.rules]);
    part.append(label);
    const hand = el('div', 'man-row');
    for (const code of ex.hand) {
      const ok = v.allowed.includes(code);
      hand.append(figure(code, ok ? 'mag' : 'mag niet', ok ? 'man-ok' : 'man-no'));
    }
    part.append(hand, richEl('p', 'man-ex-text', v.text));
    vars.append(part);
  }
  node.append(vars);
  if (ex.after) node.append(richEl('p', 'man-ex-after', ex.after));
  return node;
}

function renderTrick(ex) {
  const node = el('div', 'man-ex');
  node.append(exampleHead('', ex.trump));
  const row = el('div', 'man-row');
  for (const [role, code] of ex.cards) {
    const win = role === ex.winner;
    row.append(figure(code, ROLES[role], win ? 'man-win' : '', win ? 'wint' : ''));
  }
  node.append(row);
  const text = richEl('p', 'man-ex-text', ex.text);
  text.append(' ');
  text.append(el('span', `man-result man-${TEAM_OF[ex.winner] === 'Wij' ? 'wij' : 'zij'}`, `${ex.points} punten voor ${TEAM_OF[ex.winner]}.`));
  node.append(text);
  return node;
}

function renderRoem(ex) {
  const node = el('div', 'man-roemex');
  const row = el('div', 'man-row');
  for (const code of ex.cards) row.append(figure(code));
  const info = el('div', 'man-roemex-info');
  const head = el('div', 'man-roemex-head');
  head.append(trumpBadge(ex.trump));
  const kinds = ex.items.map((k) => ROEM_VALUES.find((r) => r.kind === k));
  const total = kinds.reduce((t, r) => t + r.points, 0);
  head.append(el('span', 'man-roemex-total', total ? `${total} roem` : 'geen roem'));
  info.append(head);
  if (kinds.length) info.append(el('div', 'man-roemex-kinds', kinds.map((r) => `${r.name} ${r.points}`).join(' + ')));
  info.append(richEl('p', 'man-ex-text', ex.text));
  node.append(row, info);
  return node;
}

function renderScore(ex) {
  const node = el('div', 'man-ex');
  node.append(exampleHead(ex.title));
  const [pp, pr] = ex.playing;
  const [dp, dr] = ex.defending;
  const total = pp + pr + dp + dr;
  const line = (label, a, b, cls) => {
    const row = el('tr', cls || '');
    const th = cell('th', label);
    th.scope = 'row';
    row.append(th, cell('td', String(a), 'man-num'), cell('td', String(b), 'man-num'));
    return row;
  };
  const rows = [
    line('Kaartpunten', pp, dp),
    line('Roem', pr, dr),
    line('Samen', pp + pr, dp + dr, 'man-sum'),
  ];
  const foot = el('tr', ex.nat ? 'man-final man-nat' : 'man-final');
  const fth = cell('th', ex.nat ? 'Op het scorebord (nat)' : 'Op het scorebord');
  fth.scope = 'row';
  foot.append(fth, cell('td', `**${ex.score[0]}**`, 'man-num'), cell('td', `**${ex.score[1]}**`, 'man-num'));
  const head = [{ text: '' }, { text: 'Wij (spelen)', cls: 'man-num man-wij' }, { text: 'Zij', cls: 'man-num man-zij' }];
  node.append(table('', head, rows, foot));
  const half = (total / 2).toLocaleString('nl-NL');
  node.append(richEl('p', 'man-ex-text', `Alles samen: ${total}. De helft is ${half}. ${ex.text}`));
  return node;
}

function renderCards(block) {
  const node = el('div', block.cards.length > 5 ? 'man-cards man-cards-many' : 'man-cards');
  const row = el('div', 'man-row');
  for (const item of block.cards) {
    const [code, caption] = Array.isArray(item) ? item : [item, ''];
    row.append(figure(code, caption));
  }
  node.append(row);
  if (block.caption) node.append(richEl('p', 'man-cards-cap', block.caption));
  return node;
}

function renderCompare(cols) {
  const node = el('div', 'man-compare');
  for (const col of cols) {
    const c = el('section', 'man-cmp');
    c.append(el('h5', 'man-cmp-title', col.title), list('ul', col.items));
    node.append(c);
  }
  return node;
}

function renderDl(block, ctx) {
  const dl = el('dl', block.chips ? 'man-dl man-dl-chips' : 'man-dl');
  for (const [term, def, iconName] of block.dl) {
    const item = el('div', 'man-dl-item');
    const dt = el('dt');
    if (block.chips) {
      const chip = el('span', 'man-ui');
      if (iconName && ctx.icon) chip.append(ctx.icon(iconName));
      chip.append(term);
      dt.append(chip);
    } else {
      dt.append(term);
    }
    item.append(dt, richEl('dd', '', def));
    dl.append(item);
  }
  return dl;
}

function renderGlossary(terms) {
  const node = el('div', 'man-glossary');
  const label = el('label', 'man-search');
  label.append(el('span', 'man-vh', 'Zoek een woord'));
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Zoek een woord…';
  input.autocomplete = 'off';
  input.setAttribute('enterkeyhint', 'search');
  label.append(input);
  const dl = el('dl', 'man-dl man-terms');
  const entries = terms.map(([term, def]) => {
    const item = el('div', 'man-dl-item');
    item.append(el('dt', '', term), richEl('dd', '', def));
    dl.append(item);
    return { item, key: fold(`${term} ${def.replace(/\*\*/g, '')}`) };
  });
  const empty = el('p', 'man-empty', 'Geen woord gevonden.');
  empty.hidden = true;
  input.addEventListener('input', () => {
    const q = fold(input.value.trim());
    let shown = 0;
    for (const { item, key } of entries) {
      item.hidden = q !== '' && !key.includes(q);
      if (!item.hidden) shown++;
    }
    empty.hidden = shown > 0;
  });
  node.append(label, dl, empty);
  return node;
}

function heading(tag, text, ctx) {
  const h = el(tag, `man-${tag}`, text);
  if (tag === 'h3') {
    h.id = `man-${ctx.section}-${slug(text)}`;
    h.tabIndex = -1;
    ctx.headings.push(h);
  }
  return h;
}

const RENDERERS = {
  lead: (v) => richEl('p', 'man-lead', v),
  h: (v, b, ctx) => heading('h3', v, ctx),
  h4: (v, b, ctx) => heading('h4', v, ctx),
  p: (v) => richEl('p', 'man-p', v),
  ul: (v) => list('ul', v),
  ol: (v) => list('ol', v),
  tip: (v, b) => box('tip', v, b.title),
  note: (v, b) => box('note', v, b.title),
  warn: (v, b) => box('warn', v, b.title),
  dl: (v, b, ctx) => renderDl(b, ctx),
  cards: (v, b) => renderCards(b),
  compare: (v) => renderCompare(v),
  legal: (v) => renderLegal(v),
  trick: (v) => renderTrick(v),
  roem: (v) => renderRoem(v),
  score: (v) => renderScore(v),
  values: () => renderValues(),
  roemTable: () => renderRoemTable(),
  glossary: (v) => renderGlossary(v),
};

export const BLOCK_TYPES = Object.keys(RENDERERS);

function renderBlock(block, ctx) {
  for (const type of BLOCK_TYPES) {
    if (type in block) return RENDERERS[type](block[type], block, ctx);
  }
  throw new Error(`manual: unknown block ${JSON.stringify(Object.keys(block))}`);
}

// In-section quick links for long sections.
function renderToc(headings) {
  const nav = el('nav', 'man-toc');
  nav.setAttribute('aria-label', 'Op deze pagina');
  for (const h of headings) {
    const btn = el('button', 'man-toc-btn', h.textContent);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const reduce = document.body?.classList.contains('reduced')
        || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
      h.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      h.focus({ preventScroll: true });
    });
    nav.append(btn);
  }
  return nav;
}

// opts.icon(name) returns an icon element for the chips (optional).
export function renderManual(sectionId, opts = {}) {
  const section = CONTENT[sectionId] ? sectionId : SECTIONS[0].id;
  const root = el('article', 'man');
  root.lang = 'nl';
  root.dataset.section = section;
  const ctx = { section, headings: [], icon: opts.icon };
  const nodes = CONTENT[section].map((block) => renderBlock(block, ctx));
  if (ctx.headings.length >= 4) {
    const at = 'lead' in CONTENT[section][0] ? 1 : 0;
    nodes.splice(at, 0, renderToc(ctx.headings));
  }
  root.append(...nodes);
  return root;
}
