'use strict';

require('dotenv').config();

const http = require('http');
const chain = require('./chain');
const external = require('./external');
const { computeScore } = require('./scoring');
const { decideAction } = require('./epoch-policy');
const { json, readBody, isAuthorized, parseScorePath, rateLimited, adminTokenPolicyError } = require('./http-helpers');
const payments = require('./payments');
const metrics = require('./metrics');

// Verified-payment settings. Read once at startup so a malformed value fails the
// process rather than silently disabling verification on the first request.
const paymentCfg = payments.readConfig();

// Per-client key for rate limiting. Behind the container's 127.0.0.1 port map all
// requests may share one source IP, so this degrades to a global cap — still a
// useful flood guard for the write endpoints.
const clientKey = req => req.socket?.remoteAddress || 'unknown';

// ---- Config ----------------------------------------------------------------

const cfg = {
  rpcUrl:            process.env.RPC_URL            || '',
  privateKey:        process.env.ORACLE_PRIVATE_KEY || '',
  identityAddress:   process.env.IDENTITY_ADDRESS   || '',
  reputationAddress: process.env.REPUTATION_ADDRESS || '',
  epochMs:           Number(process.env.EPOCH_HOURS || 24) * 3_600_000,
  host:              process.env.HOST || '127.0.0.1',
  port:              Number(process.env.PORT || 3030),
  fromBlock:         Number(process.env.FROM_BLOCK  || 0),
  logChunkSize:      Number(process.env.LOG_CHUNK_SIZE || 2000),
  adminToken:        process.env.ORACLE_ADMIN_TOKEN || '',
  // Optional: SigvaraEpochFees address. When set (and its on-chain epochFee > 0),
  // the oracle only scores agents with fee coverage and charges them per epoch.
  feeRegistryAddress: process.env.FEE_REGISTRY_ADDRESS || '',
  // Optional: ERC-8004 registries (typically Base Sepolia) for the externalScore
  // factor. When all three are set, linked agents get an external-trust score from
  // their 8004 feedback; unset leaves externalScore at 0. See external.js.
  externalRpc:        process.env.EXTERNAL_RPC || '',
  externalIdentity:   process.env.EXTERNAL_IDENTITY_ADDRESS || '',
  externalReputation: process.env.EXTERNAL_REPUTATION_ADDRESS || '',
};

