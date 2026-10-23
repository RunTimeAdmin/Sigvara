/* Sigvara interactive demo engine.
 *
 * Everything runs in the browser. Keys and signatures are real Ed25519
 * (tweetnacl). The chain is simulated. The staking and slash rules below follow the
 * contracts on main. Scoring and registration are simplified: score maturity, the
 * per-payer fee cap and the PendingBond step are not modelled.
 *   - DID and didHash derivation (SigvaraIdentity)
 *   - minimum stake, unbonding, slash lifecycle and split (SigvaraStaking, as on
 *     main): a dispute freezes the bond and hands the proposal to the admin, whose
 *     ruling either slashes (never before the 7-day deadline) or reinstates at once;
 *     an unruled dispute can be expired by anyone after 14 days. Undisputed
 *     execution is permissionless strictly after the 7-day window and stays open
 *     until someone expires the proposal, which anyone can do from 14 days after its
 *     deadline. The admin can veto a pending or disputed proposal, a committee member
 *     can cancel a pending one, and after any dropped proposal the committee waits one
 *     challenge period before filing again. Reporter = the committee member who filed,
 *     and victim/reporter shares are credited for them to claim, not pushed. The Arc
 *     testnet proxies still run the 21 September code, where the committee rules on a
 *     dispute, an upheld ruling takes effect at once, and there is no veto, no expiry
 *     of an unexecuted slash and no re-file cooldown.
 *   - six-factor score with per-factor maxima and the 6h score challenge
 *     window (SigvaraReputation + docs/reputation-model.md)
 *   - challenge/response with the v1 payload of packages/sdk challenge.ts (the
 *     current v2 format also binds an audience)
 */
