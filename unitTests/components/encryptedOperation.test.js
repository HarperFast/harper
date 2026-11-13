'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { generateKeyPairSync, randomBytes, webcrypto } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const { OperationFunctionObject } = require('#src/server/serverHelpers/OperationFunctionObject');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');
const encryptedOperationModule = require('#src/components/encryptedOperation');
const opAuth = require('#src/utility/operation_authorization');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const logger = require('#src/utility/logging/harper_logger');
const { ClientError } = require('#src/utility/errors/hdbError');
const { registerSecretCustody, clearSecretCustody } = require('#src/resources/secretDecryptor');
const { fingerprintOf, encryptEnvelope, decryptEnvelope } = require('#src/utility/secretEnvelope');
const sealed = require('#src/utility/sealedOperation');
const { pinLogConfig } = require('../logConfigFixture.js');
const { waitFor } = require('../waitFor.js');

const PREFIX = 'enc:v1:';
const { CONFIG_PARAMS } = terms;

function keypair() {
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
}
const { publicKey, privateKey } = keypair();
const kid = fingerprintOf(publicKey);
const other = keypair();

function installCustody() {
	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice(PREFIX.length), privateKey, kid),
		getPublicKey: () => ({ publicKey, fingerprint: kid }),
	});
}

const SUPER_USER = { username: 'admin', active: true, role: { id: 'su', permission: { super_user: true } } };
const allowlisted = (operations) => ({
	username: 'scoped',
	active: true,
	role: {
		id: `allow-${operations.join('-')}`,
		role: `allow_${operations.join('_')}`,
		__updatedtime__: Date.now(),
		permission: { super_user: false, operations },
	},
});

const writes = { count: 0 };
let throwingOnDestroyed = false;
const TEST_OPERATIONS = {
	test_eo_echo: async (body) => {
		const { hdb_user, ...received } = body;
		return { received, user: hdb_user?.username ?? null };
	},
	test_eo_fail: async (body) => {
		throw new ClientError(`bad value ${body.value}`, 422);
	},
	test_eo_big_write: async () => {
		writes.count++;
		return Array.from({ length: 200 }, (_, index) => ({ index, padding: 'x'.repeat(100) }));
	},
	test_eo_stream: async () => lateErroringStream,
	test_eo_iterable: async () => rejectingCleanupIterable(),
	test_eo_circular: async () => {
		writes.count++;
		const result = { name: 'loop' };
		result.self = result;
		return result;
	},
	test_eo_bigint_error: async () => {
		const error = new ClientError('unserializable detail', 409);
		error.http_resp_msg = { error: 'unserializable detail', size: 10n };
		throw error;
	},
	test_eo_large_error: async () => {
		throw new ClientError('e'.repeat(8192), 422);
	},
	test_eo_failing_cursor: async (body) => {
		writes.count++;
		return failingCursor(body.value);
	},
	test_eo_throwing_destroy: async () => ({
		pipe() {},
		destroy() {
			throw new Error('destroy failed');
		},
	}),
	test_eo_sized: async (body) => 'x'.repeat(body.size),
	test_eo_throwing_on: async () => ({
		pipe() {},
		on() {
			throw new Error('on failed');
		},
		destroy() {
			throwingOnDestroyed = true;
		},
	}),
};

// Yields two rows, then fails the way a cursor does when a read goes wrong mid-stream.
function failingCursor(message) {
	let index = 0;
	return {
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					if (index++ < 2) return { done: false, value: { index } };
					throw new Error(message);
				},
			};
		},
	};
}

// Stands in for a file/blob stream: something with pipe/destroy that emits `error` after it was dropped.
const lateErroringStream = Object.assign(new EventEmitter(), {
	destroyed: false,
	pipe() {},
	destroy() {
		this.destroyed = true;
		setImmediate(() => this.emit('error', new Error('late stream failure')));
	},
});

// Stops producing once closed, like a real cursor, but its cleanup rejects.
function rejectingCleanupIterable() {
	let closed = false;
	return {
		[Symbol.asyncIterator]() {
			return {
				next: async () => (closed ? { done: true, value: undefined } : { done: false, value: 'y'.repeat(500) }),
				return: async () => {
					closed = true;
					throw new Error('iterator cleanup failed');
				},
			};
		},
	};
}

async function call(request, hdbUser = SUPER_USER) {
	const body = { ...request, hdb_user: hdbUser };
	const operationFunction = serverUtilities.chooseOperation(body);
	return serverUtilities.processLocalTransaction({ body }, operationFunction);
}

function seal(op, options = {}) {
	return sealed.sealOperation({ op, publicKey, kid, ...options });
}

