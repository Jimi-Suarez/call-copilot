'use strict';

// Shared incremental extraction pipeline — used by both npm test and npm run replay.
// Mirrors the browser's batching: flush every 12 utterances with at least 1 Her line,
// plus a forced final flush at end of call.
// Context window: utterances from the last 90 call-time seconds (up to 40).

function makeField() { return { value: null, evidence: [], confidence: 0, locked: false }; }

function createEmptyNotes() {
  return {
    situation: { hosts: makeField(), vms: makeField(), storageTB: makeField(), teamSize: makeField(), workloads: makeField() },
    painType: makeField(), pain: makeField(), whatItAffects: makeField(), whyProblem: makeField(),
    numbers: { paysNow: makeField(), quote: makeField(), canAbsorb: makeField() },
    deadline: makeField(), renewalDate: makeField(), doingNothing: makeField(),
    cause: makeField(), otherDrivers: makeField(), impactOnOthers: makeField(),
    personalStake: makeField(), signOff: makeField(), budget: makeField(),
    needs: [], topNeed: makeField(), needReason: makeField(),
    nextStep: { who: makeField(), purpose: makeField(), dateTime: makeField() },
    scratch: []
  };
}

function getField(notes, path) {
  const parts = path.split('.');
  let obj = notes;
  for (const p of parts) { if (obj == null) return null; obj = obj[p]; }
  return obj;
}

function applyPatch(notes, patch) {
  if (!Array.isArray(patch)) return;
  for (const item of patch) {
    const { field, value, evidence, confidence, isCorrection, painType } = item;
    if (!field) continue;
    if (field === 'needs') {
      if (value && String(value).trim()) {
        const dup = notes.needs.find(n => n.value && n.value.toLowerCase() === String(value).trim().toLowerCase());
        if (!dup) {
          notes.needs.push({ value: String(value).trim(), evidence: evidence || [], confidence: confidence || 0.8,
            locked: false, painType: painType || null, sourceTier: 'need', history: [] });
        }
      }
      continue;
    }
    if (/^needs\.\d+$/.test(field)) {
      const idx = parseInt(field.split('.')[1]);
      if (notes.needs[idx] && !notes.needs[idx].locked) {
        if (isCorrection) { notes.needs[idx].history = notes.needs[idx].history || []; notes.needs[idx].history.push({ value: notes.needs[idx].value, ts: Date.now() }); }
        if (value !== null && value !== undefined) notes.needs[idx].value = String(value);
      }
      continue;
    }
    if (/^needs\.\d+\.painType$/.test(field)) {
      const idx = parseInt(field.split('.')[1]);
      if (notes.needs[idx]) notes.needs[idx].painType = value || null;
      continue;
    }
    if (field === 'scratch') {
      // Strip uXXX IDs from display value
      const raw = String(value || '').trim();
      const clean = raw.replace(/\bu\d{3}\b/gi, '').replace(/\s{2,}/g, ' ').trim();
      if (!clean) continue;
      const prefix = clean.toLowerCase().slice(0, 25);
      const dup = notes.scratch.find(s => s.value.toLowerCase().slice(0, 25) === prefix);
      if (!dup) notes.scratch.push({ value: clean, evidence: evidence || [], parkNote: item.parkNote || '', ts: '' });
      continue;
    }
    const f = getField(notes, field);
    if (!f || typeof f !== 'object' || !('value' in f)) continue;
    if (f.locked) continue;
    if (value !== null && value !== undefined && value !== '') {
      if (isCorrection) { f.history = f.history || []; f.history.push({ value: f.value, ts: Date.now() }); }
      f.value = value;
      f.evidence = evidence || [];
      f.confidence = confidence || 0.5;
    }
  }
}

function tsToSec(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const [m, s] = ts.split(':').map(Number);
  return (m || 0) * 60 + (s || 0);
}

// Run a full incremental call through /extract.
// utterances: array of { id, ts, speaker, text }
// baseUrl: e.g. 'http://localhost:3099'
// opts.onBatch: optional callback(batchResult) after each flush
async function runCall(utterances, baseUrl, opts = {}) {
  const { onBatch } = opts;
  const notes = createEmptyNotes();
  const allObjDetected = [];
  let buffer = [];
  let processed = [];
  let callCount = 0, totalInputTokens = 0, totalOutputTokens = 0;

  async function flush() {
    if (buffer.length === 0) return;
    const herLines = buffer.filter(u => u.speaker === 'Her');
    if (herLines.length === 0) {
      // No Her lines — move buffer to processed without extracting
      processed.push(...buffer);
      buffer = [];
      return;
    }

    // Context window: last 300 seconds (5 min) of call time, up to 40 utterances
    const lastTs = processed.length > 0 ? processed[processed.length - 1].ts : '00:00';
    const lastSec = tsToSec(lastTs);
    const windowStart = lastSec - 300;
    const context = processed.filter(u => tsToSec(u.ts) >= windowStart).slice(-40);
    const fullSummary = context.length > 0
      ? context.map(u => `[${u.ts}] ${u.id} ${u.speaker}: ${u.text}`).join('\n')
      : '';
    const recent = buffer.map(u => `[${u.ts}] ${u.id} ${u.speaker}: ${u.text}`).join('\n');

    let data = { patch: [], objections: [] };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(`${baseUrl}/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes, recentTranscript: recent, fullSummary })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw = await resp.json();
        if (!Array.isArray(raw.patch)) {
          lastErr = new Error(`patch not array (attempt ${attempt + 1})`);
          continue;
        }
        data = raw;
        callCount++;
        if (raw.tokenUsage) {
          totalInputTokens  += raw.tokenUsage.inputTokens  || 0;
          totalOutputTokens += raw.tokenUsage.outputTokens || 0;
        }
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      }
    }
    if (lastErr && !data.patch.length) throw lastErr;

    if (data.patch.length > 0) applyPatch(notes, data.patch);
    if (data.objections && data.objections.length > 0) allObjDetected.push(...data.objections);

    if (onBatch) onBatch({ notes, patch: data.patch, objections: data.objections || [] });

    processed.push(...buffer);
    buffer = [];
  }

  for (const utt of utterances) {
    buffer.push(utt);
    const hasHer = buffer.some(u => u.speaker === 'Her');
    if (hasHer && buffer.length >= 12) {
      await flush();
    }
  }
  await flush(); // final flush

  return { notes, objections: allObjDetected, callCount, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

function parseTranscript(text) {
  const utterances = [];
  let id = 1;
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^\[(\d{2}:\d{2})\]\s+(Me|Her):\s+(.+)$/);
    if (m) utterances.push({ id: `u${String(id++).padStart(3,'0')}`, ts: m[1], speaker: m[2], text: m[3].trim().replace(/\*[^*]+\*/g, '').replace(/\s{2,}/g, ' ').trim() });
  }
  return utterances;
}

function fv(notes, path) { const f = getField(notes, path); return f ? f.value : undefined; }

module.exports = { runCall, createEmptyNotes, applyPatch, getField, parseTranscript, fv };
