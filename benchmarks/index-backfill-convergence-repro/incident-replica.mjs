// Faithful end-to-end replica of the Walmart USGM incident, driven entirely through the
// operations API against a REAL running Harper server (not a synthetic put-bypass or SIGKILL):
//
//   1. A Redirect-shaped table on RocksDB (the default storage engine -- no LMDB source, no
//      storage-engine conversion involved), bulk-loaded at meaningful scale via a first boot whose
//      component schema declares attr0..attr4 WITHOUT @indexed.
//   2. The component schema is then edited on disk to add @indexed to all 5 attributes and Harper
//      is restarted (a real process restart, matching a normal app deploy) -- this second boot's
//      own boot-time schema load sees 5 attributes with no persisted lastIndexedKey over data that
//      already exists, and kicks off a real resources/databases.ts runIndexing() backfill for all
//      5 together. From this point on the OS process (and its pid) is fixed for the rest of the
//      run.
//   3. That backfill is interrupted the way the field did: `restart_service http_workers`, an
//      IN-PROCESS worker-thread restart (server.js's `restartWorkers('http')`) -- process.pid
//      stays constant across it, which is what makes the `indexingPID` crash-recovery clause (a
//      comparison against the CURRENT process.pid) unable to detect anything: the PID never
//      changes, so recovery has to rely on the `restartNumber` generation counter instead (see
//      resources/databases.ts). A couple of restart cycles run mid-backfill.
//   4. Observes the silent-stuck signature: search_by_hash (always complete -- reads the primary
//      store directly) returns a record that search_by_value on one of the 5 new indexes does not
//      (200 with a short/empty result, not a 503) -- and threads disagreeing (some serving a
//      complete answer, some the gap, some 503 IndexRebuildingError) right after a restart cycle.
//
// Usage: node incident-replica.mjs --rows N [--attrs 5] [--workers 2] [--restart-cycles 2]
//
// Requires this checkout's own dist/ already built (npm run build) -- run once against the PR's
// base commit, once against fix/index-backfill-convergence, from two separate worktrees.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { startHarper, killHarper, teardownHarper } from '@harperfast/integration-testing';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = join(HERE, 'fixtures', 'redirect');

function parseArgs(argv) {
	const args = { rows: 1_000_000, attrs: 5, workers: 2, restartCycles: 2, restartAfterMs: 4000 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--rows') args.rows = Number(argv[++i]);
		else if (a === '--attrs') args.attrs = Number(argv[++i]);
		else if (a === '--workers') args.workers = Number(argv[++i]);
		else if (a === '--restart-cycles') args.restartCycles = Number(argv[++i]);
		else if (a === '--restart-after-ms') args.restartAfterMs = Number(argv[++i]);
	}
	return args;
}

