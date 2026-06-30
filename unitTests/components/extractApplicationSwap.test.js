'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { extractApplication, Application } = require('#src/components/Application');
const { packageDirectory } = require('#src/components/packageComponent');

async function makeFixture(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-src-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}
	return dir;
}

describe('extractApplication directory swap', () => {
	// Regression for the replicate-phase failure on a live Next.js peer:
	//   ENOTEMPTY: directory not empty, rmdir '<component>/.next'
	// The old worker keeps writing into .next/cache while the deploy replaces the
	// component directory. Clearing the dir in place with a recursive rm raced that
	// writer (its leaf rmdir of a just-repopulated .next threw ENOTEMPTY). The fix
	// renames the old dir aside atomically, so a concurrent writer can't break it.
	it('replaces a component dir while a worker is actively writing into .next/cache', async function () {
		this.timeout(20000);

		// Stand up a "currently deployed" component dir with a live .next/cache.
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-root-'));
		const dirPath = path.join(componentsRoot, 'web');
		const cacheDir = path.join(dirPath, '.next', 'cache');
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		// Seed many cache files so the (old) recursive rm has a wide window to lose the race.
		for (let i = 0; i < 200; i++) await fs.writeFile(path.join(cacheDir, `seed-${i}`), 'x');

		// The new version we're deploying — two top-level entries so the single-folder
		// normalization path is skipped and we exercise the swap directly.
		const sourceDir = await makeFixture({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'module.exports = () => 2;\n',
		});
		const payload = await packageDirectory(sourceDir, { skip_node_modules: true });

		// Live writer: hammers .next/cache the whole time the swap runs. Every fs error
		// (ENOENT once the dir is renamed away, etc.) is swallowed so it can't surface as
		// an unhandledRejection — it models a process that just keeps writing.
		let writing = true;
		let writes = 0;
		const writer = (async () => {
			while (writing) {
				try {
					await fs.mkdir(cacheDir, { recursive: true });
					await fs.writeFile(path.join(cacheDir, `live-${writes++}`), 'data');
				} catch {
					/* directory swapped out from under us — keep going */
				}
			}
		})();

		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		try {
			// The assertion: this resolves instead of throwing ENOTEMPTY.
			await extractApplication(app);
		} finally {
			writing = false;
			await writer;
		}

		// The deployed payload is in place at the live path.
		assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '2.0.0');
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'index.js'), 'utf8'), 'module.exports = () => 2;\n');
		assert.ok(writes > 0, 'writer should have run during the swap');

		// The renamed-aside copy must stay hidden: the only non-dot entry under the
		// components root is the live component, so loadComponentDirectories (which loads
		// every visible dir as a component) can't pick up an aside as a phantom component.
		const rootEntries = await fs.readdir(componentsRoot);
		assert.deepStrictEqual(
			rootEntries.filter((entry) => !entry.startsWith('.')),
			['web'],
			`unexpected non-hidden entries under components root: ${rootEntries.join(', ')}`
		);

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});
});
