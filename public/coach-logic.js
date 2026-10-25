'use strict';
// Pure logic shared between app.js (browser) and run-tests.js (Node).
// UMD wrapper: attaches to window.CoachLogic in browsers, module.exports in Node.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CoachLogic = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const CONSTRAINT_WORDS = [
    'away', 'holiday', 'vacation', 'freeze', 'unavailable',
    'not available', 'out of office', 'on leave', 'blackout',
    'embargo', 'closed', 'closure'
  ];

  function isConstraintItem(text) {
    const lower = String(text).toLowerCase();
    return CONSTRAINT_WORDS.some(function (w) { return lower.includes(w); });
  }

  // Truncate text at the last word boundary at or before maxChars, append …
  function truncateWords(text, maxChars) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    var cut = text.lastIndexOf(' ', maxChars - 1);
    if (cut < 1) cut = maxChars;
    return text.slice(0, cut) + '…';
  }

  // Phrases that indicate Me is actually handling an objection (vs. moving on).
  var HANDLING_PHRASES = [
    "can't promise", "cannot promise", "i can't", "i cannot",
    "what would you need", "what do you need to see",
    "i'd want an expert", "want an expert",
    "put it in the comparison", "that's exactly what",
    "comparison is for", "feel safe", "honestly can",
    "that's a fair", "that's the right thing",
  ];

  var HANDLING_STOPWORDS = new Set([
    'a','an','the','to','of','and','or','in','for','that','it','i',
    'is','are','be','have','has','you','your','we','can','will','would','could',
    'there','their','this','but','if','as','so','not','with','from','up','about',
    'what','when','who','why','how','do','did','does','at','on','by','just','also',
    'get','got','its','our','she','her','him','his',
  ]);

  // Returns true if meText actually addresses the objection (not an unrelated exchange).
  function meResponseAddressesObjection(meText, objQuote) {
    var lower = meText.toLowerCase();
    // Generic handling patterns
    if (HANDLING_PHRASES.some(function(p) { return lower.includes(p); })) return true;
    // Direct keyword overlap with her objection words
    var words = (objQuote || '').toLowerCase().split(/\W+/).filter(function(w) {
      return w.length >= 4 && !HANDLING_STOPWORDS.has(w);
    });
    return words.some(function(w) { return lower.includes(w); });
  }

  // Auto-mark open objections as 'handled-auto' when:
  //   1. Me has spoken after the objection AND addressed it (not an unrelated exchange)
  //   2. Her has spoken again after Me (she moved on)
  // Mutates in place. Safe to call on every render pass.
  function autoHandleObjections(objections, transcript) {
    for (var i = 0; i < (objections || []).length; i++) {
      var obj = objections[i];
      if (obj.status !== 'open') continue;
      var objIdx = -1;
      for (var j = 0; j < transcript.length; j++) {
        if (transcript[j].id === obj.utteranceId) { objIdx = j; break; }
      }
      if (objIdx < 0) continue;
      var meAfterIdx = -1;
      var meText = '';
      for (var j = objIdx + 1; j < transcript.length; j++) {
        if (transcript[j].speaker === 'Me') { meAfterIdx = j; meText = transcript[j].text; break; }
      }
      if (meAfterIdx < 0) continue;
      // Me's first response must address the objection — not just any question
      if (!meResponseAddressesObjection(meText, obj.quote)) continue;
      var herAfterIdx = -1;
      for (var j = meAfterIdx + 1; j < transcript.length; j++) {
        if (transcript[j].speaker === 'Her') { herAfterIdx = j; break; }
      }
      if (herAfterIdx >= 0) obj.status = 'handled-auto';
    }
  }

  var SD_QUANTITY_WORDS = { 'double':1,'triple':1,'half':1,'twice':1,'once':1,'thrice':1,'more':1,'less':1,'much':1,'many':1,'very':1,'quite':1 };

  function _isStageDirectionFragment(fragment) {
    var text = fragment.trim().replace(/[.!?]+$/, '').trim();
    if (!text) return false;
    var words = text.split(/\s+/);
    if (words.length < 1 || words.length > 5) return false;
    if (/\d/.test(text)) return false;
    var lower = text.toLowerCase();
    if (/\b(i|we|you|us|me|our|my|your)\b/.test(lower)) return false;
    if (/^(a|an)\s/i.test(text)) return true;
    if (/^\w+ly\b/.test(text) && words.length <= 2) {
      var second = words.length === 2 ? words[1] : '';
      // second word starts uppercase → proper noun (e.g. "Early March"), not a stage direction
      if (second && /^[A-Z]/.test(second)) return false;
      return !SD_QUANTITY_WORDS[second.toLowerCase()];
    }
    return false;
  }

  // Strip stage directions from a Her utterance (bracketed, starred, and unbracketed short fragments).
  function stripStageDirections(text) {
    var result = String(text)
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\*[^*]+\*/g, '')
      .replace(/\bOkay\.\s*Good\.\s*Stop\.?\s*/g, '');
    var parts = result.split(/(?<=[.!?])\s+/);
    var kept = parts.filter(function(p) { return !_isStageDirectionFragment(p); });
    return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  function tsToSec(ts) {
    var parts = (ts || '0:00').split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }

  // ── Agenda/RoE detection — did Me set an objective in the first 5 min? ────────
  var ROE_WORDS = [
    'agenda', 'feel fair', 'does that work', 'part ways', 'next step makes sense',
    'objective', 'fair?', 'is that okay', 'okay with you', 'good fit',
    'figure out if', 'moving forward', 'virtual estate',
  ];

  function hasRoE(transcript) {
    var earlyMe = (transcript || []).filter(function(u) {
      return u.speaker === 'Me' && tsToSec(u.ts) <= 300;
    });
    return earlyMe.some(function(u) {
      var low = u.text.toLowerCase();
      return ROE_WORDS.some(function(w) { return low.includes(w); });
    });
  }

  // Pure auto-detection of opening ticks from transcript — Me lines only.
  // o4 requires Me to have asked a non-RoE question (discovery question, not agenda).
  function computeOpeningTicksFromTranscript(transcript) {
    var earlyMe = (transcript || []).filter(function(u) { return u.speaker === 'Me' && tsToSec(u.ts) <= 300; });
    var o1Auto = earlyMe.length > 0;
    var o3Auto = hasRoE(transcript);
    var o2Auto = (o1Auto && o3Auto) || earlyMe.some(function(u) {
      var low = u.text.toLowerCase();
      return (low.includes('understand') || low.includes('figure out') || low.includes('useful') || low.includes("what i'd")) &&
             (low.includes('minute') || low.includes('hour') || low.includes('fit') || low.includes('today'));
    });
    var o4Auto = earlyMe.some(function(u) {
      return u.text.includes('?') && !hasRoE([u]);
    });
    return { o1: o1Auto, o2: o2Auto, o3: o3Auto, o4: o4Auto };
  }

  // Returns the NEXT question to show after Nutanix has been introduced.
  // objections:   full state.objections array (open ones filtered here)
  // nextStepDone: boolean — true when tick '4' status is 'done'
  // getSayThis:   optional (key) => sayThisText  — provides playbook text for open objection
  function postPitchNext(objections, nextStepDone, getSayThis) {
    var openObjs = (objections || []).filter(function (o) { return o.status === 'open'; });
    if (openObjs.length > 0) {
      var obj = openObjs[openObjs.length - 1];
      var raw = (getSayThis ? getSayThis(obj.matchedKey) : null) || obj.quote;
      return 'Handle: ' + truncateWords(raw, 80);
    }
    if (!nextStepDone) return 'Does a next step make sense?';
    return "Recap: confirm who, what, when, and say you'll send it today.";
  }

  var CRITERION_QUESTIONS = {
    '1a': [
      "Walk me through your estate: what runs on it, how many hosts and VMs, how much storage, how big is the team?",
    ],
    '1b': [
      "What made you open to this conversation, given you've been on VMware for 10 years?",
      "What does that affect over the next 6 to 12 months?",
      "What's driving that to be a priority right now?",
      "Is this the thing to focus on, or will something else overtake it?",
    ],
    '1c': [
      "What do you need to happen before your deadline?",
      "Which of those matters most to you?",
      "Why does that matter to you personally?",
    ],
    '1d': [
      "What happens if nothing changes by then?",
      "What gets cut or delayed if this doesn't get resolved?",
    ],
    '1e': [
      "When is the board or sign-off deadline?",
      "When does the renewal fall?",
    ],
    '2': [],
    '3': [],
    '4': [
      "Does a next step make sense?",
      "Who else should be in the room?",
      "Let's book a working session before your deadline — shall I send dates today?",
    ],
  };

  var CRIT_TOPICS = {
    '1a': ['host', 'vm', 'virtual', 'storage', 'terabyte', 'team', 'estate', 'server', 'infrastructure'],
    '1b': ['renewal', 'quote', 'cost', 'pain', 'problem', 'challenge', 'concern', 'reseller', 'meeting', 'impact', 'affect'],
    '1c': ['need', 'want', 'require', 'happen', 'outcome', 'priority', 'before', 'achieve'],
    '1d': ['nothing', 'change', 'sign', 'stays', 'consequence', 'delay', 'push', 'default'],
    '1e': ['deadline', 'board', 'date', 'february', 'renewal', 'expir', 'by when'],
    '4':  ['next', 'step', 'meeting', 'session', 'follow', 'book', 'diary', 'dates'],
  };

  var DRIVER_MAP = [
    { keywords: ['licen', 'paying for parts', 'unused'],                   q: "To what extent are you paying for parts of the licence you don't use?" },
    { keywords: ['renewal', 'renew'],                                       q: "When does the renewal fall?" },
    { keywords: ['team', 'stretched', 'capacity', 'headcount'],             q: "How many people do you have, and how much time are they spending on keeping this running?" },
    { keywords: ['ageing', 'aging', 'old server', 'end of support'],        q: "When does that hardware go end of support?" },
    { keywords: ['outage', 'downtime', 'went down', 'crashed'],             q: "How many outages have you had, and what was the impact?" },
    { keywords: ['mandate', 'compliance', 'regulation', 'legal', 'audit'],  q: "What exactly does the mandate require you to change?" },
  ];

  // Pure function — takes notes, transcript array, and knowledge data (all passable from tests).
  // Opening lines (intro, agenda, "does that feel fair?") share no keyword overlap with discovery
  // questions, so alreadyAsked correctly returns false for them without any timestamp filter.
  function computeCoachNext(notes, transcript, knowledgeData) {
    var stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are','be','have','has','you','your','me','we','our','what','when','who','why','how','do','did','does','at','on','by','this','but','if','as','so','not','can','with','from','up','about','very','just','also','will','would','could','there','their']);

    function keyWords(text) {
      return new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(function(w) { return w.length > 2 && !stopwords.has(w); }));
    }

    var myTexts = transcript.filter(function(u) { return u.speaker === 'Me'; }).map(function(u) { return u.text; });
    var recentHer = transcript.filter(function(u) { return u.speaker === 'Her'; }).slice(-5);

    function alreadyAsked(q) {
      var qw = keyWords(q);
      if (qw.size === 0) return false;
      return myTexts.some(function(t) {
        var tw = keyWords(t);
        var overlap = [...qw].filter(function(w) { return tw.has(w); }).length;
        return overlap / qw.size >= 0.5;
      });
    }

    function hotScore(critId) {
      var keywords = CRIT_TOPICS[critId] || [];
      if (!keywords.length) return 0;
      return recentHer.reduce(function(s, u) {
        return s + keywords.filter(function(k) { return u.text.toLowerCase().includes(k); }).length;
      }, 0);
    }

    var n = notes;
    var filled = function(arr) { return arr.filter(Boolean).length; };
    var painC = filled([n.pain.value, n.whatItAffects.value, n.whyProblem.value, n.cause.value]);
    var tickStatus = {
      '1a': (n.situation.hosts.value || n.situation.vms.value || n.situation.workloads.value) ? 'done' : 'yet',
      '1b': painC >= 3 ? 'done' : painC >= 1 ? 'partial' : 'yet',
      '1c': n.needs.filter(function(nd) { return nd.value; }).length >= 1 ? 'done' : 'yet',
      '1d': filled([n.doingNothing.value, n.impactOnOthers.value, n.personalStake.value]) >= 2 ? 'done' : 'yet',
      '1e': filled([n.deadline.value, n.renewalDate.value]) >= 1 ? 'done' : 'yet',
      '4':  filled([n.nextStep.dateTime.value, n.nextStep.who.value]) >= 2 ? 'done' : 'yet',
    };

    var painMet  = tickStatus['1b'] === 'done' || tickStatus['1b'] === 'partial';
    var needsMet = tickStatus['1c'] === 'done';
    var meLines  = myTexts.map(function(t) { return t.toLowerCase(); });
    var nutanixMet = meLines.some(function(t) {
      return (t.includes('nutanix') && (t.includes('put') || t.includes('manage') || t.includes('idea') || t.includes('try') || t.includes('brings') || t.includes('one system'))) ||
             t.includes('can i try a few ideas');
    });

    var BASE_SCORE = { '1a': 60, '1b': 80, '1c': 70, '1d': 65, '1e': 75, '4': 50 };

    var OPENER_Q = "What made you open to this conversation, given you've been on VMware for 10 years?";
    var openerAskedByMe = alreadyAsked(OPENER_Q);
    var situationVolunteered = !!(n.situation.hosts.value || n.situation.vms.value || n.situation.storageTB.value || n.situation.teamSize.value);

    var candidates = [];

    for (var critId of Object.keys(CRITERION_QUESTIONS)) {
      if (tickStatus[critId] === 'done') continue;
      var qs = CRITERION_QUESTIONS[critId];
      if (!qs || !qs.length) continue;
      if (critId === '4' && (!painMet || !needsMet || !nutanixMet)) continue;
      if (critId === '1a' && !openerAskedByMe && !situationVolunteered) continue;

      var score = (BASE_SCORE[critId] || 50) + hotScore(critId) * 10;
      for (var qi = 0; qi < qs.length; qi++) {
        if (!alreadyAsked(qs[qi])) { candidates.push({ q: qs[qi], score: score, critId: critId }); break; }
      }
    }

    // Driver steering: after opener asked, steer based on what she said
    if (openerAskedByMe && tickStatus['1b'] !== 'done') {
      var allHerText = transcript.filter(function(u) { return u.speaker === 'Her'; }).map(function(u) { return u.text.toLowerCase(); }).join(' ');
      var driverMatched = false;
      for (var di = 0; di < DRIVER_MAP.length; di++) {
        var driver = DRIVER_MAP[di];
        if (driver.keywords.some(function(k) { return allHerText.includes(k); }) && !alreadyAsked(driver.q)) {
          candidates.push({ q: driver.q, score: 500, critId: '1b', move: 'driver' });
          driverMatched = true;
          break;
        }
      }
      if (!driverMatched) {
        var lastHerText = transcript.filter(function(u) { return u.speaker === 'Her'; }).slice(-1)[0]?.text || '';
        var VAGUE_Q = "Makes sense. So tell me about your setup today.";
        var lastHasDriver = DRIVER_MAP.some(function(d) { return d.keywords.some(function(k) { return lastHerText.toLowerCase().includes(k); }); });
        if (lastHerText && lastHerText.split(/\s+/).length < 12 && !lastHasDriver && !alreadyAsked(VAGUE_Q)) {
          candidates.push({ q: VAGUE_Q, score: 500, critId: '1b', move: 'vague' });
        }
      }
    }

    // Add targeted questions from knowledge data if pain type is known
    if (knowledgeData && n.painType.value) {
      var lk = knowledgeData.lookup.find(function(l) { return l.painType === n.painType.value; });
      if (lk) {
        if (tickStatus['1d'] !== 'done' && lk.impactQuestion && !alreadyAsked(lk.impactQuestion)) {
          candidates.push({ q: lk.impactQuestion, score: 200, critId: '1d', lesson: 'L26', move: 'M8' });
        }
        if (tickStatus['1b'] !== 'done' && lk.causeQuestion && !alreadyAsked(lk.causeQuestion)) {
          candidates.push({ q: lk.causeQuestion, score: 190, critId: '1b', lesson: 'L19', move: 'M6' });
        }
      }
    }

    // M6: open-cause before targeted — pain known, cause not yet
    var M6_OPEN = "What's your opinion on why this is happening?";
    if (n.pain.value && !n.cause.value && tickStatus['1b'] !== 'done' && !alreadyAsked(M6_OPEN)) {
      candidates.push({ q: M6_OPEN, score: 195, critId: '1b', lesson: 'L18', move: 'M6' });
    }

    // M8: open-impact before targeted — pain known, impact not yet
    var M8_OPEN = "What ripple effects is this having on the rest of the business?";
    if (n.pain.value && tickStatus['1d'] !== 'done' && !alreadyAsked(M8_OPEN)) {
      candidates.push({ q: M8_OPEN, score: 205, critId: '1d', lesson: 'L25', move: 'M8' });
    }

    // M1: RoE nudge if past 2 min with no agenda set
    var elapsed = transcript.length > 0 ? tsToSec(transcript[transcript.length - 1]?.ts || '0:00') : 0;
    var ROE_Q = "Does that feel fair?";
    if (elapsed >= 120 && !hasRoE(transcript) && !alreadyAsked(ROE_Q)) {
      candidates.push({ q: ROE_Q, score: 350, critId: 'roe', lesson: 'L5', move: 'M1' });
    }

    candidates.sort(function(a, b) { return b.score - a.score; });

    var seen = new Set();
    var deduped = candidates.filter(function(c) { if (seen.has(c.critId)) return false; seen.add(c.critId); return true; });

    return {
      mainQ:      deduped[0]?.q      || null,
      backupQ:    deduped[1]?.q      || null,
      mainLesson: deduped[0]?.lesson || null,
      mainMove:   deduped[0]?.move   || null,
    };
  }

  return {
    CONSTRAINT_WORDS: CONSTRAINT_WORDS,
    isConstraintItem: isConstraintItem,
    truncateWords: truncateWords,
    autoHandleObjections: autoHandleObjections,
    postPitchNext: postPitchNext,
    hasRoE: hasRoE,
    computeOpeningTicksFromTranscript: computeOpeningTicksFromTranscript,
    stripStageDirections: stripStageDirections,
    CRITERION_QUESTIONS: CRITERION_QUESTIONS,
    CRIT_TOPICS: CRIT_TOPICS,
    DRIVER_MAP: DRIVER_MAP,
    computeCoachNext: computeCoachNext,
  };
}));
