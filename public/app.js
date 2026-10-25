// ── State ──────────────────────────────────────────────────────────────────
let knowledge = null;
let pclubCoach = null;

const state = {
  notes: createEmptyNotes(),
  transcript: [],          // { id, ts, speaker, text }
  recentUtterances: [],    // buffer since last extract
  lastExtractTime: 0,
  extractInFlight: false,
  totalTokens: 0,
  callStart: null,
  timerInterval: null,
  pitchHeld: false,
  // replay
  replayMode: false,
  replayUtterances: [],
  replayIndex: 0,
  replayInterval: null,
  replayPaused: false,
  // live mode
  liveMode: false,
  liveSpeaker0IsMe: true,
  sessionStart: null,
  micStream: null,
  audioCtx: null,
  levelMeterInterval: null,
  dgWs: null,
  speechRec: null,
  manualTicks: { '2': null, '3': null },  // null=unset, 'done'=ticked, 'yet'=cleared
  liveTab: 'notes',
  openingTicks: { o1: null, o2: null, o3: null, o4: null }, // null=auto, true=force-done
  nutanixIntroSuggested: false,
  objections: [],   // { id, quote, matchedKey, utteranceId, timestamp, status: 'open'|'handled'|'dismissed', seenAt }
  forceFlush: false,
  // live status tracking
  activeEngine: null,      // 'deepgram' | 'chrome'
  dgWsState: null,         // 'connecting' | 'open' | 'closed' | 'error'
  dgBytesSent: 0,
  dgLastResultTime: null,
  dgGotResult: false,
  dgFallbackTimer: null,
  liveStatusInterval: null,
  liveErrorMsg: null,
  interimText: null,
  interimSpeaker: null,
  transcriptScrollLocked: false,
};
// Expose for E2E tests (const is not on window automatically)
window.state = state;

// ── Schema ──────────────────────────────────────────────────────────────────
function makeField() { return { value: null, evidence: [], confidence: 0, locked: false }; }

function createEmptyNotes() {
  return {
    situation: {
      hosts:     makeField(),
      vms:       makeField(),
      storageTB: makeField(),
      teamSize:  makeField(),
      workloads: makeField()
    },
    painType:      makeField(),
    pain:          makeField(),
    whatItAffects: makeField(),
    whyProblem:    makeField(),
    numbers: {
      paysNow:   makeField(),
      quote:     makeField(),
      canAbsorb: makeField()
    },
    deadline:      makeField(),
    renewalDate:   makeField(),
    doingNothing:  makeField(),
    cause:         makeField(),
    otherDrivers:  makeField(),
    impactOnOthers:makeField(),
    personalStake: makeField(),
    signOff:       makeField(),
    budget:        makeField(),
    needs:         [],   // dynamic: { value, evidence, confidence, locked, painType, painTypeSuggested, sourceTier, history? }
    topNeed:       makeField(),
    needReason:    makeField(),
    nextStep: {
      who:      makeField(),
      purpose:  makeField(),
      dateTime: makeField()
    },
    scratch: []
  };
}

// ── Field access ────────────────────────────────────────────────────────────
// Resolve a dotted field path to the field object (e.g. "situation.hosts")
function getField(notes, path) {
  if (!path) return null;
  const parts = path.split('.');
  let obj = notes;
  for (const p of parts) {
    if (obj == null) return null;
    obj = obj[p];
  }
  return obj;
}

// Get a human-readable label from a field path
function fieldLabel(path) {
  const labels = {
    'situation.hosts': 'Hosts', 'situation.vms': 'VMs',
    'situation.storageTB': 'Storage TB', 'situation.teamSize': 'Team size',
    'situation.workloads': 'Workloads',
    'painType': 'Pain type', 'pain': 'Pain',
    'whatItAffects': 'What it affects', 'whyProblem': 'Why it\'s a problem',
    'numbers.paysNow': 'Pays now / yr', 'numbers.quote': 'Quote / yr',
    'numbers.canAbsorb': 'Can absorb',
    'deadline': 'Board / decision date', 'renewalDate': 'Renewal date',
    'doingNothing': 'If nothing changes',
    'cause': 'Cause', 'otherDrivers': 'Other drivers',
    'impactOnOthers': 'Impact on others', 'personalStake': 'Personal stake',
    'signOff': 'Signs off', 'budget': 'Budget',
    'topNeed': 'Top need #', 'needReason': 'Why it matters',
    'nextStep.who': 'Who', 'nextStep.purpose': 'Purpose', 'nextStep.dateTime': 'Date / time'
  };
  return labels[path] || path;
}

// ── Patch application ────────────────────────────────────────────────────────
function needsSimilar(a, b) {
  const stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','our','we','i','is','are','be','have','has','need','needs']);
  const words = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && inter / union >= 0.4;
}

function applyPatch(patch) {
  for (const item of patch) {
    const { field, value, evidence, confidence, isCorrection, painType, parkNote } = item;
    if (!field) continue;

    // ── New need (field == "needs") ──
    if (field === 'needs') {
      if (value && String(value).trim()) {
        // Don't add duplicates (exact or semantic ~40% word-overlap)
        const dup = state.notes.needs.find(
          n => n.value && (
            n.value.toLowerCase() === String(value).trim().toLowerCase() ||
            needsSimilar(n.value, String(value).trim())
          )
        );
        if (!dup) {
          state.notes.needs.push({
            value: String(value).trim(),
            evidence: evidence || [],
            confidence: confidence || 0.8,
            locked: false,
            painType: painType || null,
            painTypeSuggested: !painType,
            sourceTier: 'need',
            history: []
          });
        }
      }
      continue;
    }

    // ── Update existing need text (field == "needs.0") ──
    if (/^needs\.\d+$/.test(field)) {
      const idx = parseInt(field.split('.')[1]);
      if (state.notes.needs[idx]) {
        if (!state.notes.needs[idx].locked) {
          if (isCorrection) {
            state.notes.needs[idx].history = state.notes.needs[idx].history || [];
            state.notes.needs[idx].history.push({ value: state.notes.needs[idx].value, ts: Date.now() });
          }
          if (value !== null && value !== undefined) state.notes.needs[idx].value = String(value);
          if (confidence) state.notes.needs[idx].confidence = confidence;
          state.notes.needs[idx].evidence = evidence || state.notes.needs[idx].evidence;
        }
      }
      continue;
    }

    // ── Update need pain type (field == "needs.0.painType") ──
    if (/^needs\.\d+\.painType$/.test(field)) {
      const idx = parseInt(field.split('.')[1]);
      if (state.notes.needs[idx]) {
        state.notes.needs[idx].painType = value || null;
        state.notes.needs[idx].painTypeSuggested = false;
      }
      continue;
    }

    // ── Scratch / parked ──
    if (field === 'scratch') {
      const evIds = evidence || [];
      const valStr = String(value || '').trim();
      // Strip utterance IDs (u001, u023 etc.) and bracketed notes from the display value
      const cleanVal = valStr.replace(/\bu\d{3}\b/gi, '').replace(/\s{2,}/g, ' ').trim();
      if (!cleanVal) continue;
      // Dedup: skip if first 25 chars match any existing scratch item
      const prefix = cleanVal.toLowerCase().slice(0, 25);
      const dup = state.notes.scratch.find(s => s.value.toLowerCase().slice(0, 25) === prefix);
      if (dup) continue;
      let ts = '';
      if (evIds.length > 0) {
        const srcUtt = state.transcript.find(u => u.id === evIds[0]);
        if (srcUtt) ts = srcUtt.ts;
      }
      // Separate dont-promise slips from normal parked items
      const isDontPromise = item.parkNote === 'dont-promise';
      state.notes.scratch.push({ value: cleanVal, evidence: evIds, parkNote: item.parkNote || '', ts, isDontPromise });
      continue;
    }

    // ── Standard field ──
    const f = getField(state.notes, field);
    if (!f || typeof f !== 'object' || !('value' in f)) continue;
    if (f.locked) continue;  // respect lock

    const oldValue = f.value;
    if (value !== null && value !== undefined && value !== '') {
      if (isCorrection && oldValue !== null && oldValue !== undefined) {
        f.history = f.history || [];
        f.history.push({ value: oldValue, ts: Date.now() });
      }
      f.value = value;
      f.evidence = evidence || [];
      f.confidence = confidence || 0.5;

      // Flash the DOM element
      const elId = 'f-' + field.replace(/\./g, '-');
      const el = document.getElementById(elId);
      if (el) {
        el.classList.remove('flashing');
        void el.offsetWidth; // reflow
        el.classList.add('flashing');
        el.addEventListener('animationend', () => el.classList.remove('flashing'), { once: true });
      }
    }
  }
}

// ── Derived values (port of xlsx formulas) ──────────────────────────────────
function computeDerived() {
  const n = state.notes.numbers;
  const d = {};

  // Sheet D16: increasePct = quote / paysNow - 1
  if (n.quote.value && n.paysNow.value && n.paysNow.value > 0) {
    d.increasePct = n.quote.value / n.paysNow.value - 1;
  }
  // Sheet D17: gapPerYear = quote - canAbsorb  (canAbsorb = 0 is valid)
  if (n.quote.value != null && n.canAbsorb.value != null) {
    d.gapPerYear = n.quote.value - n.canAbsorb.value;
  }

  // Monthly equivalents (M7 L24: monthly cost of inaction > yearly for urgency)
  if (n.paysNow.value != null)   d.monthlyPaysNow = Math.round(n.paysNow.value / 12);
  if (n.quote.value != null)     d.monthlyQuote   = Math.round(n.quote.value / 12);
  if (d.gapPerYear != null)      d.monthlyGap     = Math.round(d.gapPerYear / 12);

  // Sheet D21: numbers read-back (section 6.5: partial-safe, canAbsorb = 0 is valid)
  if (n.quote.value != null && n.paysNow.value != null && n.canAbsorb.value != null) {
    const dl = state.notes.deadline.value;
    const rd = state.notes.renewalDate.value;
    const datePart = dl ? ` Deadline: ${dl}.` : '';
    const renewalPart = rd ? ` Renewal: ${rd}.` : '';
    d.numbersSummary = `So the quote is ${fmtNum(n.quote.value)} against ${fmtNum(n.paysNow.value)} now. You can absorb ${fmtNum(n.canAbsorb.value)}.${datePart}${renewalPart} Did I get that right?`;
    d.numbersSummaryPartial = false;
  } else {
    const parts = [];
    if (n.paysNow.value != null) parts.push(`paying ${fmtNum(n.paysNow.value)}`);
    if (n.quote.value != null)   parts.push(`quote ${fmtNum(n.quote.value)}`);
    if (n.canAbsorb.value != null) parts.push(`absorb ${fmtNum(n.canAbsorb.value)}`);
    if (parts.length) { d.numbersSummary = `So far I've got: ${parts.join(', ')}. Did I get that right?`; d.numbersSummaryPartial = true; }
  }

  // Sheet D25: cause read-back (section 6.5: partial-safe)
  const cause = state.notes.cause.value;
  const drivers = state.notes.otherDrivers.value;
  if (cause && drivers) {
    d.causeSummary = `So it hits hard because ${cause}, and right now it matters because ${drivers}. Did I get that right?`;
    d.causeSummaryPartial = false;
  } else if (cause) {
    d.causeSummary = `So it hits hard because ${cause}. Did I get that right?`;
    d.causeSummaryPartial = true;
  }

  // Needs read-back (section 6.5 replaces xlsx D37 all-or-nothing condition)
  const filled = state.notes.needs.filter(n => n.value);
  if (filled.length > 0) {
    const topIdx = resolveTopNeedIndex(filled);
    const topText = filled[topIdx].value;
    if (filled.length === 1) {
      d.needsSummary = `So you need: ${filled[0].value}. Did I get that right?`;
    } else {
      d.needsSummary = `So you need: ${filled.map(n => n.value).join('; ')}. The most important is: ${topText}. Did I get that right?`;
    }
    d.needsSummaryPartial = !state.notes.topNeed.value;
  }

  // Sheet Pitch F15: close book-it line — use her session availability if agreed, else fall back to board deadline
  const deadline = state.notes.deadline.value;
  const sessionDate = state.notes.nextStep.dateTime.value;
  const sessionWho = state.notes.nextStep.who.value;
  if (sessionDate) {
    d.closeBookIt = sessionWho
      ? `"Let's lock in the working session — ${sessionDate}. In the room: ${sessionWho}. Shall I send dates today?"`
      : `"Let's lock in the working session — ${sessionDate}. Who should be in the room?"`;
  } else if (deadline) {
    d.closeBookIt = sessionWho
      ? `"Let's book a working session before ${deadline}. In the room: ${sessionWho}. Shall I send dates today?"`
      : `"Let's book a working session before ${deadline}. Who should be in the room?"`;
  } else {
    d.closeBookIt = `"Let's book a working session. Who should be in the room?"`;
  }

  // Targeted questions (Sheet Call C23, C27)
  if (state.notes.painType.value && knowledge) {
    const lk = lookupPainType(state.notes.painType.value);
    if (lk) {
      d.causeQuestion = lk.causeQuestion;
      d.impactQuestion = lk.impactQuestion;
    }
  }

  return d;
}

// ── Completeness and summary delegates to SummaryLogic (summary-logic.js) ──
function computeCompleteness(n) { return SummaryLogic.computeCompleteness(n); }
function computeSummaryText(section) { return SummaryLogic.computeSummaryText(section, state.notes); }

