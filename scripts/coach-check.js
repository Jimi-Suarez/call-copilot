#!/usr/bin/env node
// npm run test:coach
// Stage 1 coach check: for each holdout call at 25/50/75% of call time, print
// NEXT question, criteria chips, dig-here items, and FAIL/PASS for each condition.
// Also spot-checks 3 fields per call (expected vs actual) and fixes /api/samples.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { runCall, parseTranscript, fv } = require('../lib/extractor');
const CoachLogic = require('../public/coach-logic.js');

const PORT = 3095;
const BASE = `http://localhost:${PORT}`;
const HOLDOUT = path.join(__dirname, '../test/holdout');
const DATA    = path.join(__dirname, '../data');

const CALLS = ['hospital-cfo-call','hospital-storage-call','hospital-team-call','hospital-uptime-call'];

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
      if (!s.includes('[extract]') && !s.includes('[debrief]')) process.stderr.write(d);
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

// ── Time helpers ──────────────────────────────────────────────────────────────
function tsToSec(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [m, s] = ts.split(':').map(Number);
  return (m || 0) * 60 + (s || 0);
}
function secToTs(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Display labels for grey chips ─────────────────────────────────────────────
const GAP = {
  '1a': 'needs: hosts/VMs/storage/team',
  '1b': 'needs: pain+affects+why+cause',
  '1c': 'needs: what she needs to happen',
  '1d': 'needs: cost of doing nothing + impact',
  '1e': 'needs: board date or renewal date',
  '2':  'Nutanix not yet introduced',
  '3':  'objections not yet handled',
  '4':  'needs: next step who+date',
};

// ── Pure computeTicks (ported from computeBriefTicks in app.js) ───────────────
function computeTicks(notes, transcript, objections) {
  const n = notes, fi = a => a.filter(Boolean).length;
  const meL = transcript.filter(u => u.speaker === 'Me').map(u => u.text.toLowerCase());
  const nutanixDet = meL.some(t =>
    (t.includes('nutanix') && (t.includes('put')||t.includes('manage')||t.includes('idea')||t.includes('try'))) ||
    t.includes('can i try a few ideas')
  );
  const openObj = (objections||[]).filter(o => o.status === 'open');
  const allHandled = openObj.length === 0 && (objections||[]).length > 0;
  const noneRaised = (objections||[]).length === 0;
  const painC = fi([n.pain.value, n.whatItAffects.value, n.whyProblem.value, n.cause.value]);
  return [
    { id:'1a', label:'Situation', status: (n.situation.hosts.value||n.situation.vms.value||n.situation.workloads.value) ? 'done' : 'yet' },
    { id:'1b', label:'Pain',      status: painC >= 3 ? 'done' : painC >= 1 ? 'partial' : 'yet' },
    { id:'1c', label:'Needs',     status: n.needs.filter(nd => nd.value).length >= 1 ? 'done' : 'yet' },
    { id:'1d', label:'Implic.',   status: fi([n.doingNothing.value,n.impactOnOthers.value,n.personalStake.value]) >= 2 ? 'done' : 'yet' },
    { id:'1e', label:'Timeframe', status: fi([n.deadline.value,n.renewalDate.value]) >= 1 ? 'done' : 'yet' },
    { id:'2',  label:'Nutanix',   status: nutanixDet ? 'suggest' : 'yet' },
    { id:'3',  label:'Objections',status: noneRaised ? 'yet' : allHandled ? 'suggest' : 'yet' },
    { id:'4',  label:'NextStep',  status: fi([n.nextStep.dateTime.value,n.nextStep.who.value]) >= 2 ? 'done' : 'yet' },
  ];
}

// ── Fail checks ───────────────────────────────────────────────────────────────
function checkFails(notes, transcript, objections, ticks, mainQ, nutanixMet) {
  const fails = [];
  const myTexts = transcript.filter(u => u.speaker === 'Me').map(u => u.text);
  const SW = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are','be','have','has','you','your','me','we','our','what','when','who','why','how','do','did','does','at','on','by','this','but','if','as','so','not','can','with','from','up','about','very','just','also','will','would','could','there','their']);
  const kw = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(w => w.length > 2 && !SW.has(w)));

  // F1: computeCoachNext returned a question that overlaps an already-asked Me utterance.
  // Only applies to mainQ (pre-pitch); post-pitch cycling questions are intentionally
  // reused after the pitch and should not be checked here.
  if (mainQ && !nutanixMet) {
    const qw = kw(mainQ);
    if (qw.size > 0) {
      for (const t of myTexts) {
        const tw = kw(t);
        if ([...qw].filter(w => tw.has(w)).length / qw.size >= 0.5) {
          fails.push({ code:'F1', msg:`NEXT repeats asked: "${mainQ.slice(0,55)}"` }); break;
        }
      }
    }
  }

  // F2: chip is grey but the underlying notes field is filled
  const n = notes;
  const tm = Object.fromEntries(ticks.map(t => [t.id, t.status]));
  if ((n.situation.hosts.value||n.situation.vms.value||n.situation.workloads.value) && tm['1a'] === 'yet')
    fails.push({ code:'F2', msg:'Situation chip grey but hosts/VMs/workloads filled' });
  if (n.pain.value && tm['1b'] === 'yet')
    fails.push({ code:'F2', msg:`Pain chip grey but pain="${n.pain.value.slice(0,40)}"` });
  if (n.needs.filter(nd => nd.value).length >= 1 && tm['1c'] === 'yet')
    fails.push({ code:'F2', msg:'Needs chip grey but needs filled' });

  // F3: "ready for the pitch" / PITCH READY shows before pain+needs
  const painMet  = tm['1b'] === 'done' || tm['1b'] === 'partial';
  const needsMet = tm['1c'] === 'done';
  if (mainQ === null && !nutanixMet && (!painMet || !needsMet))
    fails.push({ code:'F3', msg:`"ready for the pitch" with pain=${tm['1b']} needs=${tm['1c']}` });

  // F4: "ready for the pitch" / PITCH READY badge shows after pitch already given
  const pitchGiven = transcript.some(u => u.speaker === 'Me' && (
    u.text.toLowerCase().includes('can i try a few ideas') ||
    (u.text.toLowerCase().includes('nutanix') && u.text.toLowerCase().includes('system'))
  ));
  if (pitchGiven && !nutanixMet)
    fails.push({ code:'F4', msg:`Pitch given but nutanixMet=false → PITCH READY would still show` });

  // F5: date/availability constraint appears as a dig topic
  const constraintDigs = (notes.scratch || []).filter(s => CoachLogic.isConstraintItem(s.value));
  if (constraintDigs.length > 0)
    fails.push({ code:'F5', msg:`Constraint in dig: "${constraintDigs.map(s=>s.value.slice(0,40)).join('", "')}"` });

  return fails;
}

