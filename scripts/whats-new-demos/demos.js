// What's New's demos (web/whats-new/), recorded headless from the web version of this repository:
// each frame is taken once the app has settled, with a drawn cursor, then encoded as a light
// MP4 (H.264, no sound) and its first frame as a WebP poster.
//
//   node scripts/whats-new-demos/demos.js [name,name]     all of them by default
//
// Needs Google Chrome, ffmpeg and cwebp, desktop/node_modules (npm install in desktop/), and the
// pages of chapter 104 (PAGES, ~/Downloads/104 by default). Text detection goes through the
// network; text-detection and generative-fill use Nano Banana 2.1 on fal.ai, with a key in FAL_KEY
// (a few cents).
// OUT writes the files elsewhere than web/whats-new/.
const { boot, openFile, sleep } = require('./harness');
const { Rec, frameDoc, docToScreen, center } = require('./rec');
const path = require('path');
const fs = require('fs');
const os = require('os');
const OUT = process.env.OUT || path.resolve(__dirname, '..', '..', 'web', 'whats-new');
const PAGES = process.env.PAGES || path.join(os.homedir(), 'Downloads', '104');
const W = 900, H = 592, CLIP = { x: 0, y: 30, width: 900, height: 562 };
// A smaller window for the demos whose point is small (the numbers of Show Bubble Distances):
// the same 16:10 picture, the interface larger in it
const SMALL = { w: 640, h: 430, clip: { x: 0, y: 30, width: 640, height: 400 } };
const SIZES = { 'bubble-distances': SMALL };
// The pages of some demos, beside the chapter's: a board seen from the side
const BOARD = process.env.BOARD || path.join(os.homedir(), 'Downloads', '02.psd');
// A few Clip Studio Paint files (two brush packs, a pack of bubbles), for the Library's demo
const CSP = process.env.CSP || '/tmp/csp-demo';
const HAND = '/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf';
// The panels hidden (Tab), the tools and the options bar back
const toolsOnly = (page) => page.evaluate(() => { window.TypeRWorkspace.setTools(true); document.getElementById('options').hidden = false; window.TypeRApp.setTool(window.TypeRPhotoshop.app.tool || 'move'); });
const wanted = (process.argv[2] || '').split(',').filter(Boolean);
// The page's lettering in English: the demos aren't translated
const ENGLISH = {
  'Tiens donc...': 'Well, well...',
  'Quelle\rsurprise !': 'What a\rsurprise!',
  'Il y a\rquel-\rqu’un.': 'Some-\rbody’s\rthere.',
  'Une\rhumai-\rne !': 'A\rhu-\rman!',
  'Voilà\rqui est rare.': 'Now that’s\rrare.',
  'Où étais-tu passé, petit ?': 'Where were you, little one?',
  'Pa... Pardon, Miaou !': 'S-Sorry, meow!',
  'C’est elle qui m’a suivi.': 'She’s the one who followed me.',
  'Ah...': 'Ah...',
  'Euh...': 'Um...',
  'Ils sont géants...!!': 'They’re huge...!!',
};
const toEnglish = (page) => page.evaluate((english) => {
  const PS = window.TypeRPhotoshop;
  PS.app.doc.state.layers.filter((l) => l.kind === 'text').forEach((l) => {
    const text = english[l.params.layerText.textKey];
    if (text) PS.ops.setText(l.id, text);
  });
}, ENGLISH);
// The last frames without the bars at the bottom of the page
const tidy = (page) => page.evaluate(() => document.querySelectorAll('.gentray, .ctxbar, #toast').forEach((e) => { e.style.display = 'none'; }));
const LAMA = { 'typer.web.generative': JSON.stringify({ service: 'local', models: { local: 'lama-manga' } }) };
// Generative Fill's demo: Nano Banana 2.1 on fal.ai, with the key given in FAL_KEY (never kept)
const NANO_BANANA = () => {
  if (!process.env.FAL_KEY) throw new Error('generative-fill needs a fal.ai key in FAL_KEY');
  return { 'typer.web.generative': JSON.stringify({ service: 'fal', keys: { fal: process.env.FAL_KEY }, models: { fal: 'google/nano-banana-2.1/edit' } }) };
};
const STORAGE = { 'generative-fill': NANO_BANANA, 'text-detection': NANO_BANANA };