// ── Classify last Her statement (pclub L16, L21) ────────────────────────────
function classifyLastHerStatement(text) {
  const t = String(text).toLowerCase();
  if (/\b(we need|i need|i'?d like|i'?m looking for|we'?re looking for|i want|we want|migration plan|proposal)\b/.test(t)) return 'SOLUTION';
  if (/\b(because|that'?s? why|the reason|due to|comes from|ever since|after|following|(since|when) (broadcom|vmware|they|we))\b/.test(t)) return 'ROOT_CAUSE';
  if (/(\d+%|£\d|€\d|\$\d|\d+\s*k\b|\d+\s*m\b|doubled?|tripled?|jumped?|went up|up \d|per year|per month|annual|renewal)/.test(t)) return 'PROBLEM';
  return null;
}

function resolveTopNeedIndex(filledNeeds) {
  const tv = state.notes.topNeed.value;
  if (tv && !isNaN(tv)) {
    const idx = parseInt(tv) - 1;
    if (idx >= 0 && idx < filledNeeds.length) return idx;
  }
  return 0; // auto: first (most recently added is at end, so index 0 is oldest — acceptable fallback)
}

// ── Pitch builder (section 6.5 — replaces xlsx fixed 3-need logic) ──────────
function buildPitch() {
  const pitch = { available: false, lines: [], confidence: 'red', missing: [], topAssumed: false };

  // Source ladder: tier 1 = explicit needs, tier 2 = pain/consequence, tier 3 = stake/driver
  const items = [];

  const filled = state.notes.needs.filter(n => n.value);
  for (const nd of filled) {
    items.push({
      text: nd.value,
      tier: 'need',
      painType: nd.painType || state.notes.painType.value,
      painTypeSuggested: nd.painTypeSuggested && !nd.painType
    });
  }

  // Amber fallback: supplement with pain/stake when fewer than 2 explicit needs
  if (filled.length < 2) {
    if (state.notes.pain.value) {
      items.push({ text: state.notes.pain.value, tier: 'pain', painType: state.notes.painType.value });
    }
    if (state.notes.whatItAffects.value) {
      items.push({ text: state.notes.whatItAffects.value, tier: 'pain', painType: null });
    }
  }

  if (items.length === 0) {
    if (state.notes.personalStake.value) {
      items.push({ text: state.notes.personalStake.value, tier: 'stake', painType: null });
    } else if (state.notes.otherDrivers.value) {
      items.push({ text: state.notes.otherDrivers.value, tier: 'stake', painType: null });
    }
  }

  if (items.length === 0) {
    pitch.missing = ['Ask: "What do you need to happen before [deadline]?" to build the pitch'];
    return pitch;
  }

  pitch.available = true;

  // Determine top
  let topIdx = 0;
  let topAssumed = true;
  const tv = state.notes.topNeed.value;
  if (tv && !isNaN(tv)) {
    const i = parseInt(tv) - 1;
    if (i >= 0 && i < items.length) { topIdx = i; topAssumed = false; }
  }
  pitch.topAssumed = topAssumed;

  // Sort top first, cap at 3 lines
  const sorted = [items[topIdx], ...items.filter((_, i) => i !== topIdx)].slice(0, 3);

  pitch.lines = sorted.map((item, lineIdx) => {
    const isTop = lineIdx === 0;
    const weDo = getWeDo(item.painType);
    const suffix = isTop ? ' matters most' : ' matters';
    const quote = shortQuote(item.text);
    const text = weDo
      ? `We ${weDo}. You told me ${quote}${suffix}. So here's how that fits.`
      : `We bring in the right people to work through this with you. You told me ${quote}${suffix}. So here's how that fits.`;

    return {
      text,
      tier: item.tier,
      isTop,
      topAssumed: isTop && topAssumed,
      painType: item.painType,
      noPainType: !item.painType || item.painTypeSuggested,
      howFact: item.painType ? getHowFact(item.painType) : null,
      howUrl: item.painType ? getSourceUrl(item.painType) : null
    };
  });

  // Confidence indicator
  const allNeeds = items.every(i => i.tier === 'need');
  const hasTop = !topAssumed;
  if (allNeeds && hasTop) pitch.confidence = 'green';
  else if (items.some(i => i.tier === 'need') || allNeeds) pitch.confidence = 'amber';
  else pitch.confidence = 'red';

  if (topAssumed && pitch.confidence !== 'red') {
    pitch.missing = ['Ask: "Which of those matters most to you?" to confirm top need'];
  } else if (pitch.confidence === 'red') {
    pitch.missing = ['Ask: "What do you need to happen before [deadline]?"'];
  }

  return pitch;
}

// ── Coach panel — constants ───────────────────────────────────────────────────
function computeFollowUpQuestion(itemText) {
  const text = itemText.toLowerCase();
  if (knowledge) {
    for (const lk of knowledge.lookup) {
      const ptWords = lk.painType.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (ptWords.some(w => text.includes(w))) {
        return lk.impactQuestion || lk.causeQuestion || null;
      }
    }
  }
  const words = itemText.split(/\s+/).filter(w => w.length > 4);
  if (words.length > 0) return `Can you say more about ${words.slice(0, 3).join(' ')}?`;
  return 'Can you say more about that?';
}

function enrichScratchItems() {
  for (const item of state.notes.scratch) {
    if (item.isConstraint === undefined) {
      item.isConstraint = CoachLogic.isConstraintItem(item.value);
    }
    if (item.followedUp === undefined) item.followedUp = false;
    if (!item.isConstraint && !item.followUpQ) item.followUpQ = computeFollowUpQuestion(item.value);
  }
}

function checkParkedFollowUps() {
  if (!state.notes.scratch.length) return;
  const stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are','be','have','has']);
  function kw(text) {
    return new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w)));
  }
  const myTexts = state.transcript.filter(u => u.speaker === 'Me').map(u => u.text);
  for (const item of state.notes.scratch) {
    if (item.followedUp) continue;
    const iw = kw(item.value);
    if (iw.size === 0) continue;
    const asked = myTexts.some(t => {
      const tw = kw(t);
      const overlap = [...iw].filter(w => tw.has(w)).length;
      return overlap / iw.size >= 0.35;
    });
    if (asked) item.followedUp = true;
  }
}

// ── Coverage board ───────────────────────────────────────────────────────────
function computeCoverage() {
  const n = state.notes;
  const areas = [
    { id: 'situation', label: 'Situation',
      covered: !!(n.situation.hosts.value || n.situation.vms.value),
      partial: !!(n.situation.hosts.value || n.situation.vms.value) &&
               !(n.situation.hosts.value && n.situation.vms.value && n.situation.storageTB.value) },
    { id: 'pain', label: 'Pain',
      covered: !!(n.pain.value && n.whatItAffects.value && n.whyProblem.value),
      partial: !!(n.pain.value) },
    { id: 'number', label: 'Number',
      covered: !!(n.numbers.paysNow.value != null && n.numbers.quote.value != null && n.numbers.canAbsorb.value != null),
      partial: !!(n.numbers.paysNow.value || n.numbers.quote.value) },
    { id: 'timeframe', label: 'Timeframe',
      covered: !!(n.deadline.value || n.renewalDate.value),
      partial: !!(n.deadline.value || n.renewalDate.value) },
    { id: 'cause', label: 'Cause',
      covered: !!(n.cause.value && n.otherDrivers.value),
      partial: !!(n.cause.value) },
    { id: 'impact', label: 'Impact',
      covered: !!(n.impactOnOthers.value && n.personalStake.value),
      partial: !!(n.impactOnOthers.value || n.personalStake.value) },
    { id: 'buyingbox', label: 'Buying box',
      covered: !!(n.signOff.value && n.budget.value),
      partial: !!(n.signOff.value || n.budget.value) },
    { id: 'needs', label: 'Needs',
      covered: n.needs.filter(nd => nd.value).length >= 1 && !!n.topNeed.value,
      partial: n.needs.filter(nd => nd.value).length >= 1 },
    { id: 'nextstep', label: 'Next step',
      covered: !!(n.nextStep.who.value && n.nextStep.dateTime.value),
      partial: !!(n.nextStep.who.value || n.nextStep.dateTime.value || n.nextStep.purpose.value) }
  ];
  // resolve partial: partial only if not already covered
  return areas.map(a => ({
    ...a,
    partial: a.partial && !a.covered
  }));
}

// ── Brief ticks (Sheet Brief D6-D13, adapted for section 6.5) ───────────────
function computeBriefTicks() {
  const n = state.notes;
  const filled = (arr) => arr.filter(Boolean).length;

  // Check for Nutanix intro auto-suggest: Me said something matching a pitch opener
  const meLines = state.transcript.filter(u => u.speaker === 'Me').map(u => u.text.toLowerCase());
  const nutanixIntroDetected = meLines.some(t =>
    (t.includes('nutanix') && (t.includes('put') || t.includes('manage') || t.includes('idea') || t.includes('try') || t.includes('brings') || t.includes('one system'))) ||
    t.includes('can i try a few ideas')
  );

  // Objection status for tick 3
  const openObj = (state.objections || []).filter(o => o.status === 'open');
  const handledObj = (state.objections || []).filter(o => o.status === 'handled');
  const allHandled = openObj.length === 0 && (state.objections || []).length > 0;
  const noneRaised = (state.objections || []).length === 0;

  return [
    { id: '1b', what: 'Pain uncovered', status: (()=>{const c=filled([n.pain.value,n.whatItAffects.value,n.whyProblem.value,n.cause.value]); return c>=3?'done':c>=1?'partial':'yet';})() },
    { id: '1a', what: 'Situation uncovered', status: (n.situation.hosts.value || n.situation.vms.value || n.situation.workloads.value) ? 'done' : 'yet' },
    { id: '1c', what: 'Needs uncovered', status: n.needs.filter(nd => nd.value).length >= 1 ? 'done' : 'yet' },
    { id: '1d', what: 'Implications uncovered', status: filled([n.doingNothing.value, n.impactOnOthers.value, n.personalStake.value]) >= 2 ? 'done' : 'yet' },
    { id: '1e', what: 'Timeframe uncovered', status: filled([n.deadline.value, n.renewalDate.value]) >= 1 ? 'done' : 'yet' },
    {
      id: '2', what: 'Nutanix introduced',
      status: state.manualTicks['2'] || (nutanixIntroDetected ? 'done' : 'yet'),
      clickable: true,
      suggestion: null
    },
    {
      id: '3', what: 'Objections handled',
      status: state.manualTicks['3'] || (noneRaised ? 'yet' : allHandled ? 'suggest' : 'yet'),
      clickable: true,
      suggestion: allHandled && state.manualTicks['3'] === null ? 'All objections handled — tick done?' : (noneRaised ? 'none raised' : null)
    },
    { id: '4',  what: 'Next step agreed', status: filled([n.nextStep.dateTime.value, n.nextStep.who.value]) >= 2 ? 'done' : 'yet' }
  ];
}

// ── Knowledge lookup helpers ─────────────────────────────────────────────────
function lookupPainType(pt) {
  if (!knowledge || !pt) return null;
  return knowledge.lookup.find(l => l.painType === pt) || null;
}
function getWeDo(pt) {
  const lk = lookupPainType(pt);
  return lk ? lk.weDo : null;
}
function getHowFact(pt) {
  const lk = lookupPainType(pt);
  return lk ? lk.supportingFact : null;
}
function getSourceUrl(pt) {
  const lk = lookupPainType(pt);
  return lk ? lk.sourceUrl : null;
}

// ── Short quote helper — truncates to maxWords for pitch lines ───────────────
function shortQuote(text, maxWords = 8) {
  if (!text) return '""';
  const words = text.split(/\s+/);
  // Strip trailing punctuation: em-dash, en-dash, hyphen, comma, colon, semicolon
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

// ── Number formatting ────────────────────────────────────────────────────────
function fmtNum(v) {
  if (v == null) return '';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (n >= 1000000) return '£' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return '£' + Math.round(n / 1000) + 'k';
  return '£' + n.toLocaleString();
}
function fmtPct(v) {
  if (v == null) return '';
  return (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
}

// ── Timer ────────────────────────────────────────────────────────────────────
function callElapsedStr() {
  if (!state.callStart) return '00:00';
  const secs = Math.floor((Date.now() - state.callStart) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}
function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.callStart = Date.now();
  state.timerInterval = setInterval(() => {
    const t = callElapsedStr();
    document.getElementById('timer').textContent = t;
    const lv = document.getElementById('lv-timer');
    if (lv) lv.textContent = t;
  }, 1000);
}
function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

// ── Transcript parsing (for .txt sample files) ───────────────────────────────
function parseTranscriptFile(text) {
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
        id: `u${String(id).padStart(3, '0')}`,
        ts: m[1],
        speaker: m[2],
        text: m[2] === 'Her' ? CoachLogic.stripStageDirections(rawText) : rawText
      });
      id++;
    }
  }
  return utterances;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function tsToSec(ts) {
  const [m, s] = (ts || '0:00').split(':').map(Number);
  return (m || 0) * 60 + (s || 0);
}

// ── Extraction trigger ────────────────────────────────────────────────────────
async function maybeExtract() {
  if (state.extractInFlight) return;
  if (state.recentUtterances.length === 0) return;
  const herLines = state.recentUtterances.filter(u => u.speaker === 'Her');
  if (herLines.length === 0) return;

  // forceFlush: bypass batch-size gate for final drain at end of replay.
  // Replay: buffer 12 utterances. Live: 12 or 8s wall-clock.
  const force = state.forceFlush && !state.liveMode;
  const batchReady = force || (!state.liveMode
    ? state.recentUtterances.length >= 12
    : (state.recentUtterances.length >= 12 || Date.now() - state.lastExtractTime >= 8000));
  if (!batchReady) return;

  state.extractInFlight = true;
  state.lastExtractTime = Date.now();
  setExtractStatus('extracting…');

  const recent = state.recentUtterances;
  state.recentUtterances = [];

  const recentTranscript = recent.map(u => `[${u.ts}] ${u.id} ${u.speaker}: ${u.text}`).join('\n');

  // 300-second context window anchored on last processed utterance — matches lib/extractor.js flush()
  const processed = state.transcript.slice(0, state.transcript.length - recent.length);
  const lastSec = processed.length > 0 ? tsToSec(processed[processed.length - 1].ts) : 0;
  const fullSummary = processed.length > 0
    ? processed.filter(u => tsToSec(u.ts) >= lastSec - 300).slice(-40)
        .map(u => `[${u.ts}] ${u.id} ${u.speaker}: ${u.text}`).join('\n')
    : '';

  try {
    const resp = await fetch('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: state.notes, recentTranscript, fullSummary })
    });
    const data = await resp.json();
    if (data.patch && data.patch.length > 0) {
      applyPatch(data.patch);
      renderAll();
    }
    if (data.objections && data.objections.length > 0) {
      handleIncomingObjections(data.objections);
    }
    if (data.tokenUsage) {
      state.totalTokens += (data.tokenUsage.inputTokens || 0) + (data.tokenUsage.outputTokens || 0);
    }
    const lastTs = recent.length > 0 ? recent[recent.length - 1].ts : callElapsedStr();
    setExtractStatus(`last extract: ${lastTs}`);
  } catch (err) {
    console.error('[extract]', err);
    setExtractStatus('extract failed');
    // Put utterances back so they're retried
    state.recentUtterances = [...recent, ...state.recentUtterances];
  } finally {
    state.extractInFlight = false;
  }
}

function setExtractStatus(msg) {
  const el = document.getElementById('extract-status');
  if (el) el.textContent = msg;
}

