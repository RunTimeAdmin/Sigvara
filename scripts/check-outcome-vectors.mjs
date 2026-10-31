// The payment-outcome vectors (ADR 0006, Rollout 2), regenerated and compared.
//
// test/vectors/payment-outcome.json is what the SDK, the oracle and any other implementation
// check their signing and verifying against. test/vectors/PaymentOutcomeVectors.sol holds the
// same cases for test/PaymentOutcome.t.sol, which checks them on chain with OpenZeppelin's own
// EIP712 and SignatureChecker. Both are generated here, from the oracle's type and the testnet
// deployment, and this runs as a gate so neither can drift from the other or from the code.
//
// Every key is keccak256("sigvara/payment-outcome/vector/<name>"), so the Solidity test derives
// the same ones and no key is stored anywhere. Signatures are deterministic (RFC 6979) in both
// ethers and Foundry, so the Solidity test signs again and must get the same bytes.
//
// Run with --write to update both files after a deliberate change.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../oracle/package.json', import.meta.url));
const { ethers } = require('ethers');
const payerOutcome = require('./payer-outcome.js');

const JSON_PATH = 'test/vectors/payment-outcome.json';
const SOL_PATH = 'test/vectors/PaymentOutcomeVectors.sol';
const LABEL = 'sigvara/payment-outcome/vector/';

const TYPE_STRING =
  'PaymentOutcome(bytes32 didHash,bytes32 txHash,address payer,uint8 outcome,bytes32 evidence,uint64 signedAt,uint64 deadline)';
if (ethers.TypedDataEncoder.from(payerOutcome.TYPES).encodeType('PaymentOutcome') !== TYPE_STRING) {
  console.error('outcome vectors: the oracle\'s PaymentOutcome type is not the one ADR 0006 defines');
  process.exit(1);
}

const deployment = JSON.parse(readFileSync('deployments/5042002.json', 'utf8'));
const domain = payerOutcome.domain(deployment.chainId, deployment.reputation);
// Signed under the wrong domain: Arc mainnet's chain id, and another Sigvara contract.
const otherChain = payerOutcome.domain(5042, deployment.reputation);
const otherContract = payerOutcome.domain(deployment.chainId, deployment.identity);

const keyOf = (name) => ethers.keccak256(ethers.toUtf8Bytes(LABEL + name));
const wallets = Object.fromEntries(['payer', 'owner', 'other'].map((n) => [n, new ethers.Wallet(keyOf(n))]));
const ACCOUNT = ethers.getAddress(ethers.dataSlice(ethers.keccak256(ethers.toUtf8Bytes(`${LABEL}account`)), 12));

const base = {
  didHash: ethers.id(`${LABEL}agent`),
  txHash: ethers.id(`${LABEL}settlement`),
  payer: wallets.payer.address,
  outcome: 1,
  evidence: ethers.ZeroHash,
  signedAt: 1793400000,
  deadline: 1793486400,
};
const digestOf = (dom, message) => ethers.TypedDataEncoder.hash(dom, payerOutcome.TYPES, message);
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function signed(name, about, { message = base, under = domain, by = 'payer', account = null, valid, onChainOnly = false }) {
  const signature = wallets[by].signingKey.sign(digestOf(under, message)).serialized;
  return {
    name,
    about,
    message,
    signedUnder: { chainId: Number(under.chainId), verifyingContract: under.verifyingContract },
    signedBy: by,
    digest: digestOf(domain, message),
    signature,
    account,
    valid,
    ...(onChainOnly ? { onChainOnly } : {}),
  };
}

