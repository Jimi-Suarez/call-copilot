#!/usr/bin/env node
// npm run gen-call -- --n 20 --seed 100
// Generates N discovery call transcripts (seed … seed+n-1) + answer keys.
// Saves to test/generated/<seed>.txt and <seed>.expected.json.
// Never overwrites existing files.
'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { confirmCost } = require('../lib/confirm');
const { buildCard, buildPrompt, buildExpected } = require('../lib/gen-card');

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Parse args
  let n = 1, startSeed = 100;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--n'    && args[i+1]) { n         = parseInt(args[i+1]); i++; }
    if (args[i] === '--seed' && args[i+1]) { startSeed = parseInt(args[i+1]); i++; }
  }
  if (isNaN(n) || n < 1)    { console.error('--n must be a positive integer'); process.exit(1); }
  if (isNaN(startSeed))     { console.error('--seed must be an integer');       process.exit(1); }

  const outDir = path.join(__dirname, '../test/generated');
  fs.mkdirSync(outDir, { recursive: true });

  // Which seeds need generating?
  const toGen = [];
  for (let i = 0; i < n; i++) {
    const seed    = startSeed + i;
    const txtPath = path.join(outDir, `${seed}.txt`);
    if (fs.existsSync(txtPath)) {
      console.log(`  skip  ${seed}.txt (already exists)`);
    } else {
      toGen.push(seed);
    }
  }

  if (toGen.length === 0) {
    console.log('All files already exist. Nothing to generate.');
    return;
  }

  // Cost estimate: claude-opus-4-7, ~4000 input + ~3500 output tokens per call
  const INPUT_PER_CALL  = 4000;
  const OUTPUT_PER_CALL = 3500;
  const INPUT_PRICE     = 0.000015;   // $15 / M tokens
  const OUTPUT_PRICE    = 0.000075;   // $75 / M tokens
  const estCost = toGen.length * (INPUT_PER_CALL * INPUT_PRICE + OUTPUT_PER_CALL * OUTPUT_PRICE);
  await confirmCost(
    `This makes ${toGen.length} API call${toGen.length !== 1 ? 's' : ''} to claude-opus-4-7 (~$${estCost.toFixed(2)}).`
  );

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let totalIn = 0, totalOut = 0, done = 0, errors = 0;

  for (const seed of toGen) {
    const card      = buildCard(seed);
    const prompt    = buildPrompt(card);
    const painLabel = card.pains.map(p => p.label).join(' + ') || 'none';
    process.stdout.write(`  [${++done}/${toGen.length}] seed ${seed}  pain: ${painLabel}  persona: ${card.persona} … `);

    let resp;
    try {
      resp = await client.messages.create({
        model:      'claude-opus-4-7',
        max_tokens: 5000,
        messages:   [{ role: 'user', content: prompt }],
      });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
      continue;
    }

    totalIn  += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;

    const text    = resp.content.find(b => b.type === 'text')?.text || '';
    const txMatch = text.match(/===TRANSCRIPT===([\s\S]*?)===END===/);
    if (!txMatch) {
      console.log('ERROR: could not parse transcript markers');
      errors++;
      continue;
    }
    const transcript = txMatch[1].trim();
    const lineCount  = transcript.split('\n').filter(l => l.match(/^\[/)).length;
    const expected   = buildExpected(card);

    fs.writeFileSync(path.join(outDir, `${seed}.txt`),           transcript + '\n');
    fs.writeFileSync(path.join(outDir, `${seed}.expected.json`), JSON.stringify(expected, null, 2) + '\n');

    console.log(`done  (${lineCount} lines, ${resp.usage.output_tokens} output tokens)`);
  }

  const actualCost = (totalIn * INPUT_PRICE + totalOut * OUTPUT_PRICE).toFixed(4);
  console.log(`\n${done - errors}/${done} generated.  API: ${totalIn.toLocaleString()} in + ${totalOut.toLocaleString()} out (~$${actualCost})`);
  if (errors) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