// ── Replay mode ───────────────────────────────────────────────────────────────
async function loadSamples() {
  try {
    const resp = await fetch('/api/samples');
    const files = await resp.json();
    const sel = document.getElementById('sample-select');
    sel.innerHTML = files.map(f => `<option value="${f}">${f.replace('.txt', '')}</option>`).join('');
  } catch (e) {
    console.error('Could not load samples', e);
  }
}

async function startReplay() {
  const sel = document.getElementById('sample-select');
  const filename = sel.value;
  if (!filename) return;

  const resp = await fetch(`/test/${filename}`);
  const text = await resp.text();
  const utterances = parseTranscriptFile(text);
  if (utterances.length === 0) { alert('No utterances found in file.'); return; }

  // Reset state
  state.notes = createEmptyNotes();
  state.transcript = [];
  state.recentUtterances = [];
  state.replayUtterances = utterances;
  state.replayIndex = 0;
  state.replayPaused = false;
  state.lastExtractTime = 0;
  state.extractInFlight = false;
  state.totalTokens = 0;

  // Replay clock shows call timestamps, not real elapsed time
  state.callStart = null;
  stopTimer();
  document.getElementById('timer').textContent = '00:00';
  setStatus('replay', `REPLAY: ${filename}`);
  document.getElementById('btn-replay-pause').classList.remove('hidden');
  document.getElementById('btn-replay-start').textContent = '↺ Restart';
  document.getElementById('btn-end').classList.remove('hidden');
  clearInterimFromDOM();
  state.transcriptScrollLocked = false;
  document.getElementById('transcript-list').innerHTML = '';
  document.getElementById('btn-jump')?.classList.add('hidden');
  document.getElementById('btn-jump-narrow')?.classList.add('hidden');

  renderAll();
  scheduleNextUtterance();
}

function scheduleNextUtterance() {
  if (state.replayInterval) clearTimeout(state.replayInterval);

  // Sequential tick: await extract before scheduling the next utterance.
  // This guarantees exactly 12-utterance batches, matching lib/extractor.js.
  async function tick() {
    if (state.replayPaused) {
      state.replayInterval = setTimeout(tick, 100);
      return;
    }

    if (state.replayIndex >= state.replayUtterances.length) {
      setStatus('replay', 'REPLAY COMPLETE');
      // Final flush — force regardless of batch size, wait for any in-flight call
      state.forceFlush = true;
      await maybeExtract();
      let maxWait = 90; // up to 18 seconds
      while ((state.extractInFlight || state.recentUtterances.some(u => u.speaker === 'Her')) && maxWait-- > 0) {
        await new Promise(r => setTimeout(r, 200));
        if (!state.extractInFlight && state.recentUtterances.some(u => u.speaker === 'Her')) {
          await maybeExtract();
        }
      }
      state.forceFlush = false;
      document.getElementById('replay-progress').textContent = 'Done';
      renderAll();
      return; // no more ticks
    }

    const utt = state.replayUtterances[state.replayIndex++];
    state.transcript.push(utt);
    state.recentUtterances.push(utt);

    document.getElementById('timer').textContent = utt.ts;
    addUtteranceToDOM(utt);
    checkDontPromise(utt);
    if (utt.speaker === 'Me') checkParkedFollowUps();
    document.getElementById('replay-progress').textContent =
      `${state.replayIndex} / ${state.replayUtterances.length}`;

    await maybeExtract(); // awaited — next utterance waits for any triggered extraction
    renderAll();

    const speedMs = parseInt(document.getElementById('replay-speed').value) || 600;
    state.replayInterval = setTimeout(tick, speedMs);
  }

  const speedMs = parseInt(document.getElementById('replay-speed').value) || 600;
  state.replayInterval = setTimeout(tick, speedMs);
}

function toggleReplayPause() {
  state.replayPaused = !state.replayPaused;
  document.getElementById('btn-replay-pause').textContent = state.replayPaused ? '▶ Resume' : '⏸ Pause';
}

// ── Live mic (Phase 2) ────────────────────────────────────────────────────────
function secToTs(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

async function startLive() {
  if (state.liveMode) { stopLive(); return; }

  // Reset state
  state.notes = createEmptyNotes();
  state.transcript = [];
  state.recentUtterances = [];
  state.lastExtractTime = 0;
  state.extractInFlight = false;
  state.totalTokens = 0;
  state.sessionStart = Date.now();
  state.liveMode = true;

  clearInterimFromDOM();
  state.transcriptScrollLocked = false;
  document.getElementById('transcript-list').innerHTML = '';
  document.getElementById('btn-jump')?.classList.add('hidden');
  document.getElementById('btn-jump-narrow')?.classList.add('hidden');
  renderAll();
  startTimer();
  setStatus('listening', 'LIVE');

  const btnLive = document.getElementById('btn-live');
  if (btnLive) btnLive.textContent = '⏹ Stop Live';

  // Reset live status
  state.dgBytesSent = 0;
  state.dgLastResultTime = null;
  state.dgGotResult = false;
  state.liveErrorMsg = null;
  state.dgWsState = null;
  state.activeEngine = null;
  state.liveStatusInterval = setInterval(updateLiveStatus, 1000);

  const engineChoice = localStorage.getItem('liveEngine') || 'auto';

  if (engineChoice === 'chrome') {
    startSpeechAPIMic();
    return;
  }

  // Try Deepgram (for 'deepgram' or 'auto')
  let deepgramAvailable = false;
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    deepgramAvailable = cfg.deepgramAvailable;
  } catch {}

  if (deepgramAvailable) {
    await startDeepgramMic();
  } else if (engineChoice === 'deepgram') {
    setLiveError('Deepgram key not set — go to Settings to add it.');
  } else {
    startSpeechAPIMic();
  }
}

function stopLive() {
  state.liveMode = false;
  if (state.dgFallbackTimer) { clearTimeout(state.dgFallbackTimer); state.dgFallbackTimer = null; }
  if (state.liveStatusInterval) { clearInterval(state.liveStatusInterval); state.liveStatusInterval = null; }
  if (state.dgWs) { state.dgWs.close(); state.dgWs = null; }
  if (state.speechRec) { state.speechRec.stop(); state.speechRec = null; }
  if (state.micStream) { state.micStream.getTracks().forEach(t => t.stop()); state.micStream = null; }
  if (state.audioCtx) { state.audioCtx.close(); state.audioCtx = null; }
  const bar = document.getElementById('live-status-bar');
  if (bar) bar.classList.add('hidden');
  stopLevelMeter();
  stopTimer();
  setStatus('stopped', 'CALL ENDED');

  const btnLive = document.getElementById('btn-live');
  if (btnLive) btnLive.textContent = '🎙 Start Live';

  // Save session
  saveLiveSession();
  // Final extract
  state.lastExtractTime = 0;
  maybeExtract().then(() => renderAll());
}

async function startDeepgramMic() {
  state.activeEngine = 'deepgram';
  state.dgWsState = 'connecting';
  updateLiveStatus();
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    state.audioCtx = new AudioContext({ sampleRate: 16000 });
    const src = state.audioCtx.createMediaStreamSource(state.micStream);
    const proc = state.audioCtx.createScriptProcessor(4096, 1, 1);
    src.connect(proc);
    proc.connect(state.audioCtx.destination);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.dgWs = new WebSocket(`${proto}//${location.host}/mic`);

    state.dgWs.onopen = () => {
      state.dgWsState = 'open';
      updateLiveStatus();
    };

    state.dgWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') {
          setLiveError(`Deepgram: ${msg.message}`);
          return;
        }
        if (msg.type === 'ready') return; // server signals Deepgram upstream connected
        if (msg.channel && !msg.is_final) {
          const alt = msg.channel.alternatives[0];
          if (alt && alt.transcript.trim()) {
            const spkIdx = alt.words?.[0]?.speaker ?? 0;
            const speaker = (spkIdx === 0) === state.liveSpeaker0IsMe ? 'Me' : 'Her';
            addInterimToDOM(speaker, alt.transcript.trim());
          }
          return;
        }
        if (msg.channel && msg.is_final) {
          const alt = msg.channel.alternatives[0];
          if (!alt || !alt.transcript.trim()) return;
          // First result: cancel fallback timer
          if (!state.dgGotResult) {
            state.dgGotResult = true;
            if (state.dgFallbackTimer) { clearTimeout(state.dgFallbackTimer); state.dgFallbackTimer = null; }
          }
          state.dgLastResultTime = Date.now();
          updateLiveStatus();
          const spkIdx = alt.words?.[0]?.speaker ?? 0;
          const speaker = (spkIdx === 0) === state.liveSpeaker0IsMe ? 'Me' : 'Her';
          const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
          addLiveUtterance({ ts: secToTs(elapsed), speaker, text: alt.transcript.trim() });
        }
      } catch {}
    };

    state.dgWs.onclose = (ev) => {
      state.dgWsState = 'closed';
      updateLiveStatus();
      if (state.liveMode) console.log('[deepgram] ws closed', ev.code);
    };

    state.dgWs.onerror = () => {
      state.dgWsState = 'error';
      updateLiveStatus();
    };

    proc.onaudioprocess = (e) => {
      if (state.dgWs && state.dgWs.readyState === WebSocket.OPEN) {
        const buf = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(buf.length);
        for (let i = 0; i < buf.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, buf[i] * 32768));
        state.dgWs.send(pcm.buffer);
        state.dgBytesSent += pcm.buffer.byteLength;
      }
    };

    // Fallback: if no transcript in 10s, switch to Chrome Speech API
    state.dgFallbackTimer = setTimeout(() => {
      if (state.liveMode && !state.dgGotResult) {
        setLiveError('Deepgram: no transcript in 10s — falling back to Chrome');
        if (state.dgWs) { state.dgWs.close(); state.dgWs = null; }
        startSpeechAPIMic();
      }
    }, 10000);

    startLevelMeter(src, state.audioCtx);
  } catch (err) {
    console.error('[mic]', err);
    setLiveError(`Mic error: ${err.message}`);
    startSpeechAPIMic();
  }
}

function startSpeechAPIMic() {
  state.activeEngine = 'chrome';
  updateLiveStatus();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('No microphone API available. Please use Chrome or provide a DEEPGRAM_API_KEY.'); stopLive(); return; }

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-GB';
  state.speechRec = rec;

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (!text) continue;
      if (!e.results[i].isFinal) {
        addInterimToDOM('Me', text);
        continue;
      }
      const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
      // Speech API has no diarization — default speaker is 'Me', user must flip manually
      addLiveUtterance({ ts: secToTs(elapsed), speaker: 'Me', text });
    }
  };
  rec.onerror = (e) => {
    console.error('[speechrec]', e.error);
    setLiveError(`Speech API error: ${e.error}`);
  };
  rec.onend = () => { if (state.liveMode && state.speechRec) rec.start(); };
  rec.start();
}

function setLiveError(msg) {
  state.liveErrorMsg = msg;
  console.error('[live]', msg);
  updateLiveStatus();
}

function updateLiveStatus() {
  const bar = document.getElementById('live-status-bar');
  if (!bar) return;
  if (!state.liveMode) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  set('lst-engine', `Engine: ${state.activeEngine || '—'}`);
  if (state.activeEngine === 'deepgram') {
    set('lst-ws', `WS: ${state.dgWsState || '—'}`);
    const kb = (state.dgBytesSent / 1024).toFixed(0);
    set('lst-bytes', `Sent: ${kb} kB`);
    const ago = state.dgLastResultTime
      ? `${Math.floor((Date.now() - state.dgLastResultTime) / 1000)}s ago`
      : 'none';
    set('lst-last', `Last result: ${ago}`);
  } else {
    set('lst-ws', '');
    set('lst-bytes', '');
    set('lst-last', '');
  }
  set('lst-error', state.liveErrorMsg || '');
}

function addLiveUtterance(utt) {
  clearInterimFromDOM();
  const id = `u${String(state.transcript.length + 1).padStart(3, '0')}`;
  const cleanText = utt.speaker === 'Her' ? CoachLogic.stripStageDirections(utt.text) : utt.text;
  const fullUtt = { ...utt, id, text: cleanText };
  state.transcript.push(fullUtt);
  state.recentUtterances.push(fullUtt);
  addUtteranceToDOM(fullUtt);
  checkDontPromise(fullUtt);
  if (utt.speaker === 'Me') checkParkedFollowUps();
  maybeExtract().then(() => renderAll());
}

function startLevelMeter(sourceNode, ctx) {
  const wrap = document.getElementById('level-meter-wrap');
  const bar = document.getElementById('level-meter');
  if (!wrap || !bar) return;
  wrap.classList.remove('hidden');

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  sourceNode.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);

  state.levelMeterInterval = setInterval(() => {
    analyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
    const pct = Math.min(100, (avg / 128) * 100);
    bar.style.width = pct + '%';
  }, 50);
}

function stopLevelMeter() {
  if (state.levelMeterInterval) { clearInterval(state.levelMeterInterval); state.levelMeterInterval = null; }
  const wrap = document.getElementById('level-meter-wrap');
  if (wrap) wrap.classList.add('hidden');
}

function flipSpeaker() {
  state.liveSpeaker0IsMe = !state.liveSpeaker0IsMe;
  const btn = document.getElementById('btn-flip-speaker');
  if (btn) btn.textContent = state.liveSpeaker0IsMe ? 'Me=Spk0' : 'Me=Spk1';
}

async function saveLiveSession() {
  if (state.transcript.length === 0) return;
  try {
    await fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: state.transcript, startedAt: state.sessionStart })
    });
  } catch (e) { console.error('[save session]', e); }
}

