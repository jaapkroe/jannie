// Klaverjas's own helpers, without the DOM. Node tests import it
// (test/ui/klaverjas.test.mjs).

// ---------- the manual ----------

// The manual's sections, as manual.js's SECTIONS: manual.js loads when the
// manual is first opened, and a lesson step names its section before that.
// test/ui/klaverjas.test.mjs keeps the two the same.
export const MANUAL_SECTIONS = [
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
