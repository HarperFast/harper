/**
 * Drives the real `authentication` middleware through a real `authentication -> rest -> application
 * catch-all` chain built by `server/middlewareChain.ts`.
 *
 * On the pre-fix revision every "reaches the application catch-all" case here fails: `security/auth.ts`
 * answered 401 during credential parsing, so the chain terminated before route ownership was known.
 */
const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { makeCallbackChain } = require('#src/server/middlewareChain');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { credentialRejectionError, settleDeferredCredentialRejection } = require('#src/security/deferredAuthentication');
const { ClientError, ServerError } = require('#src/utility/errors/hdbError');
const serverModule = require('#src/server/Server');
const tokenAuthentication = require('#src/security/tokenAuthentication');
const { authentication } = require('#src/security/auth');

const HARPER_OWNED = '/Ledger/1';
// A Harper-owned route that serves anonymous callers — the case where 'continued as anonymous'
// and 'rejected the credential' produce visibly different responses.
const HARPER_OWNED_PUBLIC = '/PublicNotice/1';
const APP_OWNED = '/wp-json/wc/v3/products';

// A WordPress Application Password, base64'd exactly as WordPress sends it — spaces and all.
const WORDPRESS_BASIC = `Basic ${Buffer.from('wordpress:abcd efgh ijkl mnop qrst uvwx').toString('base64')}`;
const HARPER_BASIC = `Basic ${Buffer.from('harper_admin:harper-pw').toString('base64')}`;
const DOWNSTREAM_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.d29vLXNlc3Npb24.not-a-harper-token';

function makeRequest(pathname, authorization, extra = {}) {
	const headerObject = authorization ? { authorization } : {};
	return {
		method: 'GET',
		url: pathname,
		pathname,
		ip: '203.0.113.7',
		headers: {
			asObject: headerObject,
			get: (name) => headerObject[name.toLowerCase()],
		},
		peerCertificate: { subject: null },
		...extra,
	};
}

