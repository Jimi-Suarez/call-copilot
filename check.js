#!/usr/bin/env node
// npm run check — verifies environment keys and connectivity
require('dotenv').config();
const https = require('https');

let ok = 0, fail = 0;
function pass(msg) { console.log(`  PASS  ${msg}`); ok++; }
function warn(msg) { console.log(`  WARN  ${msg}`); fail++; }

// Anthropic key
if (process.env.ANTHROPIC_API_KEY) {
  pass('ANTHROPIC_API_KEY set');
} else {
  warn('ANTHROPIC_API_KEY not set — extraction will fail');
}

// Deepgram key
if (process.env.DEEPGRAM_API_KEY) {
  pass('DEEPGRAM_API_KEY set — live mic will use Deepgram');
} else {
  warn('DEEPGRAM_API_KEY not set — live mic will fall back to browser Speech API');
}

// Test Anthropic model availability
async function checkAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    await client.messages.create({
      model: process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'ping' }]
    });
    pass(`Anthropic API reachable (model: ${process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001'})`);
  } catch (e) {
    warn(`Anthropic API error: ${e.message}`);
  }
}

checkAnthropic().then(() => {
  console.log(`\n${ok + fail} checks: ${ok} OK, ${fail} warning(s)`);
  process.exit(fail > 0 ? 1 : 0);
});
