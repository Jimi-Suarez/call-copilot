require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const WebSocket = require('ws');
const { buildCard, buildPrompt, buildExpected, parseFirstLine } = require('./lib/gen-card');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.use('/test', express.static(path.join(__dirname, 'test')));

let client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
const DEBRIEF_MODEL = process.env.DEBRIEF_MODEL || 'claude-sonnet-4-6';

const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/knowledge.json'), 'utf8'));
const PAIN_TYPES = knowledge.lookup.map(l => l.painType);

const USAGE_LOG     = path.join(__dirname, 'sessions/usage.log');
const GENERATED_DIR = path.join(__dirname, 'test/generated');
function logUsage(model, usage) {
  const input  = usage.input_tokens  || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead  = usage.cache_read_input_tokens     || 0;
  // haiku-4-5 pricing per million tokens: input $0.80, output $4.00, cache_write $1.00, cache_read $0.08
  const costUsd = (input * 0.0000008) + (output * 0.000004) + (cacheWrite * 0.000001) + (cacheRead * 0.00000008);
  const line = JSON.stringify({ ts: new Date().toISOString(), model, input, output, cacheWrite, cacheRead, costUsd: +costUsd.toFixed(6) }) + '\n';
  try { fs.appendFileSync(USAGE_LOG, line); } catch {}
}

