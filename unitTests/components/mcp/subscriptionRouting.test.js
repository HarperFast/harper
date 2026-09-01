const assert = require('node:assert');
const {
	claimSubscriptionOwner,
	routeResourceSubscription,
	withSessionSubscriptionLock,
	_setSubscriptionItcForTest,
	_setSubscriptionThreadIdForTest,
	_setSubscriptionTimeoutForTest,
	_resetSubscriptionRoutingForTest,
	_pendingSubscriptionRouteCount,
} = require('#src/components/mcp/subscriptionRouting');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { createSession, loadSession, patchSession, _setSessionTableForTest } = require('#src/components/mcp/session');
const { registerSession, _resetSessionRegistryForTest } = require('#src/components/mcp/sessionRegistry');
const { _setSubscribeImplForTest } = require('#src/components/mcp/resources');
const { _resetSubscriptionsForTest } = require('#src/components/mcp/subscriptions');

const USER = { username: 'alice', role: { permission: { super_user: true } } };

function fakeTable() {
	const store = new Map();
	return {
		async put(record) {
			store.set(record.id, { ...record });
		},
		async patch(record) {
			store.set(record.id, { ...store.get(record.id), ...record });
		},
		async get(id) {
			const record = store.get(id);
			return record && { ...record };
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

function fakeBridge(send) {
	const listeners = new Map();
	return {
		listeners,
		onMessageByType(type, listener) {
			listeners.set(type, listener);
		},
		sendToThread(target, event) {
			return send?.(target, event, listeners) ?? true;
		},
	};
}

describe('mcp/subscriptionRouting', () => {
	beforeEach(() => {
		_setSessionTableForTest(fakeTable());
		_setSubscriptionThreadIdForTest(1);
		_setSubscriptionItcForTest(fakeBridge());
	});

	afterEach(() => {
		_resetSubscriptionsForTest();
		_resetSessionRegistryForTest();
		_resetSubscriptionRoutingForTest();
		_setSubscriptionItcForTest(undefined);
		_setSessionTableForTest(undefined);
		_setSubscribeImplForTest(undefined);
	});

	async function remoteSession() {
		const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
		await patchSession(session.id, { streamOwner: { threadId: 7, token: 'owner-token' } });
		return loadSession(session.id);
	}

	it('accepts a correlated response only from the expected owner thread', async () => {
		const bridge = fakeBridge((_target, event, listeners) => {
			assert.equal(event.message.user.password, undefined, 'credentials must not cross the worker boundary');
			assert.equal(event.message.user.username, '');
			assert.equal(event.message.user.authExpiresAt, 12345);
			assert.equal(event.message.user.role.role, '');
			const requestId = event.message.requestId;
			setImmediate(() => {
				listeners.get(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE)({
					message: { requestId, originator: 8, result: 'not-subscribable' },
				});
				listeners.get(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE)({
					message: { requestId, originator: 7, result: 'success' },
				});
			});
			return true;
		});
		_setSubscriptionItcForTest(bridge);
		const result = await routeResourceSubscription({
			session: await remoteSession(),
			operation: 'subscribe',
			uri: 'https://app.test/Product/1',
			user: {
				...USER,
				username: '',
				authExpiresAt: 12345,
				role: { ...USER.role, role: '' },
				password: 'do-not-forward',
			},
		});
		assert.equal(result, 'success');
		assert.equal(_pendingSubscriptionRouteCount(), 0);
	});

	it('fails quickly when the persisted owner thread is unreachable', async () => {
		_setSubscriptionItcForTest(fakeBridge(() => false));
		const result = await routeResourceSubscription({
			session: await remoteSession(),
			operation: 'subscribe',
			uri: 'https://app.test/Product/1',
			user: USER,
		});
		assert.equal(result, 'no-live-stream');
		assert.equal(_pendingSubscriptionRouteCount(), 0);
	});

	it('retries listener wiring after the thread bridge becomes available', async () => {
		const bridge = fakeBridge();
		bridge.available = false;
		_setSubscriptionItcForTest(bridge);
		const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
		await claimSubscriptionOwner(session.id, 'first-stream');
		assert.equal(bridge.listeners.size, 0);
		bridge.available = true;
		await claimSubscriptionOwner(session.id, 'second-stream');
		assert.equal(bridge.listeners.has(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND), true);
		assert.equal(bridge.listeners.has(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE), true);
	});

	it('bounds a sent command when the owner never responds', async () => {
		_setSubscriptionTimeoutForTest(5);
		_setSubscriptionItcForTest(fakeBridge(() => true));
		const result = await routeResourceSubscription({
			session: await remoteSession(),
			operation: 'subscribe',
			uri: 'https://app.test/Product/1',
			user: USER,
		});
		assert.equal(result, 'timeout');
		assert.equal(_pendingSubscriptionRouteCount(), 0);
	});

	it('rejects a command whose stream token no longer owns the local registry', async () => {
		let response;
		const bridge = fakeBridge((_target, event) => {
			if (event.type === ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE) response = event.message;
			return true;
		});
		_setSubscriptionItcForTest(bridge);
		_setSubscriptionThreadIdForTest(7);
		const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
		const registered = registerSession(session.id, 'application', USER);
		await claimSubscriptionOwner(session.id, registered.streamToken);
		await bridge.listeners.get(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND)({
			message: {
				requestId: 'r1',
				originator: 1,
				sessionId: session.id,
				streamToken: 'stale-token',
				operation: 'subscribe',
				uri: 'https://app.test/Product/1',
				user: USER,
			},
		});
		await new Promise(setImmediate);
		assert.equal(response.result, 'no-live-stream');
	});

	it('ignores malformed commands without attempting a response', async () => {
		let sent = 0;
		const bridge = fakeBridge(() => {
			sent++;
			return true;
		});
		_setSubscriptionItcForTest(bridge);
		const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
		await claimSubscriptionOwner(session.id, 'owner-token');
		const listener = bridge.listeners.get(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND);
		assert.doesNotThrow(() => listener({ message: undefined }));
		assert.doesNotThrow(() => listener({ message: { requestId: 'r1', originator: 1 } }));
		await new Promise(setImmediate);
		assert.equal(sent, 0);
	});

	it('executes subscribe and unsubscribe on the owner and updates the durable URI list', async () => {
		let response;
		const bridge = fakeBridge((_target, event) => {
			if (event.type === ITC_EVENT_TYPES.MCP_SUBSCRIPTION_RESPONSE) response = event.message;
			return true;
		});
		_setSubscriptionItcForTest(bridge);
		_setSubscriptionThreadIdForTest(7);
		_setSubscribeImplForTest(async (_path, user) => {
			assert.deepEqual(user, USER);
			return {
				end() {},
				[Symbol.asyncIterator]() {
					return { next: () => new Promise(() => {}) };
				},
			};
		});
		const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
		const registered = registerSession(session.id, 'application', USER);
		await claimSubscriptionOwner(session.id, registered.streamToken);
		const uri = 'https://app.test/Product/1';
		bridge.listeners.get(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND)({
			message: {
				requestId: 'r2',
				originator: 1,
				sessionId: session.id,
				streamToken: registered.streamToken,
				operation: 'subscribe',
				uri,
				user: USER,
			},
		});
		for (let i = 0; i < 20 && !response; i++) await new Promise(setImmediate);
		assert.equal(response.result, 'success');
		assert.deepEqual((await loadSession(session.id)).subscriptions, [uri]);

		response = undefined;
		bridge.listeners.get(ITC_EVENT_TYPES.MCP_SUBSCRIPTION_COMMAND)({
			message: {
				requestId: 'r3',
				originator: 1,
				sessionId: session.id,
				streamToken: registered.streamToken,
				operation: 'unsubscribe',
				uri,
			},
		});
		for (let i = 0; i < 20 && !response; i++) await new Promise(setImmediate);
		assert.equal(response.result, 'success');
		assert.deepEqual((await loadSession(session.id)).subscriptions, []);
	});

	it('serializes owner commands behind reconnect restoration for the same session', async () => {
		_setSubscriptionThreadIdForTest(7);
		const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
		const registered = registerSession(session.id, 'application', USER);
		await claimSubscriptionOwner(session.id, registered.streamToken);
		let releaseRestore;
		const restoreBlocked = new Promise((resolve) => (releaseRestore = resolve));
		const restoring = withSessionSubscriptionLock(session.id, () => restoreBlocked);
		let subscribeStarted = false;
		_setSubscribeImplForTest(async () => {
			subscribeStarted = true;
			return {
				end() {},
				[Symbol.asyncIterator]() {
					return { next: () => new Promise(() => {}) };
				},
			};
		});
		const subscribing = routeResourceSubscription({
			session: await loadSession(session.id),
			operation: 'subscribe',
			uri: 'https://app.test/Product/2',
			user: USER,
		});
		await new Promise(setImmediate);
		assert.equal(subscribeStarted, false);
		releaseRestore();
		await restoring;
		assert.equal(await subscribing, 'success');
		assert.equal(subscribeStarted, true);
	});
});
