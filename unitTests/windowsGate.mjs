#!/usr/bin/env node
/*
 * The Windows unit-test gate — `npm run test:unit:windows`, run in CI by the
 * `unit-test-windows` job in .github/workflows/unit-test.yml.
 *
 * Two things this does that a plain `mocha` invocation cannot.
 *
 * It runs GROUPS in separate processes, so one suite that hangs or takes its process
 * down cannot cost the run every group behind it, and each group gets its own
 * GROUP_TIMEOUT_MS.
 *
 * It requires each group to print a summary line. A mocha run can stop advancing with
 * nothing failed — `timeout: 0` in .mocharc.json means no test ever times out, so the
 * event loop just drains and the process exits 0 having printed no epilogue. A bare
 * `mocha` step would report a green gate having executed a fraction of the tests. A
 * group that exits without a summary fails here, as does one that exits non-zero or
 * outruns GROUP_TIMEOUT_MS. (unitTests/mocha.init.js now also fails such a run from the
 * inside; this check is the backstop for a process that never gets that far.)
 *
 * SCOPE. GROUPS covers the part of the unit tree verified green on Windows, not the
 * whole thing: the suites in EXCLUDED fail there for environmental or test-design
 * reasons that reproduce on `main`, so gating on everything would land red and stay
 * red. Everything else under a GROUPS directory is picked up automatically — a new
 * suite is gated on Windows the day it is added, which is the point: a platform-gated
 * fix and the test written to prove it now both run somewhere.
 *
 * MAINTENANCE. Shrink EXCLUDED as its entries are fixed; widen GROUPS as more of the
 * tree is verified. Every EXCLUDED entry states why it is there — do not add one
 * without a reason, and do not add one for a suite that merely looks risky, only for
 * one observed to fail. Confirm a fix with `npx mocha <suite>` on Windows, then
 * confirm it again inside its group (several of the entries below pass alone and fail
 * with their neighbours) before deleting its line. Run it under `--reporter dot`, the
 * reporter this gate uses: unlike `spec`, it writes with process.stdout.write directly
 * rather than through console.*, so it does not paper over a suite that leaves stdout
 * broken.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** One mocha process per entry. Whole directories, so new suites are picked up. */
const GROUPS = [
	'unitTests/agent/**/*.test.js',
	'unitTests/buildTools/**/*.test.js',
	'unitTests/components/**/*.test.js',
	'unitTests/config/**/*.test.js',
	'unitTests/server/**/*.test.js',
	'unitTests/sqlEngine/**/*.test.js',
	'unitTests/utility/**/*.test.js',
	'unitTests/validation/**/*.test.js',
	// Individually verified files from directories not yet covered wholesale.
	'unitTests/resources/blob.test.js',
];

