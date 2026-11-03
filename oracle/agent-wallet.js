'use strict';

/**
 * The signature that makes the ERC-8004 publisher the agentWallet of Sigvara's own registration
 * (docs/adr/0008-sigvara-as-erc8004-signal-provider.md, runbook section 5, step 2).
 *
 * setAgentWallet(agentId, newWallet, deadline, signature) on the ERC-8004 Identity Registry needs
 * an EIP-712 signature from the new wallet over AgentWalletSet(agentId, newWallet, owner,
 * deadline), and refuses a deadline more than five minutes after the block that runs it. The
 * publisher's key is in the remote signer, and the registration's owner is the deployer, so the two
 * halves happen in one sitting: this asks the remote signer for the signature and prints it, and
 * script/SetAgentWallet.s.sol sends it from the owner, inside the window.
 *
 *   node agent-wallet.js
 *
 * Env: RPC_URL, EXTERNAL_IDENTITY_ADDRESS, SIGVARA_ERC8004_AGENT_ID, PUBLISHER_ADDRESS,
 * PUBLISH_SIGNER_URL, PUBLISH_SIGNER_SECRET (the publisher's, so it runs inside the publisher's
 * container: docker exec sigvara-publisher node agent-wallet.js). Prints DEADLINE=... and
 * SIGNATURE=... for the Forge script. Neither is a
 * secret: the signature is only good for this agent, this wallet, this owner and five minutes.
 */

const { ethers } = require('ethers');
const signerAuth = require('./signer-auth');

// The window setAgentWallet allows, and how much of it to use: enough left to send the transaction.
const MAX_DEADLINE_DELAY = 300;
const DEADLINE_AHEAD = 240;

/** The EIP-712 typed data setAgentWallet checks, in the shape eth_signTypedData_v4 takes. */
function agentWalletTypedData({ chainId, registry, agentId, newWallet, owner, deadline }) {
  return {
    domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: Number(chainId), verifyingContract: ethers.getAddress(registry) },
    types: {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet',
    message: {
      agentId: BigInt(agentId).toString(),
      newWallet: ethers.getAddress(newWallet),
      owner: ethers.getAddress(owner),
      deadline: BigInt(deadline).toString(),
    },
  };
}

/** Whether `signature` is `newWallet`'s over the typed data. */
function signedBy(typed, signature) {
  const recovered = ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature);
  return recovered.toLowerCase() === typed.message.newWallet.toLowerCase();
}

/**
 * Asks the remote signer (Web3Signer and most others answer eth_signTypedData_v4; some name it
 * eth_signTypedData) for the publisher's signature, and checks it recovers to the publisher before
 * returning it.
 */
async function requestSignature(signerUrl, typed, secret) {
  const ask = async (method) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [typed.message.newWallet, JSON.stringify({ ...typed, types: { EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ], ...typed.types } })] });
    const res = await fetch(signerUrl, {
      method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', [signerAuth.HEADER]: signerAuth.authHeader(secret, body) },
    });
    return res.status === 200 ? res.json() : { error: { message: `HTTP ${res.status}` } };
  };
  let body = await ask('eth_signTypedData_v4');
  if (body.error && /method|not (found|supported)/i.test(body.error.message || '')) body = await ask('eth_signTypedData');
  if (body.error) throw new Error(`signer: ${body.error.message || JSON.stringify(body.error)}`);
  if (!signedBy(typed, body.result)) throw new Error('the signer returned a signature that is not the publisher\'s; not used');
  return body.result;
}

async function main(env = process.env) {
  const need = (name) => {
    const v = String(env[name] ?? '').trim();
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const provider = new ethers.JsonRpcProvider(need('RPC_URL'));
  const registry = ethers.getAddress(need('EXTERNAL_IDENTITY_ADDRESS'));
  const agentId = need('SIGVARA_ERC8004_AGENT_ID');
  const newWallet = ethers.getAddress(need('PUBLISHER_ADDRESS'));
  const chainId = (await provider.getNetwork()).chainId;
  const owner = await new ethers.Contract(registry, ['function ownerOf(uint256) view returns (address)'], provider).ownerOf(agentId);
  // The chain's clock, which is what setAgentWallet compares the deadline with.
  const now = (await provider.getBlock('latest')).timestamp;
  const deadline = now + DEADLINE_AHEAD;
  const typed = agentWalletTypedData({ chainId, registry, agentId, newWallet, owner, deadline });
  const signature = await requestSignature(need('PUBLISH_SIGNER_URL'), typed, need('PUBLISH_SIGNER_SECRET'));
  console.log(`# agent ${agentId}, owner ${owner}, new agentWallet ${newWallet}; send within ${DEADLINE_AHEAD} s`);
  console.log(`DEADLINE=${deadline}`);
  console.log(`SIGNATURE=${signature}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[agent-wallet] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { agentWalletTypedData, signedBy, requestSignature, MAX_DEADLINE_DELAY, DEADLINE_AHEAD };
