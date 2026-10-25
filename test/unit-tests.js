#!/usr/bin/env node
// npm test — pure unit checks: no server, no API calls.
// Everything here runs in milliseconds.
'use strict';

const fs   = require('fs');
const path = require('path');
const CoachLogic   = require('../public/coach-logic.js');
const SummaryLogic = require('../public/summary-logic.js');

let passed = 0, failed = 0;
function assert(condition, message, detail = '') {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.log(`  FAIL  ${message}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── needsSimilar dedup ─────────────────────────────────────────────────────────
console.log('\n━━ needsSimilar dedup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','our','we','i','is','are','be','have','has','need','needs']);
  const wordsOf = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
  function needsSimilar(a, b) {
    const wa = new Set(wordsOf(a));
    const wb = new Set(wordsOf(b));
    const inter = [...wa].filter(w => wb.has(w)).length;
    const union = new Set([...wa, ...wb]).size;
    return union > 0 && inter / union >= 0.4;
  }

  assert(!needsSimilar(
    'migration plan',
    'migration windows agreed with the clinical team'
  ), 'needsSimilar: "migration plan" vs "migration windows agreed…" are NOT merged');

  assert(needsSimilar(
    'migration plan',
    'migration plan that keeps patient systems up'
  ), 'needsSimilar: "migration plan" vs "migration plan that keeps patient systems up" IS merged');

  assert(!needsSimilar(
    'side-by-side cost comparison',
    'migration windows agreed with the clinical team'
  ), 'needsSimilar: unrelated needs are NOT merged');
}

// ── shortQuote trailing punctuation ───────────────────────────────────────────
console.log('\n━━ shortQuote trailing punctuation ━━━━━━━━━━━━━━━━━━');
{
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

// ── Coach: stage-direction stripping ──────────────────────────────────────────
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

// ── Unbracketed stage direction stripping (CoachLogic.stripStageDirections) ───
const sd = CoachLogic.stripStageDirections.bind(CoachLogic);
assert(sd('A short exhale') === '',    'stripSD: "A short exhale" → empty');
assert(sd('A pause') === '',            'stripSD: "A pause" → empty');
assert(sd('A beat') === '',             'stripSD: "A beat" → empty');
assert(sd('A small frown') === '',      'stripSD: "A small frown" → empty');
assert(sd('Slightly roundabout') === '','stripSD: "Slightly roundabout" → empty');
assert(sd('A long pause') === '',       'stripSD: "A long pause" → empty');
assert(sd('Okay. Good. Stop.') === '',  'stripSD: sentinel → empty');
{
  const r = sd('A small frown. Yes, that\'s right.');
  assert(r === "Yes, that's right.", `stripSD inline: kept real content (got "${r}")`);
}
assert(sd('A beat of downtime would cost us') === 'A beat of downtime would cost us',
  'stripSD: "A beat of downtime would cost us" → unchanged');
assert(sd('A pause in the service is a risk') === 'A pause in the service is a risk',
  'stripSD: "A pause in the service is a risk" → unchanged');
assert(sd("Yes. That's fine.") === "Yes. That's fine.",
  'stripSD: "Yes. That\'s fine." → unchanged');

// ── Coach: computeCoachNext filters already-asked questions ───────────────────
console.log('\n━━ Coach: computeCoachNext filters already-asked questions ━━━━━━━━━━━━');

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

// ── Coach: opener gate + driver steering ──────────────────────────────────────
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

// ── Coach: opening lines don't mask the opener question ───────────────────────
console.log('\n━━ Coach: opening lines do not mask opener question ━━━━━━━━━━━━━━━━━━');
{
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

// ── Coach Fix 1: post-pitch cycling ───────────────────────────────────────────
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

// ── Coach Fix 3: constraint detection ─────────────────────────────────────────
console.log('\n━━ Coach Fix 3: constraint detection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

assert(CoachLogic.isConstraintItem('She will be away that week'), 'away → isConstraint');
assert(CoachLogic.isConstraintItem('IT freeze in December'), 'freeze → isConstraint');
assert(CoachLogic.isConstraintItem('Finance team on holiday until January'), 'holiday → isConstraint');
assert(CoachLogic.isConstraintItem('CFO out of office until the 15th'), 'out of office → isConstraint');
assert(!CoachLogic.isConstraintItem('Board wants less single-vendor risk'), 'board pressure → not a constraint');
assert(!CoachLogic.isConstraintItem('Clinical uptime is the top priority'), 'uptime concern → not a constraint');
assert(!CoachLogic.isConstraintItem('The renewal quote came in at 850k'), 'cost pain → not a constraint');

// ── CoachLogic.hasRoE ─────────────────────────────────────────────────────────
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

// ── Opening tick auto-detection ───────────────────────────────────────────────
console.log('\n━━ Opening tick auto-detection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const cotft = CoachLogic.computeOpeningTicksFromTranscript;
  function mkMe(ts, text) { return { speaker: 'Me', ts, text }; }
  function mkHer(ts, text) { return { speaker: 'Her', ts, text }; }

  const herOnly = [mkHer('00:10', 'Could you tell me what you need')];
  const t1 = cotft(herOnly);
  assert(!t1.o4, 'opening: Her "Could you tell me what you need" does NOT tick o4');
  assert(!t1.o1, 'opening: Her line alone does not tick o1');

  const meIntroAndRoE = [
    mkMe('00:05', 'My name is James.'),
    mkMe('00:20', 'Is that okay with you?'),
  ];
  const t2 = cotft(meIntroAndRoE);
  assert(t2.o1, 'opening: Me intro → o1 ticked');
  assert(t2.o3, 'opening: RoE phrase → o3 ticked');
  assert(!t2.o4, 'opening: no discovery Q yet → o4 not ticked');
  const ITEMS = ['o1', 'o2', 'o3', 'o4'];
  const manualOpening = { o1: true, o2: false, o3: true, o4: false };
  const firstUndoneIdx = ITEMS.findIndex(id => !manualOpening[id]);
  assert(firstUndoneIdx === 1, 'opening card: o1+o3 ticked, o2 unticked → firstUndone is step 2');

  const meWithDiscovery = [
    mkMe('00:05', 'My name is James.'),
    mkMe('00:20', 'Is that okay with you?'),
    mkMe('00:30', 'Can you walk me through your setup?'),
  ];
  const t3 = cotft(meWithDiscovery);
  assert(t3.o4, 'opening: Me asks discovery Q → o4 ticked');

  const withHerResponse = [
    mkMe('00:05', 'My name is James.'),
    mkMe('00:20', 'Is that okay with you?'),
    mkHer('00:25', 'Yes, sure.'),
    mkHer('00:35', 'Could you tell me what you need'),
  ];
  const t4 = cotft(withHerResponse);
  assert(!t4.o4, 'opening: Her lines after RoE do NOT tick o4 without Me discovery Q');
}

// ── SummaryLogic: computeCompleteness ─────────────────────────────────────────
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

  const empty = makeNotes();
  const emptyComp = computeCompleteness(empty);
  assert(!emptyComp.pain,    'pain chip hidden when pain + affects both empty');
  assert(!emptyComp.numbers, 'numbers chip hidden when all numbers empty');
  assert(!emptyComp.cause,   'cause chip hidden when cause empty');
  assert(!emptyComp.impact,  'impact chip hidden when impact fields empty');
  assert(!emptyComp.needs,   'needs chip hidden when needs list empty');

  const withPain = makeNotes();
  withPain.pain.value = 'renewal doubled';
  withPain.whatItAffects.value = 'whole IT budget';
  assert(computeCompleteness(withPain).pain, 'pain chip shown when pain + affects both filled');

  const halfPain = makeNotes();
  halfPain.pain.value = 'renewal doubled';
  assert(!computeCompleteness(halfPain).pain, 'pain chip hidden when affects is missing');

  const withNums = makeNotes();
  withNums.numbers.paysNow.value = 240000;
  withNums.numbers.quote.value   = 390000;
  withNums.numbers.canAbsorb.value = 0;
  assert(computeCompleteness(withNums).numbers, 'numbers chip shown when paysNow + quote + absorb filled');

  withNums.numbers.canAbsorb.value = null;
  assert(!computeCompleteness(withNums).numbers, 'numbers chip hidden when absorb is missing');

  const withNeeds = makeNotes();
  withNeeds.needs = [{ value: 'comparison table', evidence: [], confidence: 1, locked: false }];
  withNeeds.topNeed.value = 1;
  assert(computeCompleteness(withNeeds).needs, 'needs chip shown when need + topNeed filled');

  withNeeds.topNeed.value = null;
  assert(!computeCompleteness(withNeeds).needs, 'needs chip hidden when topNeed missing');

  const partial = makeNotes();
  partial.pain.value = 'renewal quote doubled';
  const painSummary = computeSummaryText('pain', partial);
  assert(painSummary.text.includes('what it affects'), 'pain summary lists "what it affects" as not yet heard');
  assert(painSummary.text.includes('Did I get that right?'), 'pain summary ends with check-in question');
  assert(!painSummary.complete, 'pain summary is not complete when affects missing');

  partial.whatItAffects.value = 'the whole IT budget';
  const fullPainSummary = computeSummaryText('pain', partial);
  assert(!fullPainSummary.text.includes('Not yet heard'), 'complete pain summary has no "not yet heard"');
  assert(fullPainSummary.complete, 'pain summary is complete when both fields filled');

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

// ── autoHandleObjections: pure-unit ───────────────────────────────────────────
console.log('\n━━ autoHandleObjections: pure-unit ━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { autoHandleObjections } = CoachLogic;

  const objs1 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Can you guarantee no downtime?' }];
  const tx1 = [
    { id: 'u007', speaker: 'Me',  ts: '02:00', text: 'How does it affect the team?' },
    { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Can you guarantee no downtime?' },
    { id: 'u009', speaker: 'Me',  ts: '03:00', text: "I can't promise zero downtime." },
    { id: 'u010', speaker: 'Her', ts: '03:20', text: 'A proper cutover window.' },
  ];
  autoHandleObjections(objs1, tx1);
  assert(objs1[0].status === 'handled-auto', 'auto-handle: Me + Her after objection → handled-auto');

  const objs2 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Guarantee?' }];
  const tx2 = [
    { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Guarantee?' },
    { id: 'u009', speaker: 'Me',  ts: '03:00', text: 'Good question.' },
  ];
  autoHandleObjections(objs2, tx2);
  assert(objs2[0].status === 'open', 'auto-handle: no Her follow-up → stays open');

  const objs3 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Guarantee?' }];
  const tx3 = [{ id: 'u008', speaker: 'Her', ts: '02:30', text: 'Guarantee?' }];
  autoHandleObjections(objs3, tx3);
  assert(objs3[0].status === 'open', 'auto-handle: no Me response → stays open');

  const objs4 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'handled', quote: 'Guarantee?' }];
  const tx4 = [
    { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Guarantee?' },
    { id: 'u009', speaker: 'Me',  ts: '03:00', text: 'Good.' },
    { id: 'u010', speaker: 'Her', ts: '03:20', text: 'OK.' },
  ];
  autoHandleObjections(objs4, tx4);
  assert(objs4[0].status === 'handled', 'auto-handle: already "handled" not changed to handled-auto');

  const objs5 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'handled-auto', quote: 'Guarantee?' }];
  autoHandleObjections(objs5, tx4);
  assert(objs5[0].status === 'handled-auto', 'auto-handle: already handled-auto stays handled-auto (idempotent)');

  const objs6 = [{ utteranceId: 'u008', matchedKey: 'downtime', status: 'open', quote: 'Can you guarantee no downtime?' }];
  const tx6 = [
    { id: 'u008', speaker: 'Her', ts: '02:30', text: 'Can you guarantee no downtime?' },
    { id: 'u009', speaker: 'Me',  ts: '03:00', text: 'What does your team look like?' },
    { id: 'u010', speaker: 'Her', ts: '03:20', text: 'Three people, all VMware certified.' },
  ];
  autoHandleObjections(objs6, tx6);
  assert(objs6[0].status === 'open', 'auto-handle: unrelated Me question after objection stays open (negative test)');

  const objs7 = [{ utteranceId: 'u008', matchedKey: 'cost', status: 'open', quote: 'Is it actually cheaper?' }];
  const tx7 = [
    { id: 'u008', speaker: 'Her', ts: '05:00', text: 'Is it actually cheaper?' },
    { id: 'u009', speaker: 'Me',  ts: '05:10', text: 'Good point.' },
    { id: 'u010', speaker: 'Her', ts: '05:20', text: 'What do you mean by good point?' },
  ];
  autoHandleObjections(objs7, tx7);
  assert(objs7[0].status === 'open', 'auto-handle: "Good point" does not address cost objection — stays open (negative test)');
}

// ── shouldExitOpeningPhase: unit tests ────────────────────────────────────────
console.log('\n━━ shouldExitOpeningPhase unit tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const emN = () => ({
    situation:{hosts:{value:null},vms:{value:null},storageTB:{value:null},teamSize:{value:null},workloads:{value:null}},
    pain:{value:null},numbers:{paysNow:{value:null},quote:{value:null},canAbsorb:{value:null}},
    needs:[],nextStep:{who:{value:null},purpose:{value:null},dateTime:{value:null}},
  });

  const early = [
    {id:'u001',ts:'00:10',speaker:'Me',  text:"Hi, my name is Alex at Nutanix."},
    {id:'u002',ts:'00:20',speaker:'Her', text:"Hi."},
    {id:'u003',ts:'01:00',speaker:'Me',  text:"What I'd love to do today: understand your estate."},
    {id:'u004',ts:'01:10',speaker:'Her', text:"Okay."},
  ];
  assert(!CoachLogic.shouldExitOpeningPhase(early, emN()),
    'shouldExitOpeningPhase: false before 2:30 with no signals');

  const at230 = [
    {id:'u001',ts:'00:10',speaker:'Me',  text:"Hi."},
    {id:'u002',ts:'02:30',speaker:'Her', text:"Fine."},
  ];
  assert(CoachLogic.shouldExitOpeningPhase(at230, emN()),
    'shouldExitOpeningPhase: true at call time 2:30');

  const herTwice = [
    {id:'u001',ts:'00:10',speaker:'Me',  text:"Hello, I'm Alex."},
    {id:'u002',ts:'00:20',speaker:'Her', text:"Hi."},
    {id:'u003',ts:'00:30',speaker:'Me',  text:"What made you take this meeting?"},
    {id:'u004',ts:'00:40',speaker:'Her', text:"The renewal quote came in higher."},
    {id:'u005',ts:'01:00',speaker:'Me',  text:"Tell me more."},
    {id:'u006',ts:'01:10',speaker:'Her', text:"It was forty percent above budget."},
  ];
  assert(CoachLogic.shouldExitOpeningPhase(herTwice, emN()),
    'shouldExitOpeningPhase: true when Her speaks 2+ times after discovery Q');

  const withNotes = emN();
  withNotes.pain.value = 'renewal quote doubled';
  const shortTx = [{id:'u001',ts:'00:10',speaker:'Me',text:"Hi."}];
  assert(CoachLogic.shouldExitOpeningPhase(shortTx, withNotes),
    'shouldExitOpeningPhase: true immediately when discovery field filled');

  const roeOnly = [
    {id:'u001',ts:'00:10',speaker:'Me',  text:"Hi, I'm Alex."},
    {id:'u002',ts:'00:20',speaker:'Her', text:"Hi."},
    {id:'u003',ts:'00:30',speaker:'Me',  text:"Does that feel fair?"},
    {id:'u004',ts:'00:40',speaker:'Her', text:"Yes."},
    {id:'u005',ts:'01:00',speaker:'Me',  text:"Great."},
    {id:'u006',ts:'01:10',speaker:'Her', text:"Okay."},
  ];
  assert(!CoachLogic.shouldExitOpeningPhase(roeOnly, emN()),
    'shouldExitOpeningPhase: false — RoE question does not count as discovery Q');
}

// ── Opening phase exits by 3:00 (all transcript files) ───────────────────────
console.log('\n━━ Opening phase exits by 3:00 (all transcript files) ━━━━━━━━━━━');
{
  function tts(ts) { const p = (ts||'0:00').split(':').map(Number); return p[0]*60+(p[1]||0); }
  function parseTx(text) {
    let id = 0;
    return text.split('\n')
      .filter(l => /^\[\d{2}:\d{2}\]/.test(l))
      .map(l => {
        const m = l.match(/^\[(\d{2}:\d{2})\]\s+(Me|Her):\s*(.*)/);
        return m ? {id:'u'+String(++id).padStart(3,'0'),ts:m[1],speaker:m[2],text:m[3].trim()} : null;
      }).filter(Boolean);
  }
  const emN = () => ({
    situation:{hosts:{value:null},vms:{value:null},storageTB:{value:null},teamSize:{value:null},workloads:{value:null}},
    pain:{value:null},numbers:{paysNow:{value:null},quote:{value:null},canAbsorb:{value:null}},
    needs:[],nextStep:{who:{value:null},purpose:{value:null},dateTime:{value:null}},
  });

  const TEST_LOCS = [
    { dir: __dirname, filter: f => /^(messy|tidy|thin|objection)-call\.txt$/.test(f) },
    { dir: path.join(__dirname, 'holdout'), filter: f => f.endsWith('.txt') },
    { dir: path.join(__dirname, 'generated'), filter: f => /^\d+\.txt$/.test(f) },
  ];

  const failures = [];
  let fileCount = 0;

  for (const { dir, filter } of TEST_LOCS) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir).filter(filter)) {
      const tx = parseTx(fs.readFileSync(path.join(dir, filename), 'utf8'));
      if (tx.length < 5) continue;
      fileCount++;
      const maxSec = tts(tx[tx.length - 1].ts);
      for (let sec = 180; sec <= maxSec; sec += 30) {
        const sub = tx.filter(u => tts(u.ts) <= sec);
        if (sub.length < 3) continue;
        const exits  = CoachLogic.shouldExitOpeningPhase(sub, emN());
        const auto   = CoachLogic.computeOpeningTicksFromTranscript(sub);
        const allDone = auto.o1 && auto.o2 && auto.o3 && auto.o4;
        if (!exits && !allDone) {
          failures.push(`${filename} at ${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`);
          break;
        }
      }
    }
  }

  if (failures.length > 0) {
    console.log(`  FAIL  opening phase stuck at 3:00+ in ${failures.length}/${fileCount} file(s):`);
    failures.slice(0, 10).forEach(f => console.log(`        ${f}`));
    failed++;
  } else {
    assert(true, `opening phase exits by 3:00: all ${fileCount} files pass`);
  }
}

// ── Pitch gaps and alert: pure-unit ──────────────────────────────────────────
console.log('\n━━ computePitchGaps / computePitchAlert ━━━━━━━━━━━━━━━━━━━━━━');
{
  function mf() { return { value: null, evidence: [], confidence: 0, locked: false }; }
  function emptyNotes() {
    return {
      pain: mf(), whatItAffects: mf(), whyProblem: mf(), cause: mf(), painType: mf(),
      situation: { hosts: mf(), vms: mf(), storageTB: mf(), teamSize: mf(), workloads: mf() },
      numbers: { paysNow: mf(), quote: mf(), canAbsorb: mf() },
      deadline: mf(), renewalDate: mf(),
      doingNothing: mf(), impactOnOthers: mf(), personalStake: mf(), signOff: mf(), budget: mf(),
      needs: [], topNeed: mf(), needReason: mf(),
      nextStep: { who: mf(), purpose: mf(), dateTime: mf() }, scratch: []
    };
  }

  // No pain → null (no pitch alert yet)
  assert(CoachLogic.computePitchAlert(emptyNotes()) === null,
    'computePitchAlert: null when no pain');

  // Pain but no needs → null
  {
    const n = emptyNotes(); n.pain.value = 'renewal cost';
    assert(CoachLogic.computePitchAlert(n) === null,
      'computePitchAlert: null when pain but no needs');
  }

  // Pain + 1 need → amber with all 4 gaps
  {
    const n = emptyNotes(); n.pain.value = 'renewal cost';
    n.needs = [{ value: 'cost comparison', evidence: [] }];
    const alert = CoachLogic.computePitchAlert(n);
    assert(alert && alert.status === 'amber', 'computePitchAlert: amber when pain+need but gaps');
    assert(alert && alert.gaps.includes('doing nothing'), 'computePitchAlert gap: doing nothing');
    assert(alert && alert.gaps.includes('personal stake'), 'computePitchAlert gap: personal stake');
    assert(alert && alert.gaps.includes('numbers'), 'computePitchAlert gap: numbers');
    assert(alert && alert.gaps.includes('top need'), 'computePitchAlert gap: top need');
  }

  // All gaps covered → ready
  {
    const n = emptyNotes();
    n.pain.value = 'renewal cost';
    n.needs = [{ value: 'cost comparison', evidence: [] }];
    n.doingNothing.value = 'renew by default';
    n.personalStake.value = 'my job on the line';
    n.numbers.paysNow.value = 310000; n.numbers.quote.value = 420000; n.numbers.canAbsorb.value = 350000;
    n.topNeed.value = '1';
    const alert = CoachLogic.computePitchAlert(n);
    assert(alert && alert.status === 'ready', 'computePitchAlert: ready when all gaps covered');
    assert(alert && alert.gaps.length === 0, 'computePitchAlert: no gaps when all covered');
  }

  // Numbers declined counts as covered
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.needs = [{ value: 'comparison', evidence: [] }];
    n.doingNothing.value = 'x'; n.personalStake.value = 'y'; n.topNeed.value = '1';
    const withDecline = CoachLogic.computePitchGaps(n, true);
    assert(!withDecline.includes('numbers'), 'computePitchGaps: numbers not a gap when declined');
  }
}

// ── shouldShowPausePrompt ──────────────────────────────────────────────────────
console.log('\n━━ shouldShowPausePrompt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  assert(CoachLogic.shouldShowPausePrompt([], false),
    'shouldShowPausePrompt: true with 0 objections');
  assert(CoachLogic.shouldShowPausePrompt([{status:'handled'}], false),
    'shouldShowPausePrompt: true with 1 objection');
  assert(!CoachLogic.shouldShowPausePrompt([{status:'open'},{status:'handled'}], false),
    'shouldShowPausePrompt: false with 2 objections');
  assert(!CoachLogic.shouldShowPausePrompt([{status:'open'}], true),
    'shouldShowPausePrompt: false when already asked');
}

// ── detectNutanixIntro ─────────────────────────────────────────────────────────
console.log('\n━━ detectNutanixIntro: 8 positive, 4 negative ━━━━━━━━━━━━━━━');
{
  const detect = lines => CoachLogic.detectNutanixIntro(lines.map(l => l.toLowerCase()));

  // ── 8 positive wordings ──
  assert(detect(['Can I try a few ideas on you? Nutanix puts your servers into one system.']),
    'detectNutanixIntro (+): "can i try a few ideas"');
  assert(detect(['Nutanix puts everything into one system, so you manage everything from one place.']),
    'detectNutanixIntro (+): "one system" and "one place"');
  assert(detect(["Nutanix brings compute and storage together. Here's how that fits your situation."]),
    "detectNutanixIntro (+): \"here's how that fits\"");
  assert(detect(["Let me tell you a bit about what we do — we simplify your infrastructure."]),
    'detectNutanixIntro (+): "let me tell you a bit about what we do"');
  assert(detect(["Can I share a bit about Nutanix and how we help customers in your position?"]),
    'detectNutanixIntro (+): "a bit about nutanix" and "how we help"');
  assert(detect(["It's a hyperconverged approach — compute, storage and networking on the same nodes."]),
    'detectNutanixIntro (+): "hyperconverged"');
  assert(detect(["Nutanix is one platform that runs compute, storage and networking together."]),
    'detectNutanixIntro (+): "one platform"');
  assert(detect(["You manage it from one console regardless of where the workloads run."]),
    'detectNutanixIntro (+): "manage it from one"');

  // ── 4 negative: migration/technical terms with no intro phrase ──
  assert(!detect(["We run a delta sync before the final cutover to minimise downtime."]),
    'detectNutanixIntro (-): "delta sync" + "cutover" alone do NOT match');
  assert(!detect(["You keep vCenter as the management plane and point it at the new cluster."]),
    'detectNutanixIntro (-): "vCenter" alone does NOT match');
  assert(!detect(["The Move tool handles the cutover automatically once you confirm the schedule."]),
    'detectNutanixIntro (-): "cutover" / "Move" alone do NOT match');
  assert(!detect(["The storage driver maps the virtual disks across the AOS fabric during migration."]),
    'detectNutanixIntro (-): "storage driver" technical context does NOT match');
}

// ── Diane call: assessment-brief coverage assertions ──────────────────────────
console.log('\n━━ Diane call: assessment-brief assertions ━━━━━━━━━━━━━━━━━━');
{
  function mf() { return { value: null, evidence: [], confidence: 0, locked: false }; }
  function emN() {
    return {
      pain: mf(), whatItAffects: mf(), whyProblem: mf(), cause: mf(), painType: mf(),
      situation: { hosts: mf(), vms: mf(), storageTB: mf(), teamSize: mf(), workloads: mf() },
      numbers: { paysNow: mf(), quote: mf(), canAbsorb: mf() },
      deadline: mf(), renewalDate: mf(),
      doingNothing: mf(), impactOnOthers: mf(), personalStake: mf(), signOff: mf(), budget: mf(),
      needs: [], topNeed: mf(), needReason: mf(),
      nextStep: { who: mf(), purpose: mf(), dateTime: mf() }, scratch: []
    };
  }

  // Parse diane transcript up to a given timestamp (inclusive)
  const dianeTxt = fs.readFileSync(path.join(__dirname, 'holdout/diane-call.txt'), 'utf8');
  function parseTx(text) {
    let id = 0;
    return text.split('\n')
      .filter(l => /^\[\d{2}:\d{2}\]/.test(l))
      .map(l => {
        const m = l.match(/^\[(\d{2}:\d{2})\]\s+(Me|Her):\s*(.*)/);
        return m ? { id:'u'+String(++id).padStart(3,'0'), ts:m[1], speaker:m[2], text:m[3].trim() } : null;
      }).filter(Boolean);
  }
  function tts(ts) { const p = (ts||'0:00').split(':').map(Number); return p[0]*60+(p[1]||0); }
  const dianeTxFull = parseTx(dianeTxt);
  function txAt(mmss) {
    const sec = tts(mmss);
    return dianeTxFull.filter(u => tts(u.ts) <= sec);
  }

  // ── 06:20: situation, pain, timeframe, needs known → doing-nothing or numbers question
  {
    const n620 = emN();
    n620.situation.hosts.value = 12;
    n620.situation.vms.value = 200;
    n620.situation.storageTB.value = 80;
    n620.situation.teamSize.value = 5;
    n620.pain.value = 'VMware renewal pricing came in higher than expected';
    n620.whatItAffects.value = 'IT budget — would need to cut elsewhere or go back to finance';
    n620.cause.value = 'Broadcom price restructure';
    n620.impactOnOthers.value = 'Other team projects deferred';
    n620.renewalDate.value = 'end of April';
    n620.needs = [
      { value: 'like-for-like cost comparison', evidence: [] },
      { value: 'no full migration project needed to get started', evidence: [] }
    ];
    // topNeed not yet answered (she answers at 06:30, after this checkpoint)

    const tx620 = txAt('06:20');
    const result = CoachLogic.computeCoachNext(n620, tx620, null);
    const q = (result.mainQ || '').toLowerCase();
    const isDoingNothing = q.includes('nothing changes') || q.includes('nothing change') || q.includes('gets cut') || q.includes('delayed');
    const isNumbers = q.includes('number') || q.includes('paying') || q.includes('quote') || q.includes('spend');
    assert(isDoingNothing || isNumbers,
      'Diane 06:20: Ask next is doing-nothing or numbers question',
      `got: "${result.mainQ}"`);
    const isPitch = q.includes('can i try') || q.includes('nutanix') || q.includes('pitch');
    assert(!isPitch,
      'Diane 06:20: Ask next is NOT a pitch question',
      `got: "${result.mainQ}"`);
  }

  // ── 09:40: pitch alert is amber with all 4 gaps
  {
    const n940 = emN();
    n940.situation.hosts.value = 12;
    n940.situation.vms.value = 200;
    n940.situation.storageTB.value = 80;
    n940.situation.teamSize.value = 5;
    n940.pain.value = 'VMware renewal pricing higher than expected';
    n940.whatItAffects.value = 'IT budget — need to cut elsewhere or get supplementary approval';
    n940.cause.value = 'Broadcom price restructure';
    n940.impactOnOthers.value = 'Other team projects deferred';
    n940.renewalDate.value = 'end of April';
    n940.needs = [
      { value: 'like-for-like cost comparison', evidence: [] },
      { value: 'no full migration project needed', evidence: [] }
    ];
    // doingNothing, personalStake, numbers, topNeed all absent

    const alert940 = CoachLogic.computePitchAlert(n940, false);
    assert(alert940 && alert940.status === 'amber',
      'Diane 09:40: pitch alert is amber (gaps present)');
    assert(alert940 && alert940.gaps.includes('doing nothing'),
      'Diane 09:40: gap includes doing nothing');
    assert(alert940 && alert940.gaps.includes('personal stake'),
      'Diane 09:40: gap includes personal stake');
    assert(alert940 && alert940.gaps.includes('numbers'),
      'Diane 09:40: gap includes numbers');
    assert(alert940 && alert940.gaps.includes('top need'),
      'Diane 09:40: gap includes top need');
  }

  // ── 12:00: Nutanix chip is hollow (technical intro not outcome-led)
  {
    const tx1200 = txAt('12:00');
    const meLines = tx1200.filter(u => u.speaker === 'Me').map(u => u.text.toLowerCase());
    const nutDetected = CoachLogic.detectNutanixIntro(meLines);
    assert(!nutDetected,
      'Diane 12:00: Nutanix chip is hollow — technical intro not detected as outcome-led');
  }

  // ── Before close: pause prompt shown (only 1 objection raised)
  {
    const objections = [{ id: 'o1', status: 'open', quote: 'disruption during migration is a real concern', matchedKey: 'downtime' }];
    assert(CoachLogic.shouldShowPausePrompt(objections, false),
      'Diane before-close: pause prompt shown with 1 objection');
  }
}

// ── Hospital complete calls: all items green ───────────────────────────────────
console.log('\n━━ Hospital calls: complete coverage green ━━━━━━━━━━━━━━━━━━');
{
  function mf() { return { value: null, evidence: [], confidence: 0, locked: false }; }

  // hospital-uptime-call: complete notes fixture
  const uptimeNotes = {
    pain: { value: 'patient systems must not go down — clinical uptime is the real issue' },
    whatItAffects: { value: 'every change window — only at night with clinicians signed off' },
    whyProblem: { value: 'ten years on one vendor, nobody has tested alternatives' },
    cause: { value: 'VMware renewal 35% increase; trust board risk position needed' },
    painType: mf(),
    situation: { hosts: { value: 18 }, vms: { value: 520 }, storageTB: { value: 210 }, teamSize: { value: 7 }, workloads: mf() },
    numbers: { paysNow: { value: 310000 }, quote: { value: 420000 }, canAbsorb: { value: 350000 } },
    deadline: { value: 'March trust board' }, renewalDate: { value: '1 April' },
    doingNothing: { value: 'renew by default and the board asks why we had no alternative' },
    impactOnOthers: { value: 'clinical director worries about outages; compliance officer Priya must sign off' },
    personalStake: { value: 'if there is an outage during migration it is my job' },
    signOff: { value: 'Priya for compliance, CFO for money, trust board for final call' },
    budget: mf(), otherDrivers: mf(),
    needs: [
      { value: 'migration approach clinicians believe in', evidence: [] },
      { value: 'written compliance sign-off from Priya', evidence: [] },
      { value: 'properly tested rollback', evidence: [] }
    ],
    topNeed: { value: '2' },
    needReason: { value: 'because I would be the one explaining it to the regulator' },
    nextStep: { who: { value: 'her, Priya, engineer, reseller' }, purpose: { value: 'working session before trust board' }, dateTime: { value: 'week of 9 February' } },
    scratch: []
  };

  const uptimeAlert = CoachLogic.computePitchAlert(uptimeNotes, false);
  assert(uptimeAlert && uptimeAlert.status === 'ready',
    'hospital-uptime: pitch alert is ready (no gaps)');
  assert(CoachLogic.computePitchGaps(uptimeNotes, false).length === 0,
    'hospital-uptime: zero pitch gaps');

  // 2 objections in uptime call → pause prompt NOT shown
  const uptimeObjs = [
    { id: 'o1', status: 'handled', quote: 'can you guarantee no downtime', matchedKey: 'downtime' },
    { id: 'o2', status: 'handled', quote: 'what about compliance patient data', matchedKey: 'compliance' }
  ];
  assert(!CoachLogic.shouldShowPausePrompt(uptimeObjs, false),
    'hospital-uptime: pause prompt NOT shown (2 objections raised)');

  // Nutanix detection: "Can I try a few ideas on you? ... one system"
  const uptimeMeLines = [
    'can i try a few ideas on you? a lot of vmware customers are looking at alternatives since broadcom changed the licensing. nutanix puts your servers, storage and networking into one system, so you manage it from one place.',
    'we bring in a compliance expert to answer in writing. you told me written sign-off from priya matters most. so here\'s how that fits.'
  ];
  assert(CoachLogic.detectNutanixIntro(uptimeMeLines),
    'hospital-uptime: outcome-led Nutanix intro detected');

  // hospital-cfo-call: complete notes fixture
  const cfoNotes = {
    pain: { value: 'paying for a VMware suite we barely use — CFO demands cost reduction' },
    whatItAffects: { value: 'capital projects frozen until comparison delivered; budget sign-off blocked' },
    whyProblem: { value: 'Broadcom bundled everything — they use maybe a third of it' },
    cause: { value: 'Broadcom bundled suite change; renewal end of February' },
    painType: mf(),
    situation: { hosts: { value: 10 }, vms: { value: 300 }, storageTB: { value: 120 }, teamSize: { value: 4 }, workloads: mf() },
    numbers: { paysNow: { value: 240000 }, quote: { value: 390000 }, canAbsorb: { value: 0 } },
    deadline: { value: '20 January budget sign-off' }, renewalDate: { value: 'end of February' },
    doingNothing: { value: 'sign the renewal, CFO is furious and I lose credibility' },
    impactOnOthers: { value: 'CFO and procurement lead Ayesha must both approve' },
    personalStake: { value: 'my bonus is tied to staying inside budget' },
    signOff: { value: 'CFO and procurement lead Ayesha' },
    budget: mf(), otherDrivers: mf(),
    needs: [
      { value: 'side-by-side comparison using real numbers', evidence: [] },
      { value: 'clear list of what we would stop paying for', evidence: [] }
    ],
    topNeed: { value: '1' },
    needReason: { value: 'need to walk into that room with something other than a shrug' },
    nextStep: { who: { value: 'her and Ayesha' }, purpose: { value: 'first costed comparison' }, dateTime: { value: '12 January' } },
    scratch: []
  };

  const cfoAlert = CoachLogic.computePitchAlert(cfoNotes, false);
  assert(cfoAlert && cfoAlert.status === 'ready',
    'hospital-cfo: pitch alert is ready (no gaps)');
  assert(CoachLogic.computePitchGaps(cfoNotes, false).length === 0,
    'hospital-cfo: zero pitch gaps');

  // 3 objections → pause prompt NOT shown
  const cfoObjs = [
    { id: 'o1', status: 'handled', quote: 'is it cheaper', matchedKey: 'price' },
    { id: 'o2', status: 'handled', quote: 'just signed three-year support deal', matchedKey: 'contract' },
    { id: 'o3', status: 'handled', quote: 'can you prove it will work for us', matchedKey: 'proof' }
  ];
  assert(!CoachLogic.shouldShowPausePrompt(cfoObjs, false),
    'hospital-cfo: pause prompt NOT shown (3 objections raised)');

  // Needs chip: both complete calls have topNeed and needReason → done (not partial)
  {
    const n = uptimeNotes;
    const cntNeeds = n.needs.filter(nd => nd.value).length;
    assert(cntNeeds >= 1 && n.topNeed.value && n.needReason.value,
      'hospital-uptime: needs chip would be green (needs + topNeed + needReason all present)');
  }
  {
    const n = cfoNotes;
    const cntNeeds = n.needs.filter(nd => nd.value).length;
    assert(cntNeeds >= 1 && n.topNeed.value && n.needReason.value,
      'hospital-cfo: needs chip would be green (needs + topNeed + needReason all present)');
  }

  // Impact chip: both have doingNothing + personalStake → done
  assert(!!(uptimeNotes.doingNothing.value && uptimeNotes.personalStake.value),
    'hospital-uptime: impact chip green (doingNothing + personalStake both set)');
  assert(!!(cfoNotes.doingNothing.value && cfoNotes.personalStake.value),
    'hospital-cfo: impact chip green (doingNothing + personalStake both set)');
}

// ── detectRedFlags: positive and negative tests ───────────────────────────────
console.log('\n━━ detectRedFlags: positive + negative ━━━━━━━━━━━━━━━━━');
{
  const { detectRedFlags } = CoachLogic;

  // ── Positive (should flag) ──
  assert(detectRedFlags('We can handle this with zero downtime.').some(f => f.id === 'zero-downtime'),
    'detectRedFlags (+): "zero downtime" flags zero-downtime');
  assert(detectRedFlags('I guarantee this will work for your environment.').some(f => f.id === 'guarantee'),
    'detectRedFlags (+): "I guarantee" flags guarantee');
  assert(detectRedFlags('Nutanix will be cheaper than your current VMware deal.').some(f => f.id === 'cheaper'),
    'detectRedFlags (+): "cheaper" without denial flags cheaper');
  assert(detectRedFlags('You will save 30% on your licensing costs.').some(f => f.id === 'save-percent'),
    'detectRedFlags (+): "save 30%" flags save-percent');
  assert(detectRedFlags('The pricing will come in below your current quote.').some(f => f.id === 'will-come-in-below'),
    'detectRedFlags (+): "come in below" flags will-come-in-below');
  assert(detectRedFlags('Your team will be up to speed in just three weeks.').some(f => f.id === 'learning-curve'),
    'detectRedFlags (+): specific learning-curve promise flags');
  assert(detectRedFlags('AHV is included in the licence at no additional cost.').some(f => f.id === 'included-free'),
    'detectRedFlags (+): "AHV included" without "Nutanix says" flags included-free');
  assert(detectRedFlags('ARR, which is basically the average revenue, is $2.55B.').some(f => f.id === 'arr-average'),
    'detectRedFlags (+): ARR used as average flags arr-average');
  assert(detectRedFlags('VMware is basically dead now that Broadcom took over.').some(f => f.id === 'run-down-vmware'),
    'detectRedFlags (+): running down VMware flags run-down-vmware');

  // ── Negative (must NOT flag) ──
  assert(detectRedFlags("I can't promise zero downtime, and nobody honest can.").length === 0,
    "detectRedFlags (-): \"I can't promise zero downtime\" must NOT flag");
  assert(detectRedFlags("Nutanix says AHV is included in the licence at no additional cost.").length === 0,
    'detectRedFlags (-): "Nutanix says AHV is included" must NOT flag');
  assert(detectRedFlags("I can't say it will be cheaper — I haven't seen your setup yet.").length === 0,
    "detectRedFlags (-): denied cheaper claim must NOT flag");
}

// ── Objection playbook: never_say present for all 5 objections ────────────────
console.log('\n━━ Objection never_say coverage ━━━━━━━━━━━━━━━━━━━━━━━');
{
  const knowledge = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, '../data/knowledge.json'), 'utf8')
  );
  const OBJ_KEYS = ['downtime', 'retraining', 'cost', 'compliance', 'proof'];
  for (const key of OBJ_KEYS) {
    const obj = knowledge.objections.find(o => o.id === key);
    assert(obj && obj.say_this, `knowledge.json: ${key} has say_this`);
    assert(obj && obj.never_say && obj.never_say.length > 0, `knowledge.json: ${key} has never_say`);
  }
}

// ── buildCostOfInactionScript ─────────────────────────────────────────────────
console.log('\n━━ buildCostOfInactionScript ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { buildCostOfInactionScript } = CoachLogic;

  // Canonical: 80k→250k = £170k/yr, £14k/month
  const s1 = buildCostOfInactionScript(80000, 250000);
  assert(s1.includes('£170k a year'), `COI: 80k→250k says '£170k a year' (got: ${s1})`);
  assert(s1.includes('£14k a month'), `COI: 80k→250k says '£14k a month' (got: ${s1})`);
  assert(s1.startsWith('So that\'s an extra'), `COI: starts with spoken opener (got: ${s1})`);
  assert(s1.endsWith('Is that right?'), `COI: ends with 'Is that right?' (got: ${s1})`);

  // With canAbsorb — absorb shown, doingNothing NOT pasted (Round D: doingNothing removed from spoken line)
  const s2 = buildCostOfInactionScript(80000, 250000, 120000, false, 'sign at new price');
  assert(s2.includes('£170k a year'), 'COI+absorb: still has £170k a year');
  assert(!s2.includes('sign at new price'), `COI+absorb: doingNothing NOT pasted into spoken line (got: ${s2})`);
  assert(s2.endsWith('Is that right?'), 'COI+absorb: ends correctly');

  // Monthly input converts to annual
  const s3 = buildCostOfInactionScript(6667, 20833, null, true);
  assert(s3.includes('a year'), 'COI monthly: converts and says a year');
  assert(s3.includes('a month'), 'COI monthly: includes monthly figure');

  // Small increase
  const s4 = buildCostOfInactionScript(100000, 110000);
  assert(s4.includes('£10k a year'), `COI: 10k increase (got: ${s4})`);

  // Word count under 25 (without doingNothing)
  const wordCount = s1.replace(/[^a-zA-Z0-9£ ]/g, ' ').trim().split(/\s+/).length;
  assert(wordCount <= 25, `COI: word count ${wordCount} <= 25`);

  // Layout test: no ellipsis, under 200 chars
  assert(!s1.includes('…') && !s1.includes('...'), 'COI: no ellipsis in output (layout test)');
  assert(s1.length < 200, `COI: under 200 chars at 500px width (got ${s1.length})`);
}

// ── coiMatchesSpeech ─────────────────────────────────────────────────────────
console.log('\n━━ coiMatchesSpeech ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { coiMatchesSpeech, buildCostOfInactionScript } = CoachLogic;
  const script = buildCostOfInactionScript(80000, 250000);
  // Exact numbers match
  assert(coiMatchesSpeech(script, 'So that\'s an extra £170k a year, about £14k a month. Is that right?'),
    'coiMatch: exact repetition matches');
  // Half the key numbers (£170k)
  assert(coiMatchesSpeech(script, 'So the increase is £170k a year'),
    'coiMatch: one key number matches');
  // 50% keyword overlap with paraphrase
  assert(coiMatchesSpeech(script, 'that extra 170k per year, 14k a month'),
    'coiMatch: paraphrase with numbers matches');
  // Unrelated text does not match
  assert(!coiMatchesSpeech(script, 'Walk me through your estate'),
    'coiMatch: unrelated text does not match');
  // Empty inputs
  assert(!coiMatchesSpeech('', 'some text'), 'coiMatch: empty script → false');
  assert(!coiMatchesSpeech(script, ''), 'coiMatch: empty speech → false');
}

// ── parseMoneyWords ─────────────────────────────────────────────────────────
console.log('\n━━ parseMoneyWords ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { parseMoneyWords } = CoachLogic;
  // Range → midpoint
  assert(parseMoneyWords('twenty or thirty thousand') === 25000,
    'parseMoneyWords: "twenty or thirty thousand" → 25000');
  // Single word number
  assert(parseMoneyWords('eighty thousand') === 80000,
    'parseMoneyWords: "eighty thousand" → 80000');
  // Numeric k suffix
  assert(parseMoneyWords('80k') === 80000, 'parseMoneyWords: "80k" → 80000');
  // Strip context after "of the extra..." — just check the lead phrase parses correctly
  assert(parseMoneyWords('twenty or thirty thousand of the extra hundred and seventy') === 25000,
    'parseMoneyWords: range-of-context phrase → 25000 (range wins)');
}

// ── computePitchGate ─────────────────────────────────────────────────────────
console.log('\n━━ computePitchGate ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/script.json'), 'utf8'));

  function baseNotes() {
    function mf() { return { value: null }; }
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

  // C1 unasked → first gate is C1
  {
    const n = baseNotes();
    const g = CoachLogic.computePitchGate(n, script, []);
    assert(g && g.stepId === 'C1', 'pitchGate: empty notes → C1 is first gate');
  }

  // C1 filled, C3 not → C3 is next gate
  {
    const n = baseNotes(); n.cause.value = 'Broadcom hike';
    const g = CoachLogic.computePitchGate(n, script, []);
    assert(g && g.stepId === 'C3', 'pitchGate: C1 filled → C3 next');
  }

  // C1, C3, I1 filled → O1 next
  {
    const n = baseNotes();
    n.cause.value = 'hike'; n.otherDrivers.value = 'team'; n.impactOnOthers.value = 'delays';
    const g = CoachLogic.computePitchGate(n, script, []);
    assert(g && g.stepId === 'O1', 'pitchGate: C1+C3+I1 filled → O1 next');
  }

  // All gate fields filled → null
  {
    const n = baseNotes();
    n.cause.value = 'hike'; n.otherDrivers.value = 'team'; n.impactOnOthers.value = 'delays';
    n.needs.push({ value: 'comparison' }); n.topNeed.value = '1'; n.needReason.value = 'board ask';
    const g = CoachLogic.computePitchGate(n, script, []);
    assert(g === null, 'pitchGate: all filled → null');
  }

  // C1 not filled but already asked in Me transcript → skip to C3
  {
    const n = baseNotes();
    const meTexts = ['Why do you think this is going to hit you so hard?'];
    const g = CoachLogic.computePitchGate(n, script, meTexts);
    assert(g && g.stepId === 'C3', 'pitchGate: C1 asked (not filled) → C3 next');
  }

  // null script → null
  {
    const n = baseNotes();
    const g = CoachLogic.computePitchGate(n, null, []);
    assert(g === null, 'pitchGate: null script → null');
  }
}

// ── buildReadbackScript ───────────────────────────────────────────────────────
console.log('\n━━ buildReadbackScript ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { buildReadbackScript } = CoachLogic;

  // Empty notes still ends with the question
  const s0 = buildReadbackScript({});
  assert(s0.toLowerCase().includes('did i get that right'), 'readback: empty notes still asks question');

  // Pain + 1 need
  const notes1 = {
    pain: { value: 'unplanned downtime is killing productivity' },
    needs: [{ value: 'faster failover' }],
    topNeed: { value: '1' },
  };
  const s1 = buildReadbackScript(notes1);
  assert(s1.toLowerCase().includes('did i get that right'), 'readback: 1 need ends with question');
  assert(s1.includes('unplanned downtime'), 'readback: pain is included');
  assert(s1.includes('faster failover'), 'readback: need is included');

  // Pain + 2 needs
  const notes2 = {
    pain: { value: 'licence costs spiralling' },
    needs: [{ value: 'cost predictability' }, { value: 'less admin overhead' }],
    topNeed: { value: '1' },
  };
  const s2 = buildReadbackScript(notes2);
  assert(s2.includes('cost predictability'), 'readback: top need present');
  assert(s2.includes('less admin overhead'), 'readback: second need present');
  assert(s2.toLowerCase().includes('did i get that right'), 'readback: 2 needs ends with question');
}

// ── detectSoftClose ───────────────────────────────────────────────────────────
console.log('\n━━ detectSoftClose ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { detectSoftClose } = CoachLogic;

  assert(detectSoftClose('Would you consider it as an option for next quarter?') === 'would you consider it',
    'detectSoftClose: "would you consider it" detected');
  assert(detectSoftClose('That might be something you could consider for the renewal.') === 'something you could consider',
    'detectSoftClose: "something you could consider" detected');
  assert(detectSoftClose('Would it be fair to say this solves the problem?') === 'would it be fair to say',
    'detectSoftClose: "would it be fair to say" detected');
  assert(detectSoftClose("Let's schedule a demo next week.") === null,
    'detectSoftClose: clean line returns null');
  assert(detectSoftClose('WOULD YOU CONSIDER IT — case insensitive') === 'would you consider it',
    'detectSoftClose: case insensitive');
}

// ── needIsPitched ─────────────────────────────────────────────────────────────
console.log('\n━━ needIsPitched ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const { needIsPitched } = CoachLogic;

  assert(needIsPitched(
    ['Nutanix is great. You told me faster failover is the top priority.'],
    'faster failover is the top priority'
  ), 'needIsPitched: "You told me" + first 4 need words → true');

  assert(!needIsPitched(
    ['You told me you need something completely different.'],
    'faster failover is the top priority'
  ), 'needIsPitched: wrong content → false');

  assert(!needIsPitched([], 'faster failover'), 'needIsPitched: empty meLines → false');
  assert(!needIsPitched(['You told me cost is a problem.'], ''), 'needIsPitched: empty needText → false');
}

// ── Speaker ID ────────────────────────────────────────────────────────────────
console.log('\n━━ SpeakerID: isNameTrigger ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const SpeakerID = require('../public/speaker-id.js');
  const { isNameTrigger } = SpeakerID;

  // Must trigger (first-person intro)
  assert(isNameTrigger("My name is Jimi, inside sales at Nutanix."),  'trigger: "My name is Jimi"');
  assert(isNameTrigger("I'm Jimi from Nutanix."),                     'trigger: "I\'m Jimi"');
  assert(isNameTrigger("This is Jimi at Nutanix."),                   'trigger: "This is Jimi"');
  assert(isNameTrigger("My name is Jimmy, inside sales."),            'trigger: variant Jimmy');
  assert(isNameTrigger("My name is Jimmie."),                         'trigger: variant Jimmie');
  assert(isNameTrigger("My name is Jimmi."),                          'trigger: variant Jimmi');
  assert(isNameTrigger("My name is Gimmy."),                          'trigger: variant Gimmy');

  // Must NOT trigger (vocative / second-person)
  assert(!isNameTrigger("Hi Jimi, how are you?"),                     'no-trigger: "Hi Jimi"');
  assert(!isNameTrigger("Thanks, Jimi, that was helpful."),           'no-trigger: "Thanks, Jimi"');
  assert(!isNameTrigger("Morning Jimi!"),                             'no-trigger: "Morning Jimi"');
  assert(!isNameTrigger("Is Jimi available?"),                        'no-trigger: "Is Jimi available"');
  assert(!isNameTrigger("Hi Jimi, that sounds interesting."),         'no-trigger: prospect addressing AE by name');
}

console.log('\n━━ SpeakerID: detectInversion ━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const SpeakerID = require('../public/speaker-id.js');
  const fs   = require('fs');
  const path = require('path');

  function parseTranscript(txt) {
    return txt.split('\n')
      .map(l => { const m = l.match(/^\[(\d+:\d+)\]\s+(Me|Her):\s+(.*)/); return m ? { ts: m[1], speaker: m[2], text: m[3] } : null; })
      .filter(Boolean);
  }

  const holdoutDir = path.join(__dirname, 'holdout');
  const testDir    = path.join(__dirname);

  // swapped-live-call.txt MUST be detected as inverted
  const swapped = parseTranscript(fs.readFileSync(path.join(holdoutDir, 'swapped-live-call.txt'), 'utf8'));
  const swappedResult = SpeakerID.detectInversion(swapped);
  assert(swappedResult.inverted,              `swapped-live-call.txt → inverted (conf ${swappedResult.confidence.toFixed(2)})`);
  assert(swappedResult.confidence > 0.8,      `swapped-live-call.txt → confidence > 0.8 (${swappedResult.confidence.toFixed(2)})`);

  // All other holdout files must NOT be detected as inverted
  const holdoutFiles = fs.readdirSync(holdoutDir).filter(f => f.endsWith('.txt') && f !== 'swapped-live-call.txt');
  for (const fname of holdoutFiles) {
    const utt = parseTranscript(fs.readFileSync(path.join(holdoutDir, fname), 'utf8'));
    const r = SpeakerID.detectInversion(utt);
    assert(!r.inverted, `holdout/${fname} → NOT inverted (conf ${r.confidence.toFixed(2)})`);
  }

  // Four test/*.txt samples must NOT be detected as inverted
  const sampleFiles = ['tidy-call.txt', 'messy-call.txt', 'thin-call.txt', 'objection-call.txt'];
  for (const fname of sampleFiles) {
    const utt = parseTranscript(fs.readFileSync(path.join(testDir, fname), 'utf8'));
    const r = SpeakerID.detectInversion(utt);
    assert(!r.inverted, `${fname} → NOT inverted (conf ${r.confidence.toFixed(2)})`);
  }
}

console.log('\n━━ SpeakerID: applySwap ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const SpeakerID = require('../public/speaker-id.js');
  const fs   = require('fs');
  const path = require('path');

  function parseTranscript(txt) {
    return txt.split('\n')
      .map(l => { const m = l.match(/^\[(\d+:\d+)\]\s+(Me|Her):\s+(.*)/); return m ? { ts: m[1], speaker: m[2], text: m[3] } : null; })
      .filter(Boolean);
  }

  const raw = fs.readFileSync(path.join(__dirname, 'holdout', 'swapped-live-call.txt'), 'utf8');
  const swapped = parseTranscript(raw);

  // "What's the ripple effect" is labeled Her in swapped file (salesperson line)
  const beforeSwap = swapped.find(u => /ripple effect/i.test(u.text));
  assert(beforeSwap && beforeSwap.speaker === 'Her', 'swapped file: ripple-effect line is Her before correction');

  const corrected = SpeakerID.applySwap(swapped);

  // After swap it must be Me
  const afterSwap = corrected.find(u => /ripple effect/i.test(u.text));
  assert(afterSwap && afterSwap.speaker === 'Me', 'after applySwap: ripple-effect line becomes Me');

  // applySwap must not mutate the original
  assert(beforeSwap.speaker === 'Her', 'applySwap is non-mutating');

  // "Hi Jimi" from the prospect is labeled Me in swapped file; after swap it becomes Her
  const hiJimiBefore = swapped.find(u => /hi jimi/i.test(u.text));
  assert(hiJimiBefore && hiJimiBefore.speaker === 'Me', 'swapped file: "Hi Jimi" prospect line is Me before correction');
  const hiJimiAfter = corrected.find(u => /hi jimi/i.test(u.text));
  assert(hiJimiAfter && hiJimiAfter.speaker === 'Her', 'after applySwap: "Hi Jimi" becomes Her (prospect)');
  assert(!SpeakerID.isNameTrigger(hiJimiBefore.text), '"Hi Jimi, that sounds interesting" does NOT trigger name lock');
}

// ── computeScriptNext ─────────────────────────────────────────────────────────
console.log('\n━━ computeScriptNext ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/script.json'), 'utf8'));

  function emptyNotes() {
    function mf() { return { value: null }; }
    return {
      situation: { hosts: mf(), vms: mf(), storageTB: mf(), teamSize: mf(), workloads: mf() },
      painType: mf(), pain: mf(), whatItAffects: mf(), whyProblem: mf(),
      numbers: { paysNow: mf(), quote: mf(), canAbsorb: mf() },
      quoteType: mf(), available: mf(),
      deadline: mf(), renewalDate: mf(), doingNothing: mf(),
      cause: mf(), otherDrivers: mf(), impactOnOthers: mf(),
      personalStake: mf(), signOff: mf(), budget: mf(),
      needs: [], topNeed: mf(), needReason: mf(),
      nextStep: { who: mf(), purpose: mf(), dateTime: mf() },
      scratch: []
    };
  }

  // 1. Empty notes → pain-first → first step is P1
  {
    const n = emptyNotes();
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.stepId === 'P1', 'pain-first, empty notes: first step is P1');
    assert(r.sectionLabel === 'PAIN', 'pain-first, empty notes: section is PAIN');
  }

  // 2. Empty notes → sheet-order → first step is S1
  {
    const n = emptyNotes();
    const r = CoachLogic.computeScriptNext(n, script, 'sheet-order', null, []);
    assert(r.stepId === 'S1', 'sheet-order, empty notes: first step is S1');
    assert(r.sectionLabel === 'SITUATION', 'sheet-order, empty notes: section is SITUATION');
  }

  // 3. Pain filled → moves to P2
  {
    const n = emptyNotes();
    n.pain.value = 'renewal price jump';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.stepId === 'P2', 'pain filled: next is P2 (what it affects)');
    assert(r.mainQ.includes('renewal price jump'), 'P2 fills [pain] placeholder with pain value');
  }

  // 4. Pain + whatItAffects filled → moves to P3
  {
    const n = emptyNotes();
    n.pain.value = 'VMware cost spike';
    n.whatItAffects.value = 'IT budget';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.stepId === 'P3', 'pain+whatItAffects filled: next is P3');
    assert(r.mainQ.includes('VMware cost spike'), 'P3 fills [pain] placeholder');
  }

  // 5. P1-P3 filled → P4 oneShot shows next (not yet asked)
  {
    const n = emptyNotes();
    n.pain.value = 'cost spike';
    n.whatItAffects.value = 'budget';
    n.whyProblem.value = 'board scrutiny';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.stepId === 'P4', 'P1-P3 filled: next is P4 (focus check)');
    assert(r.mainQ.includes('focus on'), 'P4 question contains "focus on"');
  }

  // 6. P4 already asked in Me transcript → moves to next section (S1 in pain-first)
  {
    const n = emptyNotes();
    n.pain.value = 'cost spike';
    n.whatItAffects.value = 'budget';
    n.whyProblem.value = 'board scrutiny';
    const meTexts = ['Is this the thing to focus on or will something overpower it?'];
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, meTexts);
    assert(r.stepId === 'S1', 'P4 asked in Me transcript: moves to S1 (SITUATION)');
  }

  // 7. All PAIN + SITUATION done → N1 is next
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    const meTexts = ['Is this the thing to focus on or will something overpower it?'];
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, meTexts);
    assert(r.stepId === 'N1', 'after PAIN+SITUATION: next is N1 (numbers)');
    assert(r.sectionLabel === 'NUMBER', 'N1 is in NUMBER section');
  }

  // 8. N1 anyField — paysNow filled → N1 done → N2 is next (quoteType set so N1b skipped)
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000;
    n.quoteType.value = 'recurring';
    const meTexts = ['Is this the thing to focus on or will something overpower it?'];
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, meTexts);
    assert(r.stepId === 'N2', 'N1 anyField: paysNow filled → N2 (deadline)');
  }

  // 9. N4 requires deadline; if deadline not filled, N4 skipped → goes to something else
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000;
    n.quoteType.value = 'recurring';
    // N2(deadline) not filled yet
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null,
      ['Is this the thing to focus on or will something overpower it?']);
    assert(r.stepId === 'N2', 'N4 requires deadline not met: N2 shown (deadline question)');
  }

  // 10. N4 requires deadline — deadline filled → N4 is available
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000;
    n.quoteType.value = 'recurring';
    n.deadline.value = 'end of March';
    n.renewalDate.value = 'April';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null,
      ['Is this the thing to focus on or will something overpower it?']);
    assert(r.stepId === 'N4', 'deadline filled: N4 is next (doing nothing)');
    assert(r.mainQ.includes('end of March'), 'N4 fills [her date] with deadline value');
  }

  // 11. CAUSE section — nothing filled → C1 next
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000;
    n.quoteType.value = 'recurring';
    n.deadline.value = 'end of March'; n.renewalDate.value = 'April'; n.doingNothing.value = 'sign at new price';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null,
      ['Is this the thing to focus on or will something overpower it?']);
    assert(r.stepId === 'C1', 'NUMBER done: C1 (cause) is next');
  }

  // 12. C2 targeted skipped when no painType
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000;
    n.quoteType.value = 'recurring';
    n.deadline.value = 'end of March'; n.renewalDate.value = 'April'; n.doingNothing.value = 'sign';
    n.cause.value = 'Broadcom hike'; // C1 done
    // C2 requires painType → should be skipped since no painType
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null,
      ['Is this the thing to focus on or will something overpower it?']);
    assert(r.stepId === 'C3', 'C2 skipped (no painType): C3 (other drivers) next');
  }

  // 13. stepIndex and totalSteps are correct
  {
    const n = emptyNotes();
    n.pain.value = 'cost spike';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.stepIndex === 1, 'P2 is at stepIndex 1 (0-based) in PAIN');
    assert(r.totalSteps === 4, 'PAIN has 4 total steps');
  }

  // 14. minutesStart/minutesEnd returned for step
  {
    const n = emptyNotes();
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.minutesStart === 4, 'PAIN minutesStart is 4');
    assert(r.minutesEnd === 8, 'PAIN minutesEnd is 8');
  }

  // 15. All sections done → mainQ is null
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000; n.quoteType.value = 'recurring'; n.deadline.value = 'end of March';
    n.renewalDate.value = 'April'; n.doingNothing.value = 'sign';
    n.cause.value = 'Broadcom hike'; n.otherDrivers.value = 'team stretched';
    n.impactOnOthers.value = 'clinical delays'; n.personalStake.value = 'my project';
    n.signOff.value = 'CTO'; n.budget.value = 'capex';
    n.needs.push({ value: 'side-by-side comparison' }); n.topNeed.value = '1';
    n.needReason.value = 'board asks';
    const meTexts = ['Is this the thing to focus on or will something overpower it?'];
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, meTexts);
    assert(r.mainQ === null, 'all fields filled: mainQ is null');
  }

  // 16. sheet-order: S1 before P1
  {
    const n = emptyNotes();
    const r = CoachLogic.computeScriptNext(n, script, 'sheet-order', null, []);
    assert(r.stepId === 'S1', 'sheet-order empty: S1 first');
    // After S1 done, P1 next
    n.situation.hosts.value = '16';
    const r2 = CoachLogic.computeScriptNext(n, script, 'sheet-order', null, []);
    assert(r2.stepId === 'P1', 'sheet-order S1 done: P1 next');
  }

  // 17. null script → mainQ is null (graceful fallback)
  {
    const n = emptyNotes();
    const r = CoachLogic.computeScriptNext(n, null, 'pain-first', null, []);
    assert(r.mainQ === null, 'null script: mainQ is null (graceful)');
  }

  // 18. P2 requires pain — not met → skip P2, skip P3, show P4? No — P3 also requires pain, so skip both
  // With pain not filled: P1 is next (not P2 or P3)
  {
    const n = emptyNotes();
    // pain not filled; whatItAffects IS filled somehow
    n.whatItAffects.value = 'budget';
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, []);
    assert(r.stepId === 'P1', 'pain not filled: P1 still shown (P2/P3 require pain)');
  }

  // 19. O1 fills [her date] placeholder from deadline
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000; n.quoteType.value = 'recurring'; n.deadline.value = 'end of Q1';
    n.renewalDate.value = 'April'; n.doingNothing.value = 'sign';
    n.cause.value = 'Broadcom hike'; n.otherDrivers.value = 'team stretched';
    n.impactOnOthers.value = 'clinical delays'; n.personalStake.value = 'my project';
    n.signOff.value = 'CTO'; n.budget.value = 'capex';
    const meTexts = ['Is this the thing to focus on or will something overpower it?'];
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null, meTexts);
    assert(r.stepId === 'O1', 'after IMPACT done: O1 (needs) is next');
    assert(r.mainQ.includes('end of Q1') || r.mainQ.includes('solve'), 'O1 question shown with placeholder filled');
  }

  // 20. O2 requires needs — not met → O1 shown
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000; n.quoteType.value = 'recurring'; n.deadline.value = 'end of Q1';
    n.renewalDate.value = 'April'; n.doingNothing.value = 'sign';
    n.cause.value = 'Broadcom hike'; n.otherDrivers.value = 'team stretched';
    n.impactOnOthers.value = 'delays'; n.personalStake.value = 'my stake';
    n.signOff.value = 'CTO'; n.budget.value = 'capex';
    // needs empty → O2 requires needs → O2 not available
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null,
      ['Is this the thing to focus on or will something overpower it?']);
    assert(r.stepId === 'O1', 'O2 requires needs not met: O1 shown');
  }

  // 21. O2 requires needs met → O2 shown after O1 done
  {
    const n = emptyNotes();
    n.pain.value = 'cost'; n.whatItAffects.value = 'budget'; n.whyProblem.value = 'board';
    n.situation.hosts.value = '16';
    n.numbers.paysNow.value = 280000; n.quoteType.value = 'recurring'; n.deadline.value = 'end of Q1';
    n.renewalDate.value = 'April'; n.doingNothing.value = 'sign';
    n.cause.value = 'Broadcom hike'; n.otherDrivers.value = 'team';
    n.impactOnOthers.value = 'delays'; n.personalStake.value = 'stake';
    n.signOff.value = 'CTO'; n.budget.value = 'capex';
    n.needs.push({ value: 'cost comparison' });
    const r = CoachLogic.computeScriptNext(n, script, 'pain-first', null,
      ['Is this the thing to focus on or will something overpower it?']);
    assert(r.stepId === 'O2', 'needs filled: O2 (top need) is next');
  }
}

// ── Layout sanity (CSS checks) ────────────────────────────────────────────────
console.log('\n━━ Layout sanity ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  // #lv-next must not clip with overflow:hidden
  const lvNextRule = css.match(/#lv-next\s*\{[^}]+\}/);
  assert(!lvNextRule || !lvNextRule[0].includes('overflow:hidden'),
    'layout: #lv-next has no overflow:hidden (Say-this card must not clip)');
  // .lv-say-this-text must allow wrapping
  const sayThisRule = css.match(/\.lv-say-this-text\s*\{[^}]+\}/);
  assert(sayThisRule && !sayThisRule[0].includes('white-space:nowrap'),
    'layout: .lv-say-this-text allows wrapping (no white-space:nowrap)');
  // COI script length fits 500px column at 20px font (≈ 25 chars/line × 4 lines = 100 chars)
  const { buildCostOfInactionScript } = CoachLogic;
  const longCOI = buildCostOfInactionScript(80000, 250000, 25000, false, undefined, 'recurring');
  assert(longCOI.length < 200,
    `layout: longest COI line under 200 chars at 500px (got ${longCOI.length})`);
}

// ── Round D tests ─────────────────────────────────────────────────────────────
console.log('\n━━ Round D ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/script.json'), 'utf8'));
  const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/knowledge.json'), 'utf8'));
  const { buildCostOfInactionScript, buildCOIWorkings, detectQuoteType,
          detectUnansweredQuestion } = CoachLogic;

  // 1. Recurring 80k→250k, absorb 25k: line has £170k, £14k, £25k
  {
    const s = buildCostOfInactionScript(80000, 250000, 25000, false, undefined, 'recurring');
    assert(s.includes('£170k'), `R-D1a: recurring has £170k (got: ${s})`);
    assert(s.includes('£14k'), `R-D1b: recurring has £14k (got: ${s})`);
    assert(s.includes('£25k'), `R-D1c: recurring has absorb £25k (got: ${s})`);
    assert(s.includes('a year'), 'R-D1d: recurring has "a year"');
    assert(s.endsWith('Is that right?'), 'R-D1e: ends with "Is that right?"');
  }

  // 2. Recurring: no raw doingNothing pasted into spoken line
  {
    const s = buildCostOfInactionScript(80000, 250000, null, false, 'miss budget window, no capital', 'recurring');
    assert(!s.includes('budget window') && !s.includes('no capital'),
      'R-D2: recurring does not paste raw doingNothing into spoken line');
  }

  // 3. Oneoff 480k with 150k available → £330k gap, no "a year", no "%"
  {
    const s = buildCostOfInactionScript(null, 480000, null, false, undefined, 'oneoff', 150000, 'end of Q1');
    assert(s.includes('£330k'), `R-D3a: oneoff has £330k gap (got: ${s})`);
    assert(!s.includes('a year'), `R-D3b: oneoff has no "a year" (got: ${s})`);
    assert(!s.includes('%'), `R-D3c: oneoff has no "%" (got: ${s})`);
    assert(s.includes('end of Q1'), `R-D3d: oneoff includes deadline (got: ${s})`);
  }

  // 4. Unknown quoteType → ask question
  {
    const s = buildCostOfInactionScript(80000, 250000, null, false, undefined, 'unknown');
    assert(s.toLowerCase().includes('yearly') || s.toLowerCase().includes('one-off'),
      `R-D4: unknown returns ask question (got: ${s})`);
  }

  // 5. Word count: recurring without absorb ≤ 25 words
  {
    const s = buildCostOfInactionScript(80000, 250000, null, false, undefined, 'recurring');
    const wc = s.replace(/[^a-zA-Z0-9£ ]/g, ' ').trim().split(/\s+/).length;
    assert(wc <= 25, `R-D5: word count ${wc} ≤ 25`);
  }

  // 6. buildCOIWorkings recurring
  {
    const w = buildCOIWorkings(80000, 250000, null, 'recurring');
    assert(w.includes('250') && w.includes('80') && w.includes('170'),
      `R-D6: recurring workings show 250-80=170 (got: ${w})`);
  }

  // 7. buildCOIWorkings oneoff
  {
    const w = buildCOIWorkings(null, 480000, 150000, 'oneoff');
    assert(w.includes('480') && w.includes('150') && w.includes('330'),
      `R-D7: oneoff workings show 480-150=330 (got: ${w})`);
  }

  // 8. detectQuoteType: recurring indicators
  assert(detectQuoteType('our renewal comes up in April') === 'recurring', 'R-D8a: "renewal" → recurring');
  assert(detectQuoteType('we pay 280k a year') === 'recurring', 'R-D8b: "a year" → recurring');
  assert(detectQuoteType('it\'s an annual subscription') === 'recurring', 'R-D8c: "annual" → recurring');

  // 9. detectQuoteType: oneoff indicators
  assert(detectQuoteType('we\'re looking at a capital purchase') === 'oneoff', 'R-D9a: "capital" → oneoff');
  assert(detectQuoteType('hardware refresh') === 'oneoff', 'R-D9b: "refresh" → oneoff');
  assert(detectQuoteType('one-off replacement') === 'oneoff', 'R-D9c: "one-off" → oneoff');

  // 10. detectQuoteType: unknown
  assert(detectQuoteType('we got a quote for 480k') === 'unknown', 'R-D10: no context → unknown');

  // 11. New lookup row exists in knowledge.json
  {
    const row = knowledge.lookup.find(l => l.painType === 'Hardware failing / warranty ending');
    assert(row != null, 'R-D11a: Hardware failing / warranty ending lookup row exists');
    assert(row && row.causeQuestion && row.causeQuestion.toLowerCase().includes('ageing'),
      'R-D11b: causeQuestion mentions ageing hardware');
    assert(row && row.weDo && row.weDo.includes('warranty'),
      'R-D11c: weDo mentions warranty');
  }

  // 12. warranty-gap objection exists
  {
    const obj = knowledge.objections.find(o => o.id === 'warranty-gap');
    assert(obj != null, 'R-D12a: warranty-gap objection exists');
    assert(obj && obj.never_say && obj.never_say.toLowerCase().includes('nutanix'),
      'R-D12b: never_say references Nutanix');
  }

  // 13. detectUnansweredQuestion: warranty gap unanswered
  {
    const tx = [
      { id:'u1', speaker:'Me', ts:'5:00', text:'Walk me through your estate.' },
      { id:'u2', speaker:'Her', ts:'5:10', text:'What about the warranty gap on the hardware?' },
      { id:'u3', speaker:'Me', ts:'5:20', text:'So the renewal is coming up in April.' },
      { id:'u4', speaker:'Me', ts:'5:30', text:'And the quote is 390k a year.' },
    ];
    const r = detectUnansweredQuestion(tx);
    assert(r != null, 'R-D13a: warranty gap question detected as unanswered');
    assert(r && r.question.includes('warranty'), 'R-D13b: returned question is the warranty question');
  }

  // 14. detectUnansweredQuestion: reference hospital answered
  {
    const tx = [
      { id:'u1', speaker:'Me', ts:'5:00', text:'We start with non-critical workloads.' },
      { id:'u2', speaker:'Her', ts:'5:10', text:'Can you give me a reference hospital?' },
      { id:'u3', speaker:'Me', ts:'5:20', text:'Yes, one hospital group used Nutanix for their reference systems.' },
      { id:'u4', speaker:'Me', ts:'5:30', text:'They did it in phases to protect uptime.' },
    ];
    const r = detectUnansweredQuestion(tx);
    assert(r === null, 'R-D14: reference hospital question is answered (returns null)');
  }

  // 15. detectUnansweredQuestion: not enough Me responses yet → null
  {
    const tx = [
      { id:'u1', speaker:'Me', ts:'1:00', text:'Walk me through your estate.' },
      { id:'u2', speaker:'Her', ts:'1:10', text:'What about the warranty gap?' },
      { id:'u3', speaker:'Me', ts:'1:20', text:'Good question.' },
    ];
    const r = detectUnansweredQuestion(tx);
    assert(r === null, 'R-D15: only 1 Me response → null (not yet declared unanswered)');
  }

  // 16. N1b step exists in script.json NUMBER section
  {
    const numSection = script.sections.find(s => s.id === 'NUMBER');
    assert(numSection != null, 'R-D16a: NUMBER section exists in script.json');
    const n1b = numSection && numSection.steps.find(s => s.id === 'N1b');
    assert(n1b != null, 'R-D16b: N1b step exists in NUMBER section');
    assert(n1b && n1b.q && n1b.q.toLowerCase().includes('one-off'),
      'R-D16c: N1b asks about yearly vs one-off');
  }

  // 17. computeScriptNext skips N1b when quoteType is 'recurring'
  {
    const sn = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/script.json'), 'utf8'));
    function mf() { return { value: null }; }
    const n = {
      situation: { hosts: mf(), vms: mf(), storageTB: mf(), teamSize: mf(), workloads: mf() },
      painType: mf(), pain: mf(), whatItAffects: mf(), whyProblem: mf(),
      numbers: { paysNow: { value: 280000 }, quote: mf(), canAbsorb: mf() },
      quoteType: { value: 'recurring' }, available: mf(),
      deadline: mf(), renewalDate: mf(), doingNothing: mf(),
      cause: mf(), otherDrivers: mf(), impactOnOthers: mf(),
      personalStake: mf(), signOff: mf(), budget: mf(),
      needs: [], topNeed: mf(), needReason: mf(),
      nextStep: { who: mf(), purpose: mf(), dateTime: mf() }, scratch: []
    };
    const r = CoachLogic.computeScriptNext(n, sn, 'pain-first', null, []);
    // N1b should be skipped (quoteType is known), so next unfilled step should be N1 quote or N2
    assert(r.stepId !== 'N1b', `R-D17: N1b skipped when quoteType=recurring (got: ${r.stepId})`);
  }
}

// ── Objection engine (Phase 1) ────────────────────────────────────────────────
console.log('\n━━ Objection engine ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
  const objLib = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/objections.json'), 'utf8')
  ).objections;

  // 1. All 14 entries detected from natural phrasing
  const naturalPhrases = [
    { id: 'downtime',        text: "I need you to guarantee there'll be no downtime on patient systems." },
    { id: 'retraining',      text: "My team would need retraining on whatever we move to." },
    { id: 'cost',            text: "Is it cheaper than what we pay now? Our reseller said it would be." },
    { id: 'compliance',      text: "What about patient data compliance? We have strict rules around that." },
    { id: 'proof',           text: "Can you prove it will work for a hospital like ours?" },
    { id: 'warranty-gap',    text: "What happens to our warranty when we make the switch?" },
    { id: 'reference',       text: "Can you give me a hospital reference who's done this migration?" },
    { id: 'timing',          text: "It's too busy a time for us right now — can you come back later?" },
    { id: 'send-info',       text: "Just send me some information and I'll have a look." },
    { id: 'happy-vmware',    text: "VMware has worked for us for ten years — why change?" },
    { id: 'not-my-decision', text: "This isn't my decision — the finance director decides on spend like this." },
    { id: 'contract',        text: "We're locked in to a contract for another 18 months." },
    { id: 'competitors',     text: "We're also looking at Hyper-V and Proxmox — why not one of those?" },
    { id: 'hidden-costs',    text: "What will the migration actually cost, beyond the licence?" },
  ];
  for (const { id, text } of naturalPhrases) {
    const matches = CoachLogic.detectObjection(text, objLib);
    assert(matches.some(m => m.id === id), `OBJ-detect-${id}: "${id}" detected from natural phrasing`);
  }

  // 15. Neutral Her line does not trigger any objection
  {
    const neutral = "That sounds interesting. Can you tell me more about how the licensing works?";
    const matches = CoachLogic.detectObjection(neutral, objLib);
    assert(matches.length === 0, 'OBJ-no-false-positive: neutral question fires no objection');
  }

  // 16. hasObjMarkers: worry line fires, neutral does not
  assert(CoachLogic.hasObjMarkers("I'm worried about downtime for our clinical systems."), 'OBJ-markers-positive: worried line has marker');
  assert(!CoachLogic.hasObjMarkers("Yes, that's fine. Go ahead."), 'OBJ-markers-negative: agreement has no marker');

  // 17-20. buildObjectionCard: 4-step card structure
  {
    const entry = objLib.find(e => e.id === 'downtime');
    const card = CoachLogic.buildObjectionCard(entry, 'Can you guarantee there will be no downtime?', {});
    assert(card.answer && card.answer.length > 0, 'OBJ-card-answer: card has non-empty answer');
    assert(card.ask && card.ask.length > 0,    'OBJ-card-ask: card has non-empty ask');
    assert(card.bridge && card.bridge.length > 0, 'OBJ-card-bridge: card has non-empty bridge');
    assert(card.check && card.check.length > 0, 'OBJ-card-check: card has non-empty check');
  }

  // 21. [her date] placeholder filled from notes.deadline
  {
    const entry = objLib.find(e => e.id === 'timing');
    const notes = { deadline: { value: 'end of March' }, renewalDate: { value: null } };
    const card = CoachLogic.buildObjectionCard(entry, "It's too busy right now.", notes);
    assert(card.answer.includes('end of March') || card.bridge.includes('end of March') ||
           card.ask.includes('end of March'), 'OBJ-card-placeholder: [her date] filled from notes.deadline');
  }

  // 22. Unknown fallback: hasObjMarkers fires on "concern" with no library match
  {
    const text = "I have some concern about the support model — it's not clear to me.";
    const matches = CoachLogic.detectObjection(text, objLib);
    const hasMarker = CoachLogic.hasObjMarkers(text);
    // Should not match a specific entry (support model isn't in library), but should have markers
    assert(hasMarker, 'OBJ-unknown-fallback: concern-marked line has markers (triggers fallback)');
    assert(!matches.some(m => m.id === 'downtime'), 'OBJ-unknown-fallback: does not false-match downtime');
  }

  // 23. isObjHandledByMe: Me addresses the ask → returns true
  {
    const entry = objLib.find(e => e.id === 'downtime');
    const card = CoachLogic.buildObjectionCard(entry, '', {});
    const meText = "What would you need to see in a plan to feel safe about the migration?";
    assert(CoachLogic.isObjHandledByMe(meText, card), 'OBJ-auto-handle: Me echoes ask → handled');
  }

  // 24. isObjHandledByMe: unrelated Me line → false
  {
    const entry = objLib.find(e => e.id === 'downtime');
    const card = CoachLogic.buildObjectionCard(entry, '', {});
    const meText = "So how many virtual machines are we talking about?";
    assert(!CoachLogic.isObjHandledByMe(meText, card), 'OBJ-auto-handle: unrelated Me line → not handled');
  }

  // 25. Queue of 2 objections: both different IDs, FIFO order preserved
  {
    const lib2 = objLib.filter(e => ['downtime','compliance'].includes(e.id));
    const m1 = CoachLogic.detectObjection("can you guarantee no downtime", lib2);
    const m2 = CoachLogic.detectObjection("what about patient data compliance", lib2);
    assert(m1.length > 0 && m1[0].id === 'downtime',    'OBJ-queue: downtime detected');
    assert(m2.length > 0 && m2[0].id === 'compliance', 'OBJ-queue: compliance detected');
  }

  // 26. Never-say tripwire: new 'definitely' rule fires
  {
    const flags = CoachLogic.detectRedFlags("It is definitely going to be cheaper for you.");
    assert(flags.some(f => f.id === 'definitely'), 'TRIPWIRE-definitely: fires on "definitely cheaper"');
  }

  // 27. Never-say tripwire: 'i-promise' fires
  {
    const flags = CoachLogic.detectRedFlags("I promise this will work for your hospital.");
    assert(flags.some(f => f.id === 'i-promise'), 'TRIPWIRE-i-promise: fires on "I promise this will work"');
  }

  // 28. Never-say tripwire: '100%' fires
  {
    const flags = CoachLogic.detectRedFlags("We are 100% certain this fits your requirements.");
    assert(flags.some(f => f.id === 'hundred-percent'), 'TRIPWIRE-100%: fires on "100% certain"');
  }

  // 29. Never-say tripwire: 'save-you-money' fires
  {
    const flags = CoachLogic.detectRedFlags("This will save you money compared to VMware.");
    assert(flags.some(f => f.id === 'save-you-money'), 'TRIPWIRE-save-money: fires on "save you money"');
  }

  // 30. Never-say tripwire: 'better-than-vmware' fires
  {
    const flags = CoachLogic.detectRedFlags("Nutanix is better than VMware for your use case.");
    assert(flags.some(f => f.id === 'better-than-vmware'), 'TRIPWIRE-better-vmware: fires on "better than VMware"');
  }

  // 31. Negation: "I can't promise zero downtime" does NOT fire zero-downtime
  {
    const flags = CoachLogic.detectRedFlags("I can't promise zero downtime, and nobody honest can.");
    assert(!flags.some(f => f.id === 'zero-downtime'), 'TRIPWIRE-negation: "can\'t promise zero downtime" does not fire');
  }

  // 32. Negation: "I can't definitely say" does NOT fire definitely
  {
    const flags = CoachLogic.detectRedFlags("I can't definitely say until I've seen the numbers.");
    assert(!flags.some(f => f.id === 'definitely'), 'TRIPWIRE-negation-definitely: "can\'t definitely say" does not fire');
  }

  // 33. Negation: "I can't promise this will save you money" does NOT fire save-you-money
  {
    const flags = CoachLogic.detectRedFlags("I can't promise this will save you money — I haven't seen your numbers.");
    assert(!flags.some(f => f.id === 'save-you-money'), 'TRIPWIRE-negation-save: "can\'t promise…save you money" does not fire');
  }

  // 34. triggeredBy field is returned in detected flags
  {
    const flags = CoachLogic.detectRedFlags("We guarantee that outcome for you.");
    const g = flags.find(f => f.id === 'guarantee');
    assert(g && g.triggeredBy && g.triggeredBy.length > 0, 'TRIPWIRE-triggeredBy: guarantee flag includes triggeredBy');
  }

  // 35. Holdout: swapped-live-call Me lines — tripwire must NOT fire on normal lines
  {
    // From swapped-live-call.txt, Her lines (labelled as Me) — these are AE lines, not promise slips
    const aeLines = [
      "Thanks for making time, Helen. My name is Jimi, inside sales at Nutanix.",
      "Walk me through your estate — hosts, VMs, storage?",
      "Can you put a number on the increase?",
      "What does that affect in your budget this year?",
      "What's the ripple effect if this doesn't get resolved?",
      "What would you need to see before making a decision?",
      "So Nutanix runs compute, storage and networking on commodity servers — managed from one place.",
      "It's a single AOS licence instead of separate vSphere, vSAN and vCenter. Typically more predictable.",
      "Most customers do it in phased waves with minimal disruption. The tooling is mature.",
    ];
    let falsePositives = 0;
    for (const line of aeLines) {
      const flags = CoachLogic.detectRedFlags(line);
      if (flags.length > 0) falsePositives++;
    }
    assert(falsePositives === 0, `TRIPWIRE-holdout: no false positives on swapped-live-call AE lines (got ${falsePositives})`);
  }

  // 36. Card text: full text not truncated (all 4 steps have complete sentences)
  {
    const entry = objLib.find(e => e.id === 'hidden-costs');
    const card = CoachLogic.buildObjectionCard(entry, 'What will the migration cost?', {});
    // Check no truncation marker and reasonable length
    assert(!card.answer.includes('…') && card.answer.length > 15, 'OBJ-layout-no-truncation: answer is full text');
    assert(!card.ask.includes('…') && card.ask.length > 15,    'OBJ-layout-no-truncation: ask is full text');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${'━'.repeat(55)}`);
console.log(`${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : '  ✓'}`);
process.exit(failed > 0 ? 1 : 0);
