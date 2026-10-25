#!/usr/bin/env node
// E2E test: replay each call in a real Chrome browser and compare final notes
// with the headless reference produced by lib/extractor.js (same pipeline).
// Run with: npm run test:e2e
'use strict';

const { chromium } = require('playwright');
const { spawn }    = require('child_process');
const { runCall, parseTranscript } = require('../lib/extractor');
const fs   = require('fs');
const path = require('path');
const { confirmCost } = require('../lib/confirm');

const E2E_PORT = 3096;
const BASE     = `http://localhost:${E2E_PORT}`;
const TEST_DIR = path.join(__dirname, '..', 'test');

// ── Calls to test ─────────────────────────────────────────────────────────────
const CALLS = [
  { name: 'tidy-call',               file: 'tidy-call.txt',                     url: '/test/tidy-call.txt' },
  { name: 'messy-call',              file: 'messy-call.txt',                    url: '/test/messy-call.txt' },
  { name: 'thin-call',               file: 'thin-call.txt',                     url: '/test/thin-call.txt' },
  { name: 'objection-call',          file: 'objection-call.txt',                url: '/test/objection-call.txt' },
  { name: 'hospital-cfo-call',       file: 'holdout/hospital-cfo-call.txt',     url: '/test/holdout/hospital-cfo-call.txt' },
  { name: 'hospital-storage-call',   file: 'holdout/hospital-storage-call.txt', url: '/test/holdout/hospital-storage-call.txt' },
  { name: 'hospital-team-call',      file: 'holdout/hospital-team-call.txt',    url: '/test/holdout/hospital-team-call.txt' },
  { name: 'hospital-uptime-call',    file: 'holdout/hospital-uptime-call.txt',  url: '/test/holdout/hospital-uptime-call.txt' },
];

// ── Server lifecycle ──────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(E2E_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { if (d.toString().includes('localhost:')) resolve(child); });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', reject);
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

