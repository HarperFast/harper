/**
 * Promoted from qa-explorer (QA-579 / P-374): pins CLI failure paths exiting non-zero
 * (regression anchor for merged PR #1801) via a 5-cell exit-code matrix spawning the real
 * dist/bin/harper.js, with a hard-kill safety net so a regression-to-hang surfaces as an
 * explicit kill, not a false exit 0.
 *
 * QA-579 — CLI exit-code contract matrix, derived from PR #1801
 * "fix: ensure CLI failure paths exit non-zero, including operation timeouts"
 * (branch fix/cli-exit-codes-on-failure, head 4a03846f0e).
 *
 * The PR's own commits fix two known holes (status.ts's bare process.exit(),
 * and the CLI's missing client-side timeout on Op-API requests) and add unit
 * tests for those exact spots. This file instead probes the exit-code
 * *contract* end-to-end, spawning the real built CLI (dist/bin/harper.js) as
 * a child process against a real running Harper instance (and some
 * deliberately broken targets), asserting exit code + message for each cell:
 *
 *   1. bad config        — malformed harperdb-config.yaml via ROOTPATH
 *   2. unreachable target — nothing listening on the target port
 *   3. operation timeout  — target accepts the TCP connection but never
 *                           responds (a "wedged" server), with a short
 *                           HARPER_CLI_TIMEOUT_MS so the test stays fast
 *   4. failed operation   — describe_table against a nonexistent table
 *   5. success control    — describe_all against the real instance
 *
 * Each CLI invocation is also wrapped in a hard child-process timeout well
 * above the CLI's own configured timeout: if the fix regressed and the CLI
 * hangs instead of exiting, the test fails with an explicit "hung" diagnosis
 * instead of blocking the whole suite.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/qa579-cli-exit-codes.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal, notEqual } from 'node:assert';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { spawnSync } from 'node:child_process';
import {
	setupHarperWithFixture,
	teardownHarper,
	DEFAULT_ADMIN_USERNAME,
	DEFAULT_ADMIN_PASSWORD,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa579-cli-exit-codes');
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');

// Hard ceiling on any single CLI child-process invocation. Well above the CLI's own
// configured operation timeout in every cell below, so if the CLI itself fails to exit
// (the exact regression class this PR fixes), the test observes a "spawnSync timed out"
// signal (`result.signal === 'SIGTERM'`, no exit code) rather than hanging the suite.
const CHILD_PROCESS_TIMEOUT_MS = 15_000;

interface CliResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	hung: boolean;
}

/** Matrix accumulator, printed in `after()` for a compact human-readable summary. */
interface MatrixRow {
	cell: string;
	expectedNonZero: boolean;
	status: number | null;
	verdict: string;
	message: string;
}
const matrix: MatrixRow[] = [];

function runCli(args: string[], env: NodeJS.ProcessEnv, homeDir: string): CliResult {
	const start = Date.now();
	const result = spawnSync(process.execPath, [HARPER_BIN, ...args], {
		// USERPROFILE matches HOME on win32, where CLI credential resolution goes through
		// os.homedir() -> USERPROFILE — without it this child still reads the real
		// ~/.harperdb/credentials.json there even with HOME replaced (see harperLifecycle.js's
		// own HOME/USERPROFILE pairing for the same isolation).
		env: { ...process.env, ...env, HOME: homeDir, USERPROFILE: homeDir },
		encoding: 'utf8',
		timeout: CHILD_PROCESS_TIMEOUT_MS,
		// spawnSync's default killSignal (SIGTERM) is not a hard ceiling -- a hang regression that
		// installs (or ignores) a TERM handler would never actually die at this timeout. SIGKILL
		// makes this safety net's whole reason for existing (surviving a hang regression) hold.
		killSignal: 'SIGKILL',
	});
	const durationMs = Date.now() - start;
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		durationMs,
		// spawnSync sets signal (typically SIGTERM) and status=null when its own `timeout`
		// option fires — that's our "the CLI never exited" signal, distinct from a clean
		// non-zero exit.
		hung: result.status === null && result.signal !== null,
	};
}

