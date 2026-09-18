const assert = require('assert');
const {
	LockCoordinator,
	LOCK_LEASE_SKEW_MS,
	DELEGATION_LEASE_MS,
	RECALL_RETRY_MS,
	compareTokens,
	decodeLockControlPayload,
	encodeLockControlPayload,
	homeFor,
	quiesceDelegations,
	ringKeyFor,
	acquireForRelay,
	releaseForRelay,
	revokeRelayedAdmission,
	fenceRelayedAdmissions,
	setLockCoordinatorResolver,
} = require('#src/resources/recordLockCoordinator');
const { MAX_LOCK_LEASE_MS, MIN_LOCK_LEASE_MS, makeKeyLockHandle } = require('#src/resources/recordLock');
const { toBufferKey } = require('ordered-binary');
const { waitFor } = require('../waitFor');

/** A real lock handle over a fake store, so revocation is tested through production code. */
function realHandle(lease = LEASE) {
	const unlocked = [];
	let mono = 1;
	const store = { unlock: (key) => unlocked.push(key), getMonotonicTimestamp: () => mono++ };
	const handle = makeKeyLockHandle(store, ['k'], 'k', lease, true);
	return { handle, unlocked };
}

/**
 * A single-node coordinator on a fixed injected clock, with NO `grantableAfterMono` override — so it
 * runs the production §4.3 default, whose horizon is measured from construction — so an injected
 * clock is what makes it assertable without depending on the suite's own uptime.
 */
let coldSequence = 0;
function coldCoordinator(monotonic, options = {}) {
	const sequence = ++coldSequence;
	return new LockCoordinator({
		// Its own database unless the caller names one: the generation rollback floor is per database.
		database: options.database ?? `cold${sequence}`,
		table: options.table ?? `ColdStart${sequence}`,
		adopt: options.adopt,
		nodeId: 'alpha',
		transport: {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => true,
			establishLockFreshness:
				options.establishLockFreshness ?? (async (_database, _table, _key, dependencies) => dependencies ?? []),
			requestDelegation: () => {
				throw new Error('a single-node home must not send a request');
			},
			recallDelegation: () => {
				throw new Error('a single-node home must not send a recall');
			},
		},
		writeControl: () => {},
		keyIdOf: (key) => String(key),
		nextTimestamp: () => 1,
		monotonic,
		grantableAfterMono: options.grantableAfterMono,
		autoTick: false,
	});
}

// Cluster record locks (harper#483 Phase 1): amortized per-record ownership, driven by a set of
// coordinators over an in-process transport with controllable delay, denial, replay and node death.
// No database is involved — the coordinator is pure, with every clock injected.
//
// Every node has its OWN monotonic clock, advanced independently. A single shared fake clock cannot
// express the property the design rests on — that a home outwaits its delegate by skew measured on
// two different clocks — so it would silently pass a coordinator that compared a remote reading
// against a local one. `docs/record-lock-ownership.md` §12 calls for exactly this.
//
// The invariant under test throughout: for one key, at most one node may admit a critical section at
// any instant, and a delegate stops admitting before its home will re-grant.

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LEASE = 30_000;
const WAIT = 30_000;

/** A cluster of coordinators exchanging delegation messages in memory. */
let clusterSequence = 0;

class FakeCluster {
	constructor(nodeNames, options = {}) {
		this.tsCounter = 0;
		this.skewMs = options.skewMs ?? LOCK_LEASE_SKEW_MS;
		// A distinct table per cluster, because module-level coordinator state — the bound a closed
		// coordinator leaves its replacement — is correctly keyed by (database, table). One shared name
		// would let one test's closed coordinator quarantine every later test's grants.
		this.table = `LockTest${++clusterSequence}`;
		// Its own database too: the generation rollback floor is per database, and tests move
		// generations in both directions, so a shared name would leak one test's floor into the next.
		this.database = `test${clusterSequence}`;
		this.generation = options.generation ?? 1;
		this.homes = [...nodeNames];
		this.nodes = new Map();
		/** Every delegation request that crossed the wire, for message-count assertions. */
		this.requests = [];
		this.recalls = [];
		for (const name of nodeNames) this.#addNode(name, options);
	}

	#addNode(name, options) {
		const node = {
			name,
			alive: true,
			owns: true,
			/**
			 * This node's OWN monotonic offset, advanced independently of every other node's. Real
			 * elapsed time is added on read so a retry loop inside the coordinator actually terminates;
			 * the offset is what lets a test move one node's clock without moving another's.
			 *
			 * The real component is `performance.now()` and NOT a delta from cluster construction,
			 * because `KeyLockHandle.joinClusterRound` measures a round's remaining lease as
			 * `leaseMs - (performance.now() - mintedMono)`. On a construction-based origin the two
			 * clocks disagree by however long the process has been up, so a test driving a real handle
			 * passed only while that was under one lease — in a full-suite run every round looked
			 * already expired and `joinClusterRound` silently returned false.
			 */
			mono: 0,
			/**
			 * Bumped to simulate a restart of this node in its role as a home. Settable at construction
			 * because a coordinator that sees the incarnation CHANGE under it reads that as another
			 * coordination incarnation having run and re-arms the §4.3 quarantine — which is the point,
			 * but not what a test about a home that restarted BEFORE this coordinator existed is saying.
			 */
			incarnation: options.incarnations?.[name] ?? 1,
			/** Set by a test to make this node's control-entry writer throw synchronously. */
			writerThrows: false,
			writerCalls: 0,
			writerReturnsVoid: false,
			freshnessCalls: [],
			freshnessError: undefined,
			/** Set to make this node report no agreed home map — a generation change, or a digest mismatch. */
			mapless: false,
			written: [],
		};
		node.coordinator = new LockCoordinator({
			database: this.database,
			table: this.table,
			nodeId: name,
			transport: {
				homeMap: () =>
					node.mapless
						? undefined
						: {
								generation: this.generation,
								homes: [...this.homes],
								homeIncarnation: node.incarnation,
							},
				ownsCoordination: () => node.owns,
				requestDelegation: (target, database, table, request) => this.#deliverRequest(name, target, request),
				recallDelegation: (target, database, table, recall) => this.#deliverRecall(name, target, recall),
				establishLockFreshness: (database, table, key, dependencies, deadlineMs) =>
					this.#establishFreshness(name, database, table, key, dependencies, deadlineMs),
			},
			writeControl: this.writeControlFor(name),
			keyIdOf: (key) => String(key),
			nextTimestamp: () => ++this.tsCounter,
			monotonic: () => node.mono + performance.now(),
			skewMs: options.skewMs,
			// The harness drives an injected clock whose readings say nothing about process start, so the
			// §4.3 restart quarantine is opted into per test rather than inherited from real uptime.
			grantableAfterMono: options.grantableAfterMono ?? -Infinity,
			autoTick: false,
		});
		this.nodes.set(name, node);
		return node;
	}

	node(name) {
		return this.nodes.get(name);
	}

	/**
	 * Writing to the local transaction log IS the send, so a release both lands in this node's `written`
	 * and reaches every peer's apply loop. Shared with `replace()`: a successor coordinator that cannot
	 * write a release would leave every home holding its grant, which is a harness artifact and not
	 * anything the coordinator does.
	 */
	writeControlFor(name) {
		return (entry) => {
			const node = this.node(name);
			// A test sets this to fail the WRITER itself, which is a different containment path from a
			// dead node: `#writeControlSafely` must swallow it, not the transport.
			if (node?.writerThrows) {
				node.writerCalls++;
				throw new Error('transaction log is not accepting control entries');
			}
			if (!node?.alive) return Promise.resolve();
			const position = ++this.tsCounter;
			node.written.push({ ...entry, position });
			this.#broadcastRelease(name, entry, position);
			return Promise.resolve(node.writerReturnsVoid ? undefined : position);
		};
	}

	/** Advance ONE node's clock. Nothing else moves. */
	advance(name, ms) {
		const node = this.node(name);
		node.mono += ms;
		node.coordinator.tick();
	}

	advanceAll(ms) {
		for (const node of this.nodes.values()) {
			node.mono += ms;
			node.coordinator.tick();
		}
	}

	async #deliverRequest(from, to, request) {
		this.requests.push({ from, to, key: request.key });
		const target = this.node(to);
		if (!target || !target.alive) throw new Error(`${to} is unreachable`);
		const reply = await target.coordinator.onDelegationRequest(request);
		// Lets a test act while the requester is still awaiting this reply — the window a component
		// reload lands in.
		await this.beforeReply?.(from, to, request, reply);
		return reply;
	}

	async #deliverRecall(from, to, recall) {
		this.recalls.push({ from, to, key: recall.key, token: recall.token });
		const target = this.node(to);
		if (!target || !target.alive) throw new Error(`${to} is unreachable`);
		return target.coordinator.onDelegationRecall(recall);
	}

	async #establishFreshness(name, database, table, key, dependencies, deadlineMs) {
		const node = this.node(name);
		node.freshnessCalls.push({ database, table, key, dependencies, deadlineMs });
		if (this.beforeFreshness) await this.beforeFreshness(name, key, dependencies);
		if (node.freshnessError) throw node.freshnessError;
		return dependencies === null ? this.homes.map((origin) => [origin, 0]) : undefined;
	}

	/** A release entry replicates to every node, as a transaction-log entry does. */
	#broadcastRelease(author, entry, position) {
		for (const [name, node] of this.nodes) {
			if (name === author || !node.alive) continue;
			node.coordinator.applyEntry(entry, author, position);
		}
	}

	/** The node that homes this key under the current membership. */
	homeOf(key) {
		// The coordinator hashes database ‖ table ‖ key (§4.4); the harness must scope it identically
		// or every keyHomedOn() would pick a different node than the coordinator does.
		return homeFor(ringKeyFor(this.database, this.table, key), this.homes);
	}

	/** A key homed on the given node, found by search so tests never hardcode a hash result. */
	keyHomedOn(name, prefix = 'k') {
		for (let i = 0; i < 10_000; i++) {
			const key = `${prefix}${i}`;
			if (this.homeOf(key) === name) return key;
		}
		throw new Error(`no key in the first 10000 homes on ${name}`);
	}
}

