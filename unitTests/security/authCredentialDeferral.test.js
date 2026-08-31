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
const { assertNoDeferredCredentialRejection } = require('#src/security/deferredAuthentication');
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
		try {
			assertNoDeferredCredentialRejection(request);
		} catch (error) {
			return { status: error.statusCode, headers: new Headers(), body: JSON.stringify({ error: error.message }) };
		}
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

		serverModule.server.getUser = async (username, password) => {
			if (getUserFault) throw getUserFault;
			const user = knownUsers.get(`${username}:${password}`);
			if (!user) throw new ClientError('Login failed', 401);
			return user;
		};
		tokenAuthentication.validateOperationToken = async () => {
			throw new ClientError('invalid token', 401);
		};
		tokenAuthentication.validateRefreshToken = async () => {
			throw new ClientError('invalid token', 401);
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
				throw new ClientError('invalid token', 401);
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
			throw new ClientError('token expired', 403);
		};
		try {
			const { response, body } = await send(HARPER_OWNED, 'Bearer expired-harper-token');

			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'token expired');
			assert.deepStrictEqual(trace, ['rest']);
		} finally {
			tokenAuthentication.validateOperationToken = async () => {
				throw new ClientError('invalid token', 401);
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
