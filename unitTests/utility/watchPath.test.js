const { canonicalizeWatchPath, resolveWatchTarget, _resetForTests } = require('#src/utility/watchPath');
const assert = require('node:assert');
const {
	mkdtempSync,
	mkdirSync,
	symlinkSync,
	realpathSync,
	writeFileSync,
	rmSync,
	readdirSync,
	readFileSync,
} = require('node:fs');
const { join, relative } = require('node:path');
const { tmpdir } = require('node:os');

// A symlink named `RUNNER~1` pointing at a long-named directory models the Windows 8.3 alias this
// exists for: `realpathSync.native` rewrites the component.
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
			assert.strictEqual(
				canonicalizeWatchPath(join(aliasLink, 'not-written-yet.yaml'), 'win32'),
				join(longDirectory, 'not-written-yet.yaml')
			);
		});

		it('fails closed when not even the directory resolves', () => {
			assert.strictEqual(canonicalizeWatchPath(join(root, 'absent', 'absent', 'config.yaml'), 'win32'), undefined);
		});

		it('expands through realpathSync.native, not the symlink-only realpathSync', () => {
			// The symlink model above cannot separate the two — plain `realpathSync` resolves a symlink
			// as well — but only `.native` expands an 8.3 name, so assert the call target itself. A
			// regression to the plain form would otherwise ship green and silently restore the abort.
			const fs = require('node:fs');
			const original = fs.realpathSync.native;
			const resolved = [];
			fs.realpathSync.native = (candidate) => {
				resolved.push(candidate);
				return original(candidate);
			};
			try {
				assert.strictEqual(canonicalizeWatchPath(aliasLink, 'win32'), longDirectory);
			} finally {
				fs.realpathSync.native = original;
			}
			assert.deepStrictEqual(resolved, [aliasLink]);
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

	// The `platform !== 'win32'` early return makes every call site a provable no-op on the ubuntu
	// and macOS runners this repo uses, so no test anywhere would notice a seventh watch site that
	// skipped the helper — and what it produces is the unloggable process abort this exists to
	// remove. This scan is the executable form of the DESIGN.md invariant.
	describe('native watch sites', () => {
		const NATIVE_WATCH_SITES = [
			'components/EntryHandler.ts',
			'components/OptionsWatcher.ts',
			'config/RootConfigWatcher.ts',
			'resources/blob.ts',
			'security/keys.ts',
			'server/threads/manageThreads.js',
		];

		const IMPORTS_CHOKIDAR = /from\s*['"]chokidar['"]|require\(\s*['"]chokidar['"]\s*\)/;
		// `watch`, not `watchFile`: the latter is stat polling with no fs-event handle, so it is
		// outside the invariant (`utility/logging/readLog.ts`).
		const IMPORTS_FS_WATCH =
			/import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*['"](?:node:)?fs['"]|\{[^}]*\bwatch\b[^}]*\}\s*=\s*require\(\s*['"](?:node:)?fs['"]\s*\)/;
		const CALLS_FS_WATCH = /\bfs\.watch\s*\(/;

		const repoRoot = join(__dirname, '..', '..');
		const skippedDirectories = new Set([
			'.claude',
			'.git',
			'dist',
			'docs',
			'integrationTests',
			'node_modules',
			'unitTests',
		]);

		const collectWatchSites = (directory, found = []) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const entryPath = join(directory, entry.name);
				if (entry.isDirectory()) {
					if (!skippedDirectories.has(entry.name)) collectWatchSites(entryPath, found);
					continue;
				}
				if (!/\.(?:ts|js|mjs|cjs)$/.test(entry.name)) continue;
				const source = readFileSync(entryPath, 'utf8');
				if (IMPORTS_CHOKIDAR.test(source) || IMPORTS_FS_WATCH.test(source) || CALLS_FS_WATCH.test(source))
					found.push(relative(repoRoot, entryPath).replace(/\\/g, '/'));
			}
			return found;
		};

		it('are exactly the files that canonicalize their watch path', () => {
			assert.deepStrictEqual(
				collectWatchSites(repoRoot).sort(),
				[...NATIVE_WATCH_SITES].sort(),
				'A file that arms a native watch must canonicalize its path through utility/watchPath.ts ' +
					'(see DESIGN.md) and then be listed here.'
			);
		});

		it('all route their path through the canonicalization helper', () => {
			for (const site of NATIVE_WATCH_SITES) {
				const source = readFileSync(join(repoRoot, site), 'utf8');
				assert.ok(
					/\bresolveWatchTarget\b|\bcanonicalizeWatchPath\b/.test(source),
					`${site} arms a native watch without going through utility/watchPath.ts`
				);
			}
		});
	});
});