describe('record lock delegations', () => {
	describe('the home ring', () => {
		it('agrees across nodes and is stable for a fixed membership', () => {
			const members = ['alpha', 'beta', 'gamma'];
			const shuffled = ['gamma', 'alpha', 'beta'];
			for (let i = 0; i < 200; i++) {
				const key = `key-${i}`;
				// Order of `members` must not change the answer, or two nodes holding the same agreed set
				// in different orders would pick different homes for one key.
				assert.strictEqual(homeFor(key, members), homeFor(key, shuffled));
			}
		});

		it('spreads keys across every member', () => {
			const members = ['alpha', 'beta', 'gamma'];
			const counts = new Map(members.map((m) => [m, 0]));
			for (let i = 0; i < 600; i++)
				counts.set(homeFor(`key-${i}`, members), counts.get(homeFor(`key-${i}`, members)) + 1);
			for (const member of members)
				assert.ok(counts.get(member) > 50, `${member} homed only ${counts.get(member)} keys`);
		});

		it('moves only the departing member’s keys when membership shrinks', () => {
			const before = ['alpha', 'beta', 'gamma'];
			const after = ['alpha', 'beta'];
			let moved = 0;
			let homedOnGamma = 0;
			for (let i = 0; i < 600; i++) {
				const key = `key-${i}`;
				const was = homeFor(key, before);
				if (was === 'gamma') homedOnGamma++;
				else if (homeFor(key, after) !== was) moved++;
			}
			// Rendezvous hashing is chosen over a modulo precisely for this: every re-homed key pays the
			// §7.2 recovery path on its next lock, so a membership change must not re-home the world.
			assert.strictEqual(moved, 0);
			assert.ok(homedOnGamma > 50);
		});

		it('returns nothing for an empty member set', () => {
			assert.strictEqual(homeFor('k', []), undefined);
		});
	});

	describe('acquisition', () => {
		it('grants a cold key from its home and admits the caller', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const round = await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			assert.ok(round.tsR > 0);
			assert.strictEqual(cluster.requests.length, 1);
			assert.deepStrictEqual(
				{ from: cluster.requests[0].from, to: cluster.requests[0].to },
				{ from: 'alpha', to: 'beta' }
			);
		});

		it('costs zero cluster messages on a repeat lock — the amortization', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, round.admissionId);
			assert.strictEqual(cluster.requests.length, 1);
			for (let i = 0; i < 25; i++) {
				// Advance between locks. Without this the whole loop runs inside one clock tick, and a
				// delegation sized to the lock's own lease would pass — which is exactly the defect a
				// same-instant loop hid: every repeat lock renewed and paid a round trip.
				cluster.advance('alpha', 1_000);
				const repeat = await alpha.acquire(key, LEASE, WAIT);
				alpha.release(key, repeat.admissionId);
			}
			// This is the whole point of the design: releasing the application lock does not release the
			// delegation, so 26 locks spread over 25 seconds cost one round.
			assert.strictEqual(cluster.requests.length, 1);
			assert.strictEqual(cluster.node('alpha').freshnessCalls.length, 0, 'the cached path ran a freshness barrier');
		});

		it('grants a binary record id homed on a peer', async () => {
			// A `Bytes` primary key is an ordinary record id: `ordered-binary` encodes it and
			// `checkValidId` passes it. Refusing the shape made the home answer `not-home` for a key
			// nobody held, which `acquire` retried every 25 ms to its own 423 — and only for peer-homed
			// keys, because `#grantLocally` never goes through `onDelegationRequest`.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			let key;
			for (let i = 0; !key && i < 10_000; i++) {
				const candidate = new Uint8Array([i & 0xff, i >>> 8]);
				if (cluster.homeOf(candidate) === 'beta') key = candidate;
			}
			assert.ok(key, 'no binary key in the first 10000 homes on beta');
			// A short wait, because the failure this guards is a retry loop that ends in a 423.
			const round = await cluster.node('alpha').coordinator.acquire(key, LEASE, 250);
			assert.ok(round.tsR > 0);
			assert.strictEqual(cluster.requests.length, 1);
		});

		it('needs no message at all when this node is the key’s own home', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('alpha');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, 0);
		});

		it('renews rather than stretching when too little of the lease is left', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, round.admissionId);
			// Close enough to the delegation's end that a fresh full-lease admission no longer fits
			// inside it. An admission that outlived its delegation is exactly what the home's skew margin
			// assumes cannot happen.
			cluster.advance('alpha', DELEGATION_LEASE_MS - LEASE + 1);
			await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, 2);
		});
	});

	describe('exclusion', () => {
		it('never lets two nodes hold a delegation for one key', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			// Beta asks while alpha is still inside its critical section. Beta must run out of wait
			// rather than be admitted alongside alpha.
			await assert.rejects(() => cluster.node('beta').coordinator.acquire(key, LEASE, 200), /not released in time/);
			assert.ok(cluster.recalls.some((r) => r.to === 'alpha'));
			assert.strictEqual(cluster.node('beta').coordinator.stats.delegations, 0);
		});

		it('hands the key over once the predecessor drains and releases', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const alphaRound = await alpha.acquire(key, LEASE, WAIT);
			// Alpha finishes its critical section. The recall arrives, alpha is idle, so it surrenders.
			alpha.release(key, alphaRound.admissionId);
			const beta = cluster.node('beta').coordinator;
			const round = await beta.acquire(key, LEASE, WAIT);
			assert.ok(round.tsR > 0);
			assert.ok(cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'));
		});

		it('drains a live admission before the successor is admitted', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			// Alpha is INSIDE its critical section — it has not released. Beta's acquisition must not
			// resolve while that is true, whatever the home does about the recall.
			let betaAdmitted = false;
			const betaAcquire = cluster
				.node('beta')
				.coordinator.acquire(key, LEASE, 5_000)
				.then(() => {
					betaAdmitted = true;
				});
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(betaAdmitted, false, 'beta was admitted while alpha was still inside');
			assert.ok(
				cluster.recalls.some((r) => r.to === 'alpha'),
				'the home did not recall the holder'
			);
			alpha.release(key, round.admissionId);
			await betaAcquire;
			assert.strictEqual(betaAdmitted, true);
		});

		it('ends a wait the home answered contended as 423, and sends no probe it cannot complete', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			// Beta's backoff reaches its deadline, so any further request would go out with no budget and
			// could only come back as beta's own `timeout`. The stall makes that the outcome if one is
			// sent at all: a wait that watched the key held must not report it unheld.
			let replies = 0;
			cluster.beforeReply = async (from) => {
				if (from !== 'beta') return;
				if (++replies === 1) return cluster.advance('beta', 180);
				cluster.advance('beta', 1_000);
				await new Promise((resolve) => setTimeout(resolve, 50));
			};
			const sent = cluster.requests.length;
			await assert.rejects(
				() => cluster.node('beta').coordinator.acquire(key, LEASE, 200),
				(error) => error.statusCode === 423
			);
			assert.strictEqual(cluster.requests.length, sent + 1, 'a probe went out with no budget to complete in');
		});

		it('ends on the last reply the home completed, so a later not-home is not reported as contention', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			// The home stops owning coordination between beta's two passes. Contention is what beta saw
			// first, but the ring disagreement is the fresher fact and the one the caller has to act on.
			let replies = 0;
			cluster.beforeReply = (from) => {
				if (from !== 'beta') return;
				if (++replies === 1) {
					cluster.node('gamma').owns = false;
					return cluster.advance('beta', 200);
				}
				cluster.advance('beta', 100);
			};
			await assert.rejects(() => cluster.node('beta').coordinator.acquire(key, LEASE, 300), /home answered not-home/);
		});

		it('retires an observation the ring has moved on from, rather than reporting it as contention', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			// A new generation is a new route. What the previous home said about the key describes an
			// arrangement that no longer owns it, so the wait must answer from its own probe.
			let replies = 0;
			cluster.beforeReply = async (from) => {
				if (from !== 'beta') return;
				if (++replies === 1) {
					cluster.generation = 2;
					return cluster.advance('beta', 200);
				}
				cluster.advance('beta', 1_000);
				await new Promise((resolve) => setTimeout(resolve, 200));
			};
			await assert.rejects(() => cluster.node('beta').coordinator.acquire(key, LEASE, 300), /home answered timeout/);
		});
	});

	describe('successor freshness', () => {
		it('waits for the releasing origin before admitting a clean successor', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const held = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, held.admissionId);

			const beta = cluster.node('beta');
			let releaseBarrier;
			cluster.beforeFreshness = (name) =>
				name === 'beta' ? new Promise((resolve) => (releaseBarrier = resolve)) : undefined;
			const acquiring = beta.coordinator.acquire(key, LEASE, WAIT);
			await waitFor(() => beta.freshnessCalls.length === 1);
			assert.strictEqual(beta.coordinator.stats.delegations, 0, 'the successor admitted before the barrier');
			releaseBarrier();
			const successor = await acquiring;
			assert.strictEqual(beta.freshnessCalls.length, 1);
			assert.deepStrictEqual(beta.freshnessCalls[0].dependencies, [
				['alpha', cluster.node('alpha').written[0].position],
			]);
			beta.coordinator.release(key, successor.admissionId);
		});

		it('inherits dependencies transitively through a holder that made no writes', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const alphaRound = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, alphaRound.admissionId);

			const beta = cluster.node('beta').coordinator;
			const betaRound = await beta.acquire(key, LEASE, WAIT);
			beta.release(key, betaRound.admissionId);
			const gamma = cluster.node('gamma');
			const gammaRound = await gamma.coordinator.acquire(key, LEASE, WAIT);
			assert.deepStrictEqual(
				gamma.freshnessCalls.at(-1).dependencies.map(([origin]) => origin),
				['alpha', 'beta']
			);
			gamma.coordinator.release(key, gammaRound.admissionId);
		});

		it('fails 503 on an unsatisfied barrier and preserves known lineage for the next requester', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const alphaRound = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, alphaRound.admissionId);

			const beta = cluster.node('beta');
			beta.freshnessError = new Error('origin position was purged');
			await assert.rejects(
				() => beta.coordinator.acquire(key, LEASE, WAIT),
				(error) => error.statusCode === 503 && /origin position was purged/.test(error.message)
			);
			beta.freshnessError = undefined;
			const gamma = cluster.node('gamma');
			const recovered = await gamma.coordinator.acquire(key, LEASE, WAIT);
			assert.deepStrictEqual(
				gamma.freshnessCalls.at(-1).dependencies.map(([origin]) => origin),
				['alpha'],
				'the failed barrier discarded or changed exact lineage'
			);
			gamma.coordinator.release(key, recovered.admissionId);
		});

		it('does not install a grant recalled while its freshness barrier is pending', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const alphaRound = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, alphaRound.admissionId);

			cluster.beforeFreshness = (name) => (name === 'beta' ? new Promise(() => {}) : undefined);
			const beta = cluster.node('beta');
			const pendingAcquire = beta.coordinator.acquire(key, LEASE, WAIT);
			await waitFor(() => beta.freshnessCalls.length === 1);
			await cluster.node('gamma').coordinator.onDelegationRequest({
				key,
				requester: 'gamma',
				generation: 1,
				leaseMs: LEASE,
			});
			await waitFor(() => cluster.recalls.some(({ to }) => to === 'beta'));
			beta.mapless = true;
			await assert.rejects(pendingAcquire, /No agreed record lock home map/);
			assert.strictEqual(beta.coordinator.stats.delegations, 0);
			await waitFor(() => cluster.node('gamma').coordinator.stats.granted === 0);
			const contender = await cluster.node('gamma').coordinator.acquire(key, LEASE, WAIT);
			cluster.node('gamma').coordinator.release(key, contender.admissionId);
		});

		it('cancels a pending freshness barrier when its coordinator closes', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, first.admissionId);

			cluster.beforeFreshness = (name) => (name === 'beta' ? new Promise(() => {}) : undefined);
			const beta = cluster.node('beta');
			const acquiring = beta.coordinator.acquire(key, LEASE, WAIT);
			await waitFor(() => beta.freshnessCalls.length === 1);
			beta.coordinator.close();
			await assert.rejects(acquiring, /coordination was closed/);
		});

		it('does not lose a recall that arrives before the grant reply', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, first.admissionId);

			const beta = cluster.node('beta');
			cluster.beforeReply = async (from, _to, _request, reply) => {
				if (from !== 'beta' || !reply.granted) return;
				cluster.beforeReply = undefined;
				// Gamma asks its local home while beta's grant reply is still held in the transport. The
				// resulting recall reaches beta before it knows the token it is about to receive.
				await cluster.node('gamma').coordinator.onDelegationRequest({
					key,
					requester: 'gamma',
					generation: 1,
					leaseMs: LEASE,
				});
				await waitFor(() => cluster.recalls.some(({ to }) => to === 'beta'));
				beta.mapless = true;
			};

			await assert.rejects(() => beta.coordinator.acquire(key, LEASE, WAIT), /No agreed record lock home map/);
			assert.strictEqual(beta.coordinator.stats.delegations, 0, 'the recalled reply was installed');
			assert.strictEqual(beta.freshnessCalls.length, 0, 'a recalled reply launched an unused freshness barrier');
			await waitFor(() => cluster.node('gamma').coordinator.stats.granted === 0);
			const contender = await cluster.node('gamma').coordinator.acquire(key, LEASE, WAIT);
			cluster.node('gamma').coordinator.release(key, contender.admissionId);
		});

		it('settles an early recall of an in-flight renewal before another node acquires', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha');
			const first = await alpha.coordinator.acquire(key, MAX_LOCK_LEASE_MS, WAIT);
			// Leave the first admission active while advancing far enough that a second maximum
			// lease requires renewal. Table's native key lock normally serializes these calls, but
			// exercising the coordinator directly proves its recall state machine does not clear the
			// home grant while an inherited admission is still holding.
			cluster.advance('alpha', DELEGATION_LEASE_MS - MAX_LOCK_LEASE_MS + 1);

			cluster.beforeReply = async (from, _to, _request, reply) => {
				if (from !== 'alpha' || !reply.granted) return;
				cluster.beforeReply = undefined;
				await cluster.node('gamma').coordinator.onDelegationRequest({
					key,
					requester: 'beta',
					generation: 1,
					leaseMs: LEASE,
				});
				await waitFor(() => cluster.recalls.some(({ to }) => to === 'alpha'));
				alpha.mapless = true;
			};

			let renewalSettled = false;
			const renewal = alpha.coordinator.acquire(key, MAX_LOCK_LEASE_MS, WAIT).finally(() => (renewalSettled = true));
			await waitFor(() => cluster.recalls.some(({ to }) => to === 'alpha'));
			await new Promise(setImmediate);
			assert.strictEqual(renewalSettled, false, 'the recalled renewal did not wait for its inherited admission');
			assert.strictEqual(alpha.written.length, 0, 'the recalled renewal released its home grant before draining');
			alpha.coordinator.release(key, first.admissionId);
			await assert.rejects(() => renewal, /No agreed record lock home map/);
			await waitFor(() => cluster.node('gamma').coordinator.stats.granted === 0);
			const successor = await cluster.node('beta').coordinator.acquire(key, LEASE, WAIT);
			cluster.node('beta').coordinator.release(key, successor.admissionId);
		});

		it('does not repeat a recovery barrier for a continuous renewal', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			cluster.advanceAll(DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const beta = cluster.node('beta');
			const recovered = await beta.coordinator.acquire(key, LEASE, WAIT);
			beta.coordinator.release(key, recovered.admissionId);
			assert.strictEqual(beta.freshnessCalls.length, 1);

			cluster.advance('beta', DELEGATION_LEASE_MS - LEASE + 1);
			const renewed = await beta.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(beta.freshnessCalls.length, 1, 'the renewal repeated the recovery barrier');
			beta.coordinator.release(key, renewed.admissionId);
		});

		it('hands back a grant whose barrier leaves too little lease to admit', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, first.admissionId);

			const beta = cluster.node('beta');
			cluster.beforeFreshness = (name) => {
				if (name !== 'beta') return;
				cluster.beforeFreshness = undefined;
				beta.mono += 61_000;
				beta.mapless = true;
			};
			await assert.rejects(
				() => beta.coordinator.acquire(key, MAX_LOCK_LEASE_MS, 120_000),
				/No agreed record lock home map/
			);
			await waitFor(() => cluster.node('gamma').coordinator.stats.granted === 0);
		});

		it('does not trust virgin-key absence after a coordinator retires', async () => {
			const table = `RetiredFreshness${Date.now()}`;
			const database = `retiredFreshness${Date.now()}`;
			const mono = () => performance.now();
			const predecessor = coldCoordinator(mono, { table, database, grantableAfterMono: -Infinity });
			await predecessor.acquire('seen-before-close', LEASE, WAIT);
			predecessor.close();

			const calls = [];
			const successor = coldCoordinator(mono, {
				table,
				database,
				grantableAfterMono: -Infinity,
				establishLockFreshness: async (_database, _table, _key, dependencies) => {
					calls.push(dependencies);
					return [];
				},
			});
			const round = await successor.acquire('seen-before-close', LEASE, WAIT);
			assert.deepStrictEqual(calls, [null]);
			successor.release('seen-before-close', round.admissionId);
			successor.close();
		});

		it('clears a self-home grant when a successful writer returns no position', async () => {
			const cluster = new FakeCluster(['alpha', 'beta']);
			const key = cluster.keyHomedOn('alpha');
			const alpha = cluster.node('alpha');
			alpha.writerReturnsVoid = true;
			const held = await alpha.coordinator.acquire(key, LEASE, WAIT);
			alpha.coordinator.release(key, held.admissionId);

			const successor = await cluster.node('beta').coordinator.acquire(key, LEASE, WAIT);
			assert.ok(alpha.written.some((entry) => entry.type === 'lockRelease'));
			cluster.node('beta').coordinator.release(key, successor.admissionId);
		});

		it('takes recovery for an unremembered key after a cold start', async () => {
			let mono = 0;
			const calls = [];
			const coordinator = coldCoordinator(() => mono, {
				establishLockFreshness: async (_database, _table, _key, dependencies) => {
					calls.push(dependencies);
					return [];
				},
			});
			mono = DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
			const round = await coordinator.acquire('cold-key', LEASE, WAIT);
			assert.deepStrictEqual(calls, [null]);
			coordinator.release('cold-key', round.admissionId);
			coordinator.close();
		});

		it('hands the transport the wait remaining on the lock deadline', async () => {
			// On a fixed clock the remaining wait is the whole wait.
			const calls = [];
			const coordinator = coldCoordinator(() => 5_000, {
				grantableAfterMono: -Infinity,
				establishLockFreshness: async (_database, _table, _key, dependencies, deadlineMs) => {
					calls.push({ dependencies, deadlineMs });
					return [];
				},
			});
			coordinator.close();
			const successor = coldCoordinator(() => 5_000, {
				database: coordinator.database,
				table: coordinator.table,
				grantableAfterMono: -Infinity,
				establishLockFreshness: async (_database, _table, _key, dependencies, deadlineMs) => {
					calls.push({ dependencies, deadlineMs });
					return [];
				},
			});
			const round = await successor.acquire('deadline-key', LEASE, 7_500);
			assert.deepStrictEqual(calls, [{ dependencies: null, deadlineMs: 7_500 }]);
			successor.release('deadline-key', round.admissionId);
			successor.close();
		});

		it('admits a recovery-marked grant once the transport has written a barrier and drained to it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha');
			const home = cluster.node('gamma').coordinator;
			const held = await home.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			const predecessorWrite = ++cluster.tsCounter;
			alpha.written.push({ type: 'put', key, position: predecessorWrite });
			home.applyEntry(
				{ type: 'lockRelease', key, requester: 'alpha', token: held.token, dependencies: 'lost' },
				'alpha',
				++cluster.tsCounter
			);

			const beta = cluster.node('beta');
			const applied = { alpha: 0, beta: 0, gamma: 0 };
			cluster.beforeFreshness = async (name, _key, dependencies) => {
				if (name !== 'beta' || dependencies !== null) return;
				for (const origin of cluster.homes) {
					const position = await cluster.writeControlFor(origin)({ type: 'lockBarrier', nonce: 1 });
					for (const entry of cluster.node(origin).written)
						if (entry.position <= position) applied[origin] = Math.max(applied[origin], entry.position);
				}
			};
			const successor = await beta.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(beta.freshnessCalls.at(-1).dependencies, null, 'the grant carried the recovery marker');
			assert.ok(applied.alpha >= predecessorWrite, 'the drain reached the predecessor’s write');
			const alphaBarrier = alpha.written.find((entry) => entry.type === 'lockBarrier');
			assert.ok(alphaBarrier.position > predecessorWrite, 'the barrier is ordered after the write');
			for (const node of cluster.nodes.values())
				assert.strictEqual(
					node.coordinator.stats.granted,
					node.name === 'gamma' ? 1 : 0,
					`${node.name} acted on a barrier`
				);
			beta.coordinator.release(key, successor.admissionId);
		});

		it('takes recovery after a delegate expires without a clean release', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, first.admissionId);
			const betaRound = await cluster.node('beta').coordinator.acquire(key, LEASE, WAIT);
			cluster.node('beta').coordinator.release(key, betaRound.admissionId);
			cluster.advanceAll(DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const gamma = cluster.node('gamma');
			const round = await gamma.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(gamma.freshnessCalls.at(-1).dependencies, null);
			gamma.coordinator.release(key, round.admissionId);
		});

		it('takes recovery when a renewed grant is handed back without clean lineage', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha');
			const first = await alpha.coordinator.acquire(key, LEASE, WAIT);
			alpha.coordinator.release(key, first.admissionId);

			const renewed = await cluster.node('gamma').coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(renewed.granted, true);
			cluster.advance('alpha', DELEGATION_LEASE_MS + 1);
			await cluster.writeControlFor('alpha')({
				type: 'lockRelease',
				key,
				requester: 'alpha',
				token: renewed.token,
				dependencies: null,
			});

			const beta = cluster.node('beta');
			const successor = await beta.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(beta.freshnessCalls.at(-1).dependencies, null);
			beta.coordinator.release(key, successor.admissionId);
		});

		it('ignores recovery positions for nodes outside the current lock map', async () => {
			let mono = 0;
			const coordinator = coldCoordinator(() => mono, {
				establishLockFreshness: async () => [
					['alpha', 3],
					['former-member', 9],
				],
			});
			mono = DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
			const round = await coordinator.acquire('recovered-key', LEASE, WAIT);
			coordinator.release('recovered-key', round.admissionId);
			coordinator.close();
		});

		it('takes recovery for a virgin key after the home-map generation changes', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const firstKey = cluster.keyHomedOn('gamma', 'generation-one-');
			await cluster.node('alpha').coordinator.acquire(firstKey, LEASE, WAIT);
			cluster.generation = 2;
			const secondKey = cluster.keyHomedOn('gamma', 'generation-two-');
			const beta = cluster.node('beta');
			const round = await beta.coordinator.acquire(secondKey, LEASE, WAIT);
			assert.strictEqual(beta.freshnessCalls.at(-1).dependencies, null);
			beta.coordinator.release(secondKey, round.admissionId);
		});
	});

	describe('independent clocks', () => {
		it('lets the home outwait its delegate even when the two clocks run apart', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { skewMs: 5_000 });
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, round.admissionId);
			// Alpha's clock runs past the delegation; beta's has not reached the grant's deadline yet.
			cluster.advance('alpha', DELEGATION_LEASE_MS + 1);
			assert.strictEqual(alpha.stats.delegations, 0, 'the delegate must stop admitting first');
			cluster.advance('beta', DELEGATION_LEASE_MS + 1);
			assert.strictEqual(
				cluster.node('beta').coordinator.stats.granted,
				1,
				'the home must still be holding the grant through the skew margin'
			);
			cluster.advance('beta', LOCK_LEASE_SKEW_MS);
			assert.strictEqual(cluster.node('beta').coordinator.stats.granted, 0);
		});

		it('does not let a home forget a grant before its own deadline', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			cluster.advance('beta', DELEGATION_LEASE_MS - 1);
			assert.strictEqual(cluster.node('beta').coordinator.stats.granted, 1);
		});
	});

	describe('failing closed', () => {
		it('refuses to acquire with no agreed home map', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			cluster.node('alpha').mapless = true;
			await assert.rejects(
				() => cluster.node('alpha').coordinator.acquire('k1', LEASE, WAIT),
				/No agreed record lock home map/
			);
		});

		it('refuses to acquire off the coordinating thread', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			cluster.node('alpha').owns = false;
			await assert.rejects(
				() => cluster.node('alpha').coordinator.acquire('k1', LEASE, WAIT),
				/not owned by this worker/
			);
		});

		it('refuses to acquire when the home cannot be reached', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			cluster.node('beta').alive = false;
			await assert.rejects(() => cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT), /Could not reach beta/);
		});

		it('blocks only the keys the unreachable node homes', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			cluster.node('beta').alive = false;
			const elsewhere = cluster.keyHomedOn('gamma');
			// The availability property the whole redesign exists for: one node down does not stop the
			// cluster from locking, only its own share of the ring.
			const round = await cluster.node('alpha').coordinator.acquire(elsewhere, LEASE, WAIT);
			assert.ok(round.tsR > 0);
		});

		it('refuses to acquire after the coordinator is closed', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			cluster.node('alpha').coordinator.close();
			await assert.rejects(() => cluster.node('alpha').coordinator.acquire('k1', LEASE, WAIT), /was closed/);
		});

		it('denies a request whose generation does not match the home’s', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const reply = await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key, requester: 'alpha', generation: 99, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'generation');
			assert.strictEqual(reply.generation, 1);
		});

		it('denies a request from a node the map does not name', async () => {
			// An authenticated replication identity outlives membership, and the generation alone proves
			// nothing about who is in it. Without this a decommissioned node takes delegations against
			// live members — and recalls the legitimate delegate to get them.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const reply = await beta.onDelegationRequest({ key, requester: 'retired', generation: 1, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'unknown-node');
			// And nothing was allocated for it: the next live member still gets the key.
			assert.strictEqual(beta.stats.granted, 0, 'a refused non-member still consumed a grant');
			const member = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(member.granted, true);
		});

		it('denies a request for a key it does not home', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const foreign = cluster.keyHomedOn('gamma');
			const reply = await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key: foreign, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'not-home');
		});

		it('rejects a malformed inbound request rather than granting on it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			for (const bad of [
				{ key, requester: '', generation: 1, leaseMs: LEASE },
				{ key: { not: 'encodable' }, requester: 'alpha', generation: 1, leaseMs: LEASE },
				{ key, requester: 'alpha', generation: 1, leaseMs: MIN_LOCK_LEASE_MS - 1 },
				{ key, requester: 'alpha', generation: 1, leaseMs: MAX_LOCK_LEASE_MS + 1 },
			]) {
				const reply = await beta.onDelegationRequest(bad);
				assert.strictEqual(reply.granted, false, `granted on ${JSON.stringify(bad)}`);
			}
			assert.strictEqual(beta.stats.granted, 0);
		});
	});

	describe('fencing tokens', () => {
		it('orders lexicographically by generation, then incarnation, then counter', () => {
			assert.ok(compareTokens([1, 1, 5], [2, 1, 1]) < 0);
			assert.ok(compareTokens([1, 1, 5], [1, 2, 1]) < 0);
			assert.ok(compareTokens([1, 1, 5], [1, 1, 6]) < 0);
			assert.strictEqual(compareTokens([1, 1, 5], [1, 1, 5]), 0);
		});

		it('outranks a restarted home’s earlier counters through the incarnation', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			const first = await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			// Beta restarts as a home and its counter begins again — the incarnation is what keeps the
			// new token ahead of the old one, which a random value could not do.
			cluster.node('beta').incarnation = 2;
			cluster.node('beta').coordinator.close();
			const fresh = new FakeCluster(['alpha', 'beta', 'gamma'], { incarnations: { beta: 2 } });
			const key2 = fresh.keyHomedOn('beta');
			const second = await fresh
				.node('beta')
				.coordinator.onDelegationRequest({ key: key2, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.ok(compareTokens(first.token, second.token) < 0);
		});

		it('does not let a stale release clear a newer delegation', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(beta.stats.granted, 1);
			// A release naming a counter that is not the live one — a delayed entry from a previous
			// delegation, or one replayed from the log long after its producer is gone.
			beta.applyEntry(
				{
					type: 'lockRelease',
					key,
					requester: 'alpha',
					token: [granted.token[0], granted.token[1], granted.token[2] - 1],
				},
				'alpha'
			);
			assert.strictEqual(beta.stats.granted, 1);
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'alpha');
			assert.strictEqual(beta.stats.granted, 0);
		});

		it('ignores a release written by a node that does not hold the grant', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			beta.applyEntry({ type: 'lockRelease', key, requester: 'gamma', token: granted.token }, 'gamma');
			assert.strictEqual(beta.stats.granted, 1, 'a non-delegate must not be able to clear a grant');
		});

		it('ignores a release whose payload names a node other than its author', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			// The payload is peer-supplied; the author comes from the audit header. They must agree.
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'gamma');
			assert.strictEqual(beta.stats.granted, 1);
		});
	});

	describe('a replaced transport', () => {
		/** Build a successor coordinator that adopts a predecessor's live authority, as Table.ts does. */
		function replace(cluster, name) {
			const node = cluster.node(name);
			const predecessor = node.coordinator;
			const successor = new LockCoordinator({
				database: cluster.database,
				table: cluster.table,
				nodeId: name,
				transport: predecessor.transport,
				writeControl: cluster.writeControlFor(name),
				keyIdOf: (key) => String(key),
				nextTimestamp: () => ++cluster.tsCounter,
				monotonic: () => node.mono + performance.now(),
				adopt: predecessor,
				// As in the harness constructor: an injected clock says nothing about process start, so the
				// §4.3 quarantine is opted into per test. It is NOT inherited from the predecessor here —
				// the adopting successor takes the max of the two, and both are waived.
				grantableAfterMono: -Infinity,
				autoTick: false,
			});
			predecessor.close();
			node.coordinator = successor;
			return { predecessor, successor };
		}

		it('installs a grant that arrived after the swap on the successor, not the coordinator it left', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			// The reload lands while the home's reply is still in flight. The grant is authority for the
			// NODE; installed on the coordinator that asked, it would admit a caller that no recall could
			// ever reach, alongside whoever the home grants next.
			let swapped;
			cluster.beforeReply = () => {
				cluster.beforeReply = undefined;
				swapped = replace(cluster, 'alpha');
			};
			const round = await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(swapped.predecessor.stats.delegations, 0, 'the delegation landed on a closed coordinator');
			assert.strictEqual(swapped.successor.stats.delegations, 1, 'the successor did not receive the late grant');

			// And the recall for it reaches the handle that grant admitted.
			const { handle } = realHandle();
			// Asserted, not called for effect: a round the handle refuses leaves `onRelease` unset, so
			// the drain never completes and the assertion below would fail for the wrong reason.
			assert.strictEqual(
				handle.joinClusterRound(round.tsR, LEASE, round.mintedMono, () =>
					swapped.successor.release(key, round.admissionId)
				),
				true
			);
			swapped.successor.registerAdmission(round.admissionId, () => handle.revokeLease());
			handle.release();
			await cluster.node('gamma').coordinator.acquire(key, LEASE, 5_000);
			assert.strictEqual(handle.isLeaseExpired(), true, 'no recall could reach the late grant’s handle');
		});

		it('does not re-grant a key its own closed predecessor still has outstanding', async () => {
			// Closing is a LOCAL event. `close()` without a successor drops the grant table, but the
			// delegation it authorized is live on the other node until that node's own deadline, and no
			// peer saw the close. A replacement built before then must refuse rather than hand the key to
			// someone else — `#grantableAfterMono` covers a process restart, not this.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta');
			const issued = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(issued.granted, true);
			beta.coordinator.close();

			const replacement = new LockCoordinator({
				database: cluster.database,
				table: cluster.table,
				nodeId: 'beta',
				transport: beta.coordinator.transport,
				writeControl: cluster.writeControlFor('beta'),
				keyIdOf: (key) => String(key),
				nextTimestamp: () => ++cluster.tsCounter,
				monotonic: () => beta.mono + performance.now(),
				autoTick: false,
			});
			beta.coordinator = replacement;
			const denied = await replacement.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(denied.granted, false, 'a replacement granted a key alpha still holds');

			// And its tokens must not tie the ones the closed coordinator already issued.
			cluster.advance('beta', DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const regranted = await replacement.onDelegationRequest({
				key,
				requester: 'gamma',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(regranted.granted, true);
			assert.strictEqual(
				compareTokens(regranted.token, issued.token) > 0,
				true,
				'the replacement restarted the counter into a token its predecessor already issued'
			);
		});

		it('cannot grant a key whose predecessor delegation is still live', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			// A component reload swaps the transport. The delegation alpha holds is untouched by that,
			// so the successor must not hand the key to gamma.
			const { successor } = replace(cluster, 'beta');
			assert.strictEqual(successor.stats.granted, 1, 'the successor adopted the live grant');
			const reply = await successor.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'contended');
		});

		it('does not hand back a grant through the coordinator the swap emptied', async () => {
			// The two-holder path this combines: a renewal reply that lost its race is cleaned up by the
			// coordinator that SENT it, and `handOffTo` has already emptied that object's delegations. The
			// "not while a delegation for the key is held" guard then reads an empty map, gives back the
			// token the home renewed in place, and the home is free to grant the key to another node while
			// the successor is still admitting under the pre-renewal delegation.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');
			const home = cluster.node('beta').coordinator;
			let deliverFirst;
			const realRequest = alpha.coordinator.transport.requestDelegation;
			alpha.coordinator.transport.requestDelegation = (target, database, table, request) =>
				new Promise((resolve) => {
					deliverFirst = async () => resolve(await cluster.node(target).coordinator.onDelegationRequest(request));
				});
			await assert.rejects(() => alpha.coordinator.acquire(key, LEASE, 100), /home answered timeout/);
			alpha.coordinator.transport.requestDelegation = realRequest;
			await alpha.coordinator.acquire(key, LEASE, WAIT);

			// The reload lands between the stalled request and its reply.
			const { predecessor, successor } = replace(cluster, 'alpha');
			assert.strictEqual(predecessor.stats.delegations, 0);
			assert.strictEqual(successor.stats.delegations, 1);

			await deliverFirst();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(home.stats.granted, 1, 'the handback cleared the grant backing a live delegation');
			assert.strictEqual(successor.stats.delegations, 1, 'the successor lost the delegation it adopted');
			const denied = await home.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(denied.granted, false, 'the home granted a key alpha is still inside');
		});

		it('keeps serving the node that already holds the delegation', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, round.admissionId);
			// Alpha is the delegate, not the home. Swapping ITS transport must not cost it the
			// delegation — the amortization would be lost on every component reload.
			const { successor } = replace(cluster, 'alpha');
			assert.strictEqual(successor.stats.delegations, 1);
			const requestsBefore = cluster.requests.length;
			await successor.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, requestsBefore, 'the adopted delegation still serves locks');
		});

		it('acquires through the successor when the swap closed the coordinator the caller captured', async () => {
			// `Table.lock()` captures a coordinator, then waits on the native key lock — long enough for a
			// reload to close what it captured. Authority moved to the successor, not away.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const { predecessor, successor } = replace(cluster, 'alpha');
			const round = await predecessor.acquire(key, LEASE, WAIT);
			assert.strictEqual(successor.stats.delegations, 1, 'the delegation landed somewhere else');
			assert.strictEqual(predecessor.stats.delegations, 0, 'the closed coordinator took the delegation');
			successor.release(key, round.admissionId);
		});

		it('carries what the wait already saw into the successor, so a swap mid-backoff still ends 423', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			// The swap lands in beta's backoff, so the successor inherits a deadline with nothing left to
			// probe with. Without the predecessor's observation it would report a held key as a
			// coordination failure.
			let swapped = false;
			cluster.beforeReply = async (from) => {
				if (from !== 'beta') return;
				if (!swapped) {
					swapped = true;
					replace(cluster, 'beta');
					return cluster.advance('beta', 1_000);
				}
				// The successor's own probe carries no budget, so only the predecessor's observation can
				// tell this wait that the key was held.
				await new Promise((resolve) => setTimeout(resolve, 200));
			};
			await assert.rejects(
				() => cluster.node('beta').coordinator.acquire(key, LEASE, 200),
				(error) => error.statusCode === 423
			);
		});

		it('does not restart the counter, so a successor token never ties a predecessor’s', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const beta = cluster.node('beta');
			const keyA = cluster.keyHomedOn('beta', 'ca-');
			const first = await beta.coordinator.onDelegationRequest({
				key: keyA,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			const { successor } = replace(cluster, 'beta');
			const keyB = cluster.keyHomedOn('beta', 'cb-');
			const second = await successor.onDelegationRequest({
				key: keyB,
				requester: 'gamma',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.ok(compareTokens(first.token, second.token) < 0, 'the successor minted a lesser-or-equal token');
		});

		it('expires the delegations it issued when closed WITHOUT a successor', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(alpha.stats.delegations, 1);
			// Nothing adopted this one, so it must not leave authority behind it.
			alpha.close();
			assert.strictEqual(alpha.stats.delegations, 0);
		});
	});

	describe('defects the pre-push review found, as regressions', () => {
		it('rejects a grant reply that outlived the delegation it grants', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');
			// The home grants, then the reply is delayed past the whole delegation. Anchoring the
			// delegate's deadline on the reply's ARRIVAL would hand it a full fresh lease while the home
			// had already expired the grant and could hand the key to someone else.
			alpha.coordinator.transport.requestDelegation = async (target, database, table, request) => {
				const reply = await cluster.node(target).coordinator.onDelegationRequest(request);
				cluster.advance('alpha', DELEGATION_LEASE_MS + 1);
				return reply;
			};
			// 503, not 423: the home granted the key to US and the reply merely arrived too late to use, so
			// nobody ever held it. 423 would send the caller to retry a contention that did not happen.
			await assert.rejects(
				() => alpha.coordinator.acquire(key, LEASE, 200),
				(error) => error.statusCode === 503 && /arrived too late to use/.test(error.message)
			);
			assert.strictEqual(alpha.coordinator.stats.delegations, 0, 'a dead reply must not install a delegation');
			// And the home must not be left holding a grant nobody will use: every retry renews it in
			// place, so without the handback the key answers `contended` to every other node until the
			// grant expires on the home's own clock.
			assert.strictEqual(
				cluster.node('beta').coordinator.stats.granted,
				0,
				'the home kept a grant the delegate never installed'
			);
			const gamma = await cluster.node('gamma').coordinator.acquire(key, LEASE, 1_000);
			cluster.node('gamma').coordinator.release(key, gamma.admissionId);
		});

		it('does not re-send a recall the delegate already confirmed', async () => {
			// A contender polls the home every 25 ms, and `#beginRecall` used to re-arm as soon as the
			// previous recall settled — so one handoff became a recall RPC per pass for the rest of the
			// delegation. A confirmed recall is never re-sent: the grant clears on its release or on its
			// own deadline.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const round = await cluster.node('alpha').coordinator.acquire(key, LEASE, WAIT);
			assert.ok(round, 'alpha did not take the key');
			// The delegate confirms the recall but never writes the release, which is the case that used
			// to leave the grant re-armable for its whole lifetime.
			let recallsSent = 0;
			cluster.node('beta').coordinator.transport.recallDelegation = async () => {
				recallsSent++;
			};
			await assert.rejects(
				() => cluster.node('gamma').coordinator.acquire(key, LEASE, 300),
				() => true
			);
			assert.strictEqual(recallsSent, 1, `the confirmed recall was re-sent ${recallsSent} times`);
		});

		it('admits from a live delegation with no wait budget left', async () => {
			// `Table.lock()` reaches the cluster step only after the native key lock, and that wait can
			// consume the caller's whole timeout. It used to throw 423 there rather than call `acquire` at
			// all — but a live delegation admits with zero messages and needs no budget, so the amortized
			// path was being skipped and the caller told a key nobody holds was held. Raised by the
			// round-24 outside lens against the 423/503 contract drawn one layer down.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, first.admissionId);
			const requestsBefore = cluster.requests.length;

			const admitted = await alpha.acquire(key, LEASE, 0);
			assert.ok(admitted, 'the amortized path needs no wait budget');
			assert.strictEqual(cluster.requests.length, requestsBefore, 'it sent a message it did not need to');
			alpha.release(key, admitted.admissionId);

			// The home's own key is the same: granting locally is synchronous.
			const localKey = cluster.keyHomedOn('alpha');
			const local = await alpha.acquire(localKey, LEASE, 0);
			assert.ok(local, 'a local grant needs no wait budget either');
			alpha.release(localKey, local.admissionId);
		});

		it('re-arms the quarantine when a thread becomes the coordination owner later', async () => {
			// A coordinator is built when a transport registers, but `ownsCoordination()` can flip long
			// afterwards — a thread taking over from an owner that died. The construction horizon has aged
			// out by then, so anchoring only there let the new owner grant immediately over delegations the
			// previous OWNER issued. Found by the round-24 graded pass, on the anchor two earlier rounds
			// had already moved.
			let owns = false;
			let mono = 1_000;
			const coordinator = new LockCoordinator({
				database: `owner${Date.now()}`,
				table: 'OwnerSwap',
				nodeId: 'alpha',
				transport: {
					homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
					ownsCoordination: () => owns,
					requestDelegation: () => Promise.reject(new Error('single node')),
					recallDelegation: () => Promise.resolve(),
				},
				writeControl: () => {},
				keyIdOf: (key) => String(key),
				nextTimestamp: () => 1,
				monotonic: () => mono,
				autoTick: false,
			});
			// Long past the construction horizon, and only now does this thread take coordination over.
			mono += 10 * (DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS);
			owns = true;
			const denied = await coordinator.onDelegationRequest({
				key: 'owned',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a new owner granted over its predecessor’s delegations');
			assert.strictEqual(denied.reason, 'quarantine');

			mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;
			const granted = await coordinator.onDelegationRequest({
				key: 'owned',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true, 'the ownership quarantine never ended');
			coordinator.close();
		});

		it('re-arms the quarantine when ownership is lost and regained', async () => {
			// The takeover anchor was only ever read from `#grant`, and `onDelegationRequest` answers
			// `not-home` before reaching it while this thread does not own coordination — so a
			// non-owning interval was never observed at all. Ownership moving A→B→A left A's anchor
			// dated from before the gap, and A granted straight over the delegations B had issued.
			let owns = true;
			let mono = 1_000;
			const coordinator = new LockCoordinator({
				database: `regain${Date.now()}`,
				table: 'OwnerRegain',
				nodeId: 'alpha',
				transport: {
					homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
					ownsCoordination: () => owns,
					requestDelegation: () => Promise.reject(new Error('single node')),
					recallDelegation: () => Promise.resolve(),
				},
				writeControl: () => {},
				keyIdOf: (key) => String(key),
				nextTimestamp: () => 1,
				monotonic: () => mono,
				autoTick: false,
			});
			mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
			const warm = await coordinator.onDelegationRequest({
				key: 'regained',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(warm.granted, true, 'an unbroken owner never leaves its own quarantine');

			// The gap. `tick()` is the poll production runs on its own while a coordinator owns.
			owns = false;
			coordinator.tick();
			mono += 10 * (DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS);
			owns = true;
			const denied = await coordinator.onDelegationRequest({
				key: 'regained',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a regained owner granted over the gap’s delegations');
			assert.strictEqual(denied.reason, 'quarantine');

			mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;
			const granted = await coordinator.onDelegationRequest({
				key: 'regained',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true, 'the re-armed quarantine never ended');
			coordinator.close();
		});

		it('does not let a cold-start waiver cover a later takeover', async () => {
			// `grantableAfterMono` attests that no previous INCARNATION OF THIS PROCESS issued anything —
			// a fresh database, a first start, a test. It latched `#quarantineWaived` for the
			// coordinator's whole life, so the same attestation also disabled the takeover quarantine,
			// which it says nothing about.
			let owns = true;
			let mono = 1_000;
			const coordinator = new LockCoordinator({
				database: `waived${Date.now()}`,
				table: 'WaivedTakeover',
				nodeId: 'alpha',
				transport: {
					homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
					ownsCoordination: () => owns,
					requestDelegation: () => Promise.reject(new Error('single node')),
					recallDelegation: () => Promise.resolve(),
				},
				writeControl: () => {},
				keyIdOf: (key) => String(key),
				nextTimestamp: () => 1,
				monotonic: () => mono,
				grantableAfterMono: -Infinity,
				autoTick: false,
			});
			const cold = await coordinator.onDelegationRequest({
				key: 'waived',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(cold.granted, true, 'the cold-start waiver did not apply');

			owns = false;
			coordinator.tick();
			mono += 10 * (DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS);
			owns = true;
			const denied = await coordinator.onDelegationRequest({
				key: 'waived',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a fresh-database attestation waived a takeover too');
			assert.strictEqual(denied.reason, 'quarantine');
			coordinator.close();
		});

		it('fails a recall routed to a thread that does not own coordination', async () => {
			// `acquire` refuses off the owner thread, so a delegation only ever lives on the coordinating
			// one. A recall that lands anywhere else finds nothing, and resolving tells the home the
			// delegate drained — it latches `recallConfirmed` and never re-sends — while the real
			// delegate on the owner thread keeps admitting for the rest of its lease.
			const cluster = new FakeCluster(['alpha', 'beta']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');
			const round = await alpha.coordinator.acquire(key, LEASE, WAIT);
			assert.ok(round, 'alpha did not take the key');
			alpha.owns = false;
			await assert.rejects(
				() => alpha.coordinator.onDelegationRecall({ key, token: round.token ?? [1, 1, 1] }),
				/not owned by this worker thread/
			);
		});

		it('re-arms the quarantine on an incarnation change the ownership poll never sampled', async () => {
			// Sampling `ownsCoordination()` proves the answer at the instant it is read, never that
			// ownership was unbroken between two reads — ownership alternating faster than the poll, with
			// each sample landing inside this thread's own interval, aliases away completely. §5.1's
			// incarnation is the statement about continuity that a boolean cannot make: a value this
			// coordinator has not granted under says another coordination incarnation ran, whatever the
			// boolean said in between.
			let incarnation = 1;
			let mono = 1_000;
			const coordinator = new LockCoordinator({
				database: `alias${Date.now()}`,
				table: 'PollAlias',
				nodeId: 'alpha',
				transport: {
					homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: incarnation }),
					// Never observed false: every sample lands inside an interval this thread owns.
					ownsCoordination: () => true,
					requestDelegation: () => Promise.reject(new Error('single node')),
					recallDelegation: () => Promise.resolve(),
				},
				writeControl: () => {},
				keyIdOf: (key) => String(key),
				nextTimestamp: () => 1,
				monotonic: () => mono,
				grantableAfterMono: -Infinity,
				autoTick: false,
			});
			const first = await coordinator.onDelegationRequest({
				key: 'aliased',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(first.granted, true);

			// Coordination went elsewhere and came back. Nothing sampled it; the incarnation says so.
			incarnation = 2;
			mono += 10 * (DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS);
			coordinator.tick();
			const denied = await coordinator.onDelegationRequest({
				key: 'aliased-2',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'an ownership change no poll saw did not re-arm the quarantine');
			assert.strictEqual(denied.reason, 'quarantine');

			mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;
			const granted = await coordinator.onDelegationRequest({
				key: 'aliased-2',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true, 'the re-armed quarantine never ended');
			coordinator.close();
		});

		it('does not waive the quarantine for a coordinator that was not owning when it was built', async () => {
			// `Table.lockCoordinator` constructs unconditionally, so every 503 `lock()` on a non-owning
			// worker builds one. Clearing the waiver only on an OBSERVED gap never fired for those: they
			// had no ownership to lose, so the takeover kept the waiver and granted immediately over the
			// delegations the outgoing owner thread was still admitting on.
			let owns = false;
			let mono = 1_000;
			const coordinator = new LockCoordinator({
				database: `unowned${Date.now()}`,
				table: 'BuiltUnowned',
				nodeId: 'alpha',
				transport: {
					homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
					ownsCoordination: () => owns,
					requestDelegation: () => Promise.reject(new Error('single node')),
					recallDelegation: () => Promise.resolve(),
				},
				writeControl: () => {},
				keyIdOf: (key) => String(key),
				nextTimestamp: () => 1,
				monotonic: () => mono,
				grantableAfterMono: -Infinity,
				autoTick: false,
			});
			mono += 10 * (DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS);
			owns = true;
			const denied = await coordinator.onDelegationRequest({
				key: 'unowned',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a coordinator built off the owner thread kept the waiver');
			assert.strictEqual(denied.reason, 'quarantine');
			coordinator.close();
		});

		it('does not let a transport reload re-waive a quarantine the predecessor lost', async () => {
			// `handOffTo` carries the horizon and the ownership clock, but the successor reads
			// `grantableAfterMono` off the NEW transport and re-latched the waiver from it — so a
			// component reload after a takeover put the node back to granting immediately.
			let owns = true;
			let mono = 1_000;
			const transport = {
				homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
				ownsCoordination: () => owns,
				requestDelegation: () => Promise.reject(new Error('single node')),
				recallDelegation: () => Promise.resolve(),
			};
			const options = {
				database: `reload${Date.now()}`,
				table: 'WaiverReload',
				nodeId: 'alpha',
				transport,
				writeControl: () => {},
				keyIdOf: (key) => String(key),
				nextTimestamp: () => 1,
				monotonic: () => mono,
				grantableAfterMono: -Infinity,
				autoTick: false,
			};
			const predecessor = new LockCoordinator(options);
			// The gap, then the takeover: the predecessor loses the waiver here.
			owns = false;
			predecessor.tick();
			mono += 10 * (DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS);
			owns = true;
			const afterTakeover = await predecessor.onDelegationRequest({
				key: 'reloaded',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(afterTakeover.reason, 'quarantine', 'the takeover did not re-arm the quarantine');

			const successor = new LockCoordinator({ ...options, adopt: predecessor });
			const denied = await successor.onDelegationRequest({
				key: 'reloaded',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a reload re-waived the quarantine the takeover armed');
			assert.strictEqual(denied.reason, 'quarantine');
			successor.close();
		});

		it('leaves a grant recallable when a local recall fails', async () => {
			// The home's own delegate goes through `#beginRecall`'s local branch, which used to assign
			// `grant.recalling` and never clear it on a rejection — so one failed recall latched the grant
			// for the rest of the delegation and no contender could prompt another. The remote branch had
			// always cleared it and armed `RECALL_RETRY_MS`; both settle the same way now.
			const cluster = new FakeCluster(['alpha', 'beta']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const own = await beta.acquire(key, LEASE, WAIT);
			assert.ok(own, 'beta did not take the key it homes');

			let recalls = 0;
			let lastRecall;
			beta.onDelegationRecall = () => {
				recalls++;
				// Awaited rather than slept past: `#beginRecall` attaches its handlers to this promise
				// inside the request below, so a handler the test attaches afterwards runs strictly after
				// the bookkeeping being asserted.
				return (lastRecall = Promise.reject(new Error('the drain failed')));
			};
			const settled = () => lastRecall.catch(() => {});
			const first = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(first.granted, false, 'alpha was granted over a live local delegation');
			await settled();
			assert.strictEqual(recalls, 1, 'the contender did not prompt a recall');

			// Only on the retry interval, not on the contender's 25 ms poll.
			const tooSoon = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(tooSoon.granted, false);
			await settled();
			assert.strictEqual(recalls, 1, 'a failed recall was re-sent on the contender’s poll interval');

			cluster.advance('beta', RECALL_RETRY_MS + 100);
			const retried = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(retried.granted, false);
			await settled();
			assert.strictEqual(recalls, 2, `a failed local recall was never retried (${recalls} sent)`);
		});

		it('arms the retry interval when the recall transport throws synchronously', async () => {
			// `Promise.resolve(recallDelegation(...))` evaluates the call first, so a synchronous throw
			// escaped `#beginRecall` entirely: the handlers never ran, `recallRetryAfterMono` was never
			// set, and the next contender pass threw again immediately instead of backing off. Third
			// instance of this pattern on this branch, so it is pinned rather than just fixed.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(granted.granted, true);

			let attempts = 0;
			cluster.node('beta').coordinator.transport.recallDelegation = () => {
				attempts++;
				throw new Error('transport is not connected');
			};
			// The contender must get a denial, not the transport's throw.
			const first = await beta.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(first.granted, false, 'a throwing recall must not grant');
			await delayMs(5);
			// And the next pass must be throttled rather than throwing again straight away.
			const second = await beta.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(second.granted, false);
			assert.strictEqual(attempts, 1, `the failed recall was re-sent ${attempts} times without backing off`);
		});

		it('does not renew a delegate that already confirmed a recall', async () => {
			// The hole the confirmed-recall guard opened, found on the next round. The delegate can confirm
			// and re-ask before its release reaches the home — the production writer is an async log commit
			// plus replication — and renewing then mints a token the pending release no longer matches,
			// leaves a grant `#beginRecall` will never recall again, and starves the contender for the rest
			// of the lease.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const first = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(first.granted, true);

			// Gamma contends, so the home recalls alpha; alpha confirms but its release has not landed.
			cluster.node('beta').coordinator.transport.recallDelegation = async () => {};
			const contended = await beta.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(contended.granted, false, 'gamma was granted over a live delegation');
			await delayMs(5);

			// Alpha's amortized next lock must NOT be renewed in place while that recall stands.
			const renewal = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(renewal.granted, false, 'the home renewed a delegate it had just recalled');
			assert.strictEqual(renewal.reason, 'contended');
		});

		it('does not latch a generation it never minted under', async () => {
			// The rollback floor has to be raised where authority is TAKEN, not where a map is read. One
			// `homeMap()` returning a too-large generation — a partial publish, a transport glitch — would
			// otherwise pin the floor above anything the operator ever publishes and fail every later lock
			// on the database until the thread restarts, for a key nobody holds. Raised by the round-22
			// outside lens against the floor added earlier in this branch.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			// One glitched read on the requester's side, of a generation nobody grants under. The home is
			// untouched and still on 1, so it refuses and nothing is ever minted under 99.
			const realMap = cluster.node('alpha').coordinator.transport.homeMap;
			cluster.node('alpha').coordinator.transport.homeMap = () => ({
				...realMap(),
				generation: 99,
			});
			await assert.rejects(
				() => alpha.acquire(key, LEASE, 100),
				(error) => error.statusCode === 503
			);

			// The real generation still works: nothing was minted under 99, so nothing is protected from.
			cluster.node('alpha').coordinator.transport.homeMap = realMap;
			const round = await alpha.acquire(key, LEASE, WAIT);
			assert.ok(round, 'a glitched read poisoned the generation floor');
			alpha.release(key, round.admissionId);
		});

		it('refuses a home map whose generation went backwards', async () => {
			// The generation is the high-order component of every fencing token, so re-minting under an
			// older one hands out tokens that order BELOW ones already issued — and a delayed write under
			// the newer generation then defeats its successor. An operator-published map makes the
			// rollback route a config restore or a partial publish, not a protocol bug, so core refuses it
			// rather than assuming it away.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, first.admissionId);
			cluster.generation = 2;
			const second = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, second.admissionId);
			const underTwo = await cluster.node('beta').coordinator.onDelegationRequest({
				key: cluster.keyHomedOn('beta', 'gen2-'),
				requester: 'gamma',
				generation: 2,
				leaseMs: LEASE,
			});
			assert.strictEqual(underTwo.token[0], 2, 'the home did not mint under the new generation');

			cluster.generation = 1;
			await assert.rejects(() => alpha.acquire(key, LEASE, 200), /No agreed record lock home map/);
			const denied = await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(denied.granted, false, 'a home granted under a rolled-back generation');
			assert.strictEqual(denied.reason, 'generation');
		});

		it('answers a generation mismatch and an unnamed node with 503, not a 423 after the full wait', async () => {
			// The same defect class as the quarantine denial: neither condition can be waited out inside a
			// `lock()` timeout, so retrying spends the caller's whole budget holding the native key and
			// then reports 423 — "held by someone else" — on a key nobody holds. Raised on the PR by
			// cb1kenobi against the head this landed on.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');

			// The home is a generation ahead of the requester.
			cluster.node('beta').coordinator.transport.homeMap = () => ({
				generation: 2,
				homes: [...cluster.homes],
				homeIncarnation: 1,
			});
			await assert.rejects(
				() => alpha.coordinator.acquire(key, LEASE, WAIT),
				(error) => error.statusCode === 503 && /home map generation 2 and this node holds 1/.test(error.message)
			);

			// And a requester the map does not name at all.
			const cluster2 = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key2 = cluster2.keyHomedOn('beta');
			cluster2.node('beta').coordinator.transport.homeMap = () => ({
				generation: 1,
				homes: ['beta', 'gamma'],
				homeIncarnation: 1,
			});
			await assert.rejects(
				() => cluster2.node('alpha').coordinator.acquire(key2, LEASE, WAIT),
				(error) => error.statusCode === 503 && /not named in the record lock home map/.test(error.message)
			);
		});

		it('reports 423 only for real contention, and 503 for a ring the map never agrees on', async () => {
			// The third case in the same round-9 finding as the quarantine and generation denials, and the
			// reason this is a class fix rather than a fourth branch: `not-home` IS worth retrying, because
			// a stale map on our side converges. What is wrong is the terminal answer — two maps under one
			// generation number never converge, and 423 tells the caller a key nobody holds is held.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			// The home agrees on the generation but derives a different ring, so it answers `not-home`
			// forever rather than for a pass or two.
			cluster.node('beta').coordinator.transport.homeMap = () => ({
				generation: 1,
				homes: ['alpha', 'gamma'],
				homeIncarnation: 1,
			});
			await assert.rejects(
				() => cluster.node('alpha').coordinator.acquire(key, LEASE, 200),
				(error) => error.statusCode === 503 && /home answered not-home/.test(error.message)
			);

			// And genuine contention still ends as a 423: the key is held by another node's delegation.
			const contended = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key2 = contended.keyHomedOn('beta');
			const gamma = await contended.node('gamma').coordinator.acquire(key2, LEASE, WAIT);
			assert.ok(gamma, 'gamma did not take the key');
			contended.node('beta').coordinator.transport.recallDelegation = () => new Promise(() => {});
			await assert.rejects(
				() => contended.node('alpha').coordinator.acquire(key2, LEASE, 200),
				(error) => error.statusCode === 423
			);
		});

		it('drops a delegation when the generation changes under it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			const { handle, unlocked } = realHandle();
			assert.strictEqual(
				handle.joinClusterRound(round.tsR, LEASE, round.mintedMono, () => alpha.release(key, round.admissionId)),
				true
			);
			alpha.registerAdmission(round.admissionId, () => handle.revokeLease());
			assert.strictEqual(handle.isLeaseExpired(), false, 'the handle expired before the generation changed');
			assert.strictEqual(alpha.stats.delegations, 1);
			// A generation change may have re-homed the key to a node that knows nothing of this token.
			// Keeping its live handle would let alpha commit alongside whoever the new home grants.
			cluster.generation = 2;
			const requestsBefore = cluster.requests.length;
			const replacement = await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(handle.isLeaseExpired(), true, 'the stale-generation handle was not fenced');
			assert.strictEqual(unlocked.length, 1, 'revoking the held handle did not return the native key');
			assert.ok(cluster.requests.length > requestsBefore, 'the stale-generation delegation was reused');
			assert.strictEqual(alpha.stats.delegations, 1, 'the replacement delegation was not installed');
			alpha.release(key, replacement.admissionId);
		});

		it('refuses to grant before its configured horizon', async () => {
			// Relative to the same clock the coordinator reads, not an absolute constant: the fake
			// monotonic is `performance.now()`-based, so a fixed horizon silently falls into the past
			// once the process has been up longer than it.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				grantableAfterMono: performance.now() + DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS,
			});
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta');
			const denied = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a cold home must not grant over an unseen predecessor');
			assert.strictEqual(denied.reason, 'quarantine');
			cluster.advance('beta', DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const granted = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true);
		});

		it('quarantines a cold home by default, on its own process clock', async () => {
			// §4.3: the home map is immutable, so a restart advances no generation and nothing external
			// bounds what a previous incarnation granted. Neither process start nor thread start is a
			// sound anchor — `performance.now()` is process-wide inside a worker, and a thread can take
			// coordination ownership long after it booted — so the horizon runs from CONSTRUCTION, the
			// only instant core can prove nothing else was granting under.
			let mono = 1_000;
			const cold = coldCoordinator(() => mono);
			const denied = await cold.onDelegationRequest({
				key: 'quarantined',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a cold home granted over an unseen predecessor');
			assert.strictEqual(denied.reason, 'quarantine');

			mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS - 1;
			const stillDenied = await cold.onDelegationRequest({
				key: 'quarantined',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(stillDenied.reason, 'quarantine', 'the horizon ended a millisecond early');

			mono += 1;
			const granted = await cold.onDelegationRequest({
				key: 'quarantined',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true, 'the quarantine outlasted the delegation lease');
			cold.close();
		});

		it('answers a quarantined home with 503 rather than burning the caller’s wait for a 423', async () => {
			// The quarantine runs a full delegation lease (365s) and MAX_LOCK_TIMEOUT_MS is 300s, so no
			// legal caller can wait it out. Retrying it as ordinary contention would spend the whole
			// budget and then report 423 — "held by someone else" — for a key nobody holds.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				grantableAfterMono: performance.now() + DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS,
			});
			const alpha = cluster.node('alpha').coordinator;
			const key = cluster.keyHomedOn('alpha');
			await assert.rejects(
				() => alpha.acquire(key, LEASE, WAIT),
				(error) => error.statusCode === 503 && /restarted and cannot grant/.test(error.message)
			);
		});

		it('does not start a fresh quarantine when a warm coordinator is adopted', async () => {
			// Adoption carries the predecessor's horizon exactly. Recomputing from the successor's own
			// construction would reject this node's whole home share for a delegation lease on every
			// transport reload, which is a component reload away.
			const table = `WarmSwap${Date.now()}`;
			const database = `warmswap${Date.now()}`;
			let mono = 1_000;
			const predecessor = coldCoordinator(() => mono, { table, database });
			mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS;
			const successor = coldCoordinator(() => mono, { table, database, adopt: predecessor });
			const granted = await successor.onDelegationRequest({
				key: 'warm',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true, 'a transport reload restarted the quarantine');
			predecessor.close();
			successor.close();
		});

		it('carries the cold-start quarantine across a transport swap', async () => {
			// The successor adopts the predecessor's live authority, so it need not wait on THAT — but the
			// quarantine bounds what a previous incarnation of the process granted, which neither
			// coordinator can see. A component reload is not evidence about it.
			const mono = () => 5_000;
			const table = `ColdSwap${Date.now()}`;
			const database = `coldswap${Date.now()}`;
			const predecessor = coldCoordinator(mono, { table, database });
			const successor = coldCoordinator(mono, { table, database, adopt: predecessor });
			const denied = await successor.onDelegationRequest({
				key: 'swapped',
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a transport swap cleared the cold-start quarantine');
			assert.strictEqual(denied.reason, 'quarantine');
			predecessor.close();
			successor.close();
		});

		it('revokes a REAL handle whose write was staged and then unlocked', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			// A real handle wired exactly as Table.ts wires one, not a stub: a bare callback would assert
			// only that the coordinator CALLS a revoker, while the production `revokeLease` is what has
			// to fence the staged write.
			const { handle } = realHandle();
			assert.strictEqual(
				handle.joinClusterRound(round.tsR, LEASE, round.mintedMono, () => alpha.release(key, round.admissionId)),
				true
			);
			alpha.registerAdmission(round.admissionId, () => handle.revokeLease());

			// The caller staged a write and then unlocked; its transaction has not committed.
			handle.release();
			assert.strictEqual(handle.isLeaseExpired(), false, 'a clean unlock alone must not fence the write');

			await cluster.node('beta').coordinator.acquire(key, LEASE, 5_000);
			// This is the §6 property: the successor is admitted only once the predecessor's staged write
			// can no longer commit. `isLeaseExpired()` is exactly what the pre-submit commit fence reads.
			assert.strictEqual(handle.isLeaseExpired(), true, 'the handoff did not fence the predecessor’s staged write');
		});

		it('keeps an unlocked-but-staged write revocable across a renewal', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			// Move to just inside the renewal threshold, so the handle admitted next is still live when
			// the renewal happens. A renewal can only occur in the delegation's last lease-length, which
			// is exactly the window where a handle admitted moments earlier is still able to commit.
			await alpha.acquire(key, LEASE, WAIT);
			cluster.advance('alpha', DELEGATION_LEASE_MS - LEASE - 1_000);
			const round = await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, 1, 'the second lock should still be on the first delegation');

			const { handle } = realHandle();
			assert.strictEqual(
				handle.joinClusterRound(round.tsR, LEASE, round.mintedMono, () => alpha.release(key, round.admissionId)),
				true
			);
			alpha.registerAdmission(round.admissionId, () => handle.revokeLease());
			handle.release();

			// Past the threshold: the next lock renews. The handle above has not reached its own lease.
			cluster.advance('alpha', 2_000);
			const renewed = await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, 2, 'the lock after the threshold should have renewed');
			alpha.release(key, renewed.admissionId);

			// A renewal installed a fresh delegation object once, dropping the predecessor's revokers on
			// the floor; the next recall then surrendered while that handle could still commit.
			await cluster.node('gamma').coordinator.acquire(key, LEASE, 5_000);
			assert.strictEqual(handle.isLeaseExpired(), true, 'a renewed delegation lost track of a live handle');
		});

		it('refuses a grant minted under a generation that advanced while the reply was in flight', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			// The membership changes after the home granted but before the requester saw the reply. Under
			// the new generation the key may be homed elsewhere, and that home can already have granted it
			// — so admitting on the generation-1 token would put two nodes inside one key with no message
			// between them. The acquisition itself should still succeed, by asking again under generation 2.
			cluster.beforeReply = () => {
				cluster.beforeReply = undefined;
				cluster.generation = 2;
			};
			await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, 2, 'the superseded-generation grant was admitted rather than redone');
			const released = cluster.node('alpha').written.filter((entry) => entry.type === 'lockRelease');
			assert.strictEqual(released.length, 1, 'the stale grant was not handed back');
			assert.strictEqual(released[0].token[0], 1, 'the handed-back token was not the superseded one');
			assert.strictEqual(alpha.stats.delegations, 1);
		});

		it('does not let a release from a previous home incarnation clear a live grant', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			// A home that restarts begins counting again, so the SAME counter can belong to two
			// different delegations. Only the whole token identifies one.
			const stale = [granted.token[0], granted.token[1] - 1, granted.token[2]];
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: stale }, 'alpha');
			assert.strictEqual(beta.stats.granted, 1, 'a previous incarnation’s release cleared a live grant');
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'alpha');
			assert.strictEqual(beta.stats.granted, 0);
		});

		it('collects an expired grant rather than answering contended forever', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta');
			await beta.coordinator.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			// Past the grant's deadline, with tick() deliberately NOT run — a table whose expiry budget
			// is saturated is exactly the case where that happens.
			beta.mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
			const reply = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'gamma',
				generation: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(reply.granted, true, 'an uncollected expired grant blocked every other node');
		});
	});

	describe('defects the second review round found, as regressions', () => {
		it('does not let a superseded handle decrement its successor’s admissions', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const first = await alpha.acquire(key, LEASE, WAIT);
			// The delegation is replaced while the first handle is still open — a generation change is the
			// cheapest way to force that here.
			cluster.generation = 2;
			const second = await alpha.acquire(key, LEASE, WAIT);
			assert.notStrictEqual(first.admissionId, second.admissionId, 'a second admission was not created');
			// The OLD handle unlocks late. Untokened, this would decrement the new delegation and let it
			// be surrendered while its own caller is still inside.
			alpha.release(key, first.admissionId);
			assert.strictEqual(alpha.stats.admitted, 1, 'the superseded handle decremented the successor');
		});

		it('does not hand back a grant while it still holds a delegation for the key', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');
			const home = cluster.node('beta').coordinator;
			// R1 stalls on the wire. R2 goes through, alpha installs that token and is inside the key.
			let deliverFirst;
			const realRequest = alpha.coordinator.transport.requestDelegation;
			// In place for the whole first acquisition, not just its first send: the retry loop would
			// otherwise reach the home on its own and the acquisition would never time out.
			alpha.coordinator.transport.requestDelegation = (target, database, table, request) =>
				new Promise((resolve) => {
					deliverFirst = async () => resolve(await cluster.node(target).coordinator.onDelegationRequest(request));
				});
			await assert.rejects(() => alpha.coordinator.acquire(key, LEASE, 100), /home answered timeout/);
			alpha.coordinator.transport.requestDelegation = realRequest;
			await alpha.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(alpha.coordinator.stats.delegations, 1);

			// R1 lands at the home NOW. The home sees the same requester and renews IN PLACE, minting a
			// token alpha never receives. R1's cleanup must not release it: the home's grant is what
			// backs the delegation alpha is using, whatever token the home currently records it under.
			await deliverFirst();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(home.stats.granted, 1, 'a live delegation lost the grant backing it');
			const denied = await home.onDelegationRequest({ key, requester: 'gamma', generation: 1, leaseMs: LEASE });
			assert.strictEqual(denied.granted, false, 'the home handed the key onward while alpha was inside it');
		});

		it('hands back a delegation whose reply arrived after the caller stopped waiting', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');
			let resolveReply;
			alpha.coordinator.transport.requestDelegation = (target, database, table, request) =>
				new Promise((resolve) => {
					resolveReply = async () => resolve(await cluster.node(target).coordinator.onDelegationRequest(request));
				});
			await assert.rejects(() => alpha.coordinator.acquire(key, LEASE, 100), /home answered timeout/);
			// The home grants only now, to a caller that has already given up. Nothing would ever claim
			// or release it, so the home would deny every other node for the whole delegation.
			await resolveReply();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(cluster.node('beta').coordinator.stats.granted, 0, 'the stranded grant was not returned');
		});
	});

	describe('bounded state', () => {
		it('refuses a request once the per-requester cap is reached', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const beta = cluster.node('beta').coordinator;
			let denied;
			// 2000 is the per-requester cap; walk past it and assert the denial is capacity, not a throw.
			for (let i = 0; i < 2_100 && !denied; i++) {
				const reply = await beta.onDelegationRequest({
					key: cluster.keyHomedOn('beta', `cap${i}-`),
					requester: 'alpha',
					generation: 1,
					leaseMs: LEASE,
				});
				if (!reply.granted) denied = reply;
			}
			assert.ok(denied, 'the per-requester cap never engaged');
			assert.strictEqual(denied.reason, 'capacity');
		});

		it('releases a requester’s budget when its grants are cleared', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(beta.stats.granted, 1);
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'alpha');
			assert.strictEqual(beta.stats.granted, 0);
			const again = await beta.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(again.granted, true);
		});

		it('collects expired admissions hidden behind a longer-lease one', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			// Homed here, so the whole run is local and no renewal crosses the wire to confuse the count.
			const key = cluster.keyHomedOn('alpha');
			const alpha = cluster.node('alpha').coordinator;
			// A handle that staged a write and then unlocked stays revocable for its OWN lease, so this
			// one sits at the head of the admission map — insertion order, not expiry order — for five
			// minutes while every short admission behind it expires within a second.
			const long = await alpha.acquire(key, MAX_LOCK_LEASE_MS, WAIT);
			alpha.release(key, long.admissionId);
			for (let i = 0; i < 200; i++) {
				cluster.advance('alpha', 1_100);
				const short = await alpha.acquire(key, 1_000, WAIT);
				alpha.release(key, short.admissionId);
			}
			assert.strictEqual(alpha.stats.admitted, 0, 'every admission in the run unlocked');
			// Without the sweep the leading long admission blocks the scan for its whole lease and all
			// 201 entries are still retained, each holding its handle.
			assert.ok(
				alpha.stats.revocable < 100,
				`expired admissions accumulated behind the long one: ${alpha.stats.revocable} retained`
			);
		});

		it('still fences a longer-lease admission the sweep walked past', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const long = await alpha.acquire(key, MAX_LOCK_LEASE_MS, WAIT);
			const { handle } = realHandle(MAX_LOCK_LEASE_MS);
			assert.strictEqual(
				handle.joinClusterRound(long.tsR, MAX_LOCK_LEASE_MS, long.mintedMono, () =>
					alpha.release(key, long.admissionId)
				),
				true
			);
			alpha.registerAdmission(long.admissionId, () => handle.revokeLease());
			// Staged a write, then unlocked: still revocable, and still at the head of the map.
			handle.release();
			for (let i = 0; i < 200; i++) {
				cluster.advance('alpha', 1_100);
				const short = await alpha.acquire(key, 1_000, WAIT);
				alpha.release(key, short.admissionId);
			}
			// The sweep may only drop admissions that can no longer commit. Losing this one to it would
			// be the §6 defect the head-only scan never had.
			await cluster.node('beta').coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(handle.isLeaseExpired(), true, 'the surviving long admission was not revoked');
		});
	});

	describe('the release control entry', () => {
		it('round-trips through the private packr', () => {
			for (const key of ['record-1', 42, 9007199254740993n, ['a', 1], [1, ['b']]]) {
				const entry = {
					type: 'lockRelease',
					key,
					requester: 'alpha',
					token: [1, 2, 7],
					dependencies: [
						['alpha', 11],
						['beta', 11],
					],
				};
				const decoded = decodeLockControlPayload('lockRelease', encodeLockControlPayload(entry));
				assert.deepStrictEqual(decoded, entry);
			}
		});

		it('decodes the historical five-field release as unknown lineage', () => {
			assert.deepStrictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 2, 7]), {
				type: 'lockRelease',
				key: 'k',
				requester: 'alpha',
				token: [1, 2, 7],
			});
		});

		it('accepts every record-id shape the key encoder does', () => {
			// The predicate and the encoder have to agree shape by shape; drift off that rule in the
			// tight direction is what refused binary record ids above.
			const accepted = [
				'record-1',
				42,
				-1.5,
				NaN,
				Infinity,
				1n,
				2n ** 70n,
				true,
				false,
				null,
				new Uint8Array([1, 2]),
				Buffer.from([3]),
				// `Id` declares `(number | string | null)[]`, and a composite key is the shape most likely
				// to carry the scalars a table would not use on their own.
				[1n, 'k', null, true, new Uint8Array([4])],
			];
			for (const key of accepted) {
				assert.doesNotThrow(() => toBufferKey(key), `${String(key)} is encodable`);
				assert.ok(decodeLockControlPayload('lockRelease', [key, 'alpha', 1, 1, 1]), `${String(key)} is accepted`);
			}
			// Shapes `toBufferKey` throws on, plus the ones it would encode to something no record id
			// can be — those must still be refused rather than reaching the delegation table.
			for (const key of [{ not: 'a key' }, new Date(0), ['ok', { nested: 1 }], undefined, Symbol('s')])
				assert.strictEqual(
					decodeLockControlPayload('lockRelease', [key, 'alpha', 1, 1, 1]),
					undefined,
					`${String(key)} is refused`
				);
		});

		it('rejects malformed tuple headers and treats malformed dependencies as unknown lineage', () => {
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 1, 1, 'extra']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', [2, 'k', 'alpha', 1, 1, 1, []]), undefined);
			const unknownLineage = { type: 'lockRelease', key: 'k', requester: 'alpha', token: [1, 1, 1] };
			for (const dependencies of [[['', 2]], [['beta', Infinity]], 'not a dependency set'])
				assert.deepStrictEqual(decodeLockControlPayload('lockRelease', [1, 'k', 'alpha', 1, 1, 1, dependencies]), {
					...unknownLineage,
					dependencies: undefined,
				});
			assert.strictEqual(decodeLockControlPayload('lockRelease', 'not a tuple'), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', '', 1, 1, 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 1, 'not a number']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', [{ bad: 'key' }, 'alpha', 1, 1, 1]), undefined);
		});

		it('clears an exact grant with malformed lineage and makes its successor recover', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const home = cluster.node('gamma').coordinator;
			const granted = await home.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			const release = decodeLockControlPayload('lockRelease', [
				1,
				key,
				'alpha',
				...granted.token,
				'corrupt dependencies',
			]);
			home.applyEntry(release, 'alpha', 11);

			const beta = cluster.node('beta');
			const successor = await beta.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(beta.freshnessCalls.at(-1).dependencies, null);
			beta.coordinator.release(key, successor.admissionId);
		});

		it('round-trips the barrier entry and refuses every other shape of it', () => {
			const barrier = { type: 'lockBarrier', nonce: 281_474_976_710_655 };
			assert.deepStrictEqual(decodeLockControlPayload('lockBarrier', encodeLockControlPayload(barrier)), barrier);
			assert.deepStrictEqual(decodeLockControlPayload('lockBarrier', [1, 0]), { type: 'lockBarrier', nonce: 0 });
			assert.strictEqual(decodeLockControlPayload('lockBarrier', [2, 7]), undefined);
			for (const malformed of [[1], [1, 7, 8], [1, 'nonce'], [1, Infinity], ['1', 7], 'not a tuple', 7])
				assert.strictEqual(decodeLockControlPayload('lockBarrier', malformed), undefined, JSON.stringify(malformed));
			assert.strictEqual(decodeLockControlPayload('lockRelease', encodeLockControlPayload(barrier)), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', [1, 7]), undefined);
			const release = { type: 'lockRelease', key: 'k', requester: 'alpha', token: [1, 1, 1] };
			assert.strictEqual(decodeLockControlPayload('lockBarrier', encodeLockControlPayload(release)), undefined);
		});

		it('applies a barrier as a no-op: the grant and its lineage survive', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const home = cluster.node('gamma').coordinator;
			const granted = await home.onDelegationRequest({ key, requester: 'alpha', generation: 1, leaseMs: LEASE });
			assert.strictEqual(home.stats.granted, 1);
			home.applyEntry({ type: 'lockBarrier', nonce: 1 }, 'alpha', 50);
			assert.strictEqual(home.stats.granted, 1, 'a barrier from the delegate cleared its grant');

			home.applyEntry(
				{ type: 'lockRelease', key, requester: 'alpha', token: granted.token, dependencies: [] },
				'alpha',
				60
			);
			assert.strictEqual(home.stats.granted, 0);
			// A later barrier from the same origin must not advance or drop the retained lineage.
			home.applyEntry({ type: 'lockBarrier', nonce: 2 }, 'alpha', 70);
			const beta = cluster.node('beta');
			const successor = await beta.coordinator.acquire(key, LEASE, WAIT);
			assert.deepStrictEqual(beta.freshnessCalls.at(-1).dependencies, [['alpha', 60]]);
			beta.coordinator.release(key, successor.admissionId);
		});

		it('no longer decodes the retired Ricart–Agrawala types', () => {
			// Nibbles 9 and 10 were retired rather than migrated; 9 is now eviction. A historical entry
			// replayed from the log must decode to nothing rather than to something this version acts on.
			assert.strictEqual(decodeLockControlPayload('lockRequest', ['k', 'alpha', 1, 1, 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockGrant', ['k', 'alpha', 1, 1, 1]), undefined);
		});

		it('is dropped off the coordinating thread rather than applied', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta');
			const granted = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
			});
			beta.owns = false;
			beta.coordinator.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'alpha');
			assert.strictEqual(beta.coordinator.stats.granted, 1);
			assert.strictEqual(beta.coordinator.stats.droppedOffOwner, 1);
		});

		it('contains a malformed entry rather than surfacing it to the apply loop', async () => {
			// A malformed entry must not reach the replicated apply loop, which would drop the whole
			// enclosing transaction and stall replication for the database.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha');
			const round = await alpha.coordinator.acquire(key, LEASE, WAIT);
			const before = alpha.coordinator.stats.delegations;
			assert.doesNotThrow(() => alpha.coordinator.applyEntry(null, 'alpha'));
			assert.doesNotThrow(() =>
				alpha.coordinator.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: [1, 1, 1] }, null)
			);
			// And neither one moved any state: a malformed entry is dropped, not half-applied.
			assert.strictEqual(alpha.coordinator.stats.delegations, before, 'a malformed entry changed the delegation table');
			alpha.coordinator.release(key, round.admissionId);
		});

		it('contains a throw from a failing writer rather than surfacing it', async () => {
			// What the name says, which the previous version of this test did not do — it injected
			// malformed apply entries and then asserted `ok(true)`. Here the WRITER throws:
			// `#writeControlSafely` has to swallow that, because the home outwaits this delegate either
			// way and an escaping rejection would take down whatever drove the surrender.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha');
			const round = await alpha.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(alpha.coordinator.stats.delegations, 1);

			alpha.writerThrows = true;
			alpha.coordinator.release(key, round.admissionId);
			// Gamma contends, so the home recalls alpha; alpha surrenders and writes the release, which
			// throws. Neither that throw nor an unhandled rejection may reach this caller.
			await cluster
				.node('gamma')
				.coordinator.acquire(key, LEASE, 500)
				.catch(() => {});
			assert.ok(alpha.writerCalls > 0, 'the failing writer was never reached');
			assert.strictEqual(alpha.coordinator.stats.delegations, 0, 'a throwing writer left the delegation held');

			// The delegation is deleted before the write is attempted and every caller above catches, so
			// neither assertion above can tell containment from a rejection absorbed further up. The home
			// can: a recall that RESOLVED is confirmed and never re-sent, while a rejected one is re-sent
			// once past the retry interval.
			const recalled = () => cluster.recalls.filter((recall) => recall.to === 'alpha').length;
			const confirmed = recalled();
			cluster.advance('beta', RECALL_RETRY_MS + 100);
			await cluster
				.node('gamma')
				.coordinator.acquire(key, LEASE, 100)
				.catch(() => {});
			assert.strictEqual(
				recalled(),
				confirmed,
				'the writer throw escaped the surrender, so the home retried the recall'
			);
		});

		it('recovers immediately when a self-home release writer fails', async () => {
			const cluster = new FakeCluster(['alpha', 'beta']);
			const key = cluster.keyHomedOn('alpha');
			const alpha = cluster.node('alpha');
			const first = await alpha.coordinator.acquire(key, LEASE, WAIT);
			alpha.coordinator.release(key, first.admissionId);
			alpha.writerThrows = true;

			const beta = cluster.node('beta');
			const successor = await beta.coordinator.acquire(key, LEASE, WAIT);
			assert.ok(alpha.writerCalls > 0, 'the self-home release writer did not fail');
			assert.strictEqual(beta.freshnessCalls.at(-1).dependencies, null);
			beta.coordinator.release(key, successor.admissionId);
		});
	});
});

