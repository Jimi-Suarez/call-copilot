'use strict';
// UMD: works in browser (SummaryLogic global) and Node (require)
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.SummaryLogic = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ── Completeness rules ──────────────────────────────────────────────────────
  function computeCompleteness(n) {
    const fi = function(arr) { return arr.filter(Boolean).length; };
    return {
      situation: !!(n.situation.hosts.value || n.situation.vms.value || n.situation.workloads.value),
      pain:      !!(n.pain.value && n.whatItAffects.value),
      numbers:   !!(n.numbers.paysNow.value && n.numbers.quote.value && n.numbers.canAbsorb.value != null),
      cause:     !!(n.cause.value && (n.otherDrivers.value || n.whyProblem.value)),
      impact:    !!(fi([n.impactOnOthers.value, n.doingNothing.value]) >= 1 && n.personalStake.value && n.signOff.value),
      needs:     !!(n.needs.filter(function(nd) { return nd.value; }).length >= 1 && n.topNeed.value),
    };
  }

  // ── On-demand summary text ──────────────────────────────────────────────────
  // Returns { text: string, complete: bool }
  // text always ends with "Did I get that right?" and lists "Not yet heard: ..." for gaps.
  function computeSummaryText(section, n) {
    var missing = [];
    var text    = '';

    switch (section) {
      case 'situation': {
        var parts = [];
        if (n.situation.hosts.value)     parts.push(n.situation.hosts.value + ' hosts');
        else                             missing.push('hosts');
        if (n.situation.vms.value)       parts.push(n.situation.vms.value + ' VMs');
        else                             missing.push('VMs');
        if (n.situation.storageTB.value) parts.push(n.situation.storageTB.value + ' storage');
        if (n.situation.teamSize.value)  parts.push('team of ' + n.situation.teamSize.value);
        if (n.situation.workloads.value) parts.push('running ' + n.situation.workloads.value);
        text = parts.length ? 'So you have ' + parts.join(', ') + '.' : '';
        break;
      }
      case 'pain': {
        if (n.pain.value)          text += n.pain.value + '.';
        else                       missing.push('the pain');
        if (n.whatItAffects.value) text += (text ? " It's affecting " : "It's affecting ") + n.whatItAffects.value + '.';
        else                       missing.push('what it affects');
        break;
      }
      case 'numbers': {
        var pn = n.numbers.paysNow.value, qv = n.numbers.quote.value, ca = n.numbers.canAbsorb.value;
        if (pn != null && qv != null && ca != null) {
          var dl = n.deadline ? n.deadline.value : null;
          var rd = n.renewalDate ? n.renewalDate.value : null;
          text = 'The quote is ' + qv + ' against ' + pn + ' now. Absorb: ' + ca + '.' +
                 (dl ? ' Deadline: ' + dl + '.' : '') + (rd ? ' Renewal: ' + rd + '.' : '');
        } else {
          var parts2 = [];
          if (pn != null) parts2.push('paying ' + pn);
          else            missing.push('pays now');
          if (qv != null) parts2.push('quote ' + qv);
          else            missing.push('quote');
          if (ca != null) parts2.push('absorb ' + ca);
          else            missing.push('absorb figure');
          if (parts2.length) text = 'So far: ' + parts2.join(', ') + '.';
        }
        break;
      }
      case 'cause': {
        if (n.cause.value)           text += 'It hits hard because ' + n.cause.value + '.';
        else                         missing.push('cause');
        if (n.otherDrivers.value)    text += ' Right now it matters because ' + n.otherDrivers.value + '.';
        else if (n.whyProblem.value) text += ' ' + n.whyProblem.value + '.';
        else                         missing.push('other drivers');
        break;
      }
      case 'impact': {
        var ripple = n.impactOnOthers.value || n.doingNothing.value;
        if (n.pain.value && n.cause.value) text += n.pain.value + '. Because ' + n.cause.value + '. ';
        else if (n.pain.value)             text += n.pain.value + '. ';
        if (ripple)              text += 'Ripple: ' + ripple + '.';
        else                     missing.push('ripple effect');
        if (n.personalStake.value) text += ' For you personally, ' + n.personalStake.value + '.';
        else                     missing.push('personal stake');
        if (n.signOff.value)     text += ' ' + n.signOff.value + ' would need to sign off.';
        else                     missing.push('who signs off');
        break;
      }
      case 'needs': {
        var filled = n.needs.filter(function(nd) { return nd.value; });
        if (filled.length === 0) { missing.push('what she needs'); break; }
        text = 'You need: ' + filled.map(function(nd) { return nd.value; }).join('; ') + '.';
        if (n.topNeed.value) {
          var topIdx = 0;
          var tv = n.topNeed.value;
          if (tv && !isNaN(tv)) { var idx = parseInt(tv) - 1; if (idx >= 0 && idx < filled.length) topIdx = idx; }
          text += ' Most important: ' + (filled[topIdx] ? filled[topIdx].value : '') + '.';
        } else {
          missing.push('top need choice');
        }
        break;
      }
    }

    var missingStr = missing.length ? ' Not yet heard: ' + missing.join(', ') + '.' : '';
    var full = (text + missingStr).trim();
    return {
      text: full ? full + ' Did I get that right?' : 'Nothing captured yet for this section.',
      complete: missing.length === 0,
    };
  }

  return { computeCompleteness: computeCompleteness, computeSummaryText: computeSummaryText };
}));
