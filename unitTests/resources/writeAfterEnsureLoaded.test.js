'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setSourceFillLockTimeoutForTesting } = require('#src/resources/Table');
const { setTimeout: delay } = require('node:timers/promises');

describe('Write after ensureLoaded() on a caching table', function () {
	let Target, sourceGets, reportLastModified, sourceGate, sourceStarted, sourceValue;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Target = table({
			database: 'write_after_ensure_loaded',
			table: 'Target',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'value', indexed: true },
			],
		});
		Target.sourcedFrom(
			class extends Resource {
				async get() {
					sourceGets++;
					if (reportLastModified) this.getContext().lastModified = Date.now() + 5;
					const value = sourceValue;
					if (sourceGate) {
						sourceStarted();
						await sourceGate;
					}
					return { id: this.getId(), value };
				}
				put() {}
			}
		);
	});

	beforeEach(function () {
		sourceGets = 0;
		reportLastModified = false;
		sourceGate = undefined;
		sourceValue = 7;
	});

	// the fill holds the record lock until its background commit settles
	async function settledValue(id) {
		await waitFor(() => !Target.primaryStore.hasLock(id));
		return Target.primaryStore.getEntry(id).value.value;
	}

	function writerAfterLoad(beforeWrite, load = (resource) => resource.ensureLoaded()) {
		return class extends Target {
			async put(data, target) {
				await load(this);
				if (beforeWrite) await beforeWrite(this.getId());
				return super.put(data, target);
			}
		};
	}

	it('keeps a write made right after the fill started', async function () {
		await writerAfterLoad().put('immediate', { value: 8 });
		assert.equal(sourceGets, 1);
		assert.equal(await settledValue('immediate'), 8);
		assert.equal((await Target.get('immediate')).value, 8);
	});

	it('keeps a write made after the fill committed', async function () {
		await writerAfterLoad(async (id) => {
			await waitFor(() => !Target.primaryStore.hasLock(id));
			assert.equal(Target.primaryStore.getEntry(id).value.value, 7);
		}).put('after-fill', { value: 8 });
		assert.equal(await settledValue('after-fill'), 8);
		assert.equal((await Target.get('after-fill')).value, 8);
	});

	it('keeps a write over a fill whose source reports its own version', async function () {
		reportLastModified = true;
		await writerAfterLoad().put('reported', { value: 8 });
		assert.equal(await settledValue('reported'), 8);
	});

	it('keeps a write over a fill that refreshes an invalidated record', async function () {
		await Target.put('invalidated', { value: 1 });
		await Target.invalidate('invalidated');
		const invalidatedVersion = Target.primaryStore.getEntry('invalidated').version;
		await writerAfterLoad().put('invalidated', { value: 8 });
		assert.equal(sourceGets, 1);
		assert.equal(await settledValue('invalidated'), 8);
		assert.ok(Target.primaryStore.getEntry('invalidated').version > invalidatedVersion);
	});

	it('keeps a write made after the transaction already wrote another record', async function () {
		const context = {};
		await transaction(context, async () => {
			await Target.put('earlier', { value: 1 }, context);
			await writerAfterLoad().put('later', { value: 8 }, context);
		});
		assert.equal(await settledValue('later'), 8);
		assert.equal(await settledValue('earlier'), 1);
	});

	it("keeps a write made after waiting on another request's fill", async function () {
		// the source gate waits on the other request, so a regression that never starts it fails rather than hangs
		this.timeout(30_000);
		await Target.get('warm');
		await settledValue('warm');
		let releaseSource, otherRequest;
		sourceGate = new Promise((resolve) => (releaseSource = resolve));
		const fetching = new Promise((resolve) => (sourceStarted = resolve));
		// this transaction's clock is fixed by its first read, before the other request starts fetching
		await writerAfterLoad(undefined, async (resource) => {
			await Target.get('warm', resource.getContext());
			const other = {};
			otherRequest = transaction(other, () => Target.get('waited', other));
			await fetching;
			const waiting = resource.ensureLoaded();
			releaseSource();
			await waiting;
		}).put('waited', { value: 8 });
		await otherRequest;
		assert.equal(sourceGets, 2);
		assert.equal(await settledValue('waited'), 8);
	});

	async function fillAfterFirstRead(id, context) {
		await Target.get('warm', context);
		assert.equal((await Target.get(id)).value, 7);
		assert.equal(await settledValue(id), 7);
		sourceValue = 9;
		assert.equal((await Target.get(id, context)).value, 9);
	}

	it("caches a fill over one another request committed after this transaction's first read", async function () {
		const context = {};
		await transaction(context, () => fillAfterFirstRead('successive', context));
		assert.equal(await settledValue('successive'), 9);
	});

	it("keeps a write made after a fill over one committed after this transaction's first read", async function () {
		const context = {};
		await transaction(context, async () => {
			await fillAfterFirstRead('successive-write', context);
			await Target.put('successive-write', { value: 8 }, context);
		});
		assert.equal(await settledValue('successive-write'), 8);
	});

	it('keeps a write made after a fill over one committed since, when the transaction already wrote', async function () {
		const context = {};
		await transaction(context, async () => {
			await Target.put('successive-earlier', { value: 1 }, context);
			await fillAfterFirstRead('successive-written', context);
			await Target.put('successive-written', { value: 8 }, context);
		});
		assert.equal(await settledValue('successive-written'), 8);
	});

	it('keeps a write over a refresh fill that loses to one committed after its first read', async function () {
		await Target.put('successive-refresh', { value: 1 });
		await Target.invalidate('successive-refresh');
		const context = {};
		await transaction(context, async () => {
			await Target.get('warm', context);
			assert.equal((await Target.get('successive-refresh')).value, 7);
			assert.equal(await settledValue('successive-refresh'), 7);
			sourceValue = 9;
			assert.equal((await Target.get('successive-refresh', context)).value, 9);
			await Target.put('successive-refresh', { value: 8 }, context);
		});
		assert.equal(await settledValue('successive-refresh'), 8);
	});

	it('keeps the newer of two overlapping fills when the newer one has the older clock', async function () {
		setSourceFillLockTimeoutForTesting(50);
		try {
			await Target.get('warm');
			await settledValue('warm');
			let releaseSource, olderFetch;
			sourceGate = new Promise((resolve) => (releaseSource = resolve));
			const fetching = new Promise((resolve) => (sourceStarted = resolve));
			sourceValue = 1;
			const context = {};
			await transaction(context, async () => {
				await Target.getResource('warm', context); // fixes this transaction's clock before the other fetch
				const other = {};
				olderFetch = transaction(other, () => Target.get('overlapped', other));
				await fetching;
				sourceGate = undefined;
				sourceValue = 2;
				await delay(120); // past the fill lock tenure, so this transaction fetches too
				assert.equal((await Target.get('overlapped', context)).value, 2);
			});
			releaseSource();
			await olderFetch;
			await delay(50); // the older fill's background commit
			assert.equal(await settledValue('overlapped'), 2);
		} finally {
			setSourceFillLockTimeoutForTesting(undefined);
		}
	});

	it('still caches a fill made by a plain read', async function () {
		assert.equal((await Target.get('read-only')).value, 7);
		assert.equal(await settledValue('read-only'), 7);
		assert.equal((await Target.get('read-only')).value, 7);
		assert.equal(sourceGets, 1);
	});
});
