'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveToLocal } = require('#js/dataLayer/export');

describe('CSV export to a local file when its source fails', function () {
	this.timeout(10000);
	let dir;
	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-csv-failure-'));
	});
	afterEach(function () {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('rejects with the source error instead of never finishing', async function () {
		function* rows() {
			yield { id: 1 };
			throw new Error('scan failed');
		}
		await assert.rejects(saveToLocal(path.join(dir, 'failed.csv'), 'csv', rows()), /scan failed/);
	});

	it('writes every row when the source succeeds', async function () {
		function* rows() {
			yield { id: 1 };
			yield { id: 2 };
		}
		const filePath = path.join(dir, 'ok.csv');
		await saveToLocal(filePath, 'csv', rows());
		assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '"id"\n1\n2\n');
	});
});