async function roundTrip(op, options = {}, hdbUser = SUPER_USER) {
	const { request, responseKey, nonce } = seal(op, options);
	const reply = await call(request, hdbUser);
	return { reply, request, result: sealed.openResponse(reply.encrypted_response, responseKey, nonce) };
}

function envelopeFor(header, key = publicKey, keyId = kid) {
	return PREFIX + encryptEnvelope(JSON.stringify(header), key, keyId);
}

function header(overrides = {}) {
	return {
		v: 1,
		rk: randomBytes(32).toString('base64'),
		nonce: randomBytes(16).toString('base64'),
		ts: Date.now(),
		op: { operation: 'test_eo_echo' },
		...overrides,
	};
}

// A fields-mode request built by hand, so a test can place leaves (or raw JSON) where the reference
// client never would.
function fieldsRequest(buildVisible, { opText } = {}) {
	const responseKey = randomBytes(32);
	const nonce = randomBytes(16).toString('base64');
	const sealValue = (value, pointer) => sealed.sealValue(value, responseKey, nonce, pointer);
	const text = opText ?? JSON.stringify(buildVisible(sealValue));
	const sealedHeader = {
		v: 1,
		rk: responseKey.toString('base64'),
		nonce,
		ts: Date.now(),
		oph: sealed.hashOperationText(text),
	};
	return {
		request: { operation: 'encrypted_operation', mode: 'fields', op: text, envelope: envelopeFor(sealedHeader) },
		responseKey,
		nonce,
	};
}

async function sealedAnswer({ request, responseKey, nonce }, hdbUser = SUPER_USER) {
	const reply = await call(request, hdbUser);
	return { reply, result: sealed.openResponse(reply.encrypted_response, responseKey, nonce) };
}

function withConfig(param, value) {
	const prior = env.get(param);
	env.setProperty(param, value);
	return () => env.setProperty(param, prior);
}

