// lib-aws/contract-tokens.js
// Thin re-export of the shared signer in lib-aws/tokens.js.
//
// The signing logic moved to tokens.js (general purpose, app-wide) on
// June 3. Contracts callers keep importing ./lib/contract-tokens unchanged;
// the functions forward to the shared implementation. Identical behavior,
// same secret, same signatures. Callers may migrate to require ./lib/tokens
// directly later as trivial cleanup.

module.exports = require('./tokens');
