'use strict';
// Shared scenario-card builder used by scripts/gen-call.js and server.js.
// No side effects on require; all state is local to each function call.

const fs   = require('fs');
const path = require('path');

// ── PRNG ─────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pick(rng, arr)    { return arr[Math.floor(rng() * arr.length)]; }
function pickN(rng, arr, n) {
  const a = [...arr]; const r = [];
  for (let i = 0; i < n && a.length; i++) r.push(a.splice(Math.floor(rng() * a.length), 1)[0]);
  return r;
}
function rInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
function fmt(n)             { return n == null ? '(unknown)' : n.toLocaleString('en-GB'); }

// ── Taxonomy ──────────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, '../data');
const knowledge = JSON.parse(fs.readFileSync(path.join(DATA, 'knowledge.json'), 'utf8'));
const taxNew    = JSON.parse(fs.readFileSync(path.join(DATA, 'pain-taxonomy-new.json'), 'utf8'));

const KNOWLEDGE_KEYS = knowledge.lookup.map(p => p.painType);
const BASICS         = knowledge.basics;

const PAINS_K = knowledge.lookup.map(p => ({
  id: p.painType, label: p.painType,
  sheMightSay: p.sheSays.replace(/^"|"$/g, ''),
  weDo: p.weDo, family: 'k',
}));
const PAINS_N = taxNew.map(p => ({
  id: p.id, label: p.label,
  sheMightSay: p.sheMightSay[0],
  weDo: p.weDo, family: 'n',
}));
const ALL_PAINS = [...PAINS_K, ...PAINS_N];

// ── Dimension tables ──────────────────────────────────────────────────────────
const PERSONAS = {
  'terse':          'Terse and impatient. Gives short answers. Never volunteers. Waits to be asked.',
  'chatty':         'Chatty and tangential. Gives long answers, goes off topic.',
  'sceptical':      'Sceptical. Challenges the premise. "I\'ve been fine on VMware for ten years."',
  'rushed':         'Time-poor. Mentions a hard stop early. Speeds through.',
  'friendly-vague': 'Warm and friendly but imprecise. Uses "sort of", "you know". Hard to pin down.',
  'data-driven':    'Data-driven. Wants evidence early. Doesn\'t accept vague promises.',
  'non-technical':  'Non-technical manager. Confused by jargon like vSphere, AHV, hyperconverged.',
  'defensive-team': 'Protective of her VMware team. "Are you saying my people don\'t know what they\'re doing?"',
};
const FLOWS = {
  'textbook':    'Standard order: estate, then pain, then numbers, then needs, then pitch, then close.',
  'pain-first':  'She volunteers the pain in the first two minutes without being asked.',
  'budget-first':'She leads with budget or money pressure before anything else.',
  'early-jump':  'At about the 8-minute mark she asks "So what does Nutanix actually do?" before discovery is done.',
  'tangent':     'She goes on a tangent mid-call about something unrelated to IT procurement (canteen contract, building project, upcoming away day).',
};
const AE_BEHAVIORS = {
  'good':     'The AE follows the process well: clear agenda, open questions, no over-promising.',
  'average':  'The AE is mostly good but asks a couple of closed questions and slightly rushes.',
  'mistakes': 'The AE makes deliberate errors as listed in PLANTED MISTAKES below.',
};

