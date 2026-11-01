import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { runtimeInfo } from '@harperfast/fulltext/native';
import { writeFile, mkdir, statfs, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
} from '@harperfast/integration-testing';
import { record, target, verify, meter, MATCHES, runPhase, cellVerdict } from './model.mts';
const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sizes = (process.env.FULLTEXT_HTTP_ROWS || '100000,1000000').split(',').map(Number);
const clients = (process.env.FULLTEXT_HTTP_CLIENTS || '8,32').split(',').map(Number);
const cases = (process.env.FULLTEXT_HTTP_CASES || 'relevance,sort,highlights,exact,structured').split(',');
const duration = Number(process.env.FULLTEXT_HTTP_DURATION_MS || 60000);
const writeRates = (process.env.FULLTEXT_HTTP_WRITES || '0,10').split(',').map(Number);
const commonGitDirectory = (
	await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: resolve(here, '../..') })
).stdout.trim();
const output = resolve(process.env.FULLTEXT_HTTP_OUTPUT || resolve(commonGitDirectory, '../../tmp/fulltext-http'));
for (const n of sizes) assert(Number.isInteger(n) && n >= MATCHES && n % MATCHES === 0 && n <= 1000000);
for (const n of clients) assert(Number.isInteger(n) && n >= 1 && n <= 32);
for (const n of writeRates) assert([0, 10].includes(n));
for (const name of cases) assert(['relevance', 'sort', 'highlights', 'exact', 'structured'].includes(name));
assert(duration >= 1000 && duration <= 300000);
await mkdir(output, { recursive: true });
process.env.HARPER_INTEGRATION_TEST_MONITOR_DIR = resolve(output, `monitor-${process.pid}`);
process.env.HARPER_INTEGRATION_TEST_MONITOR_IDLE_MS = '1000';
process.env.HARPER_INTEGRATION_TEST_MONITOR_INTERVAL_MS = '250';
const harperHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: resolve(here, '../..') })).stdout.trim();
const nativeRuntime = await runtimeInfo();
const harnessHashes = Object.fromEntries(
	await Promise.all(
		['run.mts', 'model.mts', 'fixture/resources.ts', 'fixture/schema.graphql', 'fixture/config.yaml'].map(
			async (name) => [
				name,
				createHash('sha256')
					.update(await readFile(resolve(here, name)))
					.digest('hex'),
			]
		)
	)
);
const addonFiles = process.report
	.getReport()
	.sharedObjects.filter((name) => name.includes('fulltext') && name.endsWith('.node'));