if (!cfg.rpcUrl || !cfg.privateKey || !cfg.identityAddress || !cfg.reputationAddress) {
  console.error('[oracle] Missing required env vars. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

chain.init(cfg);
external.init(cfg);

// ---- Persistent state ------------------------------------------------------
// attestations/flags drive score factors that accumulate and cannot be
// recomputed from chain, so they are persisted to a mounted volume. See store.js.
const {
  attestations,
  flags,
  links,
  load: loadState,
  persist: persistState,
  checkAttestCooldown,
  recordAttestation,
  creditPayment,
  paymentVolume,
  pruneExpiredCooldowns,
  isStatePathWritable,
  getStatePath,
  ATTEST_COOLDOWN_MS,
} = require('./store');

// With verification on, feeScore comes from settled payment volume rather than the
// attestation-count proxy. null keeps computeScore on the old path. Used by both the
// epoch and the /score endpoint so the number served matches the number proposed.
function measuredFeeScoreFor(didHash) {
  if (!payments.required(paymentCfg)) return null;
  return payments.feeScoreFromVolume(paymentVolume(didHash), paymentCfg.feeUnit);
}

// ---- Epoch -----------------------------------------------------------------

// Guards against overlapping epochs from the setInterval tick and the manual
// /epoch endpoint firing at the same time, which would submit tx's with colliding
// nonces from the shared oracle wallet.
let epochRunning = false;

async function runEpoch() {
  if (epochRunning) {
    console.log('[oracle] epoch already running, skipping this trigger');
    return;
  }
  epochRunning = true;

  try {
    await runEpochInner();
  } catch (err) {
    // runEpochInner reads chain config (challenge window, chain clock, epoch fee)
    // outside any per-agent guard. A transient RPC failure there used to escape as
    // an unhandled rejection and kill the process; the container then restarted and
    // immediately re-ran the epoch, which is how an agent could be charged twice.
    // An epoch that cannot start is skipped until the next tick instead.
    console.error('[oracle] epoch aborted:', err.message);
    metrics.inc('epochsFailed');
  } finally {
    epochRunning = false;
  }
}

async function runEpochInner() {
  const start = Date.now();
  console.log(`[oracle] epoch start — ${new Date().toISOString()}`);
  metrics.inc('epochsStarted');

  let agents;
  try {
    agents = await chain.getRegisteredAgents();
  } catch (err) {
    console.error('[oracle] could not fetch registered agents:', err.message);
    metrics.inc('epochsFailed');
    return;
  }

  console.log(`[oracle] ${agents.length} agent(s) found`);
  let proposed = 0;
  let finalized = 0;

  const challengeWindow = await chain.getChallengeWindow();
  // Use the chain's clock for window math, not the local one — the contract
  // compares against block.timestamp. Fetched once per epoch; going slightly
  // stale during a long epoch only errs toward 'skip', never toward a
  // premature finalize that would revert.
  const chainNow = await chain.getLatestBlockTimestamp();

  // Epoch-fee gating (opt-in via FEE_REGISTRY_ADDRESS). Active only when a fee
  // registry is configured AND the on-chain epochFee is non-zero. When inactive,
  // every agent is treated as covered and nothing is charged.
  const gatingActive = chain.feeGatingConfigured() && (await chain.getEpochFee()) > 0n;
  if (gatingActive) console.log('[oracle] epoch-fee gating ACTIVE');

  // Phase 1: reads are stateless — fire them concurrently instead of one at a time.
  const agentInfos = await Promise.all(
    agents.map(async ({ didHash }) => {
      try {
        const [info, pending, covered] = await Promise.all([
          chain.getAgentInfo(didHash),
          chain.getPendingScore(didHash),
          gatingActive ? chain.isCovered(didHash) : Promise.resolve(true),
        ]);
        return { didHash, ...info, pending, covered, error: null };
      } catch (err) {
        return { didHash, registeredAt: 0, status: -1, pending: null, covered: false, error: err };
      }
    })
  );

  // Phase 2: writes share the oracle wallet's nonce, so they stay sequential.
  for (const { didHash, operator, registeredAt, status, pending, covered, error } of agentInfos) {
    if (error) {
      console.error(`[oracle]   ${didHash.slice(0, 10)}… error: ${error.message}`);
      continue;
    }
    try {
      // Slashed agents are terminal — their score was zeroed by SigvaraStaking.
      if (status === chain.STATUS_SLASHED) {
        chain.pruneAgent(didHash);
        continue;
      }

      // Uncovered agents fall out of the active scoring run (tokenomics §4).
      if (gatingActive && !covered) {
        console.log(`[oracle]   ${didHash.slice(0, 10)}… uncovered (no epoch fee), skipping`);
        continue;
      }

      // The status above came from the concurrent phase-1 batch. Writes are
      // sequential, so by the time this agent's turn arrives a slash may have
      // executed — and proposing then writes a fresh score onto a terminated
      // identity that nothing will ever correct. Re-read immediately before
      // writing so the check is one block from the write, not one batch.
      const fresh = await chain.getAgentInfo(didHash);
      if (fresh.status === chain.STATUS_SLASHED) {
        console.log(`[oracle]   ${didHash.slice(0, 10)}… slashed since the batch read, skipping`);
        chain.pruneAgent(didHash);
        continue;
      }

      const action = decideAction(pending, challengeWindow, chainNow);

      if (action === 'skip') {
        console.log(`[oracle]   ${didHash.slice(0, 10)}… score still pending, waiting out challenge window`);
        continue;
      }

      if (action === 'finalize-then-propose') {
        metrics.inc('finalizeAttempts');
        try {
          const finalizeTx = await chain.finalizeScore(didHash);
          console.log(`[oracle]   ${didHash.slice(0, 10)}… finalized tx=${finalizeTx.slice(0, 10)}…`);
          finalized++;
          metrics.inc('finalizeSuccesses');
        } catch (finalizeErr) {
          // finalizeReputation is permissionless, so another party can front-run
          // us. If the pending proposal is gone, that's exactly what happened —
          // the score is live, carry on and propose fresh. Anything else is a
          // real failure and should skip this agent via the outer catch.
          const still = await chain.getPendingScore(didHash);
          if (still.exists) {
            metrics.inc('finalizeErrors');
            throw finalizeErr;
          }
          console.log(`[oracle]   ${didHash.slice(0, 10)}… already finalized by another party`);
          metrics.inc('finalizeSuccesses');
        }
      }

      const att       = attestations.get(didHash) ?? { successful: 0, total: 0 };
      const flagCount = flags.get(didHash) ?? 0;
      // externalScore: only for agents linked to an ERC-8004 identity they own.
      // Ownership is re-verified inside externalScoreFor; any failure yields 0.
      const linkedId  = links.get(didHash);
      const externalScore = (external.configured() && linkedId !== undefined)
        ? await external.externalScoreFor(linkedId, operator)
        : 0;
      const scores    = computeScore({
        registeredAt, attestations: att, flags: flagCount, externalScore,
        measuredFeeScore: measuredFeeScoreFor(didHash),
      });

      // Charge before proposing, not after. The coverage read above and the
      // charge are separated by at least the propose transaction, and an
      // operator can withdraw in that gap: they would be scored for free, and
      // because the charge used to be fire-and-forget the failure was silent.
      // Taking the fee first means a withdrawal after the charge costs them
      // nothing to us. The trade-off is that an agent charged for an epoch whose
      // proposal then fails has paid for a run it did not get; that is logged
      // and counted, and is the lesser of the two errors.
      if (gatingActive) {
        try {
          await chain.chargeEpoch(didHash);
          metrics.inc('feeCharges');
        } catch (chargeErr) {
          console.error(`[oracle]   ${didHash.slice(0, 10)}… epoch-fee charge failed, not scoring: ${chargeErr.message}`);
          metrics.inc('feeChargeErrors');
          continue;
        }
      }

      metrics.inc('proposeAttempts');
      const txHash    = await chain.proposeScore(didHash, scores);
      metrics.inc('proposeSuccesses');

      console.log(`[oracle]   ${didHash.slice(0, 10)}… proposed score=${scores.total}/100 tx=${txHash.slice(0, 10)}…`);
      proposed++;
    } catch (err) {
      console.error(`[oracle]   ${didHash.slice(0, 10)}… error: ${err.message}`);
      metrics.inc('proposeErrors');
    }
  }

  console.log(`[oracle] epoch done — ${proposed} proposed, ${finalized} finalized in ${Date.now() - start}ms`);
  metrics.inc('epochsSucceeded');
  metrics.set('lastSuccessfulEpochMs', Date.now());
  metrics.set('activeAgents', proposed);

  pruneExpiredCooldowns();
}

// ---- HTTP API --------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${cfg.port}`);
  const { pathname } = url;
  metrics.inc('httpRequests');

  // GET /health — extended for production alerting
  if (req.method === 'GET' && pathname === '/health') {
    const lastEpoch = metrics.get('lastSuccessfulEpochMs');
    const timeSinceLastEpoch = lastEpoch ? Date.now() - lastEpoch : null;
    const storeWritable = isStatePathWritable();

    const healthy = storeWritable && (!lastEpoch || timeSinceLastEpoch < cfg.epochMs * 2);

    return json(res, healthy ? 200 : 503, {
      ok: healthy,
      epochMs: cfg.epochMs,
      uptimeSeconds: metrics.uptimeSeconds(),
      lastSuccessfulEpochMs: lastEpoch,
      timeSinceLastEpochMs: timeSinceLastEpoch,
      storeWritable,
      statePath: getStatePath(),
      attestCooldownMs: ATTEST_COOLDOWN_MS,
      epochRunning,
    });
  }

  // GET /metrics — Prometheus text format
  if (req.method === 'GET' && pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(metrics.toPrometheusText());
  }

  // POST /epoch  — trigger a manual run (useful for testing)
  if (req.method === 'POST' && pathname === '/epoch') {
    // Gated: a manual epoch submits on-chain tx's paid from the oracle wallet, so
    // it must not be triggerable by anyone who can reach the port.
    if (!isAuthorized(req.headers, cfg.adminToken)) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    if (epochRunning) return json(res, 409, { error: 'Epoch already running' });
    runEpoch().catch(err => console.error('[oracle] manual epoch error:', err.message));
    return json(res, 202, { message: 'Epoch started' });
  }

  // POST /attest  — body: { didHash, success, attester }
  // attester: unique ID for the party submitting the attestation (e.g. client address, API key hash).
  // Used for dedupe/cooldown: the same attester cannot attest the same agent within ATTEST_COOLDOWN_MS.
  if (req.method === 'POST' && pathname === '/attest') {
    if (!isAuthorized(req.headers, cfg.adminToken)) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const body = await readBody(req);
      const { didHash, success } = body;
      let attester = body.attester;
      if (!didHash) {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'didHash required' });
      }
      // Only needed when payments are off; otherwise it comes from the transfer.
      if (!attester && !payments.required(paymentCfg)) {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'attester required (unique ID for the attestation source)' });
      }

      // With verification on, the attester is whoever actually paid, taken from the
      // settlement transfer. The `attester` field in the body is ignored: letting a
      // caller name themselves is what made attestations free to manufacture.
      let credited = null;
      if (payments.required(paymentCfg)) {
        const txHash = body.payment && body.payment.txHash;
        let info;
        try {
          info = await chain.getAgentInfo(didHash);
        } catch (err) {
          metrics.inc('attestRejectedOther');
          return json(res, 502, { error: `could not read agent: ${err.message}` });
        }
        if (!info || Number(info.registeredAt) === 0) {
          metrics.inc('attestRejectedOther');
          return json(res, 400, { error: 'unknown didHash' });
        }
        try {
          credited = await payments.verifyPayment(
            { provider: chain.getProvider(), cfg: paymentCfg },
            txHash,
            info.agentAddress
          );
        } catch (err) {
          // An RPC failure is not the caller's fault and must not be recorded as a
          // rejected attestation, or a flaky node would look like abuse.
          const rpc = err.code === 'rpc_error';
          metrics.inc(rpc ? 'paymentRpcErrors' : 'attestRejectedPayment');
          return json(res, rpc ? 502 : 402, { error: err.message, code: err.code || 'payment_invalid' });
        }
        attester = credited.payer;
      }

      const cooldownCheck = checkAttestCooldown(attester, didHash);
      if (!cooldownCheck.allowed) {
        metrics.inc('attestRejectedCooldown');
        const remainingSec = Math.ceil(cooldownCheck.remainingMs / 1000);
        return json(res, 429, {
          error: 'Attestation cooldown active',
          attester,
          didHash,
          remainingSeconds: remainingSec,
          cooldownMs: ATTEST_COOLDOWN_MS,
        });
      }

      const att = attestations.get(didHash) ?? { successful: 0, total: 0 };
      att.total++;
      if (success) att.successful++;
      attestations.set(didHash, att);
      recordAttestation(attester, didHash);
      if (credited) {
        // Credit after the cooldown check so a rejected attestation does not burn
        // the receipt; the payer can retry once the cooldown clears.
        if (!creditPayment(didHash, credited.txHash, credited.amount)) {
          metrics.inc('attestRejectedPayment');
          return json(res, 409, { error: 'this settlement has already been credited', code: 'replayed' });
        }
        metrics.inc('paymentsVerified');
      }
      persistState();
      metrics.inc('attestAccepted');
      return json(res, 200, {
        didHash,
        attester,
        ...att,
        ...(credited ? { payment: { txHash: credited.txHash, amount: credited.amount.toString() } } : {}),
      });
    } catch (err) {
      metrics.inc('attestRejectedOther');
      return json(res, 400, { error: err.message });
    }
  }

  // POST /flag  — body: { didHash }
  if (req.method === 'POST' && pathname === '/flag') {
    if (!isAuthorized(req.headers, cfg.adminToken)) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const { didHash } = await readBody(req);
      if (!didHash) return json(res, 400, { error: 'didHash required' });
      flags.set(didHash, (flags.get(didHash) ?? 0) + 1);
      persistState();
      metrics.inc('flagsReceived');
      return json(res, 200, { didHash, flags: flags.get(didHash) });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /link  — body: { didHash, agentId } — link a Sigvara agent to its
  // ERC-8004 identity so its 8004 feedback drives externalScore. Accepted only
  // if the 8004 agent NFT is owned by the same wallet as the Sigvara operator.
  if (req.method === 'POST' && pathname === '/link') {
    if (!isAuthorized(req.headers, cfg.adminToken)) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const { didHash, agentId } = await readBody(req);
      if (!didHash || agentId === undefined || agentId === null) {
        return json(res, 400, { error: 'didHash and agentId required' });
      }
      if (!external.configured()) return json(res, 400, { error: 'external (ERC-8004) registry not configured' });
      const { operator } = await chain.getAgentInfo(didHash);
      const owns = await external.verifyOwnership(String(agentId), operator);
      if (!owns) {
        return json(res, 403, { error: 'ERC-8004 agent is not owned by this agent\'s Sigvara operator; refusing to link' });
      }
      links.set(didHash, String(agentId));
      persistState();
      metrics.inc('linksCreated');
      return json(res, 200, { didHash, agentId: String(agentId), operator, linked: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // GET /score/:didHash  — preview computed score without writing to chain
  const didHash = parseScorePath(pathname);
  if (req.method === 'GET' && didHash) {
    try {
      const { operator, registeredAt, status } = await chain.getAgentInfo(didHash);
      const att       = attestations.get(didHash) ?? { successful: 0, total: 0 };
      const flagCount = flags.get(didHash) ?? 0;
      const linkedId  = links.get(didHash);
      const externalScore = (external.configured() && linkedId !== undefined)
        ? await external.externalScoreFor(linkedId, operator)
        : 0;
      const scores    = computeScore({
        registeredAt, attestations: att, flags: flagCount, externalScore,
        measuredFeeScore: measuredFeeScoreFor(didHash),
      });
      return json(res, 200, { didHash, status, scores, attestations: att, flags: flagCount, erc8004AgentId: linkedId ?? null });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  return json(res, 404, { error: 'Not found' });
});

{
  const policyError = adminTokenPolicyError(cfg.host, cfg.adminToken);
  if (policyError) {
    console.error(`[oracle] ${policyError}`);
    process.exit(1);
  }
}

server.listen(cfg.port, cfg.host, () => {
  if (!cfg.adminToken) {
    console.warn('[oracle] WARNING: ORACLE_ADMIN_TOKEN is unset — /attest, /flag, and /epoch are UNAUTHENTICATED. Set a token before exposing this service.');
  }
  console.log(`[oracle] HTTP on ${cfg.host}:${cfg.port}  epoch every ${cfg.epochMs / 3_600_000}h  attest cooldown ${ATTEST_COOLDOWN_MS / 1000}s`);
  console.log(`[oracle] state path: ${getStatePath()}`);
  loadState();
  runEpoch().catch(err => console.error('[oracle] startup epoch error:', err.message));
  setInterval(() => runEpoch().catch(err => console.error('[oracle] scheduled epoch error:', err.message)), cfg.epochMs);
});
