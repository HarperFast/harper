'use strict';
// Orchestrates the index-backfill-convergence repro: seeds a table, then repeatedly spawns
// worker.js in `index` mode and SIGKILLs it from OUT HERE (independent of the child's own event
// loop, so the kill lands regardless of whether the child is starving its own timers) after a
// fixed wall-clock budget -- modeling an external supervisor/health-check that kills a worker once
// it looks unresponsive for the same amount of time on every attempt.
//
// Usage:
//   node driver.js --db <path> --database <name> --table <name> --rows N --num-attrs K \
//     --kill-after-ms T --cycles C [--seed-only] [--final-run] [--final-timeout-ms MS]
//
// --seed-only     just seed the table (idempotent: skipped if the db dir already has data)
// (default)       run `cycles` kill-after-T-ms interrupted attempts, logging each one's
//                 .started.json marker (the `start` key + first keys the resumed scan opened
//                 with)
// --final-run     run one more `index`-mode attempt with no external kill (or --final-timeout-ms
//                 as a generous safety net) and report the worker's self-computed gate-check
//                 result (primary vs index key counts, indexed search vs full scan)
const path = require('node:path');
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, mkdirSync, rmSync } = require('node:fs');

function parseArgs(argv) {
	const args = { numAttrs: 2, rows: 1000000, killAfterMs: 3000, cycles: 5, finalTimeoutMs: 20 * 60 * 1000 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--db') args.db = argv[++i];
		else if (a === '--database') args.database = argv[++i];
		else if (a === '--table') args.table = argv[++i];
		else if (a === '--rows') args.rows = Number(argv[++i]);
		else if (a === '--num-attrs') args.numAttrs = Number(argv[++i]);
		else if (a === '--kill-after-ms') args.killAfterMs = Number(argv[++i]);
		else if (a === '--cycles') args.cycles = Number(argv[++i]);
		else if (a === '--final-timeout-ms') args.finalTimeoutMs = Number(argv[++i]);
		else if (a === '--seed-only') args.seedOnly = true;
		else if (a === '--final-run') args.finalRun = true;
		else if (a === '--results-dir') args.resultsDir = argv[++i];
	}
	for (const required of ['db', 'database', 'table']) {
		if (!args[required]) throw new Error(`--${required} is required`);
	}
	args.resultsDir = args.resultsDir || path.join(args.db, 'results');
	return args;
}

function runChild(scriptArgs, killAfterMs) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(__dirname, 'worker.js'), ...scriptArgs], {
			stdio: ['ignore', 'inherit', 'inherit'],
		});
		let killedByHarness = false;
		let timer;
		if (killAfterMs != null) {
			timer = setTimeout(() => {
				killedByHarness = true;
				child.kill('SIGKILL');
			}, killAfterMs);
		}
		child.once('exit', (code, signal) => {
			if (timer) clearTimeout(timer);
			resolve({ code, signal, killedByHarness });
		});
	});
}

function readJsonIfExists(p) {
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.resultsDir, { recursive: true });

	if (args.seedOnly || !existsSync(path.join(args.db, '.seeded'))) {
		console.log(`[driver] seeding ${args.rows} rows x ${args.numAttrs} attrs into ${args.db} ...`);
		const seedStart = Date.now();
		const { code } = await runChild(
			[
				'--db',
				args.db,
				'--database',
				args.database,
				'--table',
				args.table,
				'--mode',
				'seed',
				'--rows',
				String(args.rows),
				'--num-attrs',
				String(args.numAttrs),
				'--result',
				path.join(args.resultsDir, 'seed.json'),
			],
			null
		);
		if (code !== 0) throw new Error(`seed failed with exit code ${code}`);
		mkdirSync(args.db, { recursive: true });
		require('node:fs').writeFileSync(path.join(args.db, '.seeded'), String(Date.now()));
		console.log(`[driver] seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);
		if (args.seedOnly) return;
	}

	if (args.finalRun) {
		const resultPath = path.join(args.resultsDir, 'final.json');
		rmSync(resultPath + '.started.json', { force: true });
		rmSync(resultPath, { force: true });
		console.log(`[driver] final uninterrupted resume (timeout ${args.finalTimeoutMs}ms) ...`);
		const start = Date.now();
		const { code, signal, killedByHarness } = await runChild(
			[
				'--db',
				args.db,
				'--database',
				args.database,
				'--table',
				args.table,
				'--mode',
				'index',
				'--num-attrs',
				String(args.numAttrs),
				'--result',
				resultPath,
			],
			args.finalTimeoutMs
		);
		const elapsed = (Date.now() - start) / 1000;
		const started = readJsonIfExists(resultPath + '.started.json');
		const result = readJsonIfExists(resultPath);
		console.log(
			JSON.stringify(
				{ phase: 'final', elapsedSeconds: elapsed, exitCode: code, signal, killedByHarness, started, result },
				null,
				2
			)
		);
		return;
	}

	const cycleLog = [];
	for (let cycle = 1; cycle <= args.cycles; cycle++) {
		const resultPath = path.join(args.resultsDir, `cycle-${cycle}.json`);
		rmSync(resultPath + '.started.json', { force: true });
		rmSync(resultPath, { force: true });
		const start = Date.now();
		const { code, signal, killedByHarness } = await runChild(
			[
				'--db',
				args.db,
				'--database',
				args.database,
				'--table',
				args.table,
				'--mode',
				'index',
				'--num-attrs',
				String(args.numAttrs),
				'--result',
				resultPath,
			],
			args.killAfterMs
		);
		const elapsed = (Date.now() - start) / 1000;
		const started = readJsonIfExists(resultPath + '.started.json');
		const completed = readJsonIfExists(resultPath);
		const entry = { cycle, elapsedSeconds: elapsed, exitCode: code, signal, killedByHarness, started, completed };
		cycleLog.push(entry);
		console.log(`[driver] cycle ${cycle}: ${JSON.stringify(entry)}`);
	}

	// Independent snapshot of on-disk state after the crash-loop, without triggering yet another
	// indexing attempt as a side effect (see worker.js's `inspect` mode doc comment).
	const inspectPath = path.join(args.resultsDir, 'post-cycles-inspect.json');
	await runChild(
		[
			'--db',
			args.db,
			'--database',
			args.database,
			'--table',
			args.table,
			'--mode',
			'inspect',
			'--num-attrs',
			String(args.numAttrs),
			'--result',
			inspectPath,
		],
		null
	);
	console.log('[driver] post-cycles state:', readFileSync(inspectPath, 'utf8'));
	console.log('[driver] summary:', JSON.stringify(cycleLog, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
