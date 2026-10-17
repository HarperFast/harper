'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');

// A background re-authorization tick landing mid-test would add rechecks the tests do not count on.
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS ??= String(24 * 60 * 60 * 1000);

const { subscribeToResource } = require('#src/components/mcp/resources');
const { addCustomResource, clearProfileCustomResources } = require('#src/components/mcp/customResourceRegistry');
const { contextStorage } = require('#src/resources/transaction');
const { _liveSubscriptionCount, _notifyUserChange } = require('#src/server/liveSubscriptionAuth');
const { AccessViolation } = require('#src/utility/errors/hdbError');
const { findAndValidateUser } = require('#src/security/user');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../../waitFor');

const USER = { username: 'mcp_sub_user', role: { permission: { super_user: false } } };
const turn = () => new Promise((resolve) => setImmediate(resolve));

// A controllable change stream; `withEnd: false` leaves only the iterator's return() to release it.
function makeStream({ withEnd = true, end, onReturn } = {}) {
	const buffered = [];
	let resolveNext = null;
	let closed = false;
	const stats = { endCalls: 0, returnCalls: 0 };
	const close = () => {
		closed = true;
		if (resolveNext) {
			resolveNext({ done: true, value: undefined });
			resolveNext = null;
		}
	};
	const stream = {
		stats,
		push(value) {
			if (closed) return;
			if (resolveNext) {
				resolveNext({ done: false, value });
				resolveNext = null;
			} else buffered.push(value);
		},
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (buffered.length) return Promise.resolve({ done: false, value: buffered.shift() });
					if (closed) return Promise.resolve({ done: true, value: undefined });
					return new Promise((resolve) => (resolveNext = resolve));
				},
				return() {
					stats.returnCalls++;
					close();
					return onReturn ? onReturn() : Promise.resolve({ done: true, value: undefined });
				},
			};
		},
	};
	if (withEnd) {
		stream.end = () => {
			stats.endCalls++;
			close();
			return end?.();
		};
	}
	return stream;
}

function addNotes(subscribe, extra = {}) {
	addCustomResource({
		uriTemplate: 'notes:///{id}',
		name: 'note',
		profile: 'application',
		read: async () => 'x',
		subscribe,
		...extra,
	});
}

function collectUnhandledRejections() {
	const reasons = [];
	const listener = (reason) => reasons.push(reason);
	process.on('unhandledRejection', listener);
	return { reasons, stop: () => process.off('unhandledRejection', listener) };
}

