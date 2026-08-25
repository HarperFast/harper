const { canonicalizeWatchPath, resolveWatchTarget, _resetForTests } = require('#src/utility/watchPath');
const assert = require('node:assert');
const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

describe('watchPath', () => {
	let root;
	let realDirectory;
	let linkedDirectory;
	let regularFile;

	before(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'watch-path-')));
		realDirectory = join(root, 'real');
		linkedDirectory = join(root, 'link');
		regularFile = join(root, 'file.txt');
		mkdirSync(join(realDirectory, 'nested'), { recursive: true });
		symlinkSync(realDirectory, linkedDirectory, 'dir');
		writeFileSync(regularFile, 'contents');
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		_resetForTests();
	});

	describe('canonicalizeWatchPath', () => {
		it('leaves the path untouched off Windows', () => {
			// realpathSync.native would resolve symlinks here, which would change which tree an
			// npm-linked component watches.
			assert.strictEqual(canonicalizeWatchPath(linkedDirectory, 'linux'), linkedDirectory);
			assert.strictEqual(canonicalizeWatchPath(linkedDirectory, 'darwin'), linkedDirectory);
		});

		it('canonicalizes an existing path on Windows', () => {
			assert.strictEqual(canonicalizeWatchPath(linkedDirectory, 'win32'), realDirectory);
		});

		it('resolves a not-yet-created path through its deepest existing ancestor', () => {
			assert.strictEqual(
				canonicalizeWatchPath(join(linkedDirectory, 'nested', 'config.yaml'), 'win32'),
				join(realDirectory, 'nested', 'config.yaml')
			);
		});

		it('preserves every missing segment, not just the last one', () => {
			assert.strictEqual(
				canonicalizeWatchPath(join(linkedDirectory, 'later', 'deeper', 'config.yaml'), 'win32'),
				join(realDirectory, 'later', 'deeper', 'config.yaml')
			);
		});

		it('fails closed when the failure is not a missing leaf', () => {
			// A regular file used as a directory yields ENOTDIR, not ENOENT: the long form cannot be
			// established, so no path may be handed to a native watch.
			assert.strictEqual(canonicalizeWatchPath(join(regularFile, 'child.yaml'), 'win32'), undefined);
		});
	});

	describe('resolveWatchTarget', () => {
		it('reports the canonical path and no polling when it resolves', () => {
			assert.deepStrictEqual(resolveWatchTarget(realDirectory), { path: realDirectory, mustPoll: false });
		});

		it('keeps the original path and demands polling when canonicalization fails', () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			try {
				const unresolvable = join(regularFile, 'child.yaml');
				assert.deepStrictEqual(resolveWatchTarget(unresolvable), { path: unresolvable, mustPoll: true });
			} finally {
				Object.defineProperty(process, 'platform', originalPlatform);
			}
		});
	});
});