// A page, its texts flattened into its pixels, the panels hidden: only the tools and the page
async function setup(page, file, rect, tool) {
  await openFile(page, file);
  await toEnglish(page);
  await sleep(300);
  await page.evaluate((tool) => { window.TypeRPhotoshop.ops.flatten(); window.TypeRPhotoshop.ops.deselect(); window.TypeRApp.setTool(tool); document.activeElement && document.activeElement.blur(); }, tool);
  await page.keyboard.press('Tab');
  const close = page.locator('.fontbar button').last();
  if (await close.isVisible()) await close.click();
  await sleep(400);
  await frameDoc(page, rect);
  await page.mouse.move(W / 2, H / 2);
  await sleep(700);
}

const DEMOS = {
  async 'text-detection'(page) {
    await setup(page, `${PAGES}/02.psd`, [0, 0, 1114, 700], 'wand');
    const r = new Rec(page, 'text-detection', { clip: CLIP, x: 520, y: 330 });
    await r.cursor(); await r.shot(); r.hold(0.5);
    await r.moveTo(...(await center(page, 'text=Detect Text')));
    await r.click();
    await r.film(() => page.evaluate(() => !!window.TypeRPhotoshop.app.doc.state.selection), { every: 100, keep: 3 });
    await sleep(400); await r.shot(); r.hold(1.6);
    // Its message sits over the bar: gone before the next click
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await r.shot(); r.hold(0.2);
    await r.moveTo(...(await center(page, '.ctxbar__gen')));
    await r.click();
    // A paid model, several areas over the art: what it will cost, agreed to
    await sleep(400); await r.shot();
    if (await page.locator('.modal .modal__foot .btn--main').count()) {
      r.hold(1.2);
      await r.moveTo(...(await center(page, '.modal .modal__foot .btn--main')));
      await r.click();
    }
    // Over once every area over the art has its layer: the plain balloons are painted at once
    const done = () => page.evaluate(() => {
      const names = window.TypeRPhotoshop.app.doc.state.layers.map((l) => l.name).join('|');
      const tray = document.querySelector('.gentray');
      return /Text removed/.test(names) && !(tray && /Generating|Waiting|Downloading/.test(tray.innerText));
    });
    await r.moveTo(560, 200, 20);
    await r.film(done, { every: 200, keep: 2, max: 90000 });
    await sleep(500);
    // The tray folded: the clean page, whole
    await tidy(page); await sleep(200);
    await r.hide(); await r.shot(); r.hold(2.2);
    r.encode(OUT);
  },
  async 'generative-fill'(page) {
    await setup(page, `${PAGES}/11.psd`, [120, 712, 780, 1214], 'lasso');
    const r = new Rec(page, 'generative-fill', { clip: CLIP, x: 640, y: 360 });
    await r.cursor(); await r.shot(); r.hold(0.6);
    // The girl, whole, with a margin: the white halo around her, her hair and its strand, her
    // arms and her hand, the shadow under her dress and the one at her feet
    const pts = [[440, 758], [458, 762], [472, 790], [484, 808], [478, 832], [486, 856], [490, 880], [492, 920], [498, 950], [510, 988], [510, 1016],
      [480, 1018], [466, 1008], [466, 1040], [465, 1080], [468, 1140], [464, 1178], [454, 1202], [400, 1204], [350, 1200], [348, 1176], [358, 1150],
      [361, 1120], [368, 1060], [374, 1012], [356, 994], [352, 972], [366, 946], [380, 912], [378, 880], [378, 856], [382, 834], [374, 812],
      [388, 790], [418, 770], [440, 758]];
    const screen = []; for (const [x, y] of pts) screen.push(await docToScreen(page, x, y));
    await r.drag(screen, 54);
    r.hold(0.4);
    await r.moveTo(...(await center(page, '.ctxbar__gen')));
    await r.click();
    r.hold(0.2);
    // The prompt, typed
    for (const ch of 'Remove the girl, continue the stairs') { await page.keyboard.type(ch); await r.shot(); }
    r.hold(0.4);
    await r.moveTo(...(await center(page, '.ctxbar .btn--main')));
    await r.click();
    await r.moveTo(800, 330, 18);
    await r.film(() => page.evaluate(() => { const t = document.querySelector('.gentray'); return Boolean(t && /Done/.test(t.innerText)); }), { every: 150, keep: 2, max: 120000 });
    await sleep(400);
    await page.evaluate(() => window.TypeRPhotoshop.ops.deselect());
    await tidy(page);
    await sleep(300);
    await r.hide(); await r.shot(); r.hold(2.2);
    r.encode(OUT);
  },
  async gradient(page) {
    await openFile(page, `${PAGES}/02.psd`);
    await toEnglish(page);
    await sleep(300);
    await page.evaluate(() => {
      const PS = window.TypeRPhotoshop;
      const layer = PS.app.doc.state.layers.find((l) => l.kind === 'text' && /huge/i.test(l.params.layerText.textKey));
      PS.ops.selectLayer(layer.id);
      PS.app.fg = { r: 226, g: 38, b: 46 };
      PS.app.bg = { r: 255, g: 176, b: 0 };
      window.TypeRApp.setTool('gradient');
      document.activeElement && document.activeElement.blur();
    });
    await page.keyboard.press('Tab');
    const close = page.locator('.fontbar button').last();
    if (await close.isVisible()) await close.click();
    await sleep(400);
    await frameDoc(page, [20, 560, 360, 760]);
    await page.mouse.move(W / 2, H / 2);
    await sleep(700);
    const r = new Rec(page, 'gradient', { clip: CLIP, x: 620, y: 420 });
    await r.cursor(); await r.shot(); r.hold(0.7);
    const a = await docToScreen(page, 150, 628), b = await docToScreen(page, 196, 694);
    await r.drag([a, b], 26);
    await sleep(500); await r.shot(); r.hold(0.8);
    // Its ends can still be dragged: the end, further
    const b2 = await docToScreen(page, 210, 712);
    await r.drag([b, b2], 18);
    await sleep(400); await r.shot(); r.hold(0.5);
    await page.keyboard.press('Enter');
    await sleep(500);
    await tidy(page);
    await r.hide(); await r.shot(); r.hold(2);
    r.encode(OUT);
  },
  // A text dragged in its bubble: the room on each side, until it is centred (in green)
  async 'bubble-distances'(page) {
    const { w, h, clip } = SMALL;
    await openFile(page, `${PAGES}/02.psd`);
    await toEnglish(page);
    await sleep(300);
    const id = await page.evaluate(() => {
      const PS = window.TypeRPhotoshop;
      const layer = PS.app.doc.state.layers.find((l) => l.kind === 'text' && /little one/.test(l.params.layerText.textKey));
      // Pasted a little off the middle of its bubble
      PS.ops.moveLayers([layer.id], -26, 21);
      PS.ops.selectLayer(layer.id);
      window.TypeRApp.setTool('move');
      document.activeElement && document.activeElement.blur();
      return layer.id;
    });
    await page.keyboard.press('Tab');
    const close = page.locator('.fontbar button').last();
    if (await close.isVisible()) await close.click();
    await sleep(400);
    // Its own bar, over the bubble: put away
    await page.addStyleTag({ content: '.ctxbar { display: none !important; }' });
    await frameDoc(page, [687, 1165, 1114, 1400]);
    await page.mouse.move(w / 2, h / 2);
    await sleep(700);
    // Where it is centred: both pairs of sides as far from the bubble as each other
    const [dx, dy] = await page.evaluate((id) => {
      const ops = window.TypeRPhotoshop.ops;
      let best = null;
      for (let y = -50; y <= 10; y++) for (let x = -10; x <= 60; x++) {
        const g = new Map(ops.roomAround(id, x, y).map((r) => [r.side, r.gap]));
        if (g.size < 4) continue;
        const off = Math.abs(g.get('top') - g.get('bottom')) + Math.abs(g.get('left') - g.get('right'));
        if (!best || off < best[0] || (off === best[0] && Math.hypot(x - 26, y + 21) < Math.hypot(best[1] - 26, best[2] + 21))) best = [off, x, y];
      }
      return [best[1], best[2]];
    }, id);
    const box = await page.evaluate((id) => { const PS = window.TypeRPhotoshop; const f = PS.frameOf(PS.app.doc.state.layers.find((l) => l.id === id), PS.app.doc); return [(f.left + f.right) / 2, (f.top + f.bottom) / 2]; }, id);
    const from = await docToScreen(page, box[0], box[1]);
    const zoom = await page.evaluate(() => window.TypeRPhotoshop.app.doc.view.zoom);
    const to = [from[0] + dx * zoom, from[1] + dy * zoom];
    const r = new Rec(page, 'bubble-distances', { clip, x: from[0] + 120, y: from[1] + 90 });
    await r.cursor(); await r.shot(); r.hold(0.6);
    await r.moveTo(from[0], from[1]);
    await r.cursor(true, true); await r.shot(); r.hold(0.1);
    await page.mouse.down();
    // Too far, then back, then onto the middle, slower at the end
    const path = [[from[0] + 14, from[1] - 30], [to[0] + 22, to[1] - 14], [to[0] - 8, to[1] + 6], to];
    const steps = [16, 18, 14, 16];
    for (let i = 0; i < path.length; i++) {
      const [ax, ay] = [r.x, r.y], [bx, by] = path[i];
      for (let f = 1; f <= steps[i]; f++) {
        const u = f / steps[i], e = u * u * (3 - 2 * u);
        r.x = ax + (bx - ax) * e; r.y = ay + (by - ay) * e;
        await page.mouse.move(r.x, r.y);
        await r.cursor(true, true);
        await r.shot();
      }
      if (i < path.length - 1) r.hold(0.15);
    }
    // Centred: the four lines in green
    r.hold(1.8);
    await page.mouse.up();
    await r.cursor(true, false);
    await sleep(300); await r.shot(); r.hold(0.4);
    await page.evaluate(() => window.TypeRPhotoshop.ops.clearActiveLayers());
    await tidy(page);
    await r.hide(); await sleep(300); await r.shot(); r.hold(1.2);
    r.encode(OUT);
  },
  // A zone drawn over a board seen from the side: its text lies on it
  async 'auto-perspective'(page) {
    await openFile(page, BOARD);
    // Its font isn't here: the text written by hand on the board goes, the rest keeps its pixels
    const later = page.locator('dialog[open] button', { hasText: 'Later' });
    if (await later.count()) await later.first().click();
    await sleep(300);
    // The board's words in a hand of chalk: Bradley Hand, the Mac's own
    const hand = fs.readFileSync(HAND).toString('base64');
    await page.evaluate(async (b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      await window.TypeRFonts.addFiles([new File([u], 'Bradley Hand Bold.ttf')]);
      await window.TypeRFonts.ensure('BradleyHandITCTT-Bold');
    }, hand);
    await page.evaluate(() => {
      const { ops, app } = window.TypeRPhotoshop;
      const doc = app.doc;
      const board =doc.state.layers.find((l) => l.kind === 'text' && /Color circuit/.test(l.params.layerText.textKey));
      ops.selectLayer(board.id); ops.deleteLayers();
      const date = doc.state.layers.find((l) => l.kind === 'text' && /août/.test(l.params.layerText.textKey));
      if (date) ops.setText(date.id, 'Aug. 28');
      // The board's English, typed straight
      app.textDefaults.size = 28;
      const text = ops.newText(800, 500, '08/28   REHEARSALS\r\r15:30   Color Circuit\r15:50   Heartbreak\r16:10   CentiBernard\r16:30   Fant\u2019eaume', null);
      ops.setTextStyle([text.id], { fontPostScriptName: 'BradleyHandITCTT-Bold', fontName: 'Bradley Hand', fontStyleName: 'Bold' }, { alignment: 'left' });
      ops.clearActiveLayers();
      window.TypeRApp.setTool('perspective');
      document.activeElement && document.activeElement.blur();
    });
    await page.keyboard.press('Tab');
    const close = page.locator('.fontbar button').last();
    if (await close.isVisible()) await close.click();
    await toolsOnly(page);
    await sleep(400);
    await frameDoc(page, [560, 150, 1300, 760]);
    await page.mouse.move(W / 2, H / 2);
    await sleep(800);
    const r = new Rec(page, 'auto-perspective', { clip: CLIP, x: 560, y: 330 });
    await r.cursor(); await r.shot(); r.hold(0.8);
    // Over the board, corner to corner
    const a = await docToScreen(page, 585, 170), b = await docToScreen(page, 1285, 790);
    await r.drag([a, b], 30, { settle: () => sleep(900) });
    r.hold(1.6);
    // Moved on the board, it stays on it: taken by its middle
    const mid = await page.evaluate(() => {
      const l = window.TypeRPhotoshop.app.doc.state.layers.find((x) => x.kind === 'text' && /REHEARSALS/.test(x.params.layerText.textKey));
      const c = l.warp.corners;
      return [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
    });
    const from = await docToScreen(page, mid[0], mid[1]), to = await docToScreen(page, mid[0] - 70, mid[1] + 40);
    await r.moveTo(from[0], from[1]);
    await r.click(() => sleep(400));
    r.hold(0.3);
    await r.drag([from, to], 28, { settle: () => sleep(600) });
    r.hold(1);
    // The zone's lines put away: the board as it will be printed
    await page.evaluate(() => { window.TypeRPhotoshop.ops.clearActiveLayers(); window.TypeRApp.setTool('move'); });
    await tidy(page);
    await r.hide(); await sleep(400); await r.shot(); r.hold(2);
    // The screentone of the board weighs: a little more compressed
    r.encode(OUT, { crf: 33 });
  },
  // A chapter in Flow: every page on one surface, the wheel goes into one and out again
  async 'flow-mode'(page) {
    const pages = ['01', '02', '03', '04', '05'].map((n) => ({ name: `${n}.psd`, b64: fs.readFileSync(`${PAGES}/${n}.psd`).toString('base64') }));
    await page.evaluate(async (pages) => {
      const files = pages.map(({ name, b64 }) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name); });
      await window.TypeRApp.openChapter(files);
    }, pages);
    await sleep(3000);
    await page.keyboard.press('Tab');
    await toolsOnly(page);
    await page.addStyleTag({ content: '.ctxbar, .gentray { display: none !important; }' });
    const flow = () => page.evaluate(() => window.TypeRApp.flow().state());
    const front = () => page.evaluate(() => window.TypeRPhotoshop.app.doc && window.TypeRPhotoshop.app.doc.name);
    // Page 02 opened off camera, its lettering in English, then the whole chapter in view
    // The middle of a page, on the screen
    const middleOf = async (name) => {
      const p = (await flow()).pages.find((one) => one.name === name);
      const [st, zoom] = await page.evaluate(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [[b.left, b.top], window.TypeRPhotoshop.app.doc.view.zoom]; });
      return [st[0] + p.title.x + (p.width * zoom) / 2, st[1] + p.title.y + p.title.height + (p.height * zoom) / 2];
    };
    await page.evaluate(() => window.TypeRApp.flow().fitAll());
    await sleep(800);
    const [tx, ty] = await middleOf('02.psd');
    await page.mouse.click(tx, ty);
    for (let i = 0; i < 60 && (await front()) !== '02.psd'; i++) await sleep(100);
    await toEnglish(page);
    await page.evaluate(() => { window.TypeRPhotoshop.ops.clearActiveLayers(); window.TypeRApp.setTool('move'); });
    await page.evaluate(() => window.TypeRApp.flow().fitAll());
    await sleep(2500);
    const r = new Rec(page, 'flow-mode', { clip: CLIP, x: 450, y: 470 });
    await r.cursor(); await r.shot(); r.hold(1.2);
    // The wheel turned over a page: into it
    const wheel = async (x, y, ticks, delta) => {
      for (let i = 0; i < ticks; i++) {
        await page.mouse.wheel(0, delta);
        await sleep(40);
        await r.cursor(); await r.shot();
      }
    };
    const into = async (name, ticks) => {
      const [x, y] = await middleOf(name);
      await r.moveTo(x, y);
      await wheel(r.x, r.y, ticks, -45);
      await sleep(1200); await r.shot(); r.hold(1.3);
    };
    await into('02.psd', 12);
    // Out again, and over to another page
    await wheel(r.x, r.y, 12, 45);
    await sleep(600); await r.shot(); r.hold(0.4);
    await into('01.psd', 10);
    await wheel(r.x, r.y, 10, 45);
    await sleep(800); await r.shot(); r.hold(0.4);
    await r.hide(); await r.shot(); r.hold(1.2);
    // A manga page is heavy at this size: more compressed
    r.encode(OUT, { crf: 38 });
  },
  // Clip Studio Paint's brushes and materials in the Library: a brush picked paints, a bubble placed
  async library(page) {
    const files = ['brushes-a.7z', 'brushes-b.7z', 'bubbles.clip'].map((name) => ({ name, b64: fs.readFileSync(path.join(CSP, name)).toString('base64') }));
    await page.evaluate(() => window.TypeRPhotoshop.ops.newDocument({ name: 'Untitled-1', width: 1400, height: 900, resolution: 72, background: 'white' }));
    await sleep(500);
    await page.evaluate(async (files) => {
      const list = files.map(({ name, b64 }) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name); });
      await window.TypeRLibrary.importFiles(list);
    }, files);
    for (let i = 0; i < 240; i++) { if (await page.evaluate(() => /Imported/.test((document.getElementById('toast') || {}).innerText || ''))) break; await sleep(500); }
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.keyboard.press('Tab');
    await toolsOnly(page);
    await page.evaluate(() => { window.TypeRLibrary.show(); window.TypeRApp.setTool('move'); document.activeElement && document.activeElement.blur(); });
    await page.addStyleTag({ content: '.ctxbar, .gentray { display: none !important; }' });
    await sleep(600);
    await frameDoc(page, [0, 0, 1400, 900]);
    await sleep(800);
    const r = new Rec(page, 'library', { clip: CLIP, x: 420, y: 330 });
    await r.cursor(); await r.shot(); r.hold(0.8);
    const rows = page.locator('.library__brush');
    const stroke = async (n, pts) => {
      const b = await rows.nth(n).boundingBox();
      await r.moveTo(b.x + b.width / 2, b.y + b.height / 2);
      await r.click(() => sleep(400));
      r.hold(0.3);
      const screen = []; for (const [x, y] of pts) screen.push(await docToScreen(page, x, y));
      await r.drag(screen, 30, { settle: () => sleep(500) });
      r.hold(0.5);
    };
    // A ribbon of hatching, from the pack
    await stroke(1, [[110, 230], [330, 170], [560, 230], [780, 160]]);
    // The materials: a bubble, double-clicked, lands on the page
    await r.moveTo(...(await center(page, '.library__tab >> nth=1')));
    await r.click(() => sleep(700));
    r.hold(0.4);
    const tile = await page.locator('.library__tile').nth(2).boundingBox();
    await r.moveTo(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await r.cursor(true, true); await r.shot();
    await page.mouse.dblclick(r.x, r.y);
    await r.cursor(true, false);
    const placed = () => page.evaluate(() => window.TypeRPhotoshop.app.doc.state.layers.length > 3);
    for (let i = 0; i < 40 && !(await placed()); i++) await sleep(200);
    await sleep(800); await r.shot(); r.hold(0.8);
    // Free Transform is open on it: smaller, then where it goes
    const box = await page.evaluate(() => { const PS = window.TypeRPhotoshop; const doc = PS.app.doc; const id = doc.state.activeIds[doc.state.activeIds.length - 1]; const l = doc.state.layers.find((one) => one.id === id); const b = PS.ops.pixelBox(l); return [b.left, b.top, b.right, b.bottom]; });
    const corner = await docToScreen(page, box[2], box[3]);
    const smaller = await docToScreen(page, box[0] + (box[2] - box[0]) * 0.55, box[1] + (box[3] - box[1]) * 0.55);
    await r.drag([corner, smaller], 22, { settle: () => sleep(300) });
    r.hold(0.3);
    const inside = await docToScreen(page, box[0] + (box[2] - box[0]) * 0.27, box[1] + (box[3] - box[1]) * 0.27);
    const there = await docToScreen(page, 1060, 450);
    await r.drag([inside, [there[0], there[1]]], 24, { settle: () => sleep(300) });
    r.hold(0.6);
    await page.keyboard.press('Enter');
    await sleep(500);
    await page.evaluate(() => window.TypeRPhotoshop.ops.clearActiveLayers());
    await tidy(page);
    await r.hide(); await r.shot(); r.hold(2);
    r.encode(OUT);
  },
};
STORAGE['flow-mode'] = () => Object.assign({ 'typer.web.settings': JSON.stringify({ workspace: 'flow', wheel: 'zoom' }) }, LAMA);

(async () => {
  for (const [name, run] of Object.entries(DEMOS)) {
    if (wanted.length && !wanted.includes(name)) continue;
    const size = SIZES[name] || { w: W, h: H };
    const { browser, server, page } = await boot({ w: size.w, h: size.h, storage: STORAGE[name] ? STORAGE[name]() : LAMA });
    // The notice about the computer's fonts: not what any demo is about
    await page.addStyleTag({ content: '.fontbar { display: none !important; }' });
    try { await run(page); } catch (e) { console.log(name, 'failed', e); process.exitCode = 1; }
    await browser.close(); server.close();
  }
})();