const compiledHashes = Object.fromEntries(
	await Promise.all(
		[
			'dist/resources/Table.js',
			'dist/resources/indexes/fullTextQueryIndex.js',
			'dist/resources/indexes/fullTextQueryProtocol.js',
		].map(async (name) => [
			name,
			createHash('sha256')
				.update(await readFile(resolve(here, '../..', name)))
				.digest('hex'),
		])
	)
);
const addons = await Promise.all(
	addonFiles.map(async (name) => ({
		path: name,
		sha256: createHash('sha256')
			.update(await readFile(name))
			.digest('hex'),
	}))
);
await writeFile(
	resolve(output, 'provenance.json'),
	JSON.stringify(
		{
			harperHead,
			nativeRuntime,
			harnessHashes,
			compiledHashes,
			addons,
			node: process.version,
			options: { sizes, clients, cases, duration, writeRates },
		},
		null,
		2
	) + '\n'
);
const errors = createWriteStream(resolve(output, 'errors.ndjson'), { flags: 'a' });
async function errorRecord(value) {
	if (!errors.write(JSON.stringify(value) + '\n')) await once(errors, 'drain');
}
const options = {
	config: { threads: { count: 2 } },
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
	harperBinPath: resolve(here, '../../dist/bin/harper.js'),
};
let stopRequested = false;
const onSignal = () => {
	stopRequested = true;
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
	for (const rows of sizes) {
		await runPhase(
			() => stopRequested,
			() => Promise.resolve()
		);
		const ctx = createHarperContext(`fulltext-http-${rows}`);
		const report = {
			rows,
			node: process.version,
			osCold: false,
			defaultQueryLimits: true,
			bucketSelection: 'deterministic round-robin across entire catalog',
			cells: [],
			firstQueries: [],
			diagnostics: [],
			started: new Date().toISOString(),
		};
		let auth, fatal, sampling;
		let stopSampling = false;
		async function request(path, init = {}) {
			const response = await fetch(ctx.harper.httpURL + path, {
				...init,
				headers: { 'Authorization': auth, 'Content-Type': 'application/json', ...init.headers },
				signal: AbortSignal.timeout(45000),
			});
			const body = await response.text();
			if (!response.ok) throw Object.assign(new Error(body.slice(0, 4096)), { status: response.status });
			return { rows: body ? JSON.parse(body) : null, range: response.headers.get('content-range') };
		}
		async function diagnostics() {
			const samples = await Promise.all(
				Array.from({ length: 8 }, () => request('/QualificationState/', { headers: { Connection: 'close' } }))
			);
			for (const sample of samples) {
				assert(sample.rows.rss <= 6 * 1024 ** 3, 'server RSS exceeded 6 GiB');
				report.diagnostics.push({ at: Date.now(), ...sample.rows });
			}
			if (report.diagnostics.length > 50000) throw new Error('diagnostic sample bound exceeded');
		}
		async function guardDisk() {
			const { stdout } = await exec('du', ['-sk', ctx.harper.dataRootDir]);
			const bytes = Number(stdout.trim().split(/\s/)[0]) * 1024;
			assert(bytes <= 12 * 1024 ** 3, 'fixture disk exceeded 12 GiB');
			const free = await statfs(ctx.harper.dataRootDir);
			assert(free.bavail * free.bsize > 2 * 1024 ** 3, 'less than 2 GiB free disk');
			report.diskBytes = Math.max(report.diskBytes || 0, bytes);
		}
		let nextBucket = 0;
		async function query(name) {
			const bucket = nextBucket++ % (rows / MATCHES);
			const started = performance.now();
			const result =
				name === 'exact'
					? await request(
							`/Product/?catalogSearch=matches=bucket${String(bucket).padStart(6, '0')}&limit(20)&select(id,title,category,rank)`,
							{ headers: { Prefer: 'count=exact' } }
						)
					: await request(`/${name === 'structured' ? 'PlainProduct' : 'Product'}/`, {
							method: 'QUERY',
							body: JSON.stringify(target(name, bucket)),
						});
			verify(name, result.rows, result.range, bucket);
			return performance.now() - started;
		}
		try {
			const setupStarted = performance.now();
			await runPhase(
				() => stopRequested,
				() => setupHarperWithFixture(ctx, resolve(here, 'fixture'), options)
			);
			auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
			for (let start = 0; start < rows; start += 500) {
				assert(
					!stopRequested && performance.now() - setupStarted < 15 * 60000,
					'fixture setup exceeded 15 minutes or interrupted'
				);
				const batch = Array.from({ length: Math.min(500, rows - start) }, (_, offset) => record(start + offset));
				for (const table of ['Product', 'PlainProduct'])
					await request(`/${table}/`, { method: 'PUT', body: JSON.stringify(batch) });
				if (start % 10000 === 0) {
					await diagnostics();
					await guardDisk();
				}
			}
			await request('/Product/writer', {
				method: 'PUT',
				body: JSON.stringify({ id: 'writer', title: 'unmatched writer', category: 'writer', rank: -1 }),
			});
			await request('/PlainProduct/writer', {
				method: 'PUT',
				body: JSON.stringify({ id: 'writer', title: 'unmatched writer', category: 'writer', rank: -1 }),
			});
			const readyDeadline = Date.now() + 120000;
			for (const bucket of new Set([0, rows / MATCHES - 1])) {
				while (true) {
					await runPhase(
						() => stopRequested,
						() => Promise.resolve()
					);
					try {
						const strict = target('relevance', bucket);
						strict.limit = MATCHES;
						Object.assign(strict.conditions[0], { maxIndexLagMilliseconds: 0, waitForIndexMilliseconds: 30000 });
						const result = await request('/Product/', { method: 'QUERY', body: JSON.stringify(strict) });
						assert.strictEqual(result.rows.length, MATCHES);
						assert.deepStrictEqual(
							result.rows.map((row) => row.id).sort(),
							Array.from({ length: MATCHES }, (_, i) => record(bucket * MATCHES + i).id)
						);
						break;
					} catch (error) {
						if (stopRequested || Date.now() > readyDeadline) throw error;
						await delay(250);
					}
				}
			}
			report.setupMilliseconds = performance.now() - setupStarted;
			await runPhase(
				() => stopRequested,
				() => killHarper(ctx)
			);
			await runPhase(
				() => stopRequested,
				() => startHarper(ctx, options)
			);
			for (const name of cases) {
				report.firstQueries.push({
					name,
					milliseconds: await runPhase(
						() => stopRequested,
						() => query(name)
					),
					freshProcess: report.firstQueries.length === 0,
					osCold: false,
					order: report.firstQueries.length,
				});
				for (let i = 0; i < 3; i++)
					await runPhase(
						() => stopRequested,
						() => query(name)
					);
			}
			let ticks = 0;
			sampling = (async () => {
				while (!stopSampling && !stopRequested && !fatal) {
					try {
						await diagnostics();
						if (++ticks % 10 === 0) await guardDisk();
					} catch (error) {
						fatal = error;
					}
					await delay(1000);
				}
			})();
			for (const name of cases)
				for (const concurrency of clients)
					for (const writesPerSecond of writeRates) {
						assert(!fatal && !stopRequested, fatal?.message || 'interrupted');
						const diagnosticStart = report.diagnostics.length;
						await diagnostics();
						const reads = meter(),
							writes = meter();
						const bucketStart = nextBucket;
						const clientCpuStart = process.cpuUsage();
						const begin = performance.now(),
							deadline = begin + duration;
						const runReader = async () => {
							while (performance.now() < deadline && !fatal && !stopRequested) {
								const requestStarted = performance.now();
								try {
									reads.add(await query(name));
								} catch (error) {
									reads.fail(performance.now() - requestStarted, error.name === 'TimeoutError');
									await errorRecord({
										rows,
										name,
										concurrency,
										writesPerSecond,
										at: Date.now(),
										status: error.status,
										message: error.message,
									});
									if (error.code === 'ERR_ASSERTION') fatal = error;
								}
							}
						};
						const runWriter = async () => {
							if (!writesPerSecond) return;
							let sequence = 0;
							while (performance.now() < deadline && !fatal && !stopRequested) {
								const start = performance.now();
								try {
									await request(`/${name === 'structured' ? 'PlainProduct' : 'Product'}/writer`, {
										method: 'PUT',
										body: JSON.stringify({
											id: 'writer',
											title: `unmatched writer ${sequence++}`,
											category: 'writer',
											rank: -1,
										}),
									});
									writes.add(performance.now() - start);
								} catch (error) {
									writes.fail(performance.now() - start, error.name === 'TimeoutError');
									await errorRecord({
										rows,
										name,
										write: true,
										at: Date.now(),
										message: error.message,
										status: error.status,
									});
								}
								await delay(Math.max(0, 1000 / writesPerSecond - (performance.now() - start)));
							}
						};
						await Promise.all([...Array.from({ length: concurrency }, runReader), runWriter()]);
						const elapsed = performance.now() - begin;
						await diagnostics();
						const cellSamples = report.diagnostics.slice(diagnosticStart);
						const firstCpu = cellSamples[0].cpu,
							lastCpu = cellSamples.at(-1).cpu;
						const cell = {
							name,
							concurrency,
							writesPerSecond,
							durationMilliseconds: elapsed,
							admissionWindowMilliseconds: duration,
							drainMilliseconds: Math.max(0, elapsed - duration),
							diagnosticRange: [diagnosticStart, report.diagnostics.length],
							clientCpu: process.cpuUsage(clientCpuStart),
							serverCpuMicroseconds: { user: lastCpu.user - firstCpu.user, system: lastCpu.system - firstCpu.system },
							serverRssPeakBytes: Math.max(...cellSamples.map((sample) => sample.rss)),
							observedWorkerIds: [...new Set(cellSamples.map((sample) => sample.threadId))],
							bucketStart: bucketStart % (rows / MATCHES),
							bucketsAttempted: Math.min(rows / MATCHES, nextBucket - bucketStart),
							reads: reads.summary(),
							writes: writes.summary(),
						};
						cell.verdict = cellVerdict(cell.reads, cell.writes);
						cell.throughput = cell.reads.completed / (elapsed / 1000);
						report.cells.push(cell);
						await writeFile(resolve(output, `${rows}.json`), JSON.stringify(report, null, 2) + '\n');
						assert(!fatal && !stopRequested, fatal?.message || 'interrupted');
					}
			assert(new Set(report.diagnostics.map((v) => v.threadId)).size === 2, 'did not observe both HTTP workers');
		} catch (error) {
			report.failure = { message: error.message, stack: error.stack };
			throw error;
		} finally {
			stopSampling = true;
			if (sampling) await sampling;
			if (ctx.harper?.dataRootDir) await teardownHarper(ctx);
			report.verdict =
				report.failure || report.cells.some((cell) => cell.verdict !== 'qualified') ? 'unqualified' : 'qualified';
			await writeFile(resolve(output, `${rows}.json`), JSON.stringify(report, null, 2) + '\n');
		}
	}
} finally {
	errors.end();
	await once(errors, 'finish');
	const monitorRegistry = resolve(process.env.HARPER_INTEGRATION_TEST_MONITOR_DIR, 'registry.json');
	try {
		const registry = JSON.parse(await readFile(monitorRegistry, 'utf8'));
		const monitorPid = registry.monitor?.pid;
		if (monitorPid) {
			for (let attempt = 0; attempt < 20; attempt++) {
				try {
					process.kill(monitorPid, 0);
				} catch {
					break;
				}
				await delay(250);
			}
			try {
				process.kill(monitorPid, 'SIGTERM');
			} catch (error) {
				if (error.code !== 'ESRCH') throw error;
			}
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	process.off('SIGINT', onSignal);
	process.off('SIGTERM', onSignal);
}
