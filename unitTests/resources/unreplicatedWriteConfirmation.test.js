require('../testUtils');
const assert = require('node:assert');
const { hostname } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { replicationConfirmation: rocksConfirmation } = require('#src/resources/DatabaseTransaction');
const { replicationConfirmation: lmdbConfirmation } = require('#src/resources/LMDBTransaction');
const { Transaction } = require('@harperfast/rocksdb-js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const SELF = global.server.hostname || hostname();

describe('replicatedConfirmation of a write that appends nothing to replicate', () => {
	let Unaudited, UnauditedTracked, Audited;
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
	let waits, checks, releases;
	let sequence = 0;
	const nextId = (prefix) => `${prefix}-${sequence++}`;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Unaudited = table({ table: 'UnreplicatedUnaudited', database: 'test', attributes, audit: false });
		UnauditedTracked = table({
			table: 'UnreplicatedUnauditedTracked',
			database: 'test',
			attributes,
			audit: false,
			trackDeletes: true,
		});
		Audited = table({ table: 'UnreplicatedAudited', database: 'test', attributes, audit: true });
	});

	beforeEach(() => {
		waits = [];
		checks = [];
		releases = [];
		const wait = (...args) => {
			waits.push(args);
			return new Promise((resolve) => releases.push(resolve));
		};
		if (isLMDB) lmdbConfirmation(wait);
		else rocksConfirmation(wait, (...args) => checks.push(args));
	});

	afterEach(() => {
		if (isLMDB) lmdbConfirmation(undefined);
		else rocksConfirmation(undefined);
	});

	// LMDB's write-bearing link does not inherit the context's count, so ask on the table's own link
	function requestConfirmation(Table, context) {
		let link = context.transaction;
		while (link && link.db?.path !== Table.primaryStore.path) link = link.next;
		link.replicatedConfirmation = 1;
	}

	function confirmedWrite(Table, id, stage) {
		const context = { replicatedConfirmation: 1 };
		return transaction(context, async () => {
			const resource = await Table.getResource(id, context);
			await stage(resource);
			requestConfirmation(Table, context);
		});
	}

	async function settlesWithoutWaiting(promise) {
		let timer;
		const stuck = new Promise((resolve) => (timer = setTimeout(() => resolve('stuck'), 2000)));
		try {
			assert.notEqual(await Promise.race([promise, stuck]), 'stuck', 'the commit waited on replication confirmation');
		} finally {
			clearTimeout(timer);
		}
		assert.deepEqual(waits, []);
		assert.deepEqual(checks, []);
	}

	async function waitsUntilReleased(promise) {
		let settled = false;
		promise.then(
			() => (settled = true),
			() => (settled = true)
		);
		try {
			await waitFor(() => waits.length > 0, { timeout: 10_000, message: 'the commit never asked for confirmation' });
			assert.equal(settled, false, 'the commit waits on its confirmation');
			assert.equal(waits.length, 1);
			assert.ok(waits[0][1], 'with a position to wait for');
		} finally {
			for (const release of releases) release();
		}
		await promise;
	}

	const writes = {
		put: (resource, id, options) => resource._writeUpdate(id, { id, name: 'new' }, true, options),
		patch: (resource, id, options) => resource._writeUpdate(id, { name: 'patched' }, false, options),
		invalidate: (resource, id, options) => resource._writeInvalidate(id, undefined, options),
		relocate: (resource, id, options) => resource._writeRelocate(id, options ?? {}),
		delete: (resource, id, options) => resource._writeDelete(id, options),
	};

	for (const [name, stage] of Object.entries(writes)) {
		const Table = () => (name === 'delete' ? UnauditedTracked : Unaudited);
		it(`does not wait on an unaudited ${name}${name === 'delete' ? ' on a delete-tracking table' : ''}`, async () => {
			const id = nextId(`unaudited-${name}`);
			await Table().put({ id, name: 'row' });
			await settlesWithoutWaiting(confirmedWrite(Table(), id, (resource) => stage(resource, id)));
		});

		it(`does not wait on a local-only ${name} of an audited table`, async () => {
			const id = nextId(`local-${name}`);
			await Audited.put({ id, name: 'row' });
			await settlesWithoutWaiting(confirmedWrite(Audited, id, (resource) => stage(resource, id, { localOnly: true })));
		});
	}

	it('does not wait on an unaudited create', async () => {
		const id = nextId('unaudited-create');
		await settlesWithoutWaiting(
			confirmedWrite(Unaudited, id, (resource) => resource._writeUpdate(id, { id, name: 'new' }, true, {}))
		);
		assert.equal((await Unaudited.get(id)).name, 'new');
	});

	it('does not wait on a copy-apply snapshot row, which carries no audit entry', async function () {
		if (isLMDB) this.skip(); // LMDB applies a copied row as an ordinary audited write
		const id = nextId('copy-apply');
		await settlesWithoutWaiting(
			confirmedWrite(Audited, id, (resource) =>
				resource._writeUpdate(id, { id, name: 'copied' }, true, { isCopyApply: true })
			)
		);
		assert.equal((await Audited.get(id)).name, 'copied');
	});

	it('does not wait on a local-only publish', async () => {
		const id = nextId('local-publish');
		await Audited.put({ id, name: 'row' });
		await settlesWithoutWaiting(
			confirmedWrite(Audited, id, (resource) => resource._writePublish(id, { text: 'local' }, { localOnly: true }))
		);
	});

	for (const [name, stage] of Object.entries(writes)) {
		it(`still waits on an audited ${name}`, async () => {
			const id = nextId(`audited-${name}`);
			await Audited.put({ id, name: 'row' });
			await waitsUntilReleased(confirmedWrite(Audited, id, (resource) => stage(resource, id)));
		});
	}

	for (const auditedFirst of [false, true]) {
		it(`still waits on the replicable write sharing a commit with an unaudited one${auditedFirst ? ', staged first' : ''}`, async () => {
			const id = nextId('mixed');
			await Unaudited.put({ id, name: 'row' });
			const context = { replicatedConfirmation: 1 };
			const commit = transaction(context, async () => {
				if (auditedFirst) await Audited.put({ id, name: 'audited' });
				const resource = await Unaudited.getResource(id, context);
				resource._writeUpdate(id, { id, name: 'new' }, true, {});
				if (!auditedFirst) await Audited.put({ id, name: 'audited' });
				requestConfirmation(Audited, context);
			});
			await waitsUntilReleased(commit);
		});
	}

	it('still waits on a publish to an unaudited table, which is always audited', async () => {
		const id = nextId('unaudited-publish');
		await Unaudited.put({ id, name: 'row' });
		await waitsUntilReleased(
			confirmedWrite(Unaudited, id, (resource) => resource._writePublish(id, { text: 'replicable' }, {}))
		);
	});

	it('waits on a write restaged after auditing was enabled at runtime', async () => {
		const Late = table({ table: 'UnreplicatedLateAudit', database: 'test', attributes, audit: false });
		const id = nextId('late-audit');
		let iterator;
		try {
			await Late.put({ id: nextId('late-seed'), name: 'seed' });
			await Late.put({ id: nextId('late-seed'), name: 'seed' });
			const commit = confirmedWrite(Late, id, async () => {
				// the open iterator makes a RocksDB commit re-stage, on a fresh transaction, the put staged here
				// unaudited; without the restage it appends nothing and rightly does not wait
				iterator = Late.search({ conditions: [] })[Symbol.iterator]();
				iterator.next();
				await Late.put({ id, name: 'new' });
				Late.enableAuditing();
			});
			await waitsUntilReleased(commit);
		} finally {
			iterator?.return?.();
		}
	});

	it('does not wait on a coordinated retry that appends nothing after auditing was enabled', async function () {
		if (isLMDB) this.skip(); // the recommit of one native transaction is RocksDB's
		const Retried = table({
			table: 'UnreplicatedRetried',
			database: 'testUnreplicatedRetry',
			attributes,
			audit: false,
		});
		const targetDb = Retried.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		let forced = false;
		// the recommit re-runs the commit handler, now audited, but the log store appends nothing on a retry
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db !== targetDb || forced) return originalCommit.apply(this, args);
			forced = true;
			Retried.enableAuditing();
			throw Object.assign(new Error('forced busy'), { code: 'ERR_BUSY' });
		};
		try {
			const id = nextId('retried');
			await settlesWithoutWaiting(
				confirmedWrite(Retried, id, (resource) => resource._writeUpdate(id, { id, name: 'new' }, true, {}))
			);
			assert.ok(forced, 'the commit was retried');
			assert.equal((await Retried.get(id)).name, 'new');
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
	});

	describe('with a residency that names no other node', () => {
		before(function () {
			if (isLMDB) this.skip(); // LMDB commit handlers are not handed the committing transaction
		});
		afterEach(() => {
			Unaudited.setResidency(undefined);
			Audited.setResidency(undefined);
		});

		it('does not refuse an unaudited put', async () => {
			Unaudited.setResidency(() => [SELF]);
			const id = nextId('resident-unaudited');
			await settlesWithoutWaiting(
				confirmedWrite(Unaudited, id, (resource) => resource._writeUpdate(id, { id, name: 'new' }, true, {}))
			);
			assert.equal((await Unaudited.get(id)).name, 'new');
		});

		it('does not refuse a local-only put of an audited table', async () => {
			Audited.setResidency(() => [SELF]);
			const id = nextId('resident-local');
			await settlesWithoutWaiting(
				confirmedWrite(Audited, id, (resource) =>
					resource._writeUpdate(id, { id, name: 'new' }, true, { localOnly: true })
				)
			);
			assert.equal((await Audited.get(id)).name, 'new');
		});

		it('still refuses an audited put', async () => {
			Audited.setResidency(() => [SELF]);
			const id = nextId('resident-audited');
			await assert.rejects(
				confirmedWrite(Audited, id, (resource) => resource._writeUpdate(id, { id, name: 'new' }, true, {})),
				/resident on 0 other node\(s\)$/
			);
			assert.equal(Audited.primaryStore.getEntry(id), undefined);
		});
	});
});
