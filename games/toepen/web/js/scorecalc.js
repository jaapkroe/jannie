// The sums of a score sheet (score.js;
// games/toepen/README.md#score-bijhouden): the points after every round,
// who is out, who won the match, who keeps going away (the lijntoepers)
// and what a new round is worth by default. Pure: node tests read it
// (test/ui/score.test.mjs).

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8; // 32 cards, four each (games/toepen/scoresheet)
export const MAX_GAIN = 30;
export const MAX_NAME = 20;
// Going away this many rounds in a row makes you a lijntoeper.
export const LIJN = 2;

const zeros = n => Array.from({ length: n }, () => 0);
const rounds = sheet => sheet?.rounds || [];

// The points of every player before the first round and after each:
// course[i][k] is player k's points after i rounds.
export function course(sheet) {
  const n = sheet?.names?.length || 0;
  let pts = zeros(n);
  const out = [pts];
  for (const r of rounds(sheet)) {
    pts = pts.map((p, k) => p + (r.gains?.[k] || 0));
    out.push(pts);
  }
  return out;
}

export const points = sheet => course(sheet).at(-1);

// Players still in after the course so far (fewer points than the limit).
export const inGame = (pts, limit) => pts.map(p => p < limit);

// The winner of the match: the one player left under the limit, once the
// others are out; -1 while two or more still play. Should a round put
// everyone out, the fewest points win.
export function matchWinner(sheet) {
  const pts = points(sheet);
  if (pts.length < MIN_PLAYERS || !rounds(sheet).length) return -1;
  const left = pts.flatMap((p, k) => (p < sheet.limit ? [k] : []));
  if (left.length === 1) return left[0];
  if (left.length) return -1;
  const least = Math.min(...pts);
  return pts.indexOf(least);
}

// streaks[i][k]: how many rounds in a row player k went away, up to and
// including round i (0 if k did not go away in round i). A round k played
// to the end breaks the streak; rounds after k was out leave it be.
export function streaks(sheet) {
  const n = sheet?.names?.length || 0;
  const before = course(sheet);
  let cur = zeros(n);
  return rounds(sheet).map((r, i) => {
    cur = cur.map((c, k) => {
      if (r.passed?.[k]) return c + 1;
      return before[i][k] < sheet.limit ? 0 : c;
    });
    return cur.map((c, k) => (r.passed?.[k] ? c : 0));
  });
}

// Each player's current run of going away: the rounds in a row up to the
// last, as long as the player kept going away.
export function runs(sheet) {
  const n = sheet?.names?.length || 0;
  const all = streaks(sheet);
  const before = course(sheet);
  const out = zeros(n);
  for (let k = 0; k < n; k++) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i][k]) { out[k] = all[i][k]; break; }
      if (before[i][k] < sheet.limit) break; // played round i to the end
    }
  }
  return out;
}

// How often each player went away, in all.
export function passes(sheet) {
  const out = zeros(sheet?.names?.length || 0);
  for (const r of rounds(sheet)) r.passed?.forEach((p, k) => { if (p) out[k]++; });
  return out;
}

// The stake a new round starts at: 2 when someone still in is on armoede
// (one point from out), else 1.
export function startStake(pts, limit) {
  return pts.some(p => p === limit - 1) ? 2 : 1;
}

// The points of a round by default: nothing for the winner and for whoever
// is out, the stake for whoever played to the end and lost, and for who
// went away what the round was worth before the last toep (at least 1).
export function defaultGain({ stake, winner, passed, out }, k) {
  if (out || k === winner) return 0;
  if (passed) return Math.max(1, stake - 1);
  return stake;
}

// A round as the host enters it is complete: a winner who is in and did
// not go away, and points within bounds.
export function validRound(r, n) {
  if (!Number.isInteger(r.winner) || r.winner < 0 || r.winner >= n) return false;
  if (r.gains?.length !== n || r.passed?.length !== n || r.passed[r.winner]) return false;
  return r.gains.every(g => Number.isInteger(g) && Math.abs(g) <= MAX_GAIN);
}

// The players in order of the standings: whoever is in before whoever is
// out, the fewest points first; the match's winner on top.
export function standings(sheet) {
  const pts = points(sheet);
  const winner = matchWinner(sheet);
  return pts.map((p, k) => ({ k, name: sheet.names[k], points: p, out: p >= sheet.limit && k !== winner }))
    .sort((a, b) => (b.k === winner) - (a.k === winner) || a.out - b.out || a.points - b.points || a.k - b.k);
}

// Cleans a name as the server does: spaces collapsed, at most 20
// characters.
export const cleanName = s => String(s || '').split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_NAME);

// Whether names will do for a sheet: 2 to 8, none empty, no two alike.
export function namesError(names) {
  const clean = names.map(cleanName);
  if (clean.length < MIN_PLAYERS) return 'Vul minstens twee namen in.';
  if (clean.length > MAX_PLAYERS) return `Hoogstens ${MAX_PLAYERS} spelers.`;
  if (clean.some(n => !n)) return 'Geef iedereen een naam.';
  const seen = new Set();
  for (const n of clean) {
    const key = n.toLowerCase();
    if (seen.has(key)) return `${n} staat er twee keer in.`;
    seen.add(key);
  }
  return '';
}

// A score code: four letters, without I and O (games/toepen/scoresheet).
export const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').replace(/[IO]/g, '').slice(0, 4);
