'use strict';

// A write that follows ensureLoaded() in the same transaction is based on the record the source fill
// returned, so it must supersede that fill. On RocksDB the transaction's clock is fixed when it first
// reads, before the fill is versioned, so the fill has to order below that clock or the later write
// loses to it as an out-of-order older write (harper#2935).

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

describe('Write after ensureLoaded() on a caching table', function () {
	let Target, sourceGets, reportLastModified;
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
				get() {
					sourceGets++;
					if (reportLastModified) this.getContext().lastModified = Date.now() + 5;
					return { id: this.getId(), value: 7 };
				}
				put() {}
			}
		);
	});

	beforeEach(function () {
		sourceGets = 0;
		reportLastModified = false;
	});

	// the fill holds the record lock until its background commit settles
	async function settledValue(id) {
		await waitFor(() => !Target.primaryStore.hasLock(id));
		return Target.primaryStore.getEntry(id).value.value;
	}

	function writerAfterLoad(beforeWrite) {
		return class extends Target {
			async put(data, target) {
				await this.ensureLoaded();
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

	it('keeps a write made after the transaction already wrote another record', async function () {
		const context = {};
		await transaction(context, async () => {
			await Target.put('earlier', { value: 1 }, context);
			await writerAfterLoad().put('later', { value: 8 }, context);
		});
		assert.equal(await settledValue('later'), 8);
		assert.equal(await settledValue('earlier'), 1);
	});

	it('still caches a fill made by a plain read', async function () {
		assert.equal((await Target.get('read-only')).value, 7);
		assert.equal(await settledValue('read-only'), 7);
		assert.equal((await Target.get('read-only')).value, 7);
		assert.equal(sourceGets, 1);
	});
});
