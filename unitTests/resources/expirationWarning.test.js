require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');
const { waitFor } = require('../waitFor.js');

// Covers issue #1339: a runtime per-record expiresAt on a table with no table-level expiration/eviction,
// no expiresAt attribute, and no source has no setup-time arming of the cleanup scan, so eviction is not
// reliably enforced. Table.ts warns once per table when such a write happens; these tests assert the
// warning fires for the unscheduled case and is suppressed when a reliable arming path is configured.
describe('Per-record expiresAt without scheduled cleanup (#1339)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	let warnings;
	let originalWarn;

	const matchesWarning = (message) => typeof message === 'string' && message.includes('per-record expiresAt');
	const warningsFor = (tableName) =>
		warnings.filter(([message]) => matchesWarning(message) && message.includes(`"${tableName}"`));

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(function () {
		warnings = [];
		originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args);
	});

	afterEach(function () {
		logger.warn = originalWarn;
	});

	it('warns once per table when a per-record expiresAt is set on an unconfigured table', async function () {
		const UnscheduledTable = table({
			table: 'UnscheduledExpiresAtTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await UnscheduledTable.put(1, { id: 1, name: 'first' }, { expiresAt: Date.now() + 60000 });
		await waitFor(() => warningsFor('UnscheduledExpiresAtTable').length === 1);
		assert.strictEqual(warningsFor('UnscheduledExpiresAtTable').length, 1);

		// A second expiring write must not produce a duplicate warning for the same table.
		await UnscheduledTable.put(2, { id: 2, name: 'second' }, { expiresAt: Date.now() + 60000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(warningsFor('UnscheduledExpiresAtTable').length, 1);
	});

	it('does not warn when the table has a table-level eviction configured', async function () {
		const EvictionTable = table({
			table: 'EvictionConfiguredTable',
			database: 'test',
			eviction: 3600,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await EvictionTable.put(1, { id: 1 }, { expiresAt: Date.now() + 60000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(warningsFor('EvictionConfiguredTable').length, 0);
	});

	it('does not warn when the table has an expiresAt attribute', async function () {
		const AttributeTable = table({
			table: 'ExpiresAtAttributeTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
			],
		});
		await AttributeTable.put(1, { id: 1, expiresAt: Date.now() + 60000 }, { expiresAt: Date.now() + 60000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(warningsFor('ExpiresAtAttributeTable').length, 0);
	});

	it('does not warn when the table has a source', async function () {
		const SourcedTable = table({
			table: 'SourcedExpiresAtTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		SourcedTable.sourcedFrom(
			class extends Resource {
				get() {
					// A source-driven per-record expiresAt: the cache-fill write goes through the same save path.
					this.getContext().expiresAt = Date.now() + 60000;
					return { id: this.getId(), name: 'from source' };
				}
			}
		);
		await SourcedTable.get(1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(warningsFor('SourcedExpiresAtTable').length, 0);
	});
});
