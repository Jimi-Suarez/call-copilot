# Call Copilot — spec for Claude Code

A local web page that listens to a sales call through the Mac's microphone, transcribes it live, and fills in my discovery notes for me. It replaces the Excel call sheet, where I had to type keywords mid-call.

Build this in phases (section 11). Phase 1 is replay + fill with no audio. Get it working end to end before starting Phase 2.

---

## 1. Why this exists

I'm preparing for the Nutanix panel (Inside AE, UK&I). The assessment is a 30-minute role-play in which I run a discovery call with a hospital IT lead and am scored on 7 criteria (35 total). My Excel call sheet has the right structure, but I can't type keywords and talk at the same time. A real call moves faster than a spreadsheet.

The tool should do the typing. I keep my eyes on the conversation and glance at the screen.

**Primary use:** practice role-plays (me against Claude, a friend, or a recording) and real discovery calls. Debrief afterwards against the 7 criteria.
**Not a goal:** being a live crutch during the actual assessment. I'll check what Nutanix allows before using it there.

## 2. Principles

1. **Glanceable.** Everything I need mid-call is visible on one screen, with no scrolling and no tabs.
2. **Zero typing during the call.** Fields fill from speech. I can click a field to correct it, but never have to.
3. **Her words, not mine.** Fields hold short verbatim keywords or phrases from the prospect. Never paraphrase her into something she didn't say. This is scoring criterion 1.
4. **Nothing invented.** If it wasn't said, the field stays empty. Each filled field links to the transcript line it came from.
5. **Simple to run.** One command to start. Plain HTML/JS front end, one small Node server. No framework unless it clearly earns its place.
6. **Local-first.** Transcripts and notes are saved on my Mac only.

## 3. Architecture

```
Browser (Chrome on Mac)                 Local Node server (localhost:3000)
 ├─ getUserMedia (mic)                   ├─ serves the static page
 ├─ getDisplayMedia (tab audio, opt.)    ├─ holds API keys in .env (never in browser)
 ├─ AudioWorklet → 16kHz PCM chunks      ├─ WS /stt    → proxies to Deepgram streaming
 ├─ live transcript pane                 ├─ POST /extract → Claude (fast model), JSON out
 ├─ call-sheet fields (auto-filled)      ├─ POST /debrief → Claude (strong model), end of call
 ├─ prompt / guidance panel              └─ writes sessions/<timestamp>/{transcript,notes,debrief}.json
 └─ timer + step tracker
```

**Stack:** Node 20+, Express, `ws`, vanilla JS (or Preact if needed), `@anthropic-ai/sdk`, Deepgram streaming API.
**Config (.env):** `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `EXTRACT_MODEL=claude-haiku-5-5`, `DEBRIEF_MODEL=claude-sonnet-5-5`.
**Run:** `npm start`, then open `http://localhost:3000` in Chrome. `localhost` counts as a secure context, so mic access works.

## 4. Audio capture (the Mac-specific part)

Browsers on macOS can't capture system audio directly. Support three modes, selectable in a dropdown before the call:

| Mode | When | How |
|---|---|---|
| **A. Mic only** | In-person panel, or on speakers/laptop mic where both voices reach the mic | `getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}})`. One channel, so speaker labels come from Deepgram diarization (`diarize=true`). |
| **B. Mic + tab audio** | Zoom/Meet/Teams in the browser | Mic for me, plus `getDisplayMedia({audio:true, video:true})`. I tick "Share tab audio" for the call tab. Two separate channels (me / her), merged into a stereo stream, sent with `multichannel=true`. Channel 0 = Me, channel 1 = Her. This is the most accurate mode. |
| **C. Mic + BlackHole** | Zoom/Teams desktop app | I install BlackHole 2ch and make a Multi-Output Device. The app's output goes to BlackHole, and the browser reads it as a second input device. In the UI, a dropdown lists input devices (`enumerateDevices`) so I can pick "BlackHole 2ch" as "Her audio". Same stereo merge as B. |

Requirements:
- A live input level meter for each channel, so I can see before the call that audio is arriving.
- A **Test audio** button that records 5s and shows the transcript, to confirm setup.
- Show a clear red "NOT LISTENING" state if a stream drops. Auto-reconnect the STT websocket and buffer audio during the gap.
- A first-run screen that explains each mode in two lines and links to BlackHole setup steps.

## 5. Transcription

