const assert = require('node:assert');

const {
	assertNoDeferredCredentialRejection,
	credentialRejectionError,
	deferCredentialRejection,
	getDeferredCredentialRejection,
	isCredentialRejection,
	markCredentialRejection,
	settleDeferredCredentialRejection,
} = require('#src/security/deferredAuthentication');
const { ClientError, ServerError } = require('#src/utility/errors/hdbError');

/** A request shaped enough for content negotiation (`findBestSerializer` reads `headers.asObject`). */
function requestAccepting(accept, extraHeaders = {}) {
	const asObject = { ...extraHeaders };
	if (accept) asObject.accept = accept;
	return {
		method: 'GET',
		url: '/Ledger/1',
		headers: { asObject, get: (name) => asObject[name.toLowerCase()] },
	};
}

describe('deferredAuthentication', () => {
	describe('isCredentialRejection', () => {
		it('accepts only an error tagged at the point authentication rejected the credential', () => {
			assert.strictEqual(isCredentialRejection(credentialRejectionError('Login failed', 401)), true);
			assert.strictEqual(isCredentialRejection(credentialRejectionError('token expired', 403)), true);
			assert.strictEqual(isCredentialRejection(markCredentialRejection(new Error('invalid token'))), true);
		});

		it('never infers rejection from the 4xx range', () => {
			// The regression this guards: `findAndValidateUser()` lazily loads the user cache, whose
			// fixed system-table searches raise a default-status-400 ClientError when `system.hdb_role`
			// or `system.hdb_user` is unavailable. Deferring that would hand a storage outage to an
			// application's own authorization.
			assert.strictEqual(isCredentialRejection(new ClientError('Table system.hdb_role not found')), false);
			assert.strictEqual(isCredentialRejection(new ClientError('Login failed', 401)), false);
			assert.strictEqual(isCredentialRejection(new ClientError('token expired', 403)), false);
			assert.strictEqual(isCredentialRejection({ statusCode: 401 }), false);
			assert.strictEqual(isCredentialRejection({ status: 401 }), false);
		});

		it('rejects internal faults so they fail closed instead of deferring', () => {
			assert.strictEqual(isCredentialRejection(new ClientError('no encryption keys', 500)), false);
			assert.strictEqual(isCredentialRejection(new ServerError('storage unavailable')), false);
			assert.strictEqual(isCredentialRejection(new Error('ENOENT')), false);
			assert.strictEqual(isCredentialRejection(new TypeError('Invalid character')), false);
			assert.strictEqual(isCredentialRejection(undefined), false);
			assert.strictEqual(isCredentialRejection(null), false);
		});

		it('cannot be forged from outside the module', () => {
			// The tag is a module-private symbol, so neither a string key nor a registered symbol works.
			const forged = {
				'credentialRejection': true,
				'harper.credentialRejection': true,
				[Symbol.for('harper.credentialRejection')]: true,
			};

			assert.strictEqual(isCredentialRejection(forged), false);
		});

		it('leaves the tag off the wire: it is neither enumerable nor serializable', () => {
			const error = credentialRejectionError('Login failed', 401);

			assert.deepStrictEqual(Object.keys(error), ['statusCode']);
			assert.deepStrictEqual(Object.getOwnPropertySymbols({ ...error }), []);
			assert.strictEqual(JSON.stringify({ ...error }), '{"statusCode":401}');
		});
	});

	describe('deferCredentialRejection', () => {
		it('installs the state as a non-enumerable own property', () => {
			const request = { headers: { authorization: 'Basic d3A6c2VjcmV0' } };
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

			const stateSymbol = Object.getOwnPropertySymbols(request).find(
				(symbol) => symbol.description === 'harper.deferredCredentialRejection'
			);
			assert.ok(stateSymbol, 'the deferred state should be recorded under its own symbol');
			const descriptor = Object.getOwnPropertyDescriptor(request, stateSymbol);
			assert.strictEqual(descriptor.enumerable, false);
			assert.strictEqual(descriptor.configurable, true);
		});

		it('does not survive object spread into a downstream application copy', () => {
			// Object spread copies enumerable symbol-keyed properties, so an enumerable descriptor here
			// would put internal authentication state into whatever an application catch-all builds
			// from the request.
			const request = { headers: { authorization: 'Basic d3A6c2VjcmV0' } };
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

			const copied = { ...request };

			assert.deepStrictEqual(Object.getOwnPropertySymbols(copied), []);
			assert.strictEqual(getDeferredCredentialRejection(copied), undefined);
		});

		it('stays out of Object.keys and JSON.stringify', () => {
			const request = { headers: { authorization: 'Basic d3A6c2VjcmV0' } };
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

			assert.deepStrictEqual(Object.keys(request), ['headers']);
			assert.strictEqual(JSON.stringify(request), '{"headers":{"authorization":"Basic d3A6c2VjcmV0"}}');
		});

		it('leaves the inbound Authorization header byte-for-byte unchanged', () => {
			const authorization = 'Basic d29yZHByZXNzOmFiY2QgZWZnaCBpamtsIG1ub3AgcXJzdCB1dnd4';
			const request = { headers: { authorization } };
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

			assert.strictEqual(request.headers.authorization, authorization);
		});

		it('pins the deferred status to 401 even when the underlying rejection was a 403', () => {
			// The authentication middleware has always answered a rejected credential with 401
			// regardless of the error's own status, so a deferred rejection has to match that.
			const request = {};
			deferCredentialRejection(request, credentialRejectionError('token expired', 403), 'Bearer');

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
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
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

	describe('settleDeferredCredentialRejection', () => {
		it('returns undefined when nothing was deferred', () => {
			assert.strictEqual(settleDeferredCredentialRejection(requestAccepting('application/json')), undefined);
		});

		it('returns a real Headers, which the middleware 401 post-processing writes into', () => {
			// `security/auth.ts` calls `response.headers.set()` on whatever an owning layer returns —
			// WWW-Authenticate, or a Location when a login page is configured. A plain object 500s there.
			const request = requestAccepting('application/json');
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

			const settled = settleDeferredCredentialRejection(request);

			assert.strictEqual(typeof settled.headers.set, 'function');
			assert.doesNotThrow(() => settled.headers.set('WWW-Authenticate', 'Basic'));
			assert.strictEqual(settled.headers.get('WWW-Authenticate'), 'Basic');
		});

		it('reproduces the authentication middleware response: 401 with an {error} body', () => {
			// This is the wire contract callers have always seen for a rejected credential. An owning
			// layer's own error mapping (REST's RFC 9457 Problem Details, GraphQL's {errors:[…]}) must
			// not replace it.
			const request = requestAccepting('application/json');
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

			const settled = settleDeferredCredentialRejection(request);

			assert.strictEqual(settled.status, 401);
			assert.strictEqual(settled.headers.get('Content-Type'), 'application/json');
			assert.deepStrictEqual(JSON.parse(settled.body.toString()), { error: 'Login failed' });
		});

		it('serializes in the content type the request negotiated', () => {
			const request = requestAccepting('application/cbor');
			deferCredentialRejection(request, credentialRejectionError('invalid token', 401), 'Bearer');

			const settled = settleDeferredCredentialRejection(request);

			assert.strictEqual(settled.headers.get('Content-Type'), 'application/cbor');
			assert.ok(Buffer.isBuffer(settled.body), 'a CBOR body should be binary, not a JSON string');
		});

		it('carries the underlying rejection message, not a fixed one', () => {
			const request = requestAccepting('application/json');
			deferCredentialRejection(request, credentialRejectionError('token expired', 403), 'Bearer');

			const settled = settleDeferredCredentialRejection(request);

			assert.strictEqual(settled.status, 401);
			assert.deepStrictEqual(JSON.parse(settled.body.toString()), { error: 'token expired' });
		});
	});

	describe('assertNoDeferredCredentialRejection', () => {
		it('does nothing for a request with no deferred rejection', () => {
			assert.doesNotThrow(() => assertNoDeferredCredentialRejection({}));
		});

		it('throws the unauthorized ClientError an owning Harper layer renders', () => {
			const request = {};
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');

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