// ── Chip formatting ───────────────────────────────────────────────────────────
function fmtChip(tick) {
  const icon = tick.status === 'done' ? '✓' : tick.status === 'partial' ? '◑' : tick.status === 'suggest' ? '?' : '○';
  return `${icon}${tick.id}`;
}
function fmtChipLong(tick) {
  const icon = { done:'✓', partial:'◑', suggest:'?', yet:'○' }[tick.status] || '○';
  const cls  = tick.status === 'yet' ? ` [${GAP[tick.id]}]` : '';
  return `${icon} ${tick.label}${cls}`;
}

// ── Spot-check helpers ────────────────────────────────────────────────────────
function spotRow(call, fieldLabel, expectDesc, actual, pass) {
  const tick = pass ? '✓' : '✗';
  return { call, fieldLabel, expectDesc, actual: String(actual ?? 'null'), pass, tick };
}

function buildSpotChecks(callName, expected, notes, objections) {
  const rows = [];
  // 1. Always: a number field (exact)
  const numKey = expected.numbers && Object.keys(expected.numbers).find(k => expected.numbers[k] !== null && expected.numbers[k] !== undefined);
  if (numKey) {
    const ev = expected.numbers[numKey];
    const av = fv(notes, `numbers.${numKey}`);
    rows.push(spotRow(callName, `numbers.${numKey}`, `= ${ev}`, av, av === ev));
  }
  // 2. signOff or deadline contains check (shows actual value the contains check is run against)
  const containsKey = expected.contains && (expected.contains.signOff ? 'signOff' : expected.contains.deadline ? 'deadline' : Object.keys(expected.contains)[0]);
  if (containsKey) {
    const sub = expected.contains[containsKey];
    const av = fv(notes, containsKey);
    const pass = av != null && String(av).toLowerCase().includes(sub.toLowerCase());
    rows.push(spotRow(callName, containsKey, `contains "${sub}"`, av, pass));
  }
  // 3. topNeed (resolve index to text, shows full need text)
  if (expected.topNeed) {
    const idx = (fv(notes,'topNeed') || 1) - 1;
    const needText = notes.needs[idx]?.value || null;
    const pass = needText != null && needText.toLowerCase().includes(expected.topNeed.toLowerCase());
    rows.push(spotRow(callName, `topNeed[${(fv(notes,'topNeed')||'?')}]`, `contains "${expected.topNeed}"`, needText, pass));
  }
  return rows;
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

  const knowledge = JSON.parse(fs.readFileSync(path.join(DATA, 'knowledge.json'), 'utf8'));

  const allFails   = [];  // { call, pct, fail }
  const spotRows   = [];  // for spot-check table
  const coachRows  = [];  // { call, pct, ts, mainQ, ticks, digItems, fails }

  for (const callName of CALLS) {
    const txPath  = path.join(HOLDOUT, `${callName}.txt`);
    const exPath  = path.join(HOLDOUT, `${callName}.expected.json`);
    const utts    = parseTranscript(fs.readFileSync(txPath, 'utf8'));
    const expected = JSON.parse(fs.readFileSync(exPath, 'utf8'));

    const times   = utts.map(u => tsToSec(u.ts));
    const minT    = Math.min(...times);
    const maxT    = Math.max(...times);
    const dur     = maxT - minT;
    const checkpoints = [0.25, 0.50, 0.75].map(pct => ({
      pct: Math.round(pct * 100),
      cutSec: minT + pct * dur,
    }));

    // Run pipeline at each checkpoint + full run for spot-check
    // We can do 25/50/75 as separate partial runs, then the full run
    let fullNotes = null, fullObjs = null;

    for (const cp of [...checkpoints, { pct: 100, cutSec: maxT + 1 }]) {
      const partial = utts.filter(u => tsToSec(u.ts) <= cp.cutSec);
      const actualTs = partial.length > 0 ? partial[partial.length-1].ts : secToTs(cp.cutSec);

      process.stdout.write(`  ${callName} @${cp.pct}%…`);
      const { notes, objections } = acc(await runCall(partial, BASE));
      process.stdout.write(' done\n');

      if (cp.pct === 100) {
        fullNotes = notes; fullObjs = objections;
        continue; // spot-check only
      }

      // Compute coach state
      const ticks = computeTicks(notes, partial, objections);
      const tm = Object.fromEntries(ticks.map(t => [t.id, t.status]));
      const nutanixMet = tm['2'] === 'suggest' || tm['2'] === 'done';
      const { mainQ, backupQ } = CoachLogic.computeCoachNext(notes, partial, knowledge);

      // Post-pitch cycling (mirrors renderCoach)
      let displayQ = mainQ;
      if (nutanixMet) {
        const nextStepDone = tm['4'] === 'done';
        displayQ = CoachLogic.postPitchNext(objections, nextStepDone);
      }

      // Dig-here items (non-constraint, non-followed-up scratch)
      const digItems = (notes.scratch || []).filter(s => {
        s.isConstraint = s.isConstraint !== undefined ? s.isConstraint : CoachLogic.isConstraintItem(s.value);
        return !s.isConstraint && !s.followedUp;
      });

      const fails = checkFails(notes, partial, objections, ticks, displayQ, nutanixMet);
      fails.forEach(f => allFails.push({ call: callName, pct: cp.pct, ...f }));

      coachRows.push({ call: callName, pct: cp.pct, ts: actualTs, displayQ, backupQ, ticks, digItems, fails });
    }

    // Spot-check rows (from full run)
    if (fullNotes) {
      spotRows.push(...buildSpotChecks(callName, expected, fullNotes, fullObjs));
    }
  }

  // ── Print coach table ──────────────────────────────────────────────────────
  const BAR = '━'.repeat(80);
  console.log(`\n${BAR}`);
  console.log('  STAGE 1 COACH CHECK');
  console.log(BAR);

  let lastCall = '';
  for (const row of coachRows) {
    if (row.call !== lastCall) {
      console.log(`\n  ── ${row.call} ${'─'.repeat(Math.max(0, 55 - row.call.length))}`);
      lastCall = row.call;
    }
    const status = row.fails.length === 0 ? 'PASS' : `FAIL (${row.fails.length})`;
    console.log(`\n  @${row.pct}% [${row.ts}]  ${status}`);
    console.log(`    NEXT:  "${(row.displayQ || '(all done — post-pitch)').slice(0, 75)}"`);
    if (row.backupQ && !row.ticks.find(t => t.id === '2' && (t.status === 'done' || t.status === 'suggest'))) {
      console.log(`    ALT:   "${row.backupQ.slice(0, 75)}"`);
    }
    // Chips: compact with gap for 'yet'
    const chipLine = row.ticks.map(fmtChip).join('  ');
    console.log(`    CHIPS: ${chipLine}`);
    // Grey chips with their gap
    const greyChips = row.ticks.filter(t => t.status === 'yet');
    if (greyChips.length > 0) {
      greyChips.forEach(t => console.log(`           ○ ${t.label} — ${GAP[t.id]}`));
    }
    // Done/partial chips — show what was filled
    // Dig items
    if (row.digItems.length > 0) {
      console.log(`    DIG:   ${row.digItems.map(s => `"${s.value.slice(0,45)}"`).join(', ')}`);
    } else {
      console.log(`    DIG:   —`);
    }
    // Fails
    if (row.fails.length > 0) {
      row.fails.forEach(f => console.log(`    ✗ ${f.code}: ${f.msg}`));
    }
  }

  // ── Print spot-check table ─────────────────────────────────────────────────
  console.log(`\n${BAR}`);
  console.log('  STABILITY SPOT-CHECK  (expected vs actual, 3 fields per call)');
  console.log(BAR);
  console.log(`  ${'Call'.padEnd(28)} ${'Field'.padEnd(18)} ${'Expected check'.padEnd(30)} Actual value`);
  console.log(`  ${'─'.repeat(28)} ${'─'.repeat(18)} ${'─'.repeat(30)} ${'─'.repeat(30)}`);
  for (const r of spotRows) {
    const tick = r.pass ? '✓' : '✗';
    const actual = r.actual.length > 45 ? r.actual.slice(0, 43) + '…' : r.actual;
    console.log(`  ${tick} ${r.call.padEnd(26)} ${r.fieldLabel.padEnd(18)} ${r.expectDesc.padEnd(30)} ${actual}`);
  }

  // ── Failure summary ────────────────────────────────────────────────────────
  console.log(`\n${BAR}`);
  console.log('  FAILURE SUMMARY');
  console.log(BAR);

  if (allFails.length === 0) {
    console.log('\n  No failures across all 4 calls × 3 checkpoints.\n');
  } else {
    // Group by fail code → root cause
    const CAUSES = {
      F1: 'Already-asked filtering: computeCoachNext not filtering repeated questions',
      F2: 'Chip/notes mismatch: tick computation wrong relative to extracted notes',
      F3: '"Ready for pitch" gating: all-criteria-met but pain/needs not actually done',
      F4: 'Post-pitch detection: nutanixMet false even though pitch was given',
      F5: 'Constraint routing: isConstraintItem not catching date/availability text',
    };

    const byCode = {};
    for (const f of allFails) {
      if (!byCode[f.code]) byCode[f.code] = [];
      byCode[f.code].push(f);
    }

    for (const [code, items] of Object.entries(byCode)) {
      console.log(`\n  ${code} — ${CAUSES[code] || code}  (${items.length} occurrence${items.length > 1 ? 's' : ''})`);
      for (const f of items) {
        console.log(`     ${f.call} @${f.pct}%: ${f.msg}`);
      }
    }
    console.log(`\n  Total: ${allFails.length} failure${allFails.length > 1 ? 's' : ''}`);
  }

  server.kill();
  const fmt = n => n.toLocaleString();
  console.log(`API usage: ${fmt(apiUsage.calls)} calls  |  input: ${fmt(apiUsage.inputTokens)} tokens  |  output: ${fmt(apiUsage.outputTokens)} tokens`);
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
