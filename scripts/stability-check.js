#!/usr/bin/env node
// npm run test:stable
// Runs each holdout call 5 times, scores every field in .expected.json, prints
// X/5 per field. Fields below 5/5 are marked UNSTABLE with the values seen.
// Cause field is printed for every run regardless of expected.json.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { runCall, parseTranscript, fv } = require('../lib/extractor');

const RUNS  = 5;
const PORT  = 3097;
const BASE  = `http://localhost:${PORT}`;
const DIR   = path.join(__dirname, '../test/holdout');

const CALLS = [
  'hospital-cfo-call',
  'hospital-storage-call',
  'hospital-team-call',
  'hospital-uptime-call',
];

// Calls whose .txt lives outside DIR but whose .expected.json lives in DIR
const EXTRA_CALLS = [
  { name: 'objection-call', txtDir: path.join(__dirname, '../test') },
];

// ── Server lifecycle ──────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { if (d.toString().includes('localhost:')) resolve(child); });
    child.stderr.on('data', d => {
      const s = d.toString();
      if (!s.includes('[extract]')) process.stderr.write(d);
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('Server timeout')), 12000);
  });
}
async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/samples`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server not ready');
}

// ── Check builders (mirrors run-tests.js logic) ────────────────────────────
function needsArr(notes) { return notes.needs.filter(n => n.value); }
function hasObj(objs, match) { return objs.some(o => o.quote.toLowerCase().includes(match.toLowerCase())); }

function buildChecks(expected) {
  const checks = [];

  // numbers — exact integer
  if (expected.numbers) {
    for (const [k, v] of Object.entries(expected.numbers)) {
      if (v === undefined) continue;
      const dotPath = `numbers.${k}`;
      checks.push({
        label: dotPath,
        run: (notes) => fv(notes, dotPath) === v,
        fmt:  (notes) => String(fv(notes, dotPath)),
      });
    }
  }

  // mustNotInvent numbers — explicit null
  if (expected.mustNotInvent && expected.mustNotInvent.some(m => String(m).includes('number'))) {
    for (const k of ['paysNow', 'quote', 'canAbsorb']) {
      const dotPath = `numbers.${k}`;
      checks.push({
        label: `${dotPath} = null (mustNotInvent)`,
        run: (notes) => fv(notes, dotPath) === null,
        fmt:  (notes) => String(fv(notes, dotPath)),
      });
    }
  }

  // renewalDate null
  if ('renewalDate' in expected && expected.renewalDate === null) {
    checks.push({
      label: 'renewalDate = null',
      run: (notes) => fv(notes, 'renewalDate') === null,
      fmt:  (notes) => String(fv(notes, 'renewalDate')),
    });
  }

  // contains — substring checks on simple fields
  if (expected.contains) {
    for (const [dotPath, sub] of Object.entries(expected.contains)) {
      checks.push({
        label: `${dotPath} contains "${sub}"`,
        run: (notes) => String(fv(notes, dotPath) || '').toLowerCase().includes(sub.toLowerCase()),
        fmt:  (notes) => String(fv(notes, dotPath) ?? 'null'),
      });
    }
  }

  // painType in set
  if (expected.painTypeIn) {
    const short = expected.painTypeIn.slice(0, 2).join(' / ') + (expected.painTypeIn.length > 2 ? '…' : '');
    checks.push({
      label: `painType in [${short}]`,
      run: (notes) => expected.painTypeIn.includes(fv(notes, 'painType')),
      fmt:  (notes) => String(fv(notes, 'painType') ?? 'null'),
    });
  }

  // needsCount exact
  if (expected.needsCount != null) {
    checks.push({
      label: `needsCount = ${expected.needsCount}`,
      run: (notes) => needsArr(notes).length === expected.needsCount,
      fmt:  (notes) => String(needsArr(notes).length),
    });
  }

  // needsContain
  if (expected.needsContain) {
    for (const sub of expected.needsContain) {
      checks.push({
        label: `a need contains "${sub}"`,
        run: (notes) => needsArr(notes).some(n => n.value.toLowerCase().includes(sub.toLowerCase())),
        fmt:  (notes) => needsArr(notes).map(n => `"${n.value}"`).join(' | ') || 'none',
      });
    }
  }

  // topNeed — resolve 1-based index to need text
  if (expected.topNeed) {
    checks.push({
      label: `topNeed contains "${expected.topNeed}"`,
      run: (notes) => {
        const idx = (fv(notes, 'topNeed') || 1) - 1;
        return (notes.needs[idx]?.value || '').toLowerCase().includes(expected.topNeed.toLowerCase());
      },
      fmt: (notes) => {
        const idx = (fv(notes, 'topNeed') || 1) - 1;
        return `[${fv(notes, 'topNeed')}] "${notes.needs[idx]?.value || 'n/a'}"`;
      },
    });
  }

  // personalStakeContains
  if (expected.personalStakeContains) {
    checks.push({
      label: `personalStake contains "${expected.personalStakeContains}"`,
      run: (notes) => String(fv(notes, 'personalStake') || '').toLowerCase().includes(expected.personalStakeContains.toLowerCase()),
      fmt:  (notes) => String(fv(notes, 'personalStake') ?? 'null'),
    });
  }

  // needReasonContains
  if (expected.needReasonContains) {
    checks.push({
      label: `needReason contains "${expected.needReasonContains}"`,
      run: (notes) => String(fv(notes, 'needReason') || '').toLowerCase().includes(expected.needReasonContains.toLowerCase()),
      fmt:  (notes) => String(fv(notes, 'needReason') ?? 'null'),
    });
  }

  // scratch contains
  if (expected.scratch) {
    for (const sub of expected.scratch) {
      checks.push({
        label: `scratch contains "${sub}"`,
        run: (notes) => notes.scratch.some(s => s.value.toLowerCase().includes(sub.toLowerCase())),
        fmt:  (notes) => notes.scratch.map(s => `"${s.value}"`).join(' | ') || 'none',
      });
    }
  }

  // objections
  if (expected.objections && Array.isArray(expected.objections)) {
    for (const exp of expected.objections) {
      if (!exp.match) continue;
      checks.push({
        label: `objection: "${exp.match}"`,
        run: (_n, objs) => hasObj(objs, exp.match),
        fmt:  (_n, objs) => objs.map(o => `"${o.quote.slice(0, 50)}"`).join(' | ') || 'none',
      });
    }
  }

  // nextStep
  if (expected.nextStep) {
    const ns = expected.nextStep;
    if (ns.whoContains) {
      for (const sub of ns.whoContains) {
        checks.push({
          label: `nextStep.who contains "${sub}"`,
          run: (notes) => String(fv(notes, 'nextStep.who') || '').toLowerCase().includes(sub.toLowerCase()),
          fmt:  (notes) => String(fv(notes, 'nextStep.who') ?? 'null'),
        });
      }
    }
    if (ns.dateTimeContains) {
      for (const sub of (Array.isArray(ns.dateTimeContains) ? ns.dateTimeContains : [ns.dateTimeContains])) {
        checks.push({
          label: `nextStep.dateTime contains "${sub}"`,
          run: (notes) => String(fv(notes, 'nextStep.dateTime') || '').toLowerCase().includes(sub.toLowerCase()),
          fmt:  (notes) => String(fv(notes, 'nextStep.dateTime') ?? 'null'),
        });
      }
    }
    if (ns.purposeContains) {
      checks.push({
        label: `nextStep.purpose contains "${ns.purposeContains}"`,
        run: (notes) => String(fv(notes, 'nextStep.purpose') || '').toLowerCase().includes(ns.purposeContains.toLowerCase()),
        fmt:  (notes) => String(fv(notes, 'nextStep.purpose') ?? 'null'),
      });
    }
  }

  return checks;
}

// ── API usage tracking ────────────────────────────────────────────────────────
const apiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
function acc(r) {
  apiUsage.calls        += r.callCount    || 0;
  apiUsage.inputTokens  += r.inputTokens  || 0;
  apiUsage.outputTokens += r.outputTokens || 0;
  return r;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Starting server…');
  const server = await startServer();
  await waitReady();
  console.log('Server ready.\n');

  const allUnstable = []; // { call, label, score, values }

  for (const callName of CALLS) {
    const txPath  = path.join(DIR, `${callName}.txt`);
    const exPath  = path.join(DIR, `${callName}.expected.json`);
    const text    = fs.readFileSync(txPath, 'utf8');
    const utts    = parseTranscript(text);
    const expected = JSON.parse(fs.readFileSync(exPath, 'utf8'));
    const checks  = buildChecks(expected);

    const BAR = '━'.repeat(58);
    console.log(`\n${BAR}`);
    console.log(`  ${callName}`);
    console.log(BAR);

    // 5 runs
    const results = []; // array of { notes, objections }
    for (let r = 1; r <= RUNS; r++) {
      process.stdout.write(`  run ${r}/${RUNS}…`);
      const result = acc(await runCall(utts, BASE));
      results.push({ notes: result.notes, objections: result.objections });
      process.stdout.write(' done\n');
    }

    // Cause values for every run (always printed)
    const causeVals = results.map(r => fv(r.notes, 'cause') ?? 'null');
    console.log(`\n  CAUSE values (all ${RUNS} runs):`);
    causeVals.forEach((v, i) => console.log(`    run ${i + 1}: ${v === 'null' ? 'null' : `"${v}"`}`));

    // Score each check
    console.log(`\n  ${'FIELD'.padEnd(52)} SCORE`);
    console.log(`  ${'─'.repeat(52)} ─────`);

    for (const chk of checks) {
      const passes = results.map(r => chk.run(r.notes, r.objections));
      const score  = passes.filter(Boolean).length;
      const label  = chk.label.length > 50 ? chk.label.slice(0, 48) + '…' : chk.label;

      if (score === RUNS) {
        console.log(`  ${label.padEnd(52)} ${score}/${RUNS}`);
      } else {
        const marker = score === 0 ? '  UNSTABLE (0/5)' : `  UNSTABLE (${score}/${RUNS})`;
        console.log(`  ${label.padEnd(52)} ${score}/${RUNS} ◀ ${score === 0 ? 'ALWAYS FAILS' : 'UNSTABLE'}`);

        // Show distinct values seen
        const vals = results.map((r, i) => ({
          run: i + 1,
          passed: passes[i],
          val: chk.fmt(r.notes, r.objections),
        }));
        const distinct = [...new Set(vals.map(v => v.val))];
        for (const dv of distinct) {
          const runs = vals.filter(v => v.val === dv).map(v => v.run).join(',');
          const tick = vals.find(v => v.val === dv)?.passed ? '✓' : '✗';
          console.log(`       ${tick} [run${runs.length > 1 ? 's' : ''} ${runs}] ${dv}`);
        }

        allUnstable.push({ call: callName, label: chk.label, score, RUNS });
      }
    }
  }

  // Extra calls (txt outside holdout dir, expected.json in DIR)
  for (const extra of EXTRA_CALLS) {
    const txPath  = path.join(extra.txtDir, `${extra.name}.txt`);
    const exPath  = path.join(DIR, `${extra.name}.expected.json`);
    const text    = fs.readFileSync(txPath, 'utf8');
    const utts    = parseTranscript(text);
    const expected = JSON.parse(fs.readFileSync(exPath, 'utf8'));
    const checks  = buildChecks(expected);

    const BAR = '━'.repeat(58);
    console.log(`\n${BAR}`);
    console.log(`  ${extra.name}`);
    console.log(BAR);

    const results = [];
    for (let r = 1; r <= RUNS; r++) {
      process.stdout.write(`  run ${r}/${RUNS}…`);
      const result = acc(await runCall(utts, BASE));
      results.push({ notes: result.notes, objections: result.objections });
      process.stdout.write(' done\n');
    }

    const causeVals = results.map(r => fv(r.notes, 'cause') ?? 'null');
    console.log(`\n  CAUSE values (all ${RUNS} runs):`);
    causeVals.forEach((v, i) => console.log(`    run ${i + 1}: ${v === 'null' ? 'null' : `"${v}"`}`));

    console.log(`\n  ${'FIELD'.padEnd(52)} SCORE`);
    console.log(`  ${'─'.repeat(52)} ─────`);

    for (const chk of checks) {
      const passes = results.map(r => chk.run(r.notes, r.objections));
      const score  = passes.filter(Boolean).length;
      const label  = chk.label.length > 50 ? chk.label.slice(0, 48) + '…' : chk.label;
      if (score === RUNS) {
        console.log(`  ${label.padEnd(52)} ${score}/${RUNS}`);
      } else {
        console.log(`  ${label.padEnd(52)} ${score}/${RUNS} ◀ ${score === 0 ? 'ALWAYS FAILS' : 'UNSTABLE'}`);
        const vals = results.map((r, i) => ({ run: i + 1, passed: passes[i], val: chk.fmt(r.notes, r.objections) }));
        const distinct = [...new Set(vals.map(v => v.val))];
        for (const dv of distinct) {
          const runs = vals.filter(v => v.val === dv).map(v => v.run).join(',');
          const tick = vals.find(v => v.val === dv)?.passed ? '✓' : '✗';
          console.log(`       ${tick} [run${runs.length > 1 ? 's' : ''} ${runs}] ${dv}`);
        }
        allUnstable.push({ call: extra.name, label: chk.label, score, RUNS });
      }
    }
  }

  // Summary table
  console.log(`\n${'━'.repeat(58)}`);
  console.log('  UNSTABLE FIELDS SUMMARY');
  console.log('━'.repeat(58));

  if (allUnstable.length === 0) {
    console.log('  All fields 5/5 across all calls.');
  } else {
    // Group by inferred cause category
    const groups = {
      'Pain / painType routing': [],
      'Cause field assignment':  [],
      'Objection detection':     [],
      'Needs extraction':        [],
      'Numbers':                 [],
      'Next step':               [],
      'Other fields':            [],
    };

    for (const u of allUnstable) {
      const l = u.label.toLowerCase();
      if (l.includes('paintype') || l.includes('pain '))         groups['Pain / painType routing'].push(u);
      else if (l === 'cause' || l.startsWith('cause '))           groups['Cause field assignment'].push(u);
      else if (l.includes('objection'))                           groups['Objection detection'].push(u);
      else if (l.includes('need'))                                groups['Needs extraction'].push(u);
      else if (l.includes('numbers.') || l.includes('number'))    groups['Numbers'].push(u);
      else if (l.includes('nextstep'))                            groups['Next step'].push(u);
      else                                                        groups['Other fields'].push(u);
    }

    for (const [group, items] of Object.entries(groups)) {
      if (!items.length) continue;
      console.log(`\n  ▸ ${group}`);
      for (const u of items) {
        console.log(`      ${u.call}  "${u.label}"  ${u.score}/${u.RUNS}`);
      }
    }

    console.log(`\n  Total unstable fields: ${allUnstable.length}`);
  }

  server.kill();
  const fmt = n => n.toLocaleString();
  console.log(`API usage: ${fmt(apiUsage.calls)} calls  |  input: ${fmt(apiUsage.inputTokens)} tokens  |  output: ${fmt(apiUsage.outputTokens)} tokens`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