// Candidate planted mistakes — each maps to a detectable red-flag rule.
const PLANTED_MISTAKE_POOL = [
  { id: 'zero-downtime',     phrase: 'we can handle this with zero downtime',        ruleBroken: "Never say 'zero downtime'" },
  { id: 'cheaper',           phrase: "it'll be cheaper than your current VMware deal", ruleBroken: "Never say 'cheaper' without proof" },
  { id: 'will-come-in-below',phrase: 'the pricing will come in below your current quote', ruleBroken: "Never promise a saving" },
  { id: 'learning-curve',    phrase: 'your team will be up to speed in just three weeks', ruleBroken: "Don't promise a learning-curve length" },
  { id: 'safer-faster',      phrase: 'Nutanix is faster and safer for your workloads', ruleBroken: "Never say 'safer' or 'faster' without proof" },
];
const OBJ_KEYS   = ['downtime', 'retraining', 'cost', 'compliance', 'proof'];
const OBJ_QUOTES = {
  downtime:    'Can you guarantee there will be no downtime when we move patient systems?',
  retraining:  'My team only knows VMware. They\'d need a lot of retraining.',
  cost:        'Is it actually cheaper? The reseller said it would be.',
  compliance:  'What about compliance? Everything touches patient data here.',
  proof:       'Can you prove this works in a hospital environment?',
};
const OBJ_TIMINGS = ['right-after-pitch', 'right-after-pitch', 'right-after-pitch', 'at-close', 'mid-discovery'];
const OBJ_MATCH   = { downtime: 'downtime', retraining: 'retraining', cost: 'cheaper', compliance: 'compliance', proof: 'prove' };

// ── buildCard ─────────────────────────────────────────────────────────────────
function buildCard(seed) {
  const rng = mulberry32(seed);

  const noPain   = rng() < 0.08;
  const numPains = noPain ? 0 : (rng() < 0.6 ? 1 : 2);
  const pains    = numPains === 0 ? [] : pickN(rng, ALL_PAINS, numPains);

  const persona    = pick(rng, Object.keys(PERSONAS));
  const numBehav   = pick(rng, ['gives-freely', 'refuses', 'wrong-unit', 'corrects', 'vague']);
  const flow       = pick(rng, Object.keys(FLOWS));
  const aeBehavior = pick(rng, Object.keys(AE_BEHAVIORS));
  const ENDINGS    = ['specific', 'vague', 'no-next-step', 'third-person'];
  const ending     = pains.length === 0 ? 'no-next-step' : pick(rng, ENDINGS);

  const PAY_OPTS  = [180000, 220000, 240000, 280000, 310000, 350000, 400000, 450000, 520000];
  const paysNow   = pick(rng, PAY_OPTS);
  const quote     = Math.round(paysNow * (1.3 + rng() * 1.2) / 10000) * 10000;
  const canAbsorb = rng() < 0.15 ? 0 : Math.round(paysNow * rng() * 0.12 / 10000) * 10000;
  const givesNums = ['gives-freely', 'wrong-unit', 'corrects'].includes(numBehav);
  const effNums   = {
    paysNow:   givesNums ? paysNow   : null,
    quote:     givesNums ? quote     : null,
    canAbsorb: givesNums ? canAbsorb : null,
  };
  const monthlyPay   = Math.round(paysNow / 12 / 100) * 100;
  const monthlyQuote = Math.round(quote   / 12 / 100) * 100;
  const wrongQuote   = quote + 50000;

  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const deadlineMonth = pick(rng, MONTHS);
  const renewalMonth  = rng() < 0.35 ? null : pick(rng, MONTHS);

  const estate = {
    hosts: rInt(rng, 8, 24), vms: rInt(rng, 150, 600),
    storageTB: rInt(rng, 60, 250), teamSize: rInt(rng, 3, 9),
  };

  const numObj    = rng() < 0.15 ? 0 : (rng() < 0.55 ? 1 : 2);
  const objections = [];
  for (let i = 0; i < numObj; i++) {
    const useKnown = rng() < 0.7;
    const timing   = pick(rng, OBJ_TIMINGS);
    if (useKnown) {
      const key = pick(rng, OBJ_KEYS);
      if (!objections.find(o => o.key === key))
        objections.push({ key, timing, quote: OBJ_QUOTES[key], source: 'knowledge' });
    } else {
      const OTHER = [
        'The last time we tried something like this it ran six months over and nobody owned it.',
        "We're already talking to VMware about a direct discount. Why would I change now?",
        "Our clinical application supplier might not certify a different platform.",
      ];
      objections.push({ key: 'other', timing, quote: pick(rng, OTHER), source: 'other' });
    }
  }

  const numNQ    = Math.floor(rng() * 3);
  const nutanixQs = numNQ > 0 ? pickN(rng, BASICS, numNQ).map(b => b.she_asks) : [];

  const PURPOSES   = ['working session', 'cost comparison review', 'demo', 'presentation to the CFO'];
  const DATES      = ['week of the 12th','week of the 19th','week of the 5th','end of this month'];
  const THIRD_NAMES = ['Rachel from finance','David in compliance','Mo the finance director',
                       'Priya the compliance lead','Ayesha in procurement','Sarah from clinical systems'];
  let nextStepWho = null, nextStepDate = null, nextStepPurpose = null;
  if (ending === 'specific') {
    nextStepWho     = 'you and her';
    nextStepDate    = pick(rng, DATES);
    nextStepPurpose = pick(rng, PURPOSES);
  } else if (ending === 'third-person') {
    const name      = pick(rng, THIRD_NAMES);
    nextStepWho     = `you, her, and ${name}`;
    nextStepDate    = pick(rng, DATES);
    nextStepPurpose = pick(rng, PURPOSES);
  }

  let plantedMistakes = [];
  if (aeBehavior === 'mistakes') {
    plantedMistakes = pickN(rng, PLANTED_MISTAKE_POOL, 2);
  }

  return {
    seed, pains, persona, numBehav, effNums, flow, aeBehavior, ending,
    estate, deadlineMonth, renewalMonth, objections, nutanixQs,
    nextStepWho, nextStepDate, nextStepPurpose,
    plantedMistakes,
    _raw: { paysNow, quote, canAbsorb, monthlyPay, monthlyQuote, wrongQuote },
  };
}

