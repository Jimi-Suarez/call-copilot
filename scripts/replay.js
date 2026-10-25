#!/usr/bin/env node
// Usage: npm run replay -- <call-name>
// E.g.:  npm run replay -- messy-call
// Prints final notes as JSON.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runCall, parseTranscript } = require('../lib/extractor');

const TEST_PORT = parseInt(process.env.REPLAY_PORT || '3098');
const BASE = `http://localhost:${TEST_PORT}`;

const callName = process.argv[2];
if (!callName) {
  console.error('Usage: npm run replay -- <call-name>  (e.g. messy-call or holdout/hospital-cfo-call)');
  process.exit(1);
}

// Resolve path: try test/ then test/holdout/
let txPath = path.join(__dirname, '..', 'test', callName + (callName.endsWith('.txt') ? '' : '.txt'));
if (!fs.existsSync(txPath)) {
  txPath = path.join(__dirname, '..', 'test', 'holdout', callName + (callName.endsWith('.txt') ? '' : '.txt'));
}
if (!fs.existsSync(txPath)) {
  console.error(`File not found: ${callName}`);
  process.exit(1);
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { if (d.toString().includes('localhost:')) resolve(child); });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', reject);
    setTimeout(() => reject(new Error('Server timeout')), 12000);
  });
}

async function waitReady(ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/samples`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server not ready');
}

(async () => {
  const server = await startServer();
  await waitReady();

  const text = fs.readFileSync(txPath, 'utf8');
  const utterances = parseTranscript(text);
  console.error(`Running ${utterances.length} utterances from ${path.basename(txPath)}…`);

  const { notes, objections } = await runCall(utterances, BASE, {
    onBatch: ({ patch }) => {
      if (patch.length) process.stderr.write(`.`);
    }
  });

  server.kill();
  process.stderr.write('\n');
  console.log(JSON.stringify({ notes, objections }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
