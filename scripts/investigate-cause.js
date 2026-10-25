#!/usr/bin/env node
// Runs hospital-storage-call through the extraction pipeline RUNS times.
// Prints the cause value and its evidence each time so we can see where it varies.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { runCall, parseTranscript } = require('../lib/extractor');

const RUNS    = 5;
const PORT    = 3098;
const BASE    = `http://localhost:${PORT}`;
const TX_FILE = path.join(__dirname, '../test/holdout/hospital-storage-call.txt');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { if (d.toString().includes('localhost:')) resolve(child); });
    child.stderr.on('data', d => process.stderr.write(d));
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

(async () => {
  console.log('Starting server…');
  const server = await startServer();
  await waitReady();
  console.log('Server ready.\n');

  const text = fs.readFileSync(TX_FILE, 'utf8');
  const utterances = parseTranscript(text);

  // Print the utterances that are candidates for cause/whyProblem to show what the LLM sees
  console.log('─── Her utterances in first batch (u001–u012) ───────────────────────');
  utterances.slice(0, 12).filter(u => u.speaker === 'Her').forEach(u => {
    console.log(`  [${u.ts}] ${u.id}: "${u.text}"`);
  });
  console.log('');

  console.log(`─── Running ${RUNS} times ───────────────────────────────────────────────`);
  const col = { cause: [], whyProblem: [], whatItAffects: [] };

  for (let i = 1; i <= RUNS; i++) {
    let batchN = 0;
    const batchLog = [];

    const { notes } = await runCall(utterances, BASE, {
      onBatch(result) {
        batchN++;
        const causePatch  = result.patch.find(p => p.field === 'cause');
        const whyPatch    = result.patch.find(p => p.field === 'whyProblem');
        const whatPatch   = result.patch.find(p => p.field === 'whatItAffects');
        if (causePatch || whyPatch || whatPatch) {
          batchLog.push({ batch: batchN, causePatch, whyPatch, whatPatch });
        }
      }
    });

    const causeV = notes.cause.value;
    const causeE = (notes.cause.evidence || []).join(', ') || '—';
    const whyV   = notes.whyProblem.value;
    const whatV  = notes.whatItAffects.value;

    col.cause.push(causeV);
    col.whyProblem.push(whyV);
    col.whatItAffects.push(whatV);

    console.log(`Run ${i}:`);
    console.log(`  cause:         ${causeV === null ? 'null' : `"${causeV}"`}`);
    console.log(`  evidence:      ${causeE}`);
    console.log(`  whyProblem:    ${whyV === null ? 'null' : `"${whyV}"`}`);
    console.log(`  whatItAffects: ${whatV === null ? 'null' : `"${whatV}"`}`);
    if (batchLog.length) {
      batchLog.forEach(b => {
        if (b.causePatch)  console.log(`  [batch ${b.batch}] cause patch: "${b.causePatch.value}" conf=${b.causePatch.confidence}`);
        if (b.whyPatch)    console.log(`  [batch ${b.batch}] whyProblem patch: "${b.whyPatch.value}" conf=${b.whyPatch.confidence}`);
        if (b.whatPatch)   console.log(`  [batch ${b.batch}] whatItAffects patch: "${b.whatPatch.value}" conf=${b.whatPatch.confidence}`);
      });
    }
    console.log('');
  }

  const causeValues = [...new Set(col.cause.map(v => v === null ? 'null' : `"${v}"`))];
  console.log('─── Summary ─────────────────────────────────────────────────────────');
  console.log(`  cause unique values (${RUNS} runs): ${causeValues.join(' | ')}`);
  const nullCount = col.cause.filter(v => v === null).length;
  console.log(`  null: ${nullCount}/${RUNS}   non-null: ${RUNS - nullCount}/${RUNS}`);

  server.kill();
})().catch(e => { console.error(e); process.exit(1); });
