require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { setAbortMarkersForTests, setWriteIntentsForTests } = require('#src/resources/transactionLogAbortMarkers');
const { Transaction, constants } = require('@harperfast/rocksdb-js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Audit chain across a conflict retry', function () {
	this.timeout(20000);
	let T, origin, peerOrigin, dbPath;

	before(function () {
		if (isLMDB) return;
		dbPath = setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'RetryAuditChain',
			database: 'retryAuditChain',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'meta' }, { name: 'other' }],
			audit: true,
		});
		origin = getIdOfRemoteNode('retry-audit-chain-origin', T.auditStore);
		peerOrigin = getIdOfRemoteNode('retry-audit-chain-origin-b', T.auditStore);
	});

	beforeEach(function () {
		if (isLMDB) this.skip();
	});

	// One transaction from one named origin, so each write's version is its log key and every entry lands
	// in that origin's log. Future clocks: a write below the audit floor skips the walk.
	function applyFromOrigin(version, ...writes) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			for (const [id, write] of writes) {
				const resource = await T.getResource(id, context);
				await write(resource, { isNotification: true, nodeId: origin, version });
			}
		});
	}
	const patch = (id, record) => [id, (resource, options) => resource._writeUpdate(id, record, false, options)];
	const put = (id, record) => [id, (resource, options) => resource._writeUpdate(id, record, true, options)];

	function interceptNextCommit(around) {
		const db = T.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		const observed = { retried: false };
		let intercepted;
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db !== db) return originalCommit.apply(this, args);
			if (intercepted === undefined) {
				intercepted = this;
				return around(() => originalCommit.apply(this, args));
			}
			if (this === intercepted) observed.retried = true;
			return originalCommit.apply(this, args);
		};
		observed.restore = () => {
			Transaction.prototype.commit = originalCommit;
		};
		return observed;
	}

	async function retryOverIntermediateHead(id, base, ...retried) {
		await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
		const interception = interceptNextCommit(async (commit) => {
			await applyFromOrigin(base + 200, patch(id, { title: 'intermediate' }));
			return commit();
		});
		try {
			await applyFromOrigin(base + 300, ...retried);
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
	}
	const refsOf = (id) => T.primaryStore.getEntry(id).additionalAuditRefs ?? [];
	const namesHead = (id, version, nodeId = origin) =>
		refsOf(id).some((ref) => ref.version === version && ref.nodeId === nodeId);
	let nextBase = Date.now() + 86_400_000;
	const freshBase = () => (nextBase += 86_400_000);

	it('walks a newer committed entry while its own uncommitted entry holds the log watermark', async () => {
		const id = 'watermark';
		const base = freshBase();
		await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
		const interception = interceptNextCommit(async (commit) => {
			// lands after this transaction's snapshot, so its first commit conflicts after appending its entry
			await applyFromOrigin(base + 100, patch(id, { other: 'conflict' }));
			try {
				return await commit();
			} finally {
				// commits while the entry above is appended but not committed
				await applyFromOrigin(base + 300, patch(id, { title: 'newer' }));
			}
		});
		try {
			await applyFromOrigin(base + 200, patch(id, { title: 'older', meta: 'older' }));
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
		const { title, meta, other } = await T.get(id);
		assert.deepStrictEqual({ title, meta, other }, { title: 'newer', meta: 'older', other: 'conflict' });
	});

	it('replays newer patches over an out-of-order put while its own uncommitted entry holds the watermark', async () => {
		const id = 'watermark-put';
		const base = freshBase();
		await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
		const interception = interceptNextCommit(async (commit) => {
			await applyFromOrigin(base + 100, patch(id, { other: 'conflict' }));
			try {
				return await commit();
			} finally {
				await applyFromOrigin(base + 300, patch(id, { title: 'newer' }));
			}
		});
		try {
			await applyFromOrigin(base + 200, put(id, { id, title: 'older', meta: 'older' }));
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
		const { title, meta, other } = await T.get(id);
		assert.deepStrictEqual({ title, meta, other }, { title: 'newer', meta: 'older', other: undefined });
	});

	it('keeps the head an in-order retry committed over reachable from the record', async () => {
		const id = 'intermediate';
		const base = freshBase();
		await retryOverIntermediateHead(id, base, patch(id, { meta: 'retried' }));
		assert(namesHead(id, base + 200), 'the record names the head the retry committed over');
		await applyFromOrigin(base + 100, patch(id, { title: 'older' }));
		const { title, meta } = await T.get(id);
		assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
	});

	for (const [kind, write] of [
		['publish', (id) => [id, (resource, options) => resource._writePublish(id, { message: 'm' }, options)]],
		['relocate', (id) => [id, (resource, options) => resource._writeRelocate(id, options)]],
	]) {
		it(`keeps the head an in-order ${kind} retry committed over reachable from the record`, async () => {
			const id = `intermediate-${kind}`;
			const base = freshBase();
			await retryOverIntermediateHead(id, base, write(id));
			assert(namesHead(id, base + 200), 'the record names the head the retry committed over');
			await applyFromOrigin(base + 100, patch(id, { title: 'older' }));
			assert.strictEqual((await T.get(id)).title, 'intermediate');
		});
	}

	it('keeps the head an in-order invalidate retry committed over reachable from the record', async () => {
		const id = 'intermediate-invalidate';
		const base = freshBase();
		await retryOverIntermediateHead(id, base, [
			id,
			(resource, options) => resource._writeInvalidate(id, undefined, options),
		]);
		assert(namesHead(id, base + 200), 'the record names the head the retry committed over');
	});

	it('keeps the earlier write’s ref when a retried transaction writes the key twice', async () => {
		const id = 'chained';
		const base = freshBase();
		await retryOverIntermediateHead(id, base, patch(id, { meta: 'retried' }), patch(id, { other: 'second' }));
		assert(namesHead(id, base + 200), 'the record names the head the retry committed over');
		await applyFromOrigin(base + 100, patch(id, { title: 'older' }));
		const { title, meta, other } = await T.get(id);
		assert.deepStrictEqual({ title, meta, other }, { title: 'intermediate', meta: 'retried', other: 'second' });
	});

	it('adds no ref to a record whose base did not move when the conflict was on another key', async () => {
		const base = freshBase();
		await applyFromOrigin(base, put('unmoved', { id: 'unmoved', title: 'seed' }), put('moved', { id: 'moved' }));
		const interception = interceptNextCommit(async (commit) => {
			await applyFromOrigin(base + 200, patch('moved', { title: 'intermediate' }));
			return commit();
		});
		try {
			await applyFromOrigin(base + 300, patch('unmoved', { meta: 'retried' }), patch('moved', { meta: 'retried' }));
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
		assert.deepStrictEqual(refsOf('unmoved'), []);
		assert(namesHead('moved', base + 200), 'the record names the head the retry committed over');
	});

	it('keeps an equal-version head from another origin when the retry commits over it', async () => {
		const id = 'equal-version-peer';
		const base = freshBase();
		await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
		const interception = interceptNextCommit(async (commit) => {
			const context = { source: {}, sourceApply: true, timestamp: base };
			await transaction(context, async () => {
				const resource = await T.getResource(id, context);
				await resource._writeUpdate(id, { title: 'intermediate' }, false, {
					isNotification: true,
					nodeId: peerOrigin,
					version: base,
				});
			});
			return commit();
		});
		try {
			await applyFromOrigin(base + 300, patch(id, { meta: 'retried' }));
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
		assert(namesHead(id, base, peerOrigin), 'the record names the equal-version peer head');
		await applyFromOrigin(base - 100, patch(id, { title: 'older' }));
		const { title, meta } = await T.get(id);
		assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
	});

	it('keeps the head a local-origin retry with a minted log key committed over reachable from the record', async () => {
		const id = 'local-minted';
		const base = freshBase();
		await T.put({ id, title: 'seed', meta: 'seed' }, { timestamp: base });
		const interception = interceptNextCommit(async (commit) => {
			await T.patch(id, { title: 'intermediate' }, { timestamp: base + 200 });
			return commit();
		});
		try {
			await T.patch(id, { meta: 'retried' }, { timestamp: base + 300 });
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
		await T.patch(id, { title: 'older' }, { timestamp: base + 100 });
		const { title, meta } = await T.get(id);
		assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
	});

	it('keeps the head created between attempts when attempt 1 staged against an absent record', async () => {
		const id = 'created-between';
		const base = freshBase();
		const interception = interceptNextCommit(async (commit) => {
			await applyFromOrigin(base + 200, put(id, { id, title: 'intermediate', meta: 'seed' }));
			return commit();
		});
		try {
			await applyFromOrigin(base + 300, patch(id, { meta: 'retried' }));
		} finally {
			interception.restore();
		}
		assert(interception.retried, 'the write must have retried');
		assert(namesHead(id, base + 200), 'the record names the head created between attempts');
		await applyFromOrigin(base + 100, patch(id, { title: 'older' }));
		const { title, meta } = await T.get(id);
		assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
	});

	it('adds no ref when replay restages a local patch over an unmoved remote-origin base', async () => {
		const id = 'replayed-unmoved-remote';
		const base = freshBase();
		await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
		const context = { timestamp: base + 200 };
		await transaction(context, async () => {
			context.transaction.isReplay = true;
			context.transaction.retries = 1;
			context.transaction.timestamp = base + 200;
			const resource = await T.getResource(id, context);
			await resource._writeUpdate(id, { meta: 'replayed' }, false, {
				isReplay: true,
				nodeId: 0,
				version: base + 200,
				auditEntry: { type: 'patch', version: base + 200, previousVersion: base },
			});
		});
		assert(!namesHead(id, base, origin), 'replay over an unmoved remote base adds no ref to it');
		assert.deepStrictEqual(refsOf(id), []);
	});

	it('adds no ref when a retry re-logs its entry after a pre-log refusal', async () => {
		const id = 'relogged';
		const base = freshBase();
		await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
		const priorIntents = setWriteIntentsForTests(true);
		const db = T.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		const attempts = [];
		let releaseHolder, markHolderStaged, holderId;
		const holderGate = new Promise((resolve) => (releaseHolder = resolve));
		const holderStaged = new Promise((resolve) => (markHolderStaged = resolve));
		try {
			const holderContext = { source: {}, sourceApply: true, timestamp: base + 200 };
			const holder = transaction(holderContext, async () => {
				const resource = await T.getResource(id, holderContext);
				await resource._writeUpdate(id, { title: 'intermediate' }, false, {
					isNotification: true,
					nodeId: origin,
					version: base + 200,
				});
				const write = holderContext.transaction.writes.find((candidate) => candidate.key === id);
				await holderContext.transaction.save(write);
				holderId = holderContext.transaction.transaction.id;
				markHolderStaged();
				await holderGate;
			});
			await holderStaged;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== db || this.id === holderId) return originalCommit.apply(this, args);
				if (attempts.length === 0) this.setParkDeadline(1);
				const result = await originalCommit.apply(this, args);
				attempts.push({ logWritten: this.logWritten() });
				if (attempts.length === 1) {
					this.setParkDeadline(0);
					releaseHolder();
					await holder;
				}
				return result;
			};
			await applyFromOrigin(base + 300, patch(id, { meta: 'retried' }));
		} finally {
			Transaction.prototype.commit = originalCommit;
			releaseHolder?.();
			setWriteIntentsForTests(priorIntents ?? false);
		}
		assert.deepStrictEqual(attempts, [{ logWritten: false }, { logWritten: true }]);
		assert.deepStrictEqual(refsOf(id), []);
		await applyFromOrigin(base + 100, patch(id, { title: 'older' }));
		const { title, meta } = await T.get(id);
		assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
	});

	it('keeps the intermediate head when abort markers are disabled and a retry is refused before its log write', async () => {
		const id = 'markers-off';
		const base = freshBase();
		const priorMarkers = setAbortMarkersForTests(false);
		try {
			await applyFromOrigin(base, put(id, { id, title: 'seed', meta: 'seed' }));
			const interception = interceptNextCommit(async () => {
				await applyFromOrigin(base + 200, patch(id, { title: 'intermediate' }));
				return constants.RETRY_NOW_VALUE;
			});
			try {
				await applyFromOrigin(base + 300, patch(id, { meta: 'retried' }));
			} finally {
				interception.restore();
			}
			assert(interception.retried, 'the write must have retried');
			assert(namesHead(id, base + 200), 'the record names the head the retry committed over');
			await applyFromOrigin(base + 100, patch(id, { title: 'older' }));
			const { title, meta } = await T.get(id);
			assert.deepStrictEqual({ title, meta }, { title: 'intermediate', meta: 'retried' });
		} finally {
			setAbortMarkersForTests(priorMarkers ?? true);
		}
	});

	it('recovers the ref when crash replay restages the retried write over the intermediate head', async function () {
		const crashDir = path.join(dbPath, 'retry-audit-chain-crash');
		rmSync(crashDir, { recursive: true, force: true });
		const run = (mode) =>
			runChild([
				path.join(crashDir, `${mode}-root`),
				path.join(crashDir, 'shared'),
				path.join(crashDir, 'marker'),
				mode,
			]);
		const written = await run('write');
		assert.strictEqual(
			written.signal,
			'SIGKILL',
			`the writer should kill itself (exit ${written.code}): ${written.stderr}`
		);
		const replayed = await run('replay');
		assert.strictEqual(replayed.code, 0, replayed.stderr);
		assert.deepStrictEqual(JSON.parse(readFileSync(path.join(crashDir, 'marker'), 'utf8')), {
			retried: true,
			replayed: true,
			title: 'intermediate',
			meta: 'retried',
		});
	});
});

async function runChild(args) {
	const child = spawn(process.execPath, [path.join(__dirname, 'retryAuditChain-crash.js'), ...args], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
	try {
		return await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
		});
	} finally {
		clearTimeout(timer);
	}
}