// ── buildPrompt ───────────────────────────────────────────────────────────────
function buildPrompt(card) {
  const r = card._raw;

  const painLines = card.pains.length === 0
    ? 'NO PAIN — she took the meeting only because the reseller asked. She has no real problem today.'
    : card.pains.map(p => `• ${p.label}: she says something like "${p.sheMightSay}"`).join('\n');

  const numInstr = {
    'gives-freely':
      `She gives exact numbers willingly when asked:\n` +
      `  — pays now: £${fmt(r.paysNow)} per year\n` +
      `  — renewal quote: £${fmt(r.quote)} per year\n` +
      `  — can absorb: £${fmt(r.canAbsorb)} increase`,
    'refuses':
      `She refuses to give numbers on a first call. "I don't share that on a first call." paysNow, quote, and canAbsorb remain unknown.`,
    'wrong-unit':
      `She initially gives the MONTHLY amount (£${fmt(r.monthlyPay)}/month, quote £${fmt(r.monthlyQuote)}/month) without saying it's monthly. When the AE asks for the annual figure, she corrects: £${fmt(r.paysNow)}/year, quote £${fmt(r.quote)}/year.`,
    'corrects':
      `She gives the quote wrong first ("about £${fmt(r.wrongQuote)}"), then corrects: "no, sorry — it's £${fmt(r.quote)}". paysNow = £${fmt(r.paysNow)}.`,
    'vague':
      `She gives no exact numbers. Only says "a lot more than we budgeted", "well above what we can absorb". Resists all requests for figures.`,
  }[card.numBehav];

  const objLines = card.objections.length === 0
    ? 'She raises no objections to the pitch.'
    : card.objections.map(o => `• TIMING = ${o.timing}: she says "${o.quote}"`).join('\n');

  const nqLines = card.nutanixQs.length > 0
    ? `\nNUTANIX QUESTIONS SHE ASKS:\n${card.nutanixQs.map(q => `• "${q}"`).join('\n')}`
    : '';

  const endingLines = {
    'specific':
      `She agrees to a ${card.nextStepPurpose} with the AE, ${card.nextStepDate}. nextStep.who = "${card.nextStepWho}".`,
    'vague':
      `She says "send me something" and doesn't commit. No confirmed next step.`,
    'no-next-step':
      `She says she has to go and doesn't agree a next step.`,
    'third-person':
      `She agrees to a ${card.nextStepPurpose} (${card.nextStepDate}) but needs to check with ${(card.nextStepWho || '').split('and ').pop()}. nextStep.who = "${card.nextStepWho}".`,
  }[card.ending];

  const painLabel = card.pains.map(p => p.label).join(' + ') || 'none';
  const objLabel  = card.objections.map(o => `${o.key}@${o.timing}`).join(', ') || 'none';

  const PERSONA_DESC    = PERSONAS[card.persona];
  const FLOW_DESC       = FLOWS[card.flow];
  const AE_BEHAVIOR_DESC = AE_BEHAVIORS[card.aeBehavior];

  // Build knowledge context for the model
  const slipsBlock = knowledge.slips_to_avoid.map(s => `• ${s}`).join('\n');

  const objBlock = knowledge.objections.map(o =>
    `• ${o.id.toUpperCase()}: She says something like ${o.she_says}.\n  Say this: ${o.say_this}\n  Never say: ${o.never_say}`
  ).join('\n');

  const activePainTypes = card.pains.map(p => p.id);
  const cautionBlock = knowledge.lookup
    .filter(l => activePainTypes.includes(l.painType))
    .map(l => `• [${l.painType}] ${l.caution}`)
    .join('\n') || '(none for this scenario)';

  const basicsBlock = knowledge.basics.map(b =>
    `• She asks: "${b.she_asks}" → Say: "${b.say_plainly}" (source: ${b.source})`
  ).join('\n');

  const plantedBlock = card.plantedMistakes && card.plantedMistakes.length > 0
    ? `\nPLANTED MISTAKES (the AE MUST say these EXACT phrases at some point — do not paraphrase):\n` +
      card.plantedMistakes.map(m => `• Say exactly: "${m.phrase}"`).join('\n')
    : '';

  return `You are writing a training transcript for a Nutanix inside sales role-play tool.

FIXED CONTEXT: Hospital IT director, on VMware for ten years, brought in by a partner reseller. The AE is an inside sales rep at Nutanix, labelled "Me". The prospect is labelled "Her".

═══ SCENARIO CARD (seed ${card.seed}) ═══

PERSONA: ${PERSONA_DESC}

FLOW: ${FLOW_DESC}

AE BEHAVIOUR: ${AE_BEHAVIOR_DESC}

PAINS:
${painLines}

NUMBERS BEHAVIOUR:
${numInstr}

ESTATE (she gives these when asked, in whatever order the conversation flows):
  ${card.estate.hosts} hosts, ${card.estate.vms} VMs, ${card.estate.storageTB} TB storage, team of ${card.estate.teamSize}

DATES:
  Deadline (board / CFO sign-off or budget deadline): ${card.deadlineMonth}
  Renewal date: ${card.renewalMonth || 'NEVER MENTIONED — do not invent one'}

OBJECTIONS:
${objLines}
${nqLines}

ENDING:
${endingLines}
${plantedBlock}

═══ KNOWLEDGE: RULES FOR THE AE ═══
SLIPS TO AVOID (never let the AE say these):
${slipsBlock}

KNOWN OBJECTIONS AND HOW TO HANDLE THEM:
${objBlock}

CAUTIONS FOR THE PAINS IN THIS SCENARIO:
${cautionBlock}

NUTANIX BASICS (if she asks; always attribute vendor claims as "Nutanix says"):
${basicsBlock}

═══ RULES ═══
1. Format: ONLY [mm:ss] Me: … and [mm:ss] Her: … lines. No prose, no headings.
2. Her lines: only the spoken words. No asterisks, no stage directions.
3. Me's lines: realistic Nutanix inside sales. Follow the AE behaviour spec above.
4. She is vague at first. She volunteers more only when the AE asks a good follow-up.
5. Use EXACTLY the numbers and dates in this card. Do NOT change them.
6. If the card says "renewal date: NEVER MENTIONED" — do not put any renewal date in the transcript.
7. The call runs 18 to 25 minutes of call time (by the timestamps).
8. Start at [00:10].

═══ OUTPUT FORMAT ═══
Output ONLY this, with the exact markers:

===TRANSCRIPT===
# Generated: seed ${card.seed} | pain: ${painLabel} | persona: ${card.persona} | objections: ${objLabel}
[00:10] Me: ...
[00:20] Her: ...
(full transcript)
===END===`;
}

