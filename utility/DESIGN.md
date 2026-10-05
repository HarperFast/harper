# utility/ — Design notes

Cross-cutting helpers.

**Read this when:** touching `watchPath.ts` or anything that arms a native file watch, adding an interactive CLI prompt (`interactivePrompts.ts`), passing an object to `handleHDBError` (`errors/hdbError.ts`), or changing `inspectForLog`'s sanitize walk (`logging/harper_logger.ts`).

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

## Interactive CLI prompts go through `utility/interactivePrompts.ts`

Every `@inquirer`-based one-shot prompt in the codebase (`bin/login.ts`, `bin/deploySetup.ts`, `utility/install/installer.ts`, `upgrade/upgradePrompt.ts`) calls the `prompts` object (or `promptYesNo`) exported from `utility/interactivePrompts.ts` — never `@inquirer/*` directly. Reuse that seam for any new `@inquirer`-style prompt rather than importing an `@inquirer` subpath yourself: it lazy-loads each prompt package on first real call (this module sits on the server boot path via `upgradePrompt`, so eager imports would cost every rolling-restart node), restores clean-exit-on-Ctrl-C (`ExitPromptError` → exit 130, not a logged stack), and disables the password prompt's plaintext-reveal keypress. `rawPromptsForTesting` is the underlying, pre-guard layer tests stub — `@inquirer/*` packages are real ES modules, so `require('@inquirer/input').default = stub` silently no-ops even through CJS interop. Out of scope: line-oriented REPLs like `bin/agentCli.ts`'s `readline.question` flow are a different interaction model and don't go through this seam.

## An HdbError's `message` is a string; the structured body is `http_resp_msg` (`utility/errors/hdbError.ts`)

`handleHDBError(new Error(), <object>, status)` is how a permission report or validation report becomes an error: the object is the response body. `serverErrorHandler` sends an object `http_resp_msg` verbatim, and the job worker (`server/jobs/jobProcess.ts`) records it as the job's `message`, which is what `get_job` answers a refused bulk load with. The constructor derives `message` from it — the `error` summary followed by the reasons the object lists, anything else through `inspectForLog`, which cannot throw and does not expose a nested Error's properties — because the logger, `String(error)` and `errorToString` (HTTP error bodies, replication replies) all need a string. A non-string `message` rendered as `Error: [object Object]`. Read the structure from `http_resp_msg`, never from `message`.

## `inspectForLog` bounds its whole render and masks credential-shaped keys (`utility/logging/harper_logger.ts`)

One render is at most `MAX_LOG_RENDER_LENGTH` characters. Per-container and node limits multiply rather than add — 50k string leaves at the operation caller's `maxStringLength: 20000` rendered ~134M characters into one log entry — so the bound is cumulative, in two parts. The sanitize walk charges an estimated rendered length per entry and stops each open container with one "omitted" marker once it is spent: that is what bounds the work, because it runs before `util.inspect` builds anything. A final cut of the rendered string makes the length exact, because `util.inspect`'s layout and escaping are not predictable from the walk.

For the estimate to bound work, the walk must see exactly what `util.inspect` will print, in the order it prints it:

- A leaf whose size the walk cannot estimate (an Error's stack, an opaque built-in, a function) is rendered to text in the walk and charged exactly; a hook the leaf carries (Node's own Buffer hook aside) is resolved like an object's, below. An Error whose message alone exceeds what is left is rendered from its message, without materializing its stack.
- Custom inspect hooks, own or inherited, are called in the walk, where `util.inspect` would call them; their output replaces the value and is walked like any other. No clone carries a hook for `util.inspect` to run at render time. An inherited hook gets the sanitized clone as `this`, so its properties are walked first; when the output replaces them they are refunded to the render budget but counted against a separate cap (`MAX_DISCARDED_RENDER`); past it, a further such object prints as an omission while other fields keep rendering.
- A container at the level where `util.inspect` collapses it to `[ClassName]` (the caller's `depth` + 1) is not enumerated, unless an inherited hook reads it; it prints `[ClassName]` even when empty. Nothing below that level is walked. A clone built at one depth stands in for its original only at that depth or deeper.
- Arrays, Maps and Sets are walked to the `maxArrayLength` `util.inspect` prints.
- A repeat reference to a walked container is charged again, since `util.inspect` prints a shared sub-object at every occurrence.

The walk masks the value of a data property or Map entry whose key (a symbol by its description) matches `CREDENTIAL_KEY_PATTERN`, the one list shared with the MCP audit log (`components/mcp/audit.ts`) — a new credential key shape goes there. It is a substring match, so `author` is masked too. Masking is structural: a custom inspect hook that returns a secret as a primitive renders it. `HdbError`'s report flattening (`messageText`) runs before `inspectForLog` and is not masked, because its values are validation reasons, often listed under a field named `password`.

Tests: the `inspectForLog` block in `unitTests/utility/logging/harper_logger.test.js`.
