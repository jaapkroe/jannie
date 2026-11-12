// Renders every game sound through an OfflineAudioContext in real Chromium and
// checks it is audible, ends in time, never clips and is not shrill. Also
// plays every sound through the live path (unlock + play) in the browser.
//
//   node --test test/ui/sound-render.mjs      (starts scripts/chrome 9331 if needed)
//   SOUND_REPORT=1 node test/ui/sound-render.mjs   prints a level table
//   SOUND_WAV=DIR node test/ui/sound-render.mjs     also writes DIR/<name>.wav to listen to

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ownBrowser } from './app-lib.mjs';
import { serveSite } from './site.mjs';

const CDP_PORT = Number(process.env.CHROME_PORT || 9331);

// Upper bound on how long each sound may ring (seconds).
const MAX_LENGTH = {
  card: 0.15, knock: 0.3, deal: 0.1, shuffle: 0.85, trick: 0.4, trickWon: 0.75, roem: 0.9,
  trump: 1.4, turn: 0.6, chat: 0.2, nat: 1.4, pit: 1.4, handWon: 1.2,
  handLost: 1.1, win: 1.6, lose: 1.15, click: 0.06, error: 0.35, join: 0.6,
};
const NAMES = Object.keys(MAX_LENGTH);

// The production policy (deploy/nginx.conf), so the module is checked under it.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

let server, chrome, page;
const pageProblems = [];

before(async () => {
  // Klaverjas's site, with an empty test page under the policy.
  server = await serveSite('klaverjas', 0, { '/': '<!doctype html><meta charset="utf-8"><title>sound</title>' }, { 'content-security-policy': CSP });
  chrome = await ownBrowser(CDP_PORT);
  page = await chrome.browser.newPage();
  page.on('pageerror', (e) => pageProblems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') pageProblems.push(m.text()); });
  await page.goto(`${server.url}/`);
  await page.evaluate(async () => {
    window.sound = (await import('/js/sound.js')).sound;
  });
});

after(async () => {
  await page?.close().catch(() => {});
  server?.close();
  await chrome?.stop();
});

// Renders `names` (all at once, or `spacing` s apart) and measures the mix.
// Sounds start after half a second of silence: a fresh DynamicsCompressorNode
// in Chromium starts out with heavy gain reduction and needs ~0.3 s to settle,
// while in the game the chain has long been running.
function render(names, { volume = 1, spacing = 0, seconds, wav = false } = {}) {
  return page.evaluate(async (names, volume, spacing, seconds, wav) => {
    const rate = 48000, warm = 0.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(rate * (warm + seconds)), rate);
    let length = 0;
    names.forEach((n, i) => {
      length = Math.max(length, i * spacing + window.sound._renderTo(ctx, n, { volume, at: warm + i * spacing }));
    });
    const buf = await ctx.startRendering();
    const skip = Math.round(rate * warm);
    const l = buf.getChannelData(0).subarray(skip), r = buf.getChannelData(1).subarray(skip);
    const mono = new Float32Array(l.length);
    let peak = 0, peakAt = 0, last = 0, finite = true;
    for (let i = 0; i < l.length; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
      const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (a > peak) { peak = a; peakAt = i / rate; }
      if (a > 1e-3) last = i;
      mono[i] = (l[i] + r[i]) / 2;
    }
    // Loudest 50 ms window (RMS, dBFS).
    const win = rate / 20;
    let maxRms = 0;
    for (let s = 0; s + win <= mono.length; s += win / 2) {
      let sum = 0;
      for (let i = s; i < s + win; i++) sum += mono[i] * mono[i];
      maxRms = Math.max(maxRms, Math.sqrt(sum / win));
    }
    // Share of energy above 5 kHz and spectral centroid (Hann frames of 1024).
    const N = 1024, re = new Float64Array(N), im = new Float64Array(N);
    const power = new Float64Array(N / 2);
    const aWeight = new Float64Array(N / 2), phoneWeight = new Float64Array(N / 2);
    let windowEnergy = 0;
    for (let i = 0; i < N; i++) windowEnergy += (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))) ** 2;
    for (let k = 1; k < N / 2; k++) {
      const f2 = ((k * rate) / N) ** 2;
      const ra = (12194 ** 2 * f2 * f2) /
        ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
      aWeight[k] = (ra * 1.2589) ** 2;   // +2 dB: unity at 1 kHz
      phoneWeight[k] = aWeight[k] / (1 + (350 ** 2 / f2) ** 2);   // small phone speaker roll-off
    }
    let loudA = 0, phoneA = 0;
    for (let s = 0; s + N <= mono.length; s += N / 2) {
      for (let i = 0; i < N; i++) {
        re[i] = mono[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
        im[i] = 0;
      }
      for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= N; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        for (let i = 0; i < N; i += len) {
          for (let k = 0; k < len / 2; k++) {
            const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
            const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
            const xr = ar * wr - ai * wi, xi = ar * wi + ai * wr;
            re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi;
            re[i + k] += xr; im[i + k] += xi;
          }
        }
      }
      let frameA = 0, framePhone = 0;
      for (let k = 0; k < N / 2; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        power[k] += p;
        frameA += aWeight[k] * p;
        framePhone += phoneWeight[k] * p;
      }
      loudA = Math.max(loudA, (2 * frameA) / N / windowEnergy);
      phoneA = Math.max(phoneA, (2 * framePhone) / N / windowEnergy);
    }
    let total = 0, high = 0, weighted = 0;
    for (let k = 0; k < N / 2; k++) {
      const f = (k * rate) / N;
      total += power[k];
      weighted += f * power[k];
      if (f > 5000) high += power[k];
    }
    // Optional 16-bit stereo PCM, base64, for listening.
    let pcm = null;
    if (wav) {
      const ints = new Int16Array(l.length * 2);
      for (let i = 0; i < l.length; i++) {
        ints[2 * i] = Math.round(Math.max(-1, Math.min(1, l[i])) * 32767);
        ints[2 * i + 1] = Math.round(Math.max(-1, Math.min(1, r[i])) * 32767);
      }
      const bytes = new Uint8Array(ints.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      pcm = btoa(bin);
    }
    return {
      pcm, rate,
      length, peak, peakAt, finite, end: last / rate,
      rmsDb: 20 * Math.log10(maxRms || 1e-9),
      loudA: 10 * Math.log10(loudA || 1e-12),
      phoneA: 10 * Math.log10(phoneA || 1e-12),
      high: total ? high / total : 0,
      centroid: total ? weighted / total : 0,
    };
  }, names, volume, spacing, seconds, wav);
}

