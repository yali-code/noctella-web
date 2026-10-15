'use strict';
// Offline contract example only. Not imported by the application.
const fields = ['tenantId', 'actorId', 'productId', 'kind', 'token', 'sha256', 'altText'];
function classify(stored, incoming) {
  if (!incoming || fields.some(key => typeof incoming[key] !== 'string' || incoming[key].length === 0)) return 'INVALID';
  if (stored === null) return 'NEW';
  if (!stored || fields.some(key => stored[key] !== incoming[key])) return 'CONFLICT';
  return 'SAME_INTENT';
}
module.exports = { classify };