const CARDINALITY = 8;
function pad(i) {
	return String(i).padStart(9, '0');
}
function generateRow(i, numAttrs) {
	const row = { id: 'r-' + pad(i), url: `https://shop.example.com/r/${i}` };
	for (let a = 0; a < numAttrs; a++) row[`attr${a}`] = 'v-' + ((i + a * 97) % CARDINALITY);
	return row;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	// Skip @harperfast/integration-testing's loopback-alias pool (127.0.0.2+, needs a one-time sudo
	// ifconfig setup this sandbox doesn't have) and bind plain 127.0.0.1 instead -- fine for a
	// single-instance replica that never needs multiple concurrent Harper processes.
	const ctx = { harper: { hostname: '127.0.0.1' } };
	const bootOptions = { config: { threads: { count: args.workers } } };

	console.log('[replica] first boot (unindexed schema) ...');
	const unindexedSchema = await readFile(join(FIXTURE_SRC, 'schema-unindexed.graphql.tmpl'), 'utf8');
	const indexedSchema = await readFile(join(FIXTURE_SRC, 'schema-indexed.graphql.tmpl'), 'utf8');
	const configYaml = await readFile(join(FIXTURE_SRC, 'config.yaml'), 'utf8');

	// setupHarperWithFixture copies a *static* directory in before boot; we need to mutate the
	// schema between two boots that share a data directory, so stage the component manually
	// instead (same mechanics setupHarperWithFixture uses under the hood).
	const componentName = 'redirect';
	async function installSchema(schemaContents) {
		const dataRootDir = ctx.harper?.dataRootDir;
		if (!dataRootDir) throw new Error('installSchema needs an existing dataRootDir (boot once first)');
		const componentDir = join(dataRootDir, 'components', componentName);
		await mkdir(componentDir, { recursive: true });
		await writeFile(join(componentDir, 'config.yaml'), configYaml);
		await writeFile(join(componentDir, 'schema.graphql'), schemaContents);
	}

	await startHarper(ctx, bootOptions); // creates ctx.harper.dataRootDir
	await installSchema(unindexedSchema);
	await killHarper(ctx); // stop; dataRootDir survives (unlike teardownHarper)
	await startHarper(ctx, bootOptions); // re-boot picks up the unindexed component

	const authHeader = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const opsUrl = ctx.harper.operationsAPIURL;
	console.log(`[replica] unindexed boot up: pid=${ctx.harper.process.pid} operationsAPI=${opsUrl}`);

	async function ops(body, timeoutMs = 30_000) {
		const res = await fetch(opsUrl, {
			method: 'POST',
			headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		}).catch((err) => ({ status: 0, json: async () => ({ error: String(err) }) }));
		let json;
		try {
			json = await res.json();
		} catch {
			json = { error: 'non-json response' };
		}
		return { status: res.status, body: json };
	}

	const DATABASE = 'data';
	const TABLE = 'Redirect';
	const SENTINEL_ATTR_VALUE = 'sentinel-tail-marker';
	let sentinelId;

	try {
		console.log(`[replica] bulk-loading ${args.rows} rows (unindexed) ...`);
		const BATCH = 2000;
		const loadStart = Date.now();
		for (let start = 0; start < args.rows; start += BATCH) {
			const end = Math.min(start + BATCH, args.rows);
			const records = [];
			for (let i = start; i < end; i++) records.push(generateRow(i, args.attrs));
			const r = await ops({ operation: 'insert', database: DATABASE, table: TABLE, records });
			if (r.status !== 200) throw new Error(`insert batch [${start},${end}) failed: ${r.status} ${JSON.stringify(r.body)}`);
			if (end % (BATCH * 25) === 0 || end === args.rows) {
				const elapsed = (Date.now() - loadStart) / 1000;
				console.log(`[replica] loaded ${end}/${args.rows} (${elapsed.toFixed(1)}s, ${(end / elapsed).toFixed(0)} rows/s)`);
			}
		}
		sentinelId = 'r-sentinel-' + Date.now();
		await ops({
			operation: 'insert',
			database: DATABASE,
			table: TABLE,
			records: [{ id: sentinelId, url: 'https://shop.example.com/sentinel', attr0: SENTINEL_ATTR_VALUE }],
		});
		console.log(`[replica] loaded, sentinel id=${sentinelId}`);

		console.log('[replica] stopping Harper, swapping in the indexed schema, and rebooting (this deploy fires the backfill) ...');
		await killHarper(ctx);
		await installSchema(indexedSchema);
		const backfillStart = Date.now();
		await startHarper(ctx, bootOptions);
		console.log(
			`[replica] indexed boot up: pid=${ctx.harper.process.pid} (fixed for the rest of this run) operationsAPI=${ctx.harper.operationsAPIURL}`
		);

		// restart_service returns a job_id immediately (it's handled as an async job) -- the actual
		// worker-thread swap can take up to threadTerminationTimeout*2 (20s by default: manageThreads.js
		// sends a graceful SHUTDOWN postMessage first and only force-terminates the old worker if it
		// hasn't voluntarily exited by then). A worker mid a non-yielding backfill can't even check for
		// that message until it hits a yield point, so the interruption isn't real until the job
		// reports COMPLETE -- poll for that instead of assuming a fixed delay is enough.
		async function waitForJob(jobId, maxWaitMs = 30_000) {
			const deadline = Date.now() + maxWaitMs;
			while (Date.now() < deadline) {
				const r = await ops({ operation: 'get_job', id: jobId });
				const status = Array.isArray(r.body) ? r.body[0]?.status : r.body?.status;
				if (status === 'COMPLETE' || status === 'ERROR') return status;
				await new Promise((res) => setTimeout(res, 500));
			}
			return 'TIMEOUT';
		}

		const cycles = [];
		for (let cycle = 1; cycle <= args.restartCycles; cycle++) {
			console.log(`[replica] cycle ${cycle}: letting the backfill run for ${args.restartAfterMs}ms ...`);
			await new Promise((r) => setTimeout(r, args.restartAfterMs));

			console.log(`[replica] cycle ${cycle}: firing restart_service http_workers (pid should stay ${ctx.harper.process.pid}) ...`);
			const restartResult = await ops({ operation: 'restart_service', service: 'http_workers' }, 60_000).catch((e) => ({
				error: String(e),
			}));
			const jobId = restartResult.body?.job_id;
			const jobStatus = jobId ? await waitForJob(jobId) : 'NO_JOB_ID';
			console.log(
				`[replica] cycle ${cycle}: restart_service result:`,
				JSON.stringify(restartResult),
				`job ${jobId} -> ${jobStatus}`
			);
			console.log(`[replica] cycle ${cycle}: pid after restart = ${ctx.harper.process.pid} (same OS process throughout)`);

			// Sample search_by_value vs search_by_hash disagreement now that the worker swap has
			// actually completed (or timed out waiting for it to).
			const samples = [];
			for (let i = 0; i < 8; i++) {
				const [byValue, byHash] = await Promise.all([
					ops({
						operation: 'search_by_value',
						database: DATABASE,
						table: TABLE,
						search_attribute: 'attr0',
						search_value: SENTINEL_ATTR_VALUE,
						get_attributes: ['id'],
					}),
					ops({ operation: 'search_by_hash', database: DATABASE, table: TABLE, hash_values: [sentinelId], get_attributes: ['id'] }),
				]);
				samples.push({
					byValueStatus: byValue.status,
					byValueError: byValue.body?.error,
					byValueFoundSentinel: Array.isArray(byValue.body) && byValue.body.some((r) => r.id === sentinelId),
					byHashStatus: byHash.status,
					byHashFoundSentinel: Array.isArray(byHash.body) && byHash.body.some((r) => r.id === sentinelId),
				});
			}
			const elapsedSinceBackfillStart = (Date.now() - backfillStart) / 1000;
			console.log(
				`[replica] cycle ${cycle} post-restart samples (t+${elapsedSinceBackfillStart.toFixed(1)}s):`,
				JSON.stringify(samples)
			);
			cycles.push({ cycle, jobStatus, samples, restartResult });
		}

		// Final read: has attr0's index converged? A complete index returns exactly rows/CARDINALITY
		// records for one low-cardinality value, plus the sentinel search.
		console.log('[replica] final check: search_by_value counts per attribute vs expected ...');
		const finalChecks = {};
		for (let a = 0; a < args.attrs; a++) {
			const r = await ops({
				operation: 'search_by_value',
				database: DATABASE,
				table: TABLE,
				search_attribute: `attr${a}`,
				search_value: 'v-0',
				get_attributes: ['id'],
			});
			finalChecks[`attr${a}`] = {
				status: r.status,
				count: Array.isArray(r.body) ? r.body.length : undefined,
				expected: Math.floor(args.rows / CARDINALITY),
				error: !Array.isArray(r.body) ? r.body : undefined,
			};
		}
		const sentinelFinal = await ops({
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'attr0',
			search_value: SENTINEL_ATTR_VALUE,
			get_attributes: ['id'],
		});
		console.log(
			JSON.stringify(
				{
					phase: 'final',
					rows: args.rows,
					attrs: args.attrs,
					finalChecks,
					sentinelFoundViaValueSearch: Array.isArray(sentinelFinal.body) && sentinelFinal.body.some((r) => r.id === sentinelId),
					cycles,
				},
				null,
				2
			)
		);
	} finally {
		await teardownHarper(ctx).catch(() => {});
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