describe('mcp custom resources/subscribe (#3250)', () => {
	afterEach(() => {
		clearProfileCustomResources('application');
	});

	it('runs the declared subscribe with template params, the session user and profile, in a user-carrying transaction', async () => {
		let seen;
		const stream = makeStream();
		addNotes(async (params, context) => {
			const store = contextStorage.getStore();
			seen = { params, context, ambientUser: store?.user, inTransaction: !!store?.transaction };
			return stream;
		});
		const subscription = await subscribeToResource('notes:///n1', USER, 'application');
		assert.ok(subscription, 'subscribable');
		assert.deepEqual(seen.params, { id: 'n1' });
		assert.equal(seen.context.user, USER);
		assert.equal(seen.context.profile, 'application');
		assert.equal(seen.ambientUser, USER, 'the method runs under the session user');
		assert.equal(seen.inTransaction, true);
		subscription.stop();
	});

	it('delivers once per value only after start, treating values as opaque', async () => {
		const stream = makeStream();
		addNotes(async () => stream);
		const subscription = await subscribeToResource('notes:///n1', USER, 'application');
		let acknowledged = false;
		stream.push({ acknowledge: () => (acknowledged = true) });
		await turn();
		let updates = 0;
		subscription.start(() => updates++);
		await waitFor(() => updates === 1);
		stream.push({ acknowledge: 'queued' });
		stream.push(null);
		await waitFor(() => updates === 3);
		assert.equal(acknowledged, false, 'a custom value is not acknowledged like an audit-log event');
		subscription.stop();
		subscription.stop();
		assert.equal(stream.stats.endCalls, 1, 'end() once, however often stop runs');
		assert.equal(stream.stats.returnCalls, 0, 'end() is preferred over return()');
	});

	it('resolves the same entry a read does: a fixed URI wins over a matching template', async () => {
		const calls = [];
		addCustomResource({
			uri: 'notes:///special',
			name: 'special',
			profile: 'application',
			read: async () => 'x',
			subscribe: async () => (calls.push('fixed'), makeStream()),
		});
		addNotes(async () => (calls.push('template'), makeStream()));
		(await subscribeToResource('notes:///special', USER, 'application')).stop();
		(await subscribeToResource('notes:///other', USER, 'application')).stop();
		assert.deepEqual(calls, ['fixed', 'template']);
	});

	it('is not subscribable without subscribe, with a non-iterable result, or on another profile', async () => {
		addCustomResource({ uri: 'plain:///readme', name: 'readme', profile: 'application', read: async () => 'x' });
		addNotes(async () => ({ not: 'iterable' }));
		assert.equal(await subscribeToResource('plain:///readme', USER, 'application'), null);
		assert.equal(await subscribeToResource('notes:///n1', USER, 'application'), null);
		assert.equal(await subscribeToResource('notes:///n1', USER, 'operations'), null);
	});

	it('releases a return-only stream through its iterator, while idle and before start', async () => {
		const idle = makeStream({ withEnd: false });
		addNotes(async () => idle);
		const started = await subscribeToResource('notes:///n1', USER, 'application');
		let updates = 0;
		started.start(() => updates++);
		await turn();
		started.stop();
		assert.equal(idle.stats.returnCalls, 1, 'the pending next() is released without another event');
		idle.push('late');
		await turn();
		assert.equal(updates, 0);

		const unstarted = makeStream({ withEnd: false });
		clearProfileCustomResources('application');
		addNotes(async () => unstarted);
		(await subscribeToResource('notes:///n1', USER, 'application')).stop();
		assert.equal(unstarted.stats.returnCalls, 1);
	});

	it('releases the stream when iteration fails', async () => {
		const failing = makeStream();
		failing[Symbol.asyncIterator] = () => ({ next: () => Promise.reject(new Error('source lost')) });
		addNotes(async () => failing);
		const subscription = await subscribeToResource('notes:///n1', USER, 'application');
		let stopped = false;
		subscription.onStop(() => (stopped = true));
		subscription.start(() => {});
		await waitFor(() => failing.stats.endCalls === 1);
		assert.equal(stopped, true, 'onStop runs when the stream ends itself');
		let lateCallback = false;
		subscription.onStop(() => (lateCallback = true));
		assert.equal(lateCallback, true, 'onStop after stop runs at once');
	});

	it('fails the subscribe, releasing the stream, when it cannot produce an iterator', async () => {
		const unstartable = makeStream();
		unstartable[Symbol.asyncIterator] = () => {
			throw new Error('no iterator');
		};
		addNotes(async () => unstartable);
		await assert.rejects(subscribeToResource('notes:///n1', USER, 'application'), /no iterator/);
		assert.equal(unstartable.stats.endCalls, 1);
	});

	it('releases a stream whose subscribe transaction fails to commit', async () => {
		const stream = makeStream();
		addNotes(async () => {
			contextStorage.getStore().transaction.commit = () => Promise.reject(new Error('commit failed'));
			return stream;
		});
		await assert.rejects(subscribeToResource('notes:///n1', USER, 'application'), /commit failed/);
		assert.equal(stream.stats.endCalls, 1);
	});

	it('contains a release that throws or rejects, whatever the rejection value', async () => {
		const rejections = collectUnhandledRejections();
		try {
			const rejectingEnd = makeStream({ end: () => Promise.reject(null) });
			const throwingEnd = makeStream({
				end: () => {
					throw new Error('end threw');
				},
			});
			const rejectingReturn = makeStream({ withEnd: false, onReturn: () => Promise.reject(null) });
			for (const stream of [rejectingEnd, throwingEnd, rejectingReturn]) {
				clearProfileCustomResources('application');
				addNotes(async () => stream);
				const subscription = await subscribeToResource('notes:///n1', USER, 'application');
				subscription.start(() => {});
				await turn();
				subscription.stop();
			}
			for (let i = 0; i < 5; i++) await turn();
			assert.deepEqual(rejections.reasons, []);
			assert.equal(rejectingEnd.stats.endCalls, 1);
			assert.equal(throwingEnd.stats.endCalls, 1);
			assert.equal(rejectingReturn.stats.returnCalls, 1);
		} finally {
			rejections.stop();
		}
	});

	it('lets an author error propagate, acquiring nothing', async () => {
		addNotes(async () => {
			throw new Error('no such note');
		});
		await assert.rejects(subscribeToResource('notes:///n1', USER, 'application'), /no such note/);
	});

	describe('identity lifetime', () => {
		it('registers a named principal and unregisters on stop; an anonymous one is not registered', async () => {
			const before = _liveSubscriptionCount();
			addNotes(async () => makeStream());
			const named = await subscribeToResource('notes:///n1', USER, 'application');
			assert.equal(_liveSubscriptionCount(), before + 1);
			named.stop();
			assert.equal(_liveSubscriptionCount(), before);
			const anonymous = await subscribeToResource('notes:///n1', { username: '' }, 'application');
			assert.equal(_liveSubscriptionCount(), before);
			anonymous.stop();
		});

		it('refuses a subscription whose bearer token expired before admission, and releases it', async () => {
			const before = _liveSubscriptionCount();
			const stream = makeStream();
			addNotes(async () => stream);
			const expired = { ...USER, authExpiresAt: Math.floor(Date.now() / 1000) - 10 };
			await assert.rejects(subscribeToResource('notes:///n1', expired, 'application'), AccessViolation);
			assert.equal(stream.stats.endCalls, 1);
			assert.equal(_liveSubscriptionCount(), before);
		});

		it('ends the stream when the bearer token expires', async () => {
			const stream = makeStream();
			addNotes(async () => stream);
			const expiring = { ...USER, authExpiresAt: Math.floor(Date.now() / 1000) + 1 };
			const subscription = await subscribeToResource('notes:///n1', expiring, 'application');
			subscription.start(() => {});
			await waitFor(() => stream.stats.endCalls === 1, 5000);
		});

		describe('against hdb_user', () => {
			before(async () => {
				testUtils.setupTestDBPath();
				setMainIsWorker(true);
				await testUtils.ensureSystemTables();
			});
			afterEach(() => testUtils.seedUsers());

			const role = { id: 'mcp_sub_role', role: 'mcp_sub_role', permission: { super_user: false } };

			it('ends the stream when its user is removed', async () => {
				await testUtils.seedUsers([{ username: 'mcp_sub_gone', active: true, role }]);
				const user = await findAndValidateUser('mcp_sub_gone', undefined, false);
				const stream = makeStream();
				addNotes(async () => stream);
				const subscription = await subscribeToResource('notes:///n1', user, 'application');
				subscription.start(() => {});
				await testUtils.seedUsers();
				await waitFor(() => stream.stats.endCalls === 1, 5000);
			});

			it('keeps a scoped token, which is never re-resolved against hdb_user', async () => {
				const stream = makeStream();
				addNotes(async () => stream);
				const scoped = { username: 'mcp_sub_scoped', _scopedToken: true, role };
				const subscription = await subscribeToResource('notes:///n1', scoped, 'application');
				subscription.start(() => {});
				await _notifyUserChange({ usernames: new Set(['mcp_sub_scoped']), roleIds: new Set() });
				await turn();
				assert.equal(stream.stats.endCalls, 0);
				subscription.stop();
			});
		});
	});
});
