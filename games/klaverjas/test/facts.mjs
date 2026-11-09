// What the shared tests need to know of klaverjas
// (docs/adding-a-game.md#facts-for-the-shared-tests).

// The text that names klaverjas on another game's site (test/sites.test.mjs):
// "klaveren" alone is a suit.
export const mention = 'klaverj';

// The felt's dominant colour channel, which the corners of the maskable icon
// show (test/ui/app-icons.test.mjs).
export const felt = 'g';

// The link preview (test/ui/og-image.mjs): the felt's colour stops, the
// background, the emblem (the gold clover), the name, the two lines and the fan.
export const scene = {
  bg: '#0b2b21', stops: [[0, [0x2f, 0x9a, 0x62]], [0.45, [0x1b, 0x6b, 0x43]], [0.75, [0x0f, 0x4a, 0x2d]], [1, [0x0b, 0x2b, 0x21]]],
  emblem: '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/>'
    + '<stop offset="1" stop-color="#d79b28"/></linearGradient></defs><g fill="url(#g)"><circle cx="32" cy="20" r="9.5"/>'
    + '<circle cx="21" cy="35" r="9.5"/><circle cx="43" cy="35" r="9.5"/><path d="M29 34h6l3 18H26z"/></g>',
  title: 'Klaverjas', t1: 'Speel mee aan tafel', t2: 'Met vrienden of tegen AI-spelers met karakter. Geen account nodig.',
  t2color: '#bfe0cc', codes: ['TD', 'AS', 'JH', '9H', 'KC'],
};
