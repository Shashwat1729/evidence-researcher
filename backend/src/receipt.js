// Delivery receipts: Ed25519-signed, canonical-JSON, following the open
// Trust Protocol 1.0 conventions (same envelope shape as marketplace v1
// receipts): canonical JSON (keys sorted, no whitespace), sig = base64url
// Ed25519 over canonical(object without "sig"), kid = first 16 hex of
// sha256(public key), hashes = lowercase hex sha256 of UTF-8 bytes.
//
// Key management: RECEIPT_PRIVATE_KEY_PEM (PEM, base64 or raw) signs; the
// matching public key is published at /.well-known/receipts.json. When unset
// we generate an ephemeral key per process (development only — receipts then
// do not survive restarts, and the well-known doc changes on every boot).

import crypto from 'node:crypto';

export function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** Canonical JSON: keys sorted lexicographically at every level, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** kid = first 16 hex chars of sha256(base64url public key). */
export function kidFor(x) {
  return sha256hex(x).slice(0, 16);
}

function publicKeyFromPem(privatePem) {
  return crypto.createPublicKey(privatePem);
}

/** { x, kid } for a PEM private key's public half. */
export function publicInfo(privateKey) {
  const pub = publicKeyFromPem(privateKey);
  const jwk = pub.export({ format: 'jwk' });
  return { x: jwk.x, kid: kidFor(jwk.x) };
}

let cached = null;

/** Signing key from env, else ephemeral. Returns { privateKey, x, kid }. */
export function signingKey() {
  if (cached) return cached;
  const raw = (process.env.RECEIPT_PRIVATE_KEY_PEM || '').trim();
  let privateKey;
  if (raw) {
    // Accept raw PEM or base64-of-PEM (env-friendly single line).
    const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    privateKey = crypto.createPrivateKey(pem);
  } else {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
  }
  const pub = crypto.createPublicKey(privateKey);
  const x = pub.export({ format: 'jwk' }).x;
  cached = { privateKey, x, kid: kidFor(x) };
  return cached;
}

/** Reset the cached key (tests). */
export function _resetSigningKey() { cached = null; }

/**
 * Build + sign a delivery receipt.
 * payload: { order, listing, seller, buyer, amount_minor, currency, delivered_at, input, delivery }
 * input/delivery may be objects (hashed via canonical JSON) or raw strings
 * (hashed as-is). delivery_sha256 follows the protocol: sha256 of the exact
 * delivery payload text.
 */
export function signReceipt(payload) {
  const { privateKey, x, kid } = signingKey();
  const hashOf = (v) => (typeof v === 'string' ? sha256hex(v) : sha256hex(canonicalJson(v)));
  const body = {
    v: 1,
    issuer: process.env.RECEIPT_ISSUER || 'evidence-researcher',
    kid,
    order: String(payload.order || ''),
    listing: String(payload.listing || ''),
    seller: String(payload.seller || ''),
    buyer: String(payload.buyer || ''),
    amount_minor: Number.isFinite(+payload.amount_minor) ? +payload.amount_minor : 0,
    currency: String(payload.currency || 'chf').toLowerCase(),
    delivered_at: payload.delivered_at || new Date().toISOString(),
    input_sha256: hashOf(payload.input ?? ''),
    delivery_sha256: hashOf(payload.delivery ?? ''),
  };
  const sig = crypto.sign(null, Buffer.from(canonicalJson(body), 'utf8'), privateKey);
  return { ...body, sig: b64url(sig) };
}

/** Verify a receipt against a known public key x (base64url JWK x). */
export function verifyReceipt(receipt, x) {
  try {
    const { sig, ...rest } = receipt || {};
    if (!sig || !x) return { valid: false, reason: 'missing sig or key' };
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    const ok = crypto.verify(null, Buffer.from(canonicalJson(rest), 'utf8'), pub, Buffer.from(sig, 'base64url'));
    return ok ? { valid: true } : { valid: false, reason: 'signature mismatch' };
  } catch (e) {
    return { valid: false, reason: String(e?.message || 'bad receipt').slice(0, 120) };
  }
}

/** Public keys document for /.well-known/receipts.json. */
export function keysDocument() {
  const { x, kid } = signingKey();
  return {
    issuer: process.env.RECEIPT_ISSUER || 'evidence-researcher',
    alg: 'Ed25519',
    canonical: 'JSON with sorted keys, without "sig"',
    keys: [{ kid, kty: 'OKP', crv: 'Ed25519', x }],
  };
}
