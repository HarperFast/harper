const assert = require('node:assert');
const { Headers } = require('#src/server/serverHelpers/Headers');

const testUtils = require('../testUtils.js');
const { setupTestDBPath } = testUtils;
testUtils.preTestPrep();

// HarperFast/harper#2983: `request.session.update(data, { ifVersion })` guards a session write on
// the version read alongside `request.session.version` — exercised here through two real passes
// of `authentication()` sharing one session cookie, the same path HarperFast/oauth#212's
// maintenance writes use (read, await, write back).
describe('session.update ifVersion (HarperFast/harper#2983)', function () {
	let authModule;
	let restoreEnvGet, restoreSerializeMessage;

	before(function () {
		setupTestDBPath();
		const { setMainIsWorker } = require('#js/server/threads/manageThreads');
		setMainIsWorker(true);

		// AGENTS.md: no new sinon/rewire — plain reassignment, restored in after().
		const env = require('#src/utility/environment/environmentManager');
		const originalEnvGet = env.get;
		restoreEnvGet = () => {
			env.get = originalEnvGet;
		};
		env.get = (key) => {
			if (key === 'authentication.enableSessions') return true;
			if (key === 'authentication.authorizeLocal') return false;
			return undefined;
		};

		const contentTypes = require('#src/server/serverHelpers/contentTypes');
		const originalSerializeMessage = contentTypes.serializeMessage;
		restoreSerializeMessage = () => {
			contentTypes.serializeMessage = originalSerializeMessage;
		};
		contentTypes.serializeMessage = (message) => message;

		authModule = require('#src/security/auth');
	});

	after(function () {
		restoreEnvGet();
		restoreSerializeMessage();
	});

	function newRequest(cookie) {
		return {
			headers: { asObject: { authorization: null, cookie, origin: null, host: 'localhost' } },
			method: 'GET',
			pathname: '/test',
			ip: '192.168.1.100', // eslint-disable-line sonarjs/no-hardcoded-ip
			isOperationsServer: false,
			mtlsConfig: null,
			authorized: false,
			peerCertificate: null,
			protocol: 'https',
		};
	}

	function newResponse() {
		return { status: 200, headers: new Headers(), body: {} };
	}

	// auth.ts prefixes the cookie name with the (CSRF-partitioning) origin, falling back to
	// `headers.host` ('localhost' here) when no Origin header is sent — so the real cookie name is
	// `localhost-hdb-session`, not the bare `hdb-session` the session id lives under. Returning the
	// whole `name=value` pair (rather than reconstructing it) keeps this test from re-encoding that
	// assumption a second time.
	function extractSessionCookie(response) {
		const setCookie = response.headers.get('Set-Cookie');
		const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
		const found = cookies.find((c) => c?.includes('hdb-session='));
		assert.ok(found, 'expected a Set-Cookie header establishing a session');
		return found.split(';')[0];
	}

	async function establishSession(greeting) {
		const response = newResponse();
		await authModule.authentication(newRequest(null), async (request) => {
			await request.session.update({ greeting });
			return response;
		});
		return extractSessionCookie(response);
	}

	it('establishes a session and exposes its version on a later read', async function () {
		const cookie = await establishSession('hello');

		let observedSession;
		await authModule.authentication(newRequest(cookie), async (request) => {
			observedSession = request.session;
			return newResponse();
		});
		assert.strictEqual(observedSession.greeting, 'hello');
		assert.strictEqual(typeof observedSession.version, 'number');
		// Non-enumerable: must not leak into a plain enumeration/spread of the session's stored fields
		// (an app's own same-named field, or a later full-object persist, must not pick it up).
		assert.ok(!Object.keys(observedSession).includes('version'), 'version is not enumerable');
		assert.ok(!('version' in { ...observedSession }), 'version does not survive a spread');
	});

	it('writes a conditional update that matches the version just read', async function () {
		const cookie = await establishSession('hello');

		let heldVersion;
		await authModule.authentication(newRequest(cookie), async (request) => {
			heldVersion = request.session.version;
			await request.session.update({ greeting: 'updated' }, { ifVersion: heldVersion });
			return newResponse();
		});

		await authModule.authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.greeting, 'updated');
			assert.notStrictEqual(request.session.version, heldVersion, 'version advanced');
			return newResponse();
		});
	});

	it('rejects a conditional update whose version a concurrent write already moved past, writing nothing', async function () {
		const cookie = await establishSession('hello');

		let heldVersion;
		await authModule.authentication(newRequest(cookie), async (request) => {
			heldVersion = request.session.version;
			return newResponse();
		});
		// A concurrent write lands between the read above and the conditional write below.
		await authModule.authentication(newRequest(cookie), async (request) => {
			await request.session.update({ greeting: 'concurrent winner' });
			return newResponse();
		});

		let rejection;
		await authModule.authentication(newRequest(cookie), async (request) => {
			try {
				await request.session.update({ greeting: 'stale loser' }, { ifVersion: heldVersion });
			} catch (error) {
				rejection = error;
			}
			return newResponse();
		});
		assert.ok(rejection, 'the conditional write was rejected');
		assert.strictEqual(rejection.code, 'VERSION_CONFLICT');
		assert.strictEqual(rejection.statusCode, 409);
		assert.strictEqual(rejection.retryable, true, 'an ordinary mismatch is retryable with a fresh read');

		await authModule.authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.greeting, 'concurrent winner', 'the rejected write left no trace');
			return newResponse();
		});
	});

	it('rejects an ambiguous ifVersion (present but not a finite number) rather than writing unconditionally', async function () {
		const cookie = await establishSession('hello');

		let threw = false;
		await authModule.authentication(newRequest(cookie), async (request) => {
			try {
				// `request.session.version` undefined (e.g. a since-deleted session) must not fall back
				// to an unconditional write.
				await request.session.update({ greeting: 'should not land' }, { ifVersion: undefined });
			} catch {
				threw = true;
			}
			return newResponse();
		});
		assert.ok(threw, 'an explicit but unusable ifVersion must throw rather than go unconditional');

		await authModule.authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.greeting, 'hello', 'the rejected call wrote nothing');
			return newResponse();
		});
	});

	it('omitting the second argument stays unconditional, unchanged from before this feature', async function () {
		const cookie = await establishSession('hello');

		await authModule.authentication(newRequest(cookie), async (request) => {
			await request.session.update({ greeting: 'overwritten unconditionally' });
			return newResponse();
		});

		await authModule.authentication(newRequest(cookie), async (request) => {
			assert.strictEqual(request.session.greeting, 'overwritten unconditionally');
			return newResponse();
		});
	});
});
