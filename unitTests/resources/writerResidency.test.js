require('../testUtils');
const assert = require('node:assert');
const { hostname } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { INVALIDATED } = require('#src/resources/Table');
const { logger } = require('#src/utility/logging/logger');

const SELF = global.server.hostname || hostname();
const PEER = 'writer-residency-peer';

describe('Writer residency (harper#2257)', () => {
	let Records;

	let lastLogKey = Date.now() - 3_600_000;
	function originClock() {
		return (lastLogKey += 10_000);
	}

	function applyFrame(writes, logKey = originClock()) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			for (const { id, record, fullUpdate = true, residencyId, withoutNodeId } of writes) {
				const resource = await Records.getResource(id, context);
				resource._writeUpdate(id, record, fullUpdate, {
					isNotification: true,
					nodeId: withoutNodeId ? undefined : 1,
					version: logKey,
					residencyId,
				});
			}
		});
	}

	async function capturingWarnings(run) {
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (...args) => {
			warnings.push(args.map(String).join(' '));
		};
		try {
			await run();
		} finally {
			logger.warn = originalWarn;
		}
		return warnings;
	}

	const residencyOf = (entry) => Records.getResidencyRecord(entry.residencyId);
	// mints the id the way a local write does
	async function residencyIdFor(residency) {
		const previous = Records.getResidency;
		Records.setResidency(() => residency);
		const id = `minter-${residency.join('-')}`;
		await Records.put(id, { id, name: 'minter', body: 'complete' });
		Records.getResidency = previous;
		return Records.primaryStore.getEntry(id).residencyId;
	}
	const assertNoCompletePartialRow = (entry) =>
		assert.ok(
			entry.metadataFlags & INVALIDATED || entry.value?.body !== undefined,
			`stored a partial row as complete: ${JSON.stringify(entry.value)}`
		);

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'WriterResidency',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'body' },
				{ name: 'note' },
				{ name: 'place' },
				{ name: 'createdAt', assignCreatedTime: true },
			],
			audit: true,
		});
	});

	afterEach(() => {
		Records.setResidency(undefined);
		Records.setResidencyById(undefined);
	});

	it('keeps the full record and joins the residency list when the function excludes the writer', async () => {
		const placement = Object.freeze([PEER]);
		Records.setResidency(() => placement);
		const warnings = await capturingWarnings(async () => {
			await Records.put('kept-1', { id: 'kept-1', name: 'n', body: 'complete' });
			await Records.put('kept-2', { id: 'kept-2', name: 'n', body: 'complete' });
		});
		for (const id of ['kept-1', 'kept-2']) {
			const entry = Records.primaryStore.getEntry(id);
			assert.equal(entry.metadataFlags & INVALIDATED, 0);
			assert.equal(entry.value.body, 'complete');
			assert.deepEqual(residencyOf(entry), [PEER, SELF]);
			assert.equal((await Records.get(id)).body, 'complete');
		}
		const keptWarnings = warnings.filter((warning) => warning.includes('WriterResidency') && warning.includes(SELF));
		assert.equal(keptWarnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
		assert.deepEqual(placement, [PEER]);
	});

	it('replaces a stub with the full record on a local full put', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([{ id: 'stub-replaced', record: { id: 'stub-replaced', name: 'n', body: 'old' } }]);
		await Records.put('stub-replaced', { id: 'stub-replaced', name: 'n', body: 'new' });
		const entry = Records.primaryStore.getEntry('stub-replaced');
		assert.equal(entry.metadataFlags & INVALIDATED, 0);
		assert.equal(entry.value.body, 'new');
		assert.deepEqual(residencyOf(entry), [PEER, SELF]);
	});

	it('keeps the full record on a patch when the function excludes the writer', async () => {
		await Records.put('patched', { id: 'patched', name: 'n', body: 'complete' });
		Records.setResidency(() => [PEER]);
		await Records.patch('patched', { note: 'added' });
		const entry = Records.primaryStore.getEntry('patched');
		assert.equal(entry.metadataFlags & INVALIDATED, 0);
		assert.equal(entry.value.body, 'complete');
		assert.equal(entry.value.note, 'added');
		assert.deepEqual(residencyOf(entry), [PEER, SELF]);
	});

	it('stores a stub on a non-resident replicated receive that carries no residency list', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([{ id: 'received', record: { id: 'received', name: 'n', body: 'complete', createdAt: 123 } }]);
		const entry = Records.primaryStore.getEntry('received');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, undefined);
		assert.equal(entry.value.name, 'n');
		assert.equal(entry.value.createdAt, 123);
		assert.deepEqual(residencyOf(entry), [PEER]);
	});

	it('stores a stub for a source write that carries no node id', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([
			{ id: 'from-source', record: { id: 'from-source', name: 'n', body: 'complete' }, withoutNodeId: true },
		]);
		const entry = Records.primaryStore.getEntry('from-source');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, undefined);
	});

	it('never stores a local patch over a stub as a complete row', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([{ id: 'stub-moved', record: { id: 'stub-moved', name: 'n', body: 'complete' } }]);
		assert.ok(Records.primaryStore.getEntry('stub-moved').metadataFlags & INVALIDATED, 'premise: a stub');
		Records.setResidency(() => [PEER, SELF]);
		await Records.patch('stub-moved', { note: 'added' });
		const entry = Records.primaryStore.getEntry('stub-moved');
		assertNoCompletePartialRow(entry);
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.name, 'n');
		assert.deepEqual(residencyOf(entry), [PEER], 'the stub still names the complete holder');
	});

	it('keeps the stub residency when a patch over a stub moves the placement', async () => {
		Records.setResidency((record) => (record.place === 'moved' ? ['new-holder'] : [PEER]));
		await applyFrame([{ id: 'stub-placed', record: { id: 'stub-placed', name: 'n', body: 'complete' } }]);
		await Records.patch('stub-placed', { place: 'moved' });
		const entry = Records.primaryStore.getEntry('stub-placed');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.deepEqual(residencyOf(entry), [PEER], 'the patch has no complete record to place elsewhere');
	});

	it('never stores a patch over a stub staged earlier in the transaction as complete', async () => {
		Records.setResidency((record) => (record.place === 'here' ? [SELF] : [PEER]));
		await applyFrame([
			{ id: 'staged-stub', record: { id: 'staged-stub', name: 'n', body: 'complete' } },
			{ id: 'staged-stub', record: { place: 'here', note: 'added' }, fullUpdate: false },
		]);
		const entry = Records.primaryStore.getEntry('staged-stub');
		assertNoCompletePartialRow(entry);
		assert.deepEqual(residencyOf(entry), [PEER]);
	});

	it('does not force a stub-holding writer into the residency list on a patch', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([{ id: 'stub-kept', record: { id: 'stub-kept', name: 'n', body: 'complete' } }]);
		await Records.patch('stub-kept', { note: 'added' });
		const entry = Records.primaryStore.getEntry('stub-kept');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.deepEqual(residencyOf(entry), [PEER]);
	});

	it('never stores a patch over a stub as complete when no residency function applies', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([{ id: 'stub-unset', record: { id: 'stub-unset', name: 'n', body: 'complete' } }]);
		Records.setResidency(undefined);
		await Records.patch('stub-unset', { note: 'added' });
		const entry = Records.primaryStore.getEntry('stub-unset');
		assertNoCompletePartialRow(entry);
		assert.deepEqual(residencyOf(entry), [PEER], 'the stub still names a complete holder');
	});

	it('never stores a replicated patch over a stub as complete on a now-resident receiver', async () => {
		Records.setResidency(() => [PEER]);
		await applyFrame([{ id: 'stub-replicated', record: { id: 'stub-replicated', name: 'n', body: 'complete' } }]);
		const residencyId = await residencyIdFor([PEER, SELF]);
		await applyFrame([{ id: 'stub-replicated', record: { note: 'added' }, fullUpdate: false, residencyId }]);
		const entry = Records.primaryStore.getEntry('stub-replicated');
		assertNoCompletePartialRow(entry);
		assert.deepEqual(residencyOf(entry), [PEER, SELF], 'the received residency stays authoritative');
	});

	it('keeps the merged indexed values on an out-of-order patch over a stub', async () => {
		// clocks near now so the older patch is resequenced through the audit walk (reached on LMDB)
		const now = Date.now();
		Records.setResidency(() => [PEER]);
		await applyFrame(
			[{ id: 'stub-reordered', record: { id: 'stub-reordered', name: 'old', body: 'complete' } }],
			now - 3000
		);
		const residencyId = await residencyIdFor([PEER, SELF]);
		const earlier = now - 2000;
		const later = now - 1000;
		await applyFrame([{ id: 'stub-reordered', record: { name: 'new' }, fullUpdate: false, residencyId }], later);
		await applyFrame([{ id: 'stub-reordered', record: { note: 'x' }, fullUpdate: false, residencyId }], earlier);
		const entry = Records.primaryStore.getEntry('stub-reordered');
		assertNoCompletePartialRow(entry);
		assert.equal(entry.value.name, 'new');
		let hits = 0;
		for await (const _record of Records.search({ conditions: [{ attribute: 'name', value: 'new' }] })) hits++;
		assert.equal(hits, 1, 'the name index lost the record');
	});

	it('restores the default residency when the function is cleared', async () => {
		Records.setResidency(() => [PEER]);
		Records.setResidency();
		await Records.put('cleared', { id: 'cleared', name: 'n', body: 'complete' });
		const entry = Records.primaryStore.getEntry('cleared');
		assert.equal(entry.value.body, 'complete');
		assert.ok(!entry.residencyId);
	});

	it('leaves setResidencyById omission unchanged', async () => {
		Records.setResidencyById(() => [PEER]);
		await Records.put('by-id', { id: 'by-id', name: 'n', body: 'complete' });
		assert.equal(Records.primaryStore.getEntry('by-id')?.value, undefined, 'the writer keeps no copy');
		await Records.patch('by-id', { note: 'added' });
		assert.equal(Records.primaryStore.getEntry('by-id')?.value, undefined, 'nor after a patch');
	});
});
