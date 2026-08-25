const { canonicalizeWatchPath, resolveWatchTarget, _resetForTests } = require('#src/utility/watchPath');
const assert = require('node:assert');
const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// On Windows the 8.3 alias `RUNNER~1` expands to a different long name; the closest host-independent
// model of that is a symlink named with an 8.3-shaped component pointing at a long-named directory.
describe('watchPath', () => {
	let root;
	let longDirectory;
	let aliasLink;
	let stubbornShortDirectory;

	before(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'watch-path-')));
		longDirectory = join(root, 'runneradmin');
		aliasLink = join(root, 'RUNNER~1');
		stubbornShortDirectory = join(root, 'STILL~1');
		mkdirSync(longDirectory);
		mkdirSync(stubbornShortDirectory);
		symlinkSync(longDirectory, aliasLink, 'dir');
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		_resetForTests();
	});

	describe('canonicalizeWatchPath', () => {
		it('leaves every path untouched off Windows', () => {
			assert.strictEqual(canonicalizeWatchPath(aliasLink, 'linux'), aliasLink);
			assert.strictEqual(canonicalizeWatchPath(aliasLink, 'darwin'), aliasLink);
		});

		it('leaves a path with no 8.3 component untouched, without hitting the filesystem', () => {
			// Nothing here exists, so a resolution attempt would fail closed; getting the input back
			// proves paths that cannot abort are never resolved (and never symlink-resolved).
			const noSuchPath = join(root, 'absent', 'config.yaml');
			assert.strictEqual(canonicalizeWatchPath(noSuchPath, 'win32'), noSuchPath);
		});

		it('expands an 8.3 component to its long form', () => {
			assert.strictEqual(canonicalizeWatchPath(aliasLink, 'win32'), longDirectory);
			assert.strictEqual(canonicalizeWatchPath(join(aliasLink, 'config.yaml'), 'win32'), undefined);
		});

		it('fails closed when the resolved path is still short', () => {
			// The abort needs only one surviving 8.3 component, so a resolution that did not expand it
			// is not proof of anything.
			assert.strictEqual(canonicalizeWatchPath(stubbornShortDirectory, 'win32'), undefined);
		});

		it('fails closed when a short path cannot be resolved at all', () => {
			assert.strictEqual(canonicalizeWatchPath(join(root, 'GONE~1', 'config.yaml'), 'win32'), undefined);
		});
	});

	describe('resolveWatchTarget', () => {
		it('reports the path and no polling when nothing needs expanding', () => {
			assert.deepStrictEqual(resolveWatchTarget(longDirectory), { path: longDirectory, mustPoll: false });
		});

		it('keeps the original path and demands polling when the long form cannot be established', () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			try {
				assert.deepStrictEqual(resolveWatchTarget(stubbornShortDirectory), {
					path: stubbornShortDirectory,
					mustPoll: true,
				});
			} finally {
				Object.defineProperty(process, 'platform', originalPlatform);
			}
		});
	});
});