(function (root) {
  'use strict';
  // ------------------------------------------------------------ shared DID --
  // keccak256 and the didHash derivation live in did.js so app.js can use them too,
  // rather than each page carrying its own keccak to drift apart. did.js must load first.
  var _did = (typeof module !== 'undefined' && module.exports)
    ? require('./did.js')
    : root.SigvaraDid;
  var keccak256 = _did.keccak256;
  var computeDidHash = _did.computeDidHash;
  var formatDid = _did.formatDid;
  var bytesToHex = _did.bytesToHex;
  var hexToBytes = _did.hexToBytes;
  var utf8 = _did.utf8;
  var concat = _did.concat;


  // ------------------------------------------------------------- encoding --
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Encode(bytes) {
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
    for (var d = digits.length - 1; d >= 0; d--) out += B58[digits[d]];
    return out;
  }
  function randomBytes(n) {
    var a = new Uint8Array(n);
    (root.crypto || require('crypto').webcrypto).getRandomValues(a);
    return a;
  }

  function pubKeyToMultibase(pk) { var p = new Uint8Array(34); p[0] = 0xed; p[1] = 0x01; p.set(pk, 2); return 'z' + base58Encode(p); }

  // ------------------------------------------------------ protocol params --
  // Deploy.s.sol defaults and the six factor maxima from SigvaraReputation.
  var PARAMS = {
    chainId: 5042002,
    chainName: 'Arc testnet',
    bondSymbol: 'SVR',
    bondNote: 'testnet faucet token',
    minimumStake: 1000n * 10n ** 18n,
    challengePeriod: 7 * 24 * 3600,
    scoreChallengeWindow: 6 * 3600,
    unbondingPeriod: 21 * 24 * 3600,
    disputeResolutionPeriod: 14 * 24 * 3600,
    executionPeriod: 14 * 24 * 3600,
    faucetGrant: 10000n * 10n ** 18n,
    factors: [
      { key: 'feeScore', label: 'Fee activity', max: 20 },
      { key: 'successScore', label: 'Success rate', max: 15 },
      { key: 'ageScore', label: 'Tenure', max: 30 },
      { key: 'externalScore', label: 'External trust', max: 25 },
      { key: 'communityScore', label: 'Community', max: 5 },
      { key: 'propagationScore', label: 'Trust propagation', max: 5 }
    ]
  };

  // docs/reputation-model.md formulas.
  // Mirrors oracle/scoring.js. Two details here are the whole point of the model and
  // were wrong in this demo while the live oracle had moved on.
  //
  // Success divides by (total + PRIOR), not by total. A bare ratio makes one lucky job
  // score the same as ninety-nine out of a hundred, and it is scale invariant, so
  // decaying both halves leaves it untouched and a farmed score sits forever.
  //
  // Tenure is the span of PAID work, not days since registration. Registering and
  // waiting was the cheapest twenty points an idle farm could collect, so an agent with
  // no attestations scores zero here however long it has existed.
  var SUCCESS_PRIOR = 5;

  function computeFactors(input) {
    var paid = input.attestations > 0;
    return {
      // One point per 100 of settled volume, capped at 20. The live oracle also decays
      // each payment and caps any single payer; this simulation does neither, so treat
      // it as the ceiling rather than the number a real agent would hold.
      feeScore: Math.min(20, Math.floor(input.feesUsd / 100)),
      successScore: paid
        ? Math.floor((input.successes / (input.attestations + SUCCESS_PRIOR)) * 15)
        : 0,
      ageScore: paid ? Math.min(30, Math.floor(Math.log2(input.days + 1) * 3)) : 0,
      externalScore: Math.floor((input.external / 100) * 25),
      communityScore: Math.max(0, 5 - input.flags * 2),
      propagationScore: Math.max(0, Math.min(5, input.propagation))
    };
  }
  function totalScore(f) { return PARAMS.factors.reduce(function (t, x) { return t + f[x.key]; }, 0); }

  // ------------------------------------------------------------ simulator --
  // A tiny state machine that mirrors the on-chain transitions and emits
  // receipt-style events. `now` is protocol time in seconds and only moves
  // when the UI advances it, so windows are explicit.
  function Simulator(nacl) {
    this.nacl = nacl;
    this.reset();
  }
  Simulator.prototype.reset = function () {
    this.now = Math.floor(Date.now() / 1000);
    this.events = [];
    this.operator = '0x' + bytesToHex(randomBytes(20));
    // SLASHING_COMMITTEE_ROLE holder. On testnet this is a dedicated key, not the deployer; on mainnet a multisig.
    this.committee = '0x' + bytesToHex(randomBytes(20));
    // DEFAULT_ADMIN_ROLE holder: rules on disputes and can veto. The deployer on testnet, the admin Safe on mainnet.
    this.admin = '0x' + bytesToHex(randomBytes(20));
    this.lastDroppedAt = 0;
    this.balances = {};
    this.claimable = {};
    this.balances[this.operator] = PARAMS.faucetGrant;
    this.allowance = 0n;
    this.agent = null;
    this.stake = 0n;
    this.pendingWithdrawal = null;
    this.score = null;
    this.pendingScore = null;
    this.slash = null;
    this.burned = 0n;
  };
  Simulator.prototype.emit = function (name, args, note) {
    var e = { name: name, args: args, note: note || '', at: this.now, block: 62607069 + this.events.length };
    this.events.push(e);
    return e;
  };
  Simulator.prototype.advance = function (seconds) { this.now += seconds; this.emit('TimeAdvanced', { by: seconds + 's' }, 'protocol time moved forward'); };

  Simulator.prototype.registerAgent = function () {
    if (this.agent) throw new Error('agent already registered');
    var kp = this.nacl.sign.keyPair();
    var addr = '0x' + bytesToHex(randomBytes(20));
    var didHash = computeDidHash(addr, PARAMS.chainId);
    this.agent = {
      address: addr,
      did: formatDid(addr, PARAMS.chainId),
      didHash: didHash,
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      pubKeyBytes32: '0x' + bytesToHex(kp.publicKey),
      multibase: pubKeyToMultibase(kp.publicKey),
      status: 'Active',
      registeredAt: this.now
    };
    this.emit('AgentRegistered', { didHash: didHash, operator: this.operator, agentAddress: addr, ed25519PubKey: this.agent.pubKeyBytes32 }, 'SigvaraIdentity.registerAgent');
    return this.agent;
  };

  Simulator.prototype.approve = function (amount) {
    this.allowance = amount;
    this.emit('Approval', { owner: this.operator, spender: 'SigvaraStaking', value: amount }, PARAMS.bondSymbol + '.approve');
  };
  Simulator.prototype.depositStake = function (amount) {
    this.requireAgent();
    // Suspended agents may deposit: SigvaraIdentity will not reactivate an agent below minimumStake, so an
    // operator that withdrew its bond has to be able to top it up. Only Slashed is terminal. A zero deposit is accepted.
    if (this.agent.status === 'Slashed') throw new Error('AgentNotActive: a slashed agent is terminal and cannot take stake');
    if (this.allowance < amount) throw new Error('ERC20InsufficientAllowance: approve SigvaraStaking first');
    if (this.balances[this.operator] < amount) throw new Error('ERC20InsufficientBalance');
    this.balances[this.operator] -= amount;
    this.allowance -= amount;
    this.stake += amount;
    this.emit('StakeDeposited', { didHash: this.agent.didHash, operator: this.operator, amount: amount }, 'SigvaraStaking.depositStake (stake now ' + fmtToken(this.stake) + ')');
  };
  Simulator.prototype.hasMinimumStake = function () { return this.stake >= PARAMS.minimumStake; };
  Simulator.prototype.initiateWithdrawal = function (amount) {
    this.requireAgent();
    if (this.stake === 0n) throw new Error('NoStake');
    if (this.pendingWithdrawal) throw new Error('WithdrawalAlreadyPending');
    if (this.slashFrozen()) throw new Error('SlashAlreadyPending: withdrawals are frozen during a slash');
    if (amount > this.stake) throw new Error('InsufficientStake');
    var remaining = this.stake - amount;
    // While Active the remaining stake must stay at or above minimumStake. A full
    // exit requires the operator to suspend the agent first (SigvaraIdentity.updateStatus).
    if (this.agent.status === 'Active' && remaining < PARAMS.minimumStake) throw new Error('InsufficientStake: an Active agent must keep at least minimumStake; suspend the agent first to exit fully');
    this.stake -= amount;
    this.pendingWithdrawal = { amount: amount, claimableAt: this.now + PARAMS.unbondingPeriod };
    this.emit('WithdrawalInitiated', { didHash: this.agent.didHash, operator: this.operator, amount: amount, claimableAt: this.pendingWithdrawal.claimableAt }, 'SigvaraStaking.initiateWithdrawal: unbonding for 21 days, still slashable');
  };
  Simulator.prototype.claimWithdrawal = function () {
    this.requireAgent();
    if (!this.pendingWithdrawal) throw new Error('NoWithdrawalPending');
    if (this.slashFrozen()) throw new Error('SlashAlreadyPending');
    if (this.now < this.pendingWithdrawal.claimableAt) throw new Error('UnbondingPeriodActive: ' + Math.ceil((this.pendingWithdrawal.claimableAt - this.now) / 86400) + ' days left');
    var amt = this.pendingWithdrawal.amount;
    this.pendingWithdrawal = null;
    this.balances[this.operator] += amt;
    this.emit('WithdrawalClaimed', { didHash: this.agent.didHash, operator: this.operator, amount: amt }, 'SigvaraStaking.claimWithdrawal');
  };

  Simulator.prototype.proposeReputation = function (input) {
    this.requireAgent();
    // The oracle only scores agents it is tracking; a slashed DID is terminal.
    if (this.agent.status === 'Slashed') throw new Error('oracle: slashed agents are not scored (reputation is terminal)');
    var f = computeFactors(input);
    // A new proposal replaces any still-pending one and restarts the window.
    this.pendingScore = { factors: f, total: totalScore(f), proposedAt: this.now, finalizeAt: this.now + PARAMS.scoreChallengeWindow };
    this.emit('ScoreProposed', { didHash: this.agent.didHash, proposedAt: this.now }, 'oracle: SigvaraReputation.proposeReputation (total ' + this.pendingScore.total + '), 6h challenge window opens');
    return this.pendingScore;
  };
  Simulator.prototype.finalizeReputation = function () {
    if (!this.pendingScore) throw new Error('NoScorePending');
    if (this.now < this.pendingScore.finalizeAt) throw new Error('ChallengeWindowActive: ' + Math.ceil((this.pendingScore.finalizeAt - this.now) / 3600) + 'h left');
    this.score = { factors: this.pendingScore.factors, total: this.pendingScore.total, lastUpdated: this.now };
    this.pendingScore = null;
    this.emit('ReputationUpdated', { didHash: this.agent.didHash, totalScore: this.score.total, timestamp: this.now }, 'anyone: SigvaraReputation.finalizeReputation');
    return this.score;
  };
  Simulator.prototype.rejectReputation = function () {
    if (!this.pendingScore) throw new Error('NoScorePending');
    if (this.now >= this.pendingScore.finalizeAt) throw new Error('ChallengeWindowExpired: the window has closed, only finalize is possible now');
    this.pendingScore = null;
    this.emit('ScoreRejected', { didHash: this.agent.didHash, committee: this.committee }, 'committee: SigvaraReputation.rejectReputation, last finalized score stands');
  };
  Simulator.prototype.getTotalScore = function () { return this.score ? this.score.total : 0; };
  Simulator.prototype.meetsThreshold = function (t) { return this.getTotalScore() >= t; };

  // Challenge and response in the SDK's v1 format (the current v2 also binds an audience).
  Simulator.prototype.issueChallenge = function (ttl) {
    this.requireAgent();
    var nonce = bytesToHex(randomBytes(16));
    var ts = this.now;
    return { payload: 'SIGVARA-VERIFY:' + this.agent.did + ':' + nonce + ':' + ts, nonce: nonce, timestamp: ts, expiresAt: ts + (ttl || 300) };
  };
  Simulator.prototype.signChallenge = function (payload) {
    this.requireAgent();
    return base58Encode(this.nacl.sign.detached(utf8(payload), this.agent.secretKey));
  };
  Simulator.prototype.verifySignature = function (payload, sigBytes, maxAge) {
    this.requireAgent();
    var m = payload.match(/^SIGVARA-VERIFY:(.+):([0-9a-f]+):(\d+)$/);
    if (!m) return { ok: false, reason: 'malformed payload' };
    if (m[1] !== this.agent.did) return { ok: false, reason: 'payload names a different DID' };
    if (this.now - parseInt(m[3], 10) > (maxAge || 300)) return { ok: false, reason: 'challenge expired' };
    // Signature validity is independent of status; the SDK's verifySignature only
    // checks registration, the stored key, DID binding and freshness. Status and
    // score are separate reads the consumer combines into its own decision.
    var ok = this.nacl.sign.detached.verify(utf8(payload), sigBytes, this.agent.publicKey);
    return { ok: ok, reason: ok ? 'signature matches the on-chain Ed25519 key' : 'signature does not match the on-chain key' };
  };

  // Slash proposal states mirror SlashState { Pending, Executed, Cancelled, Disputed }; no proposal yet is None.
  Simulator.prototype.pendingSlash = function () { return this.slash && this.slash.state === 'Pending' ? this.slash : null; };
  /// A Pending or Disputed proposal freezes the bond and blocks a new filing. Cancelled and Executed do not.
  Simulator.prototype.slashFrozen = function () {
    return !!this.slash && (this.slash.state === 'Pending' || this.slash.state === 'Disputed');
  };
  Simulator.prototype.initiateSlash = function (victim) {
    this.requireAgent();
    if (this.slashFrozen()) throw new Error('SlashAlreadyPending');
    // After any dropped proposal the committee waits one challenge period, so the operator always gets a window to act.
    if (this.lastDroppedAt && this.now < this.lastDroppedAt + PARAMS.challengePeriod) {
      throw new Error('SlashCooldownActive: ' + Math.ceil((this.lastDroppedAt + PARAMS.challengePeriod - this.now) / 86400) + ' day(s) left');
    }
    // Gate on active stake plus anything queued for withdrawal.
    if (this.stake + (this.pendingWithdrawal ? this.pendingWithdrawal.amount : 0n) === 0n) throw new Error('NoStake');
    // The reporter is the committee member who files (msg.sender); they receive the reporter share.
    this.slash = { victim: victim, reporter: this.committee, initiatedAt: this.now, deadline: this.now + PARAMS.challengePeriod, state: 'Pending' };
    this.agent.status = 'Suspended';
    this.emit('AgentStatusUpdated', { didHash: this.agent.didHash, newStatus: 'Suspended' }, 'SigvaraIdentity, applied by the staking core (operator cannot lift it)');
    this.emit('SlashInitiated', { didHash: this.agent.didHash, reporter: this.committee, victim: victim, initiatedAt: this.now }, 'committee: SigvaraStaking.initiateSlash. Agent Suspended via SigvaraIdentity.updateStatus; 7-day challenge window');
  };
  Simulator.prototype.disputeSlash = function () {
    var p = this.pendingSlash();
    if (!p) throw new Error('NoActivePendingSlash');
    if (this.now > p.deadline) throw new Error('ChallengePeriodExpired: the window closed at ' + p.deadline);
    // A dispute hands the proposal to the admin and keeps the bond frozen. It
    // does not cancel the slash and does not reinstate the agent: releasing the bond
    // here let an operator veto every proposal for free and withdraw the whole stake.
    p.state = 'Disputed';
    p.disputedAt = this.now;
    this.emit('SlashDisputed', { didHash: this.agent.didHash, operator: this.operator }, 'operator: SigvaraStaking.disputeSlash. Proposal Disputed; the bond stays frozen');
  };

  Simulator.prototype.disputedSlash = function () {
    return this.slash && this.slash.state === 'Disputed' ? this.slash : null;
  };

  /// The admin rules on a disputed proposal. Upholding waits for the challenge deadline, the
  /// moment an undisputed slash could be executed, so a dispute never speeds a slash up.
  /// Dropping is open at any time.
  Simulator.prototype.resolveDispute = function (uphold) {
    var p = this.disputedSlash();
    if (!p) throw new Error('SlashNotDisputed');
    if (uphold) {
      if (this.now <= p.deadline) throw new Error('ChallengePeriodActive: ' + Math.ceil((p.deadline - this.now) / 86400) + ' day(s) left; an upheld ruling cannot land before the deadline');
      return this._settle(p);
    }
    this._drop(p, this.admin, 'admin: SigvaraStaking.resolveDispute(false). Proposal dropped, agent reinstated');
  };

  /// Anyone may lift a freeze the admin never ruled on.
  Simulator.prototype.expireDispute = function () {
    var p = this.disputedSlash();
    if (!p) throw new Error('SlashNotDisputed');
    var expiresAt = p.disputedAt + PARAMS.disputeResolutionPeriod;
    if (this.now <= expiresAt) throw new Error('DisputeResolutionActive: ' + Math.ceil((expiresAt - this.now) / 86400) + ' day(s) left');
    this._drop(p, 'anyone', 'anyone: SigvaraStaking.expireDispute. Unresolved past the window, so the freeze lifts');
  };

  /// Anyone may drop a Pending proposal once 14 days have passed since its deadline. Until someone does, it can still be executed.
  Simulator.prototype.expireSlash = function () {
    var p = this.pendingSlash();
    if (!p) throw new Error('NoActivePendingSlash');
    var expiresAt = p.deadline + PARAMS.executionPeriod;
    if (this.now <= expiresAt) throw new Error('ExecutionPeriodActive: ' + Math.ceil((expiresAt - this.now) / 86400) + ' day(s) left');
    this._drop(p, 'anyone', 'anyone: SigvaraStaking.expireSlash. Nobody executed it within 14 days of the deadline, so it is dropped');
  };

  /// A committee member can withdraw a Pending proposal.
  Simulator.prototype.cancelSlash = function () {
    var p = this.pendingSlash();
    if (!p) throw new Error('NoActivePendingSlash');
    this._drop(p, this.committee, 'committee: SigvaraStaking.cancelSlash. Proposal withdrawn, agent reinstated');
  };

  /// The admin can drop a Pending or Disputed proposal at any time before it is executed.
  Simulator.prototype.vetoSlash = function () {
    var p = this.pendingSlash() || this.disputedSlash();
    if (!p) throw new Error('NoActivePendingSlash');
    this._drop(p, this.admin, 'admin: SigvaraStaking.vetoSlash. Proposal dropped, agent reinstated');
    this.emit('SlashVetoed', { didHash: this.agent.didHash, by: this.admin }, 'emitted by vetoSlash after SlashCancelled; resolveDispute(false) drops a proposal without it');
  };

  Simulator.prototype._drop = function (p, by, note) {
    p.state = 'Cancelled';
    this.lastDroppedAt = this.now;
    // Main reinstates only while the active stake is still at least minimumStake, and otherwise leaves the
    // agent Suspended. The demo cannot reach that case: it has no self-suspend, so the bond never drops below it.
    this.agent.status = 'Active';
    this.emit('AgentStatusUpdated', { didHash: this.agent.didHash, newStatus: 'Active' }, 'SigvaraIdentity, reinstated by the staking core');
    this.emit('SlashCancelled', { didHash: this.agent.didHash, by: by }, note);
  };
  Simulator.prototype.executeSlash = function () {
    var p = this.pendingSlash();
    if (!p) throw new Error('NoActivePendingSlash' + (this.slash && this.slash.state === 'Disputed' ? ': the proposal is disputed; the admin rules on it' : ''));
    // Executable strictly after the deadline (block.timestamp <= deadline reverts).
    if (this.now <= p.deadline) throw new Error('ChallengePeriodActive: ' + Math.ceil((p.deadline - this.now) / 86400) + ' day(s) left');
    return this._settle(p);
  };

  /// Shared settlement for an undisputed slash and for an upheld dispute. Victim and
  /// reporter shares are credited and pulled, so a recipient that cannot receive the
  /// token cannot block settlement and freeze the bond.
  Simulator.prototype._settle = function (p) {
    var total = this.stake + (this.pendingWithdrawal ? this.pendingWithdrawal.amount : 0n);
    var burned = total / 2n, toVictim = total / 4n, toReporter = total - burned - toVictim;
    this.stake = 0n; this.pendingWithdrawal = null;
    this.burned += burned;
    // Pull, not push: credited now, withdrawn by the recipient later.
    this.claimable[p.victim] = (this.claimable[p.victim] || 0n) + toVictim;
    this.claimable[p.reporter] = (this.claimable[p.reporter] || 0n) + toReporter;
    p.state = 'Executed';
    this.agent.status = 'Slashed';
    this.score = { factors: { feeScore: 0, successScore: 0, ageScore: 0, externalScore: 0, communityScore: 0, propagationScore: 0 }, total: 0, lastUpdated: this.now };
    this.pendingScore = null;
    this.emit('AgentStatusUpdated', { didHash: this.agent.didHash, newStatus: 'Slashed' }, 'SigvaraIdentity: terminal, no further transitions');
    this.emit('ReputationZeroed', { didHash: this.agent.didHash }, 'SigvaraReputation.zeroReputation, called by the staking core; pending proposal cleared');
    this.emit('SlashExecuted', { didHash: this.agent.didHash, burned: burned, toVictim: toVictim, toReporter: toReporter }, '50% burned to 0xdead; 25% victim and 25% reporter credited for them to claim');
    return { burned: burned, toVictim: toVictim, toReporter: toReporter };
  };
  Simulator.prototype.requireAgent = function () { if (!this.agent) throw new Error('NoAgent: register first'); };

  function fmtToken(wei) {
    var whole = wei / 10n ** 18n, frac = wei % 10n ** 18n;
    var s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (frac !== 0n) s += '.' + frac.toString().padStart(18, '0').replace(/0+$/, '').slice(0, 4);
    return s;
  }

  var api = {
    keccak256: keccak256, computeDidHash: computeDidHash, formatDid: formatDid,
    base58Encode: base58Encode, bytesToHex: bytesToHex, hexToBytes: hexToBytes,
    pubKeyToMultibase: pubKeyToMultibase, computeFactors: computeFactors, totalScore: totalScore,
    PARAMS: PARAMS, Simulator: Simulator, fmtToken: fmtToken
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SigvaraDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
