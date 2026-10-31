/**
 * The full response header set `authentication` produces (#1518 Origin partitioning, #1565
 * identity floor), pinned as ordered [name, value] lists so a change to how the headers are
 * assembled cannot change what is emitted: names, case, values and insertion order.
 *
 * CORS config is read once at startup, so each CORS setting gets its own instance of the auth module.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { makeCallbackChain } = require('#src/server/middlewareChain');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { ClientError } = require('#src/utility/errors/hdbError');
const { credentialRejectionError } = require('#src/security/deferredAuthentication');
const serverModule = require('#src/server/Server');
const resourcesModule = require('#src/resources/Resources');
const tokenAuthentication = require('#js/security/tokenAuthentication');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { runStartup } = require('#src/utility/lifecycle');

const BASIC = `Basic ${Buffer.from('header_user:pw').toString('base64')}`;
const BAD_BASIC = `Basic ${Buffer.from('header_user:wrong').toString('base64')}`;
const BEARER = 'Bearer header-test-token';
const ORIGIN = 'https://app.example.com';
// RECORD_AUTH_HEADERS=1 rewrites the fixture from the current output, for a deliberate change
const RECORD = !!process.env.RECORD_AUTH_HEADERS;
const EXPECTED_PATH = path.join(__dirname, 'fixtures', 'authResponseHeaders.json');
const EXPECTED = RECORD ? {} : JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function restHeaders() {
	const headers = new Headers();
	headers.set('Vary', 'Accept, Accept-Encoding');
	headers.set('Content-Type', 'application/json');
	headers.set('ETag', '"abc"');
	return headers;
}

const RESPONSES = {
	'rest': () => ({ status: 200, headers: restHeaders(), body: '{}' }),
	'no headers': () => ({ status: 200, body: '{}' }),
	'plain object': () => ({ status: 200, headers: { 'content-type': 'text/plain', 'vary': 'Accept' }, body: 'x' }),
	'vary *': () => ({ status: 200, headers: new Headers({ Vary: '*' }), body: 'x' }),
	'vary covers': () => ({ status: 200, headers: new Headers({ vary: 'ORIGIN,  authorization ,cookie' }), body: 'x' }),
	'vary array': () => ({ status: 200, headers: new Headers([['vary', ['Accept', 'X-Thing']]]), body: 'x' }),
	'vary lookalike': () => ({ status: 200, headers: new Headers({ Vary: 'Authorizatio, Cookies, Origin-X' }), body: 'x' }),
	'vary blank': () => ({ status: 200, headers: new Headers({ Vary: '   ' }), body: 'x' }),
	'public': () => ({ status: 200, headers: new Headers({ 'Cache-Control': 'public, max-age=60' }), body: 'x' }),
	's-maxage': () => ({ status: 200, headers: new Headers({ 'cache-control': 's-maxage=30' }), body: 'x' }),
	'max-age': () => ({ status: 200, headers: new Headers({ 'Cache-Control': 'max-age=10' }), body: 'x' }),
	'no-store': () => ({ status: 200, headers: new Headers({ 'Cache-Control': 'no-store' }), body: 'x' }),
	'cache-control array': () => ({
		status: 200,
		headers: new Headers([['cache-control', ['max-age=5', 'must-revalidate']]]),
		body: 'x',
	}),
	'401 public': () => ({ status: 401, headers: new Headers({ 'Cache-Control': 'public, max-age=60' }), body: 'no' }),
	'401 private': () => ({ status: 401, headers: new Headers({ 'Cache-Control': 'private' }), body: 'no' }),
	'map': () => ({ status: 200, headers: new Map([['Vary', 'Accept']]), body: 'x' }),
	'whatwg': () => ({ status: 200, headers: new globalThis.Headers({ vary: 'Accept' }), body: 'x' }),
	'throws': () => {
		throw new ClientError('nope', 403);
	},
};

const REQUESTS = {
	'anonymous': {},
	'local trust': { localSocket: true },
	'basic': { authorization: BASIC },
	'bearer': { authorization: BEARER },
	'rejected basic': { authorization: BAD_BASIC },
};

async function loadAuthentication(cors) {
	const modulePath = require.resolve('#src/security/auth');
	const originalModule = require.cache[modulePath];
	const settings = {
		[CONFIG_PARAMS.HTTP_CORS]: cors,
		[CONFIG_PARAMS.HTTP_CORSACCESSLIST]: [ORIGIN],
		[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS]: cors,
		[CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST]: [ORIGIN],
	};
	const originalSettings = {};
	for (const [name, value] of Object.entries(settings)) {
		originalSettings[name] = env.get(name);
		env.setProperty(name, value);
	}
	// the module's top-level initSync() would re-read the config file over the settings above
	const originalInitSync = env.initSync;
	env.initSync = () => {};
	try {
		delete require.cache[modulePath];
		const { authentication } = require(modulePath);
		// startup has completed, so the fresh module's onStartup callback runs on the next microtask
		await new Promise((resolve) => setImmediate(resolve));
		return authentication;
	} finally {
		env.initSync = originalInitSync;
		require.cache[modulePath] = originalModule;
		for (const [name, value] of Object.entries(originalSettings)) env.setProperty(name, value);
	}
}

function makeRequest({ authorization, localSocket, origin, isOperationsServer, browser, method = 'GET', host }) {
	const headerObject = { host: host ?? 'example.com' };
	if (authorization) headerObject.authorization = authorization;
	if (origin) headerObject.origin = origin;
	if (browser) {
		headerObject['user-agent'] = 'Mozilla/5.0';
		headerObject.accept = 'text/html';
	}
	const request = {
		method,
		url: '/Thing/1',
		pathname: '/Thing/1',
		ip: localSocket ? undefined : '203.0.113.7',
		headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
		peerCertificate: { subject: null },
	};
	if (localSocket) request._nodeRequest = { socket: { server: { _pipeName: 'hdb.sock', bypassLocalAuth: true } } };
	if (isOperationsServer) request.isOperationsServer = true;
	return request;
}

function headerList(headers) {
	if (!headers) return null;
	const entries = headers[Symbol.iterator] ? [...headers] : Object.entries(headers);
	return {
		type: headers instanceof Headers ? 'Harper Headers' : headers.constructor.name,
		entries: entries.map(([name, value]) => [
			name,
			typeof value === 'string' ? value.replace(SESSION_ID, '<session>') : value,
		]),
	};
}

describe('authentication response headers', () => {
	let respond;
	let originalGetUser;
	let originalValidateOperationToken;
	const chains = {};
	function makeChain(authentication) {
		return makeCallbackChain(
			[
				{ listener: authentication, port: 'all', name: 'authentication' },
				{ listener: (request) => respond(request), port: 'all', name: 'app', after: 'authentication' },
			],
			'all',
			() => ({ status: 404, headers: new Headers(), body: 'Not found' })
		);
	}

	async function send({ cors, ...requestOptions }, responseFactory) {
		respond = responseFactory;
		const request = makeRequest(requestOptions);
		try {
			const response = await chains[cors](request);
			return { request, response, status: response.status, headers: headerList(response.headers) };
		} catch (error) {
			return { request, thrown: error, status: error.statusCode, headers: headerList(error.headers) };
		}
	}

	before(async () => {
		await testUtils.ensureSystemTables();
		await runStartup();
		chains.off = makeChain(await loadAuthentication(false));
		chains.on = makeChain(await loadAuthentication(true));
		if (!resourcesModule.resources) resourcesModule.resetResources();
		originalGetUser = serverModule.server.getUser;
		originalValidateOperationToken = tokenAuthentication.validateOperationToken;
		serverModule.server.getUser = async (username, password) => {
			if (username === 'header_user' && password === 'pw') return { username, role: { permission: {} } };
			throw credentialRejectionError('Login failed', 401);
		};
		tokenAuthentication.validateOperationToken = async () => ({ username: 'token_user', role: { permission: {} } });
	});

	after(() => {
		serverModule.server.getUser = originalGetUser;
		tokenAuthentication.validateOperationToken = originalValidateOperationToken;
		delete resourcesModule.resources.loginPath;
	});

	const recorded = {};
	after(() => {
		if (!RECORD) return;
		const lines = Object.entries(recorded).map(([name, value]) => `\t${JSON.stringify(name)}: ${JSON.stringify(value)}`);
		fs.writeFileSync(EXPECTED_PATH, `{\n${lines.join(',\n')}\n}\n`);
	});

	for (const [corsLabel, corsOptions] of [
		['CORS off', { cors: 'off' }],
		['CORS off, with Origin', { cors: 'off', origin: ORIGIN }],
		['CORS on, no Origin', { cors: 'on' }],
		['CORS on, with Origin', { cors: 'on', origin: ORIGIN }],
		['CORS on, other Origin', { cors: 'on', origin: 'https://other.example.com' }],
		['operations API, CORS on, with Origin', { cors: 'on', origin: ORIGIN, isOperationsServer: true }],
	]) {
		for (const [requestLabel, requestOptions] of Object.entries(REQUESTS)) {
			for (const [responseLabel, responseFactory] of Object.entries(RESPONSES)) {
				const name = `${corsLabel} / ${requestLabel} / ${responseLabel}`;
				it(name, async () => {
					const result = await send({ ...requestOptions, ...corsOptions }, responseFactory);
					const actual = { status: result.status, headers: result.headers };
					recorded[name] = actual;
					if (!RECORD) assert.deepStrictEqual(actual, EXPECTED[name]);
				});
			}
		}
	}

	const sessionUpdate = async (request) => {
		await request.session.update({ user: 'header_user' });
		return RESPONSES.rest();
	};
	const SPECIAL_CASES = {
		'login redirect': [
			{ cors: 'on', origin: ORIGIN, browser: true },
			() => {
				resourcesModule.resources.loginPath = () => '/login';
				return { status: 401, headers: new Headers(), body: 'no' };
			},
		],
		'preflight': [{ cors: 'on', origin: ORIGIN, method: 'OPTIONS' }, RESPONSES.rest],
		'preflight, CORS off': [{ cors: 'off', origin: ORIGIN, method: 'OPTIONS' }, RESPONSES.rest],
		'session update in handler, CORS on': [{ cors: 'on', origin: ORIGIN, authorization: BASIC }, sessionUpdate],
		'session update in handler, CORS off': [{ cors: 'off', authorization: BASIC }, sessionUpdate],
		'secure session update in handler, CORS on': [
			{ cors: 'on', origin: ORIGIN, authorization: BASIC, host: 'localhost:9926' },
			sessionUpdate,
		],
		'secure session update in handler, anonymous': [{ cors: 'off', host: 'localhost:9926' }, sessionUpdate],
	};
	for (const [name, [requestOptions, responseFactory]] of Object.entries(SPECIAL_CASES)) {
		it(name, async () => {
			try {
				const result = await send(requestOptions, responseFactory);
				const actual = { status: result.status, headers: result.headers };
				recorded[name] = actual;
				if (!RECORD) assert.deepStrictEqual(actual, EXPECTED[name]);
			} finally {
				delete resourcesModule.resources.loginPath;
			}
		});
	}

	for (const cors of ['on', 'off']) {
		const name = `session update after the response, CORS ${cors}`;
		it(name, async () => {
			const result = await send({ cors, origin: ORIGIN, authorization: BASIC, host: 'localhost:9926' }, RESPONSES.rest);
			await result.request.session.update({ user: 'header_user' });
			const actual = { status: result.status, headers: headerList(result.response.headers) };
			recorded[name] = actual;
			if (!RECORD) assert.deepStrictEqual(actual, EXPECTED[name]);
		});
	}
});

