'use strict';

const assert = require('node:assert/strict');
const { formatUpgradeHeader, formatMigrationLine } = require('#src/upgrade/directivesManager');

// The upgrade log must describe the real data -> software transition and what each migration does,
// rather than printing a bare directive version (the release that *introduced* a migration, e.g.
// "5.1.0" while installing 5.1.7), which reads like a downgrade.
describe('directivesManager — upgrade log wording', function () {
	describe('formatUpgradeHeader', function () {
		it('names the real data -> software transition for a single migration', function () {
			const header = formatUpgradeHeader('5.0.22', '5.1.7', 1);
			assert.ok(header.includes('from 5.0.22'), header);
			assert.ok(header.includes('software 5.1.7'), header);
			assert.ok(header.includes('1 data migration '), `expected singular wording: ${header}`);
			assert.ok(!header.includes('Running upgrade for version'), 'old misleading wording must be gone');
		});

		it('pluralizes and reports the count for multiple migrations', function () {
			const header = formatUpgradeHeader('5.0.0', '5.3.0', 3);
			assert.ok(header.includes('applying 3 data migrations '), header);
		});

		it('reports when there are no migrations to apply', function () {
			const header = formatUpgradeHeader('5.1.7', '5.1.7', 0);
			assert.ok(header.includes('no data migrations to apply'), header);
		});
	});

	describe('formatMigrationLine', function () {
		it('frames the version as "introduced in" and appends the description', function () {
			const line = formatMigrationLine(1, 1, '5.1.0', 'create system.hdb_deployment table for deployment tracking');
			assert.equal(
				line,
				'Applying migration 1 of 1 (introduced in 5.1.0): create system.hdb_deployment table for deployment tracking'
			);
		});

		it('omits the description segment when none is provided', function () {
			const line = formatMigrationLine(2, 4, '5.4.0');
			assert.equal(line, 'Applying migration 2 of 4 (introduced in 5.4.0)');
		});
	});
});
