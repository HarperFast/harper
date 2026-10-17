const assert = require('node:assert');
const {
	addResourceSubscription,
	removeResourceSubscription,
	dropSessionSubscriptions,
	restoreResourceSubscriptions,
	SubscriptionCancelledError,
	_liveSubscriptionCount,
	_resetSubscriptionsForTest,
} = require('#src/components/mcp/subscriptions');
const { _setSubscribeImplForTest } = require('#src/components/mcp/resources');
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

	it('dropSessionSubscriptions stops all live subscriptions for a session', async () => {
		registerSession('s1', 'application', USER);
		await addResourceSubscription('s1', URI, USER);
		dropSessionSubscriptions('s1');
		assert.equal(fake.endCalls, 1);
		assert.equal(_liveSubscriptionCount('s1'), 0);
	});

	describe('setup owned by the GET stream that requested it', () => {
		const URI_B = 'https://app.test:9926/Product/2';
		function deferred() {
			let resolve;
			const promise = new Promise((r) => (resolve = r));
			return { promise, resolve };
		}
		const turns = async (n = 5) => {
			for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
		};

		it('cancels and releases a setup whose GET stream closed before it resolved', async () => {
			registerSession('s1', 'application', USER);
			const gate = deferred();
			_setSubscribeImplForTest(async () => (await gate.promise, fake));
			const setup = addResourceSubscription('s1', URI, USER);
			getRegisteredSession('s1').queue.emit('close');
			gate.resolve();
			await assert.rejects(
				setup,
				(err) => err instanceof SubscriptionCancelledError && /GET SSE stream/.test(err.message)
			);
			assert.equal(fake.endCalls, 1);
			assert.equal(_liveSubscriptionCount('s1'), 0);
		});

		it('cancels a setup overtaken by unsubscribe, delivering nothing it had buffered', async () => {
			registerSession('s1', 'application', USER);
			const frames = framesOf('s1');
			const gate = deferred();
			_setSubscribeImplForTest(async () => (await gate.promise, fake));
			const setup = addResourceSubscription('s1', URI, USER);
			fake.push({ id: '1' });
			assert.equal(removeResourceSubscription('s1', URI), false, 'nothing live yet');
			gate.resolve();
			await assert.rejects(setup, /unsubscribed/);
			await turns();
			assert.equal(frames.length, 0);
			assert.equal(fake.endCalls, 1);
		});

		it('lets a newer subscribe for the same URI supersede one still in setup', async () => {
			registerSession('s1', 'application', USER);
			const frames = framesOf('s1');
			const gate = deferred();
			const first = makeFakeStream();
			const second = makeFakeStream();
			let calls = 0;
			_setSubscribeImplForTest(async () => (++calls === 1 ? (await gate.promise, first) : second));
			const older = addResourceSubscription('s1', URI, USER);
			assert.equal(await addResourceSubscription('s1', URI, USER), true);
			gate.resolve();
			await assert.rejects(older, /superseded/);
			assert.equal(first.endCalls, 1);
			assert.equal(_liveSubscriptionCount('s1'), 1);
			second.push({ id: '1' });
			await turns();
			assert.equal(frames.length, 1);
		});

		it('cancels setups in flight when the session drops its subscriptions', async () => {
			registerSession('s1', 'application', USER);
			const gate = deferred();
			_setSubscribeImplForTest(async () => (await gate.promise, fake));
			const setup = addResourceSubscription('s1', URI, USER);
			dropSessionSubscriptions('s1');
			gate.resolve();
			await assert.rejects(setup, SubscriptionCancelledError);
			assert.equal(fake.endCalls, 1);
		});

		it('refuses a subscribe with no GET stream at all', async () => {
			await assert.rejects(addResourceSubscription('s1', URI, USER), SubscriptionCancelledError);
		});

		it('pushes only to the record that admitted it', async () => {
			registerSession('s1', 'application', USER);
			await addResourceSubscription('s1', URI, USER);
			registerSession('s1', 'application', USER); // a reconnect supersedes the admitting stream
			const frames = framesOf('s1');
			fake.push({ id: '1' });
			await turns();
			assert.equal(frames.length, 0);
		});

		it('stops restoring once a newer GET supersedes it, keeping every URI it did not settle', async () => {
			const owner = registerSession('s1', 'application', USER);
			const gate = deferred();
			const requested = [];
			_setSubscribeImplForTest(async (path) => {
				requested.push(path);
				await gate.promise;
				return fake;
			});
			const restoring = restoreResourceSubscriptions('s1', [URI, URI_B], USER, 'application', owner);
			registerSession('s1', 'application', USER);
			gate.resolve();
			assert.deepEqual(await restoring, [URI, URI_B]);
			assert.deepEqual(requested, ['Product/1'], 'the second URI is never acquired for the superseded GET');
			assert.equal(fake.endCalls, 1);
			assert.equal(_liveSubscriptionCount('s1'), 0);
		});

		it('keeps a URI whose subscribe threw, so the next reconnect retries it', async () => {
			registerSession('s1', 'application', USER);
			_setSubscribeImplForTest(async (path) => {
				if (path === 'Product/2') throw new Error('source unavailable');
				return fake;
			});
			assert.deepEqual(await restoreResourceSubscriptions('s1', [URI, URI_B], USER), [URI, URI_B]);
			assert.equal(_liveSubscriptionCount('s1'), 1);
		});
	});

	it('restore re-establishes durable subscriptions and reports which succeeded', async () => {
		registerSession('s1', 'application', USER);
		const restored = await restoreResourceSubscriptions('s1', [URI, 'https://app.test:9926/nope'], USER);
		assert.deepEqual(restored, [URI], 'only the subscribable URI is restored');
		assert.equal(_liveSubscriptionCount('s1'), 1);
	});
});
