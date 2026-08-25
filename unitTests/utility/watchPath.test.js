const { canonicalizeWatchPath, resolveWatchTarget, _resetForTests } = require('#src/utility/watchPath');
const assert = require('node:assert');
const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// A symlink named `RUNNER~1` pointing at a long-named directory is the closest host-independent
// model of the Windows 8.3 alias this exists for: `realpathSync.native` rewrites the component.
describe('watchPath', () => {
	let root;
	let longDirectory;
	let aliasLink;
	let longFile;

	before(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'watch-path-')));
		longDirectory = join(root, 'runneradmin');
		aliasLink = join(root, 'RUNNER~1');
		longFile = join(longDirectory, 'config.yaml');
		mkdirSync(longDirectory);
		symlinkSync(longDirectory, aliasLink, 'dir');
		writeFileSync(longFile, 'x: 1');
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
			assert.strictEqual(canonicalizeWatchPath(join(root, 'absent'), 'linux'), join(root, 'absent'));
		});

		it('resolves a directory to its long form', () => {
			assert.strictEqual(canonicalizeWatchPath(aliasLink, 'win32'), longDirectory);
		});

		it('resolves a file reached through a short-form ancestor', () => {
			assert.strictEqual(canonicalizeWatchPath(join(aliasLink, 'config.yaml'), 'win32'), longFile);
		});

		it('resolves a leaf that does not exist yet through its directory', () => {
			// libuv compares only the parent-directory prefix, so a watcher armed before its config file
			// is written still gets a path that cannot trip the assertion.
			assert.strictEqual(
				canonicalizeWatchPath(join(aliasLink, 'not-written-yet.yaml'), 'win32'),
				join(longDirectory, 'not-written-yet.yaml')
			);
		});

		it('fails closed when not even the directory resolves', () => {
			assert.strictEqual(canonicalizeWatchPath(join(root, 'absent', 'absent', 'config.yaml'), 'win32'), undefined);
		});
	});

	describe('resolveWatchTarget', () => {
		const asWindows = (run) => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			try {
				run();
			} finally {
				Object.defineProperty(process, 'platform', originalPlatform);
			}
		};

		it('reports the canonical path and no polling when it resolves', () => {
			asWindows(() => {
				assert.deepStrictEqual(resolveWatchTarget(aliasLink), { path: longDirectory, mustPoll: false });
			});
		});

		it('keeps the original path and demands polling when it does not', () => {
			asWindows(() => {
				const unresolvable = join(root, 'absent', 'absent', 'config.yaml');
				assert.deepStrictEqual(resolveWatchTarget(unresolvable), { path: unresolvable, mustPoll: true });
			});
		});

		it('never demands polling off Windows', () => {
			assert.deepStrictEqual(resolveWatchTarget(join(root, 'absent')), {
				path: join(root, 'absent'),
				mustPoll: false,
			});
		});
	});
});
