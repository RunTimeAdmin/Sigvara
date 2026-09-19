/* Sigvara interactive demo engine.
 *
 * Everything runs in the browser. Keys and signatures are real Ed25519
 * (tweetnacl). The chain is simulated, but every rule below mirrors the
 * deployed contracts and the reference oracle:
 *   - DID and didHash derivation (SigvaraIdentity)
 *   - minimum stake, unbonding, slash lifecycle and split (SigvaraStaking):
 *     a dispute freezes the bond and hands the proposal to the committee, whose
 *     ruling either slashes or reinstates; an unresolved dispute can be expired
 *     by anyone after 14 days. Undisputed execution is permissionless strictly
 *     after the 7-day window. Reporter = the committee member who filed, and
 *     victim/reporter shares are credited for them to claim, not pushed.
 *   - six-factor score with per-factor maxima and the 6h score challenge
 *     window (SigvaraReputation + docs/reputation-model.md)
 *   - challenge/response payload format (packages/sdk challenge.ts)
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
    faucetGrant: 10000n * 10n ** 18n,
    factors: [
      { key: 'feeScore', label: 'Fee activity', max: 30 },
      { key: 'successScore', label: 'Success rate', max: 25 },
      { key: 'ageScore', label: 'Registration age', max: 20 },
      { key: 'externalScore', label: 'External trust', max: 15 },
      { key: 'communityScore', label: 'Community', max: 5 },
      { key: 'propagationScore', label: 'Trust propagation', max: 5 }
    ]
  };

  // docs/reputation-model.md formulas.
  function computeFactors(input) {
    var success = input.attestations > 0 ? input.successes / input.attestations : 0;
    return {
      feeScore: Math.min(30, Math.floor(input.feesUsd / 100)),
      successScore: Math.floor(success * 25),
      ageScore: Math.min(20, Math.floor(Math.log2(input.days + 1) * 4)),
      externalScore: Math.floor((input.external / 100) * 15),
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
    // SLASHING_COMMITTEE_ROLE holder. On testnet this is the deployer; on mainnet a multisig.
    this.committee = '0x' + bytesToHex(randomBytes(20));
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
    if (this.agent.status !== 'Active') throw new Error('AgentNotActive: only Active agents can add stake');
    if (amount <= 0n) throw new Error('ZeroAmount');
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
    if (this.slash && !this.slash.executed) throw new Error('SlashPending: withdrawals are frozen during a slash');
    if (this.pendingWithdrawal) throw new Error('WithdrawalAlreadyQueued');
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
    if (!this.pendingWithdrawal) throw new Error('NoWithdrawalQueued');
    if (this.slash && !this.slash.executed) throw new Error('SlashPending');
    if (this.now < this.pendingWithdrawal.claimableAt) throw new Error('UnbondingNotElapsed: ' + Math.ceil((this.pendingWithdrawal.claimableAt - this.now) / 86400) + ' days left');
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

  // Challenge and response, byte-for-byte the SDK format.
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

  // Slash proposal states mirror SlashState { Pending, Cancelled, Executed }.
  Simulator.prototype.pendingSlash = function () { return this.slash && this.slash.state === 'Pending' ? this.slash : null; };
  Simulator.prototype.initiateSlash = function (victim) {
    this.requireAgent();
    if (this.pendingSlash()) throw new Error('SlashAlreadyPending');
    // Gate on active stake plus anything queued for withdrawal.
    if (this.stake + (this.pendingWithdrawal ? this.pendingWithdrawal.amount : 0n) === 0n) throw new Error('NoStake');
    // The reporter is the committee member who files (msg.sender); they receive the reporter share.
    this.slash = { victim: victim, reporter: this.committee, initiatedAt: this.now, deadline: this.now + PARAMS.challengePeriod, state: 'Pending' };
    this.agent.status = 'Suspended';
    this.emit('SlashInitiated', { didHash: this.agent.didHash, reporter: this.committee, victim: victim, initiatedAt: this.now }, 'committee: SigvaraStaking.initiateSlash. Agent Suspended via SigvaraIdentity.updateStatus; 7-day challenge window');
    this.emit('AgentStatusUpdated', { didHash: this.agent.didHash, newStatus: 'Suspended' }, 'SigvaraIdentity, applied by the staking core (operator cannot lift it)');
  };
  Simulator.prototype.disputeSlash = function () {
    var p = this.pendingSlash();
    if (!p) throw new Error('NoActivePendingSlash');
    if (this.now > p.deadline) throw new Error('ChallengePeriodExpired: the window closed at ' + p.deadline);
    // A dispute hands the proposal to the committee and keeps the bond frozen. It
    // does not cancel the slash and does not reinstate the agent: releasing the bond
    // here let an operator veto every proposal for free and withdraw the whole stake.
    p.state = 'Disputed';
    p.disputedAt = this.now;
    this.emit('SlashDisputed', { didHash: this.agent.didHash, operator: this.operator }, 'operator: SigvaraStaking.disputeSlash. Proposal Disputed; the bond stays frozen');
  };

  Simulator.prototype.disputedSlash = function () {
    return this.slash && this.slash.state === 'Disputed' ? this.slash : null;
  };

  /// Committee rules on a disputed proposal.
  Simulator.prototype.resolveDispute = function (uphold) {
    var p = this.disputedSlash();
    if (!p) throw new Error('SlashNotDisputed');
    if (uphold) return this._settle(p);
    this._drop(p, this.committee, 'committee: SigvaraStaking.resolveDispute(false). Proposal dropped, agent reinstated');
  };

  /// Anyone may lift a freeze the committee never resolved.
  Simulator.prototype.expireDispute = function () {
    var p = this.disputedSlash();
    if (!p) throw new Error('SlashNotDisputed');
    var expiresAt = p.disputedAt + PARAMS.disputeResolutionPeriod;
    if (this.now <= expiresAt) throw new Error('DisputeResolutionActive: ' + Math.ceil((expiresAt - this.now) / 86400) + ' day(s) left');
    this._drop(p, 'anyone', 'anyone: SigvaraStaking.expireDispute. Unresolved past the window, so the freeze lifts');
  };

  Simulator.prototype._drop = function (p, by, note) {
    p.state = 'Cancelled';
    this.agent.status = 'Active';
    this.emit('SlashCancelled', { didHash: this.agent.didHash, by: by }, note);
    this.emit('AgentStatusUpdated', { didHash: this.agent.didHash, newStatus: 'Active' }, 'SigvaraIdentity, reinstated by the staking core');
  };
  Simulator.prototype.executeSlash = function () {
    var p = this.pendingSlash();
    if (!p) throw new Error('NoActivePendingSlash' + (this.slash && this.slash.state === 'Disputed' ? ': the proposal is disputed; the committee resolves it' : ''));
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