const EXTRACTION_SYSTEM = `You are extracting discovery information from a Nutanix sales call transcript.
The AE is labelled "Me". The prospect (hospital IT lead) is labelled "Her".

## Core rules

1. HER WORDS ONLY. Only extract values from lines labelled "Her". "Me" lines are context; never a value source.

2. SHORT EXACT WORDS — 2–8 words from her actual speech, never a lookup label:
   • pain          → how she described the problem. E.g. "renewal quote more than double"
   • cause         → external event outside their control that created the pain. E.g. "Broadcom changed the licensing". NOT an internal consequence or constraint — leave null if no clear external trigger.
   • otherDrivers  → what else is driving it. E.g. "board wants less single-vendor risk"
   • whatItAffects → what the pain affects. E.g. "clinical systems refresh"
   • whyProblem    → why it's a problem. E.g. "CFO can't go in with no alternatives"
   • doingNothing  → what happens if they sign as-is. E.g. "sign at 850, refresh pushed, storage unsolved"
   • impactOnOthers→ ripple effect. E.g. "compliance lead needs to see the plan"
   • personalStake → her personal risk/consequences for HER career or role. Answer to "how does this land
                     on you personally?" in the discovery section. E.g. "bonus tied to staying inside budget",
                     "stand up to CEO, defend recommendation". NEVER overwrite with needReason.
   • signOff       → who must approve. E.g. "Sarah compliance, the CFO"
   • budget        → budget type/limit — her exact words, full narrative. E.g. "capital, I can sign up to 250, above to CFO"
   • needReason    → why the top need matters — typically answer to "why does that matter (personally)?". E.g. "CFO won't approve without numbers"
   • needs (each)  → 4–10 words of what she explicitly stated she needs.

   Pain = her direct description of the problem — typically in answer to "what made you take this meeting?"
   or "what's the issue?". NEVER extract pain from a question SHE asks ("what does this cost?" is her
   question, not her pain). The pain is her ANSWER, not her question.
   If she says "honestly, X isn't the real issue" or "the real issue is Y", update pain to Y (isCorrection: true).

3. PAIN TYPE IS SEPARATE. 'painType' (and 'painType' on needs items) is the ONLY place for lookup-key labels.
   Valid keys: ${PAIN_TYPES.map(p => `"${p}"`).join(', ')}.
   The 'pain' field and 'painType' field will always contain DIFFERENT values.
   When you extract a pain value, also extract the best-matching painType key in the same patch.
   notes.painType is matched from the pain field description ONLY — pick the closest valid key based on how she described the problem. NEVER derive notes.painType from needs content. Each need has its own separate painType field (needs.N.painType).

4. NUMBERS — parse to plain integers, no currency symbols:
   "six hundred grand" → 600000 | "600k" → 600000 | "point six of a million" → 600000
   "400 thousand" → 400000 | "280k" → 280000 | "850" in thousands context → 850000
   RANGES: "twenty or thirty thousand" → 25000 (midpoint). "around fifty or sixty" → 55000.
   CONTEXT: extract only the amount being described, ignore reference amounts after "of the extra":
     "twenty or thirty thousand of the extra hundred and seventy" → 25000 (canAbsorb);
     "of the extra hundred and seventy" is context (the increase she can absorb FROM), NOT the value.
   If ambiguous (annual vs monthly?), leave null and add a scratch note.
   QUOTE TYPE: after extracting numbers, also detect:
   - quoteType: "recurring" if she says "a year"/"annual"/"renewal"/"subscription"; "oneoff" if "one-off"/"capital"/"refresh"/"purchase"/"replace"; "unknown" if no context clue.
   - available: what she has set aside or can absorb for a one-off purchase (e.g. "we have £150k set aside" → available = 150000). Distinct from canAbsorb which is for recurring overspend.

5. DATES — extract minimal phrase: month or period only, no prefixes.
   "Board meeting in February" → "February"  (not "Board meeting in February")
   "mid-July" → "mid-July"   |   "end of next year" → "end of next year"
   For renewalDate and deadline ONLY: spoken ordinals → digits. "thirtieth of June" → "30 June".
   For nextStep.dateTime: keep her exact words. "the ninth of February" → "the ninth of February".
   NEVER add a year she did not say.
   deadline = the date she must present to or get approval from a decision-maker (board meeting, CFO sign-off, budget deadline).
   renewalDate = specifically when her current SOFTWARE CONTRACT (VMware/licence) must be renewed.
   "The renewal on the thirtieth of June" → renewalDate = "30 June". "Contract renews end of February" → "February".
   Hardware end-of-support dates ("arrays going out of support end of next year") are NOT renewalDate.
   If the same sentence contains both a board/decision date AND a renewal date, set deadline to the board/decision date and renewalDate to the contract renewal date.
   If she never states when the software contract renews, leave renewalDate null.

6. NEEDS — only add a need when she explicitly uses "I need X" / "we need X" DURING DISCOVERY
   (before the pitch opener — i.e. before Me says "Can I try a few ideas on you?" or similar):
   ✓ "we need X" / "I need X" (discovery phase only)
   ✓ "I won't go ahead without X" (discovery phase only)
   ✗ Do NOT create needs from: expressions of worry, pain descriptions, budget mentions, sign-off mentions,
     next-step discussions, or statements about what she wants to see.
   ✗ After the pitch opener, "we need X" / "I need X" / "before I can approve" statements are NOT needs —
     they are post-pitch concerns or next-step language; ignore them for the needs array.
   ✗ Next-step agreements at the close ("we need a comparison and a migration plan") are NEXT-STEP content —
     capture in nextStep fields, not the needs array.
   Zero needs is correct for calls where all "need" language comes after the pitch opener.

   COMPOUND NEEDS: "We need X and Y" in a SINGLE utterance = ONE need item with the full phrase. Only
   create separate needs when they come from DISTINCT utterances.

   Zero needs is correct when she has not used an explicit "I need" / "we need" statement during discovery.
   Do NOT infer a need from her pain, from what you think she would need, or from what the AE implies.
   Each need value must contain the literal words she used in her "need" statement.

7. TOP NEED — when she directly answers a "which matters most?" / "which would you do first?" question,
   set topNeed (1-based integer) AND if she gives a reason in the same answer OR in the very next answer
   to "why does that matter?" / "why does that matter to you personally?", set needReason to her exact
   words (2–10 words).
   E.g. "The migration. If the migration isn't safe, the numbers don't matter." → topNeed = 2,
   needReason = "If the migration isn't safe, the numbers don't matter."
   E.g. "Compliance. Without Priya's sign-off nothing moves." then [13:10] "Because I'd be the one
   explaining it to the regulator." → needReason = "explaining it to the regulator"
   When her topNeed answer contains a short phrase that IS or REPHRASES one of the existing needs,
   update that need's value (using field "needs.0" / "needs.1" etc, 0-based) to combine BOTH the original
   phrase AND her shorter rephrasing, separated by " — ".
   E.g. existing need "Somebody to work alongside my team during any move", topNeed answer "The support
   during the move" → patch needs.0 value = "support during the move — work alongside my team",
   isCorrection: true, topNeed = 1. This preserves both phrasings for traceability.
   Leave needReason null if she does not explain why. Set isCorrection: true if overriding a prior topNeed.

8. NEXT STEP — when she agrees to a working session, follow-up or demo, fill:
   • nextStep.who      → translate to AE perspective: 'me'/'I' (her) → 'her'; 'you' (the AE) stays 'you'.
     E.g. "You, me, Sarah from compliance, the reseller" → "you, her, Sarah (compliance), reseller"
     E.g. "Me, Priya, and your engineer. The reseller too." → "you, her, Priya (compliance), engineer, reseller"
     NEVER drop named attendees. Include ALL people she names including "your engineer", "your reseller", etc.
     If she says "I'll check with X" or "I need to confirm with X" when agreeing to the session, X
     is intended as an attendee — include them. E.g. "I'll check with Mo" → include Mo in nextStep.who.
   • nextStep.purpose  → 2–4 words for meeting type. E.g. "working session"
   • nextStep.dateTime → her exact timing. E.g. "week of December 15th, or after January 10th"

9. CORRECTIONS — set isCorrection: true only when she explicitly corrects a prior statement.

10. LOCKED FIELDS — never patch a field listed as LOCKED in the current notes below.

11. SCRATCH — off-topic items (holidays, personal schedules, tangents unrelated to the IT procurement):
    value = a direct quote from her speech, one line, no commentary, no brackets, no extra labels, no utterance IDs in the value.
    Always include the utterance ID(s) in the evidence array so the timestamp can be recovered.
    Do NOT create scratch items for information already captured in a structured field — her availability
    goes in nextStep.dateTime, numbers go in numbers.*, named attendees go in nextStep.who, etc.
    ALWAYS park a non-IT tangent even if brief. E.g. "the canteen contract is up for renewal too" → scratch (it's not IT infrastructure).

12. OBJECTIONS — only flag AFTER Me has said the pitch opener (usually "Can I try a few ideas on you?"
    or similar). A concern stated ONLY during DISCOVERY (before the pitch opener) belongs in impactOnOthers
    or personalStake — it is NOT an objection. However, if she RAISES A DIRECT CHALLENGE OR QUESTION
    after the pitch opener (e.g. "Can you guarantee there'll be no downtime?" at [27:55] after the pitch
    at [27:00]), it IS a post-pitch objection and MUST be flagged — even if the same worry appeared
    during discovery. The test is: did Me say "Can I try a few ideas on you?" (or similar pitch opener)
    before her statement? If yes, her direct challenge is an objection.
    An objection is specifically her pushback or challenge to a claim just made in the pitch (after the opener).
    IMPORTANT: If "Can I try a few ideas on you?" appears in the RECENT transcript, flag any subsequent
    Her challenges as objections.
    Each objection item needs:
    • quote      → her exact words (verbatim)
    • matchedKey → one of:
        "downtime"   — guarantee / zero downtime / patient systems going down
        "retraining" — team retraining / only knows VMware / needs training
        "cost"       — is it cheaper / will it save money / will it cost less (price challenge)
        "compliance" — patient data / compliance / GDPR / regulatory. E.g. "what about compliance? this is patient data."
        "proof"      — prove it / no evidence / can you prove it works
        "other"      — anything else, including contract lock-in challenges
      IMPORTANT: "is it cheaper?" = "cost", NOT "proof". Proof = "can you prove it works for us?"
      Return ALL objections from the recent transcript, not just the first one. Multiple Her lines can each be a separate objection.
    • utteranceId, timestamp → from her utterance
    If no new post-pitch objections, omit the field or return [].

13. DON'T-PROMISE SLIPS — when "Me" uses any of these exact phrases: "zero downtime", "guarantee",
    "cheaper", "faster", "safer" — add a scratch item with field "scratch", value = the exact Me line,
    parkNote = "dont-promise". The evidence array should include the Me utterance ID.
    (The client will render these differently from parked items.)

14. EMPTY PATCH — if nothing in the recent transcript is new, return patch: [].`;