describe('quiesceDelegations (harper-pro#856)', () => {
	/** A coordinator that is a HOME for `alpha` and can grant to a peer, with a scriptable recall. */
	function homeWithPeer(database, table, recall) {
		// Ownership continuity is what proves quiescence, so a coordinator has to have owned for a full
		// lease before a sweep is a proof. These tests are about the sweep itself, so they start the
		// clock past that horizon; the handoff test below is the one that exercises the horizon.
		const clock = { now: DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1 };
		const coordinator = new LockCoordinator({
			database,
			table,
			nodeId: 'alpha',
			transport: {
				homeMap: () => ({ generation: 1, homes: ['alpha', 'beta'], homeIncarnation: 1 }),
				ownsCoordination: () => true,
				establishLockFreshness: async (_d, _t, _k, dependencies) => dependencies ?? [],
				requestDelegation: () => {
					throw new Error('unused');
				},
				recallDelegation: recall,
			},
			writeControl: () => {},
			keyIdOf: (key) => String(key),
			nextTimestamp: () => 1,
			monotonic: () => clock.now,
			grantableAfterMono: -Infinity,
			autoTick: false,
		});
		// Ownership was recorded at construction on this clock; move past its horizon.
		clock.now += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
		return coordinator;
	}

	it('reports a clean database as quiesced with nothing outstanding', async () => {
		const coordinator = homeWithPeer('q1', 'T', async () => {});
		const result = await quiesceDelegations('q1', 1000);
		assert.deepStrictEqual(result.outstanding, []);
		assert.strictEqual(result.surrendered, 0);
		assert.strictEqual(result.recalled, 0);
		coordinator.close();
	});

	it('an empty sweep is not a proof: a table nothing has touched has no coordinator to sweep', async () => {
		// No coordinator, no transport attestation — the sweep sees nothing and must say so rather than
		// reporting a clean drain that would let an orchestrator skip the interval.
		const result = await quiesceDelegations('never-touched', 1000);
		assert.deepStrictEqual(result.outstanding.length > 0 || result.complete === false, true);
		assert.strictEqual(result.complete, false, 'an unattested, unswept database cannot be proven quiesced');
	});

	it('a thread that took ownership recently cannot prove quiescence, however long it has been up', async () => {
		// cursor-grok's counterexample: worker A owns the database, grants, and exits. Worker B built
		// empty coordinators earlier (a cluster_status poll), so its registry is non-empty and its uptime
		// is long — but A's delegates still admit. Ownership continuity, not uptime, is the proof.
		let mono = 0;
		const coordinator = new LockCoordinator({
			database: 'handoff',
			table: 'T',
			nodeId: 'alpha',
			transport: {
				homeMap: () => ({ generation: 1, homes: ['alpha', 'beta'], homeIncarnation: 1 }),
				ownsCoordination: () => true,
				establishLockFreshness: async (_d, _t, _k, dependencies) => dependencies ?? [],
				requestDelegation: () => {
					throw new Error('unused');
				},
				recallDelegation: async () => {},
			},
			writeControl: () => {},
			keyIdOf: (key) => String(key),
			nextTimestamp: () => 1,
			monotonic: () => mono,
			// No grantableAfterMono: this is NOT a first incarnation, so nothing is waived.
			autoTick: false,
		});
		// Take ownership "now", then let a lot of wall time pass without the horizon elapsing.
		const taken = await quiesceDelegations('handoff', 100);
		assert.strictEqual(taken.complete, false, 'ownership just started: authority from the previous owner may be live');
		assert.ok(taken.outstanding.some((o) => /long enough to rule out authority/.test(o.reason)));
		// Past the horizon, the same sweep is a proof.
		mono = DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
		const later = await quiesceDelegations('handoff', 100);
		assert.deepStrictEqual(later.outstanding, []);
		assert.strictEqual(later.complete, true);
		coordinator.close();
	});

	it("a closed coordinator's remote grants are still reported, though no live coordinator holds them", async () => {
		// close() parks the latest deadline of grants issued to OTHER nodes and clears its own table, so
		// the delegates keep admitting with nothing live to sweep. Reporting only what is live would call
		// that quiesced.
		const coordinator = homeWithPeer('retired1', 'T', async () => {});
		const [key] = keysHomedHere('retired1', 'T', 1);
		assert.strictEqual(
			(await coordinator.onDelegationRequest({ key, requester: 'beta', generation: 1, leaseMs: MAX_LOCK_LEASE_MS }))
				.granted,
			true
		);
		coordinator.close();
		const result = await quiesceDelegations('retired1', 100);
		assert.strictEqual(result.complete, false, "a closed coordinator's grants outlive it on their delegates");
		assert.ok(
			result.outstanding.some((entry) => /closed coordinator/.test(entry.reason)),
			JSON.stringify(result.outstanding)
		);
	});

	it('never reports complete alongside outstanding work', async () => {
		const coordinator = homeWithPeer('q7', 'T', async () => {
			throw new Error('unreachable');
		});
		const [key] = keysHomedHere('q7', 'T', 1);
		await coordinator.onDelegationRequest({ key, requester: 'beta', generation: 1, leaseMs: 1000 });
		const result = await quiesceDelegations('q7', 300);
		assert.ok(result.outstanding.length > 0);
		assert.strictEqual(result.complete, false);
		coordinator.close();
	});

	/** Keys are homed by rendezvous hash, so a test that needs THIS node to be the home must pick one. */
	function keysHomedHere(database, table, count, homes = ['alpha', 'beta']) {
		const found = [];
		for (let i = 0; found.length < count; i++) {
			const key = `k${i}`;
			if (homeFor(ringKeyFor(database, table, key), homes) === 'alpha') found.push(key);
		}
		return found;
	}

	it('recalls a grant this node issued and counts it once confirmed', async () => {
		const recalls = [];
		const coordinator = homeWithPeer('q2', 'T', async (node, _db, _table, recall) => {
			recalls.push({ node, key: recall.key });
		});
		// A grant to a peer, through the production request path.
		const [key] = keysHomedHere('q2', 'T', 1);
		const reply = await coordinator.onDelegationRequest({ key, requester: 'beta', generation: 1, leaseMs: 1000 });
		assert.strictEqual(reply.granted, true, 'the test key must be homed on this node');
		const result = await quiesceDelegations('q2', 1000);
		assert.deepStrictEqual(
			recalls.map((r) => [r.node, r.key]),
			[['beta', key]]
		);
		assert.strictEqual(result.recalled, 1);
		assert.deepStrictEqual(result.outstanding, []);
		coordinator.close();
	});

	it('reports an unconfirmed delegate as outstanding instead of claiming a drain', async () => {
		const coordinator = homeWithPeer('q3', 'T', async () => {
			throw new Error('unreachable');
		});
		const [key] = keysHomedHere('q3', 'T', 1);
		assert.strictEqual(
			(await coordinator.onDelegationRequest({ key, requester: 'beta', generation: 1, leaseMs: 1000 })).granted,
			true
		);
		const result = await quiesceDelegations('q3', 500);
		assert.strictEqual(result.recalled, 0);
		assert.strictEqual(result.outstanding.length, 1);
		assert.strictEqual(result.outstanding[0].delegate, 'beta');
		assert.strictEqual(result.outstanding[0].key, key);
		assert.match(result.outstanding[0].reason, /did not confirm|recall failed/);
		coordinator.close();
	});

	it('one unreachable delegate does not hide the rest', async () => {
		const [good1, bad, good2] = keysHomedHere('q4', 'T', 3);
		const coordinator = homeWithPeer('q4', 'T', async (_node, _db, _table, recall) => {
			if (recall.key === bad) throw new Error('unreachable');
		});
		for (const key of [good1, bad, good2])
			assert.strictEqual(
				(await coordinator.onDelegationRequest({ key, requester: 'beta', generation: 1, leaseMs: 1000 })).granted,
				true
			);
		const result = await quiesceDelegations('q4', 500);
		assert.strictEqual(result.recalled, 2, 'the reachable grants still drained');
		assert.deepStrictEqual(
			result.outstanding.map((o) => o.key),
			[bad]
		);
		coordinator.close();
	});

	it('only touches the named database, and a closed coordinator is not swept', async () => {
		const a = homeWithPeer('q5', 'T', async () => {});
		const b = homeWithPeer('q6', 'T', async () => {});
		const [keyA] = keysHomedHere('q5', 'T', 1);
		const [keyB] = keysHomedHere('q6', 'T', 1);
		await a.onDelegationRequest({ key: keyA, requester: 'beta', generation: 1, leaseMs: 1000 });
		await b.onDelegationRequest({ key: keyB, requester: 'beta', generation: 1, leaseMs: 1000 });
		assert.strictEqual((await quiesceDelegations('q5', 1000)).recalled, 1);
		b.close();
		assert.strictEqual((await quiesceDelegations('q6', 1000)).recalled, 0, 'closed coordinators are deregistered');
		a.close();
	});
});

