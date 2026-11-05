'use strict';

// Loaded with --require, for a process whose poll is minutes apart in real life: a repeating timer
// fires in 50 ms instead. Nothing else about the process changes.
const realSetInterval = global.setInterval;
global.setInterval = (fn, _ms, ...args) => realSetInterval(fn, 50, ...args);
