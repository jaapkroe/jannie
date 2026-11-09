// What the shared tests need to know of toepen
// (docs/adding-a-game.md#facts-for-the-shared-tests).

// The felt's dominant colour channel, which the corners of the maskable icon
// show (test/ui/app-icons.test.mjs).
export const felt = 'b';

// The link preview (test/ui/og-image.mjs): the felt's colour stops, the
// background, the emblem (a ten of hearts), the name, the two lines and the fan.
export const scene = {
  bg: '#0b1f2e', stops: [[0, [0x3a, 0x7f, 0xb0]], [0.45, [0x22, 0x59, 0x7f]], [0.75, [0x0f, 0x35, 0x52]], [1, [0x0b, 0x1f, 0x2e]]],
  emblem: '<g transform="rotate(-9 32 33)"><rect x="18.5" y="11" width="27" height="40" rx="4" fill="#fffaf0"/>'
    + '<text x="32" y="34" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="900" font-size="17" fill="#c8102e">10</text>'
    + '<path d="M32 47.5c-5.8-3.9-7.6-7.2-5.2-9.6 1.8-1.8 4.1-.9 5.2.9 1.1-1.8 3.4-2.7 5.2-.9 2.4 2.4.6 5.7-5.2 9.6z" fill="#c8102e"/></g>',
  title: 'Toepen', t1: 'Wie haalt de laatste slag?', t2: 'Met vrienden of tegen AI-spelers met karakter. Geen account nodig.',
  t2color: '#c4dbec', codes: ['JS', '7C', '8D', '9S', 'TH'],
};