// ── buildExpected ─────────────────────────────────────────────────────────────
function buildExpected(card) {
  const exp = {
    scenario: {
      seed:       card.seed,
      pain:       card.pains.map(p => p.label).join(' + ') || 'none',
      persona:    card.persona,
      numBehav:   card.numBehav,
      flow:       card.flow,
      aeBehavior: card.aeBehavior,
      ending:     card.ending,
      objections: card.objections.map(o => ({ key: o.key, timing: o.timing })),
    },
  };

  if (card.effNums.paysNow !== null) {
    exp.numbers = { paysNow: card.effNums.paysNow, quote: card.effNums.quote };
    if (card.effNums.canAbsorb !== null) exp.numbers.canAbsorb = card.effNums.canAbsorb;
  }

  const contains = {
    'situation.hosts':    String(card.estate.hosts),
    'situation.vms':      String(card.estate.vms),
    'situation.storageTB': String(card.estate.storageTB),
    'situation.teamSize': String(card.estate.teamSize),
  };
  if (card.deadlineMonth) contains.deadline    = card.deadlineMonth.toLowerCase();
  if (card.renewalMonth)  contains.renewalDate = card.renewalMonth.toLowerCase();
  exp.contains = contains;

  if (card.pains.length > 0) {
    const kPain = card.pains.find(p => p.family === 'k');
    exp.painTypeIn = kPain ? [kPain.label] : KNOWLEDGE_KEYS;
  }

  const knownObjs = card.objections.filter(o => o.source === 'knowledge');
  if (knownObjs.length > 0) {
    exp.objections = knownObjs.map(o => ({ matchedKey: o.key, match: OBJ_MATCH[o.key] || o.key }));
  }

  if (card.nextStepPurpose) {
    exp.nextStep = { purposeContains: card.nextStepPurpose };
    const digits = (card.nextStepDate || '').match(/\d+/);
    if (digits) exp.nextStep.dateTimeContains = [digits[0]];
    if (card.ending === 'third-person') {
      const extras = (card.nextStepWho || '').split('and ').slice(1);
      exp.nextStep.whoContains = extras.map(s => s.trim().split(' ')[0].toLowerCase()).filter(Boolean);
    }
  }

  const mustNotInvent = [];
  if (!card.renewalMonth)            mustNotInvent.push('renewalDate (not mentioned in transcript)');
  if (card.effNums.paysNow === null)  mustNotInvent.push('exact numbers (not given)');
  exp.mustNotInvent = mustNotInvent;

  if (card.plantedMistakes && card.plantedMistakes.length > 0) {
    exp.plantedMistakes = card.plantedMistakes.map(m => ({
      text: m.phrase,
      ruleBroken: m.ruleBroken,
    }));
  }

  return exp;
}

// ── Label helper (used by /api/generated) ─────────────────────────────────────
function parseFirstLine(firstLine) {
  // "# Generated: seed 100 | pain: X | persona: Y | objections: Z"
  const painMatch    = firstLine.match(/pain: ([^|]+)/);
  const personaMatch = firstLine.match(/persona: ([^|]+)/);
  const objMatch     = firstLine.match(/objections: (.+)/);
  return {
    pain:     painMatch    ? painMatch[1].trim()    : 'unknown',
    persona:  personaMatch ? personaMatch[1].trim() : 'unknown',
    objLabel: objMatch     ? objMatch[1].trim()     : 'none',
  };
}

module.exports = { buildCard, buildPrompt, buildExpected, parseFirstLine, KNOWLEDGE_KEYS };
