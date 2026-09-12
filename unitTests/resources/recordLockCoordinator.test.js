const assert = require('assert');
const {
	LockCoordinator,
	LOCK_LEASE_SKEW_MS,
	DELEGATION_LEASE_MS,
	compareTokens,
	decodeLockControlPayload,
	encodeLockControlPayload,
	homeFor,
	ringKeyFor,
} = require('#src/resources/recordLockCoordinator');
const { MAX_LOCK_LEASE_MS, MIN_LOCK_LEASE_MS, makeKeyLockHandle } = require('#src/resources/recordLock');

/** A real lock handle over a fake store, so revocation is tested through production code. */
function realHandle(lease = LEASE) {
	const unlocked = [];
	let mono = 1;
	const store = { unlock: (key) => unlocked.push(key), getMonotonicTimestamp: () => mono++ };
	const handle = makeKeyLockHandle(store, ['k'], 'k', lease, true);
	return { handle, unlocked };
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
		this.epochNumber = options.epochNumber ?? 1;
		this.members = [...nodeNames];
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
			/** Bumped to simulate a restart of this node in its role as a home. */
			incarnation: 1,
			/** Set to make this node report no agreed epoch — a membership change, or a minority side. */
			epochless: false,
			written: [],
		};
		node.coordinator = new LockCoordinator({
			database: 'test',
			table: this.table,
			nodeId: name,
			transport: {
				epoch: () =>
					node.epochless
						? undefined
						: {
								number: this.epochNumber,
								members: [...this.members],
								ringVersion: 1,
								homeIncarnation: node.incarnation,
							},
				ownsCoordination: () => node.owns,
				requestDelegation: (target, database, table, request) => this.#deliverRequest(name, target, request),
				recallDelegation: (target, database, table, recall) => this.#deliverRecall(name, target, recall),
			},
			writeControl: this.writeControlFor(name),
			keyIdOf: (key) => String(key),
			nextTimestamp: () => ++this.tsCounter,
			monotonic: () => node.mono + performance.now(),
			skewMs: options.skewMs,
			grantableAfterMono: options.grantableAfterMono,
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
			if (!node?.alive) return Promise.resolve();
			node.written.push(entry);
			this.#broadcastRelease(name, entry);
			return Promise.resolve();
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
		await this.beforeReply?.(from, to, request);
		return reply;
	}

	async #deliverRecall(from, to, recall) {
		this.recalls.push({ from, to, key: recall.key });
		const target = this.node(to);
		if (!target || !target.alive) throw new Error(`${to} is unreachable`);
		return target.coordinator.onDelegationRecall(recall);
	}

	/** A release entry replicates to every node, as a transaction-log entry does. */
	#broadcastRelease(author, entry) {
		for (const [name, node] of this.nodes) {
			if (name === author || !node.alive) continue;
			node.coordinator.applyEntry(entry, author);
		}
		// The author applies its own entry too, as the local write path does.
		this.node(author).coordinator.applyEntry(entry, author);
	}

	/** The node that homes this key under the current membership. */
	homeOf(key) {
		// The coordinator hashes database ‖ table ‖ key (§4.5); the harness must scope it identically
		// or every keyHomedOn() would pick a different node than the coordinator does.
		return homeFor(ringKeyFor('test', this.table, key), this.members);
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
		it('refuses to acquire with no agreed epoch', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			cluster.node('alpha').epochless = true;
			await assert.rejects(
				() => cluster.node('alpha').coordinator.acquire('k1', LEASE, WAIT),
				/No agreed membership epoch/
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

		it('denies a request whose epoch does not match the home’s', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const reply = await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key, requester: 'alpha', epoch: 99, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'epoch');
			assert.strictEqual(reply.epoch, 1);
		});

		it('denies a request for a key it does not home', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const foreign = cluster.keyHomedOn('gamma');
			const reply = await cluster
				.node('beta')
				.coordinator.onDelegationRequest({ key: foreign, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'not-home');
		});

		it('rejects a malformed inbound request rather than granting on it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			for (const bad of [
				{ key, requester: '', epoch: 1, leaseMs: LEASE },
				{ key: { not: 'encodable' }, requester: 'alpha', epoch: 1, leaseMs: LEASE },
				{ key, requester: 'alpha', epoch: 1, leaseMs: MIN_LOCK_LEASE_MS - 1 },
				{ key, requester: 'alpha', epoch: 1, leaseMs: MAX_LOCK_LEASE_MS + 1 },
			]) {
				const reply = await beta.onDelegationRequest(bad);
				assert.strictEqual(reply.granted, false, `granted on ${JSON.stringify(bad)}`);
			}
			assert.strictEqual(beta.stats.granted, 0);
		});
	});

	describe('fencing tokens', () => {
		it('orders lexicographically by epoch, then incarnation, then counter', () => {
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
				.coordinator.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			// Beta restarts as a home and its counter begins again — the incarnation is what keeps the
			// new token ahead of the old one, which a random value could not do.
			cluster.node('beta').incarnation = 2;
			cluster.node('beta').coordinator.close();
			const fresh = new FakeCluster(['alpha', 'beta', 'gamma']);
			fresh.node('beta').incarnation = 2;
			const key2 = fresh.keyHomedOn('beta');
			const second = await fresh
				.node('beta')
				.coordinator.onDelegationRequest({ key: key2, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			assert.ok(compareTokens(first.token, second.token) < 0);
		});

		it('does not let a stale release clear a newer delegation', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
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
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			beta.applyEntry({ type: 'lockRelease', key, requester: 'gamma', token: granted.token }, 'gamma');
			assert.strictEqual(beta.stats.granted, 1, 'a non-delegate must not be able to clear a grant');
		});

		it('ignores a release whose payload names a node other than its author', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
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
				database: 'test',
				table: cluster.table,
				nodeId: name,
				transport: predecessor.transport,
				writeControl: cluster.writeControlFor(name),
				keyIdOf: (key) => String(key),
				nextTimestamp: () => ++cluster.tsCounter,
				monotonic: () => node.mono + performance.now(),
				adopt: predecessor,
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
			// someone else — the transport's epoch contract covers a process restart, not this.
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta');
			const issued = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				epoch: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(issued.granted, true);
			beta.coordinator.close();

			const replacement = new LockCoordinator({
				database: 'test',
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
			const denied = await replacement.onDelegationRequest({ key, requester: 'gamma', epoch: 1, leaseMs: LEASE });
			assert.strictEqual(denied.granted, false, 'a replacement granted a key alpha still holds');

			// And its tokens must not tie the ones the closed coordinator already issued.
			cluster.advance('beta', DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const regranted = await replacement.onDelegationRequest({ key, requester: 'gamma', epoch: 1, leaseMs: LEASE });
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
			await cluster.node('beta').coordinator.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			// A component reload swaps the transport. The delegation alpha holds is untouched by that,
			// so the successor must not hand the key to gamma.
			const { successor } = replace(cluster, 'beta');
			assert.strictEqual(successor.stats.granted, 1, 'the successor adopted the live grant');
			const reply = await successor.onDelegationRequest({ key, requester: 'gamma', epoch: 1, leaseMs: LEASE });
			assert.strictEqual(reply.granted, false);
			assert.strictEqual(reply.reason, 'contended');
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

		it('does not restart the counter, so a successor token never ties a predecessor’s', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const beta = cluster.node('beta');
			const keyA = cluster.keyHomedOn('beta', 'ca-');
			const first = await beta.coordinator.onDelegationRequest({
				key: keyA,
				requester: 'alpha',
				epoch: 1,
				leaseMs: LEASE,
			});
			const { successor } = replace(cluster, 'beta');
			const keyB = cluster.keyHomedOn('beta', 'cb-');
			const second = await successor.onDelegationRequest({
				key: keyB,
				requester: 'gamma',
				epoch: 1,
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
			await assert.rejects(() => alpha.coordinator.acquire(key, LEASE, 200), /not released in time/);
			assert.strictEqual(alpha.coordinator.stats.delegations, 0, 'a dead reply must not install a delegation');
		});

		it('drops a delegation when the epoch changes under it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key, round.admissionId);
			assert.strictEqual(alpha.stats.delegations, 1);
			// An epoch change may have re-homed the key to a node that knows nothing of this token.
			// Keeping it would let alpha admit alongside whoever the new home grants.
			cluster.epochNumber = 2;
			const requestsBefore = cluster.requests.length;
			await alpha.acquire(key, LEASE, WAIT);
			assert.ok(cluster.requests.length > requestsBefore, 'the stale-epoch delegation was reused');
		});

		it('refuses to grant before an explicitly configured horizon', async () => {
			// Core's grant quarantine is opt-in — the interval belongs to the epoch (see
			// ClusterLockTransport.epoch) — so a deployment that wants a core-side bound sets it.
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
				epoch: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(denied.granted, false, 'a cold home must not grant over an unseen predecessor');
			assert.strictEqual(denied.reason, 'contended');
			cluster.advance('beta', DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1);
			const granted = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'alpha',
				epoch: 1,
				leaseMs: LEASE,
			});
			assert.strictEqual(granted.granted, true);
		});

		it('revokes a REAL handle whose write was staged and then unlocked', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			const round = await alpha.acquire(key, LEASE, WAIT);
			// A real handle wired exactly as Table.ts wires one, not a stub: the production `revokeLease`
			// is what has to fence the staged write, and an earlier version of this test passed a bare
			// callback — so it asserted that the coordinator CALLS a revoker while the real one was a
			// no-op in exactly this state.
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

		it('refuses a grant minted under an epoch that advanced while the reply was in flight', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			// The membership changes after the home granted but before the requester saw the reply. Under
			// the new epoch the key may be homed elsewhere, and that home can already have granted it —
			// so admitting on the epoch-1 token would put two nodes inside one key with no message
			// between them. The acquisition itself should still succeed, by asking again under epoch 2.
			cluster.beforeReply = () => {
				cluster.beforeReply = undefined;
				cluster.epochNumber = 2;
			};
			await alpha.acquire(key, LEASE, WAIT);
			assert.strictEqual(cluster.requests.length, 2, 'the superseded-epoch grant was admitted rather than redone');
			const released = cluster.node('alpha').written.filter((entry) => entry.type === 'lockRelease');
			assert.strictEqual(released.length, 1, 'the stale grant was not handed back');
			assert.strictEqual(released[0].token[0], 1, 'the handed-back token was not the superseded one');
			assert.strictEqual(alpha.stats.delegations, 1);
		});

		it('does not let a release from a previous home incarnation clear a live grant', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
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
			await beta.coordinator.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			// Past the grant's deadline, with tick() deliberately NOT run — a table whose expiry budget
			// is saturated is exactly the case where that happens.
			beta.mono += DELEGATION_LEASE_MS + LOCK_LEASE_SKEW_MS + 1;
			const reply = await beta.coordinator.onDelegationRequest({
				key,
				requester: 'gamma',
				epoch: 1,
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
			// The delegation is replaced while the first handle is still open — an epoch change is the
			// cheapest way to force that here.
			cluster.epochNumber = 2;
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
			await assert.rejects(() => alpha.coordinator.acquire(key, LEASE, 100), /not released in time/);
			alpha.coordinator.transport.requestDelegation = realRequest;
			await alpha.coordinator.acquire(key, LEASE, WAIT);
			assert.strictEqual(alpha.coordinator.stats.delegations, 1);

			// R1 lands at the home NOW. The home sees the same requester and renews IN PLACE, minting a
			// token alpha never receives. R1's cleanup must not release it: the home's grant is what
			// backs the delegation alpha is using, whatever token the home currently records it under.
			await deliverFirst();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(home.stats.granted, 1, 'a live delegation lost the grant backing it');
			const denied = await home.onDelegationRequest({ key, requester: 'gamma', epoch: 1, leaseMs: LEASE });
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
			await assert.rejects(() => alpha.coordinator.acquire(key, LEASE, 100), /not released in time/);
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
					epoch: 1,
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
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			assert.strictEqual(beta.stats.granted, 1);
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'alpha');
			assert.strictEqual(beta.stats.granted, 0);
			const again = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			assert.strictEqual(again.granted, true);
		});
	});

	describe('the release control entry', () => {
		it('round-trips through the private packr', () => {
			for (const key of ['record-1', 42, 9007199254740993n, ['a', 1], [1, ['b']]]) {
				const entry = { type: 'lockRelease', key, requester: 'alpha', token: [1, 2, 7] };
				const decoded = decodeLockControlPayload('lockRelease', encodeLockControlPayload(entry));
				assert.deepStrictEqual(decoded, entry);
			}
		});

		it('rejects a payload that is not the exact three-field tuple', () => {
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 1, 1, 'extra']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', 'not a tuple'), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', '', 1, 1, 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 1, 'not a number']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', [{ bad: 'key' }, 'alpha', 1, 1, 1]), undefined);
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
			const granted = await beta.coordinator.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			beta.owns = false;
			beta.coordinator.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: granted.token }, 'alpha');
			assert.strictEqual(beta.coordinator.stats.granted, 1);
			assert.strictEqual(beta.coordinator.stats.droppedOffOwner, 1);
		});

		it('contains a throw from a failing writer rather than surfacing it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha');
			await alpha.coordinator.acquire(key, LEASE, WAIT);
			alpha.coordinator.applyEntry(null, 'alpha');
			alpha.coordinator.applyEntry({ type: 'lockRelease', key, requester: 'alpha', token: [1, 1, 1] }, null);
			// A malformed entry must not reach the replicated apply loop, which would drop the whole
			// enclosing transaction and stall replication for the database.
			assert.ok(true);
		});
	});
});
