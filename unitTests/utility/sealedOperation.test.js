'use strict';

// The WebCrypto cases build and open payloads with an independent implementation (what a browser
// client does), so a matching bug in the reference helper and the node cannot certify itself.

const assert = require('node:assert');
const { generateKeyPairSync, webcrypto, createHash } = require('node:crypto');
const sealed = require('#src/utility/sealedOperation');
const { fingerprintOf, decryptEnvelope } = require('#src/utility/secretEnvelope');
const { OPERATIONS_ENUM } = require('#src/utility/hdbTerms');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const kid = fingerprintOf(publicKey);
const PREFIX = 'enc:v1:';

function openHeader(request) {
	return JSON.parse(decryptEnvelope(request.envelope.slice(PREFIX.length), privateKey, kid));
}

describe('sealedOperation', () => {
	it('names the operation the node registers', () => {
		const { request } = sealed.sealOperation({ op: { operation: 'describe_all' }, publicKey, kid });
		assert.strictEqual(request.operation, OPERATIONS_ENUM.ENCRYPTED_OPERATION);
	});

	describe('sealOperation, sealed mode', () => {
		it('puts the whole operation, a fresh response key and nonce in the envelope', () => {
			const op = { operation: 'insert', table: 'dog', records: [{ id: 1, secret: 'marker-1' }] };
			const { request, responseKey, nonce } = sealed.sealOperation({ op, publicKey, kid, actor: 'ann', now: 1234 });
			assert.deepStrictEqual(Object.keys(request).sort(), ['envelope', 'operation']);
			assert.ok(!JSON.stringify(request).includes('marker-1'));
			const header = openHeader(request);
			assert.deepStrictEqual(header, {
				v: 1,
				rk: responseKey.toString('base64'),
				nonce,
				ts: 1234,
				actor: 'ann',
				op,
			});
			assert.strictEqual(responseKey.length, 32);
			assert.strictEqual(Buffer.from(nonce, 'base64').length, 16);
		});

		it('never reuses a response key or nonce', () => {
			const first = sealed.sealOperation({ op: { operation: 'describe_all' }, publicKey, kid });
			const second = sealed.sealOperation({ op: { operation: 'describe_all' }, publicKey, kid });
			assert.notDeepStrictEqual(first.responseKey, second.responseKey);
			assert.notStrictEqual(first.nonce, second.nonce);
		});
	});

	describe('sealOperation, fields mode', () => {
		it('keeps operation and structural keys visible and seals every other top-level value at its pointer', () => {
			const op = {
				'operation': 'insert',
				'database': 'data',
				'table': 'dog',
				'records': [{ id: 1, secret: 'marker-2' }],
				'a/b~c': 'escaped-key-value',
			};
			const { request, responseKey, nonce } = sealed.sealOperation({ op, publicKey, kid, mode: 'fields' });
			assert.strictEqual(request.mode, 'fields');
			assert.ok(!request.op.includes('marker-2'));
			const visible = JSON.parse(request.op);
			assert.strictEqual(visible.operation, 'insert');
			assert.strictEqual(visible.database, 'data');
			assert.strictEqual(visible.table, 'dog');
			assert.deepStrictEqual(Object.keys(visible.records), ['$sealed']);
			assert.deepStrictEqual(sealed.openValue(visible.records.$sealed, responseKey, nonce, '/records'), op.records);
			assert.strictEqual(
				sealed.openValue(visible['a/b~c'].$sealed, responseKey, nonce, '/a~1b~0c'),
				'escaped-key-value'
			);
			const header = openHeader(request);
			assert.strictEqual(header.op, undefined);
			assert.strictEqual(header.oph, createHash('sha256').update(request.op, 'utf8').digest('base64'));
		});

		it('binds a sealed value to its location', () => {
			const { request, responseKey, nonce } = sealed.sealOperation({
				op: { operation: 'insert', a: 'one', b: 'two' },
				publicKey,
				kid,
				mode: 'fields',
			});
			const visible = JSON.parse(request.op);
			assert.throws(() => sealed.openValue(visible.a.$sealed, responseKey, nonce, '/b'));
			assert.throws(() => sealed.openValue(visible.a.$sealed, responseKey, 'AAAAAAAAAAAAAAAAAAAAAA==', '/a'));
		});

		it('refuses a value with no JSON representation', () => {
			assert.throws(
				() => sealed.sealOperation({ op: { operation: 'x', fn: undefined }, publicKey, kid, mode: 'fields' }),
				/no JSON representation/
			);
		});
	});

	describe('responses', () => {
		const responseKey = Buffer.alloc(32, 7);
		const nonce = Buffer.alloc(16, 9).toString('base64');

		it('round-trips status, body and the executed flag', () => {
			const payload = sealed.sealResponse('{"status":413,"body":{"error":"big"},"executed":true}', responseKey, nonce);
			assert.deepStrictEqual(sealed.openResponse(payload, responseKey, nonce), {
				status: 413,
				body: { error: 'big' },
				executed: true,
			});
		});

		it('fails on a tampered ciphertext, a wrong nonce or a wrong key', () => {
			const payload = sealed.sealResponse('{"status":200,"body":1}', responseKey, nonce);
			const flipped = Buffer.from(payload.ct, 'base64');
			flipped[0] ^= 1;
			assert.throws(() => sealed.openResponse({ ...payload, ct: flipped.toString('base64') }, responseKey, nonce));
			assert.throws(() => sealed.openResponse(payload, responseKey, Buffer.alloc(16).toString('base64')));
			assert.throws(() => sealed.openResponse(payload, Buffer.alloc(32, 1), nonce));
		});

		it('refuses a malformed payload before decrypting', () => {
			assert.throws(() => sealed.openResponse({ v: 2, iv: '', ct: '', tag: '' }, responseKey, nonce), /malformed/);
			assert.throws(() => sealed.openResponse(undefined, responseKey, nonce), /malformed/);
		});
	});

	describe('helpers', () => {
		it('decodes only strict base64 of the expected length', () => {
			assert.deepStrictEqual(sealed.decodeBase64('AAEC'), Buffer.from([0, 1, 2]));
			assert.strictEqual(sealed.decodeBase64('AAEC', 4), undefined);
			assert.strictEqual(sealed.decodeBase64('AA!C'), undefined);
			assert.strictEqual(sealed.decodeBase64(42), undefined);
		});

		it('escapes JSON Pointer tokens per RFC 6901', () => {
			assert.strictEqual(sealed.pointerToken('a/b~c'), 'a~1b~0c');
			assert.strictEqual(sealed.pointerToken(3), '3');
		});
	});

	describe('interoperates with an independent WebCrypto client', () => {
		const { subtle } = webcrypto;
		const responseKey = Buffer.alloc(32, 3);
		const nonce = Buffer.alloc(16, 5).toString('base64');

		async function importAesKey() {
			return subtle.importKey('raw', responseKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
		}

		it('opens a response the node sealed', async () => {
			const payload = sealed.sealResponse('{"status":200,"body":{"ok":true}}', responseKey, nonce);
			const ctAndTag = Buffer.concat([Buffer.from(payload.ct, 'base64'), Buffer.from(payload.tag, 'base64')]);
			const plaintext = await subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: Buffer.from(payload.iv, 'base64'),
					additionalData: Buffer.from(`harper.encrypted_operation.response:${nonce}`),
					tagLength: 128,
				},
				await importAesKey(),
				ctAndTag
			);
			assert.deepStrictEqual(JSON.parse(Buffer.from(plaintext).toString('utf8')), { status: 200, body: { ok: true } });
		});

		it('produces a sealed value the node opens', async () => {
			const iv = webcrypto.getRandomValues(new Uint8Array(12));
			const ctAndTag = await subtle.encrypt(
				{
					name: 'AES-GCM',
					iv,
					additionalData: Buffer.from(`harper.encrypted_operation.field:${nonce}:/records/0`),
					tagLength: 128,
				},
				await importAesKey(),
				Buffer.from(JSON.stringify({ id: 7 }))
			);
			const leaf = Buffer.concat([Buffer.from(iv), Buffer.from(ctAndTag)]).toString('base64');
			assert.deepStrictEqual(sealed.openValue(leaf, responseKey, nonce, '/records/0'), { id: 7 });
		});
	});
});