describe('encrypted_operation', function () {
	before(() => {
		installCustody();
		// Another suite may have loaded a fresh serverUtilities, which re-injects its own dispatch.
		encryptedOperationModule.setEncryptedOperationDispatch({
			chooseOperation: serverUtilities.chooseOperation,
			processLocalTransaction: serverUtilities.processLocalTransaction,
			isJobOperation: serverUtilities.isJobOperation,
		});
		for (const [name, handler] of Object.entries(TEST_OPERATIONS)) {
			serverUtilities.OPERATION_FUNCTION_MAP.set(name, new OperationFunctionObject(handler));
			opAuth.registerOperationPermission(name, { requiresSu: false });
		}
	});

	after(() => {
		clearSecretCustody();
		for (const name of Object.keys(TEST_OPERATIONS)) {
			serverUtilities.OPERATION_FUNCTION_MAP.delete(name);
			opAuth.unregisterOperationPermission(name);
		}
		encryptedOperationModule._setClocksForTest();
		encryptedOperationModule._resetReservedNoncesForTest();
	});

	beforeEach(() => {
		encryptedOperationModule._setClocksForTest();
		encryptedOperationModule._resetReservedNoncesForTest();
	});

	describe('sealed mode', () => {
		it('runs the inner operation as the caller and seals its result', async () => {
			const op = { operation: 'test_eo_echo', records: [{ id: 1, secret: 'marker-a' }] };
			const { reply, result } = await roundTrip(op);
			assert.deepStrictEqual(Object.keys(reply), ['encrypted_response']);
			assert.ok(!JSON.stringify(reply).includes('marker-a'));
			assert.deepStrictEqual(result, { status: 200, body: { received: op, user: 'admin' } });
		});

		it('seals an inner failure with the status and body the plaintext path answers', async () => {
			const { result } = await roundTrip({ operation: 'test_eo_fail', value: 'v1' });
			assert.deepStrictEqual(result, { status: 422, body: { error: 'bad value v1' } });
			const { result: missing } = await roundTrip({ operation: 'test_eo_missing' });
			assert.deepStrictEqual(missing, { status: 400, body: { error: "Operation 'test_eo_missing' not found" } });
		});

		it('treats a $sealed object as data', async () => {
			const op = { operation: 'test_eo_echo', note: { $sealed: 'not-a-leaf' } };
			const { result } = await roundTrip(op);
			assert.deepStrictEqual(result.body.received, op);
		});

		it('accepts an envelope a WebCrypto client sealed independently', async () => {
			const { subtle } = webcrypto;
			const responseKey = randomBytes(32);
			const nonce = randomBytes(16).toString('base64');
			const plaintext = JSON.stringify({
				v: 1,
				rk: responseKey.toString('base64'),
				nonce,
				ts: Date.now(),
				op: { operation: 'test_eo_echo', from: 'webcrypto' },
			});
			const spki = Buffer.from(publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
			const rsa = await subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
			const aesKeyBytes = webcrypto.getRandomValues(new Uint8Array(32));
			const iv = webcrypto.getRandomValues(new Uint8Array(12));
			const aesKey = await subtle.importKey('raw', aesKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
			const ctAndTag = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, Buffer.from(plaintext)));
			const wrapped = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, rsa, aesKeyBytes));
			const body = {
				kid,
				k: Buffer.from(wrapped).toString('base64'),
				iv: Buffer.from(iv).toString('base64'),
				ct: Buffer.from(ctAndTag.slice(0, -16)).toString('base64'),
				tag: Buffer.from(ctAndTag.slice(-16)).toString('base64'),
			};
			const envelope = PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url');
			const reply = await call({ operation: 'encrypted_operation', envelope });
			const result = sealed.openResponse(reply.encrypted_response, responseKey, nonce);
			assert.deepStrictEqual(result.body.received, { operation: 'test_eo_echo', from: 'webcrypto' });
		});
	});

	describe('authorization', () => {
		it('requires the wrapper and the inner operation to both be granted to a restricted role', async () => {
			const op = { operation: 'test_eo_echo' };
			const wrapperOnly = await roundTrip(op, {}, allowlisted(['encrypted_operation']));
			assert.strictEqual(wrapperOnly.result.status, 403);
			await assert.rejects(call(seal(op).request, allowlisted(['test_eo_echo'])), { statusCode: 403 });
			const both = await roundTrip(op, {}, allowlisted(['encrypted_operation', 'test_eo_echo']));
			assert.deepStrictEqual(both.result, { status: 200, body: { received: op, user: 'scoped' } });
		});

		it('requires a scoped token to name both the wrapper and the inner operation', async () => {
			const scoped = (tokenOperations) => ({ ...SUPER_USER, tokenOperations });
			const op = { operation: 'test_eo_echo' };
			await assert.rejects(call(seal(op).request, scoped(['test_eo_echo'])), { statusCode: 403 });
			const wrapperOnly = await roundTrip(op, {}, scoped(['encrypted_operation']));
			assert.strictEqual(wrapperOnly.result.status, 403);
			const both = await roundTrip(op, {}, scoped(['encrypted_operation', 'test_eo_echo']));
			assert.strictEqual(both.result.status, 200);
		});

		it('applies the role allowlist to a sealed sql statement', async () => {
			const { result } = await roundTrip(
				{ operation: 'sql', sql: 'SELECT * FROM dev.dog' },
				{},
				allowlisted(['encrypted_operation'])
			);
			assert.strictEqual(result.status, 403);
		});

		for (const field of ['hdb_user', 'hdbAuthHeader', 'impersonate', 'bypass_auth', 'bypassAuth', 'progress']) {
			it(`refuses a sealed operation that sets '${field}'`, async () => {
				const op = { operation: 'test_eo_echo', [field]: SUPER_USER };
				const { result } = await roundTrip(op, {}, allowlisted(['encrypted_operation', 'test_eo_echo']));
				assert.deepStrictEqual(result, { status: 400, body: { error: `A sealed operation may not set '${field}'` } });
			});
		}

		for (const operation of [
			'login',
			'logout',
			'exchange_oidc_token',
			'refresh_operation_token',
			'encrypted_operation',
		]) {
			it(`refuses '${operation}' inside the wrapper`, async () => {
				const { result } = await roundTrip({ operation });
				assert.deepStrictEqual(result, {
					status: 400,
					body: { error: `'${operation}' cannot run inside encrypted_operation` },
				});
			});
		}

		it('refuses an operation that runs as a stored job, before any job row is written', async () => {
			for (const operation of ['csv_data_load', 'import_from_s3', 'restart_service']) {
				const { result } = await roundTrip({ operation, database: 'dev', table: 'dog', data: 'id\n1' });
				assert.deepStrictEqual(result, {
					status: 400,
					body: { error: `'${operation}' runs as a stored job; use a direct connection` },
				});
			}
		});

		it('refuses a caller with no principal outside a trusted dispatch', async () => {
			await assert.rejects(
				encryptedOperationModule.encryptedOperation({ ...seal({ operation: 'test_eo_echo' }).request }),
				{
					statusCode: 401,
				}
			);
		});

		it('keeps a trusted internal dispatch trusted for the inner operation', async () => {
			const { request, responseKey, nonce } = seal({ operation: 'test_eo_echo' });
			const reply = await runWithOperationAuthorizationBypass(true, () => {
				const body = { ...request };
				return serverUtilities.processLocalTransaction({ body }, serverUtilities.chooseOperation(body, true));
			});
			const result = sealed.openResponse(reply.encrypted_response, responseKey, nonce);
			assert.deepStrictEqual(result.body, { received: { operation: 'test_eo_echo' }, user: null });
		});
	});

	describe('admission answers in plaintext without echoing input', () => {
		it('answers 503 when the node has no custody', async () => {
			clearSecretCustody();
			try {
				await assert.rejects(call(seal({ operation: 'test_eo_echo' }).request), {
					statusCode: 503,
					message: 'secrets custody is not initialized on this node',
				});
			} finally {
				installCustody();
			}
		});

		it('refuses malformed and kid-less envelopes', async () => {
			const garbage = PREFIX + Buffer.from('{"nope":1}').toString('base64url');
			await assert.rejects(call({ operation: 'encrypted_operation', envelope: garbage }), {
				statusCode: 400,
				message: 'The envelope is malformed',
			});
			await assert.rejects(call({ operation: 'encrypted_operation', envelope: 'enc:v1:!' }), { statusCode: 400 });
			await assert.rejects(call({ operation: 'encrypted_operation', envelope: envelopeFor(header(), publicKey, '') }), {
				statusCode: 400,
				message: "The envelope must carry a 'kid'",
			});
		});

		it("answers 409 with this node's fingerprint for another key's envelope", async () => {
			const envelope = envelopeFor(header(), other.publicKey, fingerprintOf(other.publicKey));
			await assert.rejects(call({ operation: 'encrypted_operation', envelope }), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.deepStrictEqual(error.http_resp_msg, {
					error: "The envelope's kid does not match this node's secrets key",
					custody_fingerprint: kid,
				});
				return true;
			});
		});

		it('refuses an envelope for this key that does not decrypt', async () => {
			const fields = JSON.parse(Buffer.from(envelopeFor(header()).slice(PREFIX.length), 'base64url').toString());
			const ct = Buffer.from(fields.ct, 'base64');
			ct[0] ^= 1;
			const envelope =
				PREFIX + Buffer.from(JSON.stringify({ ...fields, ct: ct.toString('base64') })).toString('base64url');
			await assert.rejects(call({ operation: 'encrypted_operation', envelope }), {
				statusCode: 400,
				message: 'The envelope could not be decrypted',
			});
		});

		const malformedHeaders = {
			'an unknown version': header({ v: 2 }),
			'a short response key': header({ rk: randomBytes(16).toString('base64') }),
			'a short nonce': header({ nonce: randomBytes(8).toString('base64') }),
			'a non-numeric timestamp': header({ ts: String(Date.now()) }),
			'an actor with a newline': header({ actor: 'a\nforged log line' }),
			'an over-long actor': header({ actor: 'a'.repeat(257) }),
			'no inner operation': header({ op: undefined }),
			'a fields-mode hash in sealed mode': header({ oph: randomBytes(32).toString('base64') }),
		};
		for (const [label, sealedHeader] of Object.entries(malformedHeaders)) {
			it(`refuses a header with ${label}`, async () => {
				await assert.rejects(call({ operation: 'encrypted_operation', envelope: envelopeFor(sealedHeader) }), {
					statusCode: 400,
					message: 'The sealed request is malformed',
				});
			});
		}

		it('refuses a fields-mode header that carries the operation', async () => {
			const envelope = envelopeFor(header({ oph: randomBytes(32).toString('base64') }));
			await assert.rejects(call({ operation: 'encrypted_operation', mode: 'fields', op: '{}', envelope }), {
				statusCode: 400,
				message: 'The sealed request is malformed',
			});
		});

		it('refuses oversized requests by length, before decoding', async () => {
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE, 2048);
			try {
				const big = seal({ operation: 'test_eo_echo', padding: 'z'.repeat(4096) }).request;
				await assert.rejects(call(big), { statusCode: 413 });
				const bigFields = seal({ operation: 'test_eo_echo', padding: 'z'.repeat(4096) }, { mode: 'fields' }).request;
				await assert.rejects(call(bigFields), {
					statusCode: 413,
					message: 'The operation exceeds the encrypted operation size limit',
				});
				const fat = {
					operation: 'encrypted_operation',
					mode: 'fields',
					op: '{}',
					envelope: PREFIX + 'A'.repeat(17_000),
				};
				restore();
				await assert.rejects(call(fat), {
					statusCode: 413,
					message: 'The envelope exceeds the encrypted operation size limit',
				});
			} finally {
				restore();
			}
		});

		it('accepts a timestamp anywhere inside the window and refuses one outside it with the server time', async () => {
			const now = 1_800_000_000_000;
			encryptedOperationModule._setClocksForTest({ wall: () => now });
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE, 60_000);
			try {
				for (const ts of [now - 60_000, now + 60_000]) {
					const { result } = await roundTrip({ operation: 'test_eo_echo' }, { now: ts });
					assert.strictEqual(result.status, 200);
				}
				for (const ts of [now - 60_001, now + 60_001]) {
					await assert.rejects(call(seal({ operation: 'test_eo_echo' }, { now: ts }).request), (error) => {
						assert.strictEqual(error.statusCode, 400);
						assert.deepStrictEqual(error.http_resp_msg, {
							error: 'The sealed request is outside the accepted time window',
							server_time: now,
						});
						return true;
					});
				}
			} finally {
				restore();
			}
		});
	});

	describe('replay', () => {
		it('refuses a second submission of the same envelope', async () => {
			const { request } = seal({ operation: 'test_eo_echo' });
			await call(request);
			await assert.rejects(call(request), { statusCode: 409, message: 'This sealed request was already received' });
		});

		it('admits exactly one of two concurrent duplicates', async () => {
			const { request } = seal({ operation: 'test_eo_echo' });
			const outcomes = await Promise.allSettled([call(request), call(request)]);
			assert.deepStrictEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
			assert.strictEqual(outcomes.find((outcome) => outcome.status === 'rejected').reason.statusCode, 409);
		});

		it('keeps the reservation when the first attempt failed', async () => {
			const { request, responseKey, nonce } = seal({ operation: 'test_eo_fail', value: 'v' });
			const first = await call(request);
			assert.strictEqual(sealed.openResponse(first.encrypted_response, responseKey, nonce).status, 422);
			await assert.rejects(call(request), { statusCode: 409 });
		});

		it('answers 503 to a caller holding its share, after a full sweep finds nothing to reclaim', async () => {
			encryptedOperationModule._resetReservedNoncesForTest(4);
			await call(seal({ operation: 'test_eo_echo' }).request);
			await call(seal({ operation: 'test_eo_echo' }).request);
			await assert.rejects(call(seal({ operation: 'test_eo_echo' }).request), { statusCode: 503 });
		});

		it('leaves replay capacity to other callers while one floods envelopes it may not run', async () => {
			let monotonic = 0;
			encryptedOperationModule._setClocksForTest({ monotonic: () => monotonic });
			encryptedOperationModule._resetReservedNoncesForTest(4);
			const flooder = allowlisted(['encrypted_operation']);
			const op = { operation: 'test_eo_echo' };
			for (let index = 0; index < 2; index++) {
				assert.strictEqual((await roundTrip(op, {}, flooder)).result.status, 403);
			}
			await assert.rejects(call(seal(op).request, flooder), { statusCode: 503 });
			assert.strictEqual((await roundTrip(op)).result.status, 200);
			assert.strictEqual(
				(await roundTrip(op, {}, { ...SUPER_USER, username: 'third' })).result.status,
				200,
				'each further caller still gets a share'
			);
			await assert.rejects(call(seal(op).request), { statusCode: 503 }, 'the store is full');
			monotonic += 600_001;
			assert.strictEqual((await roundTrip(op, {}, flooder)).result.status, 403, 'expired reservations are released');
		});

		it('reclaims entries that expired behind a longer-lived one', async () => {
			let monotonic = 0;
			const wall = 1_800_000_000_000;
			encryptedOperationModule._setClocksForTest({ monotonic: () => monotonic, wall: () => wall });
			encryptedOperationModule._resetReservedNoncesForTest(6);
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE, 600_000);
			try {
				await call(seal({ operation: 'test_eo_echo' }, { now: wall + 600_000 }).request);
				await call(seal({ operation: 'test_eo_echo' }, { now: wall }).request);
				await call(seal({ operation: 'test_eo_echo' }, { now: wall }).request);
				// past the two reservations stamped now (ts + 600s), short of the one stamped 600s ahead
				monotonic += 602_000;
				const { result } = await roundTrip({ operation: 'test_eo_echo' }, { now: wall });
				assert.strictEqual(result.status, 200);
			} finally {
				restore();
			}
		});

		it('releases a nonce the moment no maxAge could admit its envelope again', async () => {
			let clock = 0;
			const start = 1_800_000_000_000;
			encryptedOperationModule._setClocksForTest({ monotonic: () => clock, wall: () => start + clock });
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE, 600_000);
			try {
				const { request } = seal({ operation: 'test_eo_echo' }, { now: start - 600_000 });
				await call(request);
				await assert.rejects(call(request), { statusCode: 409 });
				clock = 1;
				await assert.rejects(call(request), {
					statusCode: 400,
					message: 'The sealed request is outside the accepted time window',
				});
			} finally {
				restore();
			}
		});

		it('keeps a nonce while its envelope can still be fresh, even after maxAge is raised', async () => {
			let clock = 0;
			const start = 1_800_000_000_000;
			encryptedOperationModule._setClocksForTest({ monotonic: () => clock, wall: () => start + clock });
			let restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE, 60_000);
			try {
				const { request } = seal({ operation: 'test_eo_echo' }, { now: start });
				await call(request);
				restore();
				restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE, 600_000);
				clock += 200_000;
				await assert.rejects(call(request), { statusCode: 409 });
			} finally {
				restore();
			}
		});

		it('keeps a nonce through the last millisecond its envelope is fresh', async () => {
			let clock = 0;
			const start = 1_800_000_000_000;
			encryptedOperationModule._setClocksForTest({ monotonic: () => clock, wall: () => start + clock });
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE, 60_000);
			try {
				const { request } = seal({ operation: 'test_eo_echo' }, { now: start + 60_000 });
				await call(request);
				clock = 120_000;
				await assert.rejects(call(request), { statusCode: 409 });
			} finally {
				restore();
			}
		});
	});

	describe('fields mode', () => {
		it('opens sealed values in place, including escaped keys, and reports the status in plaintext', async () => {
			const op = { 'operation': 'test_eo_echo', 'table': 'dog', 'records': [{ id: 1 }], 'a/b~c': 'escaped' };
			const { reply, result, request } = await roundTrip(op, { mode: 'fields' });
			assert.strictEqual(reply.status, 200);
			assert.ok(JSON.parse(request.op).table === 'dog');
			assert.deepStrictEqual(result.body.received, op);
		});

		it('opens a nested leaf at its own pointer', async () => {
			const built = fieldsRequest((seal) => ({
				operation: 'test_eo_echo',
				records: [{ id: 1 }, { id: 2, secret: seal('s', '/records/1/secret') }],
			}));
			const { result } = await sealedAnswer(built);
			assert.deepStrictEqual(result.body.received.records, [{ id: 1 }, { id: 2, secret: 's' }]);
		});

		it('refuses a visible operation a relay edited', async () => {
			const { request, responseKey, nonce } = seal(
				{ operation: 'test_eo_echo', table: 'dog', a: 1 },
				{ mode: 'fields' }
			);
			request.op = request.op.replace('"dog"', '"cat"');
			const { result } = await sealedAnswer({ request, responseKey, nonce });
			assert.deepStrictEqual(result, {
				status: 400,
				body: { error: 'The visible operation does not match the sealed request' },
			});
		});

		it('refuses a leaf moved to another location', async () => {
			const built = fieldsRequest((seal) => ({ operation: 'test_eo_echo', b: seal('for-a', '/a') }));
			const { result } = await sealedAnswer(built);
			assert.deepStrictEqual(result, { status: 400, body: { error: "The sealed value at '/b' could not be opened" } });
		});

		it('refuses a malformed leaf and a sealed operation name', async () => {
			for (const visible of [
				(seal) => ({ operation: 'test_eo_echo', a: { ...seal(1, '/a'), extra: true } }),
				() => ({ operation: 'test_eo_echo', a: { $sealed: 7 } }),
			]) {
				const { result } = await sealedAnswer(fieldsRequest(visible));
				assert.deepStrictEqual(result, {
					status: 400,
					body: { error: "A sealed value must be an object with only a string '$sealed'" },
				});
			}
			const { result } = await sealedAnswer(
				fieldsRequest((seal) => ({ operation: seal('test_eo_echo', '/operation') }))
			);
			assert.deepStrictEqual(result, {
				status: 400,
				body: { error: "The visible operation must name its 'operation' in plaintext" },
			});
		});

		it('refuses more than 10,000 sealed values', async () => {
			const built = fieldsRequest((seal) => ({
				operation: 'test_eo_echo',
				items: Array.from({ length: 10_001 }, (_, index) => seal(index, `/items/${index}`)),
			}));
			const { result } = await sealedAnswer(built);
			assert.deepStrictEqual(result, { status: 400, body: { error: 'The operation has too many sealed values' } });
		});

		it('reports the inner status in plaintext alongside the sealed answer', async () => {
			const { reply, result } = await roundTrip({ operation: 'test_eo_fail', value: 'v' }, { mode: 'fields' });
			assert.strictEqual(reply.status, 422);
			assert.strictEqual(result.status, 422);
		});
	});

	describe('structure checks in both modes', () => {
		let nested = { leaf: true };
		for (let depth = 0; depth < 70; depth++) nested = { nested };
		const deep = { operation: 'test_eo_echo', nested };

		it('refuses an operation nested deeper than 64 levels', async () => {
			for (const options of [{}, { mode: 'fields', visibleFields: ['nested'] }]) {
				const { result } = await roundTrip(deep, options);
				assert.deepStrictEqual(result, { status: 400, body: { error: 'The operation is nested too deeply' } });
			}
		});

		it('refuses prototype-poisoning keys at any depth, as the plaintext body parser does', async () => {
			for (const raw of [
				'{"operation":"test_eo_echo","x":{"__proto__":{"y":1}}}',
				'{"operation":"test_eo_echo","x":{"constructor":{"prototype":{}}}}',
			]) {
				const { result } = await sealedAnswer(fieldsRequest(null, { opText: raw }));
				assert.deepStrictEqual(result, {
					status: 400,
					body: { error: 'The operation contains a forbidden property name' },
				});
				const sealedHeader = header();
				const text = JSON.stringify(sealedHeader).replace('{"operation":"test_eo_echo"}', raw);
				const responseKey = Buffer.from(sealedHeader.rk, 'base64');
				const envelope = PREFIX + encryptEnvelope(text, publicKey, kid);
				const reply = await call({ operation: 'encrypted_operation', envelope });
				assert.strictEqual(sealed.openResponse(reply.encrypted_response, responseKey, sealedHeader.nonce).status, 400);
			}
		});

		it('refuses a sealed value that hides a prototype under constructor', async () => {
			const { result } = await sealedAnswer(
				fieldsRequest((sealValue) => ({
					operation: 'test_eo_echo',
					x: { constructor: sealValue({ prototype: {} }, '/x/constructor') },
				}))
			);
			assert.deepStrictEqual(result, {
				status: 400,
				body: { error: 'The operation contains a forbidden property name' },
			});
		});

		it('allows a constructor property that is ordinary data', async () => {
			const op = { operation: 'test_eo_echo', records: [{ constructor: 'Ford' }] };
			const { result } = await roundTrip(op, { mode: 'fields' });
			assert.deepStrictEqual(result.body.received, op);
		});
	});

	describe('results that cannot be delivered', () => {
		it('refuses a known stream-returning operation before it runs', async () => {
			const { result } = await roundTrip({ operation: 'get_backup', database: 'data' });
			assert.deepStrictEqual(result, {
				status: 406,
				body: { error: "'get_backup' returns a byte stream; use a direct connection" },
			});
		});

		it('discards a returned stream, survives its late error, and says the operation ran', async () => {
			const { result } = await roundTrip({ operation: 'test_eo_stream' });
			assert.deepStrictEqual(result, {
				status: 406,
				body: { error: "'test_eo_stream' returned a byte stream; use a direct connection" },
				executed: true,
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(lateErroringStream.destroyed, true);
		});

		it('says an oversized result ran, so the client does not resend it', async () => {
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE, 4096);
			try {
				const before = writes.count;
				const { result } = await roundTrip({ operation: 'test_eo_big_write' });
				assert.deepStrictEqual(result, {
					status: 413,
					body: { error: 'The result exceeds 4096 bytes; use a direct connection' },
					executed: true,
				});
				assert.strictEqual(writes.count, before + 1);
			} finally {
				restore();
			}
		});

		it('keeps a successful sealed answer, wrapper included, within maxSize', async () => {
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE, 2048);
			try {
				// a string result is answered as { message }: '{"status":200,"body":{"message":"' + n x's + '"}}' is n + 36 bytes
				const fits = await roundTrip({ operation: 'test_eo_sized', size: 2048 - 36 });
				assert.strictEqual(fits.result.status, 200);
				assert.strictEqual(Buffer.from(fits.reply.encrypted_response.ct, 'base64').length, 2048);
				const over = await roundTrip({ operation: 'test_eo_sized', size: 2048 - 35 });
				assert.strictEqual(over.result.status, 413);
				assert.strictEqual(over.result.executed, true);
			} finally {
				restore();
			}
		});

		it('caps an iterable whose cleanup rejects without an unhandled rejection, and keeps serving', async () => {
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.prependListener('unhandledRejection', onUnhandled);
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE, 4096);
			try {
				const { result } = await roundTrip({ operation: 'test_eo_iterable' });
				assert.strictEqual(result.status, 413);
				assert.strictEqual(result.executed, true);
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.deepStrictEqual(unhandled, []);
				const next = await roundTrip({ operation: 'test_eo_echo' });
				assert.strictEqual(next.result.status, 200);
			} finally {
				restore();
				process.removeListener('unhandledRejection', onUnhandled);
			}
		});

		it('says a result that cannot be serialized ran, rather than sealing broken JSON as a success', async () => {
			const before = writes.count;
			const { result } = await roundTrip({ operation: 'test_eo_circular' });
			assert.deepStrictEqual(result, {
				status: 500,
				body: { error: 'The result could not be serialized' },
				executed: true,
			});
			assert.strictEqual(writes.count, before + 1);
		});

		it('seals an error whose body cannot be serialized instead of answering in plaintext', async () => {
			const { reply, result } = await roundTrip({ operation: 'test_eo_bigint_error' });
			assert.deepStrictEqual(Object.keys(reply), ['encrypted_response']);
			assert.deepStrictEqual(result, { status: 409, body: { error: 'The error could not be serialized' } });
		});

		it('bounds an error body by maxSize', async () => {
			const restore = withConfig(CONFIG_PARAMS.OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE, 2048);
			try {
				const { result } = await roundTrip({ operation: 'test_eo_large_error' });
				assert.deepStrictEqual(result, { status: 422, body: { error: 'The error exceeds 2048 bytes' } });
			} finally {
				restore();
			}
		});

		it('says a result whose cursor failed mid-stream ran, rather than sealing a truncated success', async () => {
			const before = writes.count;
			const { result } = await roundTrip({ operation: 'test_eo_failing_cursor', value: 'cursor-failure' });
			assert.deepStrictEqual(result, {
				status: 500,
				body: { error: 'The result could not be serialized' },
				executed: true,
			});
			assert.strictEqual(writes.count, before + 1);
		});

		it('answers a discarded result whose cleanup throws as a stream that ran, and still destroys it', async () => {
			throwingOnDestroyed = false;
			for (const operation of ['test_eo_throwing_destroy', 'test_eo_throwing_on']) {
				const { result } = await roundTrip({ operation });
				assert.strictEqual(result.status, 406, operation);
				assert.strictEqual(result.executed, true, operation);
			}
			assert.strictEqual(throwingOnDestroyed, true);
		});
	});

	describe('logging', function () {
		let restoreLogConfig;
		let originalLogLevel;
		let logPath;

		before(function () {
			restoreLogConfig = pinLogConfig({ level: 'info' });
			originalLogLevel = logger.logLevel;
			logger.logLevel = 'info';
			logPath = logger.getLogFilePath();
		});

		after(function () {
			logger.logLevel = originalLogLevel;
			restoreLogConfig?.();
		});

		async function logTailAfter(action, expected) {
			const offset = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
			await action();
			return waitFor(
				() => {
					if (!existsSync(logPath)) return undefined;
					const tail = readFileSync(logPath, 'utf8').slice(offset);
					return tail.includes(expected) ? tail : undefined;
				},
				{ message: `the log never showed ${expected}` }
			);
		}

		it('logs a sealed-mode operation as metadata only', async () => {
			const op = { operation: 'test_eo_echo', records: [{ secret: 'LOG-MARKER-SEALED' }] };
			const { request } = seal(op, { actor: 'log-actor-sealed' });
			const tail = await logTailAfter(() => call(request), 'log-actor-sealed');
			assert.ok(tail.includes('test_eo_echo'));
			assert.ok(!tail.includes('LOG-MARKER-SEALED'), 'a sealed value reached the log');
			assert.ok(
				!tail.includes(request.envelope.slice(PREFIX.length, PREFIX.length + 40)),
				'the envelope reached the log'
			);
		});

		it('logs a fields-mode operation with its sealed values masked', async () => {
			const op = { operation: 'test_eo_echo', table: 'log_visible_table', records: [{ secret: 'LOG-MARKER-FIELDS' }] };
			const { request } = seal(op, { mode: 'fields', actor: 'log-actor-fields' });
			const leaf = JSON.parse(request.op).records.$sealed;
			const tail = await logTailAfter(() => call(request), 'log-actor-fields');
			assert.ok(tail.includes('log_visible_table'));
			assert.ok(tail.includes('[sealed]'));
			assert.ok(!tail.includes('LOG-MARKER-FIELDS'), 'a sealed value reached the log');
			assert.ok(!tail.includes(leaf.slice(0, 40)), 'ciphertext reached the log');
		});

		it('logs an inner failure without its message', async () => {
			const { request } = seal({ operation: 'test_eo_fail', value: 'LOG-MARKER-ERROR' });
			const tail = await logTailAfter(() => call(request), 'sealed request, status 422');
			assert.ok(!tail.includes('LOG-MARKER-ERROR'), 'an error message echoing a sealed value reached the log');
		});
	});
});