const EXCLUDED = [
	// --- Product bug: chokidar's `persistent: false` error hole --------------------
	// `after each` dies with an uncaught `EPERM: operation not permitted, watch` out
	// of `FSWatcher._handle.onchange`. 39 passing / 2 failing; reproduces on `main`.
	'unitTests/components/EntryHandler.test.js',

	// --- Hangs, never exits (leaked handle) ----------------------------------------
	// Both produce no output at all and have to be killed rather than failing an
	// assertion, so they take their whole group down with them.
	'unitTests/components/OptionsWatcher.test.js',
	'unitTests/components/applicationSpawn.test.js',

	// --- Windows worker cold start outruns the condition-wait ----------------------
	// Both tests spawn an `eval: true` Worker that requires
	// #src/server/threads/manageThreads; on Windows that boot plus module load
	// regularly exceeds waitFor()'s 2000ms default, so the suite is flaky — it passes
	// when the module graph is warm in the OS file cache and fails when it is not.
	// Needs an explicit timeout rather than the default.
	'unitTests/server/threads/threadInfoTimeout.test.js',

	// --- Unix-domain-socket assumptions --------------------------------------------
	// `listen EACCES` binding a `.sock` path under the temp dir. Needs a Windows
	// named-pipe path or a platform skip.
	'unitTests/server/threads/threadServerListenOnPorts.test.js',
	'unitTests/server/udsMirror.test.js',

	// --- Path, shell, and toolchain assumptions ------------------------------------
	// POSIX path separators, `git`/`ssh`/tarball shell invocations, npm-pack layout,
	// and system introspection with no Windows analogue.
	'unitTests/components/ComponentV1.test.js',
	'unitTests/components/componentLoader.test.js',
	'unitTests/components/credentials.test.js',
	'unitTests/components/extractApplicationSwap.test.js',
	'unitTests/components/gitCredentials.test.js',
	'unitTests/components/gitSSHMaterialization.test.js',
	'unitTests/components/packageComponent.test.js',
	'unitTests/components/packageComponentOperation.test.js',
	'unitTests/components/prepareApplicationSerialization.test.js',
	'unitTests/utility/environment/systemInformation.test.js',
	'unitTests/validation/configValidator.test.js',
	'unitTests/validation/fileLoadValidator.test.js',

	// --- Native/HTTP layer ---------------------------------------------------------
	// uWebSockets.js is not exercised on Windows, and Headers.test.js exits non-zero
	// after its own assertions pass (30 passing / 0 failing).
	'unitTests/server/serverHelpers/Headers.test.js',
	'unitTests/server/serverHelpers/uwsServer.test.js',
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOCHA = join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
const SUMMARY = /\b(\d+) passing\b/;
const GROUP_TIMEOUT_MS = Number(process.env.HARPER_WINDOWS_GATE_GROUP_TIMEOUT_MS ?? 600_000);

// No --config: mocha discovers .mocharc.json itself, so the gate inherits the same
// root config (and unitTests/mocha.init.js) as every other unit-test run.
function runGroup(pattern) {
	return new Promise((settle) => {
		const args = [MOCHA, '--reporter', 'dot', pattern];
		for (const excluded of EXCLUDED) args.push('--exclude', excluded);

		const startedAt = Date.now();
		const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

		let output = '';
		const capture = (chunk) => {
			output += chunk;
			process.stdout.write(chunk);
		};
		child.stdout.on('data', capture);
		child.stderr.on('data', capture);

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, GROUP_TIMEOUT_MS);

		child.on('close', (code) => {
			clearTimeout(timer);
			const passing = SUMMARY.exec(output)?.[1];
			let reason;
			if (timedOut) reason = `timed out after ${GROUP_TIMEOUT_MS}ms`;
			else if (passing === undefined) reason = `exited ${code} without reporting a summary`;
			else if (code !== 0) reason = `exited ${code}`;
			settle({ pattern, seconds: Math.round((Date.now() - startedAt) / 1000), passing, reason });
		});
	});
}

const results = [];
for (const pattern of GROUPS) {
	console.log(`\n=== ${pattern} ===`);
	results.push(await runGroup(pattern));
}

console.log('\n=== Windows unit-test gate ===');
for (const { pattern, seconds, passing, reason } of results) {
	const cells = [`${String(seconds).padStart(4)}s`, `${(passing ?? '?').padStart(4)} passing`, pattern];
	console.log(`${reason ? 'FAIL' : 'ok  '}  ${cells.join('  ')}${reason ? `  — ${reason}` : ''}`);
}

const failed = results.filter((result) => result.reason);
if (failed.length) {
	console.error(`\n${failed.length} of ${results.length} group(s) failed.`);
	// Not process.exit(): the group table above is the whole point of the run, and a piped stdout
	// on Windows can still be draining it. Nothing is left to keep the loop alive here anyway.
	process.exitCode = 1;
} else {
	console.log(
		`\nAll ${results.length} groups passed (${results.reduce((sum, result) => sum + Number(result.passing), 0)} tests).`
	);
}