- **Primary:** Deepgram streaming (`nova-3`, `language=en-GB`, `interim_results=true`, `smart_format=true`, `endpointing=300`). Keyword boosting for: Nutanix, AHV, Prism, Broadcom, VMware, vSphere, hyperconverged, HCI, SAN, RPO, RTO, GDPR, ARR, Nutanix Move.
- **Fallback (Phase 1 for a quick test with no key):** browser `webkitSpeechRecognition` (mic only, no speaker labels, restarts every ~60s, so handle auto-restart).
- Transcript pane: speaker-labelled lines, "Me" and "Her", with interim text greyed until final. Auto-scrolls, with a "jump to live" button if I scroll up.
- Every final utterance gets an id, a timestamp (mm:ss from call start) and a speaker.

## 6. Extraction: the part that fills the sheet

### 6.1 Schema (mirrors the Call tab of my sheet)

```jsonc
{
  "situation":      { "hosts": null, "vms": null, "storageTB": null, "teamSize": null, "workloads": null },
  "painType":       null,            // one key from knowledge.json lookup[].painType, or null
  "pain":           null,            // her words
  "whatItAffects":  null,
  "whyProblem":     null,
  "numbers":        { "paysNow": null, "quote": null, "canAbsorb": null },   // per year, numeric
  "deadline":       null,            // board / decision date, her words
  "renewalDate":    null,
  "doingNothing":   null,
  "cause":          null,
  "otherDrivers":   null,            // the "Ys" for the pitch
  "impactOnOthers": null,            // who + why
  "personalStake":  null,
  "signOff":        null,            // names / roles
  "budget":         null,            // pot + owner
  "needs":          [null, null, null],
  "topNeed":        null,            // 1..3
  "needReason":     null,            // why it matters to her personally
  "nextStep":       { "who": null, "purpose": null, "dateTime": null },
  "scratch":        []               // anything else notable
}
```

Each field is stored as `{ value, evidence: [utteranceIds], confidence: 0-1, locked: bool }`. `locked` means I edited it by hand, so the model may never overwrite it.

### 6.2 How it runs

- Every ~6s of new final transcript (or on an utterance ending in a question mark from "Me"), POST to `/extract` with: the current notes object, the last ~90s of transcript, and the full transcript summary so far.
- Prompt the model to return a **JSON patch only** (fields to set or change), with evidence ids. Use tool-use/structured output so the response is always valid JSON.
- Extraction rules (put these in the system prompt verbatim):
  1. Only extract what **she** said. My lines give context but are never the source of a value.
  2. Use her exact words, trimmed to 2–6 words for text fields. No paraphrasing, no adding meaning.
  3. Numbers: parse "six hundred grand" to 600000. Keep currency out of the number. If ambiguous (annual or monthly), leave it null and add a flag.
  4. Don't fill a field from a guess. A null is always correct when unsure.
  5. Never overwrite a `locked` field. Overwrite an unlocked field only if the new evidence is clearly a correction.
  6. `painType` must be one of the keys in the lookup list, chosen from what she said, or null.
- Use the cheap, fast model for this. Target under 2s round trip. Debounce so calls never overlap. Skip a call if there's no new final transcript.
- Fields flash briefly when they fill, so I notice without staring.

### 6.3 Derived values (computed in the front end, no model)

Port these from the sheet:
- `increasePct = quote / paysNow − 1`
- `gapPerYear = quote − canAbsorb`
- **Read-back summaries** (the "Did I get that right?" lines), shown only once their inputs exist:
  - Numbers: "So the quote is {quote} against {paysNow} now. You can absorb {canAbsorb}. The board is {deadline}, the renewal is {renewalDate}. Did I get that right?"
  - Cause: "So it hits hard because {cause}, and right now it matters because {otherDrivers}. Did I get that right?"
  - Needs: "So you need: {n1}; {n2}; and {n3}. The most important is: {top}. Did I get that right?"
- **Targeted questions:** once `painType` is set, show the root-cause question (step 4) and impact question (step 5) from `knowledge.json`.
- **Pitch builder:** after step 6, show the pitch in the order: permission → opener → three lines in her order with her top need first → check-in → close. Format: "We {weDo}. You told me {need} matters most. So here's how that fits." Include the "if she asks how" fact and its source URL, behind a click.

### 6.4 Sheet parity and the pitch (hard requirement)

