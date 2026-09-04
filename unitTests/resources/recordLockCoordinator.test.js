const assert = require('assert');
const {
	LockCoordinator,
	LOCK_LEASE_SKEW_MS,
	decodeLockControlPayload,
	encodeLockControlPayload,
} = require('#src/resources/recordLockCoordinator');
const { MAX_LOCK_LEASE_MS } = require('#src/resources/recordLock');

// Cluster record locks (harper#483 Phase 1): the Ricart-Agrawala state machine, driven by three
// coordinators over an in-process transport with controllable delay, reordering, replay and node
// death. No database is involved — the coordinator is pure, with every clock injected.
//
// The invariant under test throughout: for one key, at most one node considers itself the holder at
// any instant, and a holder's own lease elapses before any participant treats the hold as over.

const KEY = 'record-1';
const LEASE = 30_000;
const WAIT = 30_000;

/** A three-node cluster of coordinators exchanging control entries in memory. */
class FakeCluster {
	constructor(nodeNames, options = {}) {
		this.wall = 1_700_000_000_000;
		this.mono = 0;
		this.tsCounter = 0;
		this.inFlight = [];
		this.delivered = [];
		this.deliveryDelay = options.deliveryDelay ?? 0;
		this.skewMs = options.skewMs ?? LOCK_LEASE_SKEW_MS;
		this.nodes = new Map();
		for (const name of nodeNames) this.#addNode(name, options);
	}

	#addNode(name, options) {
		const node = {
			name,
			alive: true,
			owns: true,
			capable: true,
			downSince: null,
			/** Control entries this node wrote, in order. */
			written: [],
			/** Entries this node applied, for replay assertions. */
			applied: [],
		};
		node.coordinator = new LockCoordinator({
			database: 'test',
			table: 'LockTest',
			nodeId: name,
			transport: {
				participants: () => this.participants(),
				ownsCoordination: () => node.owns,
			},
			writeControl: (entry) => {
				if (!node.alive) return Promise.resolve();
				node.written.push(entry);
				this.#broadcast(name, entry);
				return Promise.resolve();
			},
			keyIdOf: (key) => String(key),
			nextTimestamp: () => node.forcedTs ?? this.wall + ++this.tsCounter * 0.001,
			now: () => this.wall,
			monotonic: () => this.mono,
			skewMs: options.skewMs,
			autoTick: false,
		});
		this.nodes.set(name, node);
		return node;
	}

	node(name) {
		return this.nodes.get(name);
	}

	participants() {
		return [...this.nodes.values()].map((node) => ({
			nodeId: node.name,
			capable: node.capable,
			downSince: node.downSince,
		}));
	}

	#broadcast(from, entry) {
		for (const node of this.nodes.values()) {
			if (node.name === from) continue;
			this.inFlight.push({ to: node.name, from, entry, deliverAt: this.mono + this.deliveryDelay });
		}
	}

	/** Deliver every entry whose delay has elapsed, honoring a per-node `alive` flag. */
	#deliver() {
		const ready = this.inFlight.filter((message) => message.deliverAt <= this.mono);
		this.inFlight = this.inFlight.filter((message) => message.deliverAt > this.mono);
		for (const message of ready) {
			const node = this.nodes.get(message.to);
			if (!node?.alive) continue;
			node.applied.push(message);
			node.coordinator.applyEntry(message.entry, message.from);
		}
	}

	/** Re-apply everything a node has already seen; the protocol must be idempotent under replay. */
	replayTo(name) {
		const node = this.nodes.get(name);
		for (const message of [...node.applied]) node.coordinator.applyEntry(message.entry, message.from);
	}

	tick() {
		for (const node of this.nodes.values()) if (node.alive) node.coordinator.tick();
	}

	/** Advance both clocks together, delivering and ticking along the way, then drain microtasks. */
	async advance(ms, step = 25) {
		for (let elapsed = 0; elapsed < ms; elapsed += step) {
			const delta = Math.min(step, ms - elapsed);
			this.mono += delta;
			this.wall += delta;
			this.#deliver();
			this.tick();
			await settle();
		}
	}

	/** Let queued deliveries and promise callbacks run without moving the clock. */
	async flush(rounds = 4) {
		for (let i = 0; i < rounds; i++) {
			this.#deliver();
			this.tick();
			await settle();
		}
	}

	acquire(name, key = KEY, lease = LEASE, wait = WAIT) {
		return track(this.nodes.get(name).coordinator.acquire(key, lease, wait));
	}

	release(name, key = KEY) {
		return this.nodes.get(name).coordinator.release(key);
	}

	/** Control entries of one type written by a node. */
	writtenOfType(name, type) {
		return this.nodes.get(name).written.filter((entry) => entry.type === type);
	}
}

