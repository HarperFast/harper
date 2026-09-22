# utility/ — Design notes

Cross-cutting helpers.

**Read this when:** touching `watchPath.ts` or anything that arms a native file watch.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Every path handed to a native file watch must be canonicalized (`utility/watchPath.ts`)

libuv's Windows fs-event callback rebuilds each event's absolute path, expands it with
`GetLongPathNameW`, and asserts the expansion still starts with the directory it stored when the
watch was armed. An 8.3 short directory (`C:\Users\RUNNER~1\...`) never survives that comparison,
and libuv **aborts the process** rather than failing the watch — there is no JS-observable seam, so
`isWatcherExhaustionError`/polling recovery never runs (harper#2234).

The trap is that libuv only stores that directory for **file** targets, which reads as a narrow
surface until you follow chokidar: v4 opens a per-file `fs.watch` for every file it discovers inside
a watched tree, so one directory watch arms hundreds of file watches.

So `canonicalizeWatchPath` runs on every path before it reaches `fs.watch` (directly or through
chokidar), and returns `undefined` when it cannot establish the long form; `resolveWatchTarget` turns
that into `mustPoll`, and polling stats the file instead of arming a native watch. It resolves every
Windows path rather than only the ones that look short: `GetLongPathNameW`'s documentation is
explicit that a short name need not contain a tilde, so any spelling test leaves the abort reachable.
Plain `realpathSync` is not a substitute for the `.native` variant: it resolves symlinks but leaves
8.3 names intact — which also means Windows watch paths are symlink-resolved, matching what
`fs.watch` already does elsewhere by following a symlinked file to its target inode. A leaf that does
not exist yet resolves through its directory, because libuv stores and compares only the parent
directory of a file target.

New watch sites must go through it. As of this writing the sites are `components/EntryHandler.ts`,
`components/OptionsWatcher.ts`, `config/RootConfigWatcher.ts`, `security/keys.ts`,
`server/threads/manageThreads.js`, and `resources/blob.ts`. `fs.watchFile` (`utility/logging/readLog.ts`)
is stat polling with no fs-event handle and is outside this invariant.

Five of those six sites arm the watch through `guardedWatch()` (`utility/watcherFallback.ts`) rather
than calling `chokidar.watch`/`fs.watch` directly — it installs a process-level guard for a second,
unrelated failure (a watched path deleted out from under a non-persistent chokidar watcher raises an
unhandled async `EPERM`; see that file's header comment) but does no canonicalization of its own.
Every caller still resolves its own path first and passes the resolved path in, exactly as when they
called `chokidar.watch` directly, so the invariant holds through the wrapper. `utility/watcherFallback.ts`
itself is the one file that touches `chokidar` without canonicalizing — the watch-sites source scan
(`unitTests/utility/watchPath.test.js`) lists it as a native watch site (it does arm one) but exempts
it from the per-file canonicalization check, since canonicalizing is its callers' job, not its own —
the same relationship raw `chokidar.watch` has to the other five sites.

Two consequences worth knowing before adding a caller. `EntryHandler` is the one place where the
canonical path is load-bearing past the `fs.watch` call: chokidar's `ignored` predicate receives
absolute paths built from `cwd`, so its bases must be derived from the same spelling, while event
paths are relative to `cwd` and reads stay on the configured `component.directory`. And a watcher
that degrades to polling stays there for its lifetime, so a caller with no polling story of its own
(`resources/blob.ts`) needs one — there it polls `readMore` on the existing no-progress deadline.
