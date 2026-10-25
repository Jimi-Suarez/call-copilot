# Call Copilot

Real-time discovery assistant for Nutanix sales calls. Listens to the call, extracts structured notes, and surfaces pitch lines, targeted questions, and objection playbooks as the conversation unfolds.

## Quick start

1. Copy `.env.example` to `.env` and add your keys:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   DEEPGRAM_API_KEY=...        # optional — enables live mic via Deepgram
   PORT=3002                   # optional, default 3002
   ```
2. `npm install`
3. `npm start` → open http://localhost:3002

## Running checks

```
npm run check
```

Verifies API keys and model reachability.

## Running tests

```
npm test
```

Runs all sample calls through `/extract` and checks extraction accuracy.

## Live mic

Click **Start Live** in the top bar. The app will:
- Use Deepgram (nova-2, en-GB, diarization) if `DEEPGRAM_API_KEY` is set
- Fall back to the browser's built-in Speech Recognition API (Chrome only, no diarization)

Each session is saved to `sessions/` as a timestamped `.txt` file.

If diarization assigns the wrong speaker to you, click **Me=Spk0** to flip speakers.

## Replay mode

Select a sample call from the dropdown and click **Start Replay** to test without a microphone.

## Objection handling

When the model detects an objection in Her's speech, an amber banner appears with:
- Her exact quote
- What she's worried about
- The exact line to say

Click **Handled** or **Not an objection** to dismiss. Open and handled objections appear as chips.