suite('QA-579 CLI exit-code contract matrix (PR #1801)', (ctx: ContextWithHarper) => {
	let hostname: string;
	let operationsAPIURL: string;
	let scratchHome: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		hostname = ctx.harper.hostname;
		operationsAPIURL = ctx.harper.operationsAPIURL;

		// Isolated $HOME for every CLI invocation below so nothing touches the real
		// ~/.harperdb/credentials.json on this machine.
		scratchHome = await mkdtemp(join(tmpdir(), 'qa579-cli-home-'));

		// Readiness poll: wait until describe_all succeeds against the real instance.
		const deadline = Date.now() + 30_000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const r = await fetch(operationsAPIURL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization':
							'Basic ' + Buffer.from(`${DEFAULT_ADMIN_USERNAME}:${DEFAULT_ADMIN_PASSWORD}`).toString('base64'),
					},
					body: JSON.stringify({ operation: 'describe_all' }),
					signal: AbortSignal.timeout(3_000),
				});
				if (r.status === 200) {
					ready = true;
					break;
				}
			} catch {
				/* not ready */
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		ok(ready, 'Harper instance never became ready for describe_all');
	});

	after(async () => {
		await teardownHarper(ctx);
		// Guard against a before() failure leaving scratchHome unset — rm(undefined, ...) would
		// throw and mask the original setup error in the test output.
		if (scratchHome) await rm(scratchHome, { recursive: true, force: true });

		console.log('\n[QA-579] CLI EXIT-CODE MATRIX (PR #1801)');
		console.log('  cell                    expected     actual-exit   verdict    message');
		for (const r of matrix) {
			console.log(
				`  ${r.cell.padEnd(23)} ${(r.expectedNonZero ? 'non-zero' : 'zero').padEnd(12)} ${String(r.status).padEnd(13)} ${r.verdict.padEnd(10)} ${r.message}`
			);
		}
	});

	test('Cell 1: bad config (malformed harperdb-config.yaml) -> non-zero exit', async () => {
		const badConfigDir = await mkdtemp(join(tmpdir(), 'qa579-bad-config-'));
		// Deliberately malformed YAML: unclosed flow sequence.
		await writeFile(join(badConfigDir, 'harperdb-config.yaml'), 'rootPath: [unterminated\nfoo: bar\n');

		const result = runCli(['describe_all'], { ROOTPATH: badConfigDir }, scratchHome);
		await rm(badConfigDir, { recursive: true, force: true });

		const combined = (result.stdout + result.stderr).trim();
		matrix.push({
			cell: '1. bad-config',
			expectedNonZero: true,
			status: result.status,
			verdict: !result.hung && result.status !== 0 ? 'EXPECTED' : result.hung ? 'DEFECT(hang)' : 'DEFECT',
			message: combined.slice(0, 160).replace(/\n/g, ' '),
		});

		ok(
			!result.hung,
			`CLI hung instead of exiting (killed after ${CHILD_PROCESS_TIMEOUT_MS}ms) — stderr: ${result.stderr}`
		);
		notEqual(
			result.status,
			0,
			`Expected non-zero exit for malformed config, got ${result.status}. stderr: ${result.stderr}`
		);
		ok(combined.length > 0, 'Expected a non-empty error message for bad config');
		// A non-empty message alone can't distinguish "config rejected" from "connected to something
		// else and failed for an unrelated reason" -- pin the actual, deterministic parse-error shape.
		ok(/Error parsing.*YAMLParseError/.test(combined), `Expected a YAML parse error, got: ${combined}`);
	});

	test('Cell 2: unreachable instance (nothing listening) -> non-zero exit, no hang', async () => {
		// Find a free loopback port on the assigned test hostname, then immediately close
		// the probe socket so nothing is listening on it — guaranteeing ECONNREFUSED.
		const probe = createServer();
		const deadPort: number = await new Promise((resolvePort, reject) => {
			probe.on('error', reject);
			probe.listen(0, hostname, () => {
				const addr = probe.address();
				const port = typeof addr === 'object' && addr ? addr.port : 0;
				probe.close(() => resolvePort(port));
			});
		});

		const result = runCli(
			[
				'describe_all',
				`target=http://${hostname}:${deadPort}`,
				`username=${DEFAULT_ADMIN_USERNAME}`,
				`password=${DEFAULT_ADMIN_PASSWORD}`,
			],
			{},
			scratchHome
		);

		const combined = (result.stdout + result.stderr).trim();
		matrix.push({
			cell: '2. unreachable',
			expectedNonZero: true,
			status: result.status,
			verdict: !result.hung && result.status !== 0 ? 'EXPECTED' : result.hung ? 'DEFECT(hang)' : 'DEFECT',
			message: combined.slice(0, 160).replace(/\n/g, ' '),
		});

		ok(
			!result.hung,
			`CLI hung instead of exiting (killed after ${CHILD_PROCESS_TIMEOUT_MS}ms) — stderr: ${result.stderr}`
		);
		notEqual(
			result.status,
			0,
			`Expected non-zero exit for unreachable target, got ${result.status}. stderr: ${result.stderr}`
		);
		// Should fail fast via ECONNREFUSED, not eat the full 60s default idle timeout.
		ok(
			result.durationMs < 10_000,
			`Unreachable-target failure took ${result.durationMs}ms — expected a fast ECONNREFUSED, not a timeout-length wait`
		);
	});

	test('Cell 3: operation timeout (target accepts TCP but never responds) -> non-zero exit, no hang', async () => {
		// A "wedged" server: completes the TCP handshake (and thus the HTTP request write)
		// but never writes a response and never closes — the exact shape of an unreachable-
		// but-not-refusing target (e.g. a firewall black hole, or a genuinely stuck process).
		const blackhole: Server = createServer((socket) => {
			socket.on('error', () => {
				/* ignore ECONNRESET from client-side destroy() */
			});
			// Intentionally: no response, no close.
		});
		const blackholePort: number = await new Promise((resolvePort, reject) => {
			blackhole.on('error', reject);
			blackhole.listen(0, hostname, () => {
				const addr = blackhole.address();
				resolvePort(typeof addr === 'object' && addr ? addr.port : 0);
			});
		});

		// try/finally: if any assertion below throws, blackhole must still close — otherwise it's
		// left listening and keeps the event loop (and the whole test runner) alive on CI.
		try {
			const CLI_TIMEOUT_MS = 1500;
			const result = runCli(
				[
					'describe_all',
					`target=http://${hostname}:${blackholePort}`,
					`username=${DEFAULT_ADMIN_USERNAME}`,
					`password=${DEFAULT_ADMIN_PASSWORD}`,
				],
				{ HARPER_CLI_TIMEOUT_MS: String(CLI_TIMEOUT_MS) },
				scratchHome
			);

			const combined = (result.stdout + result.stderr).trim();
			matrix.push({
				cell: '3. op-timeout',
				expectedNonZero: true,
				status: result.status,
				verdict: !result.hung && result.status !== 0 ? 'EXPECTED' : result.hung ? 'DEFECT(hang)' : 'DEFECT',
				message: combined.slice(0, 160).replace(/\n/g, ' '),
			});

			ok(
				!result.hung,
				`CLI hung past the ${CHILD_PROCESS_TIMEOUT_MS}ms hard kill instead of respecting HARPER_CLI_TIMEOUT_MS=${CLI_TIMEOUT_MS} — this is the headline regression this PR fixes`
			);
			notEqual(
				result.status,
				0,
				`Expected non-zero exit on genuine operation timeout, got ${result.status}. stderr: ${result.stderr}`
			);
			// Should fire close to the configured 1.5s idle timeout, not the CHILD_PROCESS_TIMEOUT_MS
			// hard-kill ceiling — confirms it's the CLI's own timeout firing, not our safety net.
			ok(
				result.durationMs < CLI_TIMEOUT_MS + 8_000,
				`Timeout fired at ${result.durationMs}ms, expected close to configured ${CLI_TIMEOUT_MS}ms (not the ${CHILD_PROCESS_TIMEOUT_MS}ms hard-kill ceiling)`
			);
			ok(/timed out|ETIMEDOUT/i.test(combined), `Expected a timeout-flavored message, got: ${combined}`);
		} finally {
			await new Promise<void>((r) => blackhole.close(() => r()));
		}
	});

	test('Cell 4: failed operation (describe_table on nonexistent table) -> non-zero exit', async () => {
		const result = runCli(
			[
				'describe_table',
				`target=${operationsAPIURL}`,
				`username=${DEFAULT_ADMIN_USERNAME}`,
				`password=${DEFAULT_ADMIN_PASSWORD}`,
				'database=data',
				'table=NoSuchTable_QA579',
			],
			{},
			scratchHome
		);

		const combined = (result.stdout + result.stderr).trim();
		matrix.push({
			cell: '4. failed-op',
			expectedNonZero: true,
			status: result.status,
			verdict: !result.hung && result.status !== 0 ? 'EXPECTED' : result.hung ? 'DEFECT(hang)' : 'DEFECT',
			message: combined.slice(0, 160).replace(/\n/g, ' '),
		});

		ok(!result.hung, `CLI hung instead of exiting — stderr: ${result.stderr}`);
		notEqual(
			result.status,
			0,
			`Expected non-zero exit for a server-rejected operation, got ${result.status}. stderr: ${result.stderr}`
		);
	});

	test('Cell 5: success control (describe_all against real instance) -> exit 0', async () => {
		const result = runCli(
			[
				'describe_all',
				`target=${operationsAPIURL}`,
				`username=${DEFAULT_ADMIN_USERNAME}`,
				`password=${DEFAULT_ADMIN_PASSWORD}`,
			],
			{},
			scratchHome
		);

		const combined = (result.stdout + result.stderr).trim();
		matrix.push({
			cell: '5. success',
			expectedNonZero: false,
			status: result.status,
			verdict: !result.hung && result.status === 0 ? 'EXPECTED' : 'DEFECT',
			message: combined.slice(0, 160).replace(/\n/g, ' '),
		});

		ok(!result.hung, `CLI hung instead of exiting — stderr: ${result.stderr}`);
		equal(
			result.status,
			0,
			`Expected exit 0 for a valid operation against a running instance, got ${result.status}. stderr: ${result.stderr}`
		);
		ok(
			result.stdout.includes('data'),
			`Expected describe_all output to mention the "data" database, got: ${result.stdout}`
		);
	});
});
