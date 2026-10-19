const assert = require('node:assert');

const {
	assertNoDeferredCredentialRejection,
	authenticationChallenge,
	authenticationChallengeForError,
	credentialRejectionError,
	credentialRejectionResponse,
	deferCredentialRejection,
	deferredCredentialRejectionError,
	getDeferredCredentialRejection,
	isCredentialRejection,
	markCredentialRejection,
	settleDeferredCredentialRejection,
} = require('#src/security/deferredAuthentication');
const { ClientError, ServerError } = require('#src/utility/errors/hdbError');

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
		});

		it('cannot be cleared or changed by downstream middleware using reflection', () => {
			const request = requestAccepting('application/json');
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
			const stateSymbol = Object.getOwnPropertySymbols(request).find(
				(symbol) => symbol.description === 'harper.deferredCredentialRejection'
			);

			Reflect.deleteProperty(request, stateSymbol);
			Reflect.set(request, stateSymbol, undefined);
			const state = request[stateSymbol];
			if (state) Reflect.set(state, 'status', 200);

			const settled = settleDeferredCredentialRejection(request);
			assert.strictEqual(settled.status, 401);
			assert.deepStrictEqual(JSON.parse(settled.body.toString()), { error: 'Login failed' });
		});

		it('does not survive object spread into a downstream application copy', () => {
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

		it('preserves the first rejection when multiple route chains authenticate the request', () => {
			const request = {};
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
			deferCredentialRejection(request, credentialRejectionError('invalid token', 401), 'Bearer');

			assert.deepStrictEqual(getDeferredCredentialRejection(request), {
				status: 401,
				message: 'Login failed',
				strategy: 'Basic',
			});
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

		it('challenges in the scheme the rejected credential used', () => {
			const basic = requestAccepting('application/json');
			deferCredentialRejection(basic, credentialRejectionError('Login failed', 401), 'Basic');
			const session = requestAccepting('application/json');
			deferCredentialRejection(session, credentialRejectionError('SSO session expired', 401), 'Session');
			const bearer = requestAccepting('application/json');
			deferCredentialRejection(bearer, credentialRejectionError('invalid token', 401), 'Bearer');

			assert.strictEqual(
				settleDeferredCredentialRejection(basic).headers.get('WWW-Authenticate'),
				'Basic realm="Harper"'
			);
			assert.strictEqual(
				settleDeferredCredentialRejection(session).headers.get('WWW-Authenticate'),
				'Basic realm="Harper"'
			);
			assert.strictEqual(
				settleDeferredCredentialRejection(bearer).headers.get('WWW-Authenticate'),
				'Bearer realm="Harper", error="invalid_token"'
			);
		});

		it('reproduces the authentication middleware response: 401 with an {error} body', () => {
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

	describe('authenticationChallenge', () => {
		it('calls a Bearer token invalid only when the token itself was rejected', () => {
			assert.strictEqual(authenticationChallenge('Bearer', true), 'Bearer realm="Harper", error="invalid_token"');
			assert.strictEqual(authenticationChallenge('Bearer', false), 'Bearer realm="Harper"');
		});

		it('falls back to Basic for every other scheme and for no credential', () => {
			assert.strictEqual(authenticationChallenge('Digest', true), 'Basic realm="Harper"');
			assert.strictEqual(authenticationChallenge(), 'Basic realm="Harper"');
		});
	});

	describe('deferredCredentialRejectionError', () => {
		it('returns nothing when nothing was deferred', () => {
			assert.strictEqual(deferredCredentialRejectionError(requestAccepting('application/json')), undefined);
		});

		it('challenges by the deferred strategy, not by an Authorization header it never evaluated', () => {
			const request = requestAccepting('application/json', { authorization: 'Bearer some-downstream-token' });
			deferCredentialRejection(request, credentialRejectionError('Certificate rejected', 401), 'mTLS');

			const error = deferredCredentialRejectionError(request);

			assert.strictEqual(error.message, 'Certificate rejected');
			assert.strictEqual(error.statusCode, 401);
			assert.strictEqual(isCredentialRejection(error), true);
			assert.strictEqual(authenticationChallengeForError(error, 'Bearer'), 'Basic realm="Harper"');
		});

		it('falls back to the presented scheme for an error that settled no deferral', () => {
			assert.strictEqual(
				authenticationChallengeForError(credentialRejectionError('invalid token', 401), 'Bearer'),
				'Bearer realm="Harper", error="invalid_token"'
			);
			assert.strictEqual(
				authenticationChallengeForError(new Error('key store down'), 'Bearer'),
				'Bearer realm="Harper"'
			);
			assert.strictEqual(authenticationChallengeForError(undefined, undefined), 'Basic realm="Harper"');
		});
	});

	describe('credentialRejectionResponse', () => {
		it('gives the operations API a Content-Type but no challenge', () => {
			const request = { ...requestAccepting('application/json'), isOperationsServer: true };

			const response = credentialRejectionResponse(request, 401, 'Login failed', 'Basic', true);

			assert.strictEqual(response.headers.get('Content-Type'), 'application/json');
			assert.strictEqual(response.headers.get('WWW-Authenticate') ?? null, null);
			assert.deepStrictEqual(JSON.parse(response.body.toString()), { error: 'Login failed' });
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
