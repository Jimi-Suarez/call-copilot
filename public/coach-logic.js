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
    'num': [
      "Can you put a number on what you're paying now, and what the quote is?",
      "What's the current renewal spend, and what has the reseller quoted?",
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
    'num': ['price', 'cost', 'pay', 'quote', 'number', 'figure', 'budget', 'money', 'spend'],
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
      '1d': (n.doingNothing && n.doingNothing.value && n.personalStake && n.personalStake.value) ? 'done' : filled([n.doingNothing.value, n.impactOnOthers.value, n.personalStake.value]) >= 1 ? 'partial' : 'yet',
      '1e': filled([n.deadline.value, n.renewalDate.value]) >= 1 ? 'done' : 'yet',
      'num': (n.numbers && n.numbers.paysNow && n.numbers.paysNow.value !== null && n.numbers.quote && n.numbers.quote.value !== null) ? 'done' : 'yet',
      '4':  filled([n.nextStep.dateTime.value, n.nextStep.who.value, n.nextStep.purpose.value]) >= 3 ? 'done' : filled([n.nextStep.dateTime.value, n.nextStep.who.value]) >= 2 ? 'partial' : 'yet',
    };

    var painMet  = tickStatus['1b'] === 'done' || tickStatus['1b'] === 'partial';
    var needsMet = tickStatus['1c'] === 'done';
    var meLines  = myTexts.map(function(t) { return t.toLowerCase(); });
    var nutanixMet = detectNutanixIntro(meLines);

    var BASE_SCORE = { '1a': 60, '1b': 80, '1c': 70, '1d': 65, '1e': 75, 'num': 55, '4': 50 };

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
      if (critId === 'num' && tickStatus['1a'] !== 'done') continue;

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

  // Outcome-led Nutanix intro detection.
  // A line counts as an intro when it contains any positive phrase.
  // Pure migration/technical strings with no positive phrase do NOT count.
  var NUTANIX_INTRO_PHRASES = [
    'can i try a few ideas',
    'let me tell you a bit about what we do',
    'a bit about nutanix',
    'let me introduce nutanix',
    'what nutanix does',
    'one system',
    'one platform',
    'single platform',
    'manage it from one',
    'how we help',
    'can i share',
    'let me show you',
    "here's how that fits",
    'hyperconverged',
    'one place',
  ];

  function detectNutanixIntro(meLines) {
    return (meLines || []).some(function(t) {
      return NUTANIX_INTRO_PHRASES.some(function(p) { return t.includes(p); });
    });
  }

  // Returns the list of assessment gaps that must be covered before pitching.
  // gaps: 'doing nothing', 'personal stake', 'numbers', 'top need'
  function computePitchGaps(notes, numbersDeclined) {
    var n = notes || {};
    var gaps = [];
    if (!(n.doingNothing && n.doingNothing.value)) gaps.push('doing nothing');
    if (!(n.personalStake && n.personalStake.value)) gaps.push('personal stake');
    var nums = n.numbers || {};
    var numsDone = (nums.paysNow && nums.paysNow.value !== null) &&
                   (nums.quote && nums.quote.value !== null) &&
                   (nums.canAbsorb && nums.canAbsorb.value !== null);
    if (!numsDone && !numbersDeclined) gaps.push('numbers');
    var hasNeeds = (n.needs || []).filter(function(nd) { return nd.value; }).length >= 1;
    if (!hasNeeds || !(n.topNeed && n.topNeed.value)) gaps.push('top need');
    return gaps;
  }

  // Returns pitch alert state: null (not yet), { status:'amber', gaps:[...] }, or { status:'ready', gaps:[] }
  function computePitchAlert(notes, numbersDeclined) {
    var n = notes || {};
    var painFilled = n.pain && n.pain.value;
    var hasNeeds = (n.needs || []).filter(function(nd) { return nd.value; }).length >= 1;
    if (!painFilled || !hasNeeds) return null;
    var gaps = computePitchGaps(n, numbersDeclined);
    return { status: gaps.length === 0 ? 'ready' : 'amber', gaps: gaps };
  }

  // Returns true when the "What else would give you pause?" prompt should be shown before close.
  function shouldShowPausePrompt(objections, pauseAsked) {
    return !pauseAsked && (objections || []).length < 2;
  }

  // ── Red-flag rules ──────────────────────────────────────────────────────────
  // Sources: Pitch tab Slips, Lookup cautions, Objections tab.
  // triggeredBy: the word/phrase shown in the banner "You said '[word]'. Walk it back:"
  var RED_FLAG_RULES = [
    {
      id: 'zero-downtime',
      triggeredBy: 'zero/no downtime',
      test: function(lower) {
        var hasPhrase = lower.includes('zero downtime') || lower.includes('no downtime') ||
                        /\b(minutes?|seconds?),?\s+not\s+hours?\b/.test(lower);
        if (!hasPhrase) return false;
        var negated = lower.includes("can't promise") || lower.includes("cannot promise") ||
                      lower.includes("won't promise") || lower.includes("never promise") ||
                      /\bnobody\b/.test(lower) || /\bno one\b/.test(lower) ||
                      /\bi\s+can'?t\b/.test(lower);
        return !negated;
      },
      correction: "That's the right thing to worry about. I can't promise zero downtime, and nobody honest can. What would you need to see in a plan to feel safe?"
    },
    {
      id: 'guarantee',
      triggeredBy: 'guarantee',
      test: function(lower) {
        return /\b(i|we)\s+guarantee\b/.test(lower) || /\b(it|this)\s+is\s+guaranteed\b/.test(lower);
      },
      correction: "Never guarantee outcomes. 'I can't promise that, because I haven't seen your setup yet. What would you need to see?'"
    },
    {
      id: 'cheaper',
      triggeredBy: 'cheaper',
      test: function(lower) {
        if (!lower.includes('cheaper')) return false;
        var negated = lower.includes("can't promise") || lower.includes("cannot promise") ||
                      lower.includes("can't say") || lower.includes("cannot say") ||
                      lower.includes("i don't know") || lower.includes("haven't seen") ||
                      lower.includes("not promising") || lower.includes("won't say") ||
                      /\bi\s+can'?t\b/.test(lower);
        return !negated;
      },
      correction: "Never say 'cheaper' without proof. 'I can't promise that, because I haven't seen your setup yet. What would you need to see to know if it's worth it?'"
    },
    {
      id: 'safer-faster',
      triggeredBy: 'safer/faster than VMware',
      test: function(lower) {
        return /\b(nutanix|it|this)\s+(is|will\s+be|would\s+be)\s+(safer|faster)\b/.test(lower) ||
               /\b(safer|faster)\s+than\s+vmware\b/.test(lower);
      },
      correction: "Never say 'safer' or 'faster' without proof. Describe what you build together instead."
    },
    {
      id: 'save-percent',
      triggeredBy: 'save X%',
      test: function(lower) {
        return /\bsave\b.*\d+\s*%/.test(lower) || /\bcut\b.*\d+\s*%/.test(lower) ||
               /\d+\s*%.*\bsaving\b/.test(lower) || /\bsave\s+you\s+\d/.test(lower);
      },
      correction: "Never promise a saving. 'I haven't seen your estate, that's what the comparison is for.'"
    },
    {
      id: 'will-come-in-below',
      triggeredBy: 'will come in below',
      test: function(lower) {
        return lower.includes('will come in below') || lower.includes("it'll come in below") ||
               lower.includes('should come in below') || lower.includes('come in under');
      },
      correction: "Never promise a saving. 'I haven't seen your estate, that's what the comparison is for.'"
    },
    {
      id: 'learning-curve',
      triggeredBy: 'trained in X days/weeks',
      test: function(lower) {
        return lower.includes('weeks not months') || lower.includes('days not weeks') ||
               /\b(trained?|up to speed|learn(ing)?)\b.*\b(in|within|just|only)\s+(\d+|a\s+few|one|two|three|four|five|six|several)\s*(day|week|month)/.test(lower);
      },
      correction: "Don't promise a learning-curve length. Ask: 'Training time, or support during the move?'"
    },
    {
      id: 'included-free',
      triggeredBy: 'included / no additional cost',
      test: function(lower) {
        var relevantTerm = lower.includes('ahv') || lower.includes('hypervisor') ||
                           lower.includes('licence') || lower.includes('license') ||
                           lower.includes('vsphere');
        if (!relevantTerm) return false;
        var claimPhrase = lower.includes('included') || lower.includes('no additional cost') ||
                          lower.includes('no extra cost') ||
                          (lower.includes('free') && !lower.includes('feel free') && !lower.includes('free to'));
        if (!claimPhrase) return false;
        var attributed = lower.includes('nutanix says') || lower.includes('nutanix claims') ||
                         lower.includes('according to nutanix');
        return !attributed;
      },
      correction: "Attribute this: say 'Nutanix says AHV is included at no additional cost.' It's a vendor claim."
    },
    {
      id: 'arr-average',
      triggeredBy: 'ARR (average)',
      test: function(lower) {
        return lower.includes('arr') && lower.includes('average');
      },
      correction: "ARR means annual recurring revenue, not 'average'. State it as ARR; explain the acronym if needed."
    },
    {
      id: 'unsourced-customer',
      triggeredBy: 'hospitals run/use Nutanix',
      test: function(lower) {
        var hasPhrase = /\b\w+\s+(runs\s+on|is\s+on|uses?)\s+nutanix\b/.test(lower) ||
                        /\bhospitals?\s+(run|use|are\s+on)\s+nutanix\b/.test(lower);
        if (!hasPhrase) return false;
        var attributed = lower.includes('one customer') || lower.includes('one hospital') ||
                         lower.includes('a customer') || lower.includes('a hospital') ||
                         lower.includes('nutanix says') || lower.includes('vendor');
        return !attributed;
      },
      correction: "Use 'one hospital group said X', never as a general promise. Only if she asks, and name the source."
    },
    {
      id: 'run-down-vmware',
      triggeredBy: 'VMware is dead/failing/obsolete',
      test: function(lower) {
        return /vmware\b.*\b(dead|dying|failing|failed|terrible|awful|broken|ruined|obsolete|outdated)\b/.test(lower) ||
               /broadcom\s+(ruined|destroyed|killed|broke)\s+vmware/.test(lower) ||
               /vmware\s+(can'?t|cannot|won'?t|doesn'?t)\s+(scale|work|handle|compete)/.test(lower) ||
               /vmware\s+(is\s+)?(no\s+longer|not)\s+(viable|worth|competitive)/.test(lower);
      },
      correction: "Never run down VMware. She chose it and it has worked for ten years."
    },
    {
      id: 'definitely',
      triggeredBy: 'definitely',
      test: function(lower) {
        var hasIt = /\b(i|we|it|this|that)\s+(is\s+)?definitely\b/.test(lower) ||
                    /\bdefinitely\s+(will|cheaper|better|works?|saves?|going\s+to)\b/.test(lower);
        if (!hasIt) return false;
        var negated = lower.includes("can't definitely") || lower.includes("cannot definitely") ||
                      lower.includes("not definitely") || /\bi\s+can'?t\b/.test(lower);
        return !negated;
      },
      correction: "Avoid 'definitely' — it's a promise. 'What I can do is show you the comparison.'"
    },
    {
      id: 'i-promise',
      triggeredBy: 'I promise',
      test: function(lower) {
        if (!/\bi\s+promise\b/.test(lower)) return false;
        var negated = lower.includes("can't promise") || lower.includes("cannot promise") ||
                      lower.includes("i can't") || lower.includes("i cannot");
        return !negated;
      },
      correction: "Never promise outcomes. 'What I can do is run the comparison and show you the real numbers.'"
    },
    {
      id: 'hundred-percent',
      triggeredBy: '100%',
      test: function(lower) {
        var hasIt = lower.includes('100%') || lower.includes('100 percent') ||
                    lower.includes('one hundred percent');
        if (!hasIt) return false;
        var negated = lower.includes("can't promise") || lower.includes("cannot promise") ||
                      lower.includes("not 100") || lower.includes("never 100");
        return !negated;
      },
      correction: "Never claim 100%. 'I can show you the numbers once I've seen your estate.'"
    },
    {
      id: 'save-you-money',
      triggeredBy: 'save you money',
      test: function(lower) {
        var hasIt = /\bsave\s+you\s+(money|cost|budget)\b/.test(lower) ||
                    lower.includes('save you money');
        if (!hasIt) return false;
        var negated = lower.includes("can't") || lower.includes("cannot") ||
                      lower.includes("not promising") || lower.includes("won't");
        return !negated;
      },
      correction: "Never promise savings. 'The comparison will show what the real cost looks like.'"
    },
    {
      id: 'better-than-vmware',
      triggeredBy: 'better than VMware',
      test: function(lower) {
        return lower.includes('better than vmware') ||
               /\b(nutanix|it)\s+is\s+better\b/.test(lower) ||
               /vmware\s+(is\s+)?(bad|outdated|trash|junk|garbage)\b/.test(lower);
      },
      correction: "Never compare against VMware. 'I'm here to show you what we do — you can compare.'"
    },
  ];

  // Returns [] when clean, or [{id, triggeredBy, correction}] for each triggered rule.
  function detectRedFlags(text) {
    var lower = String(text).toLowerCase();
    var flags = [];
    for (var i = 0; i < RED_FLAG_RULES.length; i++) {
      var rule = RED_FLAG_RULES[i];
      if (rule.test(lower)) flags.push({
        id: rule.id,
        triggeredBy: rule.triggeredBy || rule.id,
        correction: rule.correction
      });
    }
    return flags;
  }

  // Returns true if meText has ≥50% keyword overlap with coiScript,
  // OR contains at least half the £Xk numbers in coiScript.
  function coiMatchesSpeech(coiScript, meText) {
    if (!coiScript || !meText) return false;
    var stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are',
      'be','about','so','right','this','its','does','that\'s','thats']);
    function kw(t) {
      return new Set(String(t).toLowerCase().replace(/[^a-z0-9£ ]/g, ' ').split(/\s+/).filter(function(w) {
        return w.length > 2 && !stopwords.has(w);
      }));
    }
    // Key-number match: £Xk amounts in the script
    var numRe = /£(\d+)k/g;
    var coiNums = [];
    var m;
    while ((m = numRe.exec(coiScript)) !== null) coiNums.push(m[1]);
    if (coiNums.length > 0) {
      var lowerMe = meText.toLowerCase();
      var matched = coiNums.filter(function(n) {
        return lowerMe.includes('£' + n + 'k') || lowerMe.includes(n + 'k') || lowerMe.includes(n + ',');
      });
      if (matched.length >= Math.ceil(coiNums.length / 2)) return true;
    }
    // Keyword overlap
    var qw = kw(coiScript);
    var tw = kw(meText);
    if (qw.size === 0) return false;
    var overlap = Array.from(qw).filter(function(w) { return tw.has(w); }).length;
    return overlap / qw.size >= 0.5;
  }

  // Pure helper: converts word-based money amount (with optional range) to integer.
  // "twenty or thirty thousand" → 25000 | "eighty thousand" → 80000
  function _wordToNum(word) {
    var ONES = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
      ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
      seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
      sixty:60, seventy:70, eighty:80, ninety:90 };
    var w = String(word).toLowerCase().trim();
    if (ONES[w] !== undefined) return ONES[w];
    var n = parseInt(w, 10);
    if (!isNaN(n)) return n;
    return null;
  }

  function parseMoneyWords(text) {
    var lower = String(text).toLowerCase().replace(/[£$€,]/g, '').trim();
    // Range: "X or Y thousand/million"
    var rangeMag = lower.match(/\b(\w+)\s+or\s+(\w+)\s+(thousand|million|grand)\b/);
    if (rangeMag) {
      var lo = _wordToNum(rangeMag[1]);
      var hi = _wordToNum(rangeMag[2]);
      if (lo != null && hi != null) {
        var mag = rangeMag[3] === 'million' ? 1000000 : 1000;
        return Math.round((lo + hi) / 2) * mag;
      }
    }
    // Single: "X thousand/million/grand"
    var singleMag = lower.match(/\b(\w+)\s+(thousand|million|grand)\b/);
    if (singleMag) {
      var val = _wordToNum(singleMag[1]);
      if (val != null) {
        var mag2 = singleMag[2] === 'million' ? 1000000 : 1000;
        return val * mag2;
      }
    }
    // Numeric suffix "80k"
    var nk = lower.match(/\b(\d+)\s*k\b/);
    if (nk) return parseInt(nk[1]) * 1000;
    // Plain number
    var plain = lower.match(/\b(\d[\d,]*)\b/);
    if (plain) return parseInt(plain[1].replace(/,/g, ''));
    return null;
  }

  // Infers quoteType from raw transcript text containing price/context words.
  function detectQuoteType(text) {
    var lower = String(text).toLowerCase();
    var RECURRING = ['a year', 'per year', 'annual', 'annually', 'renewal', 'subscription', 'per annum'];
    var ONEOFF = ['one-off', 'one off', 'capital', 'capex', 'refresh', 'purchase', 'replace', 'replacement', 'buy'];
    if (RECURRING.some(function(w) { return lower.includes(w); })) return 'recurring';
    if (ONEOFF.some(function(w) { return lower.includes(w); })) return 'oneoff';
    return 'unknown';
  }

  // Returns the arithmetic shown in small text under the COI say-this line.
  function buildCOIWorkings(paysNow, quote, available, quoteType) {
    function k(n) { return Math.round((n || 0) / 1000); }
    if (quoteType === 'oneoff') {
      if (available == null) return '';
      var gap = quote - available;
      return k(quote) + ' − ' + k(available) + ' = ' + k(gap) + 'k gap';
    }
    // recurring (default)
    if (paysNow == null || quote == null) return '';
    var inc = quote - paysNow;
    return k(quote) + ' − ' + k(paysNow) + ' = ' + k(inc) + 'k/yr';
  }

  // L24: Cost-of-inaction spoken line. Numbers-first, under 25 words, grammatical.
  // quoteType: 'recurring'|'oneoff'|'unknown' (default: 'recurring').
  // For 'unknown' returns the ask-next question instead of a COI line.
  // NEVER pastes raw doingNothing text into the spoken line.
  function buildCostOfInactionScript(paysNow, quote, canAbsorb, isMonthly, doingNothing, quoteType, available, deadline) {
    quoteType = quoteType || 'recurring';
    function fmtK(n) { return '£' + Math.round(n / 1000) + 'k'; }

    if (quoteType === 'unknown') {
      return 'Is that a yearly cost or a one-off purchase?';
    }

    if (quoteType === 'oneoff') {
      var avail = (available != null) ? available : (canAbsorb != null ? canAbsorb : null);
      var script = 'So the quote is ' + fmtK(quote);
      if (avail != null) {
        var gap = quote - avail;
        script += ', you have ' + fmtK(avail) + ", that's a " + fmtK(gap) + ' gap';
      }
      if (deadline) {
        script += ' before ' + String(deadline);
      }
      script += '. Is that right?';
      return script;
    }

    // recurring (default)
    var annualPays  = isMonthly ? paysNow * 12 : paysNow;
    var annualQuote = isMonthly ? quote   * 12 : quote;
    var increase = annualQuote - annualPays;
    var monthly  = Math.round(increase / 12);
    var script = "So that's an extra " + fmtK(increase) + ' a year, about ' + fmtK(monthly) + ' a month';
    if (canAbsorb != null) {
      script += ', and you can only absorb ' + fmtK(canAbsorb) + ' of it';
    }
    script += '. Is that right?';
    return script;
  }

  // L17: Build readback in prospect's words, ending "Did I get that right?"
  function buildReadbackScript(notes) {
    var n = notes || {};
    var lines = [];
    if (n.pain && n.pain.value) {
      lines.push('The challenge is ' + n.pain.value + '.');
    }
    var filled = (n.needs || []).filter(function(nd) { return nd.value; });
    if (filled.length) {
      var topIdx = 0;
      var tv = n.topNeed && n.topNeed.value;
      if (tv && !isNaN(Number(tv))) {
        var tIdx = parseInt(tv, 10) - 1;
        if (tIdx >= 0 && tIdx < filled.length) topIdx = tIdx;
      }
      var topText = filled[topIdx].value;
      if (filled.length === 1) {
        lines.push('What you need most is ' + topText + '.');
      } else {
        var others = filled.filter(function(_, i) { return i !== topIdx; }).map(function(nd) { return nd.value; });
        lines.push('Your top priority is ' + topText + '; you also need ' + others.join(' and ') + '.');
      }
    }
    if (!lines.length) return 'Let me play back what I have so far. Did I get that right?';
    return lines.join(' ') + ' Did I get that right?';
  }

  // L31: Detect soft-close phrases; returns matched phrase or null.
  function detectSoftClose(text) {
    var lower = String(text).toLowerCase();
    var SOFT_CLOSES = ['would you consider it', 'something you could consider', 'would it be fair to say'];
    for (var i = 0; i < SOFT_CLOSES.length; i++) {
      if (lower.includes(SOFT_CLOSES[i])) return SOFT_CLOSES[i];
    }
    return null;
  }

  // L31: True if any Me line contains "You told me" + first 4 words of needText.
  function needIsPitched(meLineTexts, needText) {
    if (!needText) return false;
    var needWords = needText.toLowerCase().split(/\s+/).slice(0, 4).join(' ');
    for (var i = 0; i < meLineTexts.length; i++) {
      var lower = meLineTexts[i].toLowerCase();
      if (lower.includes('you told me') && lower.includes(needWords)) return true;
    }
    return false;
  }

  // Sequential script walker. Replaces score-based computeCoachNext for live guidance.
  // notes: full notes object; script: parsed script.json; callOrder: 'pain-first'|'sheet-order';
  // knowledgeData: knowledge.json; meTexts: string[] of Me's transcript lines; numbersDeclined: bool
  function computeScriptNext(notes, script, callOrder, knowledgeData, meTexts, numbersDeclined) {
    if (!script || !script.sections) return { mainQ: null };

    var n = notes || {};
    var stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are','be',
      'have','has','you','your','me','we','our','what','when','who','why','how','do','did','does','at','on',
      'by','this','but','if','as','so','not','can','with','from','up','about','very','just','also','will',
      'would','could','there','their']);

    function keyWords(text) {
      return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(function(w) {
        return w.length > 2 && !stopwords.has(w);
      }));
    }

    function alreadyAsked(q) {
      var qw = keyWords(q);
      if (qw.size === 0) return false;
      return (meTexts || []).some(function(t) {
        var tw = keyWords(t);
        var overlap = Array.from(qw).filter(function(w) { return tw.has(w); }).length;
        return overlap / qw.size >= 0.5;
      });
    }

    // Resolve a field path (dotted) to its value in notes
    function fieldVal(fieldPath) {
      if (fieldPath === 'needs') {
        return (n.needs || []).some(function(nd) { return nd.value; });
      }
      if (fieldPath === 'quoteType') {
        var qt = n.quoteType && n.quoteType.value;
        return (qt === 'recurring' || qt === 'oneoff') ? qt : null;
      }
      var parts = fieldPath.split('.');
      var obj = n;
      for (var i = 0; i < parts.length; i++) {
        if (obj == null) return null;
        obj = obj[parts[i]];
      }
      if (obj && typeof obj === 'object' && 'value' in obj) {
        return obj.value !== null && obj.value !== undefined && obj.value !== '' ? obj.value : null;
      }
      return obj || null;
    }

    function stepDone(step) {
      if (step.oneShot) return step.q ? alreadyAsked(step.q) : false;
      if (!step.fields || step.fields.length === 0) return false;
      var vals = step.fields.map(function(f) { return !!fieldVal(f); });
      return step.anyField ? vals.some(Boolean) : vals.every(Boolean);
    }

    function requiresMet(step) {
      if (!step.requires || !step.requires.length) return true;
      return step.requires.every(function(f) { return !!fieldVal(f); });
    }

    function fillPlaceholders(q) {
      if (!q) return q;
      function trunc3(s) { return String(s).split(/\s+/).slice(0, 3).join(' '); }
      var painVal  = (n.pain    && n.pain.value)    || 'your situation';
      var causeVal = (n.cause   && n.cause.value)   || 'that';
      var dateVal  = (n.deadline && n.deadline.value) || 'your deadline';
      return q
        .replace(/\[pain\]/g,     trunc3(painVal))
        .replace(/\[cause\]/g,    trunc3(causeVal))
        .replace(/\[her date\]/g, dateVal);
    }

    // Section ordering
    var sectionIds = script.sections.map(function(s) { return s.id; });
    var orderedIds;
    if (callOrder === 'pain-first') {
      var painFirst = ['PAIN', 'SITUATION', 'NUMBER', 'CAUSE', 'IMPACT', 'OUTCOME'];
      orderedIds = painFirst.filter(function(id) { return sectionIds.indexOf(id) >= 0; });
      sectionIds.forEach(function(id) { if (orderedIds.indexOf(id) < 0) orderedIds.push(id); });
    } else {
      orderedIds = sectionIds;
    }

    for (var si = 0; si < orderedIds.length; si++) {
      var section = script.sections.find(function(s) { return s.id === orderedIds[si]; });
      if (!section) continue;
      var steps = section.steps || [];

      for (var i = 0; i < steps.length; i++) {
        var step = steps[i];
        if (stepDone(step)) continue;
        if (!requiresMet(step)) continue;

        // Targeted questions need pain type + knowledge lookup
        var q = step.q;
        if (step.targeted) {
          if (!knowledgeData || !n.painType || !n.painType.value) continue;
          var lk = (knowledgeData.lookup || []).find(function(l) { return l.painType === n.painType.value; });
          if (!lk || !lk[step.targeted]) continue;
          q = lk[step.targeted];
        }

        if (!q) continue;

        return {
          mainQ:         fillPlaceholders(q),
          stepId:        step.id,
          stepLabel:     step.label || '',
          stepIndex:     i,
          totalSteps:    steps.length,
          sectionId:     section.id,
          sectionLabel:  section.label,
          minutesStart:  section.minutesStart,
          minutesEnd:    section.minutesEnd,
        };
      }
    }

    return { mainQ: null };
  }

  // Returns the first unasked gate step (C1, C3, I1, O1-O3), or null if all covered.
  // meTexts: string[] of Me's transcript lines (for alreadyAsked detection).
  function computePitchGate(notes, script, meTexts) {
    if (!script || !script.sections) return null;
    var GATE_IDS = ['C1', 'C3', 'I1', 'O1', 'O2', 'O3'];
    var n = notes || {};
    var stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are',
      'be','have','has','you','your','me','we','our','what','when','who','why','how','do','did','does',
      'at','on','by','this','but','if','as','so','not','can','with','from','up','about','very','just',
      'also','will','would','could','there','their']);
    function kw(t) {
      return new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(function(w) {
        return w.length > 2 && !stopwords.has(w);
      }));
    }
    function alreadyAsked(q) {
      var qw = kw(q);
      if (qw.size === 0) return false;
      return (meTexts || []).some(function(t) {
        var tw = kw(t);
        var overlap = Array.from(qw).filter(function(w) { return tw.has(w); }).length;
        return overlap / qw.size >= 0.5;
      });
    }
    function fieldVal(fieldPath) {
      if (fieldPath === 'needs') return (n.needs || []).some(function(nd) { return nd.value; });
      var parts = fieldPath.split('.');
      var obj = n;
      for (var i = 0; i < parts.length; i++) { if (obj == null) return null; obj = obj[parts[i]]; }
      if (obj && typeof obj === 'object' && 'value' in obj) {
        return obj.value !== null && obj.value !== undefined && obj.value !== '' ? obj.value : null;
      }
      return obj || null;
    }
    for (var si = 0; si < script.sections.length; si++) {
      var section = script.sections[si];
      for (var i = 0; i < (section.steps || []).length; i++) {
        var step = section.steps[i];
        if (GATE_IDS.indexOf(step.id) < 0) continue;
        if (!step.q) continue;
        if (step.fields && step.fields.length > 0) {
          var vals = step.fields.map(function(f) { return !!fieldVal(f); });
          var done = step.anyField ? vals.some(Boolean) : vals.every(Boolean);
          if (done) continue;
        }
        if (alreadyAsked(step.q)) continue;
        return { stepId: step.id, q: step.q, sectionLabel: section.label };
      }
    }
    return null;
  }

  // Returns the most recent unanswered Her question, or null.
  // "Unanswered" = Her asked a "?" line, Me spoke at least twice after it,
  // and NONE of Me's next 2 utterances has ≥50% keyword overlap with her question.
  function detectUnansweredQuestion(transcript) {
    var tx = transcript || [];
    if (tx.length < 4) return null;
    var stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are',
      'be','have','has','you','your','me','we','our','what','when','who','why','how','do','did','does',
      'at','on','by','this','but','if','as','so','not','can','with','from','up','about','very','just',
      'also','will','would','could','there','their','its','got','get']);
    function kw(t) {
      return new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(function(w) {
        return w.length > 3 && !stopwords.has(w);
      }));
    }
    // Scan from most-recent Her "?" backwards
    for (var i = tx.length - 1; i >= 0; i--) {
      var u = tx[i];
      if (u.speaker !== 'Her' || u.text.indexOf('?') < 0) continue;
      // Collect Me's next 2 responses after this question
      var meAfter = [];
      for (var j = i + 1; j < tx.length && meAfter.length < 2; j++) {
        if (tx[j].speaker === 'Me') meAfter.push(tx[j].text);
      }
      if (meAfter.length < 2) return null; // Not enough Me responses yet
      // Check keyword overlap
      var qw = kw(u.text);
      if (qw.size === 0) return null;
      var answered = meAfter.some(function(t) {
        var tw = kw(t);
        var overlap = Array.from(qw).filter(function(w) { return tw.has(w); }).length;
        return overlap / qw.size >= 0.5;
      });
      if (!answered) return { question: u.text, ts: u.ts || '0:00' };
      return null; // Most recent Her question WAS answered
    }
    return null;
  }

  // ── Objection engine (Phase 1) ────────────────────────────────────────────

  var OBJ_MARKERS = ['worried', 'concern', 'not sure', 'what if', "can't", 'problem with', 'issue with', 'unsure', 'nervous'];

  // Returns true if text carries an objection-marker word.
  // Does NOT require a library match — used for unknown-fallback detection.
  function hasObjMarkers(text) {
    var lower = String(text).toLowerCase();
    // "but" only counts when mid-sentence, not as a standalone filler
    if (/\bbut\b/.test(lower) && lower.split(/\s+/).length > 4) return true;
    return OBJ_MARKERS.some(function(m) { return lower.includes(m); });
  }

  // Pure: given a Her line and the objections library array, returns matching library entries.
  // triggers can be plain strings (substring match) or '/pattern/flags' regex strings.
  function detectObjection(text, objectionLibrary) {
    if (!text || !objectionLibrary || !objectionLibrary.length) return [];
    var lower = String(text).toLowerCase();
    var results = [];
    for (var i = 0; i < objectionLibrary.length; i++) {
      var entry = objectionLibrary[i];
      var triggers = entry.triggers || [];
      var matched = false;
      for (var j = 0; j < triggers.length; j++) {
        var trig = triggers[j];
        if (typeof trig === 'string' && trig.length > 2 && trig[0] === '/' && trig.lastIndexOf('/') > 0) {
          var lastSlash = trig.lastIndexOf('/');
          var pattern = trig.slice(1, lastSlash);
          var flags = trig.slice(lastSlash + 1) || 'i';
          try { if (new RegExp(pattern, flags).test(lower)) { matched = true; break; } } catch(e) {}
        } else {
          if (lower.includes(String(trig).toLowerCase())) { matched = true; break; }
        }
      }
      if (matched) results.push(entry);
    }
    return results;
  }

  // Fills placeholders in an objection entry and returns a ready-to-render card.
  // herWords: her verbatim quote (used for [her words]); notes: full notes object.
  function buildObjectionCard(objEntry, herWords, notes) {
    if (!objEntry) return null;
    var n = notes || {};
    var dateVal = (n.deadline && n.deadline.value) ||
                  (n.renewalDate && n.renewalDate.value) || 'your deadline';
    var herExcerpt = herWords
      ? '"' + String(herWords).split(/\s+/).slice(0, 6).join(' ') + '…"'
      : '';

    function fill(text) {
      if (!text) return '';
      return String(text)
        .replace(/\[her words\]/g, herExcerpt)
        .replace(/\[her date\]/g, dateVal)
        .replace(/\[day\]/g, 'Thursday');
    }

    return {
      id:         objEntry.id,
      label:      (objEntry.id || 'unknown').toUpperCase().replace(/-/g, ' '),
      answer:     fill(objEntry.answer),
      ask:        fill(objEntry.ask),
      bridge:     fill(objEntry.bridge),
      check:      fill(objEntry.check || 'Does that cover it?'),
      never:      objEntry.never || '',
      ifRepeated: objEntry.ifRepeated || '',
      bridgeTo:   objEntry.bridgeTo || null,
    };
  }

  // Returns true if meText has ≥50% keyword overlap with the card's ask OR bridge.
  // Used for auto-handling: Me addressed the objection without pressing Handled.
  function isObjHandledByMe(meText, card) {
    if (!meText || !card) return false;
    var stopwords = new Set(['a','an','the','to','of','and','or','in','for','that','it','i','is','are',
      'be','have','has','you','your','me','we','our','what','when','who','why','how','do','did','does',
      'at','on','by','this','but','if','as','so','not','can','with','from','up','about','very','just',
      'also','will','would','could','there','their']);
    function kw(t) {
      return new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(function(w) {
        return w.length > 2 && !stopwords.has(w);
      }));
    }
    var mw = kw(meText);
    var targets = [card.ask, card.bridge].filter(Boolean);
    for (var ti = 0; ti < targets.length; ti++) {
      var tw = kw(targets[ti]);
      if (tw.size === 0) continue;
      var overlap = Array.from(tw).filter(function(w) { return mw.has(w); }).length;
      if (overlap / tw.size >= 0.5) return true;
    }
    return false;
  }

  // Opening phase ends when ANY of these is true:
  // 1. Call time >= 2:30
  // 2. Any discovery field has a value
  // 3. Next step agreed (both who and dateTime filled)
  // 4. Her has spoken 2+ times after Me's first non-opening discovery question
  function shouldExitOpeningPhase(transcript, notes) {
    var tx = transcript || [];
    var last = tx[tx.length - 1];
    var callSec = last ? tsToSec(last.ts) : 0;

    if (callSec >= 150) return true;

    var n = notes || {};
    var sit = n.situation || {};
    var nums = n.numbers || {};
    var ns = n.nextStep || {};
    if ((n.pain && n.pain.value != null) ||
        (sit.hosts && sit.hosts.value != null) ||
        (sit.vms && sit.vms.value != null) ||
        (sit.storageTB && sit.storageTB.value != null) ||
        (nums.paysNow && nums.paysNow.value != null)) return true;

    if ((ns.who && ns.who.value) && (ns.dateTime && ns.dateTime.value)) return true;

    for (var i = 0; i < tx.length; i++) {
      var u = tx[i];
      if (u.speaker !== 'Me' || u.text.indexOf('?') < 0) continue;
      if (hasRoE([u])) continue;
      var low = u.text.toLowerCase();
      if (low.indexOf("what i'd love") >= 0 || low.indexOf("understand your estate") >= 0 ||
          low.indexOf("is that okay") >= 0 || low.indexOf("my name is") >= 0 ||
          low.indexOf("introduce myself") >= 0 || low.indexOf("does that work for you") >= 0) continue;
      var herAfter = 0;
      for (var j = i + 1; j < tx.length; j++) {
        if (tx[j].speaker === 'Her') herAfter++;
      }
      if (herAfter >= 2) return true;
      break;
    }

    return false;
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
    shouldExitOpeningPhase: shouldExitOpeningPhase,
    detectNutanixIntro: detectNutanixIntro,
    computePitchGaps: computePitchGaps,
    computePitchAlert: computePitchAlert,
    shouldShowPausePrompt: shouldShowPausePrompt,
    RED_FLAG_RULES: RED_FLAG_RULES,
    detectRedFlags: detectRedFlags,
    detectQuoteType: detectQuoteType,
    buildCOIWorkings: buildCOIWorkings,
    buildCostOfInactionScript: buildCostOfInactionScript,
    coiMatchesSpeech: coiMatchesSpeech,
    parseMoneyWords: parseMoneyWords,
    computePitchGate: computePitchGate,
    buildReadbackScript: buildReadbackScript,
    detectSoftClose: detectSoftClose,
    needIsPitched: needIsPitched,
    computeScriptNext: computeScriptNext,
    detectUnansweredQuestion: detectUnansweredQuestion,
    OBJ_MARKERS: OBJ_MARKERS,
    hasObjMarkers: hasObjMarkers,
    detectObjection: detectObjection,
    buildObjectionCard: buildObjectionCard,
    isObjHandledByMe: isObjHandledByMe,
  };
}));
