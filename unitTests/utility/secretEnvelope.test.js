'use strict';

// Unit tests for the pure secret-envelope codec (utility/secretEnvelope.ts), ported with the
// module from harper-pro: happy-path round-trips (including a >2KB value proving the hybrid
// envelope), kid mismatch, GCM tamper rejection, and malformed-envelope rejection.

const assert = require('node:assert');
const { generateKeyPairSync, createPublicKey } = require('node:crypto');
const { fingerprintOf, encryptEnvelope, decryptEnvelope, parseEnvelopeFields } = require('#src/utility/secretEnvelope');

// 2048-bit keys keep keygen fast; the envelope code paths are identical at any RSA size.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const fp = fingerprintOf(publicKey);

// Re-serialize an envelope body after mutating its fields (to forge tampered/malformed envelopes).
const reencode = (body, mutate) => {
	const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	mutate(obj);
	return Buffer.from(JSON.stringify(obj)).toString('base64url');
};

describe('secretEnvelope codec', () => {
	describe('round-trip (client encrypt -> server decrypt)', () => {
		const samples = [
			'sk-1234567890',
			'p@ss w#rd"with\'quotes',
			'multi\nline\nvalue',
			'-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(2000) + '\n-----END PRIVATE KEY-----\n', // > RSA max: needs hybrid
			'unicode: café 🔐 日本語',
			'',
		];
		for (const s of samples) {
			it(`recovers ${JSON.stringify(s.length > 24 ? s.slice(0, 24) + '…' : s)}`, () => {
				assert.equal(decryptEnvelope(encryptEnvelope(s, publicKey, fp), privateKey, fp), s);
			});
		}
	});

	it('fingerprint is stable and derivable from the private key', () => {
		assert.equal(fingerprintOf(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })), fp);
	});

	it('parseEnvelopeFields exposes the sealed kid without decrypting', () => {
		const fields = parseEnvelopeFields(encryptEnvelope('x', publicKey, fp));
		assert.equal(fields.kid, fp);
		assert.equal(typeof fields.ct, 'string');
	});

	describe('deny paths', () => {
		it('rejects an envelope encrypted for a different key (wrong kid)', () => {
			const body = encryptEnvelope('x', publicKey, 'deadbeef');
			assert.throws(() => decryptEnvelope(body, privateKey, fp), /no secrets key for kid/);
		});

		it('rejects a tampered ciphertext (GCM auth)', () => {
			const tampered = reencode(encryptEnvelope('secret', publicKey, fp), (o) => {
				const ct = Buffer.from(o.ct, 'base64');
				ct[0] ^= 0xff;
				o.ct = ct.toString('base64');
			});
			assert.throws(() => decryptEnvelope(tampered, privateKey, fp));
		});

		it('rejects a tampered authentication tag', () => {
			const tampered = reencode(encryptEnvelope('secret', publicKey, fp), (o) => {
				const tag = Buffer.from(o.tag, 'base64');
				tag[0] ^= 0xff;
				o.tag = tag.toString('base64');
			});
			assert.throws(() => decryptEnvelope(tampered, privateKey, fp));
		});

		it('rejects malformed envelopes (not JSON, wrong type, missing field, non-string kid)', () => {
			assert.throws(() => decryptEnvelope('!!!not-base64-json', privateKey, fp), /malformed secret envelope/);
			const arrayBody = Buffer.from(JSON.stringify([]), 'utf8').toString('base64url');
			assert.throws(() => decryptEnvelope(arrayBody, privateKey, fp), /malformed secret envelope/);
			const missingTag = reencode(encryptEnvelope('x', publicKey, fp), (o) => delete o.tag);
			assert.throws(() => decryptEnvelope(missingTag, privateKey, fp), /malformed secret envelope/);
			const numericKid = reencode(encryptEnvelope('x', publicKey, fp), (o) => (o.kid = 42));
			assert.throws(() => parseEnvelopeFields(numericKid), /malformed secret envelope/);
			const nonBase64 = reencode(encryptEnvelope('x', publicKey, fp), (o) => (o.k = '!not base64!'));
			assert.throws(() => parseEnvelopeFields(nonBase64), /malformed secret envelope/);
			const emptyIv = reencode(encryptEnvelope('x', publicKey, fp), (o) => (o.iv = ''));
			assert.throws(() => parseEnvelopeFields(emptyIv), /malformed secret envelope/);
		});
	});
});
