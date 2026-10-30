// A home that renews a delegation in place for a request its delegate stopped waiting on, and a request
// delivered after a newer one for the same key (harper#3788 follow-ups to harper#3789).
const assert = require('assert');
const {
	LockCoordinator,
	LOCK_LEASE_SKEW_MS,
	DELEGATION_LEASE_MS,
	RESTART_ATTEMPT_MS,
	compareTokens,
	homeFor,
	ringKeyFor,
} = require('#src/resources/recordLockCoordinator');
const { waitFor } = require('../waitFor');

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LEASE = 30_000;
const WAIT = 30_000;

let clusterSequence = 0;

class FakeCluster {
	constructor(nodeNames, options = {}) {
		this.tsCounter = 0;
		this.skewMs = options.skewMs ?? LOCK_LEASE_SKEW_MS;
		this.table = `UnclaimedRenewalLockTest${++clusterSequence}`;
		this.database = options.database ?? `unclaimed_renewal_test_${clusterSequence}_${Date.now()}`;
		this.generation = options.generation ?? 1;
		this.grantableAfterMono = options.grantableAfterMono ?? -Infinity;
		this.homes = [...nodeNames];
		this.nodes = new Map();
		this.requests = [];
		this.replies = [];
		this.recalls = [];
		for (const name of nodeNames) this.#addNode(name, options);
	}

	#addNode(name, options) {
		const node = {
			name,
			alive: true,
			owns: true,
			mono: 0,
			incarnation: options.incarnations?.[name] ?? 1,
			epoch: options.epochs?.[name],
			startedMono: undefined,
			recovering: false,
			writerThrows: false,
			writerCalls: 0,
			writerReturnsVoid: false,
			freshnessCalls: [],
			freshnessError: undefined,
			mapless: false,
			staleMap: false,
			written: [],
			acquire: (...args) => node.coordinator.acquire(...args),
			release: (...args) => node.coordinator.release(...args),
			onDelegationRequest: (...args) => node.coordinator.onDelegationRequest(...args),
			onDelegationRecall: (...args) => node.coordinator.onDelegationRecall(...args),
			quiesce: async (
				result = { complete: true, surrendered: 0, recalled: 0, outstanding: [] },
				remaining = () => 5_000
			) => {
				await node.coordinator.quiesce(result, remaining);
				return result;
			},
		};
		node.coordinator = this.#buildCoordinator(node, { grantableAfterMono: this.grantableAfterMono });
		this.nodes.set(name, node);
		return node;
	}

	#buildCoordinator(node, options) {
		const name = node.name;
		return new LockCoordinator({
			database: this.database,
			table: this.table,
			nodeId: name,
			transport: {
				homeMap: () => {
					if (node.fastFirstAttempt) {
						node.fastFirstAttempt = false;
						node.advanceAfterNextMono = RESTART_ATTEMPT_MS - 15;
					}
					return node.mapless
						? undefined
						: {
								generation: node.staleMap ? 0 : this.generation,
								homes: [...this.homes],
								homeIncarnation: node.incarnation,
							};
				},
				ownsCoordination: () => node.owns,
				requestDelegation: (target, database, table, request) => this.#deliverRequest(name, target, request),
				recallDelegation: (target, database, table, recall) => this.#deliverRecall(name, target, recall),
				establishLockFreshness: (database, table, key, dependencies, deadlineMs) =>
					this.#establishFreshness(name, database, table, key, dependencies, deadlineMs),
				quiescedIncarnation: () => node.quiesced,
				delegateEpoch: () => node.epoch,
				coordinationStartedMono: () => node.startedMono,
				restartRecovering: () => node.recovering,
			},
			writeControl: this.writeControlFor(name),
			keyIdOf: (key) => String(key),
			nextTimestamp: () => ++this.tsCounter,
			monotonic: () => {
				const now = node.mono + performance.now();
				if (node.advanceAfterNextMono) {
					node.mono += node.advanceAfterNextMono;
					node.preAdvanced = (node.preAdvanced ?? 0) + node.advanceAfterNextMono;
					node.advanceAfterNextMono = 0;
				}
				return now;
			},
			skewMs: this.skewMs,
			grantableAfterMono: options.grantableAfterMono,
			autoTick: false,
		});
	}

	node(name) {
		return this.nodes.get(name);
	}

	writeControlFor(name) {
		return (entry) => {
			const node = this.node(name);
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

	advance(name, ms) {
		const node = this.node(name);
		const consumed = node.preAdvanced ?? 0;
		node.preAdvanced = 0;
		node.mono += ms - consumed;
		node.coordinator.tick();
	}

	async #deliverRequest(from, to, request) {
		this.requests.push({ from, to, key: request.key, request });
		const target = this.node(to);
		if (!target || !target.alive) {
			this.onUnreachable?.(from, to);
			throw new Error(`${to} is unreachable`);
		}
		const reply = await target.coordinator.onDelegationRequest(request);
		if (this.duplicateRequests) this.replies.push(await target.coordinator.onDelegationRequest({ ...request }));
		this.replies.push(reply);
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

	#broadcastRelease(author, entry, position) {
		for (const [name, node] of this.nodes) {
			if (name === author || !node.alive) continue;
			node.coordinator.applyEntry(entry, author, position);
		}
	}

	homeOf(key) {
		return homeFor(ringKeyFor(this.database, this.table, key), this.homes);
	}

	keyHomedOn(name, prefix = 'k') {
		for (let i = 0; i < 10_000; i++) {
			const key = `${prefix}${i}`;
			if (this.homeOf(key) === name) return key;
		}
		throw new Error(`no key in the first 10000 homes on ${name}`);
	}
}