describe('deferred credential rejection through the app-port middleware chain', () => {
	let originalGetUser;
	let originalValidateOperationToken;
	let originalValidateRefreshToken;
	/** Records what each layer saw, so "which layer answered" is observable rather than inferred. */
	let trace;
	/** Pathnames Harper claims ownership of, standing in for `resources.getMatch`. */
	let ownedPaths;
	/** Users the Harper credential store recognizes, keyed by `username:password`. */
	let knownUsers;
	/** When set, `getUser` raises this instead of resolving — an internal authentication fault. */
	let getUserFault;

	/**
	 * Mirrors `server/REST.ts`'s ownership branch: unowned URLs pass to the next layer untouched,
	 * owned ones settle any deferred credential through the same production assertion REST calls.
	 */
	function restLayer(request, nextHandler) {
		if (!ownedPaths.has(request.pathname)) return nextHandler(request);
		trace.push('rest');
		// The production settlement helper, not a local re-implementation: it is what decides the
		// status, body, and content type an owning Harper layer returns.
		const settled = settleDeferredCredentialRejection(request);
		if (settled) return settled;
		if (!request.user && request.pathname !== HARPER_OWNED_PUBLIC)
			return { status: 401, headers: new Headers(), body: JSON.stringify({ error: 'Login failed' }) };
		return {
			status: 200,
			headers: new Headers(),
			body: JSON.stringify({ servedBy: 'rest', user: request.user?.username ?? null }),
		};
	}

	/** The application's own middleware, mounted after `rest`, applying its own auth scheme. */
	function applicationCatchAll(request) {
		trace.push('catch-all');
		return {
			status: 200,
			headers: new Headers(),
			body: JSON.stringify({
				servedBy: 'catch-all',
				authorization: request.headers.asObject.authorization ?? null,
				harperUser: request.user?.username ?? null,
			}),
		};
	}

	const chain = makeCallbackChain(
		[
			{ listener: applicationCatchAll, port: 'all', name: 'applicationCatchAll', after: 'rest' },
			{ listener: authentication, port: 'all', name: 'authentication' },
			{ listener: restLayer, port: 'all', name: 'rest', after: 'authentication' },
		],
		'all',
		() => ({ status: 404, headers: new Headers(), body: 'Not found' })
	);

	async function send(pathname, authorization, extra) {
		const request = makeRequest(pathname, authorization, extra);
		const response = await chain(request);
		return { request, response, body: response?.body ? JSON.parse(response.body) : undefined };
	}

	before(() => {
		originalGetUser = serverModule.server.getUser;
		originalValidateOperationToken = tokenAuthentication.validateOperationToken;
		originalValidateRefreshToken = tokenAuthentication.validateRefreshToken;

		// The stubs raise what production raises: `findAndValidateUser()` and `validateToken()` tag a
		// rejected credential explicitly, and an untagged error is by construction an internal fault.
		serverModule.server.getUser = async (username, password) => {
			if (getUserFault) throw getUserFault;
			const user = knownUsers.get(`${username}:${password}`);
			if (!user) throw credentialRejectionError('Login failed', 401);
			return user;
		};
		tokenAuthentication.validateOperationToken = async () => {
			throw credentialRejectionError('invalid token', 401);
		};
		tokenAuthentication.validateRefreshToken = async () => {
			throw credentialRejectionError('invalid token', 401);
		};
	});

	after(() => {
		serverModule.server.getUser = originalGetUser;
		tokenAuthentication.validateOperationToken = originalValidateOperationToken;
		tokenAuthentication.validateRefreshToken = originalValidateRefreshToken;
	});

	beforeEach(() => {
		trace = [];
		ownedPaths = new Set([HARPER_OWNED, HARPER_OWNED_PUBLIC]);
		knownUsers = new Map([['harper_admin:harper-pw', { username: 'harper_admin', role: { permission: {} } }]]);
		getUserFault = undefined;
	});

	it('resolves the chain as authentication -> rest -> application catch-all', async () => {
		// The order is what makes the rest of this suite meaningful: `rest` must get first refusal on
		// every URL, and the application middleware must only see what `rest` declined.
		const { body } = await send(APP_OWNED, undefined);

		assert.deepStrictEqual(trace, ['catch-all']);
		assert.strictEqual(body.servedBy, 'catch-all');

		const owned = await send(HARPER_OWNED, HARPER_BASIC);
		assert.deepStrictEqual(trace, ['catch-all', 'rest']);
		assert.strictEqual(owned.body.servedBy, 'rest');
	});

	it('authenticates valid Harper Basic credentials and serves the owned resource', async () => {
		const { request, body, response } = await send(HARPER_OWNED, HARPER_BASIC);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(request.user.username, 'harper_admin');
		assert.strictEqual(body.user, 'harper_admin');
		assert.deepStrictEqual(trace, ['rest']);
	});

	it('hands an unrecognized WordPress Basic credential to the catch-all, byte-for-byte', async () => {
		const { request, response, body } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		// The header the application receives must be the header the client sent — no rename, no
		// carrier header, no stripping.
		assert.strictEqual(body.authorization, WORDPRESS_BASIC);
		assert.strictEqual(request.headers.asObject.authorization, WORDPRESS_BASIC);
		// And no Harper principal was invented along the way.
		assert.strictEqual(body.harperUser, null);
		assert.strictEqual(request.user, undefined);
	});

	it('gives a downstream-owned Bearer token the same treatment as Basic', async () => {
		const { response, body } = await send(APP_OWNED, DOWNSTREAM_BEARER);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.authorization, DOWNSTREAM_BEARER);
		assert.strictEqual(body.harperUser, null);
	});

	it('lets a Harper refresh token keep its declined (-1) handling instead of deferring', async () => {
		// A refresh token is Harper's own credential: `authentication` declines the request so the
		// operations API can handle it, and that must not turn into a deferral to the application.
		tokenAuthentication.validateRefreshToken = async () => ({ username: 'harper_admin' });
		try {
			const { response } = await send(APP_OWNED, 'Bearer harper-refresh-token');

			assert.strictEqual(response.status, -1);
			assert.deepStrictEqual(trace, []);
		} finally {
			tokenAuthentication.validateRefreshToken = async () => {
				throw credentialRejectionError('invalid token', 401);
			};
		}
	});

	it('rejects an unrecognized credential at a Harper-owned route and never reaches the catch-all', async () => {
		const { response, body } = await send(HARPER_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		assert.strictEqual(body.error, 'Login failed');
		assert.deepStrictEqual(trace, ['rest']);
		assert.ok(!trace.includes('catch-all'), 'a Harper-owned route must not fall through to the application');
	});

	it('rejects an invalid Harper Bearer token at a Harper-owned route', async () => {
		const { response, body } = await send(HARPER_OWNED, DOWNSTREAM_BEARER);

		assert.strictEqual(response.status, 401);
		assert.strictEqual(body.error, 'invalid token');
		assert.deepStrictEqual(trace, ['rest']);
	});

	it('reports an expired Harper token as 401 at a Harper-owned route, as it did before deferral', async () => {
		tokenAuthentication.validateOperationToken = async () => {
			throw credentialRejectionError('token expired', 403);
		};
		try {
			const { response, body } = await send(HARPER_OWNED, 'Bearer expired-harper-token');

			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'token expired');
			assert.deepStrictEqual(trace, ['rest']);
		} finally {
			tokenAuthentication.validateOperationToken = async () => {
				throw credentialRejectionError('invalid token', 401);
			};
		}
	});

	it('does not downgrade a Harper-owned route to public just because the credential was unknown', async () => {
		// This route serves anonymous callers, so an unknown credential that merely became
		// "anonymous" would be handed the content. The deferred rejection wins instead.
		const anonymous = await send(HARPER_OWNED_PUBLIC, undefined);
		assert.strictEqual(anonymous.response.status, 200);

		const withUnknownCredential = await send(HARPER_OWNED_PUBLIC, WORDPRESS_BASIC);
		assert.strictEqual(withUnknownCredential.response.status, 401);
		assert.strictEqual(withUnknownCredential.body.error, 'Login failed');
	});

	it('defers a scheme Harper does not implement rather than continuing anonymously', async () => {
		// Reported by review on this PR: `Digest` matches no case in the strategy switch and throws
		// nothing, so before this it fell through as an anonymous request.
		const digest = 'Digest username="wp", realm="site", response="0123456789abcdef"';
		const { request, response, body } = await send(APP_OWNED, digest);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		assert.strictEqual(body.authorization, digest);
		assert.strictEqual(request.user, undefined);
	});

	it('rejects a scheme Harper does not implement at an anonymously-readable Harper route', async () => {
		// The decisive case: this route serves anonymous callers, so continuing as anonymous would
		// return 200. Only an actual deferred rejection produces the 401.
		const anonymous = await send(HARPER_OWNED_PUBLIC, undefined);
		assert.strictEqual(anonymous.response.status, 200);

		const { response, body } = await send(HARPER_OWNED_PUBLIC, 'Digest username="wp", response="deadbeef"');
		assert.strictEqual(response.status, 401);
		assert.strictEqual(body.error, 'Login failed');
		assert.deepStrictEqual(trace, ['rest', 'rest']);
	});

	it('treats an Authorization header with no scheme token as an unrecognized credential', async () => {
		const { response } = await send(HARPER_OWNED_PUBLIC, 'aGFyZGx5LWEtc2NoZW1l');

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(trace, ['rest']);
	});

	it('fails an unimplemented scheme closed in place on the operations API', async () => {
		const { response } = await send(APP_OWNED, 'Digest username="wp"', { isOperationsServer: true });

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(trace, []);
	});

	it('keeps the legacy blank Basic credential anonymous instead of deferring it', async () => {
		// `Basic ` + base64(':') is the documented "no auth" form: it must stay anonymous, so the
		// unrecognized-scheme rejection above is gated on a strictly `undefined` user, not a nullish one.
		const blank = `Basic ${Buffer.from(':').toString('base64')}`;
		const { request, response, body } = await send(APP_OWNED, blank);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		assert.strictEqual(request.user, null);
		// Anonymous, not deferred — so an anonymously-readable Harper route still serves it.
		const owned = await send(HARPER_OWNED_PUBLIC, blank);
		assert.strictEqual(owned.response.status, 200);
	});

	it('leaves a request with no credentials completely unchanged', async () => {
		const { request, response, body } = await send(APP_OWNED, undefined);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.authorization, null);
		assert.strictEqual(request.user, undefined);
		assert.deepStrictEqual(trace, ['catch-all']);
	});

	it('fails closed on an internal authentication fault instead of deferring', async () => {
		getUserFault = new ServerError('user store unavailable');

		const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		// The whole point: an outage must not hand the request to the application's own authorization.
		assert.deepStrictEqual(trace, []);
	});

	it('fails closed when the credential store raises a bare, unclassified error', async () => {
		getUserFault = new Error('ENOENT: hdb_user');

		const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(trace, []);
	});

	it('fails closed on an internal fault that happens to carry a 4xx status', async () => {
		// The exact production shape: `findAndValidateUser()` lazily loads the user cache, whose
		// system-table searches reach `ResourceBridge.searchByValue()` and raise a `ClientError` with
		// the default 400 status when `system.hdb_role`/`system.hdb_user` is unavailable. Classifying
		// by status range read that as an ordinary unknown credential and deferred it, so an unowned
		// URL reached the application catch-all during a storage outage.
		getUserFault = new ClientError('Table system.hdb_role not found');
		assert.strictEqual(getUserFault.statusCode, 400, 'the fault must actually be in the 4xx range');

		const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(trace, [], 'a storage outage must never reach application authorization');
	});

	it('returns a generic failure for an internal fault and does not echo its message', async () => {
		getUserFault = new ClientError('Table system.hdb_role not found');

		const { response, body } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		assert.strictEqual(body.error, 'Login failed');
		assert.ok(!JSON.stringify(body).includes('hdb_role'), 'internal detail must not reach the client');
	});

	it('propagates a refresh-validation fault instead of restoring the deferrable outer rejection', async () => {
		// The operation-token path falls back to refresh-token validation on `invalid token`. Discarding
		// whatever that raises and rethrowing the outer ordinary rejection let a refresh-side storage or
		// runtime fault be classified as a deferrable unknown credential.
		tokenAuthentication.validateRefreshToken = async () => {
			throw new ServerError('refresh token store unavailable');
		};
		try {
			const { response, body } = await send(APP_OWNED, 'Bearer some-harper-looking-token');

			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'Login failed');
			assert.deepStrictEqual(trace, [], 'a refresh-validation fault must not reach the catch-all');
		} finally {
			tokenAuthentication.validateRefreshToken = async () => {
				throw credentialRejectionError('invalid token', 401);
			};
		}
	});

	it('propagates a refresh-validation fault that carries a 4xx status', async () => {
		tokenAuthentication.validateRefreshToken = async () => {
			throw new ClientError('Table system.hdb_user not found');
		};
		try {
			const { response } = await send(APP_OWNED, 'Bearer some-harper-looking-token');

			assert.strictEqual(response.status, 401);
			assert.deepStrictEqual(trace, []);
		} finally {
			tokenAuthentication.validateRefreshToken = async () => {
				throw credentialRejectionError('invalid token', 401);
			};
		}
	});

	it('restores the operation-token rejection after an ordinary refresh rejection, and defers it', async () => {
		// The other half of the same branch: an ordinary tagged refresh rejection still yields the
		// original `invalid token`, which is deferrable.
		const { response, body } = await send(APP_OWNED, DOWNSTREAM_BEARER);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		assert.strictEqual(body.authorization, DOWNSTREAM_BEARER);
	});

	it("answers a Harper-owned route with the authentication error envelope, not the owner's", async () => {
		// `{error: message}` in the request's negotiated serialization is what authentication returned
		// in line before deferral existed; REST's RFC 9457 Problem Details mapping must not replace it.
		const { response, body } = await send(HARPER_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(body, { error: 'Login failed' });
		assert.strictEqual(response.headers.get('Content-Type'), 'application/json');
	});

	it('never defers on the operations API, where Harper owns every route', async () => {
		const { response } = await send(APP_OWNED, WORDPRESS_BASIC, { isOperationsServer: true });

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(trace, []);
	});

	it('marks a deferred-credential response as identity-dependent for shared caches', async () => {
		// The application answered using the Authorization header Harper passed through, so the
		// response is credential-dependent even though no Harper principal was resolved (#1565).
		const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.headers.get('Vary').includes('Authorization'), true);
		assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-cache');
	});

	it('does not stamp the identity floor on an ordinary anonymous pass-through', async () => {
		const { response } = await send(APP_OWNED, undefined);

		assert.strictEqual(response.headers?.get?.('Cache-Control') ?? null, null);
	});
});
