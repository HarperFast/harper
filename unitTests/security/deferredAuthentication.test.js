const assert = require('node:assert');

const {
	assertNoDeferredCredentialRejection,
	deferCredentialRejection,
	getDeferredCredentialRejection,
	isCredentialRejection,
} = require('#src/security/deferredAuthentication');
const { ClientError, ServerError } = require('#src/utility/errors/hdbError');

describe('deferredAuthentication', () => {
	describe('isCredentialRejection', () => {
		it('accepts Harper 4xx authentication ClientErrors', () => {
			assert.strictEqual(isCredentialRejection(new ClientError('Login failed', 401)), true);
			assert.strictEqual(isCredentialRejection(new ClientError('token expired', 403)), true);
			assert.strictEqual(isCredentialRejection(new ClientError('invalid token', 400)), true);
		});

		it('rejects internal faults so they fail closed instead of deferring', () => {
			// A missing-JWT-keys fault is a 500 ClientError in this codebase; it must never defer.
			assert.strictEqual(isCredentialRejection(new ClientError('no encryption keys', 500)), false);
			assert.strictEqual(isCredentialRejection(new ServerError('storage unavailable')), false);
			// A bare Error carries no status at all — a bug or a driver failure, not a rejection.
			assert.strictEqual(isCredentialRejection(new Error('ENOENT')), false);
			assert.strictEqual(isCredentialRejection(new TypeError('Invalid character')), false);
			assert.strictEqual(isCredentialRejection(undefined), false);
			assert.strictEqual(isCredentialRejection(null), false);
			// A non-numeric status must not be coerced into the 4xx window.
			assert.strictEqual(isCredentialRejection({ statusCode: '401' }), false);
		});

		it('reads a plain `status` as well as `statusCode`', () => {
			assert.strictEqual(isCredentialRejection({ status: 401 }), true);
			assert.strictEqual(isCredentialRejection({ status: 503 }), false);
		});
	});

	describe('deferCredentialRejection', () => {
		it('records the rejection without exposing it as an enumerable property', () => {
			const request = { headers: { authorization: 'Basic d3A6c2VjcmV0' } };
			deferCredentialRejection(request, new ClientError('Login failed', 401), 'Basic');

			assert.deepStrictEqual(Object.keys(request), ['headers']);
			assert.strictEqual(JSON.stringify(request), '{"headers":{"authorization":"Basic d3A6c2VjcmV0"}}');
		});

		it('leaves the inbound Authorization header byte-for-byte unchanged', () => {
			const authorization = 'Basic d29yZHByZXNzOmFiY2QgZWZnaCBpamtsIG1ub3AgcXJzdCB1dnd4';
			const request = { headers: { authorization } };
			deferCredentialRejection(request, new ClientError('Login failed', 401), 'Basic');

			assert.strictEqual(request.headers.authorization, authorization);
		});

		it('pins the deferred status to 401 even when the underlying rejection was a 403', () => {
			// The authentication middleware has always answered a rejected credential with 401
			// regardless of the error's own status, so a deferred rejection has to match that.
			const request = {};
			deferCredentialRejection(request, new ClientError('token expired', 403), 'Bearer');

			assert.deepStrictEqual(getDeferredCredentialRejection(request), {
				status: 401,
				message: 'token expired',
				strategy: 'Bearer',
			});
		});

		it('falls back to a generic message when the rejection carries none', () => {
			const request = {};
			deferCredentialRejection(request, {}, 'Bearer');

			assert.strictEqual(getDeferredCredentialRejection(request).message, 'Unauthorized');
		});

		it('is readable through a proxy of the request, as the urlPath-mount chain produces', () => {
			const request = {};
			deferCredentialRejection(request, new ClientError('Login failed', 401), 'Basic');
			const proxied = new Proxy(request, { get: (target, prop) => Reflect.get(target, prop) });

			assert.strictEqual(getDeferredCredentialRejection(proxied).status, 401);
		});
	});

	describe('getDeferredCredentialRejection', () => {
		it('returns undefined for a request that presented no credential', () => {
			assert.strictEqual(getDeferredCredentialRejection({}), undefined);
			assert.strictEqual(getDeferredCredentialRejection(undefined), undefined);
		});

		it('cannot be forged through a string or well-known symbol key', () => {
			const forged = {
				'deferredCredentialRejection': { status: 401, message: 'forged', strategy: 'Basic' },
				'harper.deferredCredentialRejection': { status: 401, message: 'forged', strategy: 'Basic' },
				[Symbol.for('harper.deferredCredentialRejection')]: { status: 401, message: 'forged', strategy: 'Basic' },
			};

			assert.strictEqual(getDeferredCredentialRejection(forged), undefined);
		});
	});

	describe('assertNoDeferredCredentialRejection', () => {
		it('does nothing for a request with no deferred rejection', () => {
			assert.doesNotThrow(() => assertNoDeferredCredentialRejection({}));
		});

		it('throws the unauthorized ClientError an owning Harper layer renders', () => {
			const request = {};
			deferCredentialRejection(request, new ClientError('Login failed', 401), 'Basic');

			assert.throws(
				() => assertNoDeferredCredentialRejection(request),
				(error) => {
					assert.ok(error instanceof ClientError);
					assert.strictEqual(error.statusCode, 401);
					assert.strictEqual(error.message, 'Login failed');
					return true;
				}
			);
		});
	});
});