const cases = [];
cases.push(signed('eoa_delivered', 'The payer\'s own key signs "delivered" for its leg.', { valid: true }));
cases.push(signed('eoa_not_delivered', 'The payer signs "not delivered", pointing at what it received.', {
  message: { ...base, outcome: 2, evidence: ethers.id(`${LABEL}response`) }, valid: true,
}));
cases.push(signed('other_payers_leg', 'The payer signs, naming another sender\'s leg as payer.', {
  message: { ...base, payer: wallets.other.address }, valid: false,
}));
cases.push(signed('wrong_chain', 'Signed for the same contract address on another chain.', { under: otherChain, valid: false }));
cases.push(signed('wrong_contract', 'Signed for another Sigvara contract on the right chain.', { under: otherContract, valid: false }));
{
  const sig = ethers.Signature.from(cases[0].signature);
  const twin = ethers.concat([sig.r, ethers.toBeHex(N - BigInt(sig.s), 32), ethers.toBeHex(sig.v === 27 ? 28 : 27, 1)]);
  cases.push({
    ...cases[0],
    name: 'malleable_twin',
    about: 'eoa_delivered with s replaced by n - s and v flipped: it recovers the payer, and OpenZeppelin refuses a high s.',
    signedBy: null,
    signature: twin,
    valid: false,
  });
}
const contract = { ...base, payer: ACCOUNT };
const owned = { kind: 'owner', owner: wallets.owner.address };
cases.push(signed('contract_owner', 'A smart account answers ERC-1271 for a signature by its owner.', {
  message: contract, by: 'owner', account: owned, valid: true,
}));
cases.push(signed('contract_not_owner', 'A key that does not own the account signs for it.', {
  message: contract, by: 'other', account: owned, valid: false,
}));
cases.push(signed('contract_rotated', 'contract_owner\'s signature, checked after the account changed owner.', {
  message: contract, by: 'owner', account: { kind: 'owner', owner: wallets.other.address }, valid: false,
}));
cases.push(signed('contract_longer_answer', 'The account answers the magic value followed by more data, which OpenZeppelin accepts.', {
  message: contract, by: 'owner', account: { kind: 'longer', owner: wallets.owner.address }, valid: true,
}));
cases.push(signed('contract_short_answer', 'The account answers the four magic bytes alone, short of a word, which OpenZeppelin refuses.', {
  message: contract, by: 'owner', account: { kind: 'short', owner: wallets.owner.address }, valid: false,
}));
cases.push(signed('contract_writes_state', 'The account writes storage while answering. On chain the static call reverts, so OpenZeppelin refuses; '
  + 'an eth_call is not static and cannot see it, so the oracle and the SDK accept it. ERC-1271 forbids such an account.', {
  message: contract, by: 'owner', account: { kind: 'writes', owner: wallets.owner.address }, valid: false, onChainOnly: true,
}));

// The timing checks, which need no key: payerOutcome.timingProblem and checkedBlockProblem. Times
// are seconds. `now` is the checking host's clock, `checkedAt` the time of the block the signature
// is checked at.
const T = { settledAt: 1793399000, now: 1793400100, checkedAt: 1793400060, signedAt: 1793400000, deadline: 1793486400 };
const timing = [
  { name: 'in_time', ...T, refusal: null },
  { name: 'before_settlement', ...T, signedAt: T.settledAt - 1, refusal: 'before_settlement' },
  { name: 'from_the_future', ...T, signedAt: T.now + 301, deadline: T.now + 301 + 86400, refusal: 'future' },
  { name: 'deadline_too_far', ...T, deadline: T.signedAt + 30 * 86400 + 1, refusal: 'deadline_too_far' },
  { name: 'deadline_passed_at_block', ...T, deadline: T.checkedAt, refusal: 'deadline_passed' },
  { name: 'deadline_passed_by_clock_only', ...T, deadline: T.checkedAt + 1, now: T.checkedAt + 3600, refusal: null },
  { name: 'checked_well_before_signed', ...T, checkedAt: T.signedAt - 3601, refusal: 'checked_before_signed' },
  { name: 'checked_an_hour_before_signed', ...T, checkedAt: T.signedAt - 3600, refusal: null },
];

