const assert = require('node:assert');

if (require.main === module) {
	const { join } = require('node:path');
	const { mkdirSync } = require('node:fs');
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	const root = process.argv[2];
	mkdirSync(join(root, 'database'));
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, join(root, 'database'));
	require('#src/server/threads/manageThreads').setMainIsWorker(true);
	(async () => {
		const { getDatabases } = require('#src/resources/databases');
		const { getDirectiveByVersion, getVersionsForUpgrade } = require('#src/upgrade/directives/directivesController');
		const { UpgradeObject } = require('#src/upgrade/UpgradeObjects');
		const { defaultResidencyMap } = require('#src/resources/residencyPolicy');
		const { installResidencyMap, RESIDENCY_MAP_TABLE } = require('#src/resources/residencyMaps');
		assert.ok(getVersionsForUpgrade(new UpgradeObject('5.3.1', '5.4.0')).includes('5.4.0'));
		assert.equal(getDatabases().system?.[RESIDENCY_MAP_TABLE], undefined, 'upgrade starts without the new table');
		const upgrade = async () => {
			for (const step of getDirectiveByVersion('5.4.0').async_functions) await step();
		};
		await upgrade();
		const Maps = getDatabases().system[RESIDENCY_MAP_TABLE];
		assert.ok(Maps.auditStore);
		assert.strictEqual(Maps.replicate, true);
		assert.strictEqual(Maps.dbisDB.getSync(`${RESIDENCY_MAP_TABLE}/`).is_hash_attribute, true);
		const snapshot = defaultResidencyMap('upgrade_residency', 2, [0, 1]);
		await installResidencyMap(snapshot);
		await upgrade();
		assert.deepEqual(Maps.primaryStore.getSync('upgrade_residency'), snapshot);
	})().then(
		() => process.exit(0),
		(error) => {
			console.error(error);
			process.exit(1);
		}
	);
} else {
	describe('Shard map upgrade', () => {
		it('provisions an audited table on 5.4 upgrade and preserves an existing map on rerun', function () {
			this.timeout(15000);
			const { mkdtempSync, rmSync } = require('node:fs');
			const { join } = require('node:path');
			const { tmpdir } = require('node:os');
			const { spawnSync } = require('node:child_process');
			const root = mkdtempSync(join(tmpdir(), 'residency-upgrade-'));
			try {
				const result = spawnSync(process.execPath, [__filename, root], { encoding: 'utf8', timeout: 10000 });
				assert.ifError(result.error);
				assert.equal(result.status, 0, result.stderr);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
}
