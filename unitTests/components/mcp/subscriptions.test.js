const assert = require('node:assert');
const {
	addResourceSubscription,
	removeResourceSubscription,
	dropSessionSubscriptions,
	_liveSubscriptionCount,
	_resetSubscriptionsForTest,
} = require('#src/components/mcp/subscriptions');
const { _setSubscribeImplForTest } = require('#src/components/mcp/resources');
const { addCustomResource, clearProfileCustomResources } = require('#src/components/mcp/customResourceRegistry');
const {
	registerSession,
	getRegisteredSession,
	_resetSessionRegistryForTest,
} = require('#src/components/mcp/sessionRegistry');

const USER = { username: 'u', role: { permission: { super_user: true } } };

// A controllable async-iterable change stream with `.end()` — the shape
// subscribeToResource expects from `resource.subscribe`.
function makeFakeStream() {
	const buffered = [];
	let resolveNext = null;
	let ended = false;
	const stream = {
		endCalls: 0,
		push(update) {
			if (resolveNext) {
				resolveNext({ done: false, value: update });
				resolveNext = null;
			} else buffered.push(update);
		},
		end() {
			this.endCalls++;
			ended = true;
			if (resolveNext) {
				resolveNext({ done: true, value: undefined });
				resolveNext = null;
			}
		},
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (buffered.length) return Promise.resolve({ done: false, value: buffered.shift() });
					if (ended) return Promise.resolve({ done: true, value: undefined });
					return new Promise((r) => (resolveNext = r));
				},
				return() {
					ended = true;
					return Promise.resolve({ done: true, value: undefined });
				},
			};
		},
	};
	return stream;
}

// Collect frames a session's queue receives via the event API.
function framesOf(sessionId) {
	const out = [];
	getRegisteredSession(sessionId).queue.on('data', (f) => out.push(f.data));
	return out;
}

describe('mcp/subscriptions', () => {
	let fake;
	beforeEach(() => {
		_resetSessionRegistryForTest();
		_resetSubscriptionsForTest();
		fake = makeFakeStream();
		// Inject the fake regardless of which path; null is returned for a sentinel uri.
		_setSubscribeImplForTest(async (path) => (path === 'nope' ? null : fake));
	});
	afterEach(() => {
		_setSubscribeImplForTest(undefined);
		_resetSubscriptionsForTest();
		_resetSessionRegistryForTest();
	});

	const URI = 'https://app.test:9926/Product/1';

	it('subscribes and pushes notifications/resources/updated on each change', async () => {
		registerSession('s1', 'application', USER);
		const frames = framesOf('s1');
		const ok = await addResourceSubscription('s1', URI, USER);
		assert.equal(ok, true);
		assert.equal(_liveSubscriptionCount('s1'), 1);
		fake.push({ id: '1', value: {} });
		await new Promise((r) => setImmediate(r));
		assert.equal(frames.length, 1);
		assert.equal(frames[0].method, 'notifications/resources/updated');
		assert.equal(frames[0].params.uri, URI);
	});

	it('acknowledges updates that carry an acknowledge()', async () => {
		registerSession('s1', 'application', USER);
		framesOf('s1');
		await addResourceSubscription('s1', URI, USER);
		let acked = false;
		fake.push({ id: '1', acknowledge: () => (acked = true) });
		await new Promise((r) => setImmediate(r));
		assert.equal(acked, true);
	});

	it('returns false for a non-subscribable URI', async () => {
		registerSession('s1', 'application', USER);
		const ok = await addResourceSubscription('s1', 'https://app.test:9926/nope', USER);
		assert.equal(ok, false);
		assert.equal(_liveSubscriptionCount('s1'), 0);
	});

	it('unsubscribe stops the stream and drops it', async () => {
		registerSession('s1', 'application', USER);
		await addResourceSubscription('s1', URI, USER);
		assert.equal(removeResourceSubscription('s1', URI), true);
		assert.equal(fake.endCalls, 1, 'stream.end() called on unsubscribe');
		assert.equal(_liveSubscriptionCount('s1'), 0);
		assert.equal(removeResourceSubscription('s1', URI), false, 'second unsubscribe is a no-op');
	});

	it('keeps a replacement of the only subscription registered, so unsubscribe still stops it', async () => {
		registerSession('s1', 'application', USER);
		const streams = [];
		_setSubscribeImplForTest(async () => streams[streams.push(makeFakeStream()) - 1]);
		await addResourceSubscription('s1', URI, USER);
		await addResourceSubscription('s1', URI, USER);
		assert.equal(streams[0].endCalls, 1, 'the predecessor is stopped');
		assert.equal(_liveSubscriptionCount('s1'), 1);
		assert.equal(removeResourceSubscription('s1', URI), true);
		assert.equal(streams[1].endCalls, 1, 'the replacement is stopped by unsubscribe');
	});

	it('dropSessionSubscriptions stops all live subscriptions for a session', async () => {
		registerSession('s1', 'application', USER);
		await addResourceSubscription('s1', URI, USER);
		dropSessionSubscriptions('s1');
		assert.equal(fake.endCalls, 1);
		assert.equal(_liveSubscriptionCount('s1'), 0);
	});

	describe('custom resources (#3250)', () => {
		const NOTE = 'notes:///n1';
		let seenProfile;
		beforeEach(() => {
			seenProfile = undefined;
			addCustomResource({
				uriTemplate: 'notes:///{id}',
				name: 'note',
				profile: 'application',
				read: async () => 'x',
				subscribe: async (_params, context) => {
					seenProfile = context.profile;
					return fake;
				},
			});
		});
		afterEach(() => clearProfileCustomResources('application'));

		it('subscribes through the owning GET profile and pushes the subscribed URI on each value', async () => {
			registerSession('s1', 'application', USER);
			const frames = framesOf('s1');
			assert.equal(await addResourceSubscription('s1', NOTE, USER), true);
			assert.equal(seenProfile, 'application');
			fake.push({ opaque: true });
			await new Promise((r) => setImmediate(r));
			assert.equal(frames.length, 1);
			assert.equal(frames[0].params.uri, NOTE);
		});

		it('is not subscribable from a session of another profile', async () => {
			registerSession('s1', 'operations', USER);
			assert.equal(await addResourceSubscription('s1', NOTE, USER), false);
			assert.equal(seenProfile, undefined);
		});

		it('releases the stream and delivers nothing when its GET is superseded during setup', async () => {
			registerSession('s1', 'application', USER);
			clearProfileCustomResources('application');
			let finishSetup;
			addCustomResource({
				uriTemplate: 'notes:///{id}',
				name: 'note',
				profile: 'application',
				read: async () => 'x',
				subscribe: () => new Promise((resolve) => (finishSetup = () => resolve(fake))),
			});
			const pending = addResourceSubscription('s1', NOTE, USER);
			await new Promise((r) => setImmediate(r));
			registerSession('s1', 'application', USER);
			const frames = framesOf('s1');
			finishSetup();
			assert.equal(await pending, false);
			fake.push({});
			await new Promise((r) => setImmediate(r));
			assert.equal(fake.endCalls, 1);
			assert.deepEqual(frames, []);
			assert.equal(_liveSubscriptionCount('s1'), 0);
		});

		it('drops its live entry when the stream ends on its own', async () => {
			registerSession('s1', 'application', USER);
			framesOf('s1');
			await addResourceSubscription('s1', NOTE, USER);
			assert.equal(_liveSubscriptionCount('s1'), 1);
			fake.end();
			await new Promise((r) => setImmediate(r));
			assert.equal(_liveSubscriptionCount('s1'), 0);
		});
	});
});
