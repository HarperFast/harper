'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { getPackagedDirectorySize } = require('#src/components/packageComponent');

async function makeFixture(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-size-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return dir;
}

describe('getPackagedDirectorySize', () => {
	it('returns the sum of file sizes for a simple tree', async () => {
		const dir = await makeFixture({
			'a.txt': 'A'.repeat(100),
			'b/c.txt': 'C'.repeat(200),
			'b/d/e.txt': 'E'.repeat(50),
		});
		try {
			assert.strictEqual(await getPackagedDirectorySize(dir), 350);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('excludes node_modules when skip_node_modules is true', async () => {
		const dir = await makeFixture({
			'src/app.js': 'a'.repeat(123),
			'node_modules/lib/index.js': 'x'.repeat(1_000_000),
		});
		try {
			const withModules = await getPackagedDirectorySize(dir);
			const withoutModules = await getPackagedDirectorySize(dir, { skip_node_modules: true });
			assert.strictEqual(withModules, 123 + 1_000_000);
			assert.strictEqual(withoutModules, 123);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('also excludes webpack cache when skip_node_modules is true', async () => {
		const dir = await makeFixture({
			'src/a.js': 'a'.repeat(50),
			'.cache/webpack/big.bin': 'x'.repeat(500_000),
		});
		try {
			assert.strictEqual(await getPackagedDirectorySize(dir, { skip_node_modules: true }), 50);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('returns 0 for an empty directory', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-size-empty-'));
		try {
			assert.strictEqual(await getPackagedDirectorySize(dir), 0);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('best-effort: continues past unreadable entries instead of throwing', async () => {
		const dir = await makeFixture({ 'a.txt': 'A'.repeat(10) });
		try {
			// Read from a deliberately-nonexistent sub-path — getPackagedDirectorySize swallows
			// per-entry errors so a transient stat failure can't block a deploy.
			assert.strictEqual(await getPackagedDirectorySize(path.join(dir, 'missing-subdir')), 0);
			assert.strictEqual(await getPackagedDirectorySize(dir), 10);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