async function waitServerReady(ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/samples`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server not ready');
}

// ── Notes flattener — extracts all .value fields for comparison ───────────────
function flattenValues(notes) {
  const out = {};
  function walk(obj, prefix) {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      if (prefix === 'needs') {
        out['needs'] = obj.filter(n => n.value).map(n => n.value).sort().join(' ||| ');
        out['needs.count'] = obj.filter(n => n.value).length;
        return;
      }
      if (prefix === 'scratch') {
        out['scratch'] = obj.filter(s => s.value).map(s => s.value).sort().join(' ||| ');
        return;
      }
      return;
    }
    if (typeof obj === 'object' && 'value' in obj) {
      if (obj.value !== null && obj.value !== undefined) out[prefix] = obj.value;
      return;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        walk(obj[key], prefix ? `${prefix}.${key}` : key);
      }
    }
  }
  walk(notes, '');
  return out;
}

// ── Compare notes, return list of meaningful mismatches ──────────────────────
// Exact match:    numbers, needs.count, topNeed — the structured facts that must be identical.
// Presence match: text fields — both must be null or both non-null (wording may differ due
//                 to model non-determinism across separate API calls).
// Skip:           needs text, scratch — wording-only fields.
const EXACT_KEYS = new Set([
  'numbers.paysNow', 'numbers.quote', 'numbers.canAbsorb',
  'situation.hosts', 'situation.vms', 'situation.storageTB', 'situation.teamSize',
  'needs.count', 'topNeed',
]);
const SKIP_KEYS  = new Set(['needs', 'scratch']);

function diffValues(_name, ref, browser) {
  const diffs = [];
  const allKeys = new Set([...Object.keys(ref), ...Object.keys(browser)]);
  for (const k of allKeys) {
    if (SKIP_KEYS.has(k)) continue;
    const rv = ref[k] ?? null;
    const bv = browser[k] ?? null;
    if (EXACT_KEYS.has(k)) {
      if (rv !== bv) diffs.push({ key: k, ref: rv, browser: bv });
    } else {
      // Presence: both null or both non-null
      const rHas = rv !== null;
      const bHas = bv !== null;
      if (rHas !== bHas) diffs.push({ key: k, ref: rv, browser: bv });
    }
  }
  return diffs;
}

// ── Run one call in Chrome, return notes + pitch text ────────────────────────
async function runBrowser(browser, callInfo) {
  const ctx  = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE);

  // Inject the call into the replay engine (bypasses the dropdown for holdout files)
  await page.evaluate(async (url) => {
    // Fetch transcript text from the server's static /test route
    const resp = await fetch(url);
    const text = await resp.text();
    const utterances = window.parseTranscriptFile(text);

    // Reset all state the same way startReplay() does
    window.state.notes          = window.createEmptyNotes();
    window.state.transcript     = [];
    window.state.recentUtterances = [];
    window.state.replayUtterances = utterances;
    window.state.replayIndex    = 0;
    window.state.replayPaused   = false;
    window.state.lastExtractTime = 0;
    window.state.extractInFlight = false;
    window.state.forceFlush     = false;
    window.state.totalTokens    = 0;
    window.state.objections     = [];
    window.state.nutanixIntroSuggested = false;
    window.state.liveMode       = false;
    window.state.pitchHeld      = false;

    // DOM reset
    document.getElementById('transcript-list').innerHTML = '';
    document.getElementById('timer').textContent = '00:00';
    document.getElementById('replay-progress').textContent = '';
    const btn = document.getElementById('btn-replay-start');
    if (btn) btn.textContent = '↺ Restart';

    // Speed: fastest
    document.getElementById('replay-speed').value = '100';

    window.renderAll();
    window.scheduleNextUtterance();
  }, callInfo.url);

  // Wait for 'Done' (set only after all flushes complete, per our scheduleNextUtterance fix)
  await page.waitForFunction(
    () => document.getElementById('replay-progress')?.textContent === 'Done',
    { timeout: 120000 }
  );

  // Extra guard: wait until extractInFlight settles
  await page.waitForFunction(
    () => !window.state.extractInFlight,
    { timeout: 30000 }
  );

  // Capture state
  const result = await page.evaluate(() => ({
    notes:      window.state.notes,
    objections: window.state.objections,
    pitchText:  document.getElementById('pitch-lines')?.innerText || '',
  }));

  await ctx.close();
  return result;
}

// ── API usage tracking ────────────────────────────────────────────────────────
const apiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
function acc(resultPromise) {
  return resultPromise.then(r => {
    apiUsage.calls        += r.callCount    || 0;
    apiUsage.inputTokens  += r.inputTokens  || 0;
    apiUsage.outputTokens += r.outputTokens || 0;
    return r;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  await confirmCost('This makes about 32 API calls (~$0.25).');
  let server, browser;
  const results = [];

  try {
    process.stderr.write('Starting server…\n');
    server = await startServer();
    await waitServerReady();
    process.stderr.write(`Server ready at ${BASE}\n`);

    browser = await chromium.launch({ channel: 'chrome', headless: true });

    for (const callInfo of CALLS) {
      const txPath = path.join(TEST_DIR, callInfo.file);
      const text   = fs.readFileSync(txPath, 'utf8');
      const utterances = parseTranscript(text);

      process.stderr.write(`\n── ${callInfo.name} (${utterances.length} utterances) ──\n`);

      // Reference: headless via lib/extractor.js
      process.stderr.write('  headless reference… ');
      const { notes: refNotes, objections: refObj } = await acc(runCall(utterances, BASE, {
        onBatch: () => process.stderr.write('.'),
      }));
      process.stderr.write('\n');

      // Browser via Playwright
      process.stderr.write('  browser replay… ');
      const { notes: brNotes, objections: brObj, pitchText } = await runBrowser(browser, callInfo);
      process.stderr.write('done\n');

      // Compare
      const refFlat = flattenValues(refNotes);
      const brFlat  = flattenValues(brNotes);
      const diffs   = diffValues(callInfo.name, refFlat, brFlat);

      // Objection key-set comparison: headless accumulates raw API objects (may include
      // duplicates across batches); browser deduplicates within 60s.  Compare unique key
      // SETS — every key the headless found must also be found by the browser.
      const refObjSet = new Set((refObj || []).map(o => o.matchedKey));
      const brObjSet  = new Set((brObj  || []).map(o => o.matchedKey));
      const missingInBrowser = [...refObjSet].filter(k => !brObjSet.has(k));
      const extraInBrowser   = [...brObjSet].filter(k => !refObjSet.has(k));
      if (missingInBrowser.length > 0) {
        diffs.push({ key: 'objections.missing', ref: [...refObjSet].sort().join(','), browser: [...brObjSet].sort().join(',') });
      }
      if (extraInBrowser.length > 0) {
        diffs.push({ key: 'objections.extra', ref: [...refObjSet].sort().join(','), browser: [...brObjSet].sort().join(',') });
      }

      results.push({ name: callInfo.name, pass: diffs.length === 0, diffs, pitchText,
                     refNotes, brNotes, refObj, brObj });
    }

  } finally {
    if (browser) await browser.close();
    if (server)  server.kill();
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log('E2E RESULTS\n');

  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.pass) {
      console.log(`  PASS  ${r.name}`);
      passed++;
    } else {
      console.log(`  FAIL  ${r.name}`);
      for (const d of r.diffs) {
        console.log(`         ${d.key}`);
        console.log(`           headless: ${JSON.stringify(d.ref)}`);
        console.log(`           browser:  ${JSON.stringify(d.browser)}`);
      }
      failed++;
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`${passed + failed} calls  —  ${passed} passed, ${failed} failed`);
  const fmt = n => n.toLocaleString();
  console.log(`API usage (headless only): ${fmt(apiUsage.calls)} calls  |  input: ${fmt(apiUsage.inputTokens)} tokens  |  output: ${fmt(apiUsage.outputTokens)} tokens`);

  // ── messy-call detail ──────────────────────────────────────────────────────
  const messy = results.find(r => r.name === 'messy-call');
  if (messy) {
    console.log('\n' + '━'.repeat(60));
    console.log('messy-call  ON-SCREEN NOTES (browser)\n');
    const flat = flattenValues(messy.brNotes);
    for (const [k, v] of Object.entries(flat)) {
      if (v !== null && v !== undefined) console.log(`  ${k}: ${v}`);
    }
    console.log('\nmessy-call  PITCH TEXT (browser)\n');
    console.log(messy.pitchText || '(none)');
    console.log('\nmessy-call  OBJECTIONS (browser)');
    for (const o of (messy.brObj || [])) {
      console.log(`  [${o.matchedKey}] "${o.quote}"`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
