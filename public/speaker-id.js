'use strict';
// Speaker identification: calibration, name trigger, inversion heuristic.
// UMD — window.SpeakerID in browser, module.exports in Node.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.SpeakerID = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // All accepted spellings of Jimi's first name
  var MY_NAME = 'Jimi';
  var NAME_ALT_RE = '(jimi|jimmy|jimmie|jimmi|gimmy)';

  // First-person intro: "My name is Jimi", "I'm Jimi", "This is Jimi [at/from/inside]"
  // Must NOT match "Hi Jimi", "thanks Jimi", "morning Jimi" (second-person vocative)
  var INTRO_RE = new RegExp(
    '\\b(my name is|i\'?m|this is)\\s+' + NAME_ALT_RE + '\\b',
    'i'
  );

  // Salesperson-behaviour patterns (each match = 1 point)
  var SALES_PATTERNS = [
    /what i'?d (love|like)/i,
    /i'?d like to (understand|spend)/i,
    /spend the first \d+/i,
    /does that feel fair/i,
    /does that work\b/i,
    /does that work for you/i,
    /walk me through/i,
    /what made you/i,
    /what does that affect/i,
    /what'?s driving/i,
    /\bnutanix\b/i,
    /can you put a number/i,
    /what (else )?(would )?give you pause/i,
    /what ripple/i,
    /inside sales|at nutanix|from nutanix/i,
  ];

  // Prospect-behaviour patterns (each match = 1 point)
  var PROSPECT_PATTERNS = [
    /\bwe pay\b/i,
    /our renewal/i,
    /\bthe board\b/i,
    /my manager/i,
    /the it budget/i,
    /\bour budget\b/i,
    /\bour team\b/i,
    /our vmware/i,
    /i'?m sceptical/i,
    /we can'?t afford/i,
    /sign off\b/i,
  ];

  function scoreLines(lines, patterns) {
    var score = 0;
    for (var i = 0; i < lines.length; i++) {
      for (var j = 0; j < patterns.length; j++) {
        if (patterns[j].test(lines[i])) score++;
      }
    }
    return score;
  }

  // Returns true if text is a first-person intro containing Jimi's name.
  // "Hi Jimi" / "thanks, Jimi" → false.
  function isNameTrigger(text) {
    return INTRO_RE.test(String(text));
  }

  // Scores how much a speaker's lines look like the salesperson vs. prospect.
  function scoreSpeaker(lines) {
    return {
      sales:    scoreLines(lines, SALES_PATTERNS),
      prospect: scoreLines(lines, PROSPECT_PATTERNS),
    };
  }

  // detectInversion: returns { inverted: bool, confidence: 0-1 }
  // Requires >= 6 utterances and >= 2 lines per speaker.
  function detectInversion(utterances) {
    if (!utterances || utterances.length < 6) return { inverted: false, confidence: 0 };

    var meLines  = [];
    var herLines = [];
    for (var i = 0; i < utterances.length; i++) {
      var u = utterances[i];
      if (u.speaker === 'Me')  meLines.push(u.text);
      if (u.speaker === 'Her') herLines.push(u.text);
    }

    if (meLines.length < 2 || herLines.length < 2) return { inverted: false, confidence: 0 };

    var me  = scoreSpeaker(meLines);
    var her = scoreSpeaker(herLines);

    // Normal:   Me is sales, Her is prospect  → high (me.sales + her.prospect)
    // Inverted: Her is sales, Me is prospect  → high (her.sales + me.prospect)
    var normalEvidence   = me.sales   + her.prospect;
    var invertedEvidence = her.sales  + me.prospect;
    var total = normalEvidence + invertedEvidence;

    if (total === 0) return { inverted: false, confidence: 0 };

    var confidence = invertedEvidence / total;
    return { inverted: confidence > 0.8, confidence: confidence };
  }

  // Swap all Me/Her labels (returns a new array; does not mutate).
  function applySwap(utterances) {
    return utterances.map(function (u) {
      return { id: u.id, ts: u.ts, text: u.text,
               speaker: u.speaker === 'Me' ? 'Her' : 'Me' };
    });
  }

  return {
    MY_NAME: MY_NAME,
    INTRO_RE: INTRO_RE,
    isNameTrigger: isNameTrigger,
    scoreSpeaker: scoreSpeaker,
    detectInversion: detectInversion,
    applySwap: applySwap,
  };
}));
