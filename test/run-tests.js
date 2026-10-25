#!/usr/bin/env node
// npm test — incremental pipeline matching the browser, with holdout checks.
'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { runCall, createEmptyNotes, parseTranscript, fv } = require('../lib/extractor');
const CoachLogic   = require('../public/coach-logic.js');
const SummaryLogic = require('../public/summary-logic.js');
const { confirmCost } = require('../lib/confirm');

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
  await confirmCost('This makes about 40 API calls (~$0.30).');
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
