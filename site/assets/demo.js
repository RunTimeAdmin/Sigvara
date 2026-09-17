/* Sigvara interactive demo engine.
 *
 * Everything runs in the browser. Keys and signatures are real Ed25519
 * (tweetnacl). The chain is simulated, but every rule below mirrors the
 * deployed contracts and the reference oracle:
 *   - DID and didHash derivation (SigvaraIdentity)
 *   - minimum stake, unbonding, slash split (SigvaraStaking)
 *   - six-factor score with per-factor maxima and the 6h score challenge
 *     window (SigvaraReputation + docs/reputation-model.md)
 *   - challenge/response payload format (packages/sdk challenge.ts)
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ keccak-256 --
  // Compact Keccak-f[1600] on BigInt lanes. Only used for didHash, which is
  // keccak256(abi.encodePacked("did:sigvara:", uint256 chainId, ":", address)).
  var RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
  ];
  var ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  var M64 = (1n << 64n) - 1n;
  function rotl(x, n) { return n === 0 ? x : (((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64); }

  function keccak256(bytes) {
    var rate = 136;
    var s = new Array(25).fill(0n);
    var padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    for (var off = 0; off < padded.length; off += rate) {
      for (var i = 0; i < rate / 8; i++) {
        var v = 0n;
        for (var b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + i * 8 + b]);
        s[i] ^= v;
      }
      for (var r = 0; r < 24; r++) {
        var C = [0, 1, 2, 3, 4].map(function (x) { return s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]; });
        var D = [0, 1, 2, 3, 4].map(function (x) { return C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); });
        for (var k = 0; k < 25; k++) s[k] ^= D[k % 5];
        var B = new Array(25);
        for (var x = 0; x < 5; x++) for (var y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
        for (var x2 = 0; x2 < 5; x2++) for (var y2 = 0; y2 < 5; y2++) s[x2 + 5 * y2] = B[x2 + 5 * y2] ^ ((~B[(x2 + 1) % 5 + 5 * y2] & M64) & B[(x2 + 2) % 5 + 5 * y2]);
        s[0] ^= RC[r];
      }
    }
    var out = '';
    for (var j = 0; j < 4; j++) {
      var lane = s[j];
      for (var q = 0; q < 8; q++) { out += Number(lane & 0xffn).toString(16).padStart(2, '0'); lane >>= 8n; }
    }
    return '0x' + out;
  }

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
  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }
  function hexToBytes(hex) {
    hex = hex.replace(/^0x/, '');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function randomBytes(n) {
    var a = new Uint8Array(n);
    (root.crypto || require('crypto').webcrypto).getRandomValues(a);
    return a;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function concat() {
    var len = 0, i;
    for (i = 0; i < arguments.length; i++) len += arguments[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
    return out;
  }

  // ------------------------------------------------------------------ DID --
  function formatDid(agentAddress, chainId) { return 'did:sigvara:' + chainId + ':' + agentAddress.toLowerCase(); }
  function computeDidHash(agentAddress, chainId) {
    var id = new Uint8Array(32);
    var v = BigInt(chainId);
    for (var i = 31; i >= 0; i--) { id[i] = Number(v & 0xffn); v >>= 8n; }
    return keccak256(concat(utf8('did:sigvara:'), id, utf8(':'), hexToBytes(agentAddress)));
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
    this.balances = {};
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
    this.emit('StakeDeposited', { didHash: this.agent.didHash, amount: amount, total: this.stake }, 'SigvaraStaking.depositStake');
  };
  Simulator.prototype.hasMinimumStake = function () { return this.stake >= PARAMS.minimumStake; };
  Simulator.prototype.initiateWithdrawal = function (amount) {
    this.requireAgent();
    if (this.slash && !this.slash.executed) throw new Error('SlashPending: withdrawals are frozen during a slash');
    if (this.pendingWithdrawal) throw new Error('WithdrawalAlreadyQueued');
    if (amount > this.stake) throw new Error('InsufficientStake');
    var remaining = this.stake - amount;
    if (this.agent.status === 'Active' && remaining !== 0n && remaining < PARAMS.minimumStake) throw new Error('InsufficientStake: an Active agent must keep at least minimumStake or withdraw to zero');
    this.stake -= amount;
    this.pendingWithdrawal = { amount: amount, claimableAt: this.now + PARAMS.unbondingPeriod };
    this.emit('WithdrawalInitiated', { didHash: this.agent.didHash, amount: amount, claimableAt: this.pendingWithdrawal.claimableAt }, 'SigvaraStaking.initiateWithdrawal: unbonding for 21 days, still slashable');
  };
  Simulator.prototype.claimWithdrawal = function () {
    this.requireAgent();
    if (!this.pendingWithdrawal) throw new Error('NoWithdrawalQueued');
    if (this.slash && !this.slash.executed) throw new Error('SlashPending');
    if (this.now < this.pendingWithdrawal.claimableAt) throw new Error('UnbondingNotElapsed: ' + Math.ceil((this.pendingWithdrawal.claimableAt - this.now) / 86400) + ' days left');
    var amt = this.pendingWithdrawal.amount;
    this.pendingWithdrawal = null;
    this.balances[this.operator] += amt;
    this.emit('WithdrawalClaimed', { didHash: this.agent.didHash, amount: amt }, 'SigvaraStaking.claimWithdrawal');
  };

  Simulator.prototype.proposeReputation = function (input) {
    this.requireAgent();
    if (this.agent.status === 'Slashed') throw new Error('AgentSlashed: reputation is terminal');
    var f = computeFactors(input);
    this.pendingScore = { factors: f, total: totalScore(f), proposedAt: this.now, finalizeAt: this.now + PARAMS.scoreChallengeWindow };
    this.emit('ReputationProposed', { didHash: this.agent.didHash, total: this.pendingScore.total, finalizeAfter: this.pendingScore.finalizeAt }, 'oracle: SigvaraReputation.proposeReputation, 6h challenge window opens');
    return this.pendingScore;
  };
  Simulator.prototype.finalizeReputation = function () {
    if (!this.pendingScore) throw new Error('NoPendingScore');
    if (this.now < this.pendingScore.finalizeAt) throw new Error('ChallengeWindowOpen: ' + Math.ceil((this.pendingScore.finalizeAt - this.now) / 3600) + 'h left');
    this.score = { factors: this.pendingScore.factors, total: this.pendingScore.total, lastUpdated: this.now };
    this.pendingScore = null;
    this.emit('ReputationFinalized', { didHash: this.agent.didHash, total: this.score.total }, 'anyone: SigvaraReputation.finalizeReputation');
    return this.score;
  };
  Simulator.prototype.rejectReputation = function () {
    if (!this.pendingScore) throw new Error('NoPendingScore');
    var t = this.pendingScore.total;
    this.pendingScore = null;
    this.emit('ReputationRejected', { didHash: this.agent.didHash, rejectedTotal: t }, 'committee: SigvaraReputation.rejectReputation, last finalized score stands');
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
    if (this.agent.status !== 'Active') return { ok: false, reason: 'agent status is ' + this.agent.status };
    var ok = this.nacl.sign.detached.verify(utf8(payload), sigBytes, this.agent.publicKey);
    return { ok: ok, reason: ok ? 'signature matches the on-chain Ed25519 key' : 'signature does not match the on-chain key' };
  };

  Simulator.prototype.initiateSlash = function (victim, reporter, reason) {
    this.requireAgent();
    if (this.slash && !this.slash.executed) throw new Error('SlashAlreadyPending');
    if (this.stake + (this.pendingWithdrawal ? this.pendingWithdrawal.amount : 0n) === 0n) throw new Error('NoStake');
    this.slash = { victim: victim, reporter: reporter, reason: reason, initiatedAt: this.now, executableAt: this.now + PARAMS.challengePeriod, disputed: false, executed: false };
    this.agent.status = 'Suspended';
    this.emit('SlashInitiated', { didHash: this.agent.didHash, victim: victim, reporter: reporter, executableAfter: this.slash.executableAt }, 'committee: SigvaraStaking.initiateSlash, agent Suspended, 7-day challenge window');
  };
  Simulator.prototype.disputeSlash = function () {
    if (!this.slash || this.slash.executed) throw new Error('NoPendingSlash');
    if (this.now >= this.slash.executableAt) throw new Error('ChallengePeriodOver');
    this.slash.disputed = true;
    this.emit('SlashDisputed', { didHash: this.agent.didHash }, 'operator: SigvaraStaking.disputeSlash, committee review on record');
  };
  Simulator.prototype.executeSlash = function () {
    if (!this.slash || this.slash.executed) throw new Error('NoPendingSlash');
    if (this.now < this.slash.executableAt) throw new Error('ChallengePeriodActive: ' + Math.ceil((this.slash.executableAt - this.now) / 86400) + ' days left');
    var total = this.stake + (this.pendingWithdrawal ? this.pendingWithdrawal.amount : 0n);
    var burned = total / 2n, toVictim = total / 4n, toReporter = total - burned - toVictim;
    this.stake = 0n; this.pendingWithdrawal = null;
    this.burned += burned;
    this.balances[this.slash.victim] = (this.balances[this.slash.victim] || 0n) + toVictim;
    this.balances[this.slash.reporter] = (this.balances[this.slash.reporter] || 0n) + toReporter;
    this.slash.executed = true;
    this.agent.status = 'Slashed';
    this.score = { factors: { feeScore: 0, successScore: 0, ageScore: 0, externalScore: 0, communityScore: 0, propagationScore: 0 }, total: 0, lastUpdated: this.now };
    this.pendingScore = null;
    this.emit('SlashExecuted', { didHash: this.agent.didHash, burned: burned, toVictim: toVictim, toReporter: toReporter }, 'anyone: SigvaraStaking.executeSlash. Status Slashed (terminal), reputation zeroed');
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
