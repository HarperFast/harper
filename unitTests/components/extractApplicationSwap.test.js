'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { Readable } = require('node:stream');
const { waitFor } = require('../waitFor.js');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	extractApplication,
	recoverInterruptedComponentExtraction,
	recoverInterruptedComponentExtractions,
	dropComponentDirectory,
	makeRollbackPlaceholderMovable,
	Application,
} = require('#src/components/Application');
const { packageDirectory } = require('#src/components/packageComponent');
const {
	ComponentPreparationLockTimeoutError,
	withComponentPreparationLock,
} = require('#src/components/componentPreparationLock');

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
	it('restores the exact previous tree when payload extraction fails', async function () {
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-rollback-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(path.join(dirPath, 'nested'), { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(dirPath, '.env'), 'OLD_ONLY=true\n');
		await fs.writeFile(path.join(dirPath, 'nested', 'old-only.txt'), 'previous bytes\n');
		const sourceDir = await makeFixture({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'module.exports = () => 2;\n',
		});
		const archive = await packageDirectory(sourceDir, { skip_node_modules: true });
		const extractionError = new Error('payload delivery failed');
		const payload = Readable.from(
			(async function* () {
				yield archive.subarray(0, Math.floor(archive.length / 2));
				throw extractionError;
			})()
		);
		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		try {
			await assert.rejects(
				() => extractApplication(app),
				(error) => error === extractionError
			);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			assert.strictEqual(await fs.readFile(path.join(dirPath, '.env'), 'utf8'), 'OLD_ONLY=true\n');
			assert.strictEqual(await fs.readFile(path.join(dirPath, 'nested', 'old-only.txt'), 'utf8'), 'previous bytes\n');
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('restores a dangling symlink when payload extraction fails', async function () {
		if (process.platform === 'win32') this.skip();
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-dangling-symlink-'));
		const dirPath = path.join(componentsRoot, 'web');
		const missingTarget = path.join(componentsRoot, 'missing-target');
		const extractionError = new Error('payload delivery failed');
		await fs.symlink(missingTarget, dirPath, 'dir');
		const app = new Application({
			name: 'web',
			payload: new Readable({
				read() {
					this.destroy(extractionError);
				},
			}),
		});
		app.dirPath = dirPath;

		try {
			await assert.rejects(() => extractApplication(app), extractionError);
			assert.strictEqual((await fs.lstat(dirPath)).isSymbolicLink(), true);
			assert.strictEqual(await fs.readlink(dirPath), missingTarget);
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('removes a partial directory when a first deploy fails', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-new-failure-'));
		const dirPath = path.join(componentsRoot, 'web');
		const extractionError = new Error('payload delivery failed');
		const payload = new Readable({
			read() {
				this.destroy(extractionError);
			},
		});
		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		try {
			await assert.rejects(() => extractApplication(app), extractionError);
			await assert.rejects(fs.access(dirPath));
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('removes a partial first deploy after an interrupted process restarts', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-first-deploy-crash-'));
		const dirPath = path.join(componentsRoot, 'web');
		const stagingDir = path.join(componentsRoot, '.deploy-aside', 'web');
		const absentMarker = path.join(stagingDir, '.in-progress-123-1-record-prior-absent');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web"');
		await fs.mkdir(stagingDir, { recursive: true });
		await fs.writeFile(absentMarker, '');

		try {
			const failures = await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(failures.size, 0, failures.get('web')?.stack);
			await assert.rejects(fs.access(dirPath));
			await assert.rejects(fs.access(stagingDir));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('settles a deferred extraction transaction only once', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-idempotent-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		const sourceDir = await makeFixture({ 'package.json': '{"name":"web","version":"2.0.0"}\n' });
		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = dirPath;

		try {
			const extraction = await extractApplication(app, true);
			await extraction.rollback();
			await extraction.rollback();
			await extraction.commit();
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('recovers the newest marked aside over a partial replacement before retrying', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-recover-'));
		const dirPath = path.join(componentsRoot, 'web');
		const olderAside = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-100-previous');
		const staleAside = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-200-previous');
		const malformedAside = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-999999');
		await fs.mkdir(olderAside, { recursive: true });
		await fs.writeFile(path.join(olderAside, 'package.json'), '{"name":"web","version":"0.9.0"}\n');
		await fs.mkdir(staleAside, { recursive: true });
		await fs.writeFile(path.join(staleAside, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(staleAside, 'old-only.txt'), 'previous bytes\n');
		await fs.mkdir(malformedAside, { recursive: true });
		await fs.writeFile(path.join(malformedAside, 'package.json'), '{"name":"web","version":"9.9.9"}\n');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		await fs.writeFile(path.join(dirPath, 'partial-only.txt'), 'incomplete bytes\n');
		const extractionError = new Error('payload delivery failed again');
		const payload = new Readable({
			read() {
				this.destroy(extractionError);
			},
		});
		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		try {
			await assert.rejects(() => extractApplication(app), extractionError);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			assert.strictEqual(await fs.readFile(path.join(dirPath, 'old-only.txt'), 'utf8'), 'previous bytes\n');
			await assert.rejects(fs.access(path.join(dirPath, 'partial-only.txt')));
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('retires losing recovery candidates so a failed cleanup cannot resurrect them', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-retire-losers-'));
		const dirPath = path.join(componentsRoot, 'web');
		const stagingDir = path.join(componentsRoot, '.deploy-aside', 'web');
		const losingAside = path.join(stagingDir, '.in-progress-100-previous');
		const winningAside = path.join(stagingDir, '.in-progress-200-previous');
		await fs.mkdir(losingAside, { recursive: true });
		await fs.writeFile(path.join(losingAside, 'package.json'), '{"name":"web","version":"0.9.0"}\n');
		await fs.mkdir(winningAside, { recursive: true });
		await fs.writeFile(path.join(winningAside, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		// Deny the best-effort cleanup permission to empty the losing aside, so it outlives recovery.
		await fs.chmod(losingAside, 0o500);

		try {
			assert.strictEqual((await recoverInterruptedComponentExtractions(componentsRoot)).size, 0);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			await fs.access(losingAside);
			await fs.access(path.join(stagingDir, '.retired-100-previous'));

			assert.strictEqual((await recoverInterruptedComponentExtractions(componentsRoot)).size, 0);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
		} finally {
			await fs.chmod(losingAside, 0o700).catch(() => {});
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('does not resurrect a committed cleanup leftover after the component was dropped', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-dropped-'));
		const dirPath = path.join(componentsRoot, 'web');
		const stagingDir = path.join(componentsRoot, '.deploy-aside', 'web');
		const retiredAside = path.join(stagingDir, '.in-progress-123-previous');
		await fs.mkdir(retiredAside, { recursive: true });
		await fs.writeFile(path.join(retiredAside, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(stagingDir, '.retired-123-previous'), '');
		const extractionError = new Error('new deployment failed');
		const app = new Application({
			name: 'web',
			payload: new Readable({
				read() {
					this.destroy(extractionError);
				},
			}),
		});
		app.dirPath = dirPath;

		try {
			await assert.rejects(() => extractApplication(app), extractionError);
			await assert.rejects(fs.access(dirPath));
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('keeps a retained replacement live when its previous tree is retired', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-retained-replacement-'));
		const dirPath = path.join(componentsRoot, 'web');
		const stagingDir = path.join(componentsRoot, '.deploy-aside', 'web');
		const retiredAside = path.join(stagingDir, '.in-progress-123-previous');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		await fs.mkdir(retiredAside, { recursive: true });
		await fs.writeFile(path.join(retiredAside, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(stagingDir, '.retired-123-previous'), '');

		try {
			await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '2.0.0');
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('recovers an interrupted deploy before component loading', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-startup-recovery-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(asidePath, 'old-only.txt'), 'previous bytes\n');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		await fs.writeFile(path.join(dirPath, 'partial-only.txt'), 'incomplete bytes\n');

		try {
			await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			assert.strictEqual(await fs.readFile(path.join(dirPath, 'old-only.txt'), 'utf8'), 'previous bytes\n');
			await assert.rejects(fs.access(path.join(dirPath, 'partial-only.txt')));
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('recovers a symlinked predecessor after an interrupted deploy', async function () {
		if (process.platform === 'win32') this.skip();
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-symlink-recovery-'));
		const previousTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-symlink-target-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(path.dirname(asidePath), { recursive: true });
		await fs.symlink(previousTarget, asidePath, 'dir');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');

		try {
			const failures = await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(failures.size, 0, failures.get('web')?.stack);
			assert.strictEqual((await fs.lstat(dirPath)).isSymbolicLink(), true);
			assert.strictEqual(await fs.readlink(dirPath), previousTarget);
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			await fs.rm(previousTarget, { recursive: true, force: true });
		}
	});

	it('defers bulk recovery, then waits for active preparation before recovering the component', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-startup-race-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		let releaseRecovery;
		let recoveryStarted;
		const started = new Promise((resolve) => (recoveryStarted = resolve));
		const recovery = withComponentPreparationLock(dirPath, async () => {
			recoveryStarted();
			await new Promise((resolve) => (releaseRecovery = resolve));
		});

		try {
			await started;
			const failures = await recoverInterruptedComponentExtractions(componentsRoot);
			assert(failures.get('web') instanceof ComponentPreparationLockTimeoutError);
			setTimeout(() => releaseRecovery(), 350);
			await recoverInterruptedComponentExtraction(componentsRoot, 'web', true, 100);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
		} finally {
			releaseRecovery?.();
			await recovery;
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('bounds bulk recovery while a peer recovery remains live', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-peer-recovery-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		let releaseRecovery;
		let recoveryStarted;
		const started = new Promise((resolve) => (recoveryStarted = resolve));
		const recovery = withComponentPreparationLock(
			dirPath,
			async () => {
				recoveryStarted();
				await new Promise((resolve) => (releaseRecovery = resolve));
			},
			{ purpose: 'component-recovery' }
		);

		try {
			await started;
			let failIfUnbounded;
			const failures = await Promise.race([
				recoverInterruptedComponentExtractions(componentsRoot),
				new Promise((_, reject) => {
					failIfUnbounded = setTimeout(
						() => reject(new Error('bulk recovery waited past its bounded lock timeout')),
						1000
					);
				}),
			]).finally(() => clearTimeout(failIfUnbounded));
			assert(failures.get('web') instanceof ComponentPreparationLockTimeoutError);
			releaseRecovery();
			await recovery;
			await recoverInterruptedComponentExtraction(componentsRoot, 'web');
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
		} finally {
			releaseRecovery?.();
			await recovery;
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('retires interrupted deploy state before a component is dropped', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-drop-retire-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"2.0.0"}\n');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');

		try {
			await dropComponentDirectory(dirPath);
			await recoverInterruptedComponentExtractions(componentsRoot);
			await assert.rejects(fs.access(dirPath));
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('cleans only paths owned by the settled transaction', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-owned-cleanup-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		const sourceDir = await makeFixture({ 'package.json': '{"name":"web","version":"2.0.0"}\n' });
		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = dirPath;
		const unrelatedPath = path.join(componentsRoot, '.deploy-aside', 'web', 'unrelated-transaction');

		try {
			const extraction = await extractApplication(app, true);
			await fs.mkdir(unrelatedPath, { recursive: true });
			await fs.writeFile(path.join(unrelatedPath, 'marker'), 'keep\n');
			await extraction.commit();
			assert.strictEqual(await fs.readFile(path.join(unrelatedPath, 'marker'), 'utf8'), 'keep\n');
			assert.strictEqual((await fs.stat(path.join(componentsRoot, '.deploy-aside'))).mode & 0o777, 0o700);
			assert.strictEqual((await fs.stat(path.dirname(unrelatedPath))).mode & 0o777, 0o700);
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it('rejects a symlinked deploy staging directory', async function () {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-symlink-'));
		const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-external-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		try {
			await fs.symlink(externalDir, path.join(componentsRoot, '.deploy-aside'), 'dir');
		} catch (error) {
			if (error.code === 'EPERM') {
				await fs.rm(componentsRoot, { recursive: true, force: true });
				await fs.rm(externalDir, { recursive: true, force: true });
				this.skip();
			}
			throw error;
		}
		const payload = new Readable({ read() {} });
		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		try {
			await assert.rejects(() => extractApplication(app), /deploy staging path is not a directory/);
			assert.strictEqual(payload.destroyed, true);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			assert.deepStrictEqual(await fs.readdir(externalDir), []);
		} finally {
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			await fs.rm(externalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

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

	it('atomically restores the previous tree when preparation fails under a live writer', async function () {
		this.timeout(20000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-live-rollback-'));
		const dirPath = path.join(componentsRoot, 'web');
		const cacheDir = path.join(dirPath, '.next', 'cache');
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(dirPath, 'index.js'), 'module.exports = () => 1;\n');
		const sourceDir = await makeFixture({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'module.exports = () => 2;\n',
		});
		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = dirPath;

		let writing = true;
		const writer = (async () => {
			let writes = 0;
			while (writing) {
				try {
					await fs.mkdir(cacheDir, { recursive: true });
					await fs.writeFile(path.join(cacheDir, `live-${writes++}`), 'data');
				} catch {
					/* directory swapped between writes */
				}
			}
		})();

		try {
			const extraction = await extractApplication(app, true);
			await extraction.rollback();
		} finally {
			writing = false;
			await writer;
		}

		assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'index.js'), 'utf8'), 'module.exports = () => 1;\n');
		assert.deepStrictEqual(
			(await fs.readdir(componentsRoot)).filter((entry) => !entry.startsWith('.')),
			['web']
		);

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	it('makes only the tracked rollback placeholder movable', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-placeholder-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		const placeholder = await fs.lstat(dirPath, { bigint: true });

		try {
			await fs.chmod(dirPath, 0o000);
			await makeRollbackPlaceholderMovable(dirPath, { dev: placeholder.dev, ino: placeholder.ino });
			assert.strictEqual((await fs.lstat(dirPath)).mode & 0o777, 0o700);

			await fs.chmod(dirPath, 0o000);
			await makeRollbackPlaceholderMovable(dirPath, { dev: placeholder.dev, ino: placeholder.ino + 1n });
			assert.strictEqual((await fs.lstat(dirPath)).mode & 0o777, 0o000);
		} finally {
			await fs.chmod(dirPath, 0o700).catch(() => {});
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('adopts an owner-owned rollback placeholder during interrupted recovery', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
		this.timeout(15000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-placeholder-recovery-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.mkdir(dirPath);
		await fs.writeFile(path.join(dirPath, 'writer-created'), 'occupied');
		await fs.chmod(dirPath, 0o100);

		try {
			const failures = await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(failures.size, 0);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.chmod(dirPath, 0o700).catch(() => {});
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('adopts a rollback placeholder interrupted before its restrictive chmod', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
		this.timeout(15000);
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-placeholder-chmod-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.mkdir(dirPath, { mode: 0o700 });
		await fs.writeFile(path.join(dirPath, 'writer-created'), 'occupied');
		await fs.chmod(dirPath, 0o300);

		try {
			const failures = await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(failures.size, 0);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.chmod(dirPath, 0o700).catch(() => {});
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('adopts a mode-000 directory placeholder left by an interrupted rollback', async function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
		this.timeout(15000);
		// Builds before the placeholder gained its 0o300/0o100 modes left mode-000 directories behind.
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-placeholder-zero-'));
		const dirPath = path.join(componentsRoot, 'web');
		const asidePath = path.join(componentsRoot, '.deploy-aside', 'web', '.in-progress-123-previous');
		await fs.mkdir(asidePath, { recursive: true });
		await fs.writeFile(path.join(asidePath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.mkdir(dirPath, { mode: 0o700 });
		await fs.writeFile(path.join(dirPath, 'writer-created'), 'occupied');
		await fs.chmod(dirPath, 0o000);

		try {
			const failures = await recoverInterruptedComponentExtractions(componentsRoot);
			assert.strictEqual(failures.size, 0);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
			await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));
		} finally {
			await fs.chmod(dirPath, 0o700).catch(() => {});
			await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it('reclaims a stale aside copy left by an earlier deploy', async function () {
		this.timeout(20000);

		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-reclaim-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');

		// A leftover aside from a previous deploy whose worker has since exited — the kind
		// of residue the best-effort cleanup tolerates, to be reclaimed by the next deploy.
		const staleAside = path.join(componentsRoot, '.deploy-aside', 'web', 'stale-from-last-deploy');
		await fs.mkdir(staleAside, { recursive: true });
		await fs.writeFile(path.join(staleAside, 'leftover'), 'x');

		const sourceDir = await makeFixture({
			'package.json': '{"name":"web","version":"2.0.0"}\n',
			'index.js': 'module.exports = () => 2;\n',
		});
		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = dirPath;

		await extractApplication(app);

		// Cleanup is fire-and-forget; with no live worker holding it, the staging dir is
		// reclaimed promptly. Poll briefly so the assertion isn't racing the deferred rm.
		const asideRoot = path.join(componentsRoot, '.deploy-aside', 'web');
		const deadline = Date.now() + 5000;
		let asideGone = false;
		while (Date.now() < deadline) {
			if (
				!(await fs
					.stat(asideRoot)
					.then(() => true)
					.catch(() => false))
			) {
				asideGone = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(asideGone, 'stale aside staging dir should be reclaimed by the deploy');
		assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '2.0.0');

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	it('normalizes a single-directory archive through hidden staging', async () => {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-normalize-'));
		const dirPath = path.join(componentsRoot, 'web');
		const sourceDir = await makeFixture({
			'wrapper/package.json': '{"name":"web","version":"2.0.0"}\n',
			'wrapper/index.js': 'module.exports = () => 2;\n',
		});
		const archive = await packageDirectory(sourceDir, { skip_node_modules: true });
		let finishPayload;
		const payload = Readable.from(
			(async function* () {
				yield archive;
				await new Promise((resolve) => (finishPayload = resolve));
			})()
		);
		const app = new Application({ name: 'web', payload });
		app.dirPath = dirPath;

		const extraction = extractApplication(app);
		await waitFor(() =>
			fs.access(path.join(dirPath, 'wrapper', 'package.json')).then(
				() => true,
				() => false
			)
		);
		const liveDirectoryIdentity = await fs.lstat(dirPath, { bigint: true });
		finishPayload();
		await extraction;

		assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '2.0.0');
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'index.js'), 'utf8'), 'module.exports = () => 2;\n');
		if (process.platform === 'win32') {
			const normalizedDirectoryIdentity = await fs.lstat(dirPath, { bigint: true });
			assert.strictEqual(normalizedDirectoryIdentity.dev, liveDirectoryIdentity.dev);
			assert.strictEqual(normalizedDirectoryIdentity.ino, liveDirectoryIdentity.ino);
		}
		assert.deepStrictEqual(
			(await fs.readdir(componentsRoot)).filter((entry) => !entry.startsWith('.')),
			['web'],
			'archive normalization must not leave a visible sibling that can load as a component'
		);

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	// harper#1806: deployComponent uses Application#isNewComponent to scope its own
	// requestRestart() call to components that have never been deployed before, leaving an
	// existing component's redeploy to the component's own file watcher.
	it('marks isNewComponent true when the component directory did not exist before extraction', async () => {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-new-'));
		const sourceDir = await makeFixture({ 'package.json': '{"name":"web","version":"1.0.0"}\n' });

		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = path.join(componentsRoot, 'web');

		assert.strictEqual(app.isNewComponent, true, 'defaults to true before extraction runs');
		await extractApplication(app);
		assert.strictEqual(app.isNewComponent, true, 'no prior directory existed, so this is a new component');
		await assert.rejects(fs.access(path.join(componentsRoot, '.deploy-aside', 'web')));

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	it('marks isNewComponent false when an existing component directory is replaced', async () => {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-existing-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');

		const sourceDir = await makeFixture({ 'package.json': '{"name":"web","version":"2.0.0"}\n' });
		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = dirPath;

		await extractApplication(app);
		assert.strictEqual(app.isNewComponent, false, 'a pre-existing directory was renamed aside, so this is a redeploy');

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	it('restores the previous component directory when extraction fails', async () => {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-rollback-'));
		const dirPath = path.join(componentsRoot, 'web');
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), '{"name":"web","version":"1.0.0"}\n');
		await fs.writeFile(path.join(dirPath, 'index.js'), 'module.exports = () => 1;\n');

		const app = new Application({ name: 'web', payload: Buffer.from('not a tar archive') });
		app.dirPath = dirPath;

		await assert.rejects(() => extractApplication(app));
		assert.strictEqual(JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf8')).version, '1.0.0');
		assert.strictEqual(await fs.readFile(path.join(dirPath, 'index.js'), 'utf8'), 'module.exports = () => 1;\n');
		assert.deepStrictEqual(
			(await fs.readdir(componentsRoot)).filter((entry) => !entry.startsWith('.')),
			['web']
		);

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it('leaves runtime metadata comparison to post-install preparation', async () => {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-identical-'));
		const dirPath = path.join(componentsRoot, 'web');
		const packageJSON = '{"name":"web","version":"1.0.0"}\n';
		await fs.mkdir(dirPath, { recursive: true });
		await fs.writeFile(path.join(dirPath, 'package.json'), packageJSON);
		await fs.writeFile(path.join(dirPath, 'package-lock.json'), '{"lockfileVersion":3}\n');

		const sourceDir = await makeFixture({
			'package.json': packageJSON,
			'package-lock.json': '{"lockfileVersion":3}\n',
		});
		const app = new Application({
			name: 'web',
			payload: await packageDirectory(sourceDir, { skip_node_modules: true }),
		});
		app.dirPath = dirPath;

		await extractApplication(app);
		assert.strictEqual(app.isNewComponent, false);
		assert.strictEqual(app.packageMetadataChanged, false, 'extraction alone does not compare pre-install metadata');

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	// componentLoader fails startup closed when this scan rejects, so the two outcomes have to stay
	// distinguishable: an absent staging root is a fresh install with no work, while an unreadable one
	// means some component may hold a half-extracted tree we could not see.
	it('resolves empty when the staging root is absent but rejects when it is unreadable', async () => {
		const componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-swap-scan-'));

		assert.strictEqual((await recoverInterruptedComponentExtractions(componentsRoot)).size, 0);

		await fs.writeFile(path.join(componentsRoot, '.deploy-aside'), 'not a directory\n');
		await assert.rejects(
			() => recoverInterruptedComponentExtractions(componentsRoot),
			/staging path is not a directory/
		);

		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
});
