#!/usr/bin/env node
// npm test — incremental pipeline matching the browser, with holdout checks.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { runCall, createEmptyNotes, parseTranscript, fv } = require('../lib/extractor');
const CoachLogic   = require('../public/coach-logic.js');
const SummaryLogic = require('../public/summary-logic.js');

const TEST_PORT = parseInt(process.env.TEST_PORT || '3099');
const BASE = `http://localhost:${TEST_PORT}`;

const PAIN_TYPE_KEYS = [
  'No tested fallback', 'Migration risk / downtime', 'CFO needs numbers',
  'Renewal cost shock', 'Small team capacity', 'Storage end of support',
  'Servers and storage as two worlds', 'Clinical uptime / patient safety',
  'Board wants less single-vendor risk', 'Compliance / patient data',
  'Paying for a suite we don\'t use'
];

// ── Server lifecycle ──────────────────────────────────────────────────────────
function startServer() {
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

// ── Assertion helpers ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, message, detail = '') {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.log(`  FAIL  ${message}${detail ? ' — ' + detail : ''}`); failed++; }
}
function isPainTypeKey(v) { return typeof v === 'string' && PAIN_TYPE_KEYS.includes(v); }
function noYear(v) { return typeof v === 'string' && !/20\d{2}/.test(v); }
function contains(v, sub) { return typeof v === 'string' && v.toLowerCase().includes(sub.toLowerCase()); }

function runCallFromFile(filename) {
  const txPath = path.join(__dirname, filename);
  const text = fs.readFileSync(txPath, 'utf8');
  return runCall(parseTranscript(text), BASE);
}

const apiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
function acc(resultPromise) {
  return resultPromise.then(r => {
    apiUsage.calls        += r.callCount    || 0;
    apiUsage.inputTokens  += r.inputTokens  || 0;
    apiUsage.outputTokens += r.outputTokens || 0;
    return r;
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function runTests() {
  let server;
  try {
    console.log(`\nStarting test server on port ${TEST_PORT}…`);
    server = await startServer();
    await waitReady();
    console.log('Server ready.\n');
  } catch (e) {
    console.error('Could not start server:', e.message);
    process.exit(1);
  }

  // ── TIDY CALL ──────────────────────────────────────────────────────────────
  console.log('━━ tidy-call.txt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  let notes, objections;
  try {
    ({ notes, objections } = await acc(runCallFromFile('tidy-call.txt')));
    const n = notes.numbers;

    assert(n.paysNow.value === 400000, 'numbers.paysNow = 400000', `got ${n.paysNow.value}`);
    assert(n.quote.value === 900000,   'numbers.quote = 900000',   `got ${n.quote.value}`);
    assert(n.canAbsorb.value === 600000,'numbers.canAbsorb = 600000',`got ${n.canAbsorb.value}`);

    assert(!!fv(notes, 'deadline'),    'deadline filled');
    assert(noYear(fv(notes, 'deadline')), 'deadline has no invented year', `got "${fv(notes,'deadline')}"`);

    assert(!!fv(notes, 'renewalDate'), 'renewalDate filled');
    const rd = String(fv(notes, 'renewalDate') || '').toLowerCase();
    assert(rd.includes('july') || rd.includes('mid'), 'renewalDate is her correction (mid-July)', `got "${fv(notes,'renewalDate')}"`);

    assert(!!fv(notes, 'pain'),       'pain filled');
    assert(!isPainTypeKey(fv(notes, 'pain')), 'pain uses her words, not a painType key', `got "${fv(notes,'pain')}"`);

    assert(!!fv(notes, 'cause'),      'cause filled');
    assert(!isPainTypeKey(fv(notes, 'cause')), 'cause uses her words', `got "${fv(notes,'cause')}"`);

    assert(!!fv(notes, 'otherDrivers'), 'otherDrivers filled');
    assert(!!fv(notes, 'whatItAffects'), 'whatItAffects filled');
    assert(!!fv(notes, 'whyProblem'),   'whyProblem filled');

    const needCount = notes.needs.filter(nd => nd.value).length;
    assert(needCount >= 2, `needs.length >= 2 (got ${needCount})`);
    assert(!!fv(notes, 'topNeed'), 'topNeed filled');

    // Nutanix intro was in transcript
    const meLower = parseTranscript(fs.readFileSync(path.join(__dirname, 'tidy-call.txt'), 'utf8'))
      .filter(u => u.speaker === 'Me').map(u => u.text.toLowerCase());
    const nutanixInTranscript = meLower.some(t => t.includes('nutanix') || t.includes('can i try'));
    assert(nutanixInTranscript, 'Nutanix pitch in tidy-call transcript');

    // Downtime objection detected (she raised it in transcript)
    const objKeys = objections.map(o => o.matchedKey);
    assert(objKeys.includes('downtime'), 'downtime objection detected in tidy-call', `got: ${objKeys.join(',')}`);

    console.log(`  (needs: ${notes.needs.map(nd => '"'+nd.value+'"').join(', ')})`);
    console.log(`  (topNeed: ${fv(notes,'topNeed')}, objections: ${objections.map(o=>o.matchedKey).join(',')})`);
  } catch (e) { console.error('  ERROR running tidy-call:', e.message); }

  // ── MESSY CALL ─────────────────────────────────────────────────────────────
  console.log('\n━━ messy-call.txt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    ({ notes, objections } = await acc(runCallFromFile('messy-call.txt')));
    const n = notes.numbers;

    assert(n.paysNow.value === 400000, 'numbers.paysNow = 400000', `got ${n.paysNow.value}`);
    assert(n.quote.value === 850000, 'numbers.quote = 850000 (corrected)', `got ${n.quote.value}`);
    assert(n.canAbsorb.value === 600000,'numbers.canAbsorb = 600000', `got ${n.canAbsorb.value}`);

    const dl = String(fv(notes, 'deadline') || '').toLowerCase();
    assert(dl.includes('february') || dl.includes('feb'), 'deadline contains "February"', `got "${fv(notes,'deadline')}"`);
    assert(noYear(fv(notes, 'deadline')), 'deadline has no invented year');

    // Pain must come from [04:55] "renewal quote, more than double" NOT from [00:30] question
    const pain = String(fv(notes, 'pain') || '').toLowerCase();
    assert(!!fv(notes, 'pain'), 'pain filled');
    assert(!isPainTypeKey(fv(notes, 'pain')), 'pain uses her words', `got "${fv(notes,'pain')}"`);
    assert(!pain.includes('finance asking') && !pain.includes('typically cost'),
      'pain is from [04:55] answer, not [00:30] question', `got "${fv(notes,'pain')}"`);
    assert(pain.includes('renewal') || pain.includes('double') || pain.includes('quote'),
      'pain contains renewal/double/quote (from [04:55])', `got "${fv(notes,'pain')}"`);

    assert(!!fv(notes, 'cause'),      'cause filled');
    assert(!isPainTypeKey(fv(notes, 'cause')), 'cause uses her words');

    const needCount = notes.needs.filter(nd => nd.value).length;
    assert(needCount >= 1 && needCount <= 3, `needs count 1–3 (got ${needCount})`);
    assert(needCount === 2, 'needs count exactly 2 (comparison + migration plan)', `got ${needCount}`);

    // Needs must come from explicit "I need" / "we need" statements
    const needTexts = notes.needs.map(nd => (nd.value || '').toLowerCase());
    assert(!needTexts.some(t => t.includes('understand options')), 'needs: no hallucinated "understand options"', `got: ${needTexts.join('|')}`);
    assert(!needTexts.some(t => t.includes('retraining path')), 'needs: no hallucinated "retraining path"', `got: ${needTexts.join('|')}`);
    assert(needTexts.some(t => t.includes('comparison') || t.includes('numbers') || t.includes('alternative')),
      'needs[0] is a comparison/numbers need from her words');
    assert(needTexts.some(t => t.includes('migration') || t.includes('patient systems')),
      'needs[1] is a migration need from her words');

    assert(fv(notes,'topNeed') === 2, 'topNeed = 2 (migration)', `got ${fv(notes,'topNeed')}`);

    // nextStep filled from the final utterances
    assert(!!fv(notes,'nextStep.who'), 'nextStep.who filled');
    const nsdt = String(fv(notes,'nextStep.dateTime') || '').toLowerCase();
    assert(nsdt.includes('december') || nsdt.includes('january') || nsdt.includes('week'),
      'nextStep.dateTime has Dec/Jan/week', `got "${fv(notes,'nextStep.dateTime')}"`);
    const nsp = String(fv(notes,'nextStep.purpose') || '').toLowerCase();
    assert(nsp.includes('working') || nsp.includes('session'),
      'nextStep.purpose = working session', `got "${fv(notes,'nextStep.purpose')}"`);

    // Fix 6: nextStep.who uses "her"/"she" for prospect, not "me"
    const who = String(fv(notes, 'nextStep.who') || '').toLowerCase();
    assert(who.includes('her') || who.includes('she'), 'nextStep.who uses "her" for prospect', `got "${fv(notes,'nextStep.who')}"`);
    assert(who.includes('sarah'), 'nextStep.who includes Sarah (compliance)', `got "${fv(notes,'nextStep.who')}"`);
    assert(!who.includes('cfo'), 'nextStep.who does NOT include CFO', `got "${fv(notes,'nextStep.who')}"`);

    assert(!!fv(notes,'nextStep.dateTime'), 'nextStep.dateTime filled (last utterances extracted)');

    // close line should use nextStep.dateTime (not deadline) — tested via next step
    const sessionDate = String(fv(notes,'nextStep.dateTime') || '').toLowerCase();
    assert(sessionDate.includes('december') || sessionDate.includes('january') || sessionDate.includes('week'),
      'close line inputs: nextStep.dateTime has session date (Dec/Jan/week)');

    const nr = String(fv(notes,'needReason') || '').toLowerCase();
    assert(nr.includes('migration') || nr.includes('safe') || nr.includes("numbers don't"),
      'needReason is why migration matters', `got "${fv(notes,'needReason')}"`);

    // Scratch has no brackets/IDs
    const hasBrackets = notes.scratch.some(s => /[\[\(]/.test(s.value));
    assert(!hasBrackets, 'scratch values have no brackets', `found: "${notes.scratch.find(s => /[\[\(]/.test(s.value))?.value}"`);
    const hasUttId = notes.scratch.some(s => /\bu\d{3}\b/i.test(s.value));
    assert(!hasUttId, 'scratch values have no utterance IDs (uXXX)');
    assert(notes.scratch.length >= 1, `holiday tangent parked in scratch (got ${notes.scratch.length} items)`);

    // doingNothing
    const dn = String(fv(notes,'doingNothing') || '').toLowerCase();
    assert(dn.includes('850') || dn.includes('sign') || dn.includes('refresh'),
      'doingNothing filled with her words', `got "${fv(notes,'doingNothing')}"`);

    // painType from pain field (Renewal cost shock)
    const pt = fv(notes, 'painType');
    assert(isPainTypeKey(pt), `painType is a valid lookup key (got "${pt}")`);
    assert(pt === 'Renewal cost shock', `painType = "Renewal cost shock" (from pain, not needs)`, `got "${pt}"`);

    // budget keeps her words
    const bv = String(fv(notes, 'budget') || '');
    assert(bv.length > 0, 'budget field filled');
    assert(/[a-z]/i.test(bv), 'budget contains words (not just a number)', `got "${bv}"`);

    // shortQuote helper test
    { function shortQuoteTest(text, maxWords = 8) {
        if (!text) return '""';
        const words = text.split(/\s+/);
        if (words.length <= maxWords) return `"${text}"`;
        let cutAt = maxWords;
        for (let i = maxWords - 1; i >= 3; i--) {
          const prev = words[i - 1] || '';
          if (prev.endsWith(',') || prev.endsWith(';')) { cutAt = i; break; }
          if (/^(and|or|but|so|that|which|without|before|if|when)$/i.test(words[i] || '')) { cutAt = i; break; }
        }
        return `"${words.slice(0, cutAt).join(' ')}"`;
      }
      const sq = shortQuoteTest('renewal quote has come in at more than double what we pay now');
      assert(!sq.includes('…'), 'shortQuote does not use ellipsis', `got ${sq}`);
      assert(sq.startsWith('"') && sq.endsWith('"'), 'shortQuote is wrapped in quotes'); }

    // Objections: downtime from after pitch, NOT discovery worry
    const objKeys = objections.map(o => o.matchedKey);
    assert(objKeys.includes('downtime'), 'downtime objection detected (post-pitch only)', `got: ${objKeys.join(',')}`);
    // discovery worry at [13:30] must NOT be in objections
    const obj1330 = objections.find(o => o.quote && o.quote.toLowerCase().includes('patient systems going down'));
    assert(!obj1330 || (obj1330 && objKeys.indexOf(obj1330.matchedKey) === objKeys.indexOf('downtime')),
      'discovery worry at [13:30] not flagged as separate objection');

    console.log(`  (needs: ${notes.needs.map(nd => '"'+nd.value+'"').join(', ')})`);
    console.log(`  (topNeed: ${fv(notes,'topNeed')}, nextStep.dateTime: "${fv(notes,'nextStep.dateTime')}")`);
    console.log(`  (needReason: "${fv(notes,'needReason')}", pain: "${fv(notes,'pain')}")`);
    console.log(`  (objections: ${objections.map(o=>o.matchedKey).join(', ')})`);
  } catch (e) { console.error('  ERROR running messy-call:', e.message); }

  // ── THIN CALL ──────────────────────────────────────────────────────────────
  console.log('\n━━ thin-call.txt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    ({ notes, objections } = await acc(runCallFromFile('thin-call.txt')));
    const n = notes.numbers;

    assert(n.paysNow.value === 280000, 'numbers.paysNow = 280000', `got ${n.paysNow.value}`);
    assert(n.quote.value === 600000,   'numbers.quote = 600000',   `got ${n.quote.value}`);

    assert(fv(notes,'renewalDate') === null, 'renewalDate = null (never mentioned)', `got "${fv(notes,'renewalDate')}"`);

    const dl = String(fv(notes, 'deadline') || '').toLowerCase();
    assert(dl.includes('march'), 'deadline contains "March"', `got "${fv(notes,'deadline')}"`);

    const needCount = notes.needs.filter(nd => nd.value).length;
    assert(needCount === 1, 'exactly 1 need', `got ${needCount}`);

    assert(!!fv(notes,'pain'), 'pain filled');
    assert(!isPainTypeKey(fv(notes,'pain')), 'pain uses her words', `got "${fv(notes,'pain')}"`);

    // cost objection from thin-call (she challenged "is it actually cheaper")
    const objKeys = objections.map(o => o.matchedKey);
    assert(objKeys.includes('cost'), 'cost objection detected in thin-call', `got: ${objKeys.join(',')}`);

    console.log(`  (needs: ${notes.needs.map(nd => '"'+nd.value+'"').join(', ')})`);
    console.log(`  (pain: "${fv(notes,'pain')}", painType: "${fv(notes,'painType')}")`);
    console.log(`  (objections: ${objections.map(o=>o.matchedKey).join(', ')})`);
  } catch (e) { console.error('  ERROR running thin-call:', e.message); }

  // ── OBJECTION CALL ─────────────────────────────────────────────────────────
  console.log('\n━━ objection-call.txt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    ({ notes, objections } = await acc(runCallFromFile('objection-call.txt')));
    assert(objections.length >= 3, `at least 3 objections detected (got ${objections.length})`, objections.map(o=>o.matchedKey).join(', '));
    const objKeys = objections.map(o => o.matchedKey);
    assert(objKeys.includes('downtime'), 'downtime objection detected');
    assert(objKeys.includes('retraining'), 'retraining objection detected');
    assert(objKeys.includes('cost'), 'cost objection detected');
    const marketQ = objections.find(o => o.quote && o.quote.toLowerCase().includes('market position'));
    assert(!marketQ, 'normal market position question NOT flagged as objection');
    console.log(`  (objections: ${objections.map(o => o.matchedKey + '="' + (o.quote||'').slice(0,30) + '"').join(', ')})`);
  } catch (e) { console.error('  ERROR running objection-call:', e.message); }

  // ── LOCK ENFORCEMENT ───────────────────────────────────────────────────────
  console.log('\n━━ lock enforcement ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const { createEmptyNotes: cen } = require('../lib/extractor');
    const lockedNotes = cen();
    lockedNotes.cause.value  = 'Broadcom licensing change';
    lockedNotes.cause.locked = true;
    const resp = await fetch(`${BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: lockedNotes,
        recentTranscript: '[05:00] u001 Her: The real reason is just internal budget pressure, nothing to do with the licensing.',
        fullSummary: ''
      })
    });
    const data = await resp.json();
    const { applyPatch: ap } = require('../lib/extractor');
    ap(lockedNotes, data.patch || []);
    assert(lockedNotes.cause.value === 'Broadcom licensing change', 'locked cause not overwritten');
  } catch (e) { console.error('  ERROR in lock test:', e.message); }

  // ── HOLDOUT CALLS ──────────────────────────────────────────────────────────
  const holdoutDir = path.join(__dirname, 'holdout');
  const holdoutFiles = fs.readdirSync(holdoutDir).filter(f => f.endsWith('.txt'));

  for (const fname of holdoutFiles) {
    const callLabel = fname.replace('.txt', '');
    const expectedPath = path.join(holdoutDir, callLabel + '.expected.json');
    if (!fs.existsSync(expectedPath)) continue;
    const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

    console.log(`\n━━ holdout/${callLabel} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    try {
      const text = fs.readFileSync(path.join(holdoutDir, fname), 'utf8');
      const utterances = parseTranscript(text);
      let hNotes, hObjs;
      ({ notes: hNotes, objections: hObjs } = await acc(runCall(utterances, BASE)));

      // numbers
      if (expected.numbers) {
        const en = expected.numbers;
        const hn = hNotes.numbers;
        if (en.paysNow !== undefined) assert(hn.paysNow.value === en.paysNow, `paysNow = ${en.paysNow}`, `got ${hn.paysNow.value}`);
        if (en.quote !== undefined)   assert(hn.quote.value === en.quote,     `quote = ${en.quote}`,     `got ${hn.quote.value}`);
        if (en.canAbsorb !== undefined) {
          // canAbsorb 0 is a valid value (not null)
          const canA = hn.canAbsorb.value;
          assert(canA === en.canAbsorb, `canAbsorb = ${en.canAbsorb}`, `got ${canA}`);
        }
      }

      // renewalDate null check
      if (expected.renewalDate === null) {
        assert(fv(hNotes,'renewalDate') === null, 'renewalDate = null', `got "${fv(hNotes,'renewalDate')}"`);
      }

      // field contains checks
      if (expected.contains) {
        for (const [fieldPath, sub] of Object.entries(expected.contains)) {
          const v = String(fv(hNotes, fieldPath) || '').toLowerCase();
          assert(v.includes(sub.toLowerCase()), `${fieldPath} contains "${sub}"`, `got "${fv(hNotes, fieldPath)}"`);
        }
      }

      // painType must be in the acceptable set
      if (expected.painTypeIn) {
        const pt = fv(hNotes, 'painType');
        assert(expected.painTypeIn.includes(pt), `painType in [${expected.painTypeIn.join(', ')}]`, `got "${pt}"`);
      }

      // needs count
      const hNeedCount = hNotes.needs.filter(nd => nd.value).length;
      if (expected.needsCount !== undefined) {
        assert(hNeedCount === expected.needsCount, `needs count = ${expected.needsCount}`, `got ${hNeedCount}`);
      }

      // needs contain substrings
      if (expected.needsContain) {
        const needTexts = hNotes.needs.map(nd => (nd.value || '').toLowerCase());
        for (const sub of expected.needsContain) {
          assert(needTexts.some(t => t.includes(sub.toLowerCase())),
            `a need contains "${sub}"`, `needs: ${needTexts.join(' | ')}`);
        }
      }

      // topNeed
      if (expected.topNeed) {
        const topIdx = (fv(hNotes,'topNeed') || 1) - 1;
        const topText = (hNotes.needs[topIdx]?.value || '').toLowerCase();
        assert(topText.includes(expected.topNeed.toLowerCase()),
          `topNeed contains "${expected.topNeed}"`, `got "${topText}"`);
      }

      // needReason
      if (expected.needReasonContains) {
        const nr = String(fv(hNotes,'needReason') || '').toLowerCase();
        assert(nr.includes(expected.needReasonContains.toLowerCase()),
          `needReason contains "${expected.needReasonContains}"`, `got "${nr}"`);
      }

      // personalStake
      if (expected.personalStakeContains) {
        const ps = String(fv(hNotes,'personalStake') || '').toLowerCase();
        assert(ps.includes(expected.personalStakeContains.toLowerCase()),
          `personalStake contains "${expected.personalStakeContains}"`, `got "${ps}"`);
      }

      // scratch
      if (expected.scratch) {
        for (const sub of expected.scratch) {
          const found = hNotes.scratch.some(s => s.value.toLowerCase().includes(sub.toLowerCase()));
          assert(found, `scratch contains "${sub}"`);
        }
      }

      // objections — skip if expected.objections is a string (means "none expected as objections")
      if (expected.objections && Array.isArray(expected.objections)) {
        for (const exp of expected.objections) {
          const found = hObjs.some(o => o.quote.toLowerCase().includes(exp.match.toLowerCase()));
          assert(found, `objection detected: "${exp.match}"`, `detected: ${hObjs.map(o=>o.quote.slice(0,30)).join(' | ')}`);
        }
      }

      // nextStep
      if (expected.nextStep) {
        const ns = expected.nextStep;
        if (ns.whoContains) {
          const who = String(fv(hNotes,'nextStep.who') || '').toLowerCase();
          for (const sub of ns.whoContains) {
            assert(who.includes(sub.toLowerCase()), `nextStep.who contains "${sub}"`, `got "${who}"`);
          }
        }
        if (ns.dateTimeContains) {
          const dt = String(fv(hNotes,'nextStep.dateTime') || '').toLowerCase();
          for (const sub of ns.dateTimeContains) {
            assert(dt.includes(sub.toLowerCase()), `nextStep.dateTime contains "${sub}"`, `got "${dt}"`);
          }
        }
        if (ns.purposeContains) {
          const pur = String(fv(hNotes,'nextStep.purpose') || '').toLowerCase();
          assert(pur.includes(ns.purposeContains.toLowerCase()), `nextStep.purpose contains "${ns.purposeContains}"`, `got "${pur}"`);
        }
      }

      console.log(`  (pain: "${fv(hNotes,'pain')}", painType: "${fv(hNotes,'painType')}")`);
      console.log(`  (needs: ${hNotes.needs.map(nd => '"'+nd.value+'"').join(', ')})`);
      console.log(`  (topNeed: ${fv(hNotes,'topNeed')}, nextStep.who: "${fv(hNotes,'nextStep.who')}")`);
    } catch (e) { console.error(`  ERROR running ${callLabel}:`, e.message); }
  }

  // ── needsSimilar dedup ─────────────────────────────────────────────────────
  console.log('\n━━ needsSimilar dedup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    // Inline copy of the function from public/app.js — if it drifts, the test will fail.
    const stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','our','we','i','is','are','be','have','has','need','needs']);
    const wordsOf = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
    function needsSimilar(a, b) {
      const wa = new Set(wordsOf(a));
      const wb = new Set(wordsOf(b));
      const inter = [...wa].filter(w => wb.has(w)).length;
      const union = new Set([...wa, ...wb]).size;
      return union > 0 && inter / union >= 0.4;
    }

    // Two genuinely different needs sharing only "migration" must NOT merge
    assert(!needsSimilar(
      'migration plan',
      'migration windows agreed with the clinical team'
    ), 'needsSimilar: "migration plan" vs "migration windows agreed…" are NOT merged');

    // Same need restated must merge (positive control)
    assert(needsSimilar(
      'migration plan',
      'migration plan that keeps patient systems up'
    ), 'needsSimilar: "migration plan" vs "migration plan that keeps patient systems up" IS merged');

    // Unrelated needs must not merge
    assert(!needsSimilar(
      'side-by-side cost comparison',
      'migration windows agreed with the clinical team'
    ), 'needsSimilar: unrelated needs are NOT merged');
  }

  // ── shortQuote trailing punctuation ───────────────────────────────────────
  console.log('\n━━ shortQuote trailing punctuation ━━━━━━━━━━━━━━━━━━');
  {
    // Inline copy from public/app.js
    function shortQuote(text, maxWords = 8) {
      if (!text) return '""';
      const words = text.split(/\s+/);
      const clean = s => s.replace(/[\s—–\-,;:]+$/, '').trim();
      if (words.length <= maxWords) return `"${clean(text)}"`;
      let cutAt = maxWords;
      for (let i = maxWords - 1; i >= 3; i--) {
        const prev = words[i - 1] || '';
        if (prev.endsWith(',') || prev.endsWith(';')) { cutAt = i; break; }
        if (/^(and|or|but|so|that|which|without|before|if|when)$/i.test(words[i] || '')) { cutAt = i; break; }
      }
      return `"${clean(words.slice(0, cutAt).join(' '))}"`;
    }

    const q1 = shortQuote('alternative on the table with real numbers — proper comparison');
    assert(!q1.endsWith('—"') && !q1.endsWith('-"') && !q1.endsWith(',"'),
      `shortQuote: truncated quote does not end with punctuation (got ${q1})`);

    const q2 = shortQuote('text ending with a dash —');
    assert(!q2.endsWith('—"') && !q2.endsWith('-"'),
      `shortQuote: full-length quote does not end with dash (got ${q2})`);

    const q3 = shortQuote('short text');
    assert(q3 === '"short text"', `shortQuote: short text unchanged (got ${q3})`);
  }

  // ── Coach: stage-direction stripping ────────────────────────────────────────
  console.log('\n━━ Stage direction stripping ━━━━━━━━━━━━━━━━━━━━━━━━');

  function parseTranscriptTestHelper(text) {
    const lines = text.split('\n');
    const utterances = [];
    let id = 1;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^\[(\d{2}:\d{2})\]\s+(Me|Her):\s+(.+)$/);
      if (m) {
        const rawText = m[3].trim().replace(/\*[^*]+\*/g, '').replace(/\s{2,}/g, ' ').trim();
        utterances.push({
          id: `u${String(id).padStart(3,'0')}`,
          ts: m[1], speaker: m[2],
          text: m[2] === 'Her' ? CoachLogic.stripStageDirections(rawText) : rawText
        });
        id++;
      }
    }
    return utterances;
  }

  {
    const txt = `[04:00] Her: *She pauses.* The renewal is in February.\n[04:30] Me: *A beat.* Understood.`;
    const utts = parseTranscriptTestHelper(txt);
    assert(utts[0].text === 'The renewal is in February.',
      `stage direction stripped from Her line (got "${utts[0].text}")`);
    assert(utts[1].text === 'Understood.',
      `stage direction stripped from Me line (got "${utts[1].text}")`);
  }

  {
    const txt = `[05:00] Her: I need an alternative on the table.`;
    const utts = parseTranscriptTestHelper(txt);
    assert(utts[0].text === 'I need an alternative on the table.',
      `line without stage direction unchanged (got "${utts[0].text}")`);
  }

  // ── Unbracketed stage direction stripping (CoachLogic.stripStageDirections) ──
  const sd = CoachLogic.stripStageDirections.bind(CoachLogic);
  // Positive — must be stripped to empty
  assert(sd('A short exhale') === '',   'stripSD: "A short exhale" → empty');
  assert(sd('A pause') === '',           'stripSD: "A pause" → empty');
  assert(sd('A beat') === '',            'stripSD: "A beat" → empty');
  assert(sd('A small frown') === '',     'stripSD: "A small frown" → empty');
  assert(sd('Slightly roundabout') === '','stripSD: "Slightly roundabout" → empty');
  assert(sd('A long pause') === '',      'stripSD: "A long pause" → empty');
  assert(sd('Okay. Good. Stop.') === '', 'stripSD: sentinel → empty');
  // Inline — stage direction prefix stripped, real content kept
  {
    const r = sd('A small frown. Yes, that\'s right.');
    assert(r === "Yes, that's right.", `stripSD inline: kept real content (got "${r}")`);
  }
  // Negative — must NOT be stripped
  assert(sd('A beat of downtime would cost us') === 'A beat of downtime would cost us',
    'stripSD: "A beat of downtime would cost us" → unchanged');
  assert(sd('A pause in the service is a risk') === 'A pause in the service is a risk',
    'stripSD: "A pause in the service is a risk" → unchanged');
  assert(sd("Yes. That's fine.") === "Yes. That's fine.",
    'stripSD: "Yes. That\'s fine." → unchanged');

  // ── Coach: computeCoachNext (uses CoachLogic directly — no inline copy) ──────
  console.log('\n━━ Coach: computeCoachNext filters already-asked questions ━━━━━━━━━━━━');

  // Mock state: after batch 1 of messy-call (pain partial, situation done, numbers done)
  // Me asked "What did the reseller say that kicked this off for you?" at 04:30
  function _makeField(v) { return { value: v, evidence: [], confidence: v ? 0.8 : 0, locked: false }; }
  const mockNotes = {
    situation: { hosts: _makeField(12), vms: _makeField(400), storageTB: _makeField(150), teamSize: _makeField(5), workloads: _makeField(null) },
    painType: _makeField('Renewal cost shock'),
    pain: _makeField('renewal quote more than double'),
    whatItAffects: _makeField(null), whyProblem: _makeField(null),
    numbers: { paysNow: _makeField(400000), quote: _makeField(850000), canAbsorb: _makeField(600000) },
    deadline: _makeField(null), renewalDate: _makeField(null), doingNothing: _makeField(null),
    cause: _makeField(null), otherDrivers: _makeField(null), impactOnOthers: _makeField(null),
    personalStake: _makeField(null), signOff: _makeField(null), budget: _makeField(null),
    needs: [], topNeed: _makeField(null), needReason: _makeField(null),
    nextStep: { who: _makeField(null), purpose: _makeField(null), dateTime: _makeField(null) },
    scratch: []
  };
  const mockTranscript = [
    { id:'u011', ts:'04:30', speaker:'Me', text:'What did the reseller say that kicked this off for you?' },
    { id:'u012', ts:'04:55', speaker:'Her', text:'The renewal quote. More than double. That was the moment.' },
  ];

  const coachResult = CoachLogic.computeCoachNext(mockNotes, mockTranscript, null);
  assert(coachResult.mainQ !== null, 'coach returns a main question after batch 1');
  assert(
    !coachResult.mainQ.toLowerCase().includes('reseller'),
    `coach main question at 04:31 is NOT "What did the reseller say..." (got: "${coachResult.mainQ}")`
  );

  {
    // After full messy-call, pain should show partial/done, needs should be >= 2
    const fullNotes = {
      situation: { hosts: _makeField(12), vms: _makeField(400), storageTB: _makeField(150), teamSize: _makeField(5), workloads: _makeField('clinical systems') },
      painType: _makeField('Renewal cost shock'),
      pain: _makeField('renewal quote more than double'),
      whatItAffects: _makeField('clinical systems refresh pushed back 18 months'),
      whyProblem: _makeField('CFO needs alternatives on the table'),
      numbers: { paysNow: _makeField(400000), quote: _makeField(850000), canAbsorb: _makeField(600000) },
      deadline: _makeField('February'), renewalDate: _makeField(null),
      doingNothing: _makeField('sign at 850, refresh pushed, storage unsolved'),
      cause: _makeField('Broadcom changed the licensing'), otherDrivers: _makeField('board wants less single-vendor risk'),
      impactOnOthers: _makeField('compliance lead needs sign-off'), personalStake: _makeField('defend recommendation to CEO'),
      signOff: _makeField('Sarah, CFO'), budget: _makeField('capital, sign up to 250'),
      needs: [{value:'alternative on the table with real numbers',evidence:[],confidence:0.9,locked:false,painType:null,sourceTier:'need',history:[]},{value:'migration plan — physically possible without touching patient systems',evidence:[],confidence:0.9,locked:false,painType:null,sourceTier:'need',history:[]}],
      topNeed: _makeField(2), needReason: _makeField('if migration not safe numbers do not matter'),
      nextStep: { who: _makeField('you, her, Sarah, reseller'), purpose: _makeField('working session'), dateTime: _makeField('week of December 15th') },
      scratch: []
    };

    function _ticks(n) {
      const filled = arr => arr.filter(Boolean).length;
      const painC = filled([n.pain.value, n.whatItAffects.value, n.whyProblem.value, n.cause.value]);
      return {
        pain: painC>=3?'done':painC>=1?'partial':'yet',
        needs: n.needs.filter(nd=>nd.value).length>=1?'done':'yet',
        timeframe: filled([n.deadline.value,n.renewalDate.value])>=1?'done':'yet',
      };
    }

    const t = _ticks(fullNotes);
    assert(t.pain === 'done', `pain tick is "done" when all 4 pain fields are filled (got "${t.pain}")`);
    assert(fullNotes.needs.filter(n=>n.value).length >= 2, `needs count is >= 2 (got ${fullNotes.needs.filter(n=>n.value).length})`);
    assert(t.timeframe === 'done', `timeframe tick is "done" when deadline is set (got "${t.timeframe}")`);
    assert(t.needs === 'done', `needs tick is "done" when needs array has values (got "${t.needs}")`);
  }

  // ── Coach: opener gate + driver steering ─────────────────────────────────────
  console.log('\n━━ Coach: opener gate + driver steering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    function _emptyNotes() {
      function mf(v) { return { value: v||null, evidence:[], confidence:0, locked:false }; }
      return {
        situation: { hosts: mf(), vms: mf(), storageTB: mf(), teamSize: mf(), workloads: mf() },
        painType: mf(), pain: mf(), whatItAffects: mf(), whyProblem: mf(),
        numbers: { paysNow: mf(), quote: mf(), canAbsorb: mf() },
        deadline: mf(), renewalDate: mf(), doingNothing: mf(),
        cause: mf(), otherDrivers: mf(), impactOnOthers: mf(),
        personalStake: mf(), signOff: mf(), budget: mf(),
        needs: [], topNeed: mf(), needReason: mf(),
        nextStep: { who: mf(), purpose: mf(), dateTime: mf() }, scratch: []
      };
    }

    // 1. Situation blocked before opener asked
    const blockedNotes = _emptyNotes();
    const blockedTx = [
      { id:'u1', ts:'00:05', speaker:'Me', text:'My name is James.' },
      { id:'u2', ts:'00:20', speaker:'Her', text:'Hi, nice to meet you.' },
    ];
    const blockedResult = CoachLogic.computeCoachNext(blockedNotes, blockedTx, null);
    assert(
      !blockedResult.mainQ?.toLowerCase().includes('estate') && !blockedResult.mainQ?.toLowerCase().includes('hosts'),
      `situation question blocked before opener asked (got: "${blockedResult.mainQ}")`
    );

    // 2. Driver mapping: licensing mention → licence follow-up
    const licensingNotes = _emptyNotes();
    const licensingTx = [
      { id:'u1', ts:'00:05', speaker:'Me', text:"What made you open to this conversation, given you've been on VMware for 10 years?" },
      { id:'u2', ts:'00:20', speaker:'Her', text:'The licensing. We are paying for modules we never turn on.' },
    ];
    const licensingResult = CoachLogic.computeCoachNext(licensingNotes, licensingTx, null);
    assert(
      licensingResult.mainQ?.toLowerCase().includes('licence'),
      `driver: licensing mention → licence question (got: "${licensingResult.mainQ}")`
    );

    // 3. Vague answer fallback
    const vagueNotes = _emptyNotes();
    const vagueTx = [
      { id:'u1', ts:'00:05', speaker:'Me', text:"What made you open to this conversation, given you've been on VMware for 10 years?" },
      { id:'u2', ts:'00:20', speaker:'Her', text:'The reseller asked me to take the call.' },
    ];
    const vagueResult = CoachLogic.computeCoachNext(vagueNotes, vagueTx, null);
    assert(
      vagueResult.mainQ?.toLowerCase().includes('setup today'),
      `vague answer fallback fires (got: "${vagueResult.mainQ}")`
    );

    // 4. She volunteers hosts → situation tick done, not blocked
    const volunteerNotes = _emptyNotes();
    volunteerNotes.situation.hosts = { value: 12, evidence:[], confidence:0.8, locked:false };
    const volunteerTx = [
      { id:'u1', ts:'00:10', speaker:'Her', text:'We run 12 hosts in two datacentres.' },
    ];
    const volunteerResult = CoachLogic.computeCoachNext(volunteerNotes, volunteerTx, null);
    assert(
      !volunteerResult.mainQ?.toLowerCase().includes('hosts'),
      `she volunteers hosts — estate walk-through not re-suggested (got: "${volunteerResult.mainQ}")`
    );
    assert(
      volunteerResult.mainQ?.toLowerCase().includes('open to this conversation'),
      `she volunteers hosts → opener still suggested (got: "${volunteerResult.mainQ}")`
    );

    // 5. Situation still asked after opener asked and pain done, no estate volunteered
    const lateNotes = _emptyNotes();
    lateNotes.pain = { value: 'renewal cost', evidence:[], confidence:0.8, locked:false };
    lateNotes.whatItAffects = { value: 'budget', evidence:[], confidence:0.8, locked:false };
    lateNotes.whyProblem = { value: 'CFO pressure', evidence:[], confidence:0.8, locked:false };
    lateNotes.cause = { value: 'Broadcom pricing', evidence:[], confidence:0.8, locked:false };
    lateNotes.deadline = { value: 'February', evidence:[], confidence:0.8, locked:false };
    lateNotes.doingNothing = { value: 'stay with VMware at higher cost', evidence:[], confidence:0.8, locked:false };
    lateNotes.impactOnOthers = { value: 'team overloaded', evidence:[], confidence:0.8, locked:false };
    lateNotes.personalStake = { value: 'defend decision to board', evidence:[], confidence:0.8, locked:false };
    lateNotes.needs = [{ value: 'alternative on the table', evidence:[], confidence:0.9, locked:false, painType:null, sourceTier:'need', history:[] }];
    const lateTx = [
      { id:'u1', ts:'00:05', speaker:'Me', text:"What made you open to this conversation, given you've been on VMware for 10 years?" },
      { id:'u2', ts:'00:20', speaker:'Her', text:'The renewal cost went up three times.' },
      { id:'u3', ts:'05:00', speaker:'Me', text:'What does that affect over the next 6 to 12 months?' },
      { id:'u4', ts:'05:15', speaker:'Her', text:'It affects our whole infrastructure budget.' },
    ];
    const lateResult = CoachLogic.computeCoachNext(lateNotes, lateTx, null);
    const lateQ1 = lateResult.mainQ?.toLowerCase() || '';
    const lateQ2 = lateResult.backupQ?.toLowerCase() || '';
    assert(
      lateQ1.includes('estate') || lateQ1.includes('walk') || lateQ2.includes('estate') || lateQ2.includes('walk'),
      `situation appears in suggestions after opener asked and pain done (main: "${lateResult.mainQ}", backup: "${lateResult.backupQ}")`
    );
  }

  // ── Coach: opening lines don't mask the opener question (>= 90s filter removed) ──
  console.log('\n━━ Coach: opening lines do not mask opener question ━━━━━━━━━━━━━━━━━━');
  {
    // The >=-90s filter was removed because alreadyAsked uses 50%-keyword overlap:
    // opening lines ("My name is James", "Does that feel fair?") share zero keywords
    // with discovery questions like "What made you open to this conversation...",
    // so the filter was redundant and its removal allows correct opener detection
    // when Me asks it early (e.g. at 0:45).
    function _mf() { return { value: null, evidence:[], confidence:0, locked:false }; }
    const openingOnlyNotes = {
      situation: { hosts: _mf(), vms: _mf(), storageTB: _mf(), teamSize: _mf(), workloads: _mf() },
      painType: _mf(), pain: _mf(), whatItAffects: _mf(), whyProblem: _mf(),
      numbers: { paysNow: _mf(), quote: _mf(), canAbsorb: _mf() },
      deadline: _mf(), renewalDate: _mf(), doingNothing: _mf(),
      cause: _mf(), otherDrivers: _mf(), impactOnOthers: _mf(),
      personalStake: _mf(), signOff: _mf(), budget: _mf(),
      needs: [], topNeed: _mf(), needReason: _mf(),
      nextStep: { who: _mf(), purpose: _mf(), dateTime: _mf() }, scratch: []
    };
    const openingOnlyTx = [
      { id:'u1', ts:'00:05', speaker:'Me',  text:'My name is James, inside sales at Nutanix.' },
      { id:'u2', ts:'00:15', speaker:'Her', text:'Hi James, nice to meet you.' },
      { id:'u3', ts:'00:30', speaker:'Me',  text:"What I'd love to do today: understand your estate for 20 minutes, then decide if a next step makes sense." },
      { id:'u4', ts:'00:45', speaker:'Me',  text:'Does that feel fair?' },
      { id:'u5', ts:'00:50', speaker:'Her', text:'Yes, absolutely.' },
    ];
    const openingResult = CoachLogic.computeCoachNext(openingOnlyNotes, openingOnlyTx, null);
    assert(
      openingResult.mainQ?.toLowerCase().includes('open to this conversation'),
      `opening lines (intro + agenda + "does that feel fair?") do not mask opener question (got: "${openingResult.mainQ}")`
    );
  }

  // ── Coach Fix 1: post-pitch cycling (real CoachLogic.postPitchNext) ─────────
  console.log('\n━━ Coach Fix 1: post-pitch cycling ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  assert(
    CoachLogic.postPitchNext([], false) === 'Does a next step make sense?',
    'post-pitch with no objection and no next step → close question'
  );
  assert(
    CoachLogic.postPitchNext([], true) === "Recap: confirm who, what, when, and say you'll send it today.",
    'post-pitch with next step agreed → recap message'
  );
  {
    const objs = [{ id: 'o1', status: 'open', quote: 'Can you guarantee no downtime?' }];
    const q = CoachLogic.postPitchNext(objs, false);
    assert(q.startsWith('Handle:'), `post-pitch with open objection → starts with "Handle:" (got: "${q}")`);
    assert(q.includes('guarantee no downtime'), 'post-pitch objection text included in Handle message');
  }
  {
    const objs = [{ id: 'o1', status: 'handled', quote: 'Can you guarantee no downtime?' }];
    assert(
      CoachLogic.postPitchNext(objs, false) === 'Does a next step make sense?',
      'post-pitch with only handled objection (not open) → close question'
    );
  }

  // ── Coach Fix 3: constraint detection (real CoachLogic.isConstraintItem) ───
  console.log('\n━━ Coach Fix 3: constraint detection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  assert(CoachLogic.isConstraintItem('She will be away that week'), 'away → isConstraint');
  assert(CoachLogic.isConstraintItem('IT freeze in December'), 'freeze → isConstraint');
  assert(CoachLogic.isConstraintItem('Finance team on holiday until January'), 'holiday → isConstraint');
  assert(CoachLogic.isConstraintItem('CFO out of office until the 15th'), 'out of office → isConstraint');
  assert(!CoachLogic.isConstraintItem('Board wants less single-vendor risk'), 'board pressure → not a constraint');
  assert(!CoachLogic.isConstraintItem('Clinical uptime is the top priority'), 'uptime concern → not a constraint');
  assert(!CoachLogic.isConstraintItem('The renewal quote came in at 850k'), 'cost pain → not a constraint');

  // ── Coach hasRoE detection ────────────────────────────────────────────────
  console.log('\n━━ CoachLogic.hasRoE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const mk = (ts, text) => ({ speaker: 'Me', ts, text });
    assert(CoachLogic.hasRoE([mk('00:06', "My name is Jimmy. Is that okay with you?")]),
      'hasRoE: "is that okay with you" → true');
    assert(CoachLogic.hasRoE([mk('00:10', "Does that feel fair?")]),
      'hasRoE: "does that feel fair" → true');
    assert(CoachLogic.hasRoE([mk('00:10', "Let me set the agenda for today.")]),
      'hasRoE: "agenda" → true');
    assert(CoachLogic.hasRoE([mk('00:10', "We're figuring out if this would be a good fit.")]),
      'hasRoE: "good fit" → true');
    assert(!CoachLogic.hasRoE([mk('00:06', "Can you walk me through your estate?")]),
      'hasRoE: plain question → false');
    assert(!CoachLogic.hasRoE([]),
      'hasRoE: empty transcript → false');
    assert(!CoachLogic.hasRoE([mk('06:00', "Is that okay with you?")]),
      'hasRoE: phrase after 5 min cutoff → false');

    // Positive: live-intro-call.txt opening line
    const liveIntroText = fs.readFileSync(path.join(__dirname, 'holdout/live-intro-call.txt'), 'utf8');
    const liveIntroUtterances = liveIntroText.split('\n')
      .filter(l => /^\[(\d{2}:\d{2})\]\s+Me:/.test(l.trim()))
      .map(l => {
        const m = l.trim().match(/^\[(\d{2}:\d{2})\]\s+Me:\s+(.+)$/);
        return m ? { speaker: 'Me', ts: m[1], text: m[2] } : null;
      }).filter(Boolean);
    assert(CoachLogic.hasRoE(liveIntroUtterances),
      'hasRoE: live-intro-call opening line → true');
  }

  // ── Opening tick auto-detection (computeOpeningTicksFromTranscript) ─────────
  console.log('\n━━ Opening tick auto-detection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const cotft = CoachLogic.computeOpeningTicksFromTranscript;
    function mkMe(ts, text) { return { speaker: 'Me', ts, text }; }
    function mkHer(ts, text) { return { speaker: 'Her', ts, text }; }

    // Her line alone must not tick anything
    const herOnly = [mkHer('00:10', 'Could you tell me what you need')];
    const t1 = cotft(herOnly);
    assert(!t1.o4, 'opening: Her "Could you tell me what you need" does NOT tick o4');
    assert(!t1.o1, 'opening: Her line alone does not tick o1');

    // Me intro + RoE question → o1, o2, o3 all done (o2 auto-ticks when o1+o3 both true)
    const meIntroAndRoE = [
      mkMe('00:05', 'My name is James.'),
      mkMe('00:20', 'Is that okay with you?'),
    ];
    const t2 = cotft(meIntroAndRoE);
    assert(t2.o1, 'opening: Me intro → o1 ticked');
    assert(t2.o3, 'opening: RoE phrase → o3 ticked');
    assert(!t2.o4, 'opening: no discovery Q yet → o4 not ticked');
    // Card logic: given o1=true, o2=false, o3=true the first undone is o2 → step 2
    // (This tests _renderLiveNextOpening's firstUndone logic directly)
    const ITEMS = ['o1', 'o2', 'o3', 'o4'];
    const manualOpening = { o1: true, o2: false, o3: true, o4: false };
    const firstUndoneIdx = ITEMS.findIndex(id => !manualOpening[id]);
    assert(firstUndoneIdx === 1, 'opening card: o1+o3 ticked, o2 unticked → firstUndone is step 2');

    // Me asks a discovery question → o4 ticks
    const meWithDiscovery = [
      mkMe('00:05', 'My name is James.'),
      mkMe('00:20', 'Is that okay with you?'),
      mkMe('00:30', 'Can you walk me through your setup?'),
    ];
    const t3 = cotft(meWithDiscovery);
    assert(t3.o4, 'opening: Me asks discovery Q → o4 ticked');

    // Her response after Me discovery Q must not change o4 result
    const withHerResponse = [
      mkMe('00:05', 'My name is James.'),
      mkMe('00:20', 'Is that okay with you?'),
      mkHer('00:25', 'Yes, sure.'),
      mkHer('00:35', 'Could you tell me what you need'),
    ];
    const t4 = cotft(withHerResponse);
    assert(!t4.o4, 'opening: Her lines after RoE do NOT tick o4 without Me discovery Q');
  }

  // ── SummaryLogic: computeCompleteness ─────────────────────────────────────
  console.log('\n━━ SummaryLogic: computeCompleteness ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const { computeCompleteness, computeSummaryText } = SummaryLogic;
    const mf = () => ({ value: null, evidence: [], confidence: 0, locked: false });

    function makeNotes() {
      return {
        situation: { hosts: mf(), vms: mf(), storageTB: mf(), teamSize: mf(), workloads: mf() },
        painType: mf(), pain: mf(), whatItAffects: mf(), whyProblem: mf(),
        numbers: { paysNow: mf(), quote: mf(), canAbsorb: mf() },
        deadline: mf(), renewalDate: mf(), doingNothing: mf(),
        cause: mf(), otherDrivers: mf(), impactOnOthers: mf(),
        personalStake: mf(), signOff: mf(), budget: mf(),
        needs: [], topNeed: mf(), needReason: mf(),
        nextStep: { who: mf(), purpose: mf(), dateTime: mf() }, scratch: [],
      };
    }

    // Empty notes — nothing complete
    const empty = makeNotes();
    const emptyComp = computeCompleteness(empty);
    assert(!emptyComp.pain,    'pain chip hidden when pain + affects both empty');
    assert(!emptyComp.numbers, 'numbers chip hidden when all numbers empty');
    assert(!emptyComp.cause,   'cause chip hidden when cause empty');
    assert(!emptyComp.impact,  'impact chip hidden when impact fields empty');
    assert(!emptyComp.needs,   'needs chip hidden when needs list empty');

    // Full pain section
    const withPain = makeNotes();
    withPain.pain.value = 'renewal doubled';
    withPain.whatItAffects.value = 'whole IT budget';
    assert(computeCompleteness(withPain).pain, 'pain chip shown when pain + affects both filled');

    // Only pain, no affects
    const halfPain = makeNotes();
    halfPain.pain.value = 'renewal doubled';
    assert(!computeCompleteness(halfPain).pain, 'pain chip hidden when affects is missing');

    // Full numbers
    const withNums = makeNotes();
    withNums.numbers.paysNow.value = 240000;
    withNums.numbers.quote.value   = 390000;
    withNums.numbers.canAbsorb.value = 0;
    assert(computeCompleteness(withNums).numbers, 'numbers chip shown when paysNow + quote + absorb filled');

    withNums.numbers.canAbsorb.value = null;
    assert(!computeCompleteness(withNums).numbers, 'numbers chip hidden when absorb is missing');

    // Full needs
    const withNeeds = makeNotes();
    withNeeds.needs = [{ value: 'comparison table', evidence: [], confidence: 1, locked: false }];
    withNeeds.topNeed.value = 1;
    assert(computeCompleteness(withNeeds).needs, 'needs chip shown when need + topNeed filled');

    withNeeds.topNeed.value = null;
    assert(!computeCompleteness(withNeeds).needs, 'needs chip hidden when topNeed missing');

    // ── computeSummaryText: missing fields listed ─────────────────────────
    const partial = makeNotes();
    partial.pain.value = 'renewal quote doubled';
    const painSummary = computeSummaryText('pain', partial);
    assert(painSummary.text.includes('what it affects'), 'pain summary lists "what it affects" as not yet heard');
    assert(painSummary.text.includes('Did I get that right?'), 'pain summary ends with check-in question');
    assert(!painSummary.complete, 'pain summary is not complete when affects missing');

    // Full pain summary — no missing
    partial.whatItAffects.value = 'the whole IT budget';
    const fullPainSummary = computeSummaryText('pain', partial);
    assert(!fullPainSummary.text.includes('Not yet heard'), 'complete pain summary has no "not yet heard"');
    assert(fullPainSummary.complete, 'pain summary is complete when both fields filled');

    // Impact summary with pain restated
    const withImpact = makeNotes();
    withImpact.pain.value  = 'renewal doubled';
    withImpact.cause.value = 'Broadcom changed licensing';
    withImpact.impactOnOthers.value = 'clinical teams stuck on VMware';
    withImpact.personalStake.value  = 'her bonus tied to cost reduction';
    withImpact.signOff.value        = 'CFO';
    const impactSummary = computeSummaryText('impact', withImpact);
    assert(impactSummary.text.includes('renewal doubled'),     'impact summary restates pain');
    assert(impactSummary.text.includes('Broadcom'),            'impact summary restates cause');
    assert(impactSummary.text.includes('Did I get that right?'), 'impact summary ends with check-in');
    assert(impactSummary.complete, 'impact summary complete when all fields present');

    // Needs summary with top need
    const withFullNeeds = makeNotes();
    withFullNeeds.needs = [
      { value: 'comparison on paper', evidence: [], confidence: 1, locked: false },
      { value: 'migration plan',      evidence: [], confidence: 1, locked: false },
    ];
    withFullNeeds.topNeed.value = 2;
    const needsSummary = computeSummaryText('needs', withFullNeeds);
    assert(needsSummary.text.includes('migration plan'), 'needs summary includes top need text');
    assert(needsSummary.text.includes('Most important'), 'needs summary labels top need');
    assert(needsSummary.complete, 'needs summary complete when needs + topNeed present');
  }

  // ── autoHandleObjections: pure-unit ───────────────────────────────────────
  console.log('\n━━ autoHandleObjections: pure-unit ━━━━━━━━━━━━━━━━━━━━━━━━━');
  {
    const { autoHandleObjections } = CoachLogic;

    // Her objection → Me responds → Her moves on → handled-auto
    const objs1 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Can you guarantee no downtime?' }];
    const tx1 = [
      { id: 'u007', speaker: 'Me',  ts: '02:00', text: 'How does it affect the team?' },
      { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Can you guarantee no downtime?' },
      { id: 'u009', speaker: 'Me',  ts: '03:00', text: "I can't promise zero downtime." },
      { id: 'u010', speaker: 'Her', ts: '03:20', text: 'A proper cutover window.' },
    ];
    autoHandleObjections(objs1, tx1);
    assert(objs1[0].status === 'handled-auto', 'auto-handle: Me + Her after objection → handled-auto');

    // Me responds but Her hasn't moved on yet → still open
    const objs2 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Guarantee?' }];
    const tx2 = [
      { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Guarantee?' },
      { id: 'u009', speaker: 'Me',  ts: '03:00', text: 'Good question.' },
    ];
    autoHandleObjections(objs2, tx2);
    assert(objs2[0].status === 'open', 'auto-handle: no Her follow-up → stays open');

    // No Me response yet → stays open
    const objs3 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Guarantee?' }];
    const tx3 = [{ id: 'u008', speaker: 'Her', ts: '02:30', text: 'Guarantee?' }];
    autoHandleObjections(objs3, tx3);
    assert(objs3[0].status === 'open', 'auto-handle: no Me response → stays open');

    // Already fully handled → not touched
    const objs4 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'handled', quote: 'Guarantee?' }];
    const tx4 = [
      { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Guarantee?' },
      { id: 'u009', speaker: 'Me',  ts: '03:00', text: 'Good.' },
      { id: 'u010', speaker: 'Her', ts: '03:20', text: 'OK.' },
    ];
    autoHandleObjections(objs4, tx4);
    assert(objs4[0].status === 'handled', 'auto-handle: already "handled" not changed to handled-auto');

    // Idempotent: already handled-auto → not reset
    const objs5 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'handled-auto', quote: 'Guarantee?' }];
    autoHandleObjections(objs5, tx4);
    assert(objs5[0].status === 'handled-auto', 'auto-handle: already handled-auto stays handled-auto (idempotent)');

    // Negative: unrelated Me question + Her answer → stays open
    const objs6 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Can you guarantee no downtime?' }];
    const tx6 = [
      { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Can you guarantee no downtime?' },
      { id: 'u009', speaker: 'Me',  ts: '03:00', text: 'What does your team look like?' },
      { id: 'u010', speaker: 'Her', ts: '03:20', text: 'Three people, all VMware certified.' },
    ];
    autoHandleObjections(objs6, tx6);
    assert(objs6[0].status === 'open', 'auto-handle: unrelated Me question after objection stays open (negative test)');

    // Negative: short unrelated Me reply + Her answer → stays open
    const objs7 = [{ utteranceId: 'u008', matchedKey: 'cost', status: 'open', quote: 'Is it actually cheaper?' }];
    const tx7 = [
      { id: 'u008', speaker: 'Her', ts: '05:00', text: 'Is it actually cheaper?' },
      { id: 'u009', speaker: 'Me',  ts: '05:10', text: 'Good point.' },
      { id: 'u010', speaker: 'Her', ts: '05:20', text: 'What do you mean by good point?' },
    ];
    autoHandleObjections(objs7, tx7);
    assert(objs7[0].status === 'open', 'auto-handle: "Good point" does not address cost objection — stays open (negative test)');
  }

  // ── autoHandleObjections: LLM pipeline (hospital-uptime + objection-call) ──
  console.log('\n━━ autoHandleObjections: LLM pipeline ━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const text = fs.readFileSync(path.join(__dirname, 'holdout/hospital-uptime-call.txt'), 'utf8');
    const utterances = parseTranscript(text);
    const { objections } = await acc(runCall(utterances, BASE));
    // Mirror handleIncomingObjections in app.js: raw server objections start as 'open'
    objections.forEach(o => { if (!o.status) o.status = 'open'; });
    CoachLogic.autoHandleObjections(objections, utterances);
    const dtObj = objections.find(o => o.matchedKey === 'downtime');
    assert(!!dtObj, 'hospital-uptime: downtime objection detected');
    assert(dtObj && dtObj.status === 'handled-auto',
      'hospital-uptime: downtime auto-handled (Me + Her follow the exchange)',
      `status: ${dtObj?.status}, utteranceId: ${dtObj?.utteranceId}`);
  } catch (e) { console.error('  ERROR in auto-handle/hospital-uptime:', e.message); }

  try {
    const text = fs.readFileSync(path.join(__dirname, 'objection-call.txt'), 'utf8');
    const utterances = parseTranscript(text);
    const { objections } = await acc(runCall(utterances, BASE));
    objections.forEach(o => { if (!o.status) o.status = 'open'; });
    CoachLogic.autoHandleObjections(objections, utterances);
    const dtObj = objections.find(o => o.matchedKey === 'downtime');
    assert(!!dtObj, 'objection-call: downtime objection detected');
    assert(dtObj && dtObj.status === 'handled-auto',
      'objection-call: downtime auto-handled (Me + Her follow the exchange)',
      `status: ${dtObj?.status}, utteranceId: ${dtObj?.utteranceId}`);
  } catch (e) { console.error('  ERROR in auto-handle/objection-call:', e.message); }

  // ── Summary ────────────────────────────────────────────────────────────────
  server.kill();
  console.log(`\n${'━'.repeat(55)}`);
  const total = passed + failed;
  console.log(`${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : '  ✓'}`);
  const fmt = n => n.toLocaleString();
  console.log(`API usage: ${fmt(apiUsage.calls)} calls  |  input: ${fmt(apiUsage.inputTokens)} tokens  |  output: ${fmt(apiUsage.outputTokens)} tokens`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