// ── Objection management (Feature B) ────────────────────────────────────────
function handleIncomingObjections(newObjs) {
  if (!newObjs || !newObjs.length) return;
  const now = Date.now();
  for (const obj of newObjs) {
    // Don't re-flag within 60 seconds for same matchedKey
    const recent = state.objections.find(o =>
      o.matchedKey === obj.matchedKey && (now - o.seenAt) < 60000
    );
    if (recent) continue;
    state.objections.push({
      id: `obj-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      quote: obj.quote,
      matchedKey: obj.matchedKey || 'other',
      utteranceId: obj.utteranceId,
      timestamp: obj.timestamp,
      status: 'open',
      seenAt: now
    });
  }
  renderObjections();
}

function renderObjections() {
  const banner = document.getElementById('objection-banner');
  const chips = document.getElementById('objection-chips');
  if (!banner || !chips) return;

  const open        = state.objections.filter(o => o.status === 'open');
  const handledAuto = state.objections.filter(o => o.status === 'handled-auto');
  const handled     = state.objections.filter(o => o.status === 'handled');

  chips.innerHTML = [
    ...open.map(o =>        `<span class="obj-chip open"         data-obj-id="${o.id}" title="${escHtml(o.quote)}">${o.matchedKey}</span>`),
    ...handledAuto.map(o => `<span class="obj-chip handled-auto" data-obj-id="${o.id}" title="${escHtml(o.quote)}">${o.matchedKey} ✓?</span>`),
    ...handled.map(o =>     `<span class="obj-chip handled"      title="${escHtml(o.quote)}">${o.matchedKey} ✓</span>`)
  ].join('');

  if (open.length > 0) {
    banner.classList.remove('hidden');
    const obj = open[open.length - 1];
    const playbook = getObjectionPlaybook(obj.matchedKey);
    banner.innerHTML = `
      <div class="obj-header">
        <span class="obj-ts">${escHtml(obj.timestamp || '')}</span>
        <span class="obj-tag">${escHtml(obj.matchedKey)}</span>
        <button class="btn-small obj-dismiss" data-obj-id="${obj.id}" data-action="handled">Mark handled <kbd>O</kbd></button>
      </div>
      <div class="obj-quote">"${escHtml(obj.quote)}"</div>
      <div class="obj-worried"><strong>She's worried about:</strong> ${escHtml(playbook.worried)}</div>
      <div class="obj-saythis"><strong>Say this:</strong> ${escHtml(playbook.sayThis)}</div>
      ${playbook.reminder ? `<div class="obj-reminder">${escHtml(playbook.reminder)}</div>` : ''}
    `;
  } else if (handledAuto.length > 0) {
    banner.classList.remove('hidden');
    const obj = handledAuto[handledAuto.length - 1];
    banner.innerHTML = `
      <div class="obj-header">
        <span class="obj-ts">${escHtml(obj.timestamp || '')}</span>
        <span class="obj-tag">${escHtml(obj.matchedKey)}</span>
        <span class="obj-auto-label">Handled, auto: check</span>
        <button class="btn-small" data-obj-id="${obj.id}" data-action="confirm">Confirm <kbd>O</kbd></button>
        <button class="btn-small obj-reopen" data-obj-id="${obj.id}" data-action="reopen">Reopen</button>
      </div>
      <div class="obj-quote">"${escHtml(obj.quote)}"</div>
    `;
  } else {
    banner.classList.add('hidden');
  }
}

function getObjectionPlaybook(matchedKey) {
  if (!knowledge) return { worried: 'unknown', sayThis: 'Acknowledge and ask an open question.', reminder: '' };
  const keyMap = {
    downtime:    0,
    retraining:  1,
    cost:        2,
    compliance:  3,
    proof:       4
  };
  const idx = keyMap[matchedKey];
  if (idx !== undefined && knowledge.objections[idx]) {
    const o = knowledge.objections[idx];
    return {
      worried:  o.shes_worried,
      sayThis:  o.say_this,
      reminder: o.why_it_works
    };
  }
  return {
    worried: 'Something about the proposal.',
    sayThis: '"That\'s a fair concern. Can you tell me more about what\'s behind that?"',
    reminder: 'Listen. Ask what specifically worries them. Don\'t over-explain.'
  };
}

function dismissObjection(id, action) {
  const obj = state.objections.find(o => o.id === id);
  if (!obj) return;
  if (action === 'reopen') obj.status = 'open';
  else obj.status = 'handled'; // 'handled' or 'confirm' → green immediately
  renderObjections();
  renderBriefTicks();
  renderCoach();
}

// Check Me lines for don't-promise slips
function checkDontPromise(utt) {
  if (utt.speaker !== 'Me') return;
  const lower = utt.text.toLowerCase();
  const triggers = ['zero downtime', 'guarantee', 'cheaper', 'faster', 'safer'];
  const hit = triggers.find(t => lower.includes(t));
  if (!hit) return;
  showDontPromiseWarning(utt, hit);
}

function showDontPromiseWarning(utt, trigger) {
  const banner = document.getElementById('dont-promise-banner');
  if (!banner) return;
  banner.innerHTML = `<strong>Don't promise:</strong> You said "${escHtml(trigger)}" — ${escHtml(utt.text.slice(0, 80))}`;
  banner.classList.remove('hidden');
  // Highlight in transcript
  const uttEl = document.getElementById(`utt-${utt.id}`);
  if (uttEl) uttEl.classList.add('dont-promise');
  setTimeout(() => banner.classList.add('hidden'), 8000);
}

// ── Transcript merge helper (for display only) ────────────────────────────────
function mergedTranscript(utterances) {
  const merged = [];
  for (const u of utterances) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === u.speaker && tsToSec(u.ts) - tsToSec(prev.ts) <= 3) {
      merged[merged.length - 1] = { ...prev, text: prev.text + ' ' + u.text, ts: u.ts, id: u.id };
    } else {
      merged.push({ ...u });
    }
  }
  return merged;
}

// ── Opening phase ────────────────────────────────────────────────────────────
const OPENING_ITEMS = [
  { id: 'o1', label: 'Introduced yourself',     script: 'My name is [name], inside sales at Nutanix.' },
  { id: 'o2', label: 'Framed the 30 minutes',   script: "What I'd love to do today: understand your estate for ~20 min, then decide if a next step makes sense." },
  { id: 'o3', label: 'Set agenda / got ok',      script: 'Is that okay with you?' },
  { id: 'o4', label: 'First discovery question', script: "What made you open to this conversation, given you've been on VMware for 10 years?" },
];

function computeOpeningTicks() {
  const autos = CoachLogic.computeOpeningTicksFromTranscript(state.transcript);
  const result = {};
  for (const id of ['o1', 'o2', 'o3', 'o4']) {
    result[id] = state.openingTicks[id] === true  ? true  :
                 state.openingTicks[id] === false ? false :
                 autos[id];
  }
  return result;
}

// ── Live column ───────────────────────────────────────────────────────────────
function getLivePhase() {
  const opening = computeOpeningTicks();
  if (!opening.o1 || !opening.o2 || !opening.o3 || !opening.o4) return 'opening';

  const ticks = computeBriefTicks();
  const nutTick   = ticks.find(t => t.id === '2');
  const painTick  = ticks.find(t => t.id === '1b');
  const needsTick = ticks.find(t => t.id === '1c');
  const nutMet    = nutTick && (nutTick.status === 'done' || nutTick.status === 'suggest');
  const openObj   = state.objections.some(o => o.status === 'open');
  const pitchRdy  = (painTick?.status === 'done' || painTick?.status === 'partial') && needsTick?.status === 'done';
  if (nutMet) return openObj ? 'objection' : 'close';
  return pitchRdy ? 'pitch' : 'discovery';
}

function renderLive() {
  const liveColEl = document.getElementById('live-col');
  if (liveColEl?.classList.contains('hidden')) return;
  const compact = window.innerHeight <= 600;
  if (liveColEl) liveColEl.classList.toggle('compact', compact);
  const n = state.notes;
  const ticks = computeBriefTicks();
  const phase = getLivePhase();
  const nutTick   = ticks.find(t => t.id === '2');
  const nutMet    = nutTick && (nutTick.status === 'done' || nutTick.status === 'suggest');
  const painTick  = ticks.find(t => t.id === '1b');
  const needsTick = ticks.find(t => t.id === '1c');
  const pitchRdy  = (painTick?.status === 'done' || painTick?.status === 'partial') && needsTick?.status === 'done';

  // Timer — use last transcript timestamp (works for replay and live)
  const lastUtt = state.transcript[state.transcript.length - 1];
  const lastTs  = lastUtt?.ts || null;
  const lvTimer = document.getElementById('lv-timer');
  if (lvTimer) lvTimer.textContent = lastTs || callElapsedStr();

  // Dot: red when live or replaying
  const lvDot = document.getElementById('lv-dot');
  if (lvDot) lvDot.classList.toggle('live', state.liveMode || state.replayMode);

  // Phase label
  const phaseLabels = { opening:'Opening', discovery:'Discovery', pitch:'Pitch', objection:'Objection', close:'Close' };
  const phaseEl = document.getElementById('lv-phase-label');
  if (phaseEl) phaseEl.textContent = phaseLabels[phase] || phase;

  // Progress bar — elapsed / 30:00
  const elapsedSec = lastTs ? tsToSec(lastTs) : (state.callStart ? Math.floor((Date.now() - state.callStart) / 1000) : 0);
  const fill = document.getElementById('lv-progress-fill');
  if (fill) fill.style.width = Math.min(100, Math.round(elapsedSec / 1800 * 100)) + '%';

  const nextStepTick = ticks.find(t => t.id === '4');

  // NEXT card
  if (phase === 'opening') {
    _renderLiveNextOpening(computeOpeningTicks(), compact);
  } else {
    const { mainQ, backupQ, mainLesson, mainMove } = CoachLogic.computeCoachNext(n, state.transcript, knowledge);
    let displayQ = mainQ || '';
    let nextLabel = 'ASK NEXT';
    let nextSub = backupQ ? 'Or: ' + backupQ : '';
    let moveRef = '';
    if (nutMet) {
      nextLabel = 'SAY NEXT';
      displayQ = CoachLogic.postPitchNext(
        state.objections,
        nextStepTick && nextStepTick.status === 'done',
        (key) => getObjectionPlaybook(key).sayThis
      ) || '';
      if (phase === 'objection') {
        const openObjs = state.objections.filter(o => o.status === 'open');
        if (openObjs.length) {
          const pb = getObjectionPlaybook(openObjs[openObjs.length - 1].matchedKey);
          nextSub = pb.reminder || '';
        }
      } else if (phase === 'close') {
        nextSub = 'Call back: "At the start we said we\'d decide if a next step makes sense."';
      } else {
        nextSub = '';
      }
    } else {
      if (mainMove) moveRef = mainMove + (mainLesson ? ' · ' + mainLesson : '');
    }

    const nextLabelEl = document.getElementById('lv-next-label');
    if (nextLabelEl) nextLabelEl.textContent = nextLabel;
    const moveRefEl = document.getElementById('lv-move-ref');
    if (moveRefEl) { moveRefEl.textContent = moveRef; moveRefEl.classList.toggle('hidden', !moveRef); }
    const nextQEl = document.getElementById('lv-next-q');
    if (nextQEl) {
      nextQEl.textContent = displayQ || 'Load a sample call to begin.';
      const len = displayQ.length;
      nextQEl.style.fontSize = compact
        ? '22px'
        : (len > 90 ? '20px' : len > 60 ? '24px' : len > 40 ? '27px' : '30px');
    }
    const nextSubEl = document.getElementById('lv-next-sub');
    if (nextSubEl) nextSubEl.textContent = nextSub ? CoachLogic.truncateWords(nextSub, 70) : '';
  }

  // She just said
  const herUtts = state.transcript.filter(u => u.speaker === 'Her');
  const lastHer = herUtts[herUtts.length - 1] || null;
  let sheTag = '', sheDesc = '';
  if (lastHer) {
    const openObjs = state.objections.filter(o => o.status === 'open');
    const latestOpen = openObjs[openObjs.length - 1];
    if (latestOpen && latestOpen.utteranceId === lastHer.id) {
      sheTag = 'OBJECTION'; sheDesc = 'after the pitch';
    } else if (phase === 'close' && nextStepTick?.status === 'done') {
      sheTag = 'AGREEMENT'; sheDesc = 'next step agreed';
    } else {
      const st = classifyLastHerStatement(lastHer.text);
      if (st) {
        sheTag = st;
        sheDesc = st === 'SOLUTION' ? 'a need she stated' : st === 'PROBLEM' ? 'a number or metric' : 'why it\'s a problem';
      }
    }
  }
  const sheTagEl  = document.getElementById('lv-she-tag');
  const sheDescEl = document.getElementById('lv-she-desc');
  const sheRow    = document.getElementById('lv-she');
  if (sheTagEl)  sheTagEl.textContent  = sheTag;
  if (sheDescEl) sheDescEl.textContent = sheDesc;
  if (sheRow)    sheRow.style.visibility = sheTag ? '' : 'hidden';

  // Alert slot
  _renderLiveAlert(phase, ticks);

  // 8 chips
  const chipLabels = { '1a':'Situation','1b':'Pain','1c':'Needs','1d':'Impact','1e':'Timeframe','2':'Nutanix','3':'Objections','4':'Next step' };
  const chipsEl = document.getElementById('lv-chips');
  if (chipsEl) {
    chipsEl.innerHTML = ticks.map(t => {
      let dot;
      if (t.id === '3') {
        const hasAuto    = state.objections.some(o => o.status === 'handled-auto');
        const allHandled = state.objections.length > 0 && state.objections.every(o => o.status === 'handled');
        dot = allHandled ? 'done' : hasAuto ? 'partial' : (t.status === 'done' || t.status === 'suggest') ? 'done' : 'yet';
      } else {
        dot = (t.status === 'done' || t.status === 'suggest') ? 'done' : t.status === 'partial' ? 'partial' : 'yet';
      }
      return `<span class="lv-chip"><span class="lv-chip-dot ${dot}"></span>${escHtml(chipLabels[t.id] || t.id)}</span>`;
    }).join('');
  }
  const missingEl = document.getElementById('lv-missing');
  if (missingEl) {
    const miss = ticks.filter(t => t.status !== 'done' && t.status !== 'suggest').map(t => chipLabels[t.id] || t.id);
    missingEl.innerHTML = miss.length ? `Missing: <strong>${escHtml(miss.join(' · '))}</strong>` : 'Missing: <strong>nothing. All covered.</strong>';
  }

  // Pitch tab dot
  const pitchDot = document.getElementById('lv-tab-pitch-dot');
  if (pitchDot) pitchDot.classList.toggle('hidden', !pitchRdy);

  // Middle block
  _renderLiveMid(phase);

  // Dig here (discovery + objection only)
  const digEl = document.getElementById('lv-dig');
  const digChipsEl = document.getElementById('lv-dig-chips');
  const showDig = (phase === 'discovery' || phase === 'objection');
  const undigged = n.scratch.filter(s => !s.followedUp && !s.isConstraint);
  if (digEl) digEl.classList.toggle('hidden', !showDig || undigged.length === 0);
  if (showDig && digChipsEl) {
    digChipsEl.innerHTML = undigged.map(s => `<span class="lv-dig-chip">${escHtml(CoachLogic.truncateWords(s.value, 50))}</span>`).join('');
  }

  // Last 4 transcript lines (merged same-speaker within 3s)
  const txEl = document.getElementById('lv-tx');
  if (txEl) {
    const last4 = mergedTranscript(state.transcript).slice(-4);
    txEl.innerHTML = last4.map(u =>
      `<span><b>${escHtml(u.speaker)}</b> ${escHtml(u.text.length > 110 ? u.text.slice(0, 110) + '…' : u.text)}</span>`
    ).join('');
  }
}

function _renderLiveNextOpening(opening, compact) {
  const nextLabelEl = document.getElementById('lv-next-label');
  const nextQEl     = document.getElementById('lv-next-q');
  const nextSubEl   = document.getElementById('lv-next-sub');
  const moveRefEl   = document.getElementById('lv-move-ref');

  if (nextLabelEl) nextLabelEl.textContent = 'SAY THIS';
  if (moveRefEl) moveRefEl.classList.add('hidden');

  const firstUndone = OPENING_ITEMS.find(item => !opening[item.id]);
  const stepNum     = firstUndone ? OPENING_ITEMS.indexOf(firstUndone) + 1 : OPENING_ITEMS.length;

  if (nextQEl) {
    const script = firstUndone ? firstUndone.script : 'Opening complete — start discovering.';
    nextQEl.textContent = script;
    const len = script.length;
    nextQEl.style.fontSize = compact ? '22px' : (len > 90 ? '20px' : len > 60 ? '24px' : len > 40 ? '27px' : '30px');
  }
  if (nextSubEl) nextSubEl.textContent = firstUndone ? `Step ${stepNum} of ${OPENING_ITEMS.length}` : '';
}

function _renderLiveMidOpening(midEl, opening) {
  midEl.innerHTML = OPENING_ITEMS.map(item => {
    const done = opening[item.id];
    return `<div class="lv-opening-item${done ? ' done' : ''}" data-opening-id="${item.id}">
      <span class="lv-opening-check">${done ? '✓' : '○'}</span>
      <span class="lv-opening-label">${escHtml(item.label)}</span>
    </div>`;
  }).join('');
}

function _renderLiveAlert(phase, ticks) {
  const alertEl = document.getElementById('lv-alert');
  if (!alertEl) return;
  const n = state.notes;
  const nutTick     = ticks.find(t => t.id === '2');
  const nutMet      = nutTick && (nutTick.status === 'done' || nutTick.status === 'suggest');
  const painTick    = ticks.find(t => t.id === '1b');
  const needsTick   = ticks.find(t => t.id === '1c');
  const nextStepTick = ticks.find(t => t.id === '4');
  const openObjs    = state.objections.filter(o => o.status === 'open');
  const pitchRdy    = (painTick?.status === 'done' || painTick?.status === 'partial') && needsTick?.status === 'done';
  const numRdy      = n.numbers.paysNow.value !== null && n.numbers.quote.value !== null && n.numbers.canAbsorb.value !== null;

  alertEl.className = '';
  if (openObjs.length) {
    alertEl.className = 'alert-red';
    const obj = openObjs[openObjs.length - 1];
    const pb  = getObjectionPlaybook(obj.matchedKey);
    alertEl.innerHTML = `
      <div class="lv-alert-body">
        <span class="lv-alert-title">"${escHtml(CoachLogic.truncateWords(obj.quote, 48))}"</span>
        <span class="lv-alert-sub">${escHtml(pb.worried)}</span>
      </div>
      <button class="btn-lv-red" data-obj-id="${obj.id}" data-action="handled">Handled&nbsp;<kbd style="background:none;border:none;font:inherit;font-weight:700">O</kbd></button>`;
  } else if (nextStepTick?.status === 'done') {
    alertEl.className = 'alert-green';
    const nsFields = [n.nextStep.who.value, n.nextStep.purpose.value, n.nextStep.dateTime.value].filter(Boolean).length;
    alertEl.innerHTML = `
      <div class="lv-alert-body">
        <span class="lv-alert-title">Next step agreed</span>
        <span class="lv-alert-sub">${escHtml(CoachLogic.truncateWords(n.nextStep.dateTime.value || n.nextStep.who.value || '', 50))}</span>
      </div>
      <span class="lv-green-badge">${nsFields} of 3</span>`;
  } else if (pitchRdy && !nutMet) {
    alertEl.className = 'alert-amber';
    const filled = n.needs.filter(nd => nd.value);
    const topIdx = resolveTopNeedIndex(filled);
    const topText = filled[topIdx]?.value || '';
    alertEl.innerHTML = `
      <div class="lv-alert-body">
        <span class="lv-alert-title">Ready to pitch</span>
        <span class="lv-alert-sub">Pain and ${filled.length} need${filled.length !== 1 ? 's' : ''} captured.${topText ? ' Top: ' + escHtml(CoachLogic.truncateWords(topText, 25)) : ''}</span>
      </div>
      <button class="btn-lv-amber" data-tick-action="2">Pitched&nbsp;<kbd style="background:none;border:none;font:inherit;font-weight:700">N</kbd></button>`;
  } else if (numRdy) {
    alertEl.className = 'alert-amber';
    const d = computeDerived();
    const gap = d.gapPerYear != null ? ` Up ${fmtNum(d.gapPerYear)} a year.` : '';
    alertEl.innerHTML = `
      <div class="lv-alert-body">
        <span class="lv-alert-title">Numbers ready to summarise</span>
        <span class="lv-alert-sub">Pays now, quote and absorb are all in.${escHtml(gap)}</span>
      </div>
      <button class="btn-lv-amber" data-summarise="numbers">Summarise&nbsp;<kbd style="background:none;border:none;font:inherit;font-weight:700">S</kbd></button>`;
  } else {
    alertEl.className = 'alert-empty';
    alertEl.innerHTML = '';
  }
}

function _renderLiveMidTranscript(midEl) {
  const merged = mergedTranscript(state.transcript);
  let html = merged.map(u => {
    const t = u.text.length > 200 ? u.text.slice(0, 200) + '…' : u.text;
    return `<div class="utterance"><span class="utt-ts">${escHtml(u.ts)}</span><span class="utt-sp ${u.speaker === 'Me' ? 'me' : 'her'}">${escHtml(u.speaker)}</span><span class="utt-text">${escHtml(t)}</span></div>`;
  }).join('');
  if (state.interimText) {
    html += `<div class="utterance utt-interim"><span class="utt-ts"></span><span class="utt-sp ${state.interimSpeaker === 'Me' ? 'me' : 'her'}">${escHtml(state.interimSpeaker || '')}</span><span class="utt-text">${escHtml(state.interimText)}</span></div>`;
  }
  midEl.innerHTML = html;
  if (!state.transcriptScrollLocked) midEl.scrollTop = midEl.scrollHeight;
}

function _renderLiveMid(phase) {
  const midEl = document.getElementById('lv-mid');
  if (!midEl) return;
  const n = state.notes;
  if (state.liveTab === 'pitch') { _renderLiveMidPitch(midEl, n); return; }
  if (state.liveTab === 'transcript') { _renderLiveMidTranscript(midEl); return; }
  if      (phase === 'opening')   _renderLiveMidOpening(midEl, computeOpeningTicks());
  else if (phase === 'discovery') _renderLiveMidDiscovery(midEl, n);
  else if (phase === 'pitch')     _renderLiveMidPitch(midEl, n);
  else if (phase === 'objection') _renderLiveMidObjection(midEl, n);
  else                             _renderLiveMidClose(midEl, n);
}

function _renderLiveMidDiscovery(midEl, n) {
  const estParts = [
    n.situation.hosts.value    ? `${n.situation.hosts.value} hosts` : null,
    n.situation.vms.value      ? `${n.situation.vms.value} VMs` : null,
    n.situation.storageTB.value ? `${n.situation.storageTB.value} TB` : null,
    n.situation.teamSize.value  ? `team of ${n.situation.teamSize.value}` : null,
  ].filter(Boolean);
  const d = computeDerived();
  const monParts = [
    n.numbers.paysNow.value  !== null ? fmtNum(n.numbers.paysNow.value) + ' now'   : null,
    n.numbers.quote.value    !== null ? fmtNum(n.numbers.quote.value) + ' quote'   : null,
    n.numbers.canAbsorb.value !== null ? fmtNum(n.numbers.canAbsorb.value) + ' absorb' : null,
  ].filter(Boolean);
  const monSub = [
    d.gapPerYear != null ? `Up ${fmtNum(d.gapPerYear)} a year` : null,
    d.monthlyGap != null ? `about ${fmtNum(d.monthlyGap)}/mo` : null,
  ].filter(Boolean).join(', ');
  const numRdy = n.numbers.paysNow.value !== null && n.numbers.quote.value !== null && n.numbers.canAbsorb.value !== null;
  const dateParts = [n.deadline.value, n.renewalDate.value].filter(Boolean);
  const dim = (t) => `<span class="lv-row-dim">${t}</span>`;

  midEl.innerHTML = `
    <div class="lv-row" style="align-items:baseline">
      <span class="lv-row-label">Estate</span>
      <span class="lv-row-primary">${estParts.length ? escHtml(estParts.join(' · ')) : dim('not yet captured')}</span>
    </div>
    <div class="lv-row">
      <span class="lv-row-label">Pain</span>
      <div class="lv-row-body">
        <span class="lv-row-primary">${n.pain.value ? escHtml(CoachLogic.truncateWords(n.pain.value, 55)) : dim('not yet captured')}</span>
        ${n.whatItAffects.value ? `<span class="lv-row-sub">${escHtml(CoachLogic.truncateWords(n.whatItAffects.value, 55))}</span>` : ''}
      </div>
      <button class="btn-lv-summ" data-summarise="pain">Summarise</button>
    </div>
    <div class="lv-row">
      <span class="lv-row-label">Money</span>
      <div class="lv-row-body">
        <span class="lv-row-primary">${monParts.length ? escHtml(monParts.join(' · ')) : dim('not yet captured')}</span>
        ${monSub ? `<span class="lv-row-sub">${escHtml(monSub)}</span>` : ''}
      </div>
      ${numRdy ? '<span class="lv-ready-badge">Ready</span>' : ''}
    </div>
    <div class="lv-row" style="align-items:baseline">
      <span class="lv-row-label">Dates</span>
      <span class="lv-row-primary">${dateParts.length ? escHtml(dateParts.join(' · ')) : dim('not yet captured')}</span>
    </div>`;
}

function _renderLiveMidPitch(midEl, n) {
  const filled = n.needs.filter(nd => nd.value);
  if (!filled.length) {
    midEl.innerHTML = `<span class="lv-row-dim" style="font-size:14px;line-height:1.5">Pitch lines appear here as needs are captured.<br>Switch to Notes to see discovery progress.</span>`;
    return;
  }
  const topIdx = resolveTopNeedIndex(filled);
  let html = `<div class="lv-pitch-intro">A lot of VMware customers are looking at alternatives since Broadcom changed the licensing. Nutanix puts your servers, storage and networking into one system — managed from one place.</div>`;
  for (let i = 0; i < filled.length; i++) {
    const nd = filled[i];
    const isTop = i === topIdx;
    const pitchLine = _buildPitchLine(nd);
    if (isTop) {
      const lbl = nd.painType ? `Top need · ${nd.painType.toLowerCase()}` : 'Top need';
      html += `<div class="lv-pitch-top"><span class="lv-pitch-top-label">${escHtml(lbl)}</span><span class="lv-pitch-top-text">${escHtml(pitchLine)}</span></div>`;
    } else {
      html += `<div class="lv-pitch-need"><span class="lv-pitch-need-label">Need ${i + 1}</span><span class="lv-pitch-other-text">${escHtml(pitchLine)}</span></div>`;
    }
  }
  html += `<div class="lv-pitch-checkin">How does that sit against what you need? <span>Then stop talking.</span></div>`;
  midEl.innerHTML = html;
}

function _buildPitchLine(nd) {
  if (knowledge) {
    const pt = nd.painType;
    const lk = pt ? knowledge.lookup.find(l => l.painType === pt) : null;
    if (lk && lk.weDo) return `${lk.weDo} You told me ${shortQuote(nd.value, 8)}.`;
  }
  return `You told me ${shortQuote(nd.value, 10)}. So here's how that fits.`;
}

function _renderLiveMidObjection(midEl, n) {
  const filled = n.needs.filter(nd => nd.value);
  const topIdx = resolveTopNeedIndex(filled);
  const needsHtml = filled.map((nd, i) => i === topIdx
    ? `<span class="lv-need-top"><span class="lv-top-marker">${i+1} top</span>  ${escHtml(CoachLogic.truncateWords(nd.value, 45))}</span>`
    : `<span class="lv-need-other">${i+1}  ${escHtml(CoachLogic.truncateWords(nd.value, 45))}</span>`
  ).join('');
  const objLog = state.objections.map(o => {
    const col = (o.status === 'handled' || o.status === 'handled-auto') ? '#4CD38A' : '#FFB4B4';
    const lbl = o.status === 'handled' ? 'handled' : o.status === 'handled-auto' ? 'auto' : 'open';
    return `${escHtml(o.matchedKey)}: <b style="color:${col}">${lbl}</b>`;
  }).join(' · ');

  midEl.innerHTML = `
    <div class="lv-row">
      <span class="lv-row-label">Needs</span>
      <div class="lv-row-body" style="gap:5px">${needsHtml || '<span class="lv-row-dim">none yet</span>'}</div>
      <button class="btn-lv-summ" data-summarise="needs">Summarise</button>
    </div>
    ${n.signOff.value ? `<div class="lv-row" style="align-items:baseline"><span class="lv-row-label">Signs off</span><span class="lv-row-primary">${escHtml(n.signOff.value)}</span></div>` : ''}
    ${n.personalStake.value ? `<div class="lv-row" style="align-items:baseline"><span class="lv-row-label">Her stake</span><span class="lv-row-primary">${escHtml(CoachLogic.truncateWords(n.personalStake.value, 55))}</span></div>` : ''}
    ${objLog ? `<div class="lv-row" style="align-items:baseline"><span class="lv-row-label">Log</span><span style="font-size:15px;color:#D5DBE3;overflow:hidden">${objLog}</span></div>` : ''}`;
}

function _renderLiveMidClose(midEl, n) {
  const who  = n.nextStep.who.value || '—';
  const what = n.nextStep.purpose.value || '—';
  const when = n.nextStep.dateTime.value || '—';
  const objLog = state.objections.map(o => {
    const col = (o.status === 'handled' || o.status === 'handled-auto') ? '#4CD38A' : '#FFB4B4';
    const lbl = o.status === 'handled' ? 'handled' : o.status === 'handled-auto' ? 'auto' : 'open';
    return `${escHtml(o.matchedKey)}: <b style="color:${col}">${lbl}</b>`;
  }).join(' · ');

  midEl.innerHTML = `
    <div class="lv-close-block"><span class="lv-close-label">Who</span><span class="lv-close-val">${escHtml(who)}</span></div>
    <div class="lv-close-block"><span class="lv-close-label">What</span><span class="lv-close-val">${escHtml(what)}</span></div>
    <div class="lv-close-block"><span class="lv-close-label">When</span><span class="lv-close-val">${escHtml(when)}</span></div>
    ${objLog ? `<div class="lv-obj-log"><span class="lv-row-label">Objections</span><span style="font-size:15px;color:#D5DBE3">${objLog}</span></div>` : ''}`;
}

// ── DOM rendering ─────────────────────────────────────────────────────────────
function renderAll() {
  CoachLogic.autoHandleObjections(state.objections, state.transcript);
  renderFields();
  renderDerived();
  renderNeeds();
  renderPitch();
  renderCoverage();
  renderBriefTicks();
  enrichScratchItems();
  renderParked();
  renderCoach();
  renderObjections();
  renderCompleteness();
  renderLive();
}

function renderFields() {
  // Simple fields: map of field path → element id
  const fieldMap = [
    ['situation.hosts',     'f-situation-hosts'],
    ['situation.vms',       'f-situation-vms'],
    ['situation.storageTB', 'f-situation-storageTB'],
    ['situation.teamSize',  'f-situation-teamSize'],
    ['situation.workloads', 'f-situation-workloads'],
    ['painType',            'f-painType'],
    ['pain',                'f-pain'],
    ['whatItAffects',       'f-whatItAffects'],
    ['whyProblem',          'f-whyProblem'],
    ['numbers.paysNow',     'f-numbers-paysNow'],
    ['numbers.quote',       'f-numbers-quote'],
    ['numbers.canAbsorb',   'f-numbers-canAbsorb'],
    ['deadline',            'f-deadline'],
    ['renewalDate',         'f-renewalDate'],
    ['doingNothing',        'f-doingNothing'],
    ['cause',               'f-cause'],
    ['otherDrivers',        'f-otherDrivers'],
    ['impactOnOthers',      'f-impactOnOthers'],
    ['personalStake',       'f-personalStake'],
    ['signOff',             'f-signOff'],
    ['budget',              'f-budget'],
    ['topNeed',             'f-topNeed'],
    ['needReason',          'f-needReason'],
    ['nextStep.who',        'f-nextStep-who'],
    ['nextStep.purpose',    'f-nextStep-purpose'],
    ['nextStep.dateTime',   'f-nextStep-dateTime'],
  ];

  for (const [path, elId] of fieldMap) {
    const el = document.getElementById(elId);
    if (!el) continue;
    const f = getField(state.notes, path);
    if (!f) continue;

    el.className = 'field-value';
    if (f.value !== null && f.value !== undefined && f.value !== '') {
      const isNum = ['numbers.paysNow', 'numbers.quote', 'numbers.canAbsorb'].includes(path);
      const isSuggested = path === 'painType' && !f.locked && f.value;
      el.textContent = isNum ? fmtNum(f.value) : (isSuggested ? '~ ' + String(f.value) : String(f.value));
      el.classList.add('filled');
      if (f.locked) el.classList.add('locked');
      if (isSuggested) el.classList.add('suggested');
      if (f.confidence < 0.65) el.classList.add('low-conf');
    } else {
      el.textContent = '';
    }

    // Store data for tooltip and editing
    el.dataset.field = path;
    el.dataset.evidence = JSON.stringify(f.evidence || []);
    el.dataset.confidence = f.confidence || 0;
    el.dataset.history = JSON.stringify(f.history || []);
  }
}

function renderDerived() {
  const d = computeDerived();

  const ipEl = document.getElementById('d-increasePct');
  if (ipEl) {
    if (d.increasePct != null) {
      ipEl.textContent = fmtPct(d.increasePct);
      ipEl.classList.add('filled');
    } else {
      ipEl.textContent = '';
      ipEl.classList.remove('filled');
    }
  }

  const gpEl = document.getElementById('d-gapPerYear');
  if (gpEl) {
    if (d.gapPerYear != null) {
      gpEl.textContent = fmtNum(d.gapPerYear) + ' gap';
      gpEl.classList.add('filled');
    } else {
      gpEl.textContent = '';
      gpEl.classList.remove('filled');
    }
  }

  // Monthly equivalents (M7 L24)
  const setDerived = (id, val, suffix) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (val != null) { el.textContent = fmtNum(val) + (suffix || '') + '/mo'; el.classList.add('filled'); }
    else { el.textContent = ''; el.classList.remove('filled'); }
  };
  setDerived('d-monthly-pays', d.monthlyPaysNow, '');
  setDerived('d-monthly-quote', d.monthlyQuote, '');
  setDerived('d-monthly-gap', d.monthlyGap, ' gap');

  // Old inline summaries hidden — on-demand via Summarise buttons (summary-panel-X)
  ['summary-numbers', 'summary-cause', 'summary-needs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  // Close book-it
  const cbEl = document.getElementById('close-book-it');
  if (cbEl) {
    cbEl.textContent = d.closeBookIt || '';
    cbEl.classList.toggle('hidden', !d.closeBookIt);
  }

  // Targeted questions
  const tcEl = document.getElementById('targeted-cause');
  if (tcEl) {
    if (d.causeQuestion) {
      tcEl.textContent = '💡 ' + d.causeQuestion;
      tcEl.classList.remove('hidden');
    } else {
      tcEl.classList.add('hidden');
    }
  }
  const tiEl = document.getElementById('targeted-impact');
  if (tiEl) {
    if (d.impactQuestion) {
      tiEl.textContent = '💡 ' + d.impactQuestion;
      tiEl.classList.remove('hidden');
    } else {
      tiEl.classList.add('hidden');
    }
  }
}

function renderNeeds() {
  const list = document.getElementById('needs-list');
  if (!list) return;
  const filled = state.notes.needs.filter(n => n.value);
  if (filled.length === 0) { list.innerHTML = ''; return; }

  const topIdx = resolveTopNeedIndex(filled);

  list.innerHTML = filled.map((nd, i) => {
    const isTop = i === topIdx;
    const tierClass = `tier-${nd.sourceTier || nd.tier || 'need'}`;
    const topAssumed = isTop && !state.notes.topNeed.value;

    let tags = `<span class="need-tag ${tierClass}">${nd.sourceTier || 'need'}</span>`;
    if (isTop && topAssumed) tags += `<span class="need-tag top-assumed">assumed top</span>`;
    if (isTop && !topAssumed) tags += `<span class="need-tag tier-need">★ top</span>`;
    if (nd.painType) tags += `<span class="need-tag pain-type">${nd.painType}</span>`;
    else if (nd.painTypeSuggested !== false) tags += `<span class="need-tag no-pain-type">no pain type</span>`;

    return `<div class="need-item" data-need-idx="${i}">
      <span class="need-num">${i + 1}</span>
      <span class="need-text">${escHtml(nd.value)}</span>
      <span style="display:flex;gap:3px;flex-wrap:wrap">${tags}</span>
    </div>`;
  }).join('');
}

function renderPitch() {
  if (state.pitchHeld) return; // frozen
  const pitch = buildPitch();

  const panel = document.getElementById('pitch-panel');
  const linesEl = document.getElementById('pitch-lines');
  const statusEl = document.getElementById('pitch-status');
  const missingEl = document.getElementById('pitch-missing');
  const confEl = document.getElementById('pitch-confidence-bar');

  if (!panel) return;

  // Confidence dot
  if (confEl) {
    confEl.innerHTML = `<span class="conf-dot ${pitch.confidence}"></span>
      <span style="font-size:11px;color:var(--text-dim)">${pitch.confidence}</span>`;
  }

  // Status line (mirrors xlsx Pitch A3 formula)
  const filledNeeds = state.notes.needs.filter(n => n.value).length;
  const typedPainTypes = state.notes.needs.filter(n => n.value && n.painType).length;
  const topChosen = !!state.notes.topNeed.value;
  if (statusEl) {
    statusEl.textContent = `Needs: ${filledNeeds}   Pain types: ${typedPainTypes}/${filledNeeds || '0'}   Top: ${topChosen ? 'chosen' : 'assumed'}`;
  }

  if (!pitch.available) {
    if (linesEl) linesEl.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:4px 0">Nothing heard yet — pitch builds as soon as she says anything useful.</div>`;
    if (missingEl) missingEl.textContent = pitch.missing.join('\n');
    return;
  }

  // Build pitch HTML
  // Opener (always) + lines + check-in + close
  let html = `<div class="pitch-opener">"Can I try a few ideas on you?"</div>`;
  html += `<div class="pitch-opener" style="margin-bottom:6px">"A lot of VMware customers are looking at alternatives since Broadcom changed the licensing. Nutanix puts your servers, storage and networking into one system, so you manage it from one place."</div>`;

  for (const line of pitch.lines) {
    let tags = '';
    if (line.isTop && line.topAssumed) tags += `<span class="pitch-tag assumed">assumed top</span>`;
    if (line.tier === 'pain')  tags += `<span class="pitch-tag from-pain">from pain</span>`;
    if (line.tier === 'stake') tags += `<span class="pitch-tag from-stake">from driver</span>`;
    if (line.noPainType) tags += `<span class="pitch-tag no-type">no pain type</span>`;
    let howHtml = '';
    if (line.howFact) {
      const url = line.howUrl || '#';
      howHtml = `<div class="pitch-how-fact" onclick="window.open('${url}','_blank')" title="${escHtml(line.howFact)}">▶ If she asks how (click for source)</div>`;
    }
    const checkIn = (line.tier === 'pain' || line.tier === 'stake')
      ? '"Is that the right priority?"'
      : '"How does that sit against what you need?"';
    html += `<div class="pitch-line">
      ${escHtml(line.text)}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
      ${howHtml}
    </div>`;
  }

  // Check-in
  const checkIn = pitch.lines.some(l => l.tier !== 'need')
    ? '"Is that the right priority?" Then stop talking.'
    : '"How does that sit against what you need?" Then stop talking.';
  html += `<div class="pitch-check" style="margin-top:6px">${checkIn}</div>`;

  if (linesEl) linesEl.innerHTML = html;

  if (missingEl) {
    missingEl.textContent = pitch.missing.join(' • ');
    missingEl.style.display = pitch.missing.length ? '' : 'none';
  }
}

function renderCoverage() {
  const el = document.getElementById('coverage-chips');
  if (!el) return;
  const areas = computeCoverage();
  el.innerHTML = areas.map(a => {
    const cls = a.covered ? 'chip covered' : a.partial ? 'chip partial' : 'chip';
    return `<span class="${cls}">${a.label}</span>`;
  }).join('');
}

function renderBriefTicks() {
  const el = document.getElementById('brief-list');
  if (!el) return;
  const ticks = computeBriefTicks();
  el.innerHTML = ticks.map(t => {
    let tickEl, cls;
    if (t.status === 'done')    { tickEl = '✓ Done'; cls = 'done'; }
    else if (t.status === 'partial') { tickEl = '◑ Part'; cls = 'partial'; }
    else if (t.status === 'suggest') { tickEl = '? Tick?'; cls = 'suggest'; }
    else if (t.status === 'yet') { tickEl = 'Not yet'; cls = 'yet'; }
    else { tickEl = t.status; cls = 'yet'; }

    const clickAttr = t.clickable ? `data-tick-id="${t.id}" style="cursor:pointer"` : '';
    const suggestion = t.suggestion ? `<span class="brief-suggestion">${escHtml(t.suggestion)}</span>` : '';
    return `<div class="brief-item" ${clickAttr}>
      <span class="brief-tick ${cls}">${tickEl}</span>
      <span class="brief-what">${t.id}. ${escHtml(t.what)}${suggestion}</span>
    </div>`;
  }).join('');
}

function renderParked() {
  const section = document.getElementById('parked-section');
  const list = document.getElementById('parked-list');
  if (!section || !list) return;
  const undiggedItems = state.notes.scratch.filter(s => !s.followedUp && !s.isConstraint);
  if (undiggedItems.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  list.innerHTML = undiggedItems.map(item =>
    `<div class="parked-item">
      <span class="parked-ts">${item.ts || ''}</span>
      <span class="parked-quote">"${escHtml(item.value)}"</span>
      ${item.followUpQ ? `<span class="parked-followup">Ask: ${escHtml(item.followUpQ)}</span>` : ''}
    </div>`
  ).join('');
}

function renderConstraints() {
  const chips = document.getElementById('constraint-chips');
  if (!chips) return;
  const items = state.notes.scratch.filter(s => s.isConstraint);
  if (items.length === 0) { chips.innerHTML = ''; return; }
  chips.innerHTML = items.map(item =>
    `<span class="constraint-chip" title="${escHtml(item.value)}">⚠ ${escHtml(item.value.slice(0, 50))}</span>`
  ).join('');
}

// ── On-demand section summaries ────────────────────────────────────────────
function renderCompleteness() {
  const comp = computeCompleteness(state.notes);
  for (const [section, ready] of Object.entries(comp)) {
    const chip = document.getElementById(`ready-chip-${section}`);
    if (chip) chip.classList.toggle('hidden', !ready);
    // Keep summary panel hidden when section data changes — user re-clicks to refresh
    const panel = document.getElementById(`summary-panel-${section}`);
    if (panel && panel.dataset.stale === 'true') panel.classList.add('hidden');
  }
}

const SUMMARY_PANEL_IDS = {
  situation: 'summary-panel-situation',
  pain:      'summary-panel-pain',
  numbers:   'summary-numbers',
  cause:     'summary-cause',
  impact:    'summary-panel-impact',
  needs:     'summary-needs',
};

function toggleSummary(section) {
  const panelId = SUMMARY_PANEL_IDS[section];
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel) return;
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  const { text } = computeSummaryText(section);
  panel.textContent = text;
  panel.dataset.stale = 'false';
  panel.classList.remove('hidden');
}

// ── Pre-flight hearing test (5-second Deepgram session) ───────────────────
async function runHearingTest() {
  const btn    = document.getElementById('btn-hearing-test');
  const row    = document.getElementById('sstat-hearing');
  if (!btn || !row) return;

  btn.disabled = true;
  btn.textContent = 'Listening 5s…';
  setHearingRow(row, 'testing', 'listening…');

  let stream, audioCtx, ws;
  const words = [];

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const src  = audioCtx.createMediaStreamSource(stream);
    const proc = audioCtx.createScriptProcessor(4096, 1, 1);
    src.connect(proc);
    proc.connect(audioCtx.destination);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/mic`);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.channel && msg.is_final && msg.channel.alternatives[0]?.transcript.trim()) {
          const spk = msg.channel.alternatives[0].words?.[0]?.speaker ?? 0;
          words.push({ text: msg.channel.alternatives[0].transcript.trim(), spk });
        }
      } catch {}
    };

    proc.onaudioprocess = (e) => {
      if (ws.readyState === WebSocket.OPEN) {
        const buf = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(buf.length);
        for (let i = 0; i < buf.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, buf[i] * 32768));
        ws.send(pcm.buffer);
      }
    };

    await new Promise(r => setTimeout(r, 5000));
  } catch (err) {
    setHearingRow(row, 'error', 'mic error: ' + err.message);
    btn.disabled = false; btn.textContent = 'Run test (5s)';
    return;
  } finally {
    if (ws) ws.close();
    if (audioCtx) audioCtx.close();
    if (stream) stream.getTracks().forEach(t => t.stop());
  }

  btn.disabled = false; btn.textContent = 'Run test (5s)';

  if (words.length === 0) {
    setHearingRow(row, 'fail', '✗ No audio from speakers detected');
    return;
  }
  const nonPrimary = words.filter(w => w.spk !== 0);
  if (nonPrimary.length > 0) {
    setHearingRow(row, 'ok', `✓ Heard as other speaker: "${nonPrimary[0].text.slice(0, 40)}"`);
  } else {
    setHearingRow(row, 'warn', `~ Heard but all labeled Me — check routing. Heard: "${words[0].text.slice(0, 40)}"`);
  }
}

function setHearingRow(row, state, msg) {
  const dot = row.querySelector('.sstat-dot');
  const val = row.querySelector('.sstat-value');
  const cls = state === 'ok' ? 'connected' : state === 'fail' ? 'error' : state === 'warn' ? 'warn' : 'testing';
  if (dot) dot.className = `sstat-dot ${cls}`;
  if (val) { val.className = `sstat-value ${cls}`; val.textContent = msg; }
}

function renderCoach() {
  const { mainQ, backupQ, mainLesson, mainMove } = CoachLogic.computeCoachNext(state.notes, state.transcript, knowledge);

  const ticks = computeBriefTicks();
  const painMet  = ticks.find(t => t.id === '1b' && (t.status === 'done' || t.status === 'partial'));
  const needsMet = ticks.find(t => t.id === '1c' && t.status === 'done');
  const nutanixTick = ticks.find(t => t.id === '2');
  const nutanixMet = nutanixTick && (nutanixTick.status === 'done' || nutanixTick.status === 'suggest');

  // Post-pitch cycling: after Nutanix introduced, never show "ready for the pitch"
  let displayQ = mainQ;
  if (nutanixMet) {
    const nextStepTick = ticks.find(t => t.id === '4');
    displayQ = CoachLogic.postPitchNext(
      state.objections,
      nextStepTick && nextStepTick.status === 'done',
      (key) => getObjectionPlaybook(key).sayThis
    );
  }

  const mainEl   = document.getElementById('coach-main-q');
  const backupEl = document.getElementById('coach-backup-q');
  if (mainEl) mainEl.textContent = displayQ || 'All areas covered — ready for the pitch.';
  if (backupEl) backupEl.textContent = (!nutanixMet && backupQ) ? `↳ ${backupQ}` : '';

  // Lesson tag next to NEXT question
  const lessonEl = document.getElementById('coach-lesson-tag');
  if (lessonEl) {
    const tag = !nutanixMet && mainLesson ? `${mainMove || ''} ${mainLesson}`.trim() : '';
    lessonEl.textContent = tag;
    lessonEl.classList.toggle('hidden', !tag);
  }

  // Statement tag: classify last Her utterance (pclub L16)
  const herUtts = state.transcript.filter(u => u.speaker === 'Her');
  const stmtTagEl = document.getElementById('coach-statement-tag');
  const peelEl    = document.getElementById('coach-peel-nudge');
  if (stmtTagEl && herUtts.length > 0) {
    const lastHer = herUtts[herUtts.length - 1];
    const stmtType = classifyLastHerStatement(lastHer.text);
    stmtTagEl.textContent = stmtType ? `She said: ${stmtType}` : '';
    stmtTagEl.className = 'statement-tag' + (stmtType ? ` tag-${stmtType.toLowerCase().replace(/ /g,'_')}` : ' hidden');
    stmtTagEl.classList.toggle('hidden', !stmtType);
    if (peelEl) {
      const showPeel = stmtType === 'SOLUTION' && !nutanixMet;
      peelEl.textContent = showPeel ? "🧅 Peel: \"What's driving that to be a priority?\" (M3 L14)" : '';
      peelEl.classList.toggle('hidden', !showPeel);
    }
  } else if (stmtTagEl) {
    stmtTagEl.classList.add('hidden');
    if (peelEl) peelEl.classList.add('hidden');
  }

  // Alerts
  const pitchBadge = document.getElementById('coach-pitch-badge');
  if (pitchBadge) pitchBadge.classList.toggle('hidden', !(painMet && needsMet) || nutanixMet);

  const nudgeBadge = document.getElementById('coach-nudge-badge');
  if (nudgeBadge) nudgeBadge.classList.toggle('hidden', !(painMet && needsMet && !nutanixMet));

  // Dig here badge (constraints excluded — they show near Next Step)
  const undiggedCount = state.notes.scratch.filter(s => !s.followedUp && !s.isConstraint).length;
  const digBadge = document.getElementById('coach-dig-badge');
  if (digBadge) {
    if (undiggedCount > 0) {
      digBadge.textContent = `📌 ${undiggedCount}`;
      digBadge.classList.remove('hidden');
    } else {
      digBadge.classList.add('hidden');
    }
  }

  renderCritTracker(ticks);
  renderPacingBar();
  renderConstraints();
}

function renderCritTracker(ticks) {
  const el = document.getElementById('coach-crit-chips');
  if (!el) return;

  const LABELS = {
    '1a': 'Situation', '1b': 'Pain', '1c': 'Needs',
    '1d': 'Implications', '1e': 'Timeframe',
    '2': 'Nutanix', '3': 'Objections', '4': 'Next step'
  };

  const GAP_TEXT = {
    '1a': 'missing: hosts, VMs, storage, team size',
    '1b': 'missing: pain, what it affects, why problem, cause',
    '1c': 'missing: what she needs to happen',
    '1d': 'missing: cost of doing nothing, personal/org impact',
    '1e': 'missing: board date or renewal date',
    '2':  'tick done once you\'ve introduced Nutanix',
    '3':  'tick done once objections are handled',
    '4':  'missing: who, date/time for next meeting',
  };

  el.innerHTML = ticks.map(t => {
    const label = LABELS[t.id] || t.id;
    let cls = 'crit-chip';
    if (t.status === 'done' || t.status === 'suggest') cls += ' done';
    else if (t.status === 'partial') cls += ' partial';

    const gapText = (t.status !== 'done' && t.status !== 'suggest')
      ? GAP_TEXT[t.id] || '' : '';

    return `<span class="${cls}" title="${escHtml(gapText)}"><span class="crit-dot"></span>${escHtml(label)}</span>`;
  }).join('');
}

function renderPacingBar() {
  const fill  = document.getElementById('coach-pacing-fill');
  const label = document.getElementById('coach-pacing-label');
  const bar   = document.getElementById('coach-pacing-bar');
  if (!fill || !label) return;

  let elapsedMin = 0;
  if (state.liveMode && state.sessionStart) {
    elapsedMin = (Date.now() - state.sessionStart) / 60000;
  } else if (state.transcript.length > 0) {
    const lastTs = state.transcript[state.transcript.length - 1].ts;
    const [m, s] = lastTs.split(':').map(Number);
    elapsedMin = (m || 0) + (s || 0) / 60;
  }

  const CALL_MIN = 30;
  const pct = Math.min(100, (elapsedMin / CALL_MIN) * 100);
  fill.style.width = pct + '%';

  // Target zone label
  const ZONES = [
    { until: 2,  label: 'Agenda' },
    { until: 6,  label: 'Pain' },
    { until: 9,  label: 'Situation' },
    { until: 13, label: 'Numbers' },
    { until: 17, label: 'Cause' },
    { until: 22, label: 'Impact/Needs' },
    { until: 24, label: 'Pitch' },
    { until: 30, label: 'Close' },
  ];
  const zone = ZONES.find(z => elapsedMin < z.until) || ZONES[ZONES.length - 1];
  const minStr = Math.floor(elapsedMin);
  label.textContent = elapsedMin > 0 ? `${minStr}m — ${zone.label}` : '30m call';

  // Pacing cursor (absolute-positioned over bar)
  let cursor = document.getElementById('coach-pacing-cursor');
  if (!cursor && bar) {
    cursor = document.createElement('div');
    cursor.id = 'coach-pacing-cursor';
    bar.appendChild(cursor);
  }
  if (cursor) cursor.style.left = pct + '%';
}

function addUtteranceToDOM(utt) {
  const list = document.getElementById('transcript-list');
  if (!list) return;

  // Merge with previous DOM element if same speaker within 3 seconds
  const prevEl = list.lastElementChild?.id === 'utt-interim' ? list.lastElementChild.previousElementSibling : list.lastElementChild;
  if (prevEl && prevEl.dataset.speaker === utt.speaker) {
    const prevTsSec = parseInt(prevEl.dataset.tsSec || '0', 10);
    if (tsToSec(utt.ts) - prevTsSec <= 3) {
      const textEl = prevEl.querySelector('.utt-text');
      if (textEl) textEl.textContent += ' ' + utt.text;
      prevEl.dataset.tsSec = String(tsToSec(utt.ts));
      _transcriptAutoScroll();
      return;
    }
  }

  const div = document.createElement('div');
  div.className = 'utterance';
  div.id = `utt-${utt.id}`;
  div.dataset.speaker = utt.speaker;
  div.dataset.tsSec = String(tsToSec(utt.ts));
  div.innerHTML = `
    <span class="utt-ts">${utt.ts}</span>
    <span class="utt-sp ${utt.speaker === 'Me' ? 'me' : 'her'}">${utt.speaker}</span>
    <span class="utt-text">${escHtml(utt.text)}</span>`;
  // Insert before interim row if present
  const interimEl = document.getElementById('utt-interim');
  if (interimEl) list.insertBefore(div, interimEl);
  else list.appendChild(div);

  _transcriptAutoScroll();
}

function _transcriptAutoScroll() {
  if (state.transcriptScrollLocked) return;
  const col = document.getElementById('transcript-col');
  if (col) {
    col.scrollTop = col.scrollHeight;
    const btn = document.getElementById('btn-jump');
    if (btn) btn.classList.add('hidden');
  }
}

function addInterimToDOM(speaker, text) {
  state.interimText = text;
  state.interimSpeaker = speaker;
  const list = document.getElementById('transcript-list');
  if (list) {
    let el = document.getElementById('utt-interim');
    if (!el) {
      el = document.createElement('div');
      el.id = 'utt-interim';
      el.className = 'utterance utt-interim';
      list.appendChild(el);
    }
    el.innerHTML = `<span class="utt-ts"></span><span class="utt-sp ${speaker === 'Me' ? 'me' : 'her'}">${escHtml(speaker)}</span><span class="utt-text">${escHtml(text)}</span>`;
    if (!state.transcriptScrollLocked) {
      const col = document.getElementById('transcript-col');
      if (col) col.scrollTop = col.scrollHeight;
    }
  }
  if (state.liveTab === 'transcript') {
    const midEl = document.getElementById('lv-mid');
    if (midEl) _renderLiveMidTranscript(midEl);
  }
}

function clearInterimFromDOM() {
  state.interimText = null;
  state.interimSpeaker = null;
  document.getElementById('utt-interim')?.remove();
}

// ── Status indicator ─────────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  if (!dot || !label) return;
  dot.className = '';
  dot.classList.add(type); // 'replay', 'listening', 'stopped'
  label.textContent = text;
  label.className = type !== 'stopped' ? 'active' : '';
}

// ── Field editing (click to edit + lock) ─────────────────────────────────────
function openEditOverlay(path) {
  const overlay = document.getElementById('edit-overlay');
  const input = document.getElementById('edit-input');
  const label = document.getElementById('edit-label');
  if (!overlay || !input || !label) return;

  const f = getField(state.notes, path);
  if (!f) return;

  label.textContent = `Edit: ${fieldLabel(path)}`;
  input.value = f.value != null ? String(f.value) : '';
  input._editPath = path;
  overlay.classList.remove('hidden');
  input.focus();
  input.select();
}

function saveEdit() {
  const input = document.getElementById('edit-input');
  const path = input._editPath;
  if (!path) return;
  const f = getField(state.notes, path);
  if (!f) return;

  f.value = input.value.trim() || null;
  f.locked = true;
  f.evidence = ['manual-edit'];
  f.confidence = 1;

  document.getElementById('edit-overlay').classList.add('hidden');
  renderAll();
}

function cancelEdit() {
  document.getElementById('edit-overlay').classList.add('hidden');
}

// ── Evidence tooltip ──────────────────────────────────────────────────────────
function showEvidence(el, path) {
  const f = getField(state.notes, path);
  if (!f || !f.value) return;

  const tooltip = document.getElementById('evidence-tooltip');
  if (!tooltip) return;

  const evidenceIds = f.evidence || [];
  let lines = '';
  for (const id of evidenceIds) {
    const utt = state.transcript.find(u => u.id === id);
    if (utt) lines += `<div class="ev-line"><strong>${utt.speaker}</strong> [${utt.ts}]: "${escHtml(utt.text)}"</div>`;
  }
  if (!lines) lines = '<div class="ev-line">No transcript evidence linked</div>';

  const hist = f.history || [];
  if (hist.length > 0) {
    lines += `<div class="ev-conf" style="margin-top:6px">Previous values: ${hist.map(h => `"${escHtml(String(h.value))}" (corrected)`).join(', ')}</div>`;
  }

  tooltip.innerHTML = lines + `<div class="ev-conf">Confidence: ${Math.round((f.confidence || 0) * 100)}%${f.locked ? ' · Locked' : ''}</div>`;
  tooltip.classList.remove('hidden');

  const rect = el.getBoundingClientRect();
  tooltip.style.top = `${rect.bottom + 4}px`;
  tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
}

function hideEvidence() {
  const t = document.getElementById('evidence-tooltip');
  if (t) t.classList.add('hidden');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'p' || e.key === 'P') {
    // P: hold / unhold pitch panel
    state.pitchHeld = !state.pitchHeld;
    const panel = document.getElementById('pitch-panel');
    if (panel) panel.classList.toggle('held', state.pitchHeld);
    const btn = document.getElementById('btn-pitch-hold');
    if (btn) btn.textContent = state.pitchHeld ? 'Unhold' : 'Hold';
    if (!state.pitchHeld) renderPitch(); // refresh when released
  }

  if (e.key === 'o' || e.key === 'O') {
    // O on open → handled (green) immediately; O on handled-auto → handled (confirm)
    const mostRecentOpen = [...state.objections].reverse().find(o => o.status === 'open');
    if (mostRecentOpen) {
      mostRecentOpen.status = 'handled';
    } else {
      const mostRecentAuto = [...state.objections].reverse().find(o => o.status === 'handled-auto');
      if (mostRecentAuto) mostRecentAuto.status = 'handled';
    }
    renderObjections();
    renderBriefTicks();
    renderCoach();
  }

  if (e.key === 'n' || e.key === 'N') {
    const cur = state.manualTicks['2'];
    state.manualTicks['2'] = (cur === 'done') ? 'yet' : 'done';
    if (state.manualTicks['2'] === 'done') state.nutanixIntroSuggested = true;
    renderAll();
  }

  if (e.key === 's' || e.key === 'S') {
    const n = state.notes;
    const numRdy = n.numbers.paysNow.value !== null && n.numbers.quote.value !== null && n.numbers.canAbsorb.value !== null;
    if (numRdy) toggleSummary('numbers');
    else if (n.pain.value && n.whatItAffects.value) toggleSummary('pain');
    else if (n.needs.filter(nd => nd.value).length) toggleSummary('needs');
  }

  if (e.key === 'Escape') {
    cancelEdit();
  }
});

// ── Event wiring ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load knowledge
  try {
    const resp = await fetch('/data/knowledge.json');
    knowledge = await resp.json();
  } catch (e) { console.error('Could not load knowledge.json', e); }

  // Load pclub coach data
  try {
    const resp = await fetch('/data/pclub-coach.json');
    pclubCoach = await resp.json();
  } catch (e) { console.error('Could not load pclub-coach.json', e); }

  // Summarise buttons (event delegation)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-summarise]');
    if (btn) toggleSummary(btn.dataset.summarise);
  });

  // Hearing test button
  const btnHearing = document.getElementById('btn-hearing-test');
  if (btnHearing) btnHearing.addEventListener('click', runHearingTest);

  // Load sample list
  await loadSamples();
  document.getElementById('replay-controls').classList.remove('hidden');
  document.getElementById('btn-load-replay').classList.add('hidden');

  // Live mic
  const btnLive = document.getElementById('btn-live');
  if (btnLive) btnLive.addEventListener('click', startLive);
  const btnFlip = document.getElementById('btn-flip-speaker');
  if (btnFlip) btnFlip.addEventListener('click', flipSpeaker);

  // Objection dismiss
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action][data-obj-id]');
    if (btn) dismissObjection(btn.dataset.objId, btn.dataset.action);
    const chip = e.target.closest('.obj-chip.open[data-obj-id]');
    if (chip) {
      const id = chip.dataset.objId;
      const obj = state.objections.find(o => o.id === id);
      if (obj) { obj.status = 'open'; renderObjections(); }
    }
  });

  // Opening item toggles
  document.addEventListener('click', (e) => {
    const item = e.target.closest('[data-opening-id]');
    if (!item) return;
    const id = item.dataset.openingId;
    const opening = computeOpeningTicks();
    state.openingTicks[id] = opening[id] ? null : true;
    renderLive();
  });

  // Live col: tick-action buttons (e.g. Pitched N)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tick-action]');
    if (!btn) return;
    const id = btn.dataset.tickAction;
    const cur = state.manualTicks[id];
    state.manualTicks[id] = (cur === 'done') ? 'yet' : 'done';
    if (id === '2' && state.manualTicks[id] === 'done') state.nutanixIntroSuggested = true;
    renderAll();
  });

  // View toggle
  document.getElementById('btn-view-toggle')?.addEventListener('click', () => {
    const liveCol       = document.getElementById('live-col');
    const reviewView    = document.getElementById('review-view');
    const transcriptCol = document.getElementById('transcript-col');
    const btn           = document.getElementById('btn-view-toggle');
    if (!reviewView) return;
    const showingReview = !reviewView.classList.contains('hidden');
    reviewView.classList.toggle('hidden', showingReview);
    // At wide: transcript-col hides when review opens, shows when review closes
    if (transcriptCol) transcriptCol.classList.toggle('tx-hidden-for-review', !showingReview);
    if (liveCol) liveCol.classList.toggle('review-open', !showingReview);
    if (btn) btn.textContent = showingReview ? 'Review ▸' : 'Close review';
  });

  // Transcript col scroll: track if user scrolled up
  document.getElementById('transcript-col')?.addEventListener('scroll', function () {
    const atBottom = this.scrollHeight - this.scrollTop <= this.clientHeight + 60;
    state.transcriptScrollLocked = !atBottom;
    document.getElementById('btn-jump')?.classList.toggle('hidden', atBottom);
  });
  document.getElementById('btn-jump')?.addEventListener('click', () => {
    state.transcriptScrollLocked = false;
    const col = document.getElementById('transcript-col');
    if (col) col.scrollTop = col.scrollHeight;
    document.getElementById('btn-jump')?.classList.add('hidden');
  });

  // Narrow transcript tab scroll
  document.getElementById('lv-mid')?.addEventListener('scroll', function () {
    if (state.liveTab !== 'transcript') return;
    const atBottom = this.scrollHeight - this.scrollTop <= this.clientHeight + 60;
    state.transcriptScrollLocked = !atBottom;
    document.getElementById('btn-jump-narrow')?.classList.toggle('hidden', atBottom);
  });
  document.getElementById('btn-jump-narrow')?.addEventListener('click', () => {
    state.transcriptScrollLocked = false;
    const mid = document.getElementById('lv-mid');
    if (mid) mid.scrollTop = mid.scrollHeight;
    document.getElementById('btn-jump-narrow')?.classList.add('hidden');
  });

  // Mid-block tab switching
  document.getElementById('lv-tab-notes')?.addEventListener('click', () => {
    state.liveTab = 'notes';
    state.transcriptScrollLocked = false;
    document.getElementById('lv-tab-notes')?.classList.add('lv-tab-active');
    document.getElementById('lv-tab-pitch')?.classList.remove('lv-tab-active');
    document.getElementById('lv-tab-transcript')?.classList.remove('lv-tab-active');
    document.getElementById('btn-jump-narrow')?.classList.add('hidden');
    _renderLiveMid(getLivePhase());
  });
  document.getElementById('lv-tab-pitch')?.addEventListener('click', () => {
    state.liveTab = 'pitch';
    state.transcriptScrollLocked = false;
    document.getElementById('lv-tab-pitch')?.classList.add('lv-tab-active');
    document.getElementById('lv-tab-notes')?.classList.remove('lv-tab-active');
    document.getElementById('lv-tab-transcript')?.classList.remove('lv-tab-active');
    document.getElementById('btn-jump-narrow')?.classList.add('hidden');
    _renderLiveMid('pitch');
  });
  document.getElementById('lv-tab-transcript')?.addEventListener('click', () => {
    state.liveTab = 'transcript';
    document.getElementById('lv-tab-transcript')?.classList.add('lv-tab-active');
    document.getElementById('lv-tab-notes')?.classList.remove('lv-tab-active');
    document.getElementById('lv-tab-pitch')?.classList.remove('lv-tab-active');
    _renderLiveMid('transcript');
  });

  // Brief tick 2+3 click
  document.getElementById('brief-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-tick-id]');
    if (!item) return;
    const id = item.dataset.tickId;
    const current = state.manualTicks[id];
    state.manualTicks[id] = (current === 'done') ? 'yet' : 'done';
    if (id === '2' && state.manualTicks[id] === 'done') state.nutanixIntroSuggested = true;
    renderBriefTicks();
  });

  // Buttons
  document.getElementById('btn-replay-start').addEventListener('click', startReplay);
  document.getElementById('btn-replay-pause').addEventListener('click', toggleReplayPause);
  document.getElementById('btn-pitch-hold').addEventListener('click', () => {
    state.pitchHeld = !state.pitchHeld;
    const panel = document.getElementById('pitch-panel');
    if (panel) panel.classList.toggle('held', state.pitchHeld);
    document.getElementById('btn-pitch-hold').textContent = state.pitchHeld ? 'Unhold' : 'Hold';
    if (!state.pitchHeld) renderPitch();
  });

  document.getElementById('btn-end').addEventListener('click', () => {
    if (state.replayInterval) clearTimeout(state.replayInterval);
    state.replayInterval = null;
    stopTimer();
    setStatus('stopped', 'CALL ENDED');
    // Final extract with everything remaining
    state.forceFlush = !state.liveMode;
    state.lastExtractTime = 0; // also triggers live-mode flush via 8s check
    maybeExtract().then(() => { state.forceFlush = false; renderAll(); });
  });

  document.getElementById('btn-edit-save').addEventListener('click', saveEdit);
  document.getElementById('btn-edit-cancel').addEventListener('click', cancelEdit);
  document.getElementById('edit-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') cancelEdit();
  });

  // Field click: open edit overlay
  document.getElementById('call-sheet').addEventListener('click', (e) => {
    const row = e.target.closest('[data-field]');
    if (row && !row.classList.contains('derived')) {
      const path = row.dataset.field;
      if (path) openEditOverlay(path);
    }
    // Need click (tap to confirm / reorder top)
    const needItem = e.target.closest('.need-item');
    if (needItem) {
      const idx = parseInt(needItem.dataset.needIdx);
      if (!isNaN(idx)) {
        // Tap a need to set it as top need
        const current = state.notes.topNeed.value;
        const newTop = (current === idx + 1) ? null : idx + 1;
        state.notes.topNeed.value = newTop;
        state.notes.topNeed.evidence = ['manual-tap'];
        state.notes.topNeed.confidence = 1;
        renderAll();
      }
    }
  });

  // Evidence tooltip on field hover
  document.getElementById('call-sheet').addEventListener('mouseover', (e) => {
    const el = e.target.closest('.field-value');
    if (el && el.dataset.field) showEvidence(el, el.dataset.field);
  });
  document.getElementById('call-sheet').addEventListener('mouseout', (e) => {
    if (!e.target.closest('.field-value')) hideEvidence();
  });

  // Settings panel
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-overlay')) closeSettings();
  });
  loadSettings();

  // Initial render
  renderAll();
});

// ── Settings panel ───────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-overlay').classList.remove('hidden');
  loadSettings();
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

async function loadSettings() {
  try {
    const resp = await fetch('/api/settings/status');
    if (resp.ok) renderSettingsStatus(await resp.json());
  } catch {}
  const engineSel = document.getElementById('settings-engine');
  if (engineSel) engineSel.value = localStorage.getItem('liveEngine') || 'auto';
}

function renderSettingsStatus(data) {
  const anHint = document.getElementById('settings-an-hint');
  const dgHint = document.getElementById('settings-dg-hint');
  if (anHint) anHint.textContent = data.anthropic.set ? `currently set  (••••${data.anthropic.last4})` : 'not set';
  if (dgHint) dgHint.textContent = data.deepgram.set  ? `currently set  (••••${data.deepgram.last4})`  : 'not set';
  renderStatusRow('sstat-anthropic', 'Anthropic', data.anthropic);
  renderStatusRow('sstat-deepgram',  'Deepgram',  data.deepgram);
}

function renderStatusRow(id, label, info) {
  const row = document.getElementById(id);
  if (!row) return;
  let dotClass, valueText;
  if (!info.set)                 { dotClass = 'not-set';   valueText = 'not set'; }
  else if (info.connected === true)  { dotClass = 'connected'; valueText = 'connected'; }
  else if (info.connected === false) { dotClass = 'error';     valueText = 'key error — check value'; }
  else                           { dotClass = 'not-set';   valueText = 'set, not tested'; }
  row.innerHTML = `<span class="sstat-dot ${dotClass}"></span>
    <span class="sstat-label">${label}:</span>
    <span class="sstat-value ${dotClass}">${valueText}</span>`;
}

async function saveSettings() {
  const anInput  = document.getElementById('settings-an-input');
  const dgInput  = document.getElementById('settings-dg-input');
  const saveBtn  = document.getElementById('settings-save-btn');
  const saveMsg  = document.getElementById('settings-save-status');
  const anVal    = anInput.value.trim();
  const dgVal    = dgInput.value.trim();

  // Save engine choice to localStorage regardless of keys entered
  const engineSel = document.getElementById('settings-engine');
  if (engineSel) localStorage.setItem('liveEngine', engineSel.value);

  if (!anVal && !dgVal) { saveMsg.textContent = 'Engine preference saved.'; return; }

  saveBtn.disabled = true;
  saveMsg.textContent = 'Saving and testing…';

  // Show testing state immediately
  ['sstat-anthropic', 'sstat-deepgram'].forEach(rowId => {
    const row = document.getElementById(rowId);
    if (!row) return;
    const dot = row.querySelector('.sstat-dot');
    const val = row.querySelector('.sstat-value');
    if (dot) dot.className = 'sstat-dot testing';
    if (val) { val.className = 'sstat-value'; val.textContent = 'testing…'; }
  });

  try {
    const body = {};
    if (anVal) body.anthropicKey = anVal;
    if (dgVal) body.deepgramKey  = dgVal;
    const resp = await fetch('/api/settings/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error) {
      saveMsg.textContent = 'Error: ' + data.error;
    } else {
      renderSettingsStatus(data);
      anInput.value = '';
      dgInput.value = '';
      saveMsg.textContent = 'Saved.';
      setTimeout(() => { saveMsg.textContent = ''; }, 3000);
    }
  } catch {
    saveMsg.textContent = 'Network error.';
  } finally {
    saveBtn.disabled = false;
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