function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Wrap a promise so its state can be inspected without awaiting it. */
function track(promise) {
	const tracked = promise.then(
		(value) => {
			tracked.state = 'resolved';
			tracked.value = value;
			return value;
		},
		(error) => {
			tracked.state = 'rejected';
			tracked.error = error;
			return undefined;
		}
	);
	tracked.state = 'pending';
	return tracked;
}

describe('Cluster record lock coordinator (harper#483 Phase 1)', () => {
	describe('mutual exclusion', () => {
		it('admits exactly one holder when two nodes request the same key at once', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const first = cluster.acquire('node-a');
			const second = cluster.acquire('node-b');
			await cluster.flush();

			// node-a's request is earlier (its timestamp was minted first), so node-b defers to it.
			assert.strictEqual(first.state, 'resolved', 'the earlier request acquires');
			assert.strictEqual(second.state, 'pending', 'the later request waits for the holder');
			assert.strictEqual(
				cluster.writtenOfType('node-a', 'lockGrant').length,
				0,
				'a holder writes no grant while it holds'
			);

			await cluster.release('node-a');
			await cluster.flush();
			assert.strictEqual(second.state, 'resolved', 'release hands the key to the waiter');
			assert.ok(second.value.tsR > first.value.tsR, 'the second holder stamps later than the first');
		});

		it('fails without the holder deferral: a forged grant from the holder admits a second holder', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const first = cluster.acquire('node-a');
			const second = cluster.acquire('node-b');
			await cluster.flush();
			assert.strictEqual(first.state, 'resolved');
			assert.strictEqual(second.state, 'pending');

			// Supply exactly what a holder that did NOT defer would have written. Nothing else changes.
			const request = cluster.writtenOfType('node-b', 'lockRequest')[0];
			cluster
				.node('node-b')
				.coordinator.applyEntry(
					{ type: 'lockGrant', key: KEY, requester: 'node-b', tsR: request.tsR, grantor: 'node-a' },
					'node-a'
				);
			await cluster.flush();
			assert.strictEqual(second.state, 'resolved', 'without the deferral both nodes hold the same key');
		});

		it('breaks a timestamp tie by node name, consistently on every node', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const tie = cluster.wall + 5;
			cluster.node('node-a').forcedTs = tie;
			cluster.node('node-b').forcedTs = tie;
			const fromB = cluster.acquire('node-b');
			const fromA = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(fromA.state, 'resolved', 'the lexicographically smaller node name wins the tie');
			assert.strictEqual(fromB.state, 'pending');
		});
	});

	describe('deferral queue', () => {
		it('grants deferred requests in (timestamp, node) order on release', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const holder = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(holder.state, 'resolved');

			const firstWaiter = cluster.acquire('node-b');
			await cluster.flush();
			const secondWaiter = cluster.acquire('node-c');
			await cluster.flush();

			await cluster.release('node-a');
			const grants = cluster.writtenOfType('node-a', 'lockGrant');
			assert.deepStrictEqual(
				grants.map((entry) => entry.requester),
				['node-b', 'node-c'],
				'deferred grants are written oldest request first'
			);
			assert.ok(grants[0].tsR < grants[1].tsR, 'and their timestamps are ascending');
			await cluster.flush();
			assert.strictEqual(firstWaiter.state, 'resolved', 'the earliest deferred requester acquires next');
			assert.strictEqual(secondWaiter.state, 'pending', 'and the next one still waits on it');
		});

		it('withdraws with a release when the wait times out, and hands on what it deferred', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const holder = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(holder.state, 'resolved');

			const waiter = cluster.acquire('node-b', KEY, LEASE, 1_000);
			await cluster.flush();
			// node-c asks after node-b, so node-b defers it while its own request is outstanding.
			const behindWaiter = cluster.acquire('node-c', KEY, LEASE, 20_000);
			await cluster.flush();
			const grantsToC = () =>
				cluster.writtenOfType('node-b', 'lockGrant').filter((entry) => entry.requester === 'node-c');
			assert.strictEqual(grantsToC().length, 0, 'node-b deferred node-c while its own request was outstanding');

			await cluster.advance(1_200);
			assert.strictEqual(waiter.state, 'rejected');
			assert.strictEqual(waiter.error.statusCode, 423);
			assert.strictEqual(
				cluster.writtenOfType('node-b', 'lockRelease').length,
				1,
				'a timed-out wait writes the release that withdraws its request'
			);
			assert.strictEqual(grantsToC().length, 1, 'and hands out the grant it was deferring');
			assert.strictEqual(behindWaiter.state, 'pending', 'node-c still needs the holder to release');
		});
	});

	describe('leases, crashes and skew', () => {
		it('lets a waiter proceed only after the crashed holder can no longer be holding', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			const holder = cluster.acquire('node-a', KEY, 2_000, 3_000);
			await cluster.flush();
			assert.strictEqual(holder.state, 'resolved');
			const holderTsR = holder.value.tsR;

			const waiter = cluster.acquire('node-b', KEY, 60_000, 120_000);
			await cluster.flush();
			assert.strictEqual(waiter.state, 'pending');

			// node-a stops running: no release, no grants, nothing.
			cluster.node('node-a').alive = false;

			// The holder's own bound is tsR + lease with no margin, and it has passed. The participant's
			// bound is its own observation + max(lease, wait) + skew = 8s, and it has not.
			await cluster.advance(2_500);
			assert.ok(cluster.wall > holderTsR + 2_000, 'the holder-side bound has passed');
			assert.strictEqual(waiter.state, 'pending', 'the participant has not yet expired the hold');

			await cluster.advance(6_000);
			assert.strictEqual(waiter.state, 'resolved', 'once no hold can remain, the missing grant is implied');
		});

		it('refuses a round that completes after its own lease has elapsed', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b'], { deliveryDelay: 900 });
			const late = cluster.acquire('node-a', KEY, 500, 20_000);
			await cluster.advance(2_500);
			assert.strictEqual(late.state, 'rejected', 'a lock granted after its lease is no lock at all');
			assert.strictEqual(late.error.statusCode, 423);
			assert.strictEqual(
				cluster.writtenOfType('node-a', 'lockRelease').length,
				1,
				'and the round is withdrawn so peers do not keep deferring to it'
			);
		});

		it('drops a deferred request whose author crashed before it acquired', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const holder = cluster.acquire('node-a', KEY, 60_000, 120_000);
			await cluster.flush();
			assert.strictEqual(holder.state, 'resolved');

			const doomed = cluster.acquire('node-b', KEY, 2_000, 3_000);
			await cluster.flush();
			assert.strictEqual(doomed.state, 'pending');
			assert.strictEqual(cluster.node('node-a').coordinator.stats.deferred, 1, 'the holder is deferring node-b');

			cluster.node('node-b').alive = false; // crashes without ever writing its withdraw

			await cluster.advance(3_000 + LOCK_LEASE_SKEW_MS + 500);
			assert.strictEqual(
				cluster.node('node-a').coordinator.stats.deferred,
				0,
				'the abandoned request stops being owed a grant'
			);
			assert.strictEqual(
				cluster.writtenOfType('node-a', 'lockGrant').length,
				0,
				'and no grant is written to a node that withdrew by expiry'
			);
		});
	});

	describe('membership', () => {
		it('fails closed with a retryable 503 when a peer cannot take part', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			cluster.node('node-b').capable = false;
			const attempt = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(attempt.state, 'rejected');
			assert.strictEqual(attempt.error.statusCode, 503);
			assert.strictEqual(attempt.error.code, 'LOCK_UNAVAILABLE');
			assert.strictEqual(attempt.error.retryable, true);
			assert.strictEqual(cluster.node('node-a').written.length, 0, 'and nothing is written');
		});

		it('excludes a node only once it has been down longer than any hold could last', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			cluster.node('node-b').alive = false;
			cluster.node('node-b').downSince = cluster.wall - 1_000;
			const blocked = cluster.acquire('node-a', KEY, 60_000, 3_000);
			await cluster.advance(3_500);
			assert.strictEqual(blocked.state, 'rejected', 'a recently-down peer still has to grant');
			assert.strictEqual(blocked.error.statusCode, 423);

			cluster.node('node-b').downSince = cluster.wall - (MAX_LOCK_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const allowed = cluster.acquire('node-a', 'record-2', 60_000, 3_000);
			await cluster.flush();
			assert.strictEqual(allowed.state, 'resolved', 'a long-down peer is out of the grant set');
		});

		it('rejects on a worker that does not own lock coordination', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			cluster.node('node-a').owns = false;
			const attempt = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(attempt.state, 'rejected');
			assert.strictEqual(attempt.error.statusCode, 503);
			assert.strictEqual(cluster.node('node-a').written.length, 0);
		});

		it('refuses a node identity that cannot order requests', () => {
			assert.throws(
				() =>
					new LockCoordinator({
						database: 'test',
						table: 'LockTest',
						nodeId: '127.0.0.1',
						transport: { participants: () => [], ownsCoordination: () => true },
						writeControl: () => {},
						keyIdOf: String,
						nextTimestamp: () => 1,
					}),
				/distinctive node name/
			);
		});
	});

	describe('joiners and replay', () => {
		it('cannot break exclusion through a node that joined after the hold started', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			const holder = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(holder.state, 'resolved');

			const waiter = cluster.acquire('node-b');
			await cluster.flush();
			assert.strictEqual(waiter.state, 'pending');

			// A node that comes up now knows the membership but never saw the holder's request, so it
			// grants freely.
			const joiner = new FakeCluster(['node-a', 'node-b', 'node-c']);
			joiner.node('node-c').coordinator.applyEntry(cluster.writtenOfType('node-b', 'lockRequest')[0], 'node-b');
			assert.strictEqual(
				joiner.writtenOfType('node-c', 'lockGrant').length,
				1,
				'the joiner grants, having no reason not to'
			);
			// Safety never depended on the joiner: the holder is still deferring, so node-b cannot complete.
			assert.strictEqual(waiter.state, 'pending');
			assert.strictEqual(cluster.writtenOfType('node-a', 'lockGrant').length, 0);
		});

		it('is idempotent when every entry is replayed', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			const holder = cluster.acquire('node-a');
			await cluster.flush();
			const waiter = cluster.acquire('node-b');
			await cluster.flush();
			const grantsBefore = cluster.writtenOfType('node-c', 'lockGrant').length;

			cluster.replayTo('node-c');
			cluster.replayTo('node-a');
			await cluster.flush();

			assert.strictEqual(
				cluster.writtenOfType('node-c', 'lockGrant').length,
				grantsBefore,
				'a replayed request produces no second grant'
			);
			assert.strictEqual(holder.state, 'resolved');
			assert.strictEqual(waiter.state, 'pending', 'replay does not complete a round that was not complete');

			await cluster.release('node-a');
			await cluster.flush();
			cluster.replayTo('node-b');
			await cluster.flush();
			assert.strictEqual(waiter.state, 'resolved');
			assert.strictEqual(cluster.writtenOfType('node-a', 'lockGrant').length, 1, 'and one grant, not two');
		});

		it('does not treat a cleanly released peer round as a grant when it later expires', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			// node-a takes and cleanly releases the key, leaving node-b holding a released peer record
			// that lingers until its bound so a replayed request cannot resurrect it.
			const firstHold = cluster.acquire('node-a', KEY, 1_000, 1_000);
			await cluster.flush();
			assert.strictEqual(firstHold.state, 'resolved');
			await cluster.release('node-a');
			await cluster.flush();

			// node-b now wants the key and node-a stops answering. Only a crash may imply a grant, and
			// node-a did not crash while holding — it released.
			cluster.node('node-a').alive = false;
			const waiter = cluster.acquire('node-b', KEY, 60_000, 120_000);
			await cluster.flush();
			assert.strictEqual(waiter.state, 'pending');

			await cluster.advance(1_000 + LOCK_LEASE_SKEW_MS + 1_000);
			assert.strictEqual(
				waiter.state,
				'pending',
				'the lingering released record must not complete a round node-a never granted'
			);
		});

		it('ignores a grant whose payload names a grantor other than the node that wrote it', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b', 'node-c']);
			cluster.node('node-b').alive = false; // node-b never answers, so node-a stays pending
			const pending = cluster.acquire('node-a');
			await cluster.flush();
			const request = cluster.writtenOfType('node-a', 'lockRequest')[0];
			// node-c writes a grant claiming to be node-b.
			cluster
				.node('node-a')
				.coordinator.applyEntry(
					{ type: 'lockGrant', key: KEY, requester: 'node-a', tsR: request.tsR, grantor: 'node-b' },
					'node-c'
				);
			await cluster.flush();
			assert.strictEqual(pending.state, 'pending', 'a node cannot grant on another node’s behalf');
		});

		it('does not let released rounds crowd out live contenders on a hot key', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			// A hot key turns over far more rounds inside one bound than the per-key cap. Released rounds
			// linger only for replay protection, so counting them would make node-a stop granting.
			const grantsBefore = cluster.writtenOfType('node-a', 'lockGrant').length;
			for (let round = 0; round < 90; round++) {
				const held = cluster.acquire('node-b', KEY, 60_000, 60_000);
				await cluster.flush(2);
				assert.strictEqual(held.state, 'resolved', `round ${round} acquired`);
				await cluster.release('node-b');
				await cluster.flush(2);
			}
			assert.strictEqual(
				cluster.writtenOfType('node-a', 'lockGrant').length - grantsBefore,
				90,
				'every live request was granted'
			);
		});

		it('does not let released keys crowd out live ones across the table', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			// Same rule as the per-key cap, applied table-wide: a key whose only remaining state is
			// released rounds must give up its slot rather than block a fresh key.
			for (let key = 0; key < 10_050; key++) {
				cluster.node('node-a').coordinator.applyEntry(
					{
						type: 'lockRequest',
						key: `hot-${key}`,
						requester: 'node-b',
						tsR: cluster.wall + key * 0.001,
						leaseMs: 60_000,
						waitMs: 60_000,
					},
					'node-b'
				);
				cluster
					.node('node-a')
					.coordinator.applyEntry(
						{ type: 'lockRelease', key: `hot-${key}`, requester: 'node-b', tsR: cluster.wall + key * 0.001 },
						'node-b'
					);
			}
			const grantsBefore = cluster.writtenOfType('node-a', 'lockGrant').length;
			cluster.node('node-a').coordinator.applyEntry(
				{
					type: 'lockRequest',
					key: 'the-live-one',
					requester: 'node-b',
					tsR: cluster.wall + 20,
					leaseMs: 60_000,
					waitMs: 60_000,
				},
				'node-b'
			);
			assert.strictEqual(
				cluster.writtenOfType('node-a', 'lockGrant').length,
				grantsBefore + 1,
				'a fresh key is still granted after the table filled with released ones'
			);
		});

		it('ignores a request replayed from beyond any live hold', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			cluster.node('node-a').coordinator.applyEntry(
				{
					type: 'lockRequest',
					key: KEY,
					requester: 'node-b',
					tsR: cluster.wall - (MAX_LOCK_LEASE_MS + WAIT + LOCK_LEASE_SKEW_MS + 1_000),
					leaseMs: LEASE,
					waitMs: WAIT,
				},
				'node-b'
			);
			assert.strictEqual(cluster.node('node-a').written.length, 0, 'no grant for a request nothing can be waiting on');
		});
	});

	describe('containment and lifecycle', () => {
		it('does not let a failing control write escape the tick or the round', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			const holder = cluster.acquire('node-a', KEY, 60_000, 1_000);
			await cluster.flush();
			assert.strictEqual(holder.state, 'resolved');

			// The audit store goes away underneath: every later control write fails.
			cluster.node('node-a').coordinator.transport.participants = () => cluster.participants();
			const failing = cluster.node('node-a');
			const original = failing.written;
			let rejections = 0;
			const onRejection = () => rejections++;
			process.on('unhandledRejection', onRejection);
			try {
				failing.written = {
					push() {
						throw new Error('audit store is closing');
					},
					filter: () => [],
				};
				const released = cluster.node('node-a').coordinator.release(KEY);
				await settle();
				await cluster.advance(200);
				assert.strictEqual(rejections, 0, 'a failed release neither throws nor rejects unhandled');
				await Promise.resolve(released);
			} finally {
				process.off('unhandledRejection', onRejection);
				failing.written = original;
			}
		});

		it('keeps failing closed after a registered transport goes away', () => {
			const {
				registerClusterLockTransport,
				unregisterClusterLockTransport,
				isClusterLockRequired,
			} = require('#src/resources/recordLockCoordinator');
			const database = `lifecycle-${Date.now()}`;
			assert.strictEqual(isClusterLockRequired(database), false);
			registerClusterLockTransport(database, { participants: () => [], ownsCoordination: () => true });
			assert.strictEqual(isClusterLockRequired(database), true);
			unregisterClusterLockTransport(database);
			assert.strictEqual(
				isClusterLockRequired(database),
				true,
				'a transport that disappeared is not proof the database became standalone'
			);
			unregisterClusterLockTransport(database, true);
			assert.strictEqual(isClusterLockRequired(database), false, 'only an explicit standalone claim clears it');
		});

		it('refuses a participant set in which two nodes share an identity', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			cluster.node('node-b').name = 'node-a';
			const attempt = cluster.acquire('node-a');
			await cluster.flush();
			assert.strictEqual(attempt.state, 'rejected');
			assert.strictEqual(attempt.error.statusCode, 503);
			assert.match(attempt.error.message, /both identify as/);
		});

		it('ignores a control entry from a node that is not a participant', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			cluster.node('node-a').coordinator.applyEntry(
				{
					type: 'lockRequest',
					key: KEY,
					requester: 'node-from-another-cluster',
					tsR: cluster.wall,
					leaseMs: LEASE,
					waitMs: WAIT,
				},
				'node-from-another-cluster'
			);
			assert.strictEqual(cluster.node('node-a').written.length, 0);
			assert.strictEqual(cluster.node('node-a').coordinator.stats.deferred, 0);
		});
	});

	describe('lease anchoring', () => {
		const { makeKeyLockHandle } = require('#src/resources/recordLock');
		const fakeStore = () => ({ unlock() {}, getMonotonicTimestamp: () => Date.now() });

		it('measures a granted lease monotonically, so a backward wall-clock step cannot extend it', async () => {
			const handle = makeKeyLockHandle(fakeStore(), ['k'], 'k', 60_000, true, Date.now());
			// tsR comes from a never-decreasing source, so after the wall clock steps BACK it is ahead of
			// Date.now(). Deriving the remaining lease from `tsR + leaseMs - Date.now()` would hand back
			// the full lease plus the step, past what every peer bounded from its own observation.
			const mintedMono = performance.now();
			const tsRAfterBackwardStep = Date.now() + 10_000;
			assert.strictEqual(
				handle.joinClusterRound(tsRAfterBackwardStep, 200, mintedMono, () => {}),
				true
			);
			assert.strictEqual(handle.isLeaseExpired(), false, 'the lease is live immediately after the round');
			await new Promise((resolve) => setTimeout(resolve, 350));
			assert.strictEqual(handle.isLeaseExpired(), true, 'and lapses 200ms later, not 10.2s later');
		});

		it('reports lease expiry after a deliberate release when the lease timer ran late', () => {
			const handle = makeKeyLockHandle(fakeStore(), ['k'], 'k', 150, true, Date.now());
			// Peg the event loop past the deadline, which is exactly what a replication catch-up burst
			// does, so the lease timer provably has not run.
			const until = performance.now() + 250;
			while (performance.now() < until) {} // eslint-disable-line no-empty
			assert.strictEqual(handle.expired, false, 'the lease timer has not run');
			handle.release();
			assert.strictEqual(
				handle.isLeaseExpired(),
				true,
				'giving the lock up deliberately does not make a lapsed lease valid again'
			);
		});

		it('refuses a round whose lease already elapsed in monotonic terms', () => {
			const handle = makeKeyLockHandle(fakeStore(), ['k'], 'k', 60_000, true, Date.now());
			assert.strictEqual(
				handle.joinClusterRound(Date.now(), 100, performance.now() - 500, () => {}),
				false
			);
		});
	});

	describe('payload validation', () => {
		it('round-trips each control entry, decoded by a codec that has never seen the writer', () => {
			const { Unpackr } = require('msgpackr');
			for (const entry of [
				{ type: 'lockRequest', key: [1, 'a'], requester: 'node-a', tsR: 5, leaseMs: LEASE, waitMs: WAIT },
				{ type: 'lockGrant', key: 'k', requester: 'node-a', tsR: 5, grantor: 'node-b' },
				{ type: 'lockRelease', key: 7, requester: 'node-a', tsR: 5 },
			]) {
				// A fresh codec with its own (empty) structure dictionary: the payload must not depend on
				// any structure the writing table happened to have.
				const reader = new Unpackr({ structures: [] });
				const decoded = decodeLockControlPayload(entry.type, reader.unpack(encodeLockControlPayload(entry)));
				assert.deepStrictEqual(decoded, entry);
			}
		});

		it('survives a decoder whose structure dictionary is populated, for every record key shape', () => {
			const { Unpackr } = require('msgpackr');
			// The receiving side decodes with the TABLE's decoder, which repurposes a range of positive
			// fixints as structure ids. Integer record keys land in that range.
			const structures = [];
			for (let i = 0; i < 80; i++) structures.push([`a${i}`, `b${i}`]);
			const tableDecoder = new Unpackr({ structures, useRecords: true });
			for (const key of [0, 31, 32, 63, 64, 100, 127, 128, 4096, -5, 'k', [64, 'a'], 1.5, true, null]) {
				const entry = { type: 'lockRequest', key, requester: 'node-a', tsR: 5, leaseMs: LEASE, waitMs: WAIT };
				const decoded = decodeLockControlPayload(entry.type, tableDecoder.unpack(encodeLockControlPayload(entry)));
				assert.deepStrictEqual(decoded, entry, `record key ${JSON.stringify(key)} round-trips`);
			}
		});

		it('accepts every record-id shape the key encoder does', () => {
			const { toBufferKey } = require('ordered-binary');
			// The decoder's key check has to match what keyIdOf can actually encode: too strict drops a
			// legitimate lock (a bigint or binary id), too loose throws into the replicated apply loop.
			for (const key of [1, 1n, 2n ** 70n, 'k', true, null, new Uint8Array([1, 2]), [1n, 'k', null]]) {
				assert.doesNotThrow(() => toBufferKey(key), `${String(key)} is encodable`);
				assert.ok(
					decodeLockControlPayload('lockRelease', [key, 'node-a', 5]),
					`${String(key)} is accepted by the decoder`
				);
			}
		});

		it('rejects malformed and spoofed payloads without touching coordinator state', async () => {
			const cluster = new FakeCluster(['node-a', 'node-b']);
			const bad = [
				['lockRequest', null],
				['lockRequest', ['k', 'node-b', 5]],
				['lockRequest', ['k', 'node-b', NaN, LEASE, WAIT]],
				['lockRequest', ['k', '', 5, LEASE, WAIT]],
				['lockRequest', ['k', 'node-b', 5, Number.MAX_SAFE_INTEGER, WAIT]],
				['lockRequest', ['k', 'node-b', 5, LEASE, -1]],
				['lockGrant', ['k', 'node-b', 5]],
				['lockGrant', ['k', 'node-b', 5, 42]],
				['lockRelease', ['k', 'node-b', 5, 'extra']],
				['lockRelease', [undefined, 'node-b', 5]],
				// Shapes the record-id encoder cannot serialize, which would throw out of keyIdOf.
				['lockRelease', [{ not: 'a key' }, 'node-b', 5]],
				['lockRelease', [new Date(0), 'node-b', 5]],
				['lockRelease', [['ok', { nested: 1 }], 'node-b', 5]],
				['somethingElse', ['k', 'node-b', 5]],
			];
			for (const [type, value] of bad)
				assert.strictEqual(decodeLockControlPayload(type, value), undefined, `${type} ${JSON.stringify(value)}`);

			// A grant from a node that was never in the grant set must not complete a round.
			cluster.node('node-b').alive = false; // node-b never answers, so node-a stays pending
			const pending = cluster.acquire('node-a');
			await cluster.flush();
			const request = cluster.writtenOfType('node-a', 'lockRequest')[0];
			cluster
				.node('node-a')
				.coordinator.applyEntry(
					{ type: 'lockGrant', key: KEY, requester: 'node-a', tsR: request.tsR, grantor: 'node-not-in-the-cluster' },
					'node-not-in-the-cluster'
				);
			await cluster.flush();
			assert.strictEqual(pending.state, 'pending', 'an uncorrelated grant does not complete the round');
			assert.strictEqual(cluster.node('node-a').coordinator.stats.held, 0);
		});
	});
});
