'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveToLocal } = require('#js/dataLayer/export');

describe('JSON export to a local file when its source fails', function () {
	let dir;
	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-json-failure-'));
	});
	afterEach(function () {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('rejects and leaves no file when the source throws mid-stream', async function () {
		function* rows() {
			yield { id: 1 };
			throw new Error('scan failed');
		}
		const filePath = path.join(dir, 'failed.json');
		await assert.rejects(saveToLocal(filePath, 'json', rows()), /scan failed/);
		assert.strictEqual(fs.existsSync(filePath), false);
	});

	it('rejects and leaves no file when the source throws before its file opens', async function () {
		const rows = {
			[Symbol.iterator]() {
				return {
					next() {
						throw new Error('scan failed at once');
					},
				};
			},
		};
		const filePath = path.join(dir, 'early.json');
		await assert.rejects(saveToLocal(filePath, 'json', rows), /scan failed at once/);
		assert.strictEqual(fs.existsSync(filePath), false);
	});

	it('leaves a target it could not open alone', async function () {
		function* rows() {
			yield { id: 1 };
		}
		const target = path.join(dir, 'existing.json');
		fs.mkdirSync(path.join(target, 'kept'), { recursive: true });
		await assert.rejects(saveToLocal(target, 'json', rows()), /EISDIR/);
		assert.strictEqual(fs.existsSync(path.join(target, 'kept')), true);
	});

	it('leaves a file another export put at the same path after this one opened it', async function () {
		const filePath = path.join(dir, 'shared.json');
		async function* rows() {
			yield { id: 1 };
			await new Promise((resolve) => setTimeout(resolve, 20));
			fs.rmSync(filePath);
			fs.writeFileSync(filePath, '[{"id":"other"}]');
			throw new Error('scan failed');
		}
		await assert.rejects(saveToLocal(filePath, 'json', rows()), /scan failed/);
		assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '[{"id":"other"}]');
	});
});
