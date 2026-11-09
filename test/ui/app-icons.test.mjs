// Home-screen icons and the link preview of every site (the web/ of each
// game's folder):
//   node --test test/ui/app-icons.test.mjs
//
// iOS takes only a raster apple-touch-icon and fills transparent pixels
// black; Android launchers want PNG icons and a maskable one whose artwork
// stays inside the central 80% circle. The PNGs are rendered from the
// site's favicon.svg and icon-full.svg (see icon-full.svg). Chat apps show
// og:image for a shared link: the site's og.png, made by
// test/ui/og-image.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { GAMES, facts, siteDir } from './site.mjs';

// Decodes an 8-bit, non-interlaced RGB or RGBA PNG.
function readPNG(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is no PNG`);
  let w = 0, h = 0, ctype = -1;
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      assert.equal(data[8], 8, `${file}: bit depth`);
      ctype = data[9];
      assert.equal(data[12], 0, `${file}: interlaced`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ctype];
  assert.ok(bpp, `${file}: colour type ${ctype}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytes = buf.length;
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const at = (x, y) => {
    const i = y * stride + x * bpp;
    return { r: px[i], g: px[i + 1], b: px[i + 2], a: bpp === 4 ? px[i + 3] : 255 };
  };
  return { w, h, at, bytes };
}

function opaque(img) {
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.at(x, y).a !== 255) return false;
  return true;
}

for (const game of GAMES) {
// The felt's dominant colour channel, which the corners of the maskable icon
// show: felt in the game's test/facts.mjs.
const { felt } = await facts(game);
const web = p => path.join(siteDir(game), p.replace(/^\//, ''));
const manifest = JSON.parse(fs.readFileSync(web('manifest.webmanifest'), 'utf8'));
const html = fs.readFileSync(web('index.html'), 'utf8');

test(`${game}: the apple-touch-icon is an opaque 180×180 PNG`, () => {
  const link = /<link rel="apple-touch-icon" href="([^"]+)" sizes="180x180">/.exec(html);
  assert.ok(link, 'index.html links an apple-touch-icon with sizes 180x180');
  // iOS also asks for /apple-touch-icon.png by itself: the same file.
  assert.equal(link[1], '/apple-touch-icon.png');
  const img = readPNG(web(link[1]));
  assert.deepEqual([img.w, img.h], [180, 180]);
  assert.ok(opaque(img), 'no transparent pixels (iOS fills them black)');
});

test(`${game}: the manifest has the SVG plus PNG icons of 192 and 512, and a maskable one`, () => {
  const icons = manifest.icons;
  assert.ok(icons.some(i => i.src === '/favicon.svg' && i.type === 'image/svg+xml'));
  for (const i of icons.filter(x => x.type === 'image/png')) {
    const img = readPNG(web(i.src));
    assert.equal(`${img.w}x${img.h}`, i.sizes, `${i.src} has the size the manifest says`);
  }
  const png = (size, purpose) => icons.find(i => i.type === 'image/png' && i.sizes === size && (i.purpose || 'any') === purpose);
  assert.ok(png('192x192', 'any'), 'a 192 px PNG');
  assert.ok(png('512x512', 'any'), 'a 512 px PNG');
  assert.ok(png('512x512', 'maskable'), 'a 512 px maskable PNG');
});

test(`${game}: the maskable icon is full bleed with its artwork inside the safe circle`, () => {
  const img = readPNG(web(manifest.icons.find(i => i.purpose === 'maskable').src));
  assert.ok(opaque(img), 'no transparent pixels');
  // The felt is green or blue; the artwork (klaverjas: the gold clover and
  // the red heart; toepen: the white card and its red 10) is not: more red
  // than green.
  const c = img.w / 2;
  const safe = 0.4 * img.w;
  let art = 0;
  const outside = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const p = img.at(x, y);
      if (p.r <= p.g) continue;
      art++;
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (d > safe + 1 && outside.length < 5) outside.push(`${x},${y} at ${d.toFixed(1)} px`);
    }
  }
  assert.ok(art > img.w * img.h * 0.1, 'the artwork is there');
  assert.deepEqual(outside, [], `artwork outside the ${safe} px safe circle`);
  // Felt reaches every corner: no frame, no rounded corners.
  assert.ok(['r', 'g', 'b'].includes(felt), `${game}'s test/facts.mjs: felt 'r', 'g' or 'b', not ${felt}`);
  for (const [x, y] of [[0, 0], [img.w - 1, 0], [0, img.h - 1], [img.w - 1, img.h - 1]]) {
    const p = img.at(x, y);
    assert.ok(Object.keys(p).every(o => o === 'a' || o === felt || p[felt] > p[o]), `corner ${x},${y} is felt (${felt}): ${JSON.stringify(p)}`);
  }
});

test(`${game}: the link preview: og tags in index.html and an opaque 1200×630 og.png under 300 KB`, () => {
  const meta = {};
  for (const [, k, v] of html.matchAll(/<meta property="(og:[a-z:_]+)" content="([^"]*)">/g)) meta[k] = v;
  // Absolute, as scrapers want it: the image build fills in the host name.
  assert.equal(meta['og:image'], 'https://@SITE@/og.png');
  for (const k of ['og:type', 'og:site_name', 'og:locale', 'og:title', 'og:description', 'og:image:alt']) {
    assert.ok(meta[k], `${k} is set`);
  }
  // The same file serves / and every /ABCD: a fixed og:url would make every
  // invite look like the home page.
  assert.equal(meta['og:url'], undefined, 'no og:url');
  const img = readPNG(web('/og.png'));
  assert.deepEqual([img.w, img.h], [1200, 630]);
  assert.equal(`${img.w}x${img.h}`, `${meta['og:image:width']}x${meta['og:image:height']}`, 'og:image:width/height');
  assert.ok(opaque(img), 'no transparent pixels');
  // WhatsApp leaves out larger images.
  assert.ok(img.bytes < 300 * 1024, `og.png is ${img.bytes} bytes`);
});
}
