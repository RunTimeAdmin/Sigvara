'use strict';

/**
 * A byte-bounded LRU for already-serialized responses, invalidated by a revision token.
 *
 * Built for `/evidence`, which is the most expensive thing an unauthenticated stranger
 * can ask this service to do: it hashes a Merkle tree over an agent's whole payment
 * history, derives one proof per payment, and serializes the lot. That is O(E log E) in
 * CPU and allocation for a response that does not change between payments, and the
 * callers are auditors, browsers and independent verifiers who ask for the same agent
 * repeatedly. Measured elsewhere at 5,000 events: ~1.4s and ~5.5MB of JSON, per request.
 *
 * ## Revision, not invalidation
 *
 * Entries carry a `revision` and are served only when the caller presents the identical
 * one (`===`, not deep equality). For payment evidence the revision is the event array
 * itself, because the store never mutates a list in place: creditPayment sets a new
 * array, prunePaymentEvents sets a new array when it actually dropped something, and
 * loading state builds fresh arrays. So "the data changed" and "the array identity
 * changed" are the same event, and there is nothing to remember to invalidate.
 *
 * That is deliberate. The alternative, calling invalidate() after each credit and each
 * prune, is one forgotten call away from serving stale evidence, and stale evidence from
 * an endpoint whose purpose is letting people check the operator is worse than no cache.
 * This way a missed case degrades to a cache miss.
 *
 * ## Bounds
 *
 * Capped by total serialized bytes rather than entry count, because entry size here
 * spans orders of magnitude: one agent with 5,000 payments outweighs thousands of small
 * ones. Eviction is least-recently-used, taken from Map insertion order, with a hit
 * moving its entry to the back. An entry larger than the whole budget is served and not
 * stored, rather than evicting everything else to hold one response.
 */
function createResponseCache({ maxBytes }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(`response cache: maxBytes must be a positive integer, got ${maxBytes}`);
  }

  const entries = new Map(); // key -> { revision, body, bytes }
  let totalBytes = 0;
  const stats = { hits: 0, misses: 0, evictions: 0 };

  function evictTo(limit) {
    // Map iterates in insertion order, and a hit re-inserts, so the front is the least
    // recently used.
    for (const key of entries.keys()) {
      if (totalBytes <= limit) break;
      totalBytes -= entries.get(key).bytes;
      entries.delete(key);
      stats.evictions++;
    }
  }

  return {
    /**
     * Serialized body for `key`, built by `build()` on a miss.
     *
     * `build` must return the finished string. It is called synchronously and only when
     * needed, so an expensive build is skipped entirely on a hit.
     */
    get(key, revision, build) {
      const hit = entries.get(key);
      if (hit && hit.revision === revision) {
        // Re-insert to move it to the back of the LRU order.
        entries.delete(key);
        entries.set(key, hit);
        stats.hits++;
        return hit.body;
      }
      stats.misses++;

      const body = build();
      const bytes = Buffer.byteLength(body);

      // A stale entry for this key is replaced, not left behind.
      if (hit) {
        totalBytes -= hit.bytes;
        entries.delete(key);
      }

      // Serve, but do not store, anything that cannot coexist with a useful cache.
      if (bytes > maxBytes) return body;

      entries.set(key, { revision, body, bytes });
      totalBytes += bytes;
      evictTo(maxBytes);
      return body;
    },

    stats() {
      return { ...stats, entries: entries.size, bytes: totalBytes };
    },

    clear() {
      entries.clear();
      totalBytes = 0;
    },
  };
}

module.exports = { createResponseCache };
