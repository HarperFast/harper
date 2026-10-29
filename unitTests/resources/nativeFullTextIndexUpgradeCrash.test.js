'use strict';

require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { setupTestDBPath } = require('../testUtils');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');

describe('published native full-text upgrade process crash recovery', function () {
	this.timeout(120_000);
	let directory;
	before(async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		directory = path.join(setupTestDBPath(), 'native-upgrade-crashes');
	});
	for (const checkpoint of ['K1', 'K2', 'K3']) {
		it(`rebuilds from source after ${checkpoint} without trusting the interrupted checkpoint`, () => {
			const root = path.join(directory, checkpoint);
			for (const child of ['database', 'log', 'components', 'keys'])
				fs.mkdirSync(path.join(root, child), { recursive: true });
			const config = YAML.parseDocument(
				fs.readFileSync(path.join(__dirname, '../../static/defaultConfig.yaml'), 'utf8')
			);
			config.setIn(['rootPath'], root);
			config.setIn(['storage', 'path'], 'database');
			config.setIn(['componentsRoot'], 'components');
			config.setIn(['logging', 'root'], 'log');
			config.setIn(['logging', 'rotation', 'path'], 'log');
			fs.writeFileSync(path.join(root, 'harper-config.yaml'), config.toString());
			const run = (phase) =>
				spawnSync(
					process.execPath,
					[
						...process.execArgv.filter((argument) => !argument.startsWith('--inspect')),
						path.join(__dirname, 'fixtures/fullTextUpgradeCrashProcess.cjs'),
						root,
						phase,
					],
					{
						env: { ...process.env, ROOTPATH: root, FULLTEXT_PREFER_LOCAL_BUILD: '' },
						encoding: 'utf8',
						timeout: 45_000,
						maxBuffer: 2 * 1024 * 1024,
					}
				);
			const seeded = run('seed');
			assert.strictEqual(seeded.status, 0, `${root}: ${seeded.stderr || seeded.stdout}`);
			assert.match(seeded.stdout, /"seeded":true/);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'exit-seed.json'), 'utf8')), { code: 0 });
			const killed = run(checkpoint);
			assert.ifError(killed.error);
			const exitPath = path.join(root, `exit-${checkpoint}.json`);
			assert.ok(
				!fs.existsSync(exitPath),
				`${root}: normal exit: ${fs.existsSync(exitPath) ? fs.readFileSync(exitPath, 'utf8') : ''}: ${killed.stderr}`
			);
			assert.notStrictEqual(killed.status, 0, `${root}: ${killed.stderr || killed.stdout}`);
			assert.ok(
				killed.signal === 'SIGKILL' || (process.platform === 'win32' && killed.status === 1),
				`${root}: unexpected termination ${killed.status}/${killed.signal}: ${killed.stderr}`
			);
			const sentinel = JSON.parse(fs.readFileSync(path.join(root, 'crash.json'), 'utf8'));
			assert.strictEqual(sentinel.checkpoint, checkpoint);
			assert.strictEqual(sentinel.condemned, true);
			if (checkpoint === 'K1') assert.strictEqual(sentinel.applied, 0);
			if (checkpoint === 'K2') assert.ok(sentinel.applied > 0 && sentinel.applied < 5);
			if (checkpoint === 'K3') assert.strictEqual(sentinel.applied, 5);
			const recovered = run('recover');
			assert.strictEqual(recovered.status, 0, `${root}: ${recovered.stderr || recovered.stdout}`);
			assert.match(recovered.stdout, /"recovered":true/);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'exit-recover.json'), 'utf8')), { code: 0 });
		});
	}
});
