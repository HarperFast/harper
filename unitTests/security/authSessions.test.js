'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const { waitFor } = require('../waitFor');
const { databases } = require('#src/resources/databases');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { authentication } = require('#src/security/auth');
const { runStartup } = require('#src/utility/lifecycle');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

function remoteRequest(headerObject = {}) {
	return {
		method: 'GET',
		url: '/',
		pathname: '/',
		ip: '203.0.113.7',
		headers: { asObject: { host: 'example.com', ...headerObject }, get: (name) => headerObject[name.toLowerCase()] },
		peerCertificate: { subject: null },
	};
}

async function authenticate(request, handler = () => {}) {
	let seen;
	const response = await authentication(request, async (authenticated) => {
		seen = authenticated.user;
		await handler(authenticated);
		return { status: 200, headers: new Headers() };
	});
	return { user: seen, response };
}

function sessionCookie(response) {
	return response.headers.get('Set-Cookie').split(';')[0];
}

const sessionIdOf = (cookie) => cookie.slice(cookie.indexOf('=') + 1);

async function storedSession(cookie) {
	return databases.system.hdb_session.get(sessionIdOf(cookie));
}

// The session helpers authentication() installs on a request: what they persist, which response they set
// the cookie on, and that they keep working however the application holds them.
describe('authentication session helpers', function () {
	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		await testUtils.ensureSystemTables();
		await runStartup();
		setMainIsWorker(true);
	});

	afterEach(() => testUtils.seedUsers());

	it('gives a request with no cookie an empty session it can start', async () => {
		let session;
		const { user, response } = await authenticate(remoteRequest(), (request) => {
			session = { ...request.session };
			return request.session.update({ cart: ['widget'] });
		});
		assert.strictEqual(user, undefined);
		assert.deepStrictEqual(Object.keys(session), ['update']);
		const cookie = sessionCookie(response);
		assert.match(cookie, /^example_com-hdb-session=/);
		assert.deepStrictEqual((await storedSession(cookie)).cart, ['widget']);
		await databases.system.hdb_session.delete(sessionIdOf(cookie));
	});

	it('loads the session and its user from the session cookie', async () => {
		const login = await authenticate(remoteRequest(), (request) => request.login('admin', 'password'));
		const cookie = sessionCookie(login.response);
		await waitFor(async () => (await storedSession(cookie))?.user === 'admin');
		let session;
		const { user, response } = await authenticate(remoteRequest({ cookie: `other=1; ${cookie}` }), (request) => {
			session = request.session;
			return request.session.update({ ...request.session, cart: ['gadget'] });
		});
		assert.strictEqual(user.username, 'admin');
		assert.strictEqual(session.user, 'admin');
		assert.strictEqual(session.id, sessionIdOf(cookie));
		assert.strictEqual(response.headers.get('Set-Cookie'), undefined, 'an existing session is not re-issued');
		await waitFor(async () => (await storedSession(cookie))?.cart?.[0] === 'gadget');
		assert.strictEqual((await storedSession(cookie)).user, 'admin');
		await databases.system.hdb_session.delete(sessionIdOf(cookie));
	});

	it('keeps update and login working when detached from the request or copied', async () => {
		let copied;
		const { response } = await authenticate(remoteRequest(), async (request) => {
			const { login } = request;
			await login('admin', 'password');
			const { update } = request.session;
			await update({ user: 'admin', step: 1 });
			copied = { ...request.session };
			await copied.update({ user: 'admin', step: 2 });
		});
		const cookie = sessionCookie(response);
		await waitFor(async () => (await storedSession(cookie))?.step === 2);
		assert.strictEqual((await storedSession(cookie)).user, 'admin');
		assert.strictEqual(typeof copied.update, 'function');
		await databases.system.hdb_session.delete(sessionIdOf(cookie));
	});

	it('overwrites a stored session field named update with the helper', async () => {
		const first = await authenticate(remoteRequest(), (request) => request.session.update({ update: 'stored' }));
		const cookie = sessionCookie(first.response);
		assert.strictEqual((await storedSession(cookie)).update, 'stored', 'premise: the row has an update field');
		let update;
		await authenticate(remoteRequest({ cookie }), (request) => (update = request.session.update));
		assert.strictEqual(typeof update, 'function');
		await databases.system.hdb_session.delete(sessionIdOf(cookie));
	});

	it('sets the cookie on the response itself for an update after authentication returned', async () => {
		let request;
		const { response } = await authenticate(remoteRequest(), (authenticated) => (request = authenticated));
		assert.strictEqual(response.headers.get('Set-Cookie'), undefined);
		await request.session.update({ cart: ['late'] });
		const cookie = sessionCookie(response);
		assert.deepStrictEqual((await storedSession(cookie)).cart, ['late']);
		await databases.system.hdb_session.delete(sessionIdOf(cookie));
	});
});
