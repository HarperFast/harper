import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('published shrinkwrap pruning', function () {
	it('keeps uWebSockets.js opt-in and out of consumer production locks', async function () {
		const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
		assert.strictEqual(manifest.optionalDependencies?.['uWebSockets.js'], undefined);
		assert.strictEqual(manifest.peerDependencies?.['uWebSockets.js'], '20.68.0');
		assert.strictEqual(manifest.peerDependenciesMeta?.['uWebSockets.js']?.optional, true);
		assert.match(manifest.devDependencies?.['uWebSockets.js'], /^https:\/\/github\.com\//);

		const tempDir = await mkdtemp(join(tmpdir(), 'harper-shrinkwrap-'));
		const shrinkwrap = join(tempDir, 'npm-shrinkwrap.json');
		try {
			await copyFile(join(root, 'package-lock.json'), shrinkwrap);
			execFileSync(process.execPath, [join(root, 'build-tools/prune-shrinkwrap-dev.mjs'), shrinkwrap]);

			const lock = JSON.parse(await readFile(shrinkwrap, 'utf8'));
			assert.strictEqual(lock.packages['']?.devDependencies, undefined);
			assert.strictEqual(lock.packages['node_modules/uWebSockets.js'], undefined);
			assert.strictEqual(lock.packages['']?.peerDependencies?.['uWebSockets.js'], '20.68.0');
			assert.strictEqual(lock.packages['']?.peerDependenciesMeta?.['uWebSockets.js']?.optional, true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
