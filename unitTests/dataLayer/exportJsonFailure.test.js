'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveToLocal } = require('#js/dataLayer/export');
const { waitFor } = require('../waitFor');

describe('JSON export to a local file when its source fails', function () {
	let dir;
	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-json-failure-'));
	});
	afterEach(function () {
		const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
		fs.rmSync(dir, { recursive: true, force: true });
		assert.deepStrictEqual(leftovers, [], 'a failed export must remove its temporary file');
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
		await assert.rejects(saveToLocal(target, 'json', rows()));
		assert.strictEqual(fs.existsSync(path.join(target, 'kept')), true);
	});

	it('leaves an existing file at the path unchanged', async function () {
		const filePath = path.join(dir, 'existing.json');
		fs.writeFileSync(filePath, '[{"id":"previous"}]');
		function* rows() {
			yield { id: 1 };
			throw new Error('scan failed');
		}
		await assert.rejects(saveToLocal(filePath, 'json', rows()), /scan failed/);
		assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '[{"id":"previous"}]');
	});

	it('keeps the mode of the file it replaces, and writes through a symlink', async function () {
		if (process.platform === 'win32') this.skip();
		const realPath = path.join(dir, 'real.json');
		const linkPath = path.join(dir, 'link.json');
		fs.writeFileSync(realPath, '[]');
		fs.chmodSync(realPath, 0o600);
		fs.symlinkSync(realPath, linkPath);
		function* rows() {
			yield { id: 1 };
		}
		await saveToLocal(linkPath, 'json', rows());
		assert.strictEqual(fs.lstatSync(linkPath).isSymbolicLink(), true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(realPath, 'utf8')), [{ id: 1 }]);
		assert.strictEqual(fs.statSync(realPath).mode & 0o777, 0o600);
	});

	it('writes through a chain of symlinks whose last target does not exist yet', async function () {
		if (process.platform === 'win32') this.skip();
		const realPath = path.join(dir, 'not-yet.json');
		const middlePath = path.join(dir, 'middle.json');
		const linkPath = path.join(dir, 'dangling.json');
		fs.symlinkSync(realPath, middlePath);
		fs.symlinkSync(middlePath, linkPath);
		function* rows() {
			yield { id: 1 };
		}
		await saveToLocal(linkPath, 'json', rows());
		assert.strictEqual(fs.lstatSync(linkPath).isSymbolicLink(), true);
		assert.strictEqual(fs.lstatSync(middlePath).isSymbolicLink(), true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(realPath, 'utf8')), [{ id: 1 }]);
	});

	it('resolves a link relative to its real directory, as the kernel does', async function () {
		if (process.platform === 'win32') this.skip();
		fs.mkdirSync(path.join(dir, 'real', 'exports'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'real', 'archive'));
		fs.symlinkSync(path.join(dir, 'real', 'exports'), path.join(dir, 'srv'));
		fs.symlinkSync('../archive/out.json', path.join(dir, 'real', 'exports', 'out.json'));
		function* rows() {
			yield { id: 1 };
		}
		await saveToLocal(path.join(dir, 'srv', 'out.json'), 'json', rows());
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'real', 'archive', 'out.json'), 'utf8')), [
			{ id: 1 },
		]);
	});

	it('rejects a symlink cycle', async function () {
		if (process.platform === 'win32') this.skip();
		fs.symlinkSync(path.join(dir, 'b.json'), path.join(dir, 'a.json'));
		fs.symlinkSync(path.join(dir, 'a.json'), path.join(dir, 'b.json'));
		function* rows() {
			yield { id: 1 };
		}
		await assert.rejects(saveToLocal(path.join(dir, 'a.json'), 'json', rows()), { code: 'ELOOP' });
		assert.strictEqual(fs.lstatSync(path.join(dir, 'a.json')).isSymbolicLink(), true);
		assert.strictEqual(fs.lstatSync(path.join(dir, 'b.json')).isSymbolicLink(), true);
	});

	it('never makes the rows readable wider than the file it replaces while writing', async function () {
		if (process.platform === 'win32') this.skip();
		const filePath = path.join(dir, 'private.json');
		fs.writeFileSync(filePath, '[]');
		fs.chmodSync(filePath, 0o600);
		let tempMode;
		async function* rows() {
			yield { id: 1 };
			const temp = await waitFor(() => fs.readdirSync(dir).find((name) => name.endsWith('.tmp')));
			tempMode = fs.statSync(path.join(dir, temp)).mode & 0o777;
			yield { id: 2 };
		}
		await saveToLocal(filePath, 'json', rows());
		assert.strictEqual(tempMode & 0o077, 0);
	});

	it('replaces the file at the path when it succeeds', async function () {
		const filePath = path.join(dir, 'replaced.json');
		fs.writeFileSync(filePath, '[{"id":"previous"}]');
		function* rows() {
			yield { id: 1 };
		}
		await saveToLocal(filePath, 'json', rows());
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), [{ id: 1 }]);
	});
});
