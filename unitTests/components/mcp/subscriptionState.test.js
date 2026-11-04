const { processIncarnation } = require('#src/server/threads/processIncarnation');
const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const {
	createSession,
	loadSession,
	patchSession,
	deleteSession,
	ensureSessionTable,
	_setSessionTableForTest,
	withSessionSubscriptionLock,
} = require('#src/components/mcp/session');
const {
	claimSubscriptionOwner,
	updateResourceSubscription,
	_setSubscriptionTimeoutForTest,
	_pendingSubscriptionRouteCount,
} = require('#src/components/mcp/subscriptionState');
const {
	registerSession,
	getRegisteredSession,
	_resetSessionRegistryForTest,
} = require('#src/components/mcp/sessionRegistry');
const { _setResourcesForTest, _setSubscribeImplForTest } = require('#src/components/mcp/resources');
const { _liveSubscriptionCount, _resetSubscriptionsForTest } = require('#src/components/mcp/subscriptions');
const { AccessViolation } = require('#src/utility/errors/hdbError');

const USER = { username: 'alice', role: { permission: { super_user: true } } };
const URI = 'https://app.test/Product/1';

function deferred() {
	let resolve;
	const promise = new Promise((done) => (resolve = done));
	return { promise, resolve };
}

function changeStream() {
	const closed = deferred();
	return {
		stops: 0,
		end() {
			this.stops++;
			closed.resolve({ done: true });
		},
		[Symbol.asyncIterator]() {
			return { next: () => closed.promise };
		},
	};
}

