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

// A symlink pointing at a long-named directory models the Windows 8.3 alias this exists for:
// `realpathSync.native` rewrites the component. The link must NOT be named after the alias NTFS
// would itself generate for its sibling (`runneradmin` -> `RUNNER~1`): on a volume with 8.3 name
// creation enabled that name is already taken, and symlinkSync fails EEXIST before any test runs.
describe('watchPath', () => {
	let root;
	let longDirectory;
	let aliasLink;
	let longFile;

	before(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'watch-path-')));
		longDirectory = join(root, 'runneradmin');
		aliasLink = join(root, 'WPLINK~1');
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

		// The symlink model cannot separate `.native` from plain `realpathSync` — both resolve a
		// symlink — but only `.native` expands an 8.3 name, so assert the call target itself.
		const recordingNativeCalls = (run, resolve) => {
			const fs = require('node:fs');
			const original = fs.realpathSync.native;
			const resolved = [];
			fs.realpathSync.native = (candidate) => {
				resolved.push(candidate);
				return resolve ? resolve(candidate, original) : original(candidate);
			};
			try {
				run();
			} finally {
				fs.realpathSync.native = original;
			}
			return resolved;
		};

		it('expands an existing path through realpathSync.native', () => {
			const resolved = recordingNativeCalls(() =>
				assert.strictEqual(canonicalizeWatchPath(aliasLink, 'win32'), longDirectory)
			);
			assert.deepStrictEqual(resolved, [aliasLink]);
		});

		it('expands a not-yet-written leaf’s directory through realpathSync.native', () => {
			const absentLeaf = join(aliasLink, 'not-written-yet.yaml');
			const resolved = recordingNativeCalls(() =>
				assert.strictEqual(canonicalizeWatchPath(absentLeaf, 'win32'), join(longDirectory, 'not-written-yet.yaml'))
			);
			assert.deepStrictEqual(resolved, [absentLeaf, aliasLink]);
		});

		it('fails closed without resolving the parent after a non-ENOENT failure', () => {
			const resolved = recordingNativeCalls(
				() => assert.strictEqual(canonicalizeWatchPath(aliasLink, 'win32'), undefined),
				() => {
					throw Object.assign(new Error('access denied'), { code: 'EACCES' });
				}
			);
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
			'utility/watcherFallback.ts',
		];

		// Sites whose own file canonicalization call is exempt: `guardedWatch` in
		// utility/watcherFallback.ts is the shared primitive underneath every
		// `guardedWatch(...)` call site below, taking an already-resolved path from
		// its caller rather than resolving one of its own — the same relationship
		// raw `chokidar.watch` has to the other listed sites.
		const CANONICALIZES_VIA_CALLER = new Set(['utility/watcherFallback.ts']);

		// `watch`, not `watchFile`: the latter is stat polling with no fs-event handle, so it is outside
		// the invariant (`utility/logging/readLog.ts`). `node:fs/promises` counts — its async iterator
		// is a real fs-event watch.
		const FS_MODULE = /(?:node:)?fs(?:\/promises)?/.source;
		const WATCH_SPELLINGS = [
			/from\s*['"]chokidar['"]/,
			/require\(\s*['"]chokidar['"]\s*\)/,
			new RegExp(`import\\s*\\{[^}]*\\bwatch\\b[^}]*\\}\\s*from\\s*['"]${FS_MODULE}['"]`),
			new RegExp(`\\{[^}]*\\bwatch\\b[^}]*\\}\\s*=\\s*require\\(\\s*['"]${FS_MODULE}['"]\\s*\\)`),
			new RegExp(`require\\(\\s*['"]${FS_MODULE}['"]\\s*\\)\\s*\\.watch\\s*\\(`),
			/\bfs(?:Promises|p)?\.watch\s*\(/,
			/\bguardedWatch\s*\(/,
		];

		const repoRoot = join(__dirname, '..', '..');
		// Anchored to repo-root children, so skipping generated output cannot also blind the scan to a
		// nested `tmp/`, `docs/` or `coverage/` holding a real watch site.
		const skippedRootEntries = new Set([
			'.claude',
			'.nyc_output',
			'coverage',
			'dist',
			'docs',
			'integrationTests',
			'tmp',
			'unitTests',
		]);
		const skippedAtAnyDepth = new Set(['.git', 'node_modules']);

		const collectWatchSites = (directory, found = [], depth = 0) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const entryPath = join(directory, entry.name);
				if (entry.isDirectory()) {
					if (skippedAtAnyDepth.has(entry.name)) continue;
					if (depth === 0 && skippedRootEntries.has(entry.name)) continue;
					collectWatchSites(entryPath, found, depth + 1);
					continue;
				}
				if (!/\.(?:ts|js|mjs|cjs)$/.test(entry.name)) continue;
				const source = readFileSync(entryPath, 'utf8');
				if (WATCH_SPELLINGS.some((spelling) => spelling.test(source)))
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

		// File-level: catches a site that never canonicalizes, not a second raw watch beside a
		// canonicalized one. A CANONICALIZES_VIA_CALLER site is skipped here: its own callers are
		// each listed in NATIVE_WATCH_SITES too (none of them exempted), so this same loop already
		// requires every one of them to canonicalize before calling it.
		it('all route their path through the canonicalization helper', () => {
			for (const site of NATIVE_WATCH_SITES) {
				if (CANONICALIZES_VIA_CALLER.has(site)) continue;
				const source = readFileSync(join(repoRoot, site), 'utf8');
				assert.ok(
					/\bresolveWatchTarget\b|\bcanonicalizeWatchPath\b/.test(source),
					`${site} arms a native watch without going through utility/watchPath.ts`
				);
			}
		});
	});
});
