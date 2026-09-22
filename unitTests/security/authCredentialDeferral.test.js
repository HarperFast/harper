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

	before(() => {
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
