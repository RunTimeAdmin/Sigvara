/* Shared DID derivation for every Sigvara page.
 *
 * didHash = keccak256(abi.encodePacked("did:sigvara:", uint256 chainId, ":", address)),
 * the same expression SigvaraIdentity evaluates. It is computed on chain at registration
 * precisely so that anyone can reproduce it without asking, and app.js used to ask
 * anyway: one eth_call, ~124 ms, for a pure function of two values it already had.
 *
 * This lives in its own file because demo.js had the implementation and app.js did not,
 * and the page that needed it most was the one paying a network round trip. Copying it
 * across would have left two keccaks to drift apart; there is one, and both pages load it.
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

  var api = {
    keccak256: keccak256,
    computeDidHash: computeDidHash,
    formatDid: formatDid,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes,
    utf8: utf8,
    concat: concat,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SigvaraDid = api;
})(typeof window !== 'undefined' ? window : globalThis);
