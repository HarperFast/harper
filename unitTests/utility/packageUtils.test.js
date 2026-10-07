const { describe, it } = require('mocha');

const assert = require('node:assert');
const { join, dirname } = require('node:path');
const {
	readFileSync,
	realpathSync,
	symlinkSync,
	rmSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	copyFileSync,
} = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

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

	describe('PRODUCT_NAME', () => {
		it("is this package's productName", () => {
			assert.equal(packageUtils.PRODUCT_NAME, 'Harper');
		});

		function productNameFor(manifests, modulePath) {
			const tmpDir = mkdtempSync(join(os.tmpdir(), 'harper-product-name-test-'));
			try {
				for (const [dir, manifest] of Object.entries(manifests)) {
					mkdirSync(join(tmpDir, dir), { recursive: true });
					writeFileSync(join(tmpDir, dir, 'package.json'), JSON.stringify(manifest));
				}
				mkdirSync(join(tmpDir, dirname(modulePath)), { recursive: true });
				copyFileSync(join(__dirname, '../../utility/packageUtils.js'), join(tmpDir, modulePath));
				return execFileSync(
					process.execPath,
					['-e', `console.log(require(${JSON.stringify(join(tmpDir, modulePath))}).PRODUCT_NAME)`],
					{ encoding: 'utf8', cwd: os.tmpdir() }
				).trim();
			} finally {
				rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
			}
		}

		it("uses the embedding distribution's productName for its compiled core", () => {
			// Harper Pro ships core compiled under dist/core with no package.json of its own
			assert.equal(
				productNameFor(
					{ '.': { name: '@harperfast/harper-pro', productName: 'Harper Pro' } },
					'dist/core/utility/packageUtils.js'
				),
				'Harper Pro'
			);
		});

		it('uses the nearest package rather than an enclosing application', () => {
			assert.equal(
				productNameFor(
					{
						'.': { name: 'my-app', productName: 'My App' },
						'node_modules/harper': { name: 'harper', productName: 'Harper' },
					},
					'node_modules/harper/utility/packageUtils.js'
				),
				'Harper'
			);
		});

		it('falls back to Harper when productName is missing or empty', () => {
			assert.equal(productNameFor({ '.': { name: 'harper' } }, 'utility/packageUtils.js'), 'Harper');
			assert.equal(productNameFor({ '.': { name: 'harper', productName: '' } }, 'utility/packageUtils.js'), 'Harper');
		});
	});
});