/**
 * Alpha holds `key` (homed on gamma) with less than a lease left, then sends a renewal whose caller
 * stops waiting before gamma's reply (an in-place renewal) arrives. `beforeReplyLands` runs on alpha
 * just before that reply is processed. Resolves with the renewed token once the reply has landed.
 */
async function raceRenewalReply(cluster, key, beforeReplyLands) {
	const alpha = cluster.node('alpha');
	const r1 = await alpha.acquire(key, LEASE, WAIT);
	alpha.release(key, r1.admissionId);
	cluster.advance('alpha', DELEGATION_LEASE_MS - LEASE + 1_000);
	let renewalReply;
	let landed;
	const replyLanded = new Promise((resolve) => (landed = resolve));
	cluster.beforeReply = async (from, to, _request, reply) => {
		if (from !== 'alpha' || to !== 'gamma') return;
		cluster.beforeReply = undefined;
		renewalReply = reply;
		cluster.advance('alpha', 100);
		await delayMs(60);
		beforeReplyLands?.();
		landed();
	};
	await assert.rejects(
		() => alpha.acquire(key, LEASE, 40),
		(error) => error.statusCode === 423 || error.statusCode === 503
	);
	await replyLanded;
	await delayMs(20);
	return renewalReply.token;
}

describe('recordLockCoordinator: unclaimed in-place renewals and out-of-order request ids', function () {
	this.timeout(30_000);

	describe("a renewal during the retry's barrier, and an older request while the newer grant is held", () => {
		it("releases the renewed token when a delayed untagged attempt renews in place during the retry's freshness barrier", async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const gamma = cluster.node('gamma');
			const key = cluster.keyHomedOn('gamma');

			// Prior grant on beta released so gamma's next grant to alpha has non-empty dependencies (beforeFreshness fires).
			const previous = await beta.acquire(key, LEASE, WAIT);
			beta.release(key, previous.admissionId);
			await beta.quiesce();

			const original = alpha.coordinator.transport.requestDelegation;
			let attempts = 0;
			let deliverFirst;
			alpha.fastFirstAttempt = true;
			alpha.coordinator.transport.requestDelegation = (...args) => {
				if (++attempts === 1) {
					cluster.advance('alpha', RESTART_ATTEMPT_MS + 100);
					return new Promise((resolve) => {
						deliverFirst = () => original(...args).then(resolve);
					});
				}
				return original(...args);
			};

			let releaseBarrier;
			cluster.beforeFreshness = (name) => {
				if (name !== 'alpha') return;
				cluster.beforeFreshness = undefined;
				return new Promise((resolve) => {
					releaseBarrier = resolve;
				});
			};

			// Older build wire behavior: strip requestId and delegateEpoch.
			const realOnRequest = gamma.coordinator.onDelegationRequest.bind(gamma.coordinator);
			gamma.coordinator.onDelegationRequest = async (request) =>
				realOnRequest({ ...request, requestId: undefined, delegateEpoch: undefined });

			const round = alpha.acquire(key, LEASE, WAIT);
			await waitFor(() => releaseBarrier !== undefined, 10_000);
			const t1 = cluster.replies.at(-1).token;

			const repliedBefore = cluster.replies.length;
			deliverFirst();
			await waitFor(() => cluster.replies.length > repliedBefore, 10_000);
			const t2 = cluster.replies.at(-1).token;
			assert.ok(compareTokens(t2, t1) > 0, 'expected delayed untagged attempt to renew in place to T2 > T1');
			await delayMs(30);

			releaseBarrier();
			const admitted = await round;
			assert.ok(admitted.tsR > 0);
			alpha.release(key, admitted.admissionId);

			await alpha.quiesce();
			const releases = alpha.written.filter((e) => e.type === 'lockRelease');
			const lastRelease = releases.at(-1);
			assert.ok(lastRelease, 'expected alpha.quiesce() to write lockRelease');
			assert.strictEqual(compareTokens(lastRelease.token, t2), 0);

			const betaAdmitted = await beta.acquire(key, LEASE, 250);
			assert.ok(betaAdmitted.tsR > 0);
			beta.release(key, betaAdmitted.admissionId);
		});

		it('refuses an older request as stale while the same delegate holds the newer grant', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const gamma = cluster.node('gamma');
			const key = cluster.keyHomedOn('gamma');

			const original = alpha.coordinator.transport.requestDelegation;
			let attempts = 0;
			let firstReq;
			alpha.fastFirstAttempt = true;
			alpha.coordinator.transport.requestDelegation = (target, database, table, request) => {
				if (++attempts === 1) {
					firstReq = { ...request };
					cluster.advance('alpha', RESTART_ATTEMPT_MS + 100);
					return new Promise(() => {});
				}
				return original(target, database, table, request);
			};

			const r1 = await alpha.acquire(key, LEASE, WAIT);
			assert.ok(r1.tsR > 0);
			const t1 = cluster.replies.at(-1).token;
			assert.deepStrictEqual(t1, [1, 1, 1]);
			alpha.release(key, r1.admissionId);

			const staleReply = await gamma.onDelegationRequest(firstReq);
			assert.deepStrictEqual(staleReply, {
				granted: false,
				reason: 'stale',
				requestId: firstReq.requestId,
			});

			await alpha.quiesce();
			const lastRelease = alpha.written.filter((e) => e.type === 'lockRelease').at(-1);
			assert.deepStrictEqual(lastRelease.token, t1);

			const rBeta = await beta.acquire(key, LEASE, 250);
			assert.ok(rBeta.tsR > 0);
			beta.release(key, rBeta.admissionId);
		});
	});

	describe('a renewal the delegate stopped waiting on, while it holds the key', () => {
		it('adopts the renewed token from a timed-out renewal, so quiesce releases what the home holds', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const gamma = cluster.node('gamma');
			const key = cluster.keyHomedOn('gamma');

			// Alpha holds T1 = [1, 1, 1] with no handle open.
			const r1 = await alpha.acquire(key, LEASE, WAIT);
			const t1 = cluster.replies.at(-1).token;
			assert.deepStrictEqual(t1, [1, 1, 1]);
			alpha.release(key, r1.admissionId);

			// Leave T1 less than LEASE, so the next acquire asks gamma to renew.
			cluster.advance('alpha', DELEGATION_LEASE_MS - LEASE + 1_000);

			let resolveBeforeReplyFinished;
			const beforeReplyFinished = new Promise((resolve) => {
				resolveBeforeReplyFinished = resolve;
			});
			let renewalReply;
			cluster.beforeReply = async (from, to, _request, reply) => {
				if (from === 'alpha' && to === 'gamma') {
					cluster.beforeReply = undefined;
					renewalReply = reply;
					cluster.advance('alpha', 100);
					await delayMs(60);
					resolveBeforeReplyFinished();
				}
			};

			// A 40ms wait against a 60ms reply: the caller gives up while alpha still holds T1, and the
			// renewal's reply arrives unclaimed.
			await assert.rejects(
				() => alpha.acquire(key, LEASE, 40),
				(err) => err.statusCode === 423 || err.statusCode === 503
			);

			await beforeReplyFinished;
			await delayMs(20);
			const t2 = renewalReply.token;
			assert.deepStrictEqual(t2, [1, 1, 2]);

			await alpha.quiesce();
			const lastRelease = alpha.written.filter((e) => e.type === 'lockRelease').at(-1);
			assert.ok(lastRelease, 'expected alpha.quiesce() to write a lockRelease control entry');

			let betaErr;
			let rBeta;
			try {
				rBeta = await beta.acquire(key, LEASE, 250);
			} catch (err) {
				betaErr = err;
			}
			if (rBeta) beta.release(key, rBeta.admissionId);

			let gammaErr;
			let rGamma;
			try {
				rGamma = await gamma.acquire(key, LEASE, 250);
			} catch (err) {
				gammaErr = err;
			}
			if (rGamma) gamma.release(key, rGamma.admissionId);

			assert.deepStrictEqual(
				lastRelease.token,
				t2,
				`expected alpha.quiesce() lockRelease to carry renewed T2=${JSON.stringify(t2)}, but got stale T1=${JSON.stringify(lastRelease.token)} (subsequent beta.acquire threw ${betaErr?.statusCode}: ${betaErr?.message}; gamma.acquire threw ${gammaErr?.statusCode}: ${gammaErr?.message})`
			);
			assert.ifError(betaErr);
			assert.ifError(gammaErr);
		});

		it('surrenders a draining recall under a renewed token that landed during the drain', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const key = cluster.keyHomedOn('gamma');

			// Alpha holds T1 = [1, 1, 1] with r1 still open.
			const r1 = await alpha.acquire(key, LEASE, WAIT);
			const t1 = cluster.replies.at(-1).token;
			assert.deepStrictEqual(t1, [1, 1, 1]);

			// Leave T1 less than LEASE while r1 is still open.
			cluster.advance('alpha', DELEGATION_LEASE_MS - LEASE + 1_000);

			const original = alpha.coordinator.transport.requestDelegation;
			let releaseRenewalReply;
			let renewalGrantedOnHome;
			const renewalGrantedPromise = new Promise((resolve) => {
				renewalGrantedOnHome = resolve;
			});
			alpha.coordinator.transport.requestDelegation = async (target, database, table, request) => {
				const reply = await original(target, database, table, request);
				cluster.advance('alpha', 100);
				renewalGrantedOnHome(reply);
				await new Promise((resolve) => {
					releaseRenewalReply = resolve;
				});
				return reply;
			};

			const secondAcquire = alpha.acquire(key, LEASE, 40);
			secondAcquire.catch(() => {});
			const renewalReply = await renewalGrantedPromise;
			const t2 = renewalReply.token;
			assert.deepStrictEqual(t2, [1, 1, 2]);

			await delayMs(60);
			await assert.rejects(secondAcquire, (err) => err.statusCode === 423 || err.statusCode === 503);

			// Recall T1 while r1 is open: the recall waits for r1 to drain.
			let recallDone = false;
			const recallPromise = alpha.onDelegationRecall({ key, token: t1 }).then(() => {
				recallDone = true;
			});
			await delayMs(20);
			assert.strictEqual(recallDone, false, 'recall should be waiting on local holder r1 to release');

			// The unclaimed T2 reply lands during that drain.
			releaseRenewalReply();
			await delayMs(20);

			alpha.release(key, r1.admissionId);
			await recallPromise;

			const lastRelease = alpha.written.filter((e) => e.type === 'lockRelease').at(-1);
			assert.ok(lastRelease, 'expected #recallHeld to write a lockRelease entry');

			let betaErr;
			let rBeta;
			try {
				rBeta = await beta.acquire(key, LEASE, 250);
			} catch (err) {
				betaErr = err;
			}

			assert.deepStrictEqual(
				lastRelease.token,
				t2,
				`expected #recallHeld to surrender renewed T2=${JSON.stringify(t2)}, but surrendered stale T1=${JSON.stringify(lastRelease.token)} (subsequent beta.acquire threw ${betaErr?.statusCode}: ${betaErr?.message})`
			);
			assert.ifError(betaErr);
			beta.release(key, rBeta.admissionId);
		});

		it('adopts the renewed token when a delayed untagged first attempt lands after the retry installed', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const gamma = cluster.node('gamma');
			const key = cluster.keyHomedOn('gamma');

			// Rolling-upgrade untagged wire setup: strip requestId and delegateEpoch on gamma.
			const realOnRequest = gamma.coordinator.onDelegationRequest.bind(gamma.coordinator);
			gamma.coordinator.onDelegationRequest = async (request) =>
				realOnRequest({ ...request, requestId: undefined, delegateEpoch: undefined });

			const original = alpha.coordinator.transport.requestDelegation;
			let attempts = 0;
			let deliverFirst;
			alpha.fastFirstAttempt = true;
			alpha.coordinator.transport.requestDelegation = (...args) => {
				if (++attempts === 1) {
					cluster.advance('alpha', RESTART_ATTEMPT_MS + 100);
					return new Promise((resolve) => {
						deliverFirst = () => {
							const p = original(...args);
							p.then(resolve);
							return p;
						};
					});
				}
				return original(...args);
			};

			// The retry is granted T1 = [1, 1, 1] and installs it.
			const r1 = await alpha.acquire(key, LEASE, WAIT);
			const t1 = cluster.replies.at(-1).token;
			assert.deepStrictEqual(t1, [1, 1, 1]);
			alpha.release(key, r1.admissionId);

			// The delayed first attempt reaches gamma, which renews in place to T2 = [1, 1, 2]; nobody on
			// alpha is waiting for that reply.
			const firstReply = await deliverFirst();
			const t2 = firstReply.token;
			assert.deepStrictEqual(t2, [1, 1, 2]);
			await delayMs(20);

			await alpha.quiesce();
			const lastRelease = alpha.written.filter((e) => e.type === 'lockRelease').at(-1);
			assert.ok(lastRelease, 'expected alpha.quiesce() to write lockRelease');

			let betaErr;
			let rBeta;
			try {
				rBeta = await beta.acquire(key, LEASE, 250);
			} catch (err) {
				betaErr = err;
			}

			assert.deepStrictEqual(
				lastRelease.token,
				t2,
				`expected alpha.quiesce() to write lockRelease(T2=${JSON.stringify(t2)}), but wrote stale T1=${JSON.stringify(lastRelease.token)} (subsequent beta.acquire threw ${betaErr?.statusCode}: ${betaErr?.message})`
			);
			assert.ifError(betaErr);
			beta.release(key, rBeta.admissionId);
		});
	});

	describe('an older request delivered after a newer one for the same key', () => {
		it('is stale after the newer grant moved to a contender or was released', async () => {
			const cluster3a = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha3a = cluster3a.node('alpha');
			const beta3a = cluster3a.node('beta');
			const gamma3a = cluster3a.node('gamma');
			const key1 = cluster3a.keyHomedOn('gamma', 'k3a-');

			const orig3a = alpha3a.coordinator.transport.requestDelegation;
			let attempts3a = 0;
			let firstReq3a;
			alpha3a.fastFirstAttempt = true;
			alpha3a.coordinator.transport.requestDelegation = (target, database, table, request) => {
				if (++attempts3a === 1) {
					firstReq3a = { ...request };
					cluster3a.advance('alpha', RESTART_ATTEMPT_MS + 100);
					return new Promise(() => {});
				}
				return orig3a(target, database, table, request);
			};

			const cluster3b = new FakeCluster(['alpha', 'beta', 'gamma'], {
				epochs: { alpha: 1, beta: 1, gamma: 1 },
			});
			const alpha3b = cluster3b.node('alpha');
			const beta3b = cluster3b.node('beta');
			const gamma3b = cluster3b.node('gamma');
			const key2 = cluster3b.keyHomedOn('gamma', 'k3b-');

			const orig3b = alpha3b.coordinator.transport.requestDelegation;
			let attempts3b = 0;
			let firstReqKey2;
			alpha3b.fastFirstAttempt = true;
			alpha3b.coordinator.transport.requestDelegation = (target, database, table, request) => {
				if (++attempts3b === 1) {
					firstReqKey2 = { ...request };
					cluster3b.advance('alpha', RESTART_ATTEMPT_MS + 100);
					return new Promise(() => {});
				}
				return orig3b(target, database, table, request);
			};

			const [rAlpha, rAlphaKey2] = await Promise.all([
				alpha3a.acquire(key1, LEASE, WAIT),
				alpha3b.acquire(key2, LEASE, WAIT),
			]);
			const t1 = cluster3a.replies.at(-1).token;
			assert.deepStrictEqual(t1, [1, 1, 1]);
			alpha3a.release(key1, rAlpha.admissionId);

			const rBeta = await beta3a.acquire(key1, LEASE, 250);
			const t2 = cluster3a.replies.at(-1).token;
			assert.deepStrictEqual(t2, [1, 1, 2]);
			beta3a.release(key1, rBeta.admissionId);
			assert.strictEqual(cluster3a.recalls.length, 1);

			const lateReply3a = await gamma3a.onDelegationRequest(firstReq3a);
			await delayMs(20);
			const recallsAfter3a = cluster3a.recalls.length;

			const betaRequestsBefore = cluster3a.requests.filter((r) => r.from === 'beta').length;
			const rBetaCached = await beta3a.acquire(key1, LEASE, 250);
			beta3a.release(key1, rBetaCached.admissionId);
			const betaExtraRequests = cluster3a.requests.filter((r) => r.from === 'beta').length - betaRequestsBefore;

			// Release alpha's newer grant on key2 so gamma holds none.
			alpha3b.release(key2, rAlphaKey2.admissionId);
			await alpha3b.quiesce();
			assert.strictEqual(gamma3b.coordinator.stats.granted, 0);

			const lateReply3b = await gamma3b.onDelegationRequest(firstReqKey2);
			let beta3bErr;
			let rBetaKey2;
			try {
				rBetaKey2 = await beta3b.acquire(key2, LEASE, 250);
			} catch (err) {
				beta3bErr = err;
			}
			if (rBetaKey2) beta3b.release(key2, rBetaKey2.admissionId);

			assert.deepStrictEqual(
				lateReply3a,
				{ granted: false, reason: 'stale', requestId: firstReq3a.requestId },
				`after transfer expected stale refusal for older requestId, got ${JSON.stringify(lateReply3a)} (recalls=${recallsAfter3a}, betaExtraRequests=${betaExtraRequests}); ` +
					`after release got ${JSON.stringify(lateReply3b)} (beta.acquire threw ${beta3bErr?.statusCode}: ${beta3bErr?.message})`
			);
			assert.strictEqual(recallsAfter3a, 1, 'after transfer: delayed older requestId must not recall contender beta');
			assert.strictEqual(betaExtraRequests, 0, 'after transfer: beta cached delegation T2 must remain intact');

			assert.deepStrictEqual(
				lateReply3b,
				{ granted: false, reason: 'stale', requestId: firstReqKey2.requestId },
				`after release expected stale refusal for older requestId after release, got ${JSON.stringify(lateReply3b)} (beta.acquire threw ${beta3bErr?.statusCode}: ${beta3bErr?.message})`
			);
			assert.ifError(beta3bErr);
		});
	});
	describe('renewal adopted onto a held delegation, at its local deadline', () => {
		it('releases the adopted token when the delegation expires locally, so a later contender is not refused until the home lease', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { epochs: { alpha: 1, beta: 1, gamma: 1 } });
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const key = cluster.keyHomedOn('gamma');
			const renewed = await raceRenewalReply(cluster, key);
			assert.deepStrictEqual(renewed, [1, 1, 2]);
			assert.strictEqual(alpha.written.filter((entry) => entry.type === 'lockRelease').length, 0);

			// Past alpha's original deadline; gamma's renewed grant has most of a lease left.
			cluster.advance('alpha', LEASE);
			await waitFor(() => alpha.written.some((entry) => entry.type === 'lockRelease'), 2_000);
			const release = alpha.written.find((entry) => entry.type === 'lockRelease');
			assert.deepStrictEqual(release.token, renewed);
			assert.notStrictEqual(release.dependencies, null, 'a surrender carries the delegation lineage');
			assert.strictEqual(alpha.coordinator.stats.delegations, 0);

			const round = await beta.acquire(key, LEASE, 250);
			beta.release(key, round.admissionId);
		});

		it('hands the token back rather than adopting it when the held delegation has already expired locally', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { epochs: { alpha: 1, beta: 1, gamma: 1 } });
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const key = cluster.keyHomedOn('gamma');
			// Alpha's clock passes its deadline without a tick collecting the delegation: the home may have
			// expired its grant too, so the renewed token may be a fresh grant it must not adopt.
			const renewed = await raceRenewalReply(cluster, key, () => (alpha.mono += LEASE));
			assert.deepStrictEqual(renewed, [1, 1, 2]);
			await waitFor(() => alpha.written.some((entry) => entry.type === 'lockRelease'), 2_000);
			const release = alpha.written.find((entry) => entry.type === 'lockRelease');
			assert.deepStrictEqual(release.token, renewed);
			assert.strictEqual(release.dependencies, null, 'an unclaimed handback names no lineage');
			assert.strictEqual(alpha.coordinator.stats.delegations, 0);

			const round = await beta.acquire(key, LEASE, 250);
			beta.release(key, round.admissionId);
		});
		it('releases a token adopted during the freshness barrier once the delegation expires locally', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { epochs: { alpha: 1, beta: 1, gamma: 1 } });
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const gamma = cluster.node('gamma');
			const key = cluster.keyHomedOn('gamma');
			// A prior holder gives alpha's grant a lineage, so its freshness barrier runs and can be held open.
			const previous = await beta.acquire(key, LEASE, WAIT);
			beta.release(key, previous.admissionId);
			await beta.quiesce();

			const original = alpha.coordinator.transport.requestDelegation;
			let attempts = 0;
			let deliverFirst;
			alpha.fastFirstAttempt = true;
			alpha.coordinator.transport.requestDelegation = (...args) => {
				if (++attempts === 1) {
					cluster.advance('alpha', RESTART_ATTEMPT_MS + 100);
					return new Promise((resolve) => (deliverFirst = () => original(...args).then(resolve)));
				}
				return original(...args);
			};
			let releaseBarrier;
			cluster.beforeFreshness = (name) => {
				if (name !== 'alpha') return;
				cluster.beforeFreshness = undefined;
				return new Promise((resolve) => (releaseBarrier = resolve));
			};
			// An untagged home renews in place for the delayed first attempt.
			const realOnRequest = gamma.coordinator.onDelegationRequest.bind(gamma.coordinator);
			gamma.coordinator.onDelegationRequest = async (request) =>
				realOnRequest({ ...request, requestId: undefined, delegateEpoch: undefined });

			const round = alpha.acquire(key, LEASE, WAIT);
			await waitFor(() => releaseBarrier !== undefined, 10_000);
			const repliedBefore = cluster.replies.length;
			deliverFirst();
			await waitFor(() => cluster.replies.length > repliedBefore, 10_000);
			const renewed = cluster.replies.at(-1).token;
			await delayMs(30);
			releaseBarrier();
			const admitted = await round;
			alpha.release(key, admitted.admissionId);
			assert.strictEqual(alpha.written.filter((entry) => entry.type === 'lockRelease').length, 0);

			cluster.advance('alpha', DELEGATION_LEASE_MS);
			await waitFor(() => alpha.written.some((entry) => entry.type === 'lockRelease'), 2_000);
			assert.deepStrictEqual(alpha.written.find((entry) => entry.type === 'lockRelease').token, renewed);
		});
	});

	describe('a renewal reply landing on a recalled delegation already past its deadline', () => {
		it('hands the token back with no lineage instead of surrendering it under the old delegation', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { epochs: { alpha: 1, beta: 1, gamma: 1 } });
			const alpha = cluster.node('alpha');
			const beta = cluster.node('beta');
			const key = cluster.keyHomedOn('gamma');
			const r1 = await alpha.acquire(key, LEASE, WAIT);
			const t1 = cluster.replies.at(-1).token;
			cluster.advance('alpha', DELEGATION_LEASE_MS - LEASE + 1_000);

			const original = alpha.coordinator.transport.requestDelegation;
			let returnRenewalReply;
			let renewalGranted;
			const granted = new Promise((resolve) => (renewalGranted = resolve));
			alpha.coordinator.transport.requestDelegation = async (...args) => {
				const reply = await original(...args);
				cluster.advance('alpha', 100);
				renewalGranted(reply);
				await new Promise((resolve) => (returnRenewalReply = resolve));
				return reply;
			};
			const secondAcquire = alpha.acquire(key, LEASE, 40);
			secondAcquire.catch(() => {});
			const t2 = (await granted).token;
			await delayMs(60);
			await assert.rejects(secondAcquire, (error) => error.statusCode === 423 || error.statusCode === 503);

			let recallDone = false;
			const recall = alpha.onDelegationRecall({ key, token: t1 }).then(() => (recallDone = true));
			await delayMs(20);
			assert.strictEqual(recallDone, false, 'the recall waits for r1');
			// Alpha stalls past its deadline before the reply is processed: the home may have expired the
			// grant and minted the renewed token afresh for alpha with another holder's lineage behind it.
			alpha.mono += LEASE;
			returnRenewalReply();
			await Promise.race([recall, delayMs(2_000).then(() => assert.fail('the recall did not drain'))]);
			alpha.release(key, r1.admissionId);

			const releases = alpha.written.filter((entry) => entry.type === 'lockRelease');
			const forT2 = releases.filter((entry) => compareTokens(entry.token, t2) === 0);
			assert.strictEqual(forT2.length, 1, JSON.stringify(releases));
			assert.strictEqual(forT2[0].dependencies, null, 'the old delegation lineage must not vouch for the new token');

			const round = await beta.acquire(key, LEASE, 250);
			beta.release(key, round.admissionId);
		});
	});

	describe('request ordering is per key', () => {
		it('still grants an older, unseen request for a different key', async () => {
			const cluster = new FakeCluster(['alpha', 'beta', 'gamma'], { epochs: { alpha: 1, beta: 1, gamma: 1 } });
			const gamma = cluster.node('gamma');
			const first = cluster.keyHomedOn('gamma', 'a-');
			const second = cluster.keyHomedOn('gamma', 'b-');
			const request = (key, requestId) => ({
				key,
				requester: 'alpha',
				generation: 1,
				leaseMs: LEASE,
				requestId,
				delegateEpoch: 1,
			});
			const base = 1_000_000;
			assert.strictEqual((await gamma.onDelegationRequest(request(first, base + 2))).granted, true);
			assert.strictEqual((await gamma.onDelegationRequest(request(second, base + 1))).granted, true);
		});
	});
});
