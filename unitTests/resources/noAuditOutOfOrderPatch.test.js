require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { waitFor } = require('../waitFor');

describe('out-of-order patch on an audit:false table', () => {
	let NoAudit;
	let nextId = 1;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		setDeletionDelay(0);
		NoAudit = table({
			table: 'NoAuditOutOfOrderPatch',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag' },
				{ name: 'data' },
				{ name: 'extra' },
				{ name: 'count' },
			],
			audit: false,
		});
		if (NoAudit.indexingOperation) await NoAudit.indexingOperation;
	});

	after(() => setDeletionDelay(undefined));

	async function seedNewerRecord() {
		const id = `noaudit-${nextId++}`;
		await NoAudit.put(id, { tag: 'base', count: 10 });
		const now = Date.now();
		const newerBytes = randomBytes(25000);
		const newerBlob = await createBlob(newerBytes);
		await NoAudit.patch(
			id,
			{ tag: 'newer', data: newerBlob, count: { __op__: 'add', value: 2 } },
			{ timestamp: now + 100 }
		);
		return { id, now, newerBytes, newerBlob };
	}

	it('a patch whose keys all exist in the newer record leaves it untouched and reclaims its blob', async () => {
		const { id, now, newerBytes, newerBlob } = await seedNewerRecord();
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAudit.patch(id, { tag: 'stale', data: staleBlob }, { timestamp: now + 50 });

		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'newer', 'the stale patch overwrote a newer scalar');
		assert.ok(Buffer.from(await record.data.bytes()).equals(newerBytes), 'the stale patch replaced the newer blob');
		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the stale patch blob was never cleaned up',
		});
		assert.ok(existsSync(getFilePathForBlob(newerBlob)), 'the newer record blob file was unlinked');
	});

	it('a partially superseded patch adds only the new key and reclaims the blob of the dropped key', async () => {
		const { id, now, newerBytes, newerBlob } = await seedNewerRecord();
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAudit.patch(id, { tag: 'stale', data: staleBlob, extra: 'added' }, { timestamp: now + 50 });

		const record = await NoAudit.get(id);
		assert.strictEqual(record.tag, 'newer');
		assert.strictEqual(record.extra, 'added', 'the key the newer record lacked must still merge');
		assert.ok(Buffer.from(await record.data.bytes()).equals(newerBytes));
		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the dropped key blob was never cleaned up',
		});
		assert.ok(existsSync(getFilePathForBlob(newerBlob)), 'the newer record blob file was unlinked');
	});

	it('a blob the merged record keeps survives the cleanup', async () => {
		const { id, now, newerBytes } = await seedNewerRecord();
		const keptBytes = randomBytes(25000);
		const keptBlob = await createBlob(keptBytes);
		const staleBlob = await createBlob(randomBytes(25000));
		await NoAudit.patch(id, { data: staleBlob, extra: keptBlob }, { timestamp: now + 50 });

		await waitFor(() => !existsSync(getFilePathForBlob(staleBlob)), {
			timeout: 5000,
			message: 'the dropped key blob was never cleaned up',
		});
		const record = await NoAudit.get(id);
		assert.ok(Buffer.from(await record.extra.bytes()).equals(keptBytes), 'the retained blob must stay readable');
		assert.ok(Buffer.from(await record.data.bytes()).equals(newerBytes), 'the newer blob must stay readable');
	});

	it('an increment is applied even though every key it touches exists in the newer record', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 } }, { timestamp: now + 50 });
		assert.strictEqual((await NoAudit.get(id)).count, 13);
	});

	it('an increment survives beside a stale plain assignment that is dropped', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 }, tag: 'stale' }, { timestamp: now + 50 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.count, 13);
		assert.strictEqual(record.tag, 'newer');
	});

	it('an increment survives beside a plain key the newer record lacks', async () => {
		const { id, now } = await seedNewerRecord();
		await NoAudit.patch(id, { count: { __op__: 'add', value: 1 }, extra: 'added' }, { timestamp: now + 50 });
		const record = await NoAudit.get(id);
		assert.strictEqual(record.count, 13);
		assert.strictEqual(record.extra, 'added');
	});
});
