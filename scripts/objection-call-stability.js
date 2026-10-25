#!/usr/bin/env node
// Run objection-call extraction 10 times, show per-field variation.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { runCall, parseTranscript } = require('../lib/extractor');

const RUNS = 10;
const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { if (d.toString().includes('localhost:')) resolve(child); });
    child.stderr.on('data', d => { const s = d.toString(); if (!s.includes('[extract]')) process.stderr.write(d); });
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

async function main() {
  const server = await startServer();
  await waitReady();
  const txPath = path.join(__dirname, '../test/objection-call.txt');
  const text   = fs.readFileSync(txPath, 'utf8');
  const utts   = parseTranscript(text);

  const results = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  run ${i+1}/${RUNS}…`);
    const { notes } = await runCall(utts, BASE);
    const needs = notes.needs.filter(n => n.value);
    results.push({
      needsCount: needs.length,
      needsText: needs.map(n => n.value),
      pain: notes.pain.value,
      topNeed: notes.topNeed.value,
    });
    process.stdout.write(` needs=${needs.length}\n`);
  }

  server.kill();

  // Summarise
  console.log('\n━━ RESULTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const countDist = {};
  for (const r of results) {
    countDist[r.needsCount] = (countDist[r.needsCount] || 0) + 1;
  }
  console.log('needs.count distribution:', countDist);

  // Show all unique needs texts
  const allTexts = new Set(results.flatMap(r => r.needsText));
  console.log('\nAll unique need values seen:');
  for (const t of allTexts) console.log(' -', t);

  // Which runs had >2 needs?
  const highRuns = results.filter(r => r.needsCount > 2);
  if (highRuns.length > 0) {
    console.log('\nExtra needs seen (runs with >2 needs):');
    for (const r of highRuns) {
      const extra = r.needsText;
      console.log(' [' + r.needsCount + ']', extra.map(t => `"${t}"`).join(', '));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
