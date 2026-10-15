'use strict';
// Offline-only shape comparison. No authorization, persistence or DB atomicity.
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCOPE = /^[A-Za-z0-9:_-]{1,128}$/;
function valid(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  if (!['tenantId','actorId','productId'].every(k => typeof x[k] === 'string' && SCOPE.test(x[k]))) return false;
  if (x.kind !== 'W2_PRODUCT_PHOTO_UPLOAD') return false;
  if (typeof x.token !== 'string' || !TOKEN.test(x.token)) return false;
  if (typeof x.sha256 !== 'string' || !SHA256.test(x.sha256)) return false;
  if (typeof x.altText !== 'string' || x.altText.length > 500) return false;
  return true;
}
function classify(stored, incoming) {
  if (!valid(incoming)) return 'INVALID';
  if (stored === null) return 'NEW';
  if (!valid(stored)) return 'CONFLICT';
  for (const field of ['tenantId','actorId','productId','kind','token','sha256','altText']) {
    if (stored[field] !== incoming[field]) return 'CONFLICT';
  }
  return 'SAME_INTENT';
}
module.exports = { classify };
