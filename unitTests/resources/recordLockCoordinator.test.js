const assert = require('assert');
const {
	LockCoordinator,
	LOCK_LEASE_SKEW_MS,
	compareTokens,
	decodeLockControlPayload,
	encodeLockControlPayload,
	homeFor,
} = require('#src/resources/recordLockCoordinator');
const { MAX_LOCK_LEASE_MS, MIN_LOCK_LEASE_MS } = require('#src/resources/recordLock');

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
class FakeCluster {
	constructor(nodeNames, options = {}) {
		this.tsCounter = 0;
		this.startedAt = Date.now();
		this.skewMs = options.skewMs ?? LOCK_LEASE_SKEW_MS;
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
			table: 'LockTest',
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
			writeControl: (entry) => {
				if (!node.alive) return Promise.resolve();
				node.written.push(entry);
				this.#broadcastRelease(name, entry);
				return Promise.resolve();
			},
			keyIdOf: (key) => String(key),
			nextTimestamp: () => ++this.tsCounter,
			monotonic: () => node.mono + (Date.now() - this.startedAt),
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
		return target.coordinator.onDelegationRequest(request);
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
		return homeFor(String(key), this.members);
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
			await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key);
			assert.strictEqual(cluster.requests.length, 1);
			for (let i = 0; i < 25; i++) {
				await alpha.acquire(key, LEASE, WAIT);
				alpha.release(key);
			}
			// This is the whole point of the design: releasing the application lock does not release the
			// delegation, so 26 locks cost one round.
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
			await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key);
			// Two thirds through the lease, a fresh full-lease admission no longer fits inside it. An
			// admission that outlived its delegation is exactly what the home's skew margin assumes
			// cannot happen.
			cluster.advance('alpha', 20_000);
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
			await alpha.acquire(key, LEASE, WAIT);
			// Alpha finishes its critical section. The recall arrives, alpha is idle, so it surrenders.
			alpha.release(key);
			const beta = cluster.node('beta').coordinator;
			const round = await beta.acquire(key, LEASE, WAIT);
			assert.ok(round.tsR > 0);
			assert.ok(cluster.node('alpha').written.some((entry) => entry.type === 'lockRelease'));
		});

		it('drains a live admission before the successor is admitted', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha').coordinator;
			await alpha.acquire(key, LEASE, WAIT);
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
			alpha.release(key);
			await betaAcquire;
			assert.strictEqual(betaAdmitted, true);
		});
	});

	describe('independent clocks', () => {
		it('lets the home outwait its delegate even when the two clocks run apart', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { skewMs: 5_000 });
			const key = cluster.keyHomedOn('beta');
			const alpha = cluster.node('alpha').coordinator;
			await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key);
			// Alpha's clock runs past the delegation; beta's has not reached the grant's deadline yet.
			cluster.advance('alpha', LEASE + 1);
			assert.strictEqual(alpha.stats.delegations, 0, 'the delegate must stop admitting first');
			cluster.advance('beta', LEASE + 1);
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
			cluster.advance('beta', LEASE - 1);
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
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', tsR: granted.token[2] - 1 }, 'alpha');
			assert.strictEqual(beta.stats.granted, 1);
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', tsR: granted.token[2] }, 'alpha');
			assert.strictEqual(beta.stats.granted, 0);
		});

		it('ignores a release written by a node that does not hold the grant', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			beta.applyEntry({ type: 'lockRelease', key, requester: 'gamma', tsR: granted.token[2] }, 'gamma');
			assert.strictEqual(beta.stats.granted, 1, 'a non-delegate must not be able to clear a grant');
		});

		it('ignores a release whose payload names a node other than its author', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta').coordinator;
			const granted = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			// The payload is peer-supplied; the author comes from the audit header. They must agree.
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', tsR: granted.token[2] }, 'gamma');
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
				table: 'LockTest',
				nodeId: name,
				transport: predecessor.transport,
				writeControl: () => Promise.resolve(),
				keyIdOf: (key) => String(key),
				nextTimestamp: () => ++cluster.tsCounter,
				monotonic: () => node.mono + (Date.now() - cluster.startedAt),
				adopt: predecessor,
				autoTick: false,
			});
			predecessor.close();
			node.coordinator = successor;
			return { predecessor, successor };
		}

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
			await alpha.acquire(key, LEASE, WAIT);
			alpha.release(key);
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
			beta.applyEntry({ type: 'lockRelease', key, requester: 'alpha', tsR: granted.token[2] }, 'alpha');
			assert.strictEqual(beta.stats.granted, 0);
			const again = await beta.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			assert.strictEqual(again.granted, true);
		});
	});

	describe('the release control entry', () => {
		it('round-trips through the private packr', () => {
			for (const key of ['record-1', 42, 9007199254740993n, ['a', 1], [1, ['b']]]) {
				const entry = { type: 'lockRelease', key, requester: 'alpha', tsR: 7 };
				const decoded = decodeLockControlPayload('lockRelease', encodeLockControlPayload(entry));
				assert.deepStrictEqual(decoded, entry);
			}
		});

		it('rejects a payload that is not the exact three-field tuple', () => {
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 1, 'extra']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', 'not a tuple'), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', '', 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', ['k', 'alpha', 'not a number']), undefined);
			assert.strictEqual(decodeLockControlPayload('lockRelease', [{ bad: 'key' }, 'alpha', 1]), undefined);
		});

		it('no longer decodes the retired Ricart–Agrawala types', () => {
			// Nibbles 9 and 10 were retired rather than migrated; 9 is now eviction. A historical entry
			// replayed from the log must decode to nothing rather than to something this version acts on.
			assert.strictEqual(decodeLockControlPayload('lockRequest', ['k', 'alpha', 1]), undefined);
			assert.strictEqual(decodeLockControlPayload('lockGrant', ['k', 'alpha', 1]), undefined);
		});

		it('is dropped off the coordinating thread rather than applied', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('beta');
			const beta = cluster.node('beta');
			const granted = await beta.coordinator.onDelegationRequest({ key, requester: 'alpha', epoch: 1, leaseMs: LEASE });
			beta.owns = false;
			beta.coordinator.applyEntry({ type: 'lockRelease', key, requester: 'alpha', tsR: granted.token[2] }, 'alpha');
			assert.strictEqual(beta.coordinator.stats.granted, 1);
			assert.strictEqual(beta.coordinator.stats.droppedOffOwner, 1);
		});

		it('contains a throw from a failing writer rather than surfacing it', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma']);
			const key = cluster.keyHomedOn('gamma');
			const alpha = cluster.node('alpha');
			await alpha.coordinator.acquire(key, LEASE, WAIT);
			alpha.coordinator.applyEntry(null, 'alpha');
			alpha.coordinator.applyEntry({ type: 'lockRelease', key, requester: 'alpha', tsR: 1 }, null);
			// A malformed entry must not reach the replicated apply loop, which would drop the whole
			// enclosing transaction and stall replication for the database.
			assert.ok(true);
		});
	});
});
