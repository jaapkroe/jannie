// Renders the site's og.png in its folder's web/, the 1200×630 preview image
// that chat apps show for a shared link (og:image in the site's index.html):
// the felt, the site's emblem (klaverjas: the gold clover; toepen: a ten of
// hearts), its name and a fan of real card faces from cards.js, as the scene
// of the game's test/facts.mjs has them. Run it again when the cards or the
// look change, and commit the PNG. Without --url it serves the site itself
// (test/ui/site.mjs): no game server needed.
//
//   scripts/chrome 9700
//   cd test/ui && node og-image.mjs --cdp http://127.0.0.1:9700 [--site <game>] [--out FILE]
//
// test/ui/app-icons.test.mjs checks the result (size, opaque, under 300 KB).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { args, connect } from './app-lib.mjs';
import { facts, siteDir, serveSite } from './site.mjs';

const a = args();
const argv = process.argv.slice(2);
const opt = name => (argv.includes('--' + name) ? argv[argv.indexOf('--' + name) + 1] : '');
const site = opt('site') || 'klaverjas';
const out = opt('out') || path.join(siteDir(site), 'og.png');

// The site's scene, from its folder's test/facts.mjs: the felt's colour stops,
// the background, the emblem, the name, the two lines and the fan.
const { scene } = await facts(site);
if (!scene) throw new Error(`og-image: no scene for site ${site} (the scene of its test/facts.mjs)`);

// The site's files, unless --url names a server.
const server = argv.includes('--url') ? null : await serveSite(site);
if (server) a.url = server.url;

const browser = await connect(a.cdp);
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
try {
  // The scene uses a <style> of its own, which the app's CSP forbids.
  await page.setBypassCSP(true);
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.goto(`${a.url}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(async cfg => {
    const { createCard } = await import('/js/cards.js');
    const css = `
      html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: ${cfg.bg}; }
      body > :not(.og) { display: none !important; }
      .og { position: fixed; inset: 0; overflow: hidden;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif; }
      .og canvas { position: absolute; inset: 0; }
      .og::after { content: ''; position: absolute; inset: 16px; border-radius: 34px;
        border: 14px solid #7a4a24; box-shadow: inset 0 0 0 2px #a8743f, inset 0 0 60px rgb(0 0 0 / .35); }
      .fan { position: absolute; left: 70px; top: 120px; width: 470px; height: 420px; --card-w: 168px; }
      .fan .card { position: absolute; left: 150px; top: 60px; transform-origin: 50% 135%;
        box-shadow: 0 0 0 .5px rgb(40 30 10 / .35), 0 3px 6px rgb(0 0 0 / .3), 0 14px 30px -6px rgb(0 0 0 / .45); }
      .txt { position: absolute; left: 600px; top: 150px; width: 540px; color: #e8f3ec; }
      .brand { display: flex; align-items: center; gap: 22px; }
      .brand svg { width: 96px; height: 96px; flex: none; filter: drop-shadow(0 4px 8px rgb(0 0 0 / .35)); }
      h1 { margin: 0; font-size: 104px; line-height: 1; font-weight: 800; letter-spacing: -1px; color: #ffe08a;
        text-shadow: 0 4px 14px rgb(0 0 0 / .4); }
      .t1 { margin: 34px 0 0; font-size: 46px; font-weight: 700; line-height: 1.15; }
      .t2 { margin: 18px 0 0; font-size: 28px; line-height: 1.35; color: ${cfg.t2color}; }
      .suits { margin-top: 30px; font-size: 40px; letter-spacing: 14px; }
      .suits .r { color: #ef6f5a; } .suits .k { color: #e8f3ec; }`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
    const scene = el('div', 'og');
    // The felt, computed per pixel: a CSS gradient is dithered, and its
    // noise would make the PNG three times as big.
    const canvas = el('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const g2d = canvas.getContext('2d');
    const img = g2d.createImageData(1200, 630);
    const { stops } = cfg;
    for (let y = 0; y < 630; y++) {
      for (let x = 0; x < 1200; x++) {
        const t = Math.min(1, Math.hypot((x - 408) / 900, (y - 328) / 504));
        let k = 1;
        while (stops[k][0] < t) k++;
        const [t0, c0] = stops[k - 1];
        const [t1, c1] = stops[k];
        const f = (t - t0) / (t1 - t0);
        const o = (y * 1200 + x) * 4;
        for (let ch = 0; ch < 3; ch++) img.data[o + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * f);
        img.data[o + 3] = 255;
      }
    }
    g2d.putImageData(img, 0, 0);
    scene.append(canvas);
    const fan = el('div', 'fan');
    const { codes } = cfg;
    codes.forEach((code, i) => {
      const c = createCard(code, { size: 'lg' });
      c.style.transform = `rotate(${(i - 2) * 11}deg)`;
      fan.append(c);
    });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.innerHTML = cfg.emblem;
    const suits = el('div', 'suits');
    for (const [s, cls] of [['♥', 'r'], ['♣', 'k'], ['♦', 'r'], ['♠', 'k']]) suits.append(el('span', cls, s));
    const txt = el('div', 'txt');
    const brand = el('div', 'brand');
    brand.append(svg, el('h1', '', cfg.title));
    txt.append(brand, el('p', 't1', cfg.t1), el('p', 't2', cfg.t2), suits);
    scene.append(fan, txt);
    document.body.append(scene);
    await document.fonts.ready;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, scene);
  const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
  const png = repack(Buffer.from(shot));
  fs.writeFileSync(out, png);
  console.log(`og-image: ${out}, ${png.length} bytes`);
} finally {
  await ctx.close();
  await browser.disconnect();
  server?.close();
}

// Chromium's PNG encoder is quick, not small. This writes the same pixels as
// an opaque RGB PNG with a filter chosen per row and zlib at level 9: about
// half the size, well under the 300 KB that WhatsApp is said to accept.
function repack(buf) {
  let w = 0, h = 0, bpp = 0;
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('screenshot: not an 8-bit, non-interlaced PNG');
      bpp = { 2: 3, 6: 4 }[data[9]];
      if (!bpp) throw new Error(`screenshot: colour type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  // Unfilter into RGB rows.
  const inStride = w * bpp;
  const stride = w * 3;
  const px = Buffer.alloc(h * inStride);
  const rgb = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (inStride + 1)];
    const line = raw.subarray(y * (inStride + 1) + 1, (y + 1) * (inStride + 1));
    for (let x = 0; x < inStride; x++) {
      const a = x >= bpp ? px[y * inStride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * inStride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * inStride + x - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      px[y * inStride + x] = (line[x] + pred) & 255;
    }
    for (let x = 0; x < w; x++) px.copy(rgb, y * stride + x * 3, y * inStride + x * bpp, y * inStride + x * bpp + 3);
  }
  // Filter each row with the type whose output has the smallest sum of
  // absolute values (the usual heuristic).
  const outRaw = Buffer.alloc(h * (stride + 1));
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    let best = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
        const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
        const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0;
        const v = (rgb[y * stride + x] - [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]) & 255;
        cand[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < best) {
        best = sum;
        outRaw[y * (stride + 1)] = f;
        cand.copy(outRaw, y * (stride + 1) + 1);
      }
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(outRaw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
