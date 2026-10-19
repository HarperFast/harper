import { NO_FULL_WORKER_COVERAGE } from '../integrationTests/database/recordCachingWorkers.ts';
import { suite, test } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { toBufferKey } from 'ordered-binary';
import { runtimeInfo } from '@harperfast/fulltext/native';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const sizes = (process.env.FT_BENCH_SIZES ?? '10000,50000,100000').split(',').map(Number);
const samples = Number(process.env.FT_BENCH_SAMPLES ?? 20);
const reachableWorkers = NO_FULL_WORKER_COVERAGE ? 1 : 2;
const fixture = resolve(import.meta.dirname, 'fulltext-continuation');
const idFor = (index: number) => `p${String(index).padStart(6, '0')}`;
const ordered = (ids: string[]) =>
	ids.sort((a, b) =>
		Buffer.compare(Buffer.from(toBufferKey(a).toString('base64url')), Buffer.from(toBufferKey(b).toString('base64url')))
	);
function distribution(values: number[]) {
	values.sort((a, b) => a - b);
	return {
		samples: values.length,
		p50: values[Math.max(0, Math.ceil(values.length * 0.5) - 1)],
		p95: values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.95) - 1))],
		max: values.at(-1),
	};
}

for (const size of sizes) {
	suite(`fulltext bounded workload ${size}`, (ctx: ContextWithHarper) => {
		test(
			'measures warm filtering, concurrent traffic, and local/cross-worker paging',
			{ timeout: 600000 },
			async () => {
				await setupHarperWithFixture(ctx, fixture, {
					config: { threads: { count: 2 } },
					env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
				});
				const authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
				async function request(url: string, body?: unknown) {
					const response = await fetch(url, {
						method: body ? 'POST' : 'GET',
						headers: { 'Authorization': authorization, 'Content-Type': 'application/json', 'Connection': 'close' },
						body: body ? JSON.stringify(body) : undefined,
						signal: AbortSignal.timeout(60000),
					});
					const text = await response.text();
					assert.strictEqual(response.status, 200, text);
					return JSON.parse(text);
				}
				const bench = (body: unknown) => request(`${ctx.harper.httpURL}/Bench/`, body);
				const operation = (body: unknown) => request(ctx.harper.operationsAPIURL, body);
				const close = async (query, result) => {
					if (result.continuation)
						await bench({ query: { ...query, continuation: result.continuation, closeContinuation: true } });
				};
				function validate(result, expected: string[]) {
					if (result.error) {
						assert.strictEqual(result.error.status, 400, JSON.stringify(result));
						assert.match(result.error.message, /maxRawHitsPerRequest/);
					} else
						assert.deepStrictEqual(
							result.records.map(({ id }) => id),
							expected
						);
				}
				async function profileQuery(query) {
					const started = new Set<number>();
					for (let n = 0; n < 30 && started.size < reachableWorkers; n++)
						started.add((await bench({ action: 'profile-start', main: n === 0 })).worker);
					assert.strictEqual(started.size, reachableWorkers, 'profiling must reach available HTTP workers');
					const result = await bench({ query });
					const stopped = new Map<number, any>();
					for (let n = 0; n < 30 && stopped.size < reachableWorkers; n++) {
						const value = await bench({ action: 'profile-stop' });
						if (value.counts) stopped.set(value.worker, value);
					}
					assert.strictEqual(stopped.size, reachableWorkers);
					return { result, workers: Object.fromEntries(stopped) };
				}
				try {
					await operation({
						operation: 'insert',
						schema: 'data',
						table: 'Control',
						records: [{ id: 'control', value: 'ready' }],
					});
					for (let start = 0; start < size; start += 2000) {
						await operation({
							operation: 'insert',
							schema: 'data',
							table: 'Product',
							records: Array.from({ length: Math.min(2000, size - start) }, (_, n) => ({
								id: idFor(start + n),
								title: start + n === size - 1 ? 'widget lastmarker' : 'widget',
								owner: (start + n) % 500 === 0 ? 'rare' : 'common',
								category: (start + n) % 500 === 0 ? 'rare' : 'common',
							})),
						});
					}
					const deadline = Date.now() + 120000;
					while (true) {
						const result = await bench({
							query: {
								conditions: [
									{
										attribute: 'catalogSearch',
										comparator: 'matches',
										value: 'lastmarker',
										waitForIndexMilliseconds: 30000,
									},
								],
								limit: 1,
								select: ['id', 'title'],
							},
						});
						if (!result.error && result.records[0]?.id === idFor(size - 1)) break;
						assert(Date.now() < deadline, JSON.stringify(result));
						await delay(50);
					}
					console.log(
						'FT_ENVIRONMENT ' +
							JSON.stringify({
								size,
								samples,
								node: process.version,
								reachableHttpWorkers: reachableWorkers,
								commit: execFileSync('git', ['rev-parse', 'HEAD'], {
									cwd: resolve(import.meta.dirname, '..'),
									encoding: 'utf8',
								}).trim(),
								cpu: cpus()[0].model,
								native: await runtimeInfo(),
							})
					);
					const rare = ordered(Array.from({ length: Math.ceil(size / 500) }, (_, n) => idFor(n * 500)));
					for (const comparator of ['matches', 'matches_prefix']) {
						for (const [filter, attribute, value] of [
							['sparse-unindexed', 'owner', 'rare'],
							['none-unindexed', 'owner', 'missing'],
							['sparse-indexed', 'category', 'rare'],
							['none-indexed', 'category', 'missing'],
						]) {
							const base = {
								operator: 'and',
								conditions: [
									{
										attribute: 'catalogSearch',
										comparator,
										value: comparator === 'matches' ? 'widget' : 'widg',
										waitForIndexMilliseconds: 30000,
									},
									{ attribute, comparator: 'equals', value },
								],
								limit: 25,
								select: ['id', 'title'],
							};
							const expected = value === 'rare' ? rare.slice(0, 25) : [];
							for (const mode of ['ordinary', 'continuation']) {
								const query = mode === 'ordinary' ? base : { ...base, continuation: true };
								const warm = await bench({ query });
								validate(warm, expected);
								await close(query, warm);
								const times: number[] = [],
									delays: number[] = [],
									loaded: number[] = [],
									probes: any[] = [],
									outcomes: any[] = [],
									rss: number[] = [];
								for (let n = 0; n < samples + 3; n++) {
									let done = false;
									const pending = bench({ query }).finally(() => {
										done = true;
									});
									if (n >= samples)
										while (!done) {
											const start = performance.now();
											const response = await bench({ action: 'control' });
											assert.strictEqual(response.value, 'ready');
											probes.push({ milliseconds: performance.now() - start, worker: response.worker });
										}
									const result = await pending;
									validate(result, expected);
									(n < samples ? times : loaded).push(result.milliseconds);
									delays.push(result.eventLoopMaxMilliseconds);
									rss.push(result.processRssBytes);
									outcomes.push(result.error?.status ?? 'success');
									await close(query, result);
								}
								const profiled = await profileQuery(query);
								validate(profiled.result, expected);
								await close(query, profiled.result);
								console.log(
									'FT_MEASUREMENT ' +
										JSON.stringify({
											size,
											comparator,
											filter,
											mode,
											latencyMilliseconds: distribution(times),
											loadedLatencyMilliseconds: distribution(loaded),
											controlLatencyMilliseconds: distribution(probes.map(({ milliseconds }) => milliseconds)),
											eventLoopDelayMilliseconds: distribution(delays),
											peakProcessRssBytes: Math.max(...rss),
											outcomes,
											counts: profiled.workers,
										})
								);
							}
							if (filter === 'sparse-unindexed' && !NO_FULL_WORKER_COVERAGE) {
								const query = { ...base, limit: 5 };
								const first = await bench({ query: { ...query, continuation: true } });
								assert(first.continuation);
								const routes: Record<string, number[]> = { local: [], remote: [] };
								for (let n = 0; n < 40 && (routes.local.length < samples || routes.remote.length < samples); n++) {
									const resumed = await bench({ query: { ...query, continuation: first.continuation } });
									validate(resumed, rare.slice(5, 10));
									routes[resumed.worker === first.worker ? 'local' : 'remote'].push(resumed.milliseconds);
								}
								assert(routes.local.length >= samples && routes.remote.length >= samples, JSON.stringify(routes));
								const profiled = await profileQuery({ ...query, continuation: first.continuation });
								validate(profiled.result, rare.slice(5, 10));
								await close(query, first);
								console.log(
									'FT_RESUME ' +
										JSON.stringify({
											size,
											comparator,
											visibleLimit: 5,
											localMilliseconds: distribution(routes.local),
											remoteMilliseconds: distribution(routes.remote),
											profiledRoute: profiled.result.worker === first.worker ? 'local' : 'remote',
											counts: profiled.workers,
										})
								);
							}
						}
					}
				} finally {
					await teardownHarper(ctx);
				}
			}
		);
	});
}