// Tool schema for structured extraction output
const EXTRACT_TOOL = {
  name: 'update_notes',
  cache_control: { type: 'ephemeral' },
  description: 'Update the call notes with newly discovered information. Only include fields that should change based on the recent transcript.',
  input_schema: {
    type: 'object',
    required: ['patch'],
    properties: {
      patch: {
        type: 'array',
        description: 'Array of field updates derived from the recent transcript.',
        items: {
          type: 'object',
          required: ['field', 'value', 'evidence', 'confidence'],
          properties: {
            field: {
              type: 'string',
              description: [
                'Dot-notation path to the field to update. Valid paths:',
                '  Simple fields: pain, painType, whatItAffects, whyProblem, deadline, renewalDate,',
                '    doingNothing, cause, otherDrivers, impactOnOthers, personalStake, signOff, budget,',
                '    topNeed, needReason',
                '  Nested: situation.hosts, situation.vms, situation.storageTB, situation.teamSize, situation.workloads',
                '  Nested: numbers.paysNow, numbers.quote, numbers.canAbsorb',
                '  Nested: nextStep.who, nextStep.purpose, nextStep.dateTime',
                '  Dynamic: "needs" (append a new need), "needs.0" / "needs.1" etc (update that need)',
                '  Dynamic: "needs.0.painType" (set pain type on an existing need)',
                '  Parked: "scratch" (append off-topic or parked item)'
              ].join('\n')
            },
            value: {
              description: 'The extracted value. String for text fields, integer for numbers, 1-based integer for topNeed, null to explicitly clear.'
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'Utterance IDs this value came from (e.g. ["u003", "u004"])'
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Confidence 0-1. Use < 0.7 if uncertain.'
            },
            isCorrection: {
              type: 'boolean',
              description: 'True if this explicitly corrects a value she previously stated (e.g. "sorry, it\'s 850 not 900")'
            },
            painType: {
              type: 'string',
              description: 'For needs field only: the pain type key that best fits this need'
            },
            parkNote: {
              type: 'string',
              description: 'For scratch field only: brief note on why this was parked (e.g. "holiday dates", "tangent")'
            }
          }
        }
      },
      objections: {
        type: 'array',
        description: 'Objections raised by Her in the recent transcript. Only include new objections not already in current notes.',
        items: {
          type: 'object',
          required: ['quote', 'utteranceId', 'timestamp'],
          properties: {
            quote: { type: 'string', description: 'Her exact words, verbatim, that constitute the objection' },
            matchedKey: { type: 'string', description: 'One of: "downtime", "retraining", "cost", "compliance", "proof", "other"' },
            utteranceId: { type: 'string', description: 'The utterance ID (e.g. "u015")' },
            timestamp: { type: 'string', description: 'The timestamp from the transcript (e.g. "12:34")' }
          }
        }
      }
    }
  }
};