describe('MCP persisted subscription state', function () {
	this.timeout(10000);
	let sessions;
	let products;
	let session;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		_setSessionTableForTest(undefined);
		sessions = ensureSessionTable();
		products = table({
			database: 'test',
			table: 'McpSubscriptionProduct',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});
	beforeEach(async () => {
		_setSessionTableForTest(sessions);
		const resources = new Map();
		resources.getMatch = (path) => ({ Resource: products, relativeURL: path.replace(/^Product\/?/, '') });
		_setResourcesForTest(resources);
		session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
	});
	afterEach(async () => {
		_resetSessionRegistryForTest();
		if (session) await waitFor(async () => !(await loadSession(session.id))?.streamToken);
		_resetSubscriptionsForTest();
		_setSubscribeImplForTest(undefined);
		_setResourcesForTest(undefined);
		_setSubscriptionTimeoutForTest(undefined);
		assert.equal(_pendingSubscriptionRouteCount(), 0);
	});
	after(() => _setSessionTableForTest(undefined));

	async function open() {
		const record = registerSession(session.id, 'application', USER);
		assert.equal(await claimSubscriptionOwner(session.id, record.streamToken), true);
		return record;
	}
	const subscribe = (uri = URI, user = USER) =>
		updateResourceSubscription({ session, operation: 'subscribe', uri, user });
	const unsubscribe = (uri = URI) => updateResourceSubscription({ session, operation: 'unsubscribe', uri });

	it('acknowledges installation and removal through a real Harper table subscription', async () => {
		await open();
		assert.equal(await subscribe(), 'success');
		assert.equal(_liveSubscriptionCount(session.id), 1);
		assert.equal(await unsubscribe(), 'success');
		assert.equal(_liveSubscriptionCount(session.id), 0);
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('does not persist a subscribe with no open GET', async () => {
		assert.equal(await subscribe(), 'no-live-stream');
		assert.equal((await loadSession(session.id)).subscriptions, undefined);
	});

	it('removes durable state without a GET so reconnect cannot restore it', async () => {
		await patchSession(session.id, { subscriptions: [URI] });
		assert.equal(await unsubscribe(), 'success');
		await open();
		assert.equal(_liveSubscriptionCount(session.id), 0);
	});

	it('preserves concurrent changes and accepts coalesced applied revisions', async () => {
		await open();
		const uris = Array.from({ length: 5 }, (_, index) => URI + index);
		assert.deepEqual(
			await Promise.all(uris.map((uri) => subscribe(uri))),
			uris.map(() => 'success')
		);
		assert.equal(_liveSubscriptionCount(session.id), 5);
		assert.deepEqual(new Set((await loadSession(session.id)).subscriptions), new Set(uris));
		assert.deepEqual(
			await Promise.all(uris.map((uri) => unsubscribe(uri))),
			uris.map(() => 'success')
		);
		assert.equal(_liveSubscriptionCount(session.id), 0);
	});

	it('does not acknowledge a subscription before its resource iterator is installed', async () => {
		await open();
		const started = deferred();
		const install = deferred();
		const stream = changeStream();
		_setSubscribeImplForTest(async () => {
			started.resolve();
			return install.promise;
		});
		let complete = false;
		const result = subscribe().then((value) => {
			complete = true;
			return value;
		});
		await started.promise;
		assert.equal(complete, false);
		await withSessionSubscriptionLock(session.id, async () => assert.equal(complete, false));
		install.resolve(stream);
		assert.equal(await result, 'success');
	});

	it('keeps delivering from an existing subscription while a replacement is installing', async () => {
		const record = await open();
		const original = new IterableEventQueue();
		original.end = () => original.close();
		_setSubscribeImplForTest(async () => original);
		assert.equal(await subscribe(), 'success');
		let updates = 0;
		record.queue.on('data', (frame) => {
			if (frame.data?.params?.uri === URI) updates++;
		});
		const started = deferred();
		const install = deferred();
		_setSubscribeImplForTest(async () => {
			started.resolve();
			return install.promise;
		});
		const replacing = subscribe();
		await started.promise;
		try {
			original.send({ id: '1' });
			await waitFor(() => updates > 0);
		} finally {
			install.resolve(changeStream());
			assert.equal(await replacing, 'success');
		}
	});

	it('stops a late install after its GET closes', async () => {
		_setSubscriptionTimeoutForTest(25);
		const record = await open();
		const started = deferred();
		const install = deferred();
		const stream = changeStream();
		_setSubscribeImplForTest(async () => {
			started.resolve();
			return install.promise;
		});
		const result = subscribe();
		await started.promise;
		record.queue.emit('close');
		install.resolve(stream);
		assert.equal(await result, 'timeout');
		await waitFor(() => stream.stops === 1);
		assert.equal(_liveSubscriptionCount(session.id), 0);
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('distinguishes deletion from a missing GET while installation is pending', async () => {
		await open();
		const started = deferred();
		const install = deferred();
		const stream = changeStream();
		_setSubscribeImplForTest(async () => {
			started.resolve();
			return install.promise;
		});
		const result = subscribe();
		await started.promise;
		try {
			await deleteSession(session.id);
			assert.equal(await result, 'session-gone');
		} finally {
			install.resolve(stream);
			await result;
		}
		await waitFor(() => stream.stops === 1);
	});

	it('does not let a superseded incarnation overwrite the new owner acknowledgement', async () => {
		const first = await open();
		const started = deferred();
		const install = deferred();
		const oldStream = changeStream();
		let calls = 0;
		_setSubscribeImplForTest(async () => {
			if (++calls === 1) {
				started.resolve();
				return install.promise;
			}
			return changeStream();
		});
		const result = subscribe();
		await started.promise;
		const replacement = await open();
		assert.notEqual(first.streamToken, replacement.streamToken);
		install.resolve(oldStream);
		assert.equal(await result, 'success');
		await waitFor(() => oldStream.stops === 1);
		const saved = await loadSession(session.id);
		assert.equal(saved.subscriptionAck.token, replacement.streamToken);
		assert.equal(_liveSubscriptionCount(session.id), 1);
	});

	it('rejects subscribe and completes unsubscribe for a token left by an earlier process', async () => {
		await patchSession(session.id, { subscriptions: [URI], streamToken: 'earlier-process:stream' });
		try {
			assert.equal(await subscribe(URI + 'other'), 'no-live-stream');
			assert.equal(await unsubscribe(), 'success');
			assert.deepEqual((await loadSession(session.id)).subscriptions, []);
		} finally {
			await patchSession(session.id, { streamToken: undefined });
		}
	});

	it('removes only its own generation after a timeout', async () => {
		await patchSession(session.id, { streamToken: `${processIncarnation}:dead-owner` });
		_setSubscriptionTimeoutForTest(10);
		assert.equal(await subscribe(), 'timeout');
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
		await patchSession(session.id, { streamToken: undefined });
		await open();
		assert.equal(_liveSubscriptionCount(session.id), 0);
	});

	it('does not let an older failed subscribe remove a newer retry generation', async () => {
		await patchSession(session.id, { streamToken: `${processIncarnation}:waiting-owner` });
		const first = subscribe();
		await waitFor(async () => (await loadSession(session.id)).subscriptionGenerations?.[URI]);
		const firstGeneration = (await loadSession(session.id)).subscriptionGenerations[URI];
		const retry = subscribe();
		await waitFor(async () => (await loadSession(session.id)).subscriptionGenerations[URI] !== firstGeneration);
		await open();
		assert.equal(await first, 'internal-error');
		assert.equal(await retry, 'success');
		assert.deepEqual((await loadSession(session.id)).subscriptions, [URI]);
		assert.equal(_liveSubscriptionCount(session.id), 1);
	});

	it('bounds one session backlog while admitting another session', async () => {
		await patchSession(session.id, { streamToken: `${processIncarnation}:unreachable-owner` });
		_setSubscriptionTimeoutForTest(25);
		const backlog = Array.from({ length: 25 }, (_, index) => subscribe(URI + index));
		try {
			assert.equal(await subscribe(URI + 'overflow'), 'internal-error');
			const other = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			assert.equal(
				await updateResourceSubscription({ session: other, operation: 'subscribe', uri: URI, user: USER }),
				'no-live-stream'
			);
			await Promise.all(backlog);
		} finally {
			await Promise.allSettled(backlog);
			await patchSession(session.id, { streamToken: undefined });
		}
	});

	it('rejects invalid URI names that collide with Object prototype properties', async () => {
		await open();
		for (const uri of ['__proto__', 'constructor', 'toString']) {
			const result = await subscribe(uri);
			assert.equal(result, 'not-subscribable', uri);
			assert.deepEqual((await loadSession(session.id)).subscriptions ?? [], []);
		}
		assert.equal(_liveSubscriptionCount(session.id), 0);
	});

	it('returns a terminal permission denial and removes the rejected desired entry', async () => {
		await open();
		_setSubscribeImplForTest(async () => {
			throw new AccessViolation(USER);
		});
		assert.equal(await subscribe(), 'permission-denied');
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('preserves a local principal but persists only scoped-token authorization fields', async () => {
		await open();
		let received;
		_setSubscribeImplForTest(async (_path, user) => {
			received = user;
			return changeStream();
		});
		const full = { ...USER, customClaim: 'custom', password: 'not-for-storage' };
		assert.equal(await subscribe(URI, full), 'success');
		assert.equal(received, full);
		assert.deepEqual((await loadSession(session.id)).subscriptionPrincipals, {});
		const scoped = { ...full, _scopedToken: true, authExpiresAt: Date.now() / 1000 + 60 };
		assert.equal(await subscribe(URI, scoped), 'success');
		const saved = await loadSession(session.id);
		const stored = saved.subscriptionPrincipals[saved.subscriptionPrincipalIds[URI]];
		assert.equal(stored.password, undefined);
		assert.equal(stored.customClaim, undefined);
		assert.equal(stored._scopedToken, true);
		assert.equal(stored.authExpiresAt, scoped.authExpiresAt);
		assert.equal(await subscribe(URI + 'other', scoped), 'success');
		const pooled = await loadSession(session.id);
		assert.equal(Object.keys(pooled.subscriptionPrincipals).length, 1);
		assert.equal(pooled.subscriptionPrincipalIds[URI], pooled.subscriptionPrincipalIds[URI + 'other']);
		assert.equal(await unsubscribe(URI), 'success');
		assert.equal(Object.keys((await loadSession(session.id)).subscriptionPrincipals).length, 1);
		assert.equal(await unsubscribe(URI + 'other'), 'success');
		assert.deepEqual((await loadSession(session.id)).subscriptionPrincipals, {});
	});

	it('does not restore a stored grant onto a different scoped credential with the same username', async () => {
		await open();
		_setSubscribeImplForTest(async () => changeStream());
		const broad = { ...USER, _scopedToken: true, authExpiresAt: Date.now() / 1000 + 60 };
		assert.equal(await subscribe(URI, broad), 'success');
		const narrow = { ...broad, role: { permission: {} } };
		const replacement = registerSession(session.id, 'application', narrow);
		assert.equal(await claimSubscriptionOwner(session.id, replacement.streamToken), true);
		assert.equal(_liveSubscriptionCount(session.id), 0);
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('rejects expired scoped-token state on reconnect', async () => {
		await patchSession(session.id, {
			subscriptions: [URI],
			subscriptionPrincipals: { expired: { ...USER, _scopedToken: true, authExpiresAt: 1 } },
			subscriptionPrincipalIds: { [URI]: 'expired' },
		});
		await open();
		assert.equal(_liveSubscriptionCount(session.id), 0);
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('does not deliver custom resource updates after the scoped grant expires', async () => {
		const record = await open();
		const stream = new IterableEventQueue();
		stream.end = () => stream.close();
		_setSubscribeImplForTest(async () => stream);
		let updates = 0;
		record.queue.on('data', (frame) => {
			if (frame.data?.params?.uri === URI) updates++;
		});
		const authExpiresAt = Math.ceil(Date.now() / 1000) + 1;
		assert.equal(await subscribe(URI, { ...USER, _scopedToken: true, authExpiresAt }), 'success');
		stream.send({ id: 'before-expiry' });
		await waitFor(() => updates === 1);
		await waitFor(() => Date.now() >= authExpiresAt * 1000, 3000);
		stream.send({ id: 'after-expiry' });
		await new Promise(setImmediate);
		assert.equal(updates, 1);
	});

	it('fails closed when a persisted scoped-principal reference is missing', async () => {
		await patchSession(session.id, {
			subscriptions: [URI],
			subscriptionPrincipalIds: { [URI]: 'missing-grant' },
			subscriptionPrincipals: {},
		});
		await open();
		assert.equal(_liveSubscriptionCount(session.id), 0);
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('closes a failed restore so a new GET can retry the durable subscription', async () => {
		await patchSession(session.id, { subscriptions: [URI] });
		let attempts = 0;
		_setSubscribeImplForTest(async () => {
			if (++attempts === 1) throw new Error('temporarily unavailable');
			return changeStream();
		});
		const first = registerSession(session.id, 'application', USER);
		assert.equal(await claimSubscriptionOwner(session.id, first.streamToken), false);
		assert.equal(getRegisteredSession(session.id), undefined);
		assert.deepEqual((await loadSession(session.id)).subscriptions, [URI]);
		await open();
		assert.equal(_liveSubscriptionCount(session.id), 1);
	});

	it('acknowledges durable removal when the GET closes before applying it', async () => {
		_setSubscriptionTimeoutForTest(1000);
		const record = await open();
		assert.equal(await subscribe(), 'success');
		const started = deferred();
		const install = deferred();
		_setSubscribeImplForTest(async () => {
			started.resolve();
			return install.promise;
		});
		const pending = subscribe(`${URI}/other`);
		await started.promise;
		try {
			const removal = unsubscribe();
			await waitFor(async () => !(await loadSession(session.id)).subscriptions.includes(URI));
			record.queue.emit('close');
			assert.equal(await removal, 'success');
		} finally {
			install.resolve(changeStream());
			await pending;
		}
	});

	it('closes the GET and its iterators when another request deletes the durable session', async () => {
		await open();
		assert.equal(await subscribe(), 'success');
		await sessions.delete(session.id);
		await waitFor(() => !getRegisteredSession(session.id));
		assert.equal(_liveSubscriptionCount(session.id), 0);
	});
});
