const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { makeCallbackChain } = require('#src/server/middlewareChain');
const { Headers } = require('#src/server/serverHelpers/Headers');
const {
	credentialRejectionError,
	settleDeferredCredentialRejection,
	assertNoDeferredCredentialRejection,
} = require('#src/security/deferredAuthentication');
const { ClientError, ServerError } = require('#src/utility/errors/hdbError');
const serverModule = require('#src/server/Server');
const resourcesModule = require('#src/resources/Resources');
const tokenAuthentication = require('#src/security/tokenAuthentication');
const { databases } = require('#src/resources/databases');
const { authentication } = require('#src/security/auth');

const HARPER_OWNED = '/Ledger/1';
const HARPER_OWNED_PUBLIC = '/PublicNotice/1';
const APP_OWNED = '/wp-json/wc/v3/products';

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
	let trace;
	let ownedPaths;
	let knownUsers;
	let getUserFault;

	function restLayer(request, nextHandler) {
		if (!ownedPaths.has(request.pathname)) return nextHandler(request);
		trace.push('rest');
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

	let catchAllResponse;

	function applicationCatchAll(request) {
		trace.push('catch-all');
		if (catchAllResponse) return catchAllResponse();
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

	before(async () => {
		await testUtils.ensureSystemTables();
		originalGetUser = serverModule.server.getUser;
		originalValidateOperationToken = tokenAuthentication.validateOperationToken;
		originalValidateRefreshToken = tokenAuthentication.validateRefreshToken;

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

	before(() => {
		if (!resourcesModule.resources) resourcesModule.resetResources();
	});

	beforeEach(() => {
		trace = [];
		ownedPaths = new Set([HARPER_OWNED, HARPER_OWNED_PUBLIC]);
		knownUsers = new Map([['harper_admin:harper-pw', { username: 'harper_admin', role: { permission: {} } }]]);
		getUserFault = undefined;
		catchAllResponse = undefined;
		delete resourcesModule.resources.loginPath;
	});

	afterEach(() => {
		delete resourcesModule.resources.loginPath;
	});

	it('resolves the chain as authentication -> rest -> application catch-all', async () => {
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
		assert.strictEqual(body.authorization, WORDPRESS_BASIC);
		assert.strictEqual(request.headers.asObject.authorization, WORDPRESS_BASIC);
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
		const anonymous = await send(HARPER_OWNED_PUBLIC, undefined);
		assert.strictEqual(anonymous.response.status, 200);

		const withUnknownCredential = await send(HARPER_OWNED_PUBLIC, WORDPRESS_BASIC);
		assert.strictEqual(withUnknownCredential.response.status, 401);
		assert.strictEqual(withUnknownCredential.body.error, 'Login failed');
	});

	it('defers a scheme Harper does not implement rather than continuing anonymously', async () => {
		const digest = 'Digest username="wp", realm="site", response="0123456789abcdef"';
		const { request, response, body } = await send(APP_OWNED, digest);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		assert.strictEqual(body.authorization, digest);
		assert.strictEqual(request.user, undefined);
	});

	it('rejects a scheme Harper does not implement at an anonymously-readable Harper route', async () => {
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
		const blank = `Basic ${Buffer.from(':').toString('base64')}`;
		const { request, response, body } = await send(APP_OWNED, blank);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		assert.strictEqual(request.user, null);
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
		assert.deepStrictEqual(trace, []);
	});

	it('fails closed when the credential store raises a bare, unclassified error', async () => {
		getUserFault = new Error('ENOENT: hdb_user');

		const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(trace, []);
	});

	it('fails closed on an internal fault that happens to carry a 4xx status', async () => {
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
		const { response, body } = await send(APP_OWNED, DOWNSTREAM_BEARER);

		assert.strictEqual(response.status, 200);
		assert.strictEqual(body.servedBy, 'catch-all');
		assert.strictEqual(body.authorization, DOWNSTREAM_BEARER);
	});

	it("answers a Harper-owned route with the authentication error envelope, not the owner's", async () => {
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
		const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

		assert.strictEqual(response.headers.get('Vary').includes('Authorization'), true);
		assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-cache');
	});

	it('does not stamp the identity floor on an ordinary anonymous pass-through', async () => {
		const { response } = await send(APP_OWNED, undefined);

		assert.strictEqual(response.headers?.get?.('Cache-Control') ?? null, null);
	});
	describe('401 post-processing ownership', () => {
		const BROWSER = {
			'user-agent': 'Mozilla/5.0 (Macintosh)',
			'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		};

		function browserRequestExtra(authorization) {
			const headerObject = { ...BROWSER };
			if (authorization) headerObject.authorization = authorization;
			return {
				headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
			};
		}

		async function sendBrowser(pathname, authorization) {
			const request = makeRequest(pathname, authorization, browserRequestExtra(authorization));
			const response = await chain(request);
			return { request, response };
		}

		it("leaves an application catch-all's own 401 challenge untouched", async () => {
			catchAllResponse = () => ({
				status: 401,
				headers: new Headers({ 'WWW-Authenticate': 'Basic realm="WooCommerce", charset="UTF-8"' }),
				body: JSON.stringify({ code: 'woocommerce_rest_authentication_error' }),
			});

			const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

			assert.deepStrictEqual(trace, ['catch-all']);
			assert.strictEqual(response.status, 401);
			assert.strictEqual(response.headers.get('WWW-Authenticate'), 'Basic realm="WooCommerce", charset="UTF-8"');
		});

		it("does not redirect a browser to Harper's login page over an application-owned 401", async () => {
			resourcesModule.resources.loginPath = () => '/login';
			catchAllResponse = () => ({
				status: 401,
				headers: new Headers({ 'WWW-Authenticate': 'Bearer realm="woo"' }),
				body: JSON.stringify({ code: 'woocommerce_rest_authentication_error' }),
			});

			const { response } = await sendBrowser(APP_OWNED, WORDPRESS_BASIC);

			assert.strictEqual(response.status, 401);
			assert.strictEqual(response.headers.get('Location') ?? null, null);
			assert.strictEqual(response.headers.get('WWW-Authenticate'), 'Bearer realm="woo"');
		});

		it('still applies the identity floor to an application-owned 401', async () => {
			catchAllResponse = () => ({ status: 401, headers: new Headers(), body: '{}' });

			const { response } = await send(APP_OWNED, WORDPRESS_BASIC);

			assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-cache');
			assert.ok(response.headers.get('Vary').includes('Authorization'));
		});

		it('keeps a settled Harper-owned rejection wire-identical to the in-line 401 it replaced', async () => {
			resourcesModule.resources.loginPath = () => '/login';

			const { response } = await sendBrowser(HARPER_OWNED, WORDPRESS_BASIC);

			assert.strictEqual(response.status, 401);
			assert.strictEqual(response.headers.get('Location') ?? null, null);
			assert.strictEqual(response.headers.get('WWW-Authenticate') ?? null, null);
			assert.deepStrictEqual(JSON.parse(response.body), { error: 'Login failed' });
		});

		it('still redirects a browser with no credentials at all to the login page', async () => {
			resourcesModule.resources.loginPath = () => '/login';

			const { response } = await sendBrowser(HARPER_OWNED, undefined);

			assert.strictEqual(response.status, 302);
			assert.strictEqual(response.headers.get('Location'), '/login');
		});

		it('still challenges an uncredentialed non-browser 401 with WWW-Authenticate', async () => {
			const { response } = await send(HARPER_OWNED, undefined);

			assert.strictEqual(response.status, 401);
			assert.strictEqual(response.headers.get('WWW-Authenticate'), 'Basic');
		});
	});
});

describe('#2703 principal resolution failures become decisions, not thrown errors', () => {
	const SESSION_ID = 'sess-2703';
	const SESSION_USER = 'staff@example.com';
	// the cookie name is prefixed with the origin, with its first non-word character replaced
	const SESSION_COOKIE = `example_com-hdb-session=${SESSION_ID}`;
	const CERT_CN = 'svc.example.com';

	const sessionTable = databases.system.hdb_session;
	let originalGetUser;
	let originalValidateOperationToken;

	let trace;
	let ownedPaths;
	let getUserOutcomes;
	let getUserCalls;

	function restLayer(request, nextHandler) {
		if (!ownedPaths.has(request.pathname)) return nextHandler(request);
		trace.push('rest');
		const settled = settleDeferredCredentialRejection(request);
		if (settled) return settled;
		if (!request.user) return { status: 401, headers: new Headers(), body: JSON.stringify({ error: 'Login failed' }) };
		return {
			status: 200,
			headers: new Headers(),
			body: JSON.stringify({ servedBy: 'rest', user: request.user?.username ?? null }),
		};
	}

	function applicationCatchAll(request) {
		trace.push('catch-all');
		return {
			status: 200,
			headers: new Headers(),
			body: JSON.stringify({ servedBy: 'catch-all', harperUser: request.user?.username ?? null }),
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

	async function send(pathname, { cookie, mtls, mtlsUser = 'CN', authorization, isOperationsServer } = {}) {
		const headerObject = { host: 'example.com' };
		if (cookie) headerObject.cookie = cookie;
		if (authorization) headerObject.authorization = authorization;
		const request = {
			method: 'GET',
			url: pathname,
			pathname,
			ip: '203.0.113.7',
			headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
			peerCertificate: mtls ? { subject: { CN: CERT_CN } } : { subject: null },
			...(mtls ? { mtlsConfig: { user: mtlsUser }, authorized: true } : {}),
			...(isOperationsServer ? { isOperationsServer: true } : {}),
		};
		let thrown;
		let response;
		try {
			response = await chain(request);
		} catch (error) {
			thrown = error;
		}
		return { request, response, thrown, body: response?.body ? JSON.parse(response.body) : undefined };
	}

	before(async () => {
		originalGetUser = serverModule.server.getUser;
		originalValidateOperationToken = tokenAuthentication.validateOperationToken;

		await sessionTable.put({ id: SESSION_ID, user: SESSION_USER });
		serverModule.server.getUser = async (username) => {
			getUserCalls.push(username);
			const outcome = getUserOutcomes.get(username);
			if (outcome) throw outcome;
			return { username, role: { permission: {} } };
		};
	});

	after(async () => {
		await sessionTable.delete(SESSION_ID);
		serverModule.server.getUser = originalGetUser;
		tokenAuthentication.validateOperationToken = originalValidateOperationToken;
	});

	beforeEach(() => {
		trace = [];
		ownedPaths = new Set([HARPER_OWNED]);
		getUserOutcomes = new Map();
		getUserCalls = [];
	});

	describe('cookie session', () => {
		it('serves an application-owned route normally when the session is rejected', async () => {
			getUserOutcomes.set(SESSION_USER, credentialRejectionError('SSO session expired', 401));

			const { request, response, thrown, body } = await send(APP_OWNED, { cookie: SESSION_COOKIE });

			assert.strictEqual(thrown, undefined, 'the rejection must not escape the middleware chain');
			assert.strictEqual(response.status, 200);
			assert.strictEqual(body.servedBy, 'catch-all');
			assert.strictEqual(request.user, undefined);
			assert.strictEqual(body.harperUser, null);
		});

		it('answers a Harper-owned route with the negotiated 401 envelope', async () => {
			getUserOutcomes.set(SESSION_USER, credentialRejectionError('SSO session expired', 401));

			const { response, body } = await send(HARPER_OWNED, { cookie: SESSION_COOKIE });

			assert.strictEqual(response.status, 401);
			assert.deepStrictEqual(body, { error: 'SSO session expired' });
			assert.strictEqual(response.headers.get('Content-Type'), 'application/json');
			assert.deepStrictEqual(trace, ['rest']);
		});

		it('fails closed in place on an internal fault instead of deferring', async () => {
			getUserOutcomes.set(SESSION_USER, new ServerError('user store unavailable'));

			const { response, body, thrown } = await send(APP_OWNED, { cookie: SESSION_COOKIE });

			assert.strictEqual(thrown, undefined);
			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'Login failed');
			assert.deepStrictEqual(trace, [], 'an internal fault must not reach the application');
		});

		it('fails closed on an internal fault that happens to carry a 4xx status', async () => {
			getUserOutcomes.set(SESSION_USER, new ClientError('Table system.hdb_role not found'));

			const { response, body } = await send(APP_OWNED, { cookie: SESSION_COOKIE });

			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'Login failed');
			assert.ok(!JSON.stringify(body).includes('hdb_role'), 'internal detail must not reach the client');
		});

		it('decides a rejected session in place on the operations API, keeping the tagged message', async () => {
			getUserOutcomes.set(SESSION_USER, credentialRejectionError('SSO session expired', 401));

			const { response, body } = await send(APP_OWNED, { cookie: SESSION_COOKIE, isOperationsServer: true });

			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'SSO session expired');
			assert.deepStrictEqual(trace, [], 'Harper owns every operations route, so it never defers');
		});

		it('still authenticates a session the override accepts', async () => {
			const { response, body } = await send(HARPER_OWNED, { cookie: SESSION_COOKIE });

			assert.strictEqual(response.status, 200);
			assert.strictEqual(body.user, SESSION_USER);
		});

		it('marks a deferred session rejection as identity-dependent for shared caches', async () => {
			getUserOutcomes.set(SESSION_USER, credentialRejectionError('SSO session expired', 401));

			const { response } = await send(APP_OWNED, { cookie: SESSION_COOKIE });

			assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-cache');
			assert.ok(response.headers.get('Vary').includes('Cookie'));
		});
	});

	describe('mTLS certificate identity', () => {
		it('defers a rejected certificate identity instead of throwing out of the chain', async () => {
			getUserOutcomes.set(CERT_CN, credentialRejectionError('certificate user revoked', 401));

			const { request, response, thrown, body } = await send(APP_OWNED, { mtls: true });

			assert.strictEqual(thrown, undefined);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(body.servedBy, 'catch-all');
			assert.strictEqual(request.user, undefined);
		});

		it('does not fall through to Basic after the certificate identity was rejected', async () => {
			getUserOutcomes.set(CERT_CN, credentialRejectionError('certificate user revoked', 401));

			const { request, body } = await send(APP_OWNED, { mtls: true, authorization: HARPER_BASIC });

			assert.deepStrictEqual(getUserCalls, [CERT_CN], 'Basic must not be attempted after a rejected certificate');
			assert.strictEqual(request.user, undefined);
			assert.strictEqual(body.harperUser, null);
		});

		it('does not fall through to the cookie session after the certificate identity was rejected', async () => {
			getUserOutcomes.set(CERT_CN, credentialRejectionError('certificate user revoked', 401));

			const { request } = await send(APP_OWNED, { mtls: true, cookie: SESSION_COOKIE });

			assert.deepStrictEqual(getUserCalls, [CERT_CN]);
			assert.strictEqual(request.user, undefined);
		});

		it('rejects a certificate identity at a Harper-owned route with the negotiated envelope', async () => {
			getUserOutcomes.set(CERT_CN, credentialRejectionError('certificate user revoked', 401));

			const { response, body } = await send(HARPER_OWNED, { mtls: true });

			assert.strictEqual(response.status, 401);
			assert.deepStrictEqual(body, { error: 'certificate user revoked' });
		});

		it('fails closed in place on an internal fault resolving the certificate identity', async () => {
			getUserOutcomes.set(CERT_CN, new ServerError('user store unavailable'));

			const { response, body, thrown } = await send(APP_OWNED, { mtls: true });

			assert.strictEqual(thrown, undefined);
			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'Login failed');
			assert.deepStrictEqual(trace, []);
		});

		it('still authenticates a certificate identity the override accepts', async () => {
			const { request, response, body } = await send(HARPER_OWNED, { mtls: true });

			assert.strictEqual(response.status, 200);
			assert.strictEqual(request.user.username, CERT_CN);
			assert.strictEqual(body.user, CERT_CN);
		});

		it('leaves regular authentication to run when the certificate names no user', async () => {
			const { request } = await send(APP_OWNED, { mtls: true, mtlsUser: null, authorization: HARPER_BASIC });

			// the resolved principal must be the Basic user, not one derived from the certificate
			assert.strictEqual(request.user?.username, 'harper_admin');
			assert.ok(!getUserCalls.includes(CERT_CN), 'the certificate CN must not be resolved as a user');
		});
	});

	// A WebSocket/MQTT upgrade only awaits the chain (server/REST.ts, server/mqtt.ts) and never reads
	// its resolved value, so an in-place 401 is invisible to it unless it is recorded on the request.
	describe('an in-place rejection still fails an upgrade closed', () => {
		it('throws for an internal fault resolving a cookie session, with the generic message', async () => {
			getUserOutcomes.set(SESSION_USER, new ServerError('user store unavailable'));

			const { request } = await send(APP_OWNED, { cookie: SESSION_COOKIE });

			assert.throws(
				() => assertNoDeferredCredentialRejection(request),
				(error) => error.statusCode === 401 && error.message === 'Login failed'
			);
		});

		it('throws for an internal fault resolving a certificate identity', async () => {
			getUserOutcomes.set(CERT_CN, new ServerError('user store unavailable'));

			const { request } = await send(APP_OWNED, { mtls: true });

			assert.throws(() => assertNoDeferredCredentialRejection(request), /Login failed/);
		});

		it('leaves a successfully authenticated upgrade alone', async () => {
			const { request } = await send(APP_OWNED, { cookie: SESSION_COOKIE });

			assert.doesNotThrow(() => assertNoDeferredCredentialRejection(request));
		});
	});

	describe('operations API keeps a tagged rejection message', () => {
		it('does not replace a tagged Authorization rejection with the generic message', async () => {
			tokenAuthentication.validateOperationToken = async () => {
				throw credentialRejectionError('token expired', 403);
			};

			const { response, body } = await send(APP_OWNED, {
				authorization: 'Bearer expired-harper-token',
				isOperationsServer: true,
			});

			assert.strictEqual(response.status, 401);
			assert.strictEqual(body.error, 'token expired');
		});
	});
});

describe('server.registerBearerValidator (#oauth/279)', () => {
	const userModule = require('#src/security/user');
	const logger = require('#src/utility/logging/harper_logger');
	const { getSession, replayLastWill } = require('#src/server/DurableSubscriptionsSession');

	let originalValidateOperationToken;
	let originalValidateRefreshToken;
	let trace;
	let ownedPaths;
	let unregisters = [];
	let originalServerGetUser;
	const externalUsers = new Map();

	/** Names a user only a component's server.getUser knows (no hdb_user row); a validator returns the result. */
	function externalUser(username, permission = { super_user: false }) {
		externalUsers.set(username, permission);
		return { username };
	}

	// .mocharc.json disables timeouts, so a promise that never settles would hang the run
	function bounded(promise, label, ms = 2_000) {
		let timer;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
		});
		return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
	}

	function registerValidator(validator, options) {
		const unregister = serverModule.server.registerBearerValidator(validator, options);
		unregisters.push(unregister);
		return unregister;
	}

	function makeJwt(payload) {
		const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
		const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
		return `${header}.${body}.external-signature`;
	}

	function restLayer(request, nextHandler) {
		if (!ownedPaths.has(request.pathname)) return nextHandler(request);
		trace.push('rest');
		const settled = settleDeferredCredentialRejection(request);
		if (settled) return settled;
		if (!request.user && request.pathname !== HARPER_OWNED_PUBLIC)
			return { status: 401, headers: new Headers(), body: JSON.stringify({ error: 'Login failed' }) };
		return {
			status: 200,
			headers: new Headers(),
			body: JSON.stringify({
				servedBy: 'rest',
				user: request.user?.username ?? null,
				roleId: request.user?.role?.id ?? null,
			}),
		};
	}

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

	let previousDatabasesData;
	let previousHdbSchema;
	const ledgerTableDef = {
		primaryKey: 'id',
		attributes: [{ attribute: 'id' }, { attribute: 'name' }],
	};

	before(async () => {
		await testUtils.ensureSystemTables();
		originalValidateOperationToken = tokenAuthentication.validateOperationToken;
		originalValidateRefreshToken = tokenAuthentication.validateRefreshToken;
		if (!resourcesModule.resources) resourcesModule.resetResources();
		previousDatabasesData = databases.data;
		databases.data = { ...databases.data, Ledger: ledgerTableDef };
		previousHdbSchema = global.hdb_schema;
		global.hdb_schema = {
			...global.hdb_schema,
			data: { ...global.hdb_schema?.data, Ledger: ledgerTableDef },
		};
	});

	after(() => {
		tokenAuthentication.validateOperationToken = originalValidateOperationToken;
		tokenAuthentication.validateRefreshToken = originalValidateRefreshToken;
		if (previousDatabasesData === undefined) {
			delete databases.data;
		} else {
			databases.data = previousDatabasesData;
		}
		global.hdb_schema = previousHdbSchema;
	});

	beforeEach(() => {
		trace = [];
		ownedPaths = new Set([HARPER_OWNED, HARPER_OWNED_PUBLIC]);
		unregisters = [];
		tokenAuthentication.validateOperationToken = async () => {
			throw credentialRejectionError('invalid token', 401);
		};
		tokenAuthentication.validateRefreshToken = async () => {
			throw credentialRejectionError('invalid token', 401);
		};
		originalServerGetUser = serverModule.server.getUser;
		serverModule.server.getUser = async (username, password, request) =>
			externalUsers.has(username)
				? { username, active: true, role: { id: `external_${username}`, permission: externalUsers.get(username) } }
				: originalServerGetUser(username, password, request);
	});

	afterEach(() => {
		while (unregisters?.length > 0) {
			unregisters.pop()();
		}
		serverModule.server.getUser = originalServerGetUser;
		externalUsers.clear();
	});

	it('rejects non-function arguments to registerBearerValidator', () => {
		assert.throws(() => serverModule.server.registerBearerValidator(null), TypeError);
		assert.throws(() => serverModule.server.registerBearerValidator({}), TypeError);
	});

	it('accepts a non-Harper Bearer token via a registered validator as the user server.getUser resolves', async () => {
		let seenToken;
		let seenRequest;
		const claim = externalUser('oauth-client', { super_user: false, operations: ['read_only'] });
		registerValidator(async (token, request) => {
			seenToken = token;
			seenRequest = request;
			if (token === 'ext-oauth-token') return claim;
		});

		const { request, response, body } = await send(HARPER_OWNED, 'Bearer ext-oauth-token');

		assert.strictEqual(response.status, 200);
		assert.strictEqual(seenToken, 'ext-oauth-token');
		assert.strictEqual(seenRequest.pathname, HARPER_OWNED);
		assert.strictEqual(request.user.username, 'oauth-client');
		assert.strictEqual(request.user.role.id, 'external_oauth-client');
		assert.deepStrictEqual(request.user.role.permission.operations, ['read_only']);
		assert.strictEqual(request.user._bearerValidator, true);
		assert.strictEqual(request.user._scopedToken, undefined);
		assert.deepStrictEqual(claim, { username: 'oauth-client' }, 'must not mutate the validator result');
		assert.deepStrictEqual(body, { servedBy: 'rest', user: 'oauth-client', roleId: 'external_oauth-client' });
		assert.deepStrictEqual(trace, ['rest']);
	});

	it('resolves { username } through server.getUser, including a custom override with no hdb_user row, and refuses a returned server.getUser view', async () => {
		registerValidator(async (token) => {
			if (token === 'admin-mapped-token') {
				return { username: 'admin' };
			}
			if (token === 'custom-override-token') {
				return { username: 'custom-directory-user' };
			}
			if (token === 'direct-get-user-token') {
				return serverModule.server.getUser('admin', null);
			}
		});

		const { request, response } = await send(HARPER_OWNED, 'Bearer admin-mapped-token');

		assert.strictEqual(response.status, 200);
		assert.strictEqual(request.user.username, 'admin');
		assert.strictEqual(request.user._bearerValidator, true);
		assert.strictEqual(request.user._scopedToken, undefined);
		assert.strictEqual(request.user.role.permission.super_user, true, "the resolved user's own role applies");
		assert.strictEqual(userModule.hasRecordProvenance(request.user), true);
		assert.strictEqual(userModule.isCurrentUser(request.user), true);

		const originalServerGetUser = serverModule.server.getUser;
		serverModule.server.getUser = async (username, password) => {
			if (username === 'custom-directory-user' && password === null) {
				return {
					username: 'custom-directory-user',
					active: true,
					role: { id: 'directory_role', permission: { super_user: true } },
				};
			}
			return originalServerGetUser(username, password);
		};
		try {
			const customRes = await send(HARPER_OWNED, 'Bearer custom-override-token');
			assert.strictEqual(
				customRes.response.status,
				200,
				'a validator must accept a custom server.getUser override returning a principal not stored in hdb_user'
			);
			assert.strictEqual(customRes.request.user.username, 'custom-directory-user');
			assert.strictEqual(customRes.request.user._bearerValidator, true);
			assert.strictEqual(customRes.request.user._scopedToken, undefined);
			assert.strictEqual(userModule.hasRecordProvenance(customRes.request.user), true);
			assert.strictEqual(userModule.isCurrentUser(customRes.request.user), true);
		} finally {
			serverModule.server.getUser = originalServerGetUser;
		}

		trace = [];
		const directAppRes = await send(APP_OWNED, 'Bearer direct-get-user-token');
		const directHarperRes = await send(HARPER_OWNED, 'Bearer direct-get-user-token');
		for (const res of [directAppRes, directHarperRes]) {
			assert.strictEqual(res.response.status, 401, 'a server.getUser view carries role and other unsupported fields');
			assert.strictEqual(res.body.error, 'Login failed');
		}
		assert.deepStrictEqual(trace, [], 'an unsupported result fails closed in place, never deferring');
	});

	it('treats a username server.getUser resolves to no user or no role as a tagged credential rejection', async () => {
		const coreGetUser = serverModule.server.getUser;
		serverModule.server.getUser = async (username, ...rest) =>
			username === 'role-less-user' ? { username, active: true } : coreGetUser(username, ...rest);
		registerValidator(async (token) => {
			if (token === 'unknown-sub-token') return { username: 'nonexistent-oauth-sub' };
			if (token === 'role-less-token') return { username: 'role-less-user' };
		});

		for (const token of ['unknown-sub-token', 'role-less-token']) {
			const appRes = await send(APP_OWNED, `Bearer ${token}`);
			assert.strictEqual(appRes.response.status, 200, token);
			assert.strictEqual(appRes.body.servedBy, 'catch-all');

			const harperRes = await send(HARPER_OWNED, `Bearer ${token}`);
			assert.strictEqual(harperRes.response.status, 401, token);
			assert.strictEqual(harperRes.body.error, 'Login failed');
		}
	});

	it('chains through validators returning undefined or null and stops at the first match', async () => {
		const calls = [];
		registerValidator(async (token) => {
			calls.push(`v1:${token}`);
			return undefined;
		});
		registerValidator(async (token) => {
			calls.push(`v2:${token}`);
			if (token === 'v2-token') return externalUser('v2-user');
			return null;
		});
		registerValidator(async (token) => {
			calls.push(`v3:${token}`);
			return externalUser('v3-user');
		});

		const { request, response } = await send(HARPER_OWNED, 'Bearer v2-token');

		assert.strictEqual(response.status, 200);
		assert.strictEqual(request.user.username, 'v2-user');
		assert.deepStrictEqual(calls, ['v1:v2-token', 'v2:v2-token']);
	});

	it('defers invalid token when all registered validators return nullish, never caches the decline, and lets a later registration claim it', async () => {
		let validatorCalls = 0;
		registerValidator(async () => {
			validatorCalls++;
			return undefined;
		});
		registerValidator(async () => null);

		const appRes = await send(APP_OWNED, DOWNSTREAM_BEARER);
		assert.strictEqual(appRes.response.status, 200);
		assert.strictEqual(appRes.body.servedBy, 'catch-all');
		assert.strictEqual(appRes.body.authorization, DOWNSTREAM_BEARER);
		assert.strictEqual(appRes.request.user, undefined);
		assert.strictEqual(validatorCalls, 1);

		const harperRes = await send(HARPER_OWNED, DOWNSTREAM_BEARER);
		assert.strictEqual(harperRes.response.status, 401);
		assert.strictEqual(harperRes.body.error, 'invalid token');
		assert.strictEqual(validatorCalls, 2, 'a declined token is offered to the validators again');

		registerValidator(async (token) => {
			if (token === DOWNSTREAM_BEARER.slice('Bearer '.length)) {
				return externalUser('newly-claimed');
			}
		});
		const claimedRes = await send(HARPER_OWNED, DOWNSTREAM_BEARER);
		assert.strictEqual(claimedRes.response.status, 200);
		assert.strictEqual(claimedRes.request.user.username, 'newly-claimed');
	});

	it('suppresses invalid-token warn logs when a registered validator accepts the token', async () => {
		const removeTestJwtKeys = testUtils.installTestJwtKeys();
		tokenAuthentication.clearJWTRSAKeysCache();
		tokenAuthentication.validateOperationToken = originalValidateOperationToken;
		tokenAuthentication.validateRefreshToken = originalValidateRefreshToken;
		const warns = [];
		const originalWarn = logger.warn;
		logger.warn = (...args) => warns.push(args);
		const jwtWarns = () =>
			warns.filter(
				(args) =>
					args[0]?.name === 'JsonWebTokenError' ||
					/jwt malformed|invalid signature|invalid token/i.test(String(args[0]?.message ?? args[0]))
			);
		try {
			registerValidator(async (token) => {
				if (token === 'accepted-external-token') {
					return externalUser('oauth-user');
				}
				return undefined;
			});

			const accepted = await send(HARPER_OWNED, 'Bearer accepted-external-token');
			assert.strictEqual(accepted.response.status, 200);
			assert.strictEqual(jwtWarns().length, 0, 'accepted external token must not log invalid token warnings');

			const declined = await send(HARPER_OWNED, 'Bearer unrecognized-external-token');
			assert.strictEqual(declined.response.status, 401);
			assert.strictEqual(
				jwtWarns().length,
				2,
				'unclaimed invalid token emits the deferred operation-token and refresh-token warnings after validators decline'
			);
		} finally {
			logger.warn = originalWarn;
			removeTestJwtKeys();
			tokenAuthentication.clearJWTRSAKeysCache();
		}
	});

	it('stops the chain and defers or settles with the validator message on a tagged credential rejection', async () => {
		let secondValidatorCalled = false;
		registerValidator(async (token) => {
			if (token === 'revoked-oauth-token') {
				throw credentialRejectionError('OAuth token revoked', 401);
			}
		});
		registerValidator(async () => {
			secondValidatorCalled = true;
			return externalUser('should-not-run');
		});

		const appRes = await send(APP_OWNED, 'Bearer revoked-oauth-token');
		assert.strictEqual(secondValidatorCalled, false);
		assert.strictEqual(appRes.response.status, 200);
		assert.strictEqual(appRes.body.servedBy, 'catch-all');
		assert.strictEqual(appRes.response.headers.get('Cache-Control'), 'private, no-cache');
		assert.ok(appRes.response.headers.get('Vary').includes('Authorization'));

		const harperRes = await send(HARPER_OWNED, 'Bearer revoked-oauth-token');
		assert.strictEqual(harperRes.response.status, 401);
		assert.deepStrictEqual(harperRes.body, { error: 'OAuth token revoked' });
	});

	it('fails closed in place with generic Login failed when a validator throws an untagged error', async () => {
		let secondValidatorCalled = false;
		registerValidator(async () => {
			throw new Error('JWKS endpoint 10.0.0.42 unreachable');
		});
		registerValidator(async () => {
			secondValidatorCalled = true;
			return externalUser('fallback');
		});

		const { request, response, body } = await send(APP_OWNED, 'Bearer any-token');

		assert.strictEqual(secondValidatorCalled, false);
		assert.strictEqual(response.status, 401);
		assert.strictEqual(body.error, 'Login failed');
		assert.ok(!JSON.stringify(body).includes('10.0.0.42'), 'internal fault message must never leak');
		assert.deepStrictEqual(trace, [], 'must not defer to the application catch-all');
		assert.throws(
			() => assertNoDeferredCredentialRejection(request),
			(err) => err.statusCode === 401 && err.message === 'Login failed'
		);
	});

	it('fails closed in place on a malformed result or a field other than username/authExpiresAt/authCacheable', async () => {
		const inYears = (years) => Math.floor(Date.now() / 1000) + years * 366 * 24 * 60 * 60;
		const results = {
			'role-field': { username: 'admin', role: { permission: { super_user: false } } },
			'active-field': { username: 'admin', active: false },
			'missing-username': { username: '' },
			'non-object': 'admin',
			'array': ['admin'],
			'nan-exp': { username: 'admin', authExpiresAt: NaN },
			'ms-exp': { username: 'admin', authExpiresAt: Date.now() },
			'multi-year-exp': { username: 'admin', authExpiresAt: inYears(1.1) },
			'string-cacheable': { username: 'admin', authCacheable: 'no' },
		};
		registerValidator(async (token) => results[token]);

		for (const token of Object.keys(results)) {
			const { response, body } = await send(APP_OWNED, `Bearer ${token}`);
			assert.strictEqual(response.status, 401, `expected 401 for ${token}`);
			assert.strictEqual(body.error, 'Login failed');
			assert.deepStrictEqual(trace, [], `${token} must fail closed in place`);
		}
	});

	it('treats an inactive user from server.getUser as a tagged credential rejection', async () => {
		const coreGetUser = serverModule.server.getUser;
		serverModule.server.getUser = async (username, ...rest) =>
			username === 'inactive-user'
				? { username, active: false, role: { permission: { super_user: false } } }
				: coreGetUser(username, ...rest);
		registerValidator(async (token) => (token === 'inactive-user-token' ? { username: 'inactive-user' } : null));

		const inactiveRes = await send(HARPER_OWNED, 'Bearer inactive-user-token');
		assert.strictEqual(inactiveRes.response.status, 401);
		assert.strictEqual(inactiveRes.body.error, 'Cannot complete request: User is inactive');
	});

	it('preserves Harper operation token and refresh token precedence over registered validators', async () => {
		let validatorCalls = 0;
		registerValidator(async () => {
			validatorCalls++;
			return externalUser('oauth-user');
		});

		tokenAuthentication.validateOperationToken = async () => ({
			username: 'harper_op_user',
			role: { id: 'op', permission: {} },
		});
		const opRes = await send(HARPER_OWNED, 'Bearer valid-op-token');
		assert.strictEqual(opRes.response.status, 200);
		assert.strictEqual(opRes.request.user.username, 'harper_op_user');
		assert.strictEqual(validatorCalls, 0);

		tokenAuthentication.validateOperationToken = async () => {
			throw credentialRejectionError('token expired', 403);
		};
		const expiredRes = await send(HARPER_OWNED, 'Bearer expired-op-token');
		assert.strictEqual(expiredRes.response.status, 401);
		assert.strictEqual(expiredRes.body.error, 'token expired');
		assert.strictEqual(validatorCalls, 0);

		tokenAuthentication.validateOperationToken = async () => {
			throw credentialRejectionError('invalid token', 401);
		};
		tokenAuthentication.validateRefreshToken = async () => ({ username: 'harper_refresh_user' });
		const refreshRes = await send(APP_OWNED, 'Bearer valid-refresh-token');
		assert.strictEqual(refreshRes.response.status, -1);
		assert.strictEqual(validatorCalls, 0);

		tokenAuthentication.validateRefreshToken = async () => {
			throw new ServerError('refresh store offline');
		};
		const faultRes = await send(APP_OWNED, 'Bearer faulting-refresh-token');
		assert.strictEqual(faultRes.response.status, 401);
		assert.strictEqual(faultRes.body.error, 'Login failed');
		assert.strictEqual(validatorCalls, 0);
	});

	it('caches validated Bearer tokens, defaults omitted authExpiresAt to 300s, ignores past unverified decodeJWT exp when validator claims token, and rejects expired or zero-exp tokens (#1414)', async () => {
		let validatorCalls = 0;
		let pastJwtCalls = 0;
		const futureExpSec = Math.floor(Date.now() / 1000) + 60;
		const jwtToken = makeJwt({ sub: 'cached-oauth-user', exp: futureExpSec });
		const pastExpJwtToken = makeJwt({ sub: 'past-jwt-exp-user', exp: Math.floor(Date.now() / 1000) - 60 });

		registerValidator(async (token) => {
			if (token === jwtToken) {
				validatorCalls++;
				return externalUser('cached-oauth-user');
			}
			if (token === pastExpJwtToken) {
				pastJwtCalls++;
				return externalUser('past-jwt-exp-user');
			}
			if (token === 'opaque-no-exp') {
				validatorCalls++;
				return externalUser('opaque-default-exp-user');
			}
			if (token === 'zero-exp-opaque') {
				validatorCalls++;
				return { ...externalUser('zero-exp-user'), authExpiresAt: 0 };
			}
			if (token === 'already-expired-opaque') {
				validatorCalls++;
				return { ...externalUser('expired-oauth-user'), authExpiresAt: Math.floor(Date.now() / 1000) - 10 };
			}
			if (token === 'short-lived-opaque') {
				validatorCalls++;
				return { ...externalUser('short-lived-user'), authExpiresAt: Date.now() / 1000 + 0.03 };
			}
		});

		const first = await send(HARPER_OWNED, `Bearer ${jwtToken}`);
		assert.strictEqual(first.response.status, 200);
		assert.strictEqual(first.request.user.authExpiresAt, futureExpSec);
		assert.strictEqual(validatorCalls, 1);

		const second = await send(HARPER_OWNED, `Bearer ${jwtToken}`);
		assert.strictEqual(second.response.status, 200);
		assert.strictEqual(second.request.user.username, 'cached-oauth-user');
		assert.strictEqual(validatorCalls, 1, 'second request with the same unexpired JWT must hit authorizationCache');

		const nowSec = Math.floor(Date.now() / 1000);
		const pastJwtFirst = await send(HARPER_OWNED, `Bearer ${pastExpJwtToken}`);
		assert.strictEqual(
			pastJwtFirst.response.status,
			200,
			'token with past unverified decodeJWT exp must still be accepted when claimed by validator'
		);
		assert.ok(pastJwtFirst.request.user.authExpiresAt >= nowSec + 295);
		const pastJwtSecond = await send(HARPER_OWNED, `Bearer ${pastExpJwtToken}`);
		assert.strictEqual(pastJwtSecond.response.status, 200);
		assert.strictEqual(
			pastJwtCalls,
			2,
			'token whose unverified decodeJWT exp is in the past must bypass authorizationCache'
		);

		const opaqueDefault = await send(HARPER_OWNED, 'Bearer opaque-no-exp');
		assert.strictEqual(opaqueDefault.response.status, 200);
		assert.ok(
			opaqueDefault.request.user.authExpiresAt >= nowSec + 295 &&
				opaqueDefault.request.user.authExpiresAt <= nowSec + 305,
			`expected default 300s authExpiresAt on opaque token, got ${opaqueDefault.request.user.authExpiresAt}`
		);

		const zeroExp = await send(HARPER_OWNED, 'Bearer zero-exp-opaque');
		assert.strictEqual(zeroExp.response.status, 401);
		assert.strictEqual(zeroExp.body.error, 'token expired');

		const expired = await send(HARPER_OWNED, 'Bearer already-expired-opaque');
		assert.strictEqual(expired.response.status, 401);
		assert.strictEqual(expired.body.error, 'token expired');

		const shortFirst = await send(HARPER_OWNED, 'Bearer short-lived-opaque');
		assert.strictEqual(shortFirst.response.status, 200);
		const callsAfterShortFirst = validatorCalls;
		await new Promise((resolve) => setTimeout(resolve, 50));
		const shortSecond = await send(HARPER_OWNED, 'Bearer short-lived-opaque');
		assert.strictEqual(shortSecond.response.status, 200);
		assert.strictEqual(validatorCalls, callsAfterShortFirst + 1, 'expired cache entry must re-invoke validator');
	});

	it("evicts only a disposed validator's cached principals, keeps them across other registrations, and unregister is idempotent", async () => {
		let v1Calls = 0;
		const unregisterV1 = registerValidator(async (token) => {
			if (token === 'cached-token') {
				v1Calls++;
				return externalUser('v1-user');
			}
		});
		let v2Calls = 0;
		const unregisterV2 = registerValidator(async (token) => {
			if (token === 'v2-cached-token') {
				v2Calls++;
				return externalUser('v2-user');
			}
		});

		await send(HARPER_OWNED, 'Bearer cached-token');
		await send(HARPER_OWNED, 'Bearer cached-token');
		assert.strictEqual(v1Calls, 1, 'token is served from authorizationCache');
		await send(HARPER_OWNED, 'Bearer v2-cached-token');

		registerValidator(async () => null);
		const afterRegister = await send(HARPER_OWNED, 'Bearer cached-token');
		assert.strictEqual(afterRegister.request.user.username, 'v1-user');
		assert.strictEqual(v1Calls, 1, 'registering another validator must not flush cached principals');

		unregisterV1();
		unregisterV1();
		const afterUnregister = await send(HARPER_OWNED, 'Bearer cached-token');
		assert.strictEqual(afterUnregister.response.status, 401);
		const otherValidator = await send(HARPER_OWNED, 'Bearer v2-cached-token');
		assert.strictEqual(otherValidator.request.user.username, 'v2-user');
		assert.strictEqual(v2Calls, 1, "disposing one validator must not evict another validator's principals");
		unregisterV2();
		assert.strictEqual((await send(HARPER_OWNED, 'Bearer v2-cached-token')).response.status, 401);

		let unregisterMidAwait;
		unregisterMidAwait = registerValidator(async (token) => {
			if (token === 'mid-await-unregister') {
				unregisterMidAwait();
				return externalUser('stale-validator-user');
			}
		});
		const midAwaitRes = await send(HARPER_OWNED, 'Bearer mid-await-unregister');
		assert.strictEqual(midAwaitRes.response.status, 401, 'validator unregistered while awaiting must be discarded');

		let invalidateCalls = 0;
		registerValidator(async (token) => {
			if (token === 'mid-await-invalidate') {
				invalidateCalls++;
				if (invalidateCalls === 1) {
					serverModule.server.invalidateUser();
				}
				return externalUser('invalidated-mid-await');
			}
		});
		const firstInvalidated = await send(HARPER_OWNED, 'Bearer mid-await-invalidate');
		assert.strictEqual(firstInvalidated.response.status, 200);
		const secondInvalidated = await send(HARPER_OWNED, 'Bearer mid-await-invalidate');
		assert.strictEqual(secondInvalidated.response.status, 200);
		assert.strictEqual(
			invalidateCalls,
			2,
			'server.invalidateUser() during validator await must skip caching into the fresh map'
		);
	});

	it('forbids passwordless create_tokens and inline-role scoped-token minting from a Bearer-validated principal', async () => {
		await assert.rejects(
			() =>
				tokenAuthentication.createTokens({
					hdb_user: {
						username: 'admin',
						_bearerValidator: true,
						role: { id: 'super_user', permission: { super_user: true } },
					},
				}),
			(err) => err.statusCode === 401 && err.message === 'invalid credentials'
		);
		await assert.rejects(
			() =>
				tokenAuthentication.createTokens({
					hdb_user: {
						username: 'admin',
						_bearerValidator: true,
						role: { id: 'super_user', permission: { super_user: true } },
					},
					role: { permission: { structure_user: true } },
					expires_in: '3650d',
				}),
			(err) => err.statusCode === 401 && err.message === 'invalid credentials'
		);
	});

	it('persists the token expiry on an MQTT last-will and drops the will once the token has expired, on disconnect and on restart replay', async () => {
		const { Resource } = require('#src/resources/Resource');
		const { waitFor } = require('../waitFor');
		const publishedWills = [];
		const publishedByUsers = [];
		class WillTargetResource extends Resource {
			allowCreate(user) {
				publishedByUsers.push(user?.username);
				return Boolean(user);
			}
			publish(data) {
				publishedWills.push(data);
			}
		}
		resourcesModule.resources.set('status', WillTargetResource, { mqtt: true });
		await databases.system.hdb_role.put({
			id: 'will_source_role',
			role: 'will_source_role',
			permission: { super_user: true },
		});
		await databases.system.hdb_user.put({
			username: 'will_source_user',
			active: true,
			role: 'will_source_role',
		});

		const willIds = [];
		const openSession = async (clientId, user, data) => {
			const session = await getSession({
				clientId,
				user,
				listener: () => {},
				clean: true,
				will: { topic: 'status/exit', data, qos: 1, retain: false },
			});
			willIds.push(session.willId);
			return session;
		};
		const willsGone = (...sessionWillIds) =>
			waitFor(async () => {
				for (const willId of sessionWillIds) {
					if (await databases.system.hdb_session_will.get(willId)) return false;
				}
				return true;
			});
		try {
			registerValidator(async (token) => (token === 'mqtt-will-bearer' ? { username: 'will_source_user' } : null));
			const { request, response } = await send(HARPER_OWNED, 'Bearer mqtt-will-bearer');
			assert.strictEqual(response.status, 200);

			const live = await openSession('bearer-will-client-live', request.user, 'offline-live');
			const liveWillId = live.willId;
			assert.deepStrictEqual((await databases.system.hdb_session_will.get(liveWillId)).user, {
				username: 'will_source_user',
				authExpiresAt: request.user.authExpiresAt,
			});
			live.disconnect(false);
			await willsGone(liveWillId);
			assert.deepStrictEqual(publishedWills, ['offline-live']);
			assert.deepStrictEqual(publishedByUsers, ['will_source_user']);

			publishedWills.length = 0;
			const expired = await openSession(
				'bearer-will-client-expired',
				{ ...request.user, authExpiresAt: Math.floor(Date.now() / 1000) - 1 },
				'offline-expired'
			);
			const expiredWillId = expired.willId;
			expired.disconnect(false);
			await willsGone(expiredWillId);
			assert.deepStrictEqual(publishedWills, [], 'a will must not publish past its bearer token');

			const realDateNow = Date.now;
			let clockOffsetMs = 0;
			const coreGetUser = serverModule.server.getUser;
			serverModule.server.getUser = async (username, ...rest) => {
				const user = await coreGetUser(username, ...rest);
				clockOffsetMs = 60_000;
				return user;
			};
			Date.now = () => realDateNow() + clockOffsetMs;
			try {
				for (const [clientId, ttlSec] of [
					['bearer-will-replay-expiring', 30],
					['bearer-will-replay-valid', 600],
				]) {
					clockOffsetMs = 0;
					const session = await openSession(
						clientId,
						{ ...request.user, authExpiresAt: Math.floor(realDateNow() / 1000) + ttlSec },
						clientId
					);
					await replayLastWill(await databases.system.hdb_session_will.get(session.willId));
					assert.ok(!(await databases.system.hdb_session_will.get(session.willId)), `${clientId} row is deleted`);
				}
			} finally {
				Date.now = realDateNow;
			}
			assert.deepStrictEqual(
				publishedWills,
				['bearer-will-replay-valid'],
				'restart replay must recheck the expiry after its server.getUser lookup'
			);
		} finally {
			resourcesModule.resources.delete('status');
			for (const willId of willIds) {
				await databases.system.hdb_session_will.delete(willId);
			}
			await databases.system.hdb_user.delete('will_source_user');
			await databases.system.hdb_role.delete('will_source_role');
		}
	});

	it('falls through real validateOperationToken and validateRefreshToken on a foreign RS256 JWT without stubbing', async () => {
		const { generateKeyPairSync } = require('node:crypto');
		const jwt = require('jsonwebtoken');
		tokenAuthentication.validateOperationToken = originalValidateOperationToken;
		tokenAuthentication.validateRefreshToken = originalValidateRefreshToken;
		tokenAuthentication.clearJWTRSAKeysCache();
		const removeTestJwtKeys = testUtils.installTestJwtKeys();
		const { privateKey: foreignPrivateKey, publicKey: foreignPublicKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});
		const foreignToken = jwt.sign({ sub: 'ext-subject', scope: 'read' }, foreignPrivateKey, {
			algorithm: 'RS256',
			expiresIn: 120,
		});
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args);
		const jwtWarnings = () =>
			warnings.filter(
				(args) =>
					args[0]?.name === 'JsonWebTokenError' ||
					/jwt malformed|invalid signature|invalid token/i.test(String(args[0]?.message ?? args[0]))
			);

		try {
			registerValidator(async (token) => {
				const claims = jwt.verify(token, foreignPublicKey, { algorithms: ['RS256'] });
				return { ...externalUser(claims.sub), authExpiresAt: claims.exp };
			});

			const { request, response } = await send(HARPER_OWNED, `Bearer ${foreignToken}`);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(request.user.username, 'ext-subject');
			assert.strictEqual(request.user.authExpiresAt, jwt.decode(foreignToken).exp);
			assert.strictEqual(
				jwtWarnings().length,
				0,
				'real jwt.verify signature mismatch must not log a warning when claimed by a registered validator'
			);
		} finally {
			logger.warn = originalWarn;
			removeTestJwtKeys();
			tokenAuthentication.clearJWTRSAKeysCache();
		}
	});

	it('serves a cached principal on any route without the validator, skips the cache when authCacheable is false, and never caches a decline', async () => {
		let calls = 0;
		let routeBoundCalls = 0;
		registerValidator(async (token, request) => {
			if (token === 'request-bound-token') {
				calls++;
				return { ...externalUser(`user-for-${request.pathname}-${calls}`), authCacheable: false };
			}
			if (token === 'route-bound-cacheable-token') {
				routeBoundCalls++;
				return request.pathname === HARPER_OWNED ? externalUser('route-bound-user') : null;
			}
			return null;
		});

		assert.strictEqual((await send(HARPER_OWNED, 'Bearer route-bound-cacheable-token')).response.status, 200);
		const otherRoute = await send(HARPER_OWNED_PUBLIC, 'Bearer route-bound-cacheable-token');
		assert.strictEqual(otherRoute.request.user.username, 'route-bound-user');
		assert.strictEqual(routeBoundCalls, 1, 'the cache key is the Authorization header, not the route');

		const first = await send(HARPER_OWNED, 'Bearer request-bound-token');
		const second = await send(HARPER_OWNED_PUBLIC, 'Bearer request-bound-token');
		assert.strictEqual(first.response.status, 200);
		assert.strictEqual(second.response.status, 200);
		assert.strictEqual(calls, 2, 'authCacheable: false must re-invoke the validator on every request');
		assert.strictEqual(first.request.user.username, `user-for-${HARPER_OWNED}-1`);
		assert.strictEqual(second.request.user.username, `user-for-${HARPER_OWNED_PUBLIC}-2`);

		let eventuallyConsistentCalls = 0;
		registerValidator(async (token) => {
			if (token === 'eventually-consistent-token') {
				eventuallyConsistentCalls++;
				if (eventuallyConsistentCalls === 1) return null;
				return externalUser('replicated-token-user');
			}
			return null;
		});

		const missRes = await send(HARPER_OWNED, 'Bearer eventually-consistent-token');
		assert.strictEqual(missRes.response.status, 401);
		const hitRes = await send(HARPER_OWNED, 'Bearer eventually-consistent-token');
		assert.strictEqual(hitRes.response.status, 200);
		assert.strictEqual(hitRes.request.user.username, 'replicated-token-user');
		assert.strictEqual(eventuallyConsistentCalls, 2, 'a declined token must be offered to the validators again');
	});

	it('validates timeoutMs options (up to 60_000ms), times out a hanging validator with 401 Login failed and aborts its AbortSignal, enforces both per-validator and chain-wide timeout budgets, and isolates isOperationsServer from bearer validators', async () => {
		for (const badTimeout of [0, -1, 60_001, 2_147_483_648, NaN, Infinity, '30']) {
			assert.throws(
				() => serverModule.server.registerBearerValidator(() => null, { timeoutMs: badTimeout }),
				TypeError,
				`expected TypeError for timeoutMs: ${badTimeout}`
			);
		}

		let secondValidatorCalled = false;
		let hangingSignal;
		const unhandledRejections = [];
		const onUnhandledRejection = (err) => unhandledRejections.push(err);
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			registerValidator(
				(_token, _request, signal) => {
					hangingSignal = signal;
					return new Promise((_, reject) => {
						signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
					});
				},
				{ timeoutMs: 25 }
			);
			registerValidator(() => {
				secondValidatorCalled = true;
				return externalUser('after-timeout');
			});

			const timedOut = await Promise.race([
				send(APP_OWNED, 'Bearer hanging-validator-token'),
				new Promise((_, reject) => setTimeout(() => reject(new Error('timeoutMs test hung')), 1_000)),
			]);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(timedOut.response.status, 401);
			assert.strictEqual(timedOut.body.error, 'Login failed');
			assert.strictEqual(secondValidatorCalled, false, 'validator timeout must abort the chain and fail closed');
			assert.strictEqual(hangingSignal?.aborted, true, 'validator timeout must abort the per-call AbortSignal');
			assert.deepStrictEqual(
				unhandledRejections,
				[],
				'AbortError rejection from an aborted validator must not trigger unhandledRejection'
			);
			assert.deepStrictEqual(trace, [], 'validator timeout must not defer to the application catch-all');
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}

		while (unregisters.length > 0) unregisters.pop()();

		let secondChainSignal;
		registerValidator(
			async (token) => {
				const stepMs = token === 'within-chain-budget' ? 100 : 20;
				await new Promise((resolve) => setTimeout(resolve, stepMs));
				return undefined;
			},
			{ timeoutMs: 600 }
		);
		registerValidator(
			async (token, _request, signal) => {
				secondChainSignal = signal;
				const stepMs = token === 'exceeds-second-call-budget' ? 250 : 100;
				await new Promise((resolve) => setTimeout(resolve, stepMs));
				return externalUser('chained-async-user');
			},
			{ timeoutMs: 150 }
		);

		const withinBudget = await Promise.race([
			send(HARPER_OWNED, 'Bearer within-chain-budget'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('within-budget chain test hung')), 2_000)),
		]);
		assert.strictEqual(
			withinBudget.response.status,
			200,
			'two chained validators taking 100ms each within the 600ms chain budget must succeed'
		);
		assert.strictEqual(withinBudget.request.user.username, 'chained-async-user');
		assert.strictEqual(secondChainSignal?.aborted, false);

		trace = [];
		const exceededBudget = await Promise.race([
			send(APP_OWNED, 'Bearer exceeds-second-call-budget'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('exceeds-budget chain test hung')), 2_000)),
		]);
		assert.strictEqual(
			exceededBudget.response.status,
			401,
			'a validator exceeding its own per-call timeoutMs budget (150ms) must fail closed with 401'
		);
		assert.strictEqual(exceededBudget.body.error, 'Login failed');
		assert.strictEqual(secondChainSignal?.aborted, true);
		assert.match(secondChainSignal?.reason?.message ?? '', /^Bearer validator timed out after 150ms$/);
		assert.deepStrictEqual(trace, []);

		while (unregisters.length > 0) unregisters.pop()();

		let chainExhaustedSignal;
		registerValidator(
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 350));
				return undefined;
			},
			{ timeoutMs: 600 }
		);
		registerValidator(
			async (_token, _request, signal) => {
				chainExhaustedSignal = signal;
				await new Promise((resolve) => setTimeout(resolve, 350));
				return externalUser('chained-async-user');
			},
			{ timeoutMs: 600 }
		);

		trace = [];
		const exceededChainBudget = await Promise.race([
			send(APP_OWNED, 'Bearer exceeds-chain-budget'),
			new Promise((_, reject) => setTimeout(() => reject(new Error('exceeds-chain-budget test hung')), 2_000)),
		]);
		assert.strictEqual(
			exceededChainBudget.response.status,
			401,
			'two chained validators with timeoutMs: 600 whose combined runtime (700ms) exceeds the 600ms chain budget must fail closed with 401'
		);
		assert.strictEqual(exceededChainBudget.body.error, 'Login failed');
		assert.strictEqual(chainExhaustedSignal?.aborted, true);
		assert.match(
			chainExhaustedSignal?.reason?.message ?? '',
			/^Bearer validator chain timed out after 600ms \(remaining budget \d+ms\)$/
		);
		assert.deepStrictEqual(trace, []);

		while (unregisters.length > 0) unregisters.pop()();

		let postDeadlineSecondCalls = 0;
		const realDateNow = Date.now;
		let syntheticClockOffset = 0;
		Date.now = () => realDateNow() + syntheticClockOffset;
		try {
			registerValidator(
				async () => {
					syntheticClockOffset = 1_000;
					return undefined;
				},
				{ timeoutMs: 500 }
			);
			registerValidator(
				async () => {
					postDeadlineSecondCalls++;
					return externalUser('should-not-be-invoked');
				},
				{ timeoutMs: 500 }
			);
			trace = [];
			const exhaustedBeforeSecond = await send(APP_OWNED, 'Bearer exhausted-before-second');
			assert.strictEqual(exhaustedBeforeSecond.response.status, 401);
			assert.strictEqual(exhaustedBeforeSecond.body.error, 'Login failed');
			assert.strictEqual(
				postDeadlineSecondCalls,
				0,
				'when the chain deadline is already exhausted before the next validator, it must not be invoked'
			);
			assert.deepStrictEqual(trace, []);
		} finally {
			Date.now = realDateNow;
		}

		while (unregisters.length > 0) unregisters.pop()();

		let opsValidatorCalls = 0;
		registerValidator(async (token) => {
			opsValidatorCalls++;
			if (token === 'app-then-ops-token') {
				return externalUser('ops-oauth-user');
			}
			return undefined;
		});

		const appAccepted = await send(HARPER_OWNED, 'Bearer app-then-ops-token');
		assert.strictEqual(appAccepted.response.status, 200);
		assert.strictEqual(appAccepted.request.user.username, 'ops-oauth-user');
		assert.strictEqual(opsValidatorCalls, 1);

		trace = [];
		const opsRejectedEvenWhenCached = await send(HARPER_OWNED, 'Bearer app-then-ops-token', {
			isOperationsServer: true,
		});
		assert.strictEqual(
			opsRejectedEvenWhenCached.response.status,
			401,
			'isOperationsServer must ignore _bearerValidator entries in authorizationCache and skip registered validators'
		);
		assert.strictEqual(opsRejectedEvenWhenCached.body.error, 'invalid token');
		assert.strictEqual(opsValidatorCalls, 1, 'isOperationsServer must not invoke registered bearer validators');
		assert.deepStrictEqual(trace, []);

		const appStillCached = await send(HARPER_OWNED, 'Bearer app-then-ops-token');
		assert.strictEqual(appStillCached.response.status, 200);
		assert.strictEqual(
			opsValidatorCalls,
			1,
			'Operations API rejection must not evict the application-port authorizationCache entry'
		);

		trace = [];
		const opsDeclined = await send(APP_OWNED, 'Bearer ops-unclaimed-token', { isOperationsServer: true });
		assert.strictEqual(opsDeclined.response.status, 401);
		assert.strictEqual(opsDeclined.body.error, 'invalid token');
		assert.strictEqual(opsValidatorCalls, 1);
		assert.deepStrictEqual(trace, [], 'isOperationsServer must settle declined tokens in place with 401');
	});

	it('keeps a validator timeout fail-closed when the validator settles from its own abort listener', async () => {
		const settleOnAbort = {
			'abort-resolves-principal': (resolve) => resolve(externalUser('timed-out-principal')),
			'abort-resolves-decline': (resolve) => resolve(null),
			'abort-rejects-tagged': (_resolve, reject) => reject(credentialRejectionError('late rejection', 401)),
		};
		for (const [token, settle] of Object.entries(settleOnAbort)) {
			const unregister = registerValidator(
				(_token, _request, signal) =>
					new Promise((resolve, reject) =>
						signal.addEventListener('abort', () => settle(resolve, reject), { once: true })
					),
				{ timeoutMs: 25 }
			);
			trace = [];
			const res = await bounded(send(APP_OWNED, `Bearer ${token}`), token);
			assert.strictEqual(res.response.status, 401, `${token}: the timeout must win`);
			assert.strictEqual(res.body.error, 'Login failed');
			assert.deepStrictEqual(trace, [], `${token}: a timed-out validator must not defer to the application`);
			unregister();
		}
	});

	it('discards a claim whose validator is disposed while its server.getUser lookup is pending', async () => {
		const originalGetUser = serverModule.server.getUser;
		let releaseLookup;
		let markLookupStarted;
		const lookupStarted = new Promise((resolve) => (markLookupStarted = resolve));
		try {
			serverModule.server.getUser = async (username, ...rest) => {
				if (username !== 'disposed-mid-lookup') return originalGetUser(username, ...rest);
				markLookupStarted();
				await new Promise((resolve) => (releaseLookup = resolve));
				return { username, active: true, role: { permission: { super_user: true } } };
			};
			const unregister = registerValidator((token) =>
				token === 'dispose-mid-lookup' ? { username: 'disposed-mid-lookup' } : null
			);
			const pending = send(HARPER_OWNED, 'Bearer dispose-mid-lookup');
			await bounded(lookupStarted, 'the server.getUser lookup');
			unregister();
			releaseLookup();
			const res = await bounded(pending, 'authentication');
			assert.strictEqual(res.response.status, 401);
			assert.strictEqual(res.request.user, undefined);
			assert.strictEqual(
				res.body.error,
				'invalid token',
				"a disposed validator's claim reads as an unrecognized token"
			);
		} finally {
			serverModule.server.getUser = originalGetUser;
		}
	});

	it('rejects a claim whose authExpiresAt passes while server.getUser resolves it', async () => {
		const realDateNow = Date.now;
		let clockOffsetMs = 0;
		Date.now = () => realDateNow() + clockOffsetMs;
		try {
			const coreGetUser = serverModule.server.getUser;
			serverModule.server.getUser = async (username, ...rest) => {
				if (username !== 'slow-lookup-user') return coreGetUser(username, ...rest);
				await null;
				clockOffsetMs = 60_000;
				return { username, active: true, role: { permission: { super_user: false } } };
			};
			registerValidator((token) =>
				token === 'expires-during-lookup'
					? { username: 'slow-lookup-user', authExpiresAt: Math.floor(realDateNow() / 1000) + 30 }
					: null
			);
			const res = await send(HARPER_OWNED, 'Bearer expires-during-lookup');
			assert.strictEqual(res.response.status, 401);
			assert.strictEqual(res.body.error, 'token expired');
			assert.strictEqual(res.request.user, undefined);
		} finally {
			Date.now = realDateNow;
		}
	});

	it('accepts pre-existing VERSION_REUSED and clock-ahead replicated records on RocksDB, and rejects a replicated or out-of-order write that lands during the server.getUser lookup', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const { VERSION_REUSED } = require('#js/resources/RecordEncoder');
		const now = Date.now();
		await databases.system.hdb_role.put(
			{
				id: 'reused_role',
				role: 'reused_role',
				permission: { super_user: true },
			},
			{ timestamp: now + 60_000 }
		);
		await databases.system.hdb_user.put({
			username: 'reused_user',
			active: true,
			role: 'reused_role',
			refresh_token: 'secret-refresh-token-must-not-persist',
			logins: 0,
		});
		const login = { logins: { __op__: 'add', value: 1 } };
		await databases.system.hdb_user.patch('reused_user', login, { timestamp: now + 60_000 });

		let writeDuringLookup;
		const coreGetUser = serverModule.server.getUser;
		serverModule.server.getUser = async (...args) => {
			const user = await coreGetUser(...args);
			const write = writeDuringLookup;
			writeDuringLookup = undefined;
			await write?.();
			return user;
		};
		try {
			registerValidator(async (token) => (token === 'reused-user-token' ? { username: 'reused_user' } : null));

			const clockAheadRes = await send(HARPER_OWNED, 'Bearer reused-user-token');
			assert.strictEqual(
				clockAheadRes.response.status,
				200,
				'pre-existing clock-ahead replicated record must not be misclassified as a mid-await write'
			);
			assert.strictEqual(userModule.isCurrentUser(clockAheadRes.request.user), true);

			await databases.system.hdb_user.patch('reused_user', login, { timestamp: now + 50_000 });
			const entry = databases.system.hdb_user.primaryStore.getEntry('reused_user');
			assert.ok(entry.metadataFlags & VERSION_REUSED, 'out-of-order patch marks hdb_user entry VERSION_REUSED');

			const reusedRes = await send(HARPER_OWNED, 'Bearer reused-user-token');
			assert.strictEqual(reusedRes.response.status, 200, 'VERSION_REUSED record must not be rejected');
			assert.strictEqual(userModule.isCurrentUser(reusedRes.request.user), true);

			writeDuringLookup = () => databases.system.hdb_user.patch('reused_user', login, { timestamp: now + 45_000 });
			serverModule.server.invalidateUser();
			const outOfOrderDuringLookup = await send(HARPER_OWNED, 'Bearer reused-user-token');
			assert.strictEqual(outOfOrderDuringLookup.response.status, 401, 'an out-of-order write during the lookup');

			writeDuringLookup = () =>
				databases.system.hdb_role.put(
					{ id: 'reused_role', role: 'reused_role', permission: { super_user: false } },
					{ timestamp: now + 120_000 }
				);
			serverModule.server.invalidateUser();
			const clockAheadDuringLookup = await send(HARPER_OWNED, 'Bearer reused-user-token');
			assert.strictEqual(clockAheadDuringLookup.response.status, 401, 'a clock-ahead role write during the lookup');

			const freshReusedRes = await send(HARPER_OWNED, 'Bearer reused-user-token');
			assert.strictEqual(freshReusedRes.response.status, 200);
			await databases.system.hdb_user.patch('reused_user', login, { timestamp: now + 40_000 });
			assert.strictEqual(
				userModule.isCurrentUser(freshReusedRes.request.user),
				false,
				'isCurrentUser must detect value change on VERSION_REUSED record'
			);
		} finally {
			await databases.system.hdb_user.delete('reused_user');
			await databases.system.hdb_role.delete('reused_role');
		}
	});

	it('allows a custom server.getUser override that memoizes its returned user object across validator and Basic lookups and preserves _bearerValidator across impersonation', async () => {
		const { applyImpersonation } = require('#src/security/impersonation');
		const { registerLiveSubscription } = require('#src/server/liveSubscriptionAuth');
		await testUtils.ensureSystemTables();
		await databases.system.hdb_role.put({
			id: 'memo_role',
			role: 'memo_role',
			permission: { super_user: true },
		});
		await databases.system.hdb_user.put({
			username: 'memo_backed_user',
			role: 'memo_role',
			active: true,
		});

		const memoNonBacked = {
			username: 'memo_external_user',
			active: true,
			role: { id: 'ext_role', role: 'ext_role', permission: { super_user: true } },
		};
		const memoBacked = {
			username: 'memo_backed_user',
			active: true,
			role: { id: 'memo_role', role: 'memo_role', permission: { super_user: true } },
		};

		const originalGetUser = serverModule.server.getUser;
		let backedGetUserCalls = 0;
		try {
			serverModule.server.getUser = async (username) => {
				if (username === 'memo_external_user') return memoNonBacked;
				if (username === 'memo_backed_user') {
					backedGetUserCalls++;
					return memoBacked;
				}
				if (username === 'slow_get_user') return new Promise(() => {});
				return null;
			};

			registerValidator(
				async (token) => {
					if (token.startsWith('memo-ext-')) return { username: 'memo_external_user' };
					if (token.startsWith('memo-backed-')) return { username: 'memo_backed_user' };
					if (token === 'slow-getuser') return { username: 'slow_get_user' };
					return undefined;
				},
				{ timeoutMs: 30 }
			);

			const slowGetUserRes = await Promise.race([
				send(APP_OWNED, 'Bearer slow-getuser'),
				new Promise((_, reject) => setTimeout(() => reject(new Error('hanging server.getUser test hung')), 2_000)),
			]);
			assert.strictEqual(
				slowGetUserRes.response.status,
				401,
				'a server.getUser lookup exceeding timeoutMs must fail closed in place with 401'
			);

			const firstExt = await send(HARPER_OWNED, 'Bearer memo-ext-1');
			assert.strictEqual(firstExt.response.status, 200);
			const nowSec = Math.floor(Date.now() / 1000);
			assert.ok(
				firstExt.request.user.authExpiresAt >= nowSec + 290 && firstExt.request.user.authExpiresAt <= nowSec + 305,
				'validator principal without authExpiresAt must default to now + 300s'
			);
			const liveSubHandle = registerLiveSubscription({
				username: firstExt.request.user.username,
				authExpiresAt: firstExt.request.user.authExpiresAt,
				recheck: async () => true,
				revoke: () => {},
			});
			liveSubHandle.unregister();

			const secondExt = await send(HARPER_OWNED, 'Bearer memo-ext-2');
			assert.strictEqual(
				secondExt.response.status,
				200,
				'a second resolution of a memoized custom getUser object without an hdb_user row must succeed'
			);

			const basicHeader = `Basic ${Buffer.from('memo_backed_user:pw').toString('base64')}`;
			const firstBasic = await send(HARPER_OWNED, basicHeader);
			assert.strictEqual(firstBasic.response.status, 200);
			const firstBacked = await send(HARPER_OWNED, 'Bearer memo-backed-1');
			assert.strictEqual(firstBacked.response.status, 200);
			assert.strictEqual(backedGetUserCalls, 2);

			await databases.system.hdb_user.patch('memo_backed_user', { login_time: Date.now() });
			const secondBacked = await send(HARPER_OWNED, 'Bearer memo-backed-2');
			assert.strictEqual(
				secondBacked.response.status,
				200,
				'a second resolution of a memoized custom getUser object after a harmless hdb_user write must update trackedProvenance and succeed'
			);
			assert.strictEqual(
				userModule.isCurrentUser(firstBasic.request.user),
				false,
				're-stamping memoBacked must not make a pre-write Basic principal look current'
			);
			const secondBasic = await send(HARPER_OWNED, basicHeader);
			assert.strictEqual(secondBasic.response.status, 200);
			assert.strictEqual(
				backedGetUserCalls,
				4,
				'Basic authorizationCache entry must miss and re-invoke getUser after hdb_user write even if a validator lookup re-stamped memoBacked'
			);

			const impersonated = await applyImpersonation(secondBacked.request.user, {
				username: 'impersonated_target',
				role: { permission: { super_user: false } },
			});
			assert.strictEqual(
				impersonated._bearerValidator,
				true,
				'applyImpersonation must preserve _bearerValidator on the impersonated principal'
			);
			await assert.rejects(
				() => tokenAuthentication.createTokens({ hdb_user: impersonated }),
				(err) => err instanceof ClientError && err.statusCode === 401,
				'impersonated _bearerValidator principal must still be rejected by passwordless createTokens'
			);
		} finally {
			serverModule.server.getUser = originalGetUser;
			await databases.system.hdb_user.delete('memo_backed_user');
			await databases.system.hdb_role.delete('memo_role');
		}
	});
});