app.post('/extract', async (req, res) => {
  const { notes, recentTranscript, fullSummary } = req.body;

  if (!recentTranscript || !recentTranscript.trim()) {
    return res.json({ patch: [], tokenUsage: null });
  }

  // Summarise current notes for the model (show only what's filled)
  const filledNotes = summariseNotes(notes);

  const userPrompt = [
    'Current notes (already extracted):',
    filledNotes || '(nothing extracted yet)',
    '',
    fullSummary ? `Full call summary so far:\n${fullSummary}\n` : '',
    'Recent transcript to extract from:',
    recentTranscript
  ].filter(Boolean).join('\n');

  try {
    debugLog({
      event: 'extract-request',
      model: EXTRACT_MODEL,
      recentLen: recentTranscript.length,
      notesKeys: Object.keys(notes || {}).length
    });

    let response, attempts = 0;
    while (attempts < 2) {
      response = await client.messages.create({
        model: EXTRACT_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: [{ type: 'text', text: EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'update_notes' },
        messages: [{ role: 'user', content: userPrompt }]
      });
      const toolUse = response.content.find(b => b.type === 'tool_use');
      const candidate = toolUse ? (toolUse.input.patch || []) : [];
      if (Array.isArray(candidate)) break;
      debugLog({ event: 'bad-patch-retry', attempt: attempts, type: typeof candidate });
      attempts++;
    }
    logUsage(EXTRACT_MODEL, response.usage);

    const toolUse = response.content.find(b => b.type === 'tool_use');
    const rawPatch = Array.isArray(toolUse?.input?.patch) ? toolUse.input.patch : [];
    const rawObjRaw = toolUse?.input?.objections;
    const rawObj = Array.isArray(rawObjRaw) ? rawObjRaw : [];

    // Server-side lock enforcement
    const lockedPaths = findLockedFields(notes);
    const patch = rawPatch.filter(item => {
      if (!item || !item.field) return false;
      if (item.field === 'needs' || item.field === 'scratch') return true;
      const isLocked = lockedPaths.some(lp => lp === item.field || item.field.startsWith(lp + '.'));
      if (isLocked) console.log(`[extract] blocked locked field: ${item.field}`);
      return !isLocked;
    });

    debugLog({
      event: 'extract-response',
      patchCount: patch.length,
      fields: patch.map(p => p.field),
      objCount: rawObj.length,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWrite: response.usage.cache_creation_input_tokens || 0,
      cacheRead:  response.usage.cache_read_input_tokens     || 0
    });

    res.json({
      patch,
      objections: rawObj,
      tokenUsage: {
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWrite:   response.usage.cache_creation_input_tokens || 0,
        cacheRead:    response.usage.cache_read_input_tokens     || 0
      }
    });
  } catch (err) {
    debugLog({ event: 'extract-error', message: err.message });
    console.error('[extract]', err.message);
    res.status(500).json({ error: err.message, patch: [] });
  }
});

// Session cost summary from usage log
app.get('/api/usage', (req, res) => {
  try {
    if (!fs.existsSync(USAGE_LOG)) return res.json({ calls: 0, costUsd: 0 });
    const lines = fs.readFileSync(USAGE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    let calls = 0, costUsd = 0;
    for (const line of lines) {
      try { const r = JSON.parse(line); calls++; costUsd += r.costUsd || 0; } catch {}
    }
    res.json({ calls, costUsd: +costUsd.toFixed(4) });
  } catch {
    res.json({ calls: 0, costUsd: 0 });
  }
});

// List available sample calls
app.get('/api/samples', (req, res) => {
  const testDir = path.join(__dirname, 'test');
  try {
    const top = fs.readdirSync(testDir)
      .filter(f => f.endsWith('.txt') && !f.startsWith('.'));
    const holdoutDir = path.join(testDir, 'holdout');
    const holdout = fs.existsSync(holdoutDir)
      ? fs.readdirSync(holdoutDir)
          .filter(f => f.endsWith('.txt') && !f.startsWith('.'))
          .map(f => `holdout/${f}`)
      : [];
    res.json([...top, ...holdout]);
  } catch {
    res.json([]);
  }
});

// List generated calls with metadata parsed from their first line
app.get('/api/generated', (req, res) => {
  try {
    if (!fs.existsSync(GENERATED_DIR)) return res.json([]);
    const files = fs.readdirSync(GENERATED_DIR).filter(f => /^\d+\.txt$/.test(f));
    const calls = [];
    for (const f of files) {
      const seed = parseInt(f);
      try {
        const txt = fs.readFileSync(path.join(GENERATED_DIR, f), 'utf8');
        const firstLine = txt.split('\n').find(l => l.startsWith('# Generated:')) || '';
        const meta = parseFirstLine(firstLine);
        calls.push({ seed, filename: `generated/${f}`, ...meta });
      } catch {}
    }
    calls.sort((a, b) => a.seed - b.seed);
    res.json(calls);
  } catch {
    res.json([]);
  }
});

// Generate N more calls via SSE (client reads progress events)
app.post('/api/generate', async (req, res) => {
  const n = Math.min(parseInt(req.body?.n) || 5, 20);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  try {
    if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

    const existing = fs.readdirSync(GENERATED_DIR)
      .filter(f => /^\d+\.txt$/.test(f))
      .map(f => parseInt(f));
    const startSeed = existing.length > 0 ? Math.max(...existing) + 1 : 100;

    const toGen = [];
    for (let i = 0; i < n; i++) toGen.push(startSeed + i);

    send({ type: 'start', count: toGen.length, startSeed });

    const INPUT_PRICE  = 0.000015;
    const OUTPUT_PRICE = 0.000075;

    for (let i = 0; i < toGen.length; i++) {
      const seed      = toGen[i];
      const card      = buildCard(seed);
      const prompt    = buildPrompt(card);
      const painLabel = card.pains.map(p => p.label).join(' + ') || 'none';
      const objLabel  = card.objections.map(o => `${o.key}@${o.timing}`).join(', ') || 'none';

      send({ type: 'progress', seed, pain: painLabel, persona: card.persona, i: i + 1, total: toGen.length });

      let resp;
      try {
        resp = await client.messages.create({
          model: 'claude-opus-4-7',
          max_tokens: 5000,
          messages: [{ role: 'user', content: prompt }],
        });
      } catch (e) {
        send({ type: 'error', seed, message: e.message });
        continue;
      }

      const text    = resp.content.find(b => b.type === 'text')?.text || '';
      const txMatch = text.match(/===TRANSCRIPT===([\s\S]*?)===END===/);
      if (!txMatch) {
        send({ type: 'error', seed, message: 'could not parse transcript markers' });
        continue;
      }
      const transcript = txMatch[1].trim();
      const expected   = buildExpected(card);

      fs.writeFileSync(path.join(GENERATED_DIR, `${seed}.txt`),           transcript + '\n');
      fs.writeFileSync(path.join(GENERATED_DIR, `${seed}.expected.json`), JSON.stringify(expected, null, 2) + '\n');

      const cost = ((resp.usage.input_tokens * INPUT_PRICE) + (resp.usage.output_tokens * OUTPUT_PRICE)).toFixed(4);
      send({ type: 'done', seed, pain: painLabel, persona: card.persona, objLabel, cost });
    }

    send({ type: 'complete', count: toGen.length });
  } catch (e) {
    send({ type: 'fatal', message: e.message });
  }
  res.end();
});

// Produce a compact summary of filled notes for the extraction prompt
function summariseNotes(notes) {
  if (!notes) return '';
  const lines = [];

  const fv = (f) => (f && f.value !== null && f.value !== undefined) ? f.value : null;
  const add = (label, val) => { if (val !== null && val !== undefined) lines.push(`${label}: ${val}`); };

  const s = notes.situation || {};
  const sit = [fv(s.hosts), fv(s.vms), fv(s.storageTB), fv(s.teamSize), fv(s.workloads)].filter(Boolean);
  if (sit.length) add('Situation', sit.join(', '));

  add('Pain', fv(notes.pain));
  add('Pain type', fv(notes.painType));
  add('What it affects', fv(notes.whatItAffects));
  add('Why problem', fv(notes.whyProblem));

  const n = notes.numbers || {};
  add('Pays now', fv(n.paysNow));
  add('Quote', fv(n.quote));
  add('Can absorb', fv(n.canAbsorb));

  add('Deadline', fv(notes.deadline));
  add('Renewal date', fv(notes.renewalDate));
  add('Doing nothing', fv(notes.doingNothing));
  add('Cause', fv(notes.cause));
  add('Other drivers', fv(notes.otherDrivers));
  add('Impact on others', fv(notes.impactOnOthers));
  add('Personal stake', fv(notes.personalStake));
  add('Sign-off', fv(notes.signOff));
  add('Budget', fv(notes.budget));

  if (notes.needs && notes.needs.length > 0) {
    notes.needs.forEach((nd, i) => {
      if (nd && nd.value) add(`Need ${i + 1}`, nd.value + (nd.painType ? ` [${nd.painType}]` : ''));
    });
  }
  add('Top need', fv(notes.topNeed));
  add('Need reason', fv(notes.needReason));

  const ns = notes.nextStep || {};
  add('Next step who', fv(ns.who));
  add('Next step purpose', fv(ns.purpose));
  add('Next step date', fv(ns.dateTime));

  // Mark locked fields
  const lockedFields = findLockedFields(notes);
  if (lockedFields.length) lines.push(`LOCKED (do not overwrite): ${lockedFields.join(', ')}`);

  return lines.join('\n');
}

function findLockedFields(notes, prefix = '', result = []) {
  if (!notes || typeof notes !== 'object') return result;
  if ('locked' in notes && 'value' in notes) {
    if (notes.locked) result.push(prefix);
    return result;
  }
  for (const [key, val] of Object.entries(notes)) {
    if (key === 'scratch' || key === 'history') continue;
    if (Array.isArray(val)) {
      val.forEach((item, i) => findLockedFields(item, `${prefix}${prefix ? '.' : ''}${key}.${i}`, result));
    } else if (val && typeof val === 'object') {
      findLockedFields(val, `${prefix}${prefix ? '.' : ''}${key}`, result);
    }
  }
  return result;
}

const PORT = process.env.PORT || 3000;

// Create HTTP server and attach WebSocket
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// WebSocket proxy for Deepgram live transcription
wss.on('connection', (clientWs, req) => {
  if (!req.url.startsWith('/mic')) { clientWs.close(); return; }

  const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DEEPGRAM_KEY) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'DEEPGRAM_API_KEY not set' }));
    clientWs.close();
    return;
  }

  const dgUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en-GB&diarize=true&punctuate=true&interim_results=true&encoding=linear16&sample_rate=16000';
  const dgWs = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } });

  dgWs.on('open', () => {
    console.log('[deepgram] upstream connected (nova-2, linear16, 16kHz)');
    clientWs.send(JSON.stringify({ type: 'ready' }));
  });
  dgWs.on('message', (data) => {
    try {
      const str = data.toString();
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'Results' && msg.is_final) {
          const text = msg.channel?.alternatives?.[0]?.transcript || '';
          console.log(text.trim() ? `[deepgram] transcript: ${text.substring(0, 120)}` : '[deepgram] final (empty)');
        }
      } catch {}
      clientWs.send(str);
    } catch {}
  });
  dgWs.on('close', (code, reason) => {
    console.log('[deepgram] closed:', code, reason?.toString() || '');
    try { clientWs.close(); } catch {}
  });
  dgWs.on('error', (e) => {
    console.error('[deepgram] error:', e.message);
    try { clientWs.send(JSON.stringify({ type: 'error', message: e.message })); clientWs.close(); } catch {}
  });

  clientWs.on('message', (data) => { if (dgWs.readyState === WebSocket.OPEN) dgWs.send(data); });
  clientWs.on('close', () => { if (dgWs.readyState !== WebSocket.CLOSED) dgWs.close(); });
});

