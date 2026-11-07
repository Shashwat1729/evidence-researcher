// Receipt signing/verification: valid, tampered, wrong key, canonicalization.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, signReceipt, verifyReceipt, keysDocument, kidFor, _resetSigningKey, signingKey } from '../backend/src/receipt.js';

beforeEach(() => { delete process.env.RECEIPT_PRIVATE_KEY_PEM; _resetSigningKey(); });

const base = () => ({
  order: 'task_1', listing: 'evidence-researcher', seller: '', buyer: 'agent_1',
  amount_minor: 500, currency: 'chf', delivered_at: '2026-10-08T10:00:00.000Z',
  input: { question: 'q' }, delivery: { ok: true, claims: 3 },
});

describe('canonicalJson', () => {
  it('is deterministic regardless of key order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
    assert.equal(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }), '{"a":{"c":3,"d":2},"b":1}');
  });
  it('handles arrays and nested values', () => {
    assert.equal(canonicalJson({ z: [1, { y: 2, x: 1 }] }), '{"z":[1,{"x":1,"y":2}]}');
  });
});

describe('sign/verify', () => {
  it('round-trips a valid receipt', () => {
    const r = signReceipt(base());
    const { x } = signingKey();
    assert.equal(verifyReceipt(r, x).valid, true);
  });
  it('rejects a tampered payload', () => {
    const r = signReceipt(base());
    r.amount_minor = 9999;
    const { x } = signingKey();
    const v = verifyReceipt(r, x);
    assert.equal(v.valid, false);
    assert.match(v.reason, /mismatch/);
  });
  it('rejects a wrong key', () => {
    const r = signReceipt(base());
    const kid = kidFor('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const v = verifyReceipt(r, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(v.valid, false);
  });
  it('rejects a stripped signature', () => {
    const r = signReceipt(base());
    delete r.sig;
    const { x } = signingKey();
    assert.equal(verifyReceipt(r, x).valid, false);
  });
  it('produces stable kid from public key', () => {
    const k = signingKey();
    assert.equal(kidFor(k.x), k.kid);
  });
});

describe('keysDocument', () => {
  it('exposes the public key only', () => {
    const doc = keysDocument();
    assert.equal(doc.alg, 'Ed25519');
    assert.equal(doc.keys.length, 1);
    assert.equal(doc.keys[0].kty, 'OKP');
    assert.equal(doc.keys[0].crv, 'Ed25519');
    assert.ok(doc.keys[0].x.length > 20);
    assert.equal(doc.keys[0].d, undefined);
  });
});
