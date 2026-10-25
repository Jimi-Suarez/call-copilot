#!/usr/bin/env node
// Layout test: live column fits viewports; wide layout shows call sheet; narrow fills full width.
// Injects tidy-call transcript (no extraction) to simulate end-of-call state.
// Run with: npm run test:layout
// Screenshots saved to: test/layout-shots/
'use strict';

const { chromium } = require('playwright');
const { spawn }    = require('child_process');
const path         = require('path');
const fs           = require('fs');

const LAYOUT_PORT = 3097;
const BASE        = `http://localhost:${LAYOUT_PORT}`;
const SHOTS_DIR   = path.join(__dirname, 'layout-shots');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(LAYOUT_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { if (d.toString().includes('localhost:')) resolve(child); });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', reject);
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

// Inject tidy-call transcript into state and rerender — no extraction needed.
async function injectTidyCall(page) {
  await page.evaluate(async () => {
    const resp = await fetch('/test/tidy-call.txt');
    const text = await resp.text();
    const utterances = window.parseTranscriptFile(text);
    window.state.notes          = window.createEmptyNotes();
    window.state.transcript     = utterances;
    window.state.recentUtterances = [];
    window.state.objections     = [];
    window.state.replayMode     = true;
    window.state.replayIndex    = utterances.length;
    window.renderAll();
    // Populate transcript DOM directly (renderAll does not re-render existing utterances)
    const list = document.getElementById('transcript-list');
    if (list) {
      list.innerHTML = utterances.map(u =>
        `<div class="utt-row"><span class="utt-spk">${u.speaker}</span> <span class="utt-text">${u.text}</span></div>`
      ).join('');
    }
  });
}

const SIZES = [
  { w: 1000, h: 450, label: '1000x450', wideLayout: true  },
  { w: 1280, h: 800, label: '1280x800', wideLayout: true  },
  { w: 700,  h: 600, label: '700x600',  wideLayout: false },
];

async function runLayoutTests() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  let server;
  let browser;
  let passed = 0;
  let failed = 0;

  try {
    server  = await startServer();
    browser = await chromium.launch();

    for (const { w, h, label, wideLayout } of SIZES) {
      const ctx  = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await injectTidyCall(page);

      const shotPath = path.join(SHOTS_DIR, `layout-${label}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });

      const checks = await page.evaluate((isWide) => {
        const results = [];

        const keysEl    = document.getElementById('lv-keys');
        const midEl     = document.getElementById('lv-mid');
        const nextQEl   = document.getElementById('lv-next-q');
        const liveColEl = document.getElementById('live-col');
        const reviewEl  = document.getElementById('review-view');

        if (!keysEl || !midEl || !liveColEl) {
          return [{ ok: false, name: 'elements', reason: 'required elements missing' }];
        }

        const keysRect    = keysEl.getBoundingClientRect();
        const midRect     = midEl.getBoundingClientRect();
        const liveRect    = liveColEl.getBoundingClientRect();

        // 1. Keys row within viewport
        results.push({
          ok:     keysRect.bottom <= window.innerHeight + 2,
          name:   'keys-visible',
          reason: `#lv-keys bottom ${keysRect.bottom.toFixed(0)} > viewport ${window.innerHeight}`,
        });

        // 2. Mid block at least 120px
        results.push({
          ok:     midRect.height >= 120,
          name:   'mid-height',
          reason: `#lv-mid height ${midRect.height.toFixed(0)}px < 120px`,
        });

        // 3. Mid block scrollable when overflowing
        if (midEl.scrollHeight > midEl.clientHeight + 2) {
          const overflowY = getComputedStyle(midEl).overflowY;
          results.push({
            ok:     overflowY === 'auto' || overflowY === 'scroll',
            name:   'mid-scrollable',
            reason: `#lv-mid overflows but overflow-y="${overflowY}"`,
          });
        }

        // 4. Ask Next text not clipped
        if (nextQEl && nextQEl.scrollHeight > nextQEl.clientHeight + 4) {
          results.push({
            ok:     false,
            name:   'ask-next-unclipped',
            reason: `#lv-next-q clipped: scrollH=${nextQEl.scrollHeight} clientH=${nextQEl.clientHeight}`,
          });
        }

        // 5. Review pane is hidden by default at all widths
        const reviewHidden = !reviewEl || getComputedStyle(reviewEl).display === 'none';
        results.push({
          ok:     reviewHidden,
          name:   'review-hidden-default',
          reason: `#review-view should be hidden by default (display=${reviewEl ? getComputedStyle(reviewEl).display : 'N/A'})`,
        });

        if (isWide) {
          // 6a. At wide: live-col is a fixed sidebar (~440px), not full viewport
          results.push({
            ok:     liveRect.width <= window.innerWidth - 100,
            name:   'live-col-sidebar',
            reason: `#live-col width ${liveRect.width.toFixed(0)}px should leave room for transcript-col (viewport ${window.innerWidth}px)`,
          });

          // 6b. Transcript column is visible and has reasonable width
          const txCol = document.getElementById('transcript-col');
          const txDisplay = txCol ? getComputedStyle(txCol).display : 'none';
          const txRect    = txCol ? txCol.getBoundingClientRect() : null;
          results.push({
            ok:     txDisplay !== 'none' && !!txRect && txRect.width > 100,
            name:   'transcript-col-visible',
            reason: `#transcript-col display=${txDisplay} width=${txRect ? txRect.width.toFixed(0) : 'N/A'}px`,
          });

          // 7. Toggle button is present and visible
          const toggleBtn = document.getElementById('btn-view-toggle');
          const toggleVisible = !!toggleBtn && getComputedStyle(toggleBtn).display !== 'none';
          results.push({
            ok:     toggleVisible,
            name:   'toggle-btn-visible',
            reason: `#btn-view-toggle not visible at wide viewport`,
          });
        } else {
          // 6. At narrow: live column fills the full viewport width
          results.push({
            ok:     Math.abs(liveRect.width - window.innerWidth) <= 2,
            name:   'live-fills-viewport',
            reason: `#live-col width ${liveRect.width.toFixed(0)}px != viewport ${window.innerWidth}px`,
          });
        }

        return results;
      }, wideLayout);

      let rowPassed = 0;
      let rowFailed = 0;
      for (const c of checks) {
        if (c.ok) { rowPassed++; }
        else       { console.log(`  FAIL  ${label} / ${c.name}: ${c.reason}`); rowFailed++; }
      }
      if (rowFailed === 0) {
        const compactTag = w <= 900 ? '' : (h <= 600 ? ' [compact]' : '');
        const midH = checks.find(c => c.name === 'mid-height');
        console.log(`  PASS  ${label}${compactTag}  (${checks.length} checks, mid≥120px OK)`);
        passed++;
      } else {
        failed++;
      }
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    if (server)  server.kill();
  }

  console.log(`\n${passed + failed} viewport sizes: ${passed} passed, ${failed} failed`);
  console.log(`Screenshots: ${SHOTS_DIR}`);
  if (failed > 0) process.exit(1);
}

runLayoutTests().catch(e => { console.error(e); process.exit(1); });
