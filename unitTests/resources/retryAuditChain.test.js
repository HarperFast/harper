// A RocksDB transaction writes its transaction-log entry once, at its first commit attempt, and a retry
// after a conflict appends nothing. The out-of-order walk has to keep finding every committed write while
// such an entry is still uncommitted, and after the retry commits over a newer head than the entry names.
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
const { Transaction } = require('@harperfast/rocksdb-js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Audit chain across a conflict retry', function () {
	this.timeout(20000);
	let T, origin, dbPath;

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

	// Runs `around` in place of the next native commit on the table's database; it gets the real commit.
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

	// `retried` commits at base + 300 and conflicts on its first attempt with a patch at base + 200, which it
	// then retries in order over, so its log entry names the seed at `base` as its previous version.
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
	const namesHead = (id, version) => refsOf(id).some((ref) => ref.version === version && ref.nodeId === origin);
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
		// older than the intermediate head, so its title has to lose to it
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