const vectors = {
  about: 'Payment outcomes signed by the payer (docs/adr/0006-payer-signed-outcomes.md). Generated by '
    + 'scripts/check-outcome-vectors.mjs: do not edit by hand. Each key is keccak256("sigvara/payment-outcome/vector/<name>") '
    + 'and none is stored. A case is valid when OpenZeppelin 5.6.1\'s SignatureChecker accepts its signature for its '
    + 'payer over its digest, which is always under `domain`. An account of kind owner, longer, short or writes answers '
    + 'ERC-1271 as test/PaymentOutcome.t.sol\'s accounts do. The cases that need a payment, a clock or state held by an '
    + 'oracle (a second signature, a negative under `positive`, import from a peer, an owner rotating between acceptance '
    + 'and import) are tested end to end in oracle/payer-outcome.test.js.',
  typeString: TYPE_STRING,
  typeHash: ethers.id(TYPE_STRING),
  domain: { ...domain, chainId: Number(domain.chainId) },
  domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
  addresses: {
    payer: wallets.payer.address,
    owner: wallets.owner.address,
    other: wallets.other.address,
    account: ACCOUNT,
  },
  cases,
  timing,
};
const json = `${JSON.stringify(vectors, null, 2)}\n`;

// ---- Solidity ----------------------------------------------------------------------------------

const solCase = (c, i) => `        c[${i}] = Case({
            name: "${c.name}",
            didHash: ${c.message.didHash},
            txHash: ${c.message.txHash},
            payer: ${c.message.payer},
            outcome: ${c.message.outcome},
            evidence: ${c.message.evidence},
            signedAt: ${c.message.signedAt},
            deadline: ${c.message.deadline},
            signedChainId: ${c.signedUnder.chainId},
            signedContract: ${c.signedUnder.verifyingContract},
            signedBy: "${c.signedBy ?? ''}",
            digest: ${c.digest},
            signature: hex"${c.signature.slice(2)}",
            account: "${c.account?.kind ?? ''}",
            accountOwner: ${c.account?.owner ?? ethers.ZeroAddress},
            valid: ${c.valid}
        });`;

const sol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Generated by scripts/check-outcome-vectors.mjs from the same cases as test/vectors/payment-outcome.json.
// Do not edit: change the script and run it with --write.
library PaymentOutcomeVectors {
    struct Case {
        string name;
        bytes32 didHash;
        bytes32 txHash;
        address payer;
        uint8 outcome;
        bytes32 evidence;
        uint64 signedAt;
        uint64 deadline;
        uint256 signedChainId;
        address signedContract;
        string signedBy;
        bytes32 digest;
        bytes signature;
        string account;
        address accountOwner;
        bool valid;
    }

    string internal constant TYPE_STRING =
        "${TYPE_STRING}";
    bytes32 internal constant TYPE_HASH = ${vectors.typeHash};
    uint256 internal constant CHAIN_ID = ${vectors.domain.chainId};
    address internal constant REPUTATION = ${vectors.domain.verifyingContract};
    bytes32 internal constant DOMAIN_SEPARATOR = ${vectors.domainSeparator};
    address internal constant PAYER = ${vectors.addresses.payer};
    address internal constant OWNER = ${vectors.addresses.owner};
    address internal constant OTHER = ${vectors.addresses.other};
    address internal constant ACCOUNT = ${vectors.addresses.account};

    function cases() internal pure returns (Case[] memory c) {
        c = new Case[](${cases.length});
${cases.map(solCase).join('\n')}
    }
}
`;

const write = process.argv.includes('--write');
const drift = [[JSON_PATH, json], [SOL_PATH, sol]].filter(([p, want]) => {
  try {
    return readFileSync(p, 'utf8') !== want;
  } catch {
    return true;
  }
});

if (!drift.length) {
  console.log(`outcome vectors check: ok (${cases.length} cases, ${timing.length} timing cases)`);
  process.exit(0);
}
if (!write) {
  console.error(`outcome vectors check: FAILED. ${drift.map(([p]) => p).join(' and ')} would change.`);
  console.error('If the type, the domain or a case changed on purpose, rerun with --write and review the diff.');
  process.exit(1);
}
for (const [p, want] of drift) writeFileSync(p, want);
console.log(`outcome vectors: wrote ${drift.map(([p]) => p).join(' and ')}`);
