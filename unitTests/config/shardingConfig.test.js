const assert = require('node:assert');
const { readFileSync, writeFileSync, readdirSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');

describe('Sharding configuration repair', () => {
	(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it)(
		'projects the root file before a worker installs its first map, without Pro startup',
		async function () {
			this.timeout(20_000);
			const { Worker } = require('node:worker_threads');
			const { getConfigFilePath } = require('#src/config/configUtils');
			const { readRootConfig, setRootConfigEntry } = require('../rootConfigFixture');
			const path = getConfigFilePath();
			const saved = readFileSync(path, 'utf8');
			let worker;
			let timer;
			try {
				setRootConfigEntry('replication', { ...readRootConfig().replication, shard: 0, shards: [0, 1] });
				worker = new Worker(
					`
				const { parentPort, workerData } = require('node:worker_threads');
				require(workerData.testUtils).setupTestDBPath();
				const env = require('#src/utility/environment/environmentManager');
				env.setProperty('replication_shard', 0);
				env.setProperty('replication_shards', [1]);
				const { prepareResidencyDeclaration, readResidencyMap } = require('#src/resources/residencyMaps');
				prepareResidencyDeclaration('configProjection', 'Rows', {}).then(() => {
					parentPort.postMessage({ type: 'projection-result', map: readResidencyMap('configProjection') });
				}, error => parentPort.postMessage({ type: 'projection-result', error: error.message }));
				parentPort.ref();
			`,
					{
						eval: true,
						workerData: {
							testUtils: require.resolve('../testUtils'),
							noServerStart: true,
							addPorts: [],
							workerIndex: 9,
							workerCount: 10,
						},
					}
				);
				const result = await new Promise((resolve, reject) => {
					timer = setTimeout(() => reject(new Error('worker did not project the root configuration')), 15_000);
					worker.once('error', reject);
					worker.once('exit', (code) => reject(new Error(`worker exited before declaration: ${code}`)));
					worker.on('message', (message) => {
						if (message.type === 'projection-result') resolve(message);
					});
				});
				assert.equal(result.error, undefined);
				assert.equal(result.map.slots, 1024);
				assert.deepEqual([...new Set(result.map.ranges.map((range) => range.shard))].sort(), [0, 1]);
				assert.equal(
					result.map.ranges
						.filter((range) => range.shard === 0)
						.reduce((total, range) => total + range.end - range.start, 0),
					512
				);
			} finally {
				clearTimeout(timer);
				await worker?.terminate();
				writeFileSync(path, saved);
			}
		}
	);
	for (const section of [false, true])
		it(`restores the startup shard list through set_configuration (section=${section})`, async () => {
			const { setConfiguration, initConfig, getConfigFilePath } = require('#src/config/configUtils');
			const { readRootConfig, setRootConfigEntry } = require('../rootConfigFixture');
			const path = getConfigFilePath();
			const saved = readFileSync(path, 'utf8');
			try {
				const replication = { ...readRootConfig().replication, shard: 0, shards: [0, 1] };
				setRootConfigEntry('replication', replication);
				initConfig(true);
				const args = (shards) =>
					section ? { replication: { ...replication, shards } } : { replication_shards: shards };
				await setConfiguration({ operation: 'set_configuration', ...args([1]) });
				assert.deepEqual(readRootConfig().replication.shards, [1]);
				await setConfiguration({ operation: 'set_configuration', ...args([0, 1]) });
				assert.deepEqual(readRootConfig().replication.shards, [0, 1]);
				const repaired = readFileSync(path, 'utf8');
				const backupDir = join(readRootConfig().rootPath, 'backup');
				const backups = readdirSync(backupDir).sort();
				await setConfiguration({ operation: 'set_configuration', ...args([0, 1]) });
				assert.equal(readFileSync(path, 'utf8'), repaired);
				assert.deepEqual(readdirSync(backupDir).sort(), backups, 'an idempotent request creates no backup');
			} finally {
				writeFileSync(path, saved);
				initConfig(true);
			}
		});
	it('also persists an explicit port rollback without changing boot snapshot semantics', async () => {
		const { setConfiguration, initConfig, getConfigFilePath } = require('#src/config/configUtils');
		const { readRootConfig, setRootConfigEntry } = require('../rootConfigFixture');
		const path = getConfigFilePath();
		const saved = readFileSync(path, 'utf8');
		try {
			setRootConfigEntry('http', { ...readRootConfig().http, port: 9926, securePort: null });
			initConfig(true);
			await setConfiguration({ operation: 'set_configuration', http_port: 9927 });
			assert.equal(readRootConfig().http.port, 9927);
			await setConfiguration({ operation: 'set_configuration', http_port: 9926 });
			assert.equal(readRootConfig().http.port, 9926);
		} finally {
			writeFileSync(path, saved);
			initConfig(true);
		}
	});

	it('does not rewrite or back up an unchanged shard list at boot', () => {
		const { updateConfigValue, initConfig, getConfigFilePath } = require('#src/config/configUtils');
		const { readRootConfig, setRootConfigEntry } = require('../rootConfigFixture');
		const path = getConfigFilePath();
		const saved = readFileSync(path, 'utf8');
		try {
			setRootConfigEntry('replication', { ...readRootConfig().replication, shard: 0, shards: [0, 1] });
			initConfig(true);
			const before = readFileSync(path, 'utf8');
			const beforeStat = statSync(path);
			const backupDir = join(readRootConfig().rootPath, 'backup');
			const backups = existsSync(backupDir) ? readdirSync(backupDir).sort() : [];
			updateConfigValue(undefined, undefined, { REPLICATION_SHARDS: '[0,1]' }, true);
			assert.equal(readFileSync(path, 'utf8'), before);
			assert.equal(statSync(path).mtimeMs, beforeStat.mtimeMs, 'an unchanged boot value must not rewrite the file');
			assert.equal(statSync(path).ino, beforeStat.ino, 'an unchanged boot value must not replace the file');
			assert.deepEqual(existsSync(backupDir) ? readdirSync(backupDir).sort() : [], backups);
		} finally {
			writeFileSync(path, saved);
			initConfig(true);
		}
	});
});
