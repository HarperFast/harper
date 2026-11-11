const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PID_DIR_PATH } = require('../perPidRoot');
const { RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();

describe('RocksDB flush on process.exit()', function () {
	this.timeout(60_000);
	let root;
	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
	});
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(PID_DIR_PATH, 'exit-flush-'));
	});
	afterEach(() => {
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});

	function writeThenExit(env) {
		const child = spawnSync(
			process.execPath,
			[...process.execArgv, path.join(__dirname, 'fixtures/exitFlushChild.cjs'), root],
			{
				env: { ...process.env, ...env },
				encoding: 'utf8',
				timeout: 30_000,
			}
		);
		assert.strictEqual(child.status, 0, child.stderr);
		const db = RocksDatabase.open(root);
		try {
			return db.getSync('key');
		} finally {
			db.close();
		}
	}

	it('keeps an unlogged write', () => {
		assert.strictEqual(writeThenExit({ HARPER_NO_FLUSH_ON_EXIT: '' }), 'value');
	});

	it('drops an unlogged write under HARPER_NO_FLUSH_ON_EXIT', () => {
		assert.strictEqual(writeThenExit({ HARPER_NO_FLUSH_ON_EXIT: '1' }), undefined);
	});
});
