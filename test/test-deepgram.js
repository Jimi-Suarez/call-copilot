#!/usr/bin/env node
// Headless proof-of-concept: sends real speech through the /mic WebSocket proxy
// and verifies that Deepgram returns a transcript.
// Run with: npm run test:deepgram
'use strict';

const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const fs  = require('fs');
const path = require('path');

const DG_PORT  = 3097;
const TIMEOUT  = 20000;     // max wait for any transcript
const CHUNK_SAMPLES = 4096; // matches ScriptProcessor buffer size in app.js

// ── 1. Generate speech via macOS TTS ─────────────────────────────────────────
const AIFF = '/tmp/dg_test.aiff';
const WAV  = '/tmp/dg_test.wav';
const TEXT = 'testing one two three four five hello world';

function generateAudio() {
  console.log(`Generating speech: "${TEXT}"`);
  execSync(`say -o "${AIFF}" "${TEXT}"`);
  // Convert to 16-bit LE PCM, 16 kHz, mono WAV
  execSync(`afconvert "${AIFF}" -o "${WAV}" -d LEI16@16000 -c 1 -f WAVE`);
  const wavBuf = fs.readFileSync(WAV);
  // Strip 44-byte WAV header → raw PCM16
  const pcm = wavBuf.slice(44);
  console.log(`  Audio: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(2)}s at 16 kHz mono)`);
  return pcm;
}

// ── 2. Start server ───────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(DG_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => {
      const s = d.toString();
      if (s.includes('localhost:')) resolve(child);
    });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', reject);
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

// ── 3. Send audio and collect transcripts ─────────────────────────────────────
function runDeepgramTest(pcmBuf) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${DG_PORT}/mic`);
    const results = [];
    let ready = false;
    let chunkOffset = 0;
    let sendTimer = null;

    const deadline = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${TIMEOUT}ms — no transcript received`));
    }, TIMEOUT);

    ws.on('open', () => {
      console.log('  WS opened to /mic proxy');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'error') {
          clearTimeout(deadline);
          ws.close();
          reject(new Error(`Deepgram error: ${msg.message}`));
          return;
        }

        if (msg.type === 'ready') {
          console.log('  Deepgram upstream ready — streaming audio…');
          ready = true;
          sendNextChunk();
          return;
        }

        // Deepgram Results message
        if (msg.type === 'Results' && msg.is_final) {
          const text = msg.channel?.alternatives?.[0]?.transcript?.trim() || '';
          if (text) {
            results.push(text);
            console.log(`  ✓ transcript: "${text}"`);
          }
        }

        // speech_final = true means Deepgram finished the utterance; check if done
        if (msg.speech_final && chunkOffset >= pcmBuf.length) {
          clearTimeout(deadline);
          if (sendTimer) clearInterval(sendTimer);
          ws.close();
          resolve(results);
        }
      } catch {}
    });

    ws.on('close', () => {
      clearTimeout(deadline);
      if (sendTimer) clearInterval(sendTimer);
      resolve(results);
    });

    ws.on('error', (e) => {
      clearTimeout(deadline);
      reject(new Error(`WS error: ${e.message}`));
    });

    function sendNextChunk() {
      if (!ready) return;
      sendTimer = setInterval(() => {
        if (chunkOffset >= pcmBuf.length) {
          // Send CloseStream signal (empty binary frame = Deepgram end-of-stream)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(Buffer.alloc(0));
          }
          clearInterval(sendTimer);
          sendTimer = null;
          return;
        }
        const end    = Math.min(chunkOffset + CHUNK_SAMPLES * 2, pcmBuf.length);
        const chunk  = pcmBuf.slice(chunkOffset, end);
        chunkOffset  = end;
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      }, 256); // 4096 samples / 16000 Hz ≈ 256 ms per chunk
    }
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  let server;
  try {
    const pcm = generateAudio();

    console.log(`\nStarting server on port ${DG_PORT}…`);
    server = await startServer();
    console.log('  Server ready\n');

    console.log('Sending audio through /mic proxy…');
    const results = await runDeepgramTest(pcm);

    console.log('\n─────────────────────────────────────────');
    if (results.length === 0) {
      console.log('FAIL  no transcript returned');
      process.exitCode = 1;
    } else {
      console.log(`PASS  got ${results.length} transcript segment(s):`);
      results.forEach((r, i) => console.log(`  [${i + 1}] ${r}`));
    }
    console.log('─────────────────────────────────────────\n');

  } catch (err) {
    console.error('\nFAIL ', err.message);
    process.exitCode = 1;
  } finally {
    if (server) server.kill();
  }
})();
