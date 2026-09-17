(function () {
'use strict';
var D = window.SigvaraDemo, P = D.PARAMS;
var sim = new D.Simulator(window.nacl);
var $ = function (id) { return document.getElementById(id); };
var WEI = 10n ** 18n;
var challenge = null, signature = null;
var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
var short = function (h) { return h.length > 18 ? h.slice(0, 10) + '…' + h.slice(-6) : h; };
var fmtTs = function (t) { return new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; };

// ---------------------------------------------------------- rendering --
function renderCard() {
  var a = sim.agent;
  $('cardLabel').textContent = a ? 'Agent ' + a.address.slice(2, 8) : 'No agent yet';
  $('cardDid').textContent = a ? a.did : 'did:sigvara:' + P.chainId + ':…';
  $('cardDid').title = a ? a.did : '';
  var st = a ? a.status : 'None';
  $('cardStatus').dataset.s = st;
  $('cardStatusText').textContent = a ? st : 'unregistered';
  var total = sim.getTotalScore();
  $('cardScore').textContent = total;
  if (sim.pendingScore) { $('cardScoreLabel').textContent = 'proposed ' + sim.pendingScore.total; $('cardScoreNote').textContent = 'challenge window open'; }
  else if (sim.score) { $('cardScoreLabel').textContent = st === 'Slashed' ? 'zeroed by slash' : 'finalized'; $('cardScoreNote').textContent = 'as of ' + fmtTs(sim.score.lastUpdated); }
  else { $('cardScoreLabel').textContent = 'no score yet'; $('cardScoreNote').textContent = 'runs after the first epoch'; }
  var f = sim.score ? sim.score.factors : null;
  $('cardBars').innerHTML = P.factors.map(function (x) {
    var v = f ? f[x.key] : 0;
    return '<div class="bar-line"><span>' + x.label + '</span><div class="bar-track"><div class="bar-fill" data-w="' + (v / x.max * 100) + '"></div></div><b>' + v + '/' + x.max + '</b></div>';
  }).join('');
  // Widths go through the CSSOM rather than a style attribute so the CSP stays free of 'unsafe-inline'.
  $('cardBars').querySelectorAll('.bar-fill').forEach(function (el) { el.style.width = el.dataset.w + '%'; });
  $('cardStake').textContent = D.fmtToken(sim.stake) + ' SVR';
  $('cardBonded').textContent = a ? (sim.hasMinimumStake() ? 'yes' : 'no, below minimum') : 'no';
  $('cardQueued').textContent = sim.pendingWithdrawal ? D.fmtToken(sim.pendingWithdrawal.amount) + ' SVR, claim ' + fmtTs(sim.pendingWithdrawal.claimableAt) : 'none';
  $('cardBalance').textContent = D.fmtToken(sim.balances[sim.operator]) + ' SVR';
  $('cardBurned').textContent = D.fmtToken(sim.burned) + ' SVR';
  $('clock').textContent = fmtTs(sim.now);
}
var seen = 0;
function renderLog() {
  var list = $('log');
  if (sim.events.length === 0) { list.innerHTML = '<li class="log-empty">Nothing yet. Start with step 01.</li>'; seen = 0; return; }
  if (seen === 0) list.innerHTML = '';
  for (; seen < sim.events.length; seen++) {
    var e = sim.events[seen];
    var args = Object.keys(e.args).map(function (k) {
      var v = e.args[k];
      if (typeof v === 'bigint') v = D.fmtToken(v) + ' SVR';
      else if (typeof v === 'string' && /^0x[0-9a-f]{40,}$/i.test(v)) v = short(v);
      else if (typeof v === 'number' && v > 1e9) v = fmtTs(v);
      return k + '=' + v;
    }).join(' ');
    var li = document.createElement('li');
    li.innerHTML = '<span class="ev">' + esc(e.name) + '</span> <span class="args">' + esc(args) + '</span><span class="meta">block ' + e.block + ' · ' + fmtTs(e.at) + (e.note ? ' · ' + esc(e.note) : '') + '</span>';
    list.prepend(li);
  }
}
function logError(msg) {
  var li = document.createElement('li');
  li.innerHTML = '<span class="err">revert</span> <span class="args">' + esc(msg) + '</span>';
  if ($('log').querySelector('.log-empty')) $('log').innerHTML = '';
  $('log').prepend(li);
}
function out(id, html) { $(id).innerHTML = html; }
function line(k, v, cls) { return '<span class="k">' + esc(k) + '</span> ' + (cls ? '<span class="' + cls + '">' : '') + esc(v) + (cls ? '</span>' : '') + '\n'; }
function refresh() { renderCard(); renderLog(); }
function setStep(n, state) {
  var el = document.querySelector('.step[data-step="' + n + '"]');
  el.dataset.state = state;
  el.querySelector('.step-state').textContent = state === 'done' ? 'Done' : state === 'active' ? 'Ready' : 'Locked';
  el.querySelector('.step-head').setAttribute('aria-expanded', state === 'locked' ? 'false' : 'true');
  if (state !== 'locked') el.dataset.collapsed = '0';
}
function unlock(n) { var el = document.querySelector('.step[data-step="' + n + '"]'); if (el.dataset.state === 'locked') setStep(n, 'active'); }
function attempt(fn, outId) {
  try { fn(); } catch (e) { logError(e.message); if (outId) out(outId, line('error', e.message, 'bad')); }
  refresh();
}
document.querySelectorAll('.step-head').forEach(function (h) {
  var toggle = function () { var s = h.parentElement; if (s.dataset.state === 'locked') return; s.dataset.collapsed = s.dataset.collapsed === '1' ? '0' : '1'; h.setAttribute('aria-expanded', s.dataset.collapsed === '1' ? 'false' : 'true'); };
  h.addEventListener('click', toggle);
  h.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
});

// --------------------------------------------------------------- 01 --
$('btnRegister').addEventListener('click', function () {
  attempt(function () {
    var a = sim.registerAgent();
    out('outRegister',
      line('operator', sim.operator) + line('agentAddress', a.address) + line('ed25519 pubkey (bytes32)', a.pubKeyBytes32) +
      line('multibase key', a.multibase) + line('did', a.did) + line('didHash', a.didHash) +
      line('status', 'Active', 'ok') + line('note', 'didHash = keccak256("did:sigvara:" ‖ uint256(' + P.chainId + ') ‖ ":" ‖ address). Same bytes the contract hashes.'));
    setStep(1, 'done'); unlock(2);
    $('btnRegister').disabled = true;
  }, 'outRegister');
});

// --------------------------------------------------------------- 02 --
function amountWei() { var v = BigInt(Math.max(0, Math.floor(Number($('stakeAmount').value) || 0))); return v * WEI; }
$('btnApprove').addEventListener('click', function () {
  attempt(function () { sim.approve(amountWei()); out('outStake', line('approve', D.fmtToken(amountWei()) + ' SVR for SigvaraStaking', 'ok') + line('next', 'deposit the same amount')); }, 'outStake');
});
$('btnDeposit').addEventListener('click', function () {
  attempt(function () {
    sim.depositStake(amountWei());
    var ok = sim.hasMinimumStake();
    out('outStake', line('stake', D.fmtToken(sim.stake) + ' SVR') + line('hasMinimumStake', ok ? 'true' : 'false (minimum is ' + D.fmtToken(P.minimumStake) + ' SVR)', ok ? 'ok' : 'warn') + line('unbondingPeriod', '21 days on any withdrawal'));
    if (ok) { setStep(2, 'done'); unlock(3); unlock(4); unlock(5); }
  }, 'outStake');
});
$('btnWithdraw').addEventListener('click', function () {
  attempt(function () { sim.initiateWithdrawal(amountWei()); out('outStake', line('queued', D.fmtToken(amountWei()) + ' SVR', 'warn') + line('claimable', fmtTs(sim.pendingWithdrawal.claimableAt)) + line('note', 'still slashable until claimed')); }, 'outStake');
});

// --------------------------------------------------------------- 03 --
var sliders = { inFees: 'vFees', inAtt: 'vAtt', inSucc: 'vSucc', inDays: 'vDays', inExt: 'vExt', inFlags: 'vFlags', inProp: 'vProp' };
Object.keys(sliders).forEach(function (id) { $(id).addEventListener('input', function () { if (id === 'inSucc' && Number($('inSucc').value) > Number($('inAtt').value)) $('inSucc').value = $('inAtt').value; if (id === 'inAtt' && Number($('inSucc').value) > Number($('inAtt').value)) { $('inSucc').value = $('inAtt').value; $('vSucc').textContent = $('inAtt').value; } $(sliders[id]).textContent = $(id).value; }); });
function inputs() { return { feesUsd: +$('inFees').value, attestations: +$('inAtt').value, successes: +$('inSucc').value, days: +$('inDays').value, external: +$('inExt').value, flags: +$('inFlags').value, propagation: +$('inProp').value }; }
function factorLines(f) { return P.factors.map(function (x) { return line(x.label, f[x.key] + ' / ' + x.max); }).join(''); }
$('btnPropose').addEventListener('click', function () {
  attempt(function () { var p = sim.proposeReputation(inputs()); out('outScore', factorLines(p.factors) + line('proposed total', p.total, 'ok') + line('finalizable after', fmtTs(p.finalizeAt)) + line('note', 'committee can reject during the 6h window')); }, 'outScore');
});
$('btnAdvance6h').addEventListener('click', function () { attempt(function () { sim.advance(P.scoreChallengeWindow); }); });
$('btnFinalize').addEventListener('click', function () {
  attempt(function () { var s = sim.finalizeReputation(); out('outScore', factorLines(s.factors) + line('finalized total', s.total, 'ok') + line('meetsThreshold(40)', sim.meetsThreshold(40) ? 'true' : 'false')); setStep(3, 'done'); unlock(6); }, 'outScore');
});
$('btnReject').addEventListener('click', function () { attempt(function () { sim.rejectReputation(); out('outScore', line('rejected', 'proposal discarded, last finalized score stands', 'warn')); }, 'outScore'); });

// --------------------------------------------------------------- 04 --
$('btnChallenge').addEventListener('click', function () {
  attempt(function () { challenge = sim.issueChallenge(); signature = null; out('outVerify', line('payload', challenge.payload) + line('expires', fmtTs(challenge.expiresAt)) + line('next', 'the agent signs this exact string')); }, 'outVerify');
});
$('btnSign').addEventListener('click', function () {
  attempt(function () { if (!challenge) throw new Error('issue a challenge first'); signature = sim.signChallenge(challenge.payload); out('outVerify', line('payload', challenge.payload) + line('signature (base58)', signature) + line('next', 'verifier checks it against the registry key')); }, 'outVerify');
});
function verifyWith(sigBytes, label) {
  if (!challenge || !signature) throw new Error('issue and sign a challenge first');
  var r = sim.verifySignature(challenge.payload, sigBytes);
  var t = +$('inThreshold').value, score = sim.getTotalScore(), meets = sim.meetsThreshold(t);
  var decision = r.ok && meets && sim.agent.status === 'Active';
  out('outVerify', line(label, r.ok ? 'valid' : 'invalid', r.ok ? 'ok' : 'bad') + line('reason', r.reason) + line('status', sim.agent.status) + line('score', score + ' vs threshold ' + t + ' → ' + (meets ? 'meets' : 'below'), meets ? 'ok' : 'warn') + line('decision', decision ? 'route the task' : 'refuse', decision ? 'ok' : 'bad'));
  if (decision) { setStep(4, 'done'); unlock(6); }
}
$('btnVerify').addEventListener('click', function () { attempt(function () { verifyWith(b58decode(signature), 'signature'); }, 'outVerify'); });
$('btnTamper').addEventListener('click', function () { attempt(function () { var b = b58decode(signature); b[0] ^= 1; verifyWith(b, 'tampered signature'); }, 'outVerify'); });
function b58decode(s) {
  var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', bytes = [0];
  for (var i = 0; i < s.length; i++) { var c = A.indexOf(s[i]); if (c < 0) throw new Error('bad base58'); for (var j = 0; j < bytes.length; j++) { c += bytes[j] * 58; bytes[j] = c & 0xff; c >>= 8; } while (c > 0) { bytes.push(c & 0xff); c >>= 8; } }
  for (var k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

// --------------------------------------------------------------- 05 --
var VICTIM = '0x' + D.bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
$('btnInitiateSlash').addEventListener('click', function () {
  attempt(function () { sim.initiateSlash(VICTIM); out('outSlash', line('status', 'Suspended', 'warn') + line('victim', VICTIM) + line('reporter (committee member)', sim.committee) + line('challenge window closes', fmtTs(sim.slash.deadline)) + line('note', 'stake and queued withdrawals are frozen; a consumer query now sees Suspended')); }, 'outSlash');
});
$('btnDispute').addEventListener('click', function () { attempt(function () { sim.disputeSlash(); out('outSlash', line('disputed', 'proposal cancelled, agent reinstated to Active', 'ok') + line('note', 'the committee may re-file with stronger evidence; until then nothing can be executed')); }, 'outSlash'); });
$('btnAdvance7d').addEventListener('click', function () { attempt(function () { sim.advance(P.challengePeriod + 1); }); });
$('btnExecuteSlash').addEventListener('click', function () {
  attempt(function () { var r = sim.executeSlash(); out('outSlash', line('burned (50%)', D.fmtToken(r.burned) + ' SVR → 0xdead', 'bad') + line('to victim (25%)', D.fmtToken(r.toVictim) + ' SVR') + line('to reporter (25%)', D.fmtToken(r.toReporter) + ' SVR') + line('status', 'Slashed, terminal', 'bad') + line('reputation', 'zeroed')); setStep(5, 'done'); unlock(6); }, 'outSlash');
});

// --------------------------------------------------------------- 06 --
$('btnRead').addEventListener('click', function () {
  attempt(function () {
    sim.requireAgent();
    var a = sim.agent, t = +$('inThreshold').value;
    out('outRead', line('getIdentity(didHash).status', a.status, a.status === 'Active' ? 'ok' : 'bad') + line('isActive', a.status === 'Active' ? 'true' : 'false') + line('hasMinimumStake', sim.hasMinimumStake() ? 'true' : 'false') + line('getTotalScore', sim.getTotalScore()) + line('meetsThreshold(' + t + ')', sim.meetsThreshold(t) ? 'true' : 'false', sim.meetsThreshold(t) ? 'ok' : 'warn') + line('verdict', a.status === 'Active' && sim.hasMinimumStake() && sim.meetsThreshold(t) ? 'trust this agent for tasks at this threshold' : 'do not route to this agent', a.status === 'Active' && sim.hasMinimumStake() && sim.meetsThreshold(t) ? 'ok' : 'bad'));
    setStep(6, 'done');
  }, 'outRead');
});
$('btnReset').addEventListener('click', function () {
  sim.reset(); challenge = null; signature = null; seen = 0;
  ['outRegister', 'outStake', 'outScore', 'outVerify', 'outSlash', 'outRead'].forEach(function (id) { out(id, ''); });
  [2, 3, 4, 5, 6].forEach(function (n) { setStep(n, 'locked'); });
  setStep(1, 'active'); $('btnRegister').disabled = false;
  refresh();
  document.querySelector('.step[data-step="1"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('btnClearLog').addEventListener('click', function () { sim.events = []; seen = 0; renderLog(); });

refresh();
})();