// Config endpoint for front-end feature detection
app.get('/api/config', (req, res) => {
  res.json({
    deepgramAvailable: !!process.env.DEEPGRAM_API_KEY,
    models: { extract: EXTRACT_MODEL, debrief: DEBRIEF_MODEL }
  });
});

// Save live session transcript
const SESSION_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

function debugLog(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(SESSION_DIR, 'debug.log'), line);
  } catch {}
}

app.post('/api/session/save', (req, res) => {
  const { transcript, startedAt } = req.body || {};
  if (!transcript || !Array.isArray(transcript)) return res.status(400).json({ error: 'transcript required' });
  const ts = new Date(startedAt || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `session-${ts}.txt`;
  const lines = transcript.map(u => `[${u.ts}] ${u.speaker}: ${u.text}`).join('\n');
  fs.writeFileSync(path.join(SESSION_DIR, filename), lines, 'utf8');
  res.json({ saved: filename });
});

// ── Settings ─────────────────────────────────────────────────────────────────
// In-memory test status — resets on restart (never persists keys in memory)
const settingsStatus = {
  deepgram:  { connected: null },
  anthropic: { connected: null },
};

function setEnvVar(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) return content.replace(re, line);
  return (content && !content.endsWith('\n') ? content + '\n' : content) + line + '\n';
}

