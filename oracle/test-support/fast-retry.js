'use strict';

// Loaded with --require beside fast-interval.js, for a process test that waits through several runs, each of which
// fails only after readWithBackoff's whole schedule (about 24 s for a node refusing for its rate limit). A wait of
// 250 ms or more is cut to 10 ms; shorter ones are left alone.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 250 ? 10 : ms, ...args);