// harper-pro#852: the "owner" and "caller" are two coordinators in one process, wired the way the
// transport wires them, so the remote-admission lifecycle is exercised without a real worker mesh.
describe('relayed admissions across worker threads (harper-pro#852)', () => {
	function makeCoordinator(database, transport, overrides = {}) {
		return new LockCoordinator({
			database,
			table: 'T',
			nodeId: 'alpha',
			transport,
			writeControl: () => {},
			keyIdOf: (key) => String(key),
			nextTimestamp: () => 1,
			monotonic: () => performance.now(),
			grantableAfterMono: -Infinity,
			autoTick: false,
			...overrides,
		});
	}

	/** An owner coordinator (self-home, owns coordination) and a caller coordinator that relays its
	 * acquires to the owner exactly as the transport does: the owner mints and registers a revoker that
	 * fences the caller's handle, the caller records the round under a fresh LOCAL id. `acquire()`
	 * returns both the local round the handle uses and the owner id the wire's release/revoke name. */
	function relaySetup(database) {
		const ownerMap = { generation: 1, homes: ['alpha'], homeIncarnation: 1 };
		const owner = makeCoordinator(database, {
			homeMap: () => ownerMap,
			ownsCoordination: () => true,
			establishLockFreshness: async (_d, _t, _k, dependencies) => dependencies ?? [],
			requestDelegation: () => {
				throw new Error('a single-node home must not request');
			},
			recallDelegation: () => {
				throw new Error('a single-node home must not recall');
			},
		});
		const released = [];
		/** Every admission id the OWNER minted, in order, so a test can name the id the wire uses. */
		const minted = [];
		let caller;
		caller = makeCoordinator(database, {
			homeMap: () => ownerMap,
			ownsCoordination: () => false,
			establishLockFreshness: async (_d, _t, _k, dependencies) => dependencies ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
			acquireOnOwner: async (_db, _table, key, lease, wait) => {
				const round = await owner.acquire(key, lease, wait);
				minted.push(round.admissionId);
				owner.registerAdmission(round.admissionId, () => caller.revokeRemoteAdmission(round.admissionId));
				return round;
			},
			releaseOnOwner: (_db, _table, key, ownerAdmissionId) => {
				released.push(ownerAdmissionId);
				return owner.release(key, ownerAdmissionId);
			},
		});
		return { owner, caller, released, minted };
	}

	afterEach(() => setLockCoordinatorResolver(() => undefined));

	it('mints on the owner, records a LOCAL id on the caller, and never reuses the owner id', async () => {
		const { owner, caller } = relaySetup('r1');
		const round = await caller.acquire('k', LEASE, WAIT);
		assert.ok(round && typeof round.admissionId === 'number');
		assert.strictEqual(caller.stats.relayedAdmissions, 1, 'the caller counts a relayed admission');
		assert.strictEqual(caller.stats.admitted, 0, 'the caller holds no local delegation');
		assert.strictEqual(owner.stats.admitted, 1, 'the owner holds the admission');
	});

	it('fails closed off the owner when the transport cannot relay', async () => {
		const noRelay = makeCoordinator('r2', {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => false,
			establishLockFreshness: async (_d, _t, _k, dep) => dep ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
		});
		await assert.rejects(noRelay.acquire('k', LEASE, WAIT), /not owned by this worker thread/);
	});

	it('times out a wedged owner acquire and releases a grant that arrives afterward', async () => {
		let grant;
		const released = [];
		const caller = makeCoordinator('r2a', {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => false,
			establishLockFreshness: async (_d, _t, _k, dependencies) => dependencies ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
			acquireOnOwner: () => new Promise((resolve) => (grant = resolve)),
			releaseOnOwner: (_database, _table, key, ownerAdmissionId) => {
				released.push({ key, ownerAdmissionId });
			},
		});
		await assert.rejects(caller.acquire('k', LEASE, 0), /the coordinating worker did not answer/);
		assert.deepStrictEqual(released, [], 'the backstop released an admission the owner had not granted');
		grant({ tsR: 1, mintedMono: performance.now(), admissionId: 77 });
		await waitFor(() => released.length === 1, {
			message: 'the grant that arrived after the backstop was not released to the owner',
		});
		assert.deepStrictEqual(released, [{ key: 'k', ownerAdmissionId: 77 }]);
		assert.strictEqual(caller.stats.relayedAdmissions, 0, 'the late grant was installed locally');
	});

	it('installs the handle revoker and fences it on a revoke, resolving the ack', async () => {
		const { caller } = relaySetup('r3');
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(round.admissionId, () => fenced++);
		// The wire names the OWNER id; here owner and caller share the id space (single-node self-home),
		// so the round's own id is the owner's.
		await caller.revokeRemoteAdmission(round.admissionId);
		assert.strictEqual(fenced, 1, 'the handle was fenced and the ack resolved');
	});

	it('holds the ack until an asynchronous fence actually lands', async () => {
		const { caller } = relaySetup('r3a');
		const round = await caller.acquire('k', LEASE, WAIT);
		let landFence;
		let acked = false;
		caller.registerAdmission(round.admissionId, () => new Promise((resolve) => (landFence = resolve)));
		const ack = caller.revokeRemoteAdmission(round.admissionId).then(() => (acked = true));
		await Promise.resolve();
		assert.strictEqual(acked, false, 'the ack resolved before the async fence landed');
		landFence();
		await ack;
		assert.strictEqual(acked, true, 'the ack resolved once the fence landed');
	});

	it('fails the ack when the fence does, so the owner waits out the lease instead of releasing', async () => {
		// The owner writes the delegation release the moment this ack resolves. A revoker that rejects —
		// a cross-thread relay revoker on a dead sibling port — has NOT fenced the handle, so resolving
		// would admit a successor over a writer that can still commit.
		const { caller } = relaySetup('r3b');
		const round = await caller.acquire('k', LEASE, WAIT);
		let fired = 0;
		caller.registerAdmission(round.admissionId, () => {
			fired++;
			return Promise.reject(new Error('sibling port gone'));
		});
		await assert.rejects(caller.revokeRemoteAdmission(round.admissionId), /sibling port gone/);
		// The entry is kept rather than dropped: the handle is still committable until its own lease, and
		// a retried revoke has to be able to fire the revoker again.
		await assert.rejects(caller.revokeRemoteAdmission(round.admissionId), /sibling port gone/);
		assert.strictEqual(fired, 2, 'the retried revoke did not reach the handle');
	});

	it('rejects rather than throwing synchronously when the revoker throws', async () => {
		const { caller } = relaySetup('r3c');
		const round = await caller.acquire('k', LEASE, WAIT);
		caller.registerAdmission(round.admissionId, () => {
			throw new Error('revoker exploded');
		});
		await assert.rejects(caller.revokeRemoteAdmission(round.admissionId), /revoker exploded/);
	});

	it('resolves the ack only after the handle is fenced when the revoke lands before the handle registers', async () => {
		const { caller } = relaySetup('r4');
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		let acked = false;
		// A revoke arrives before Table.lock installs the real revoker: the ack must NOT resolve yet.
		const ack = caller.revokeRemoteAdmission(round.admissionId).then(() => (acked = true));
		await Promise.resolve();
		assert.strictEqual(acked, false, 'the ack resolved before the handle was fenced');
		caller.registerAdmission(round.admissionId, () => fenced++);
		await ack;
		assert.strictEqual(fenced, 1, 'the latched revoke fenced the handle the instant it joined');
		assert.strictEqual(acked, true, 'the ack resolved once the fence landed');
	});

	it('waits for an ASYNC revoker registered after a latched revoke before resolving the ack', async () => {
		// Same race as above, but the handle's revoker is asynchronous. The ack the owner is waiting on
		// must not resolve until that promise settles: the owner writes the delegation release the moment
		// it is acked, so an early ack puts a successor in against a handle that is still committable.
		const { caller } = relaySetup('r4-async');
		const round = await caller.acquire('k', LEASE, WAIT);
		let releaseFence;
		let acked = false;
		const ack = caller.revokeRemoteAdmission(round.admissionId).then(() => (acked = true));
		await Promise.resolve();
		caller.registerAdmission(round.admissionId, () => new Promise((resolve) => (releaseFence = resolve)));
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(acked, false, 'the ack resolved before the async fence settled');
		releaseFence();
		await ack;
		assert.strictEqual(acked, true, 'the ack resolves once the async fence settles');
	});

	it('latches a revoke that arrives before the admission is even installed', async () => {
		// The owner registers its revoker before it posts the grant reply, so a recall in that window can
		// fire the revoke before `#acquireFromOwner` has recorded the entry. The ack must wait for the
		// eventual fence, never resolve against a handle that does not exist yet.
		const { caller } = relaySetup('r4b');
		let acked = false;
		// Owner id 1 is what a single-node self-home mints first; revoke it before acquiring.
		const ack = caller.revokeRemoteAdmission(1).then(() => (acked = true));
		await Promise.resolve();
		assert.strictEqual(acked, false, 'a pre-install revoke resolved with no handle to fence');
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(round.admissionId, () => fenced++);
		await ack;
		assert.strictEqual(fenced, 1, 'the pre-install revoke fenced the handle once it installed and registered');
		assert.strictEqual(acked, true);
	});

	it('separates the local id the handle uses from the owner id the wire names', async () => {
		// The id-collision guard: the caller records a relayed admission under a FRESH local id, and the
		// wire's release names the OWNER's id. Advancing the owner's own admission counter first makes the
		// two ids differ, so a test would catch the caller confusing them.
		const { owner, caller, released } = relaySetup('r5');
		const throwaway = await owner.acquire('warm', LEASE, WAIT); // advance the owner's admission counter
		owner.release('warm', throwaway.admissionId);
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(round.admissionId, () => fenced++);
		await caller.release('k', round.admissionId);
		assert.strictEqual(released.length, 1, 'exactly one release reached the owner');
		assert.notStrictEqual(round.admissionId, released[0], 'the local handle id and the owner id are distinct');
		assert.strictEqual(owner.stats.admitted, 0, 'the owner dropped the relayed admission, not the warm-up one');
	});

	it('forwards a release to the owner and keeps the entry until lease', async () => {
		const { owner, caller, released } = relaySetup('r6');
		const round = await caller.acquire('k', LEASE, WAIT);
		caller.registerAdmission(round.admissionId, () => {});
		await caller.release('k', round.admissionId);
		assert.strictEqual(released.length, 1, 'the release reached the owner');
		assert.strictEqual(owner.stats.admitted, 0, 'the owner dropped the admission');
	});

	it('does not raise an unhandled rejection when a fire-and-forget revoke rejects', async () => {
		// `close()`/`tick()` discard the revoke outcomes, so a relayed revoker that rejects (a dead sibling
		// port) — or a handle revoker that throws synchronously — must not become an unhandled rejection,
		// which Node's default policy turns into a worker exit.
		const rejections = [];
		const onUnhandled = (reason) => rejections.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const owner = makeCoordinator('reject-cl', {
				homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
				ownsCoordination: () => true,
				establishLockFreshness: async (_d, _t, _k, dep) => dep ?? [],
				requestDelegation: () => {
					throw new Error('unused');
				},
				recallDelegation: () => {
					throw new Error('unused');
				},
			});
			const key = 'k';
			const round = await owner.acquire(key, LEASE, WAIT);
			// A revoker that rejects, as a cross-thread relay revoker would on a dead port.
			owner.registerAdmission(round.admissionId, () => Promise.reject(new Error('sibling port gone')));
			owner.close();
			// A throwing revoker on another admission, via a second owner.
			const owner2 = makeCoordinator('reject-cl2', {
				homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
				ownsCoordination: () => true,
				establishLockFreshness: async (_d, _t, _k, dep) => dep ?? [],
				requestDelegation: () => {
					throw new Error('unused');
				},
				recallDelegation: () => {
					throw new Error('unused');
				},
			});
			const round2 = await owner2.acquire(key, LEASE, WAIT);
			owner2.registerAdmission(round2.admissionId, () => {
				throw new Error('revokeLease threw');
			});
			owner2.close();
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepStrictEqual(rejections, [], `a fire-and-forget revoke rejection escaped: ${rejections}`);
		} finally {
			process.removeListener('unhandledRejection', onUnhandled);
		}
	});

	it('fences a remote handle when the caller coordinator closes', async () => {
		const { caller } = relaySetup('r7');
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(round.admissionId, () => fenced++);
		caller.close();
		assert.strictEqual(fenced, 1, 'closing fenced the relayed handle');
	});

	it('fences every remote handle when the owner is declared gone', async () => {
		const { caller } = relaySetup('r8');
		const first = await caller.acquire('k1', LEASE, WAIT);
		const second = await caller.acquire('k2', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(first.admissionId, () => fenced++);
		caller.registerAdmission(second.admissionId, () => fenced++);
		caller.fenceAllRemoteAdmissions();
		assert.strictEqual(fenced, 2, 'both relayed handles were fenced fail-closed');
	});

	it('fences a stale relayed handle when a replacement owner reuses an admission id', async () => {
		// A replacement owner restarts its admission counter, so it can mint an id a departed owner's
		// still-live entry already holds. On the collision, the old entry must be fenced fail-closed
		// before the new one takes the id, so a later revoke for the id can only reach the live handle.
		let nextOwnerId = 5;
		const caller = makeCoordinator('reuse', {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => false,
			establishLockFreshness: async (_d, _t, _k, dep) => dep ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
			acquireOnOwner: async (_db, _table, _key, _lease) => ({
				tsR: 1,
				mintedMono: performance.now(),
				admissionId: nextOwnerId,
			}),
			releaseOnOwner: () => {},
		});
		const first = await caller.acquire('k', LEASE, WAIT);
		let staleFenced = 0;
		caller.registerAdmission(first.admissionId, () => staleFenced++);
		// The replacement owner mints the SAME id 5 for a new grant on the same key.
		nextOwnerId = 5;
		const second = await caller.acquire('k', LEASE, WAIT);
		assert.strictEqual(staleFenced, 1, 'the stale relayed handle was not fenced when the owner reused its id');
		assert.notStrictEqual(first.admissionId, second.admissionId, 'the two grants share a local id');
		// A revoke naming owner id 5 now reaches only the live (second) handle.
		let liveFenced = 0;
		caller.registerAdmission(second.admissionId, () => liveFenced++);
		await caller.revokeRemoteAdmission(5);
		assert.strictEqual(liveFenced, 1, 'the revoke did not reach the live handle');
		assert.strictEqual(staleFenced, 1, 'the stale handle was fenced a second time');
	});

	it('carries a remote admission to a successor across a transport swap', async () => {
		const { caller } = relaySetup('r9');
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(round.admissionId, () => fenced++);
		const successor = makeCoordinator('r9', {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => false,
			establishLockFreshness: async (_d, _t, _k, dep) => dep ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
			acquireOnOwner: async () => {
				throw new Error('unused');
			},
			releaseOnOwner: () => {},
		});
		caller.handOffTo(successor);
		await successor.revokeRemoteAdmission(round.admissionId);
		assert.strictEqual(fenced, 1, 'the successor drove the fence for the carried admission');
	});

	it('drives the exported owner-side entry points (acquireForRelay / releaseForRelay)', async () => {
		const owner = makeCoordinator('r10', {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => true,
			establishLockFreshness: async (_d, _t, _k, dep) => dep ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
		});
		setLockCoordinatorResolver(() => owner);
		let revoked = 0;
		const round = await acquireForRelay('r10', 'T', 'k', LEASE, WAIT, () => () => revoked++);
		assert.ok(round && typeof round.admissionId === 'number', 'acquireForRelay returned a round');
		assert.strictEqual(owner.stats.admitted, 1);
		await releaseForRelay('r10', 'T', 'k', round.admissionId);
		assert.strictEqual(owner.stats.admitted, 0, 'releaseForRelay ended the admission');
	});

	it('drives the exported caller-side entry points (revokeRelayedAdmission / fenceRelayedAdmissions)', async () => {
		const { owner, caller, minted } = relaySetup('r11');
		// Advance the owner's counter first, so the entry point is proven to address the OWNER's id
		// rather than passing because a fresh owner and caller both happen to start at 1.
		const throwaway = await owner.acquire('warm', LEASE, WAIT);
		owner.release('warm', throwaway.admissionId);
		const round = await caller.acquire('k', LEASE, WAIT);
		let fenced = 0;
		caller.registerAdmission(round.admissionId, () => fenced++);
		setLockCoordinatorResolver(() => caller);
		assert.notStrictEqual(minted[0], round.admissionId, 'the owner id and the local id must differ here');
		await revokeRelayedAdmission('r11', 'T', minted[0]);
		assert.strictEqual(fenced, 1, 'revokeRelayedAdmission fenced through the resolver');
		const second = await caller.acquire('k2', LEASE, WAIT);
		caller.registerAdmission(second.admissionId, () => fenced++);
		fenceRelayedAdmissions('r11', 'T');
		assert.strictEqual(fenced, 2, 'fenceRelayedAdmissions fenced the remaining handle');
	});

	it('does not write the delegation release until the relayed handle confirms it is fenced', async () => {
		// The invariant the whole relay exists to keep: an unlocked-but-staged write on another worker
		// is still committable, so the owner must fence it BEFORE it writes the release that lets the
		// home re-grant. Modeled with an admission whose revoke resolves only when the test says so.
		const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
		const key = cluster.keyHomedOn('gamma');
		const alpha = cluster.node('alpha').coordinator;
		const round = await alpha.acquire(key, LEASE, WAIT);
		let releaseFence;
		const fenced = new Promise((resolve) => (releaseFence = resolve));
		// A relayed handle: its revoke is asynchronous and settles only on the caller's ack.
		alpha.registerAdmission(round.admissionId, () => fenced);
		alpha.release(key, round.admissionId); // the caller unlocked, but the staged write can still commit

		let betaAdmitted = false;
		const betaAcquire = cluster
			.node('beta')
			.coordinator.acquire(key, LEASE, WAIT)
			.then(() => (betaAdmitted = true));
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(
			cluster.recalls.some((r) => r.to === 'alpha'),
			'the home recalled the holder'
		);
		assert.strictEqual(
			cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'),
			false,
			'the release was written before the relayed handle was fenced'
		);
		assert.strictEqual(betaAdmitted, false, 'the successor was admitted before the fence');
		releaseFence();
		await betaAcquire;
		assert.ok(
			cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'),
			'the release is written once the fence confirms'
		);
		assert.strictEqual(betaAdmitted, true);
	});

	it('writes one release for a delegation recalled twice, and not before the fence', async () => {
		// The home re-sends a recall RECALL_RETRY_MS after its own recall call failed — far inside a
		// delegation lease — so two recalls for the same token can both be parked on the drain and
		// resume together. The second must not find the admissions the first already emptied and write
		// the release while that first surrender is still waiting for the relayed handle's fence.
		const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
		const key = cluster.keyHomedOn('gamma');
		const alpha = cluster.node('alpha').coordinator;
		const round = await alpha.acquire(key, LEASE, WAIT);
		let releaseFence;
		const fenced = new Promise((resolve) => (releaseFence = resolve));
		alpha.registerAdmission(round.admissionId, () => fenced);

		const betaAcquire = cluster.node('beta').coordinator.acquire(key, LEASE, WAIT);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const recall = cluster.recalls.find((r) => r.to === 'alpha');
		assert.ok(recall, 'the home recalled the holder');
		const retried = alpha.onDelegationRecall({ key, token: recall.token });
		await new Promise((resolve) => setTimeout(resolve, 10));
		alpha.release(key, round.admissionId); // the caller unlocks: both recalls drain together
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(
			cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'),
			false,
			'the retried recall wrote the release before the relayed handle was fenced'
		);
		releaseFence();
		await Promise.all([betaAcquire, retried]);
		assert.strictEqual(
			cluster.node('alpha').written.filter((entry) => entry.type === 'lockRelease').length,
			1,
			'one handoff must write exactly one release entry'
		);
	});

	it('waits out the handle lease rather than releasing when the relayed fence rejects', async () => {
		// The owner half of the same invariant: a fence that failed is not a fence, so `#revokeAllAndSettle`
		// must fall through to the admission's own lease before `#surrender` publishes the release.
		const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
		const key = cluster.keyHomedOn('gamma');
		const alpha = cluster.node('alpha').coordinator;
		const shortLease = 300;
		const round = await alpha.acquire(key, shortLease, WAIT);
		alpha.registerAdmission(round.admissionId, () => Promise.reject(new Error('sibling port gone')));
		alpha.release(key, round.admissionId); // unlocked, but the staged write is still committable

		const betaAcquire = cluster.node('beta').coordinator.acquire(key, LEASE, WAIT);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(
			cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'),
			false,
			'a rejected fence was treated as a fence and released the delegation'
		);
		await betaAcquire;
		assert.ok(
			cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'),
			'the release is written once the handle lease has run out'
		);
	});

	it('refuses a grant that lands after the owner worker was declared gone', async () => {
		// The owner can grant and then die before the reply is processed. `fenceAllRemoteAdmissions` fails
		// the existing grants closed, but the in-flight one resolves AFTERWARDS. Installing it would let
		// this thread write under an admission the replacement owner — which starts empty — knows nothing
		// about, while that owner grants the same key to another worker. Two writers, silently.
		let grant;
		const released = [];
		const caller = makeCoordinator('r-generation', {
			homeMap: () => ({ generation: 1, homes: ['alpha'], homeIncarnation: 1 }),
			ownsCoordination: () => false,
			establishLockFreshness: async (_d, _t, _k, dependencies) => dependencies ?? [],
			requestDelegation: () => {
				throw new Error('unused');
			},
			recallDelegation: () => {
				throw new Error('unused');
			},
			acquireOnOwner: () => new Promise((resolve) => (grant = resolve)),
			releaseOnOwner: (_db, _table, _key, ownerAdmissionId) => {
				released.push(ownerAdmissionId);
			},
		});
		const acquiring = caller.acquire('k', LEASE, WAIT);
		await new Promise((resolve) => setImmediate(resolve)); // let the acquire reach the transport
		caller.fenceAllRemoteAdmissions(); // the owner worker is declared gone, mid-flight
		grant({ tsR: 1, mintedMono: performance.now(), admissionId: 77 });
		await assert.rejects(acquiring, /coordinating worker changed/);
		assert.deepEqual(released, [77], 'the orphaned grant must be handed straight back to the owner');
		assert.strictEqual(caller.stats.relayedAdmissions, 0, 'no orphaned admission may be installed');
	});
});