async function writeWav(dir, name, { pcm, rate }) {
  const data = Buffer.from(pcm, 'base64');
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);            // PCM
  head.writeUInt16LE(2, 22);            // stereo
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.wav`), Buffer.concat([head, data]));
}

test('the module offers exactly the contract sounds', async () => {
  const names = await page.evaluate(() => [...window.sound._names]);
  assert.deepEqual([...names].sort(), [...NAMES].sort());
});

const report = [];

for (const name of NAMES) {
  test(`${name}: audible, short, unclipped, mellow`, async () => {
    const loud = await render([name], { volume: 1, seconds: MAX_LENGTH[name] + 0.5 });
    const soft = await render([name], { volume: 0.6, seconds: MAX_LENGTH[name] + 0.5, wav: Boolean(process.env.SOUND_WAV) });
    if (process.env.SOUND_WAV) await writeWav(process.env.SOUND_WAV, name, soft);
    report.push({ name, ...loud, softPeak: soft.peak });
    assert.ok(loud.finite, 'samples are finite');
    assert.ok(loud.length > 0 && loud.length <= MAX_LENGTH[name], `scheduled length ${loud.length.toFixed(3)} s`);
    assert.ok(soft.peak > 0.02, `audible at default volume (peak ${soft.peak.toFixed(3)})`);
    assert.ok(loud.peak < 0.8, `peak ${loud.peak.toFixed(3)} at full volume (limiter stays linear)`);
    assert.ok(loud.end <= Math.min(MAX_LENGTH[name], loud.length + 0.03), `rings until ${loud.end.toFixed(3)} s`);
    assert.ok(loud.high < 0.2, `not shrill (${(loud.high * 100).toFixed(1)} % above 5 kHz)`);
  });
}

test('everything at once at full volume stays below 0.95', async () => {
  const all = await render(NAMES, { volume: 1, seconds: 2.2 });
  assert.ok(all.finite);
  assert.ok(all.peak < 0.95, `peak ${all.peak.toFixed(3)}`);
});

test('a quick deal run (32 flicks, 45 ms apart) stays clean', async () => {
  const run = await render(Array(32).fill('deal'), { volume: 1, spacing: 0.045, seconds: 2 });
  assert.ok(run.peak > 0.02 && run.peak < 0.95, `peak ${run.peak.toFixed(3)}`);
  assert.ok(run.end <= 31 * 0.045 + MAX_LENGTH.deal);
});

test('live playback: unlock, play everything, throttle and voice cap', async () => {
  const out = await page.evaluate(async (names) => {
    const s = window.sound;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const count = () => s._voiceCount();
    await s.unlock();
    await s.unlock();
    s.setMuted(false);
    s.setVolume(0.6);
    for (const n of names) s.play(n);
    const burst = count();
    await wait(2200);
    const idle = count();
    s.play('nope');
    s.play(undefined);
    s.play('constructor');
    const unknown = count();
    s.play('trump');
    s.play('trump');
    const throttled = count();
    await wait(60);
    s.play('trump');
    const again = count();
    s.play('deal');
    await wait(20);
    s.play('deal');
    const deals = count() - again;
    s.setMuted(true);
    s.play('roem');
    const muted = count() - again - deals;
    s.setMuted(false);
    return { burst, idle, unknown, throttled, again, deals, muted };
  }, NAMES);
  assert.ok(out.burst >= 1 && out.burst <= 10, `voices after a burst of all sounds: ${out.burst}`);
  assert.equal(out.idle, 0, 'voices are released when they end');
  assert.equal(out.unknown, 0, 'unknown names are ignored');
  assert.equal(out.throttled, 1, 'the same sound twice within 40 ms plays once');
  assert.equal(out.again, 2, 'it plays again after 40 ms');
  assert.equal(out.deals, 2, 'deal flicks may follow each other quickly');
  assert.equal(out.muted, 0, 'muted: nothing plays');
});

after(() => {
  if (!process.env.SOUND_REPORT) return;
  console.log('\nname        len   end   peak    at  softPk  rmsDb  dB(A)  phone  >5k%  centroid');
  for (const r of report) {
    console.log(
      r.name.padEnd(10),
      r.length.toFixed(2).padStart(5), r.end.toFixed(2).padStart(5),
      r.peak.toFixed(3).padStart(6), r.peakAt.toFixed(2).padStart(5), r.softPeak.toFixed(3).padStart(6),
      r.rmsDb.toFixed(1).padStart(6), r.loudA.toFixed(1).padStart(6), r.phoneA.toFixed(1).padStart(6), (r.high * 100).toFixed(1).padStart(5),
      Math.round(r.centroid).toString().padStart(8),
    );
  }
});

test('no page errors or console warnings', () => {
  assert.deepEqual(pageProblems, []);
});
