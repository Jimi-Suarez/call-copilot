# Pains and scenario variety: addendum to SPEC.md

Read this together with SPEC.md. It replaces the "11 pain types" assumption and adds a scenario generator.

## 1. The fixed scenario, the variable parts

The assessment is always the same: an IT director at a well-known hospital, 10 years on VMware, brought in by a partner reseller. What changes every time is **which pains she has, how she behaves, what she says and in what order**. The app must never assume a particular pain, order or personality.

## 2. A much bigger pain model

- `data/knowledge.json` has 11 pains. `data/pain-taxonomy-new.json` adds 28 more across four families: cost, risk, technology, people and organisation. Merge them into one taxonomy of 39 (keep the original 11 unchanged). Each entry has: `id`, `family`, `label`, `sheMightSay`, `weDo` (starts with a verb), `rootCauseQuestion`, `impactQuestion`, optional `caution`, and `supportingFact` / `source`.
- `data/situations.json` holds six special call situations that aren't pains: no pain surfaced, pain played down, already evaluating another option, just renewed, not the decision maker, and "other". Each has a handling rule.
- **The taxonomy is a helper, not a cage.** Her words are always the source of truth. A pain type is only a suggestion used to pick the targeted questions and the "We do ..." line.

### Rules for the app

1. A call can have **several pains** (usually 1–3, sometimes more). Store them as a list, each with her words, a suggested taxonomy id (or none), a confidence, and a rank (which she stressed most). Needs link to pains by id where possible.
2. The extractor returns up to 3 candidate taxonomy ids per pain with confidence. The UI shows the top one as a "suggested" chip, with one tap to change it from a searchable list of all 39.
3. **No match is fine.** If nothing fits with reasonable confidence, use `s-other`: keep her exact words, and have the model draft a generic "We [verb] ..." line. Label it "draft, not from Lookup". It must describe what we DO with her (process: compare, map, agree, test, name an owner), never a Nutanix product claim.
4. **No pain is fine.** Never invent one. If after the discovery questions nothing has surfaced, show the `s-no-pain` prompts and keep pitch confidence red.
5. Pains can **appear late, change, or be denied** ("not really an issue"). Store minimised pains with a "minimised" tag, and let a later statement upgrade them.
6. **Product facts.** Any supporting fact must come from `knowledge.json` with its source URL. For every new pain, `supportingFact` is null. Do not invent Nutanix claims to fill the gap. If she asks "how?", the card says "No sourced fact on file: say what we'd check together."
7. The pitch uses the pain/need's `weDo` line. The Brief and read-back lines work with any number of pains.

## 3. Scenario generator (different call every time)

Add `npm run gen-scenario` (optionally `-- --n 20 --seed 7`). It builds a random scenario from these dimensions, then asks the strongest model to write a full call transcript and an answer key from the scenario spec. The key is derived from the spec, not from the extractor, so it stays independent.

**Dimensions**
- **Pains:** pick 0–3 from the 39 (weight towards 1–2). Sometimes pick 0 (`s-no-pain`) or add one situation.
- **Her persona:** terse; chatty and rambling; hostile; friendly but sceptical; data-driven; non-technical manager; time-poor with a hard stop; defensive about the team.
- **Numbers:** gives them freely / early; refuses on a first call; gives them in the wrong unit (monthly, in thousands); corrects herself; vague ("a lot more").
- **Order and flow:** textbook order / out of order (budget or personal stakes first) / interruptions / a tangent about something unrelated / delegates part of the call to a colleague / jumps to "so what do you do?" early.
- **Her objections:** 0–3, chosen from the 5 in `knowledge.json` plus 1–2 generated "other" ones (past bad experience, a recently signed deal, competitor rumours, "why now?").
- **Her Nutanix questions:** 0–3 from the Basics tab, or a question not in the tab (which must get "I don't know that one" advice).
- **Your behaviour in the transcript:** good, average, or with deliberate mistakes (says "zero downtime", pitches too early, long monologue, no agenda), so the flags and the debrief get tested.
- **Ending:** specific next step / vague ("send me something") / no next step / a next step that needs a third person.
- **Timing:** pitch starts early / on time / late; runs over 30 minutes.
- **Speech-to-text noise:** randomly replace some words as a transcriber would ("Nutanics", "VM ware", "A H V", "four hundred" vs "forty").

**Output** (to `test/generated/<id>.txt` and `<id>.expected.json`): the transcript in the standard format, plus an answer key with the scenario spec, expected field values (null where nothing is said), which pains and needs should be found, the top need (or "unspecified"), expected objections, expected next step, and anything that must NOT be invented.

**Runner:** `npm run test:generated` runs every generated call through the full pipeline and prints:
- pass rate per field (numbers, situation, dates, needs, top need, objections, next step),
- **invented-value rate** (a filled field with no support in her words). This is the most important number and should be 0,
- which pain ids and situations have been covered so far, so the generator can prioritise gaps,
- the 5 worst calls with the lines that caused the problem.

## 4. Test discipline

- Three layers: (1) hand-written hold-out calls in `test/holdout/` (never edited by Claude Code); (2) generated calls, regenerated with new seeds each run; (3) the original sample calls.
- **Never tune a prompt to a single failing call.** Find the general cause. If the same kind of failure shows in 3 or more generated calls, fix the rule. Keep a changelog in `CHANGELOG-extraction.md` of what rule changed and why.
- Generated keys can be wrong. When a failure looks suspicious, check the transcript before changing the app.
- Acceptance bar before relying on it in a real call: invented-value rate 0% over 30 generated calls, and at least 90% on named fields, with the pitch building on every call that has at least one stated need or pain.

## 5. Practice partner (next feature, reuses the generator)

Add `npm run practice`: the same generator creates a scenario, then Claude plays the IT director live (text first, voice later) with that persona, pains, numbers and objections, revealing information only when asked a good question. It never reveals her scenario spec. At the end it saves the transcript and the debrief, and records the score in the run log toward 5 full runs at 35/35. Each run uses a fresh random scenario.