The app must behave exactly like `nutanix_call_builder_v3.xlsx`, with the mic doing the typing:
- Every formula on the Call, Pitch and Brief tabs has an equivalent in the app, with the same wording. Claude Code must read the xlsx formulas and port them, not rewrite them from this description. **Exception:** the sheet's fixed 3-need and top-need logic is replaced by 6.5. Keep the sentence wording, drop the all-or-nothing conditions.
- **The pitch builds itself while I listen, from whatever she has actually said.** It must work with 0, 1, 2, 3 or more needs. Real prospects rarely give exactly three. See 6.5 for the rules. I just read it out.
- If a need has no pain type yet, the model picks the closest one from the lookup and marks it "suggested". One tap confirms or changes it.
- The Brief tab auto-ticks (Done / Not yet) live as fields fill, so I can see what's still uncovered.
- I should never need to type during the call. If I do have to type, that's a bug.

### 6.5 Pitch with incomplete or messy input (hard requirement)

The sheet assumes exactly 3 needs and a chosen top need. Real calls don't work like that. The app must degrade gracefully:

- **Needs are a dynamic list (0 to 5), not 3 fixed slots.** The extractor adds a need whenever she states something she wants to happen, or a problem she wants gone. It merges duplicates.
- **Source ladder.** For each pitch line, use the best evidence available, in this order:
  1. An explicit need: "we need X before June".
  2. A stated pain or its consequence: "the renewal is double", "the team can't cope". The app rewords it only into the "You told me ___" slot, quoting her words as they were.
  3. A driver or personal stake she mentioned (the sheet's "Ys").
  Mark each line with its source tier: `need` / `pain` / `stake`. Lines from tier 2 or 3 show a small "from pain, not a stated need" tag, and the check-in line becomes "Is that the right priority?"
- **Pitch is available from 1 line.** With one usable item, build a one-line pitch plus the permission, opener and close. With two or three, build that many. Never show "(type all three needs)" or blank placeholders.
- **No top need chosen?** Pick it automatically, in this order: the one she said matters most; the one with a deadline attached; the one she repeated or stressed most; the most recent. Show a small "assumed top" tag, and one tap re-orders. If she later says what matters most, that wins.
- **Pain type is always suggested, never required.** If the extractor can't match a lookup key, the line uses a generic "We bring in the right people to work through this with you" and flags "no pain type". It never leaves a blank.
- **Pitch confidence indicator.** A small bar showing how well-grounded the pitch is: green (explicit needs and top need), amber (built from pains), red (too little heard, so keep asking). Red lists what's missing as suggested questions.
- **It updates as the call moves.** Lines re-order and rewrite as she says more, but stay frozen while I'm reading them (a "hold" state when I tap the pitch panel).
- **Hard pitch shortcut:** a key (`P`) that forces a best-effort pitch right now from everything heard, in case the call jumps to the pitch early.

The same principle applies to the read-back lines and the Brief ticks: they must work with partial data ("So far I've got: ...") and never wait for every field.

## 7. Guidance engine

A narrow strip at the top that always answers "what do I do next?"

- **Real calls are not linear.** She will jump from pain to budget to a competitor and back, answer three questions at once, or go off on a tangent. The app must never assume the order of the sheet. Fields fill in whatever order she says things, and nothing is blocked until an earlier step is "done".
- **Coverage board instead of a step tracker.** Show the discovery areas (Situation, Pain, Number, Timeframe, Cause, Impact, Buying box, Needs, Next step) as chips: grey = not heard, amber = partly heard, green = covered. The sheet's step order is only a suggested route, shown as a faint hint.
- **Next prompt = the most valuable gap, not the next row.** Rank unfilled areas by (a) what the rubric needs, (b) what the conversation just touched, (c) time left. Offer up to 2 suggested questions, using the sheet's wording with her words substituted. Example: if she just mentioned a board date, suggest "What happens if nothing changes by then?", even if Situation is incomplete.
- **Tangent handling:** when she goes somewhere new, store it in scratch with a timestamp and show a small "park / come back to" note, so I can return to the thread I left. Add a "Parked" list under the coverage board.
- **Pitch is progressive, not a threshold.** The Pitch panel is available from the first usable item and improves as more is heard (see 6.5). It never waits for three needs.
- **Timer:** big mm:ss clock with targets from the brief: agenda by 2:00, pitch started by 23:00, close started by 27:00, end by 30:00. The clock turns amber 1 minute before a target and red after it.
- **Live flags** (a small badge row, from simple rules plus a cheap model check where needed):
  - I said "zero downtime", "cheaper", "safer", "faster", "guarantee" → warn.
  - Filler "okay" at the start of a turn → count it.
  - I spoke for more than ~45s without a question → "Ask a question."
  - Talk ratio (my words / her words), target under 40% during discovery.
  - Objection detected in her speech → show the matching row from the Objections tab: what she's worried about and the "say this" line.
  - She asked a Nutanix basics question → show the matching plain answer and source.
- The flags must be unobtrusive. Small, no sound, no modal popups.

## 8. Screen layout (one screen, 1440×900 target)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ● LISTENING   [Me ▮▮▮▯] [Her ▮▮▯▯]   14:32 / 30:00   Step: 4 Cause   [End] │
├───────────────────────────────────────────────────────────────────────────┤
│ NEXT: "Why do you think this is going to hit you so hard?"                │
├───────────────────────────────┬───────────────────────────────────────────┤
│ CALL SHEET (auto-filled)      │ TRANSCRIPT (live)                         │
│  Situation  hosts/VMs/TB/team │  Her:  …                                  │
│  Pain / affects / why         │  Me:   …                                  │
│  Numbers + % + gap            │                                           │
│  Deadline / renewal           ├───────────────────────────────────────────┤
│  Cause / drivers              │ HELP PANEL (contextual)                   │
│  Impact / stake / sign-off    │  Objection / basics card, read-back line, │
│  Needs 1-3 + top              │  or pitch lines                           │
│  Next step                    │  Flags: filler 3 · talk ratio 34%         │
└───────────────────────────────┴───────────────────────────────────────────┘
```

- Dark theme by default (calmer on a call), readable at arm's length. Min body text 16px, field values 18px.
- Click any field to edit, which locks it. Hover shows the evidence quote and its timestamp.
- Keyboard: `Space` = pause/resume listening, `N` = mark next step, `L` = lock/unlock hovered field, `E` = end call.

## 9. End of call: debrief

On **End**, send the full transcript and final notes to `/debrief` (strong model). It returns, and the page shows:

1. **Score against the 7 criteria** (1–5 each, total /35), with a one-line reason and one specific fix for each, quoting my actual words:
   1. Understanding of the customer
   2. Level of preparation
   3. Presentation skills and communication
   4. Understanding of Nutanix at base level
   5. Ability to deal with objections
   6. Control over the meeting and time management
   7. Clear next action
2. **The four "must do" checks:** uncovered situation / pain / needs / implications / timeframe; introduced Nutanix at outcome level; handled objections; agreed a specific next step.
3. **Timeline:** when each step started vs target.
4. **Stats:** talk ratio, filler count, longest monologue, questions asked, banned phrases used.
5. **Three things to do differently next run**, ordered by score impact.
6. A running **run log** (`sessions/index.json`) so I can see scores over time. My target is 5 runs at 35/35 before the panel.

Include a "Copy debrief" button and an "Export notes" button (Markdown, matching the sheet's Call and Brief tabs).

## 10. Data and files

```
call-copilot/
  server.js
  package.json
  .env.example
  public/
    index.html  app.js  styles.css  audio-worklet.js
  data/
    knowledge.json      ← provided: lookup (11 pain types), basics (9), objections (5), slips to avoid
    script.json         ← the step-by-step questions from the Call tab (Claude Code: create from the xlsx)
    rubric.json         ← the 7 criteria + 4 must-dos + time targets (create from the xlsx Brief tab)
  sessions/             ← one folder per call, git-ignored
  README.md             ← setup incl. BlackHole steps
  test/
    sample-call.txt     ← fake transcript for testing without audio
```

`knowledge.json` is attached. Pull `script.json` and `rubric.json` from the original `nutanix_call_builder_v3.xlsx` (Call and Brief tabs). Don't retype the wording, because it's mine and already tuned.

## 11. Build phases (fast route, first build = Phases 1 and 2)

**Phase 1 — replay + fill (build this first, no audio needed)**
- Server, page, `/extract`, schema, patch merge, evidence links, tap-to-confirm "suggested" fields, lock-on-edit.
- Derived values, read-back lines, targeted questions, pitch panel (section 6), Brief auto-ticks, coverage board.
- **Replay mode:** load `test/sample-call.txt` (write three: one tidy, one messy and out of order with tangents and interruptions, one thin with only a single need and no clear priority) and feed it in as if live.
- Calm-mode layout (section 8).
- *Done when:* replaying the messy call fills at least 90% of fields correctly, invents nothing, and the pitch appears as soon as one usable item exists and improves as more is heard.

**Phase 2 — it hears me**
- Mic capture, level meter, Deepgram streaming (Chrome speech fallback if no key), live Me/Her transcript, saved to `sessions/`, `npm run check`.
- Feed live transcript into the Phase 1 pipeline.
- *Done when:* I speak a scripted 3-minute role-play and the fields and pitch fill within ~4s of each statement.

**Phase 3 — it guides me**
- Timer, flags, objection/basics cards, talk ratio, parked-topics list.

**Phase 4 — it debriefs me**
- `/debrief` scores, run log, Markdown export.

**Phase 5 — tab audio and BlackHole modes**, then the practice-partner mode (Claude plays the prospect). Pull Phase 5 earlier if my first test is on Zoom.

## 11b. Reliability rules for the first build

1. A wrong value is worse than an empty one. Fields start as grey "heard" suggestions and go solid after she repeats them or I tap to confirm. Update quietly, no flashing on corrections.
2. Numbers show a "heard as…" tooltip with the transcript line. Flag low-confidence numbers, never silently fill them.
3. One-key **swap speakers** (labels sometimes flip). Treat unlabelled lines cautiously.
4. A **pin last 30s** hotkey to mark a moment to check after the call.
5. If the network drops, keep the transcript locally and run extraction and debrief afterwards.
6. Every session folder is saved as a reusable test case.

## 12. Acceptance tests

00. **Thin call:** on a sample where she gives only one need and no top need, the pitch still builds (one line, tagged assumed). On a sample with two pains and no stated needs, the pitch builds from the pains with the amber tag.
0. **Out of order:** on the messy sample call (budget first, then pain, then a tangent about her holiday, then the number), every field still fills correctly and the tangent lands in Parked, not in a field.
1. **Latency:** a spoken number ("they currently pay about 400 grand") appears in the right field within 4s of me finishing the sentence.
2. **Number parsing:** "six hundred thousand", "600k", "point six of a million" all become 600000.
3. **No invention:** a call with no mention of a deadline leaves `deadline` null.
4. **Her words only:** if I say "so the renewal's in June?" and she says nothing, `renewalDate` stays null. If she confirms "yes, end of June", it fills with "end of June".
5. **Lock:** I edit `cause`; a later contradictory statement does not overwrite it.
6. **Correction:** she says "quote is 600, sorry, 650", and `quote` becomes 650000 with the old value kept in history.
7. **Flag:** me saying "we guarantee zero downtime" triggers the warning within 2s.
8. **Recovery:** unplug the network for 20s mid-call. The page shows NOT LISTENING, then reconnects and the transcript has no gap.
9. **Debrief:** on the sample call the scores are plausible and every "fix" quotes a real line from the transcript.

## 13. Constraints and notes

- **Cost control:** extraction calls only when there is new speech. Cap at one call per ~6s. Log token use per session in the debrief footer.
- **Privacy:** audio is streamed to Deepgram and text to Anthropic's API. Nothing else leaves the Mac. Don't store raw audio unless I tick "Save audio".
- **Consent:** show a one-line reminder on start: "Tell the other person you're taking notes with a transcription tool." The role-play assessment may not allow tools. Check with the recruiter first.
- **Chrome only** is fine. No need for Safari/Firefox support.
- Prefer boring and readable code over clever code. Small files, comments on the audio and merge logic. I'm not a full-time developer, so a README that explains how to run, stop and fix it matters.
- Ask me before adding any dependency beyond: express, ws, dotenv, @anthropic-ai/sdk.

## 14. First prompt to give Claude Code

> Read SPEC.md, data/knowledge.json and nutanix_call_builder_v3.xlsx. Create the project structure in section 10 and build Phase 1 only (replay + fill, no audio). Port the formulas from the xlsx exactly. Write three sample calls, including a messy out-of-order one and a thin one where she gives only one need, and make the acceptance tests in section 12 pass against them. Remember that real calls aren't linear (section 7). When Phase 1 meets its "done when", stop and tell me how to run it. Don't start Phase 2 until I say so.
