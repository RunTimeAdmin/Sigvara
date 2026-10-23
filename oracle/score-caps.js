'use strict';

// The most each of the six factors can contribute to a score. They sum to 100.
//
// These mirror the MAX_*_SCORE constants in SigvaraReputation.sol, which the contract enforces on every
// proposal: a factor above its cap reverts the whole proposal. They were written out as bare numbers in
// scoring.js, payments.js and external.js, and payments.js already records two occasions when a cap moved
// and a copy did not. Kept here once, with score-caps.test.js reading the contract, a reweight is one edit
// plus a failing test if the contract was not changed with it.
const CAPS = Object.freeze({
  fee: 20,
  success: 15,
  age: 30,
  external: 25,
  community: 5,
  propagation: 5,
});

module.exports = { CAPS };