app.get('/api/settings/status', (req, res) => {
  const dgKey = process.env.DEEPGRAM_API_KEY  || '';
  const anKey = process.env.ANTHROPIC_API_KEY || '';
  res.json({
    deepgram:  { set: !!dgKey, last4: dgKey ? dgKey.slice(-4) : null, connected: settingsStatus.deepgram.connected },
    anthropic: { set: !!anKey, last4: anKey ? anKey.slice(-4) : null, connected: settingsStatus.anthropic.connected },
  });
});

app.post('/api/settings/save', async (req, res) => {
  const { deepgramKey, anthropicKey } = req.body || {};
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  try { envContent = fs.readFileSync(envPath, 'utf8'); } catch {}

  // Write keys — values are never logged
  if (typeof deepgramKey === 'string' && deepgramKey.trim()) {
    const v = deepgramKey.trim();
    envContent = setEnvVar(envContent, 'DEEPGRAM_API_KEY', v);
    process.env.DEEPGRAM_API_KEY = v;
  }
  if (typeof anthropicKey === 'string' && anthropicKey.trim()) {
    const v = anthropicKey.trim();
    envContent = setEnvVar(envContent, 'ANTHROPIC_API_KEY', v);
    process.env.ANTHROPIC_API_KEY = v;
    client = new Anthropic({ apiKey: v }); // reinitialise without restart
  }

  try {
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Could not write .env: ' + e.message });
  }

  // Quick connection test — Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      await client.messages.create({
        model: EXTRACT_MODEL, max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      settingsStatus.anthropic.connected = true;
    } catch {
      settingsStatus.anthropic.connected = false;
    }
  }

  // Quick connection test — Deepgram (lightweight projects endpoint)
  if (process.env.DEEPGRAM_API_KEY) {
    try {
      const r = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
      });
      settingsStatus.deepgram.connected = r.ok;
    } catch {
      settingsStatus.deepgram.connected = false;
    }
  }

  const dgKey = process.env.DEEPGRAM_API_KEY  || '';
  const anKey = process.env.ANTHROPIC_API_KEY || '';
  res.json({
    deepgram:  { set: !!dgKey, last4: dgKey ? dgKey.slice(-4) : null, connected: settingsStatus.deepgram.connected },
    anthropic: { set: !!anKey, last4: anKey ? anKey.slice(-4) : null, connected: settingsStatus.anthropic.connected },
  });
});

httpServer.listen(PORT, () => {
  console.log(`Call Copilot → http://localhost:${PORT}`);
  console.log(`Extract model: ${EXTRACT_MODEL}`);
});
