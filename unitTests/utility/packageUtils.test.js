const { describe, it } = require('mocha');

const assert = require('node:assert');
const { join } = require('node:path');
const {
	readFileSync,
	realpathSync,
	symlinkSync,
	rmSync,
	mkdtempSync,
	mkdirSync,
	copyFileSync,
	writeFileSync,
} = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');

const packageUtils = require('#src/utility/packageUtils');

// Compare the fs resolved package.json to an absolute resolution from this test file.
// These tests will fail if this test file changes location.
describe('packageUtils', () => {
	it('should export the HarperDB package.json as packageJson', () => {
		assert.equal(typeof packageUtils.packageJson, 'object');
		const expectedPackageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
		assert.deepEqual(packageUtils.packageJson, expectedPackageJson);
	});

	it('should export the HarperDB package root as PACKAGE_ROOT', () => {
		assert.equal(typeof packageUtils.PACKAGE_ROOT, 'string');
		// realpathSync'd: PACKAGE_ROOT is canonicalized (see the symlink test below), so compare
		// against the canonical form rather than the raw join, which would only coincidentally
		// match unless this suite itself is invoked with --preserve-symlinks.
		assert.equal(packageUtils.PACKAGE_ROOT, realpathSync(join(__dirname, '../..')));
	});

	it('should canonicalize PACKAGE_ROOT when the checkout is reached through a symlink', () => {
		// security/jsLoader.ts's allowed-path check always realpathSync()s the module it is
		// loading before comparing it against an allowedPath prefix. If PACKAGE_ROOT (used as
		// that prefix by consumers/tests) is not equally canonical, a symlinked checkout root
		// makes an in-scope module look "outside of allowed path" even though it isn't.
		//
		// Node's default require() already realpath()s __dirname, which would mask a
		// regression here — so this exercises it under --preserve-symlinks (in a child
		// process, since the flag can't be toggled for an already-running process),
		// the same condition that lets a symlinked checkout diverge from PACKAGE_ROOT.
		const realRoot = join(__dirname, '../..');
		const tmpDir = mkdtempSync(join(os.tmpdir(), 'harper-pkgutils-test-'));
		const linkPath = join(tmpDir, 'harper-link');
		try {
			symlinkSync(realRoot, linkPath, 'dir');
		} catch (err) {
			rmSync(tmpDir, { recursive: true, force: true });
			if (err.code === 'EPERM' || err.code === 'ENOTSUP') return; // no symlink support in this CI env
			throw err;
		}
		try {
			const output = execFileSync(
				process.execPath,
				[
					'--preserve-symlinks',
					'-e',
					`console.log(require(${JSON.stringify(join(linkPath, 'utility/packageUtils.js'))}).PACKAGE_ROOT)`,
				],
				{ encoding: 'utf8' }
			).trim();
			assert.equal(output, realpathSync(realRoot));
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('core runtime layouts', () => {
	const sourceRoot = join(__dirname, '../..');
	const expectedSchema = JSON.parse(readFileSync(join(sourceRoot, 'json/systemSchema.json'), 'utf8'));
	for (const [name, relativeRoot, source] of [
		['standalone source', '', true],
		['standalone compiled', 'dist', false],
		['embedded compiled', 'dist/core', false],
		['source without an inner manifest', 'core', true],
	]) {
		it(`launches a worker and loads core assets in ${name}`, async () => {
			const fixture = mkdtempSync(join(os.tmpdir(), 'harper-core-layout-'));
			let worker;
			try {
				const runtime = join(fixture, relativeRoot);
				mkdirSync(join(runtime, 'utility'), { recursive: true });
				mkdirSync(join(runtime, 'json'), { recursive: true });
				writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'outer-product', version: '1.0.0' }));
				copyFileSync(join(sourceRoot, 'utility/packageUtils.js'), join(runtime, 'utility/packageUtils.js'));
				copyFileSync(join(sourceRoot, 'utility/systemSchema.js'), join(runtime, 'utility/systemSchema.js'));
				copyFileSync(join(sourceRoot, 'json/systemSchema.json'), join(runtime, 'json/systemSchema.json'));
				if (source) copyFileSync(join(sourceRoot, 'utility/hdbTerms.ts'), join(runtime, 'utility/hdbTerms.ts'));
				const extension = source ? '.ts' : '.js';
				writeFileSync(
					join(runtime, `layout-worker${extension}`),
					source
						? "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('core worker');"
						: "require('node:worker_threads').parentPort.postMessage('core worker');"
				);
				const helpers = require(join(runtime, 'utility/packageUtils.js'));
				assert.strictEqual(helpers.PACKAGE_ROOT, realpathSync(fixture));
				assert.strictEqual(helpers.packageJson.name, 'outer-product');
				const { systemSchema } = require(join(runtime, 'utility/systemSchema.js'));
				assert.deepStrictEqual(systemSchema, expectedSchema);
				assert.strictEqual(systemSchema, require(join(runtime, 'json/systemSchema.json')));
				worker = new Worker(join(helpers.RUNTIME_SRC_ROOT, `layout-worker${helpers.RUNTIME_FILE_EXT}`));
				const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
				assert.strictEqual(message, 'core worker');
			} finally {
				if (worker && worker.threadId !== -1) await worker.terminate();
				rmSync(fixture, { recursive: true, force: true });
			}
		});
	}

	for (const prefix of ['', 'core/']) {
		it(`emits the current schema into dist/${prefix}json on every build`, () => {
			const fixture = mkdtempSync(join(os.tmpdir(), 'harper-schema-build-'));
			try {
				mkdirSync(join(fixture, prefix, 'utility'), { recursive: true });
				mkdirSync(join(fixture, prefix, 'json'), { recursive: true });
				copyFileSync(join(sourceRoot, 'utility/systemSchema.js'), join(fixture, prefix, 'utility/systemSchema.js'));
				copyFileSync(join(sourceRoot, 'json/systemSchema.json'), join(fixture, prefix, 'json/systemSchema.json'));
				writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'schema-build-fixture' }));
				writeFileSync(
					join(fixture, 'tsconfig.json'),
					JSON.stringify({
						files: [`${prefix}utility/systemSchema.js`],
						compilerOptions: {
							allowJs: true,
							resolveJsonModule: true,
							module: 'NodeNext',
							moduleResolution: 'NodeNext',
							rootDir: '.',
							outDir: 'dist',
							types: [],
						},
					})
				);
				const build = () =>
					execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', fixture], {
						encoding: 'utf8',
						timeout: 30000,
					});
				build();
				const emitted = join(fixture, 'dist', prefix, 'json/systemSchema.json');
				assert.deepStrictEqual(JSON.parse(readFileSync(emitted, 'utf8')), expectedSchema);
				writeFileSync(emitted, '{"stale":true}');
				build();
				assert.deepStrictEqual(JSON.parse(readFileSync(emitted, 'utf8')), expectedSchema);
			} finally {
				rmSync(fixture, { recursive: true, force: true });
			}
		});
	}
});
