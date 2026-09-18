/** Native HNSW coverage waits and response metadata through REST with six HTTP workers. */
import { test } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
} from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

test(
	'native queries expose bounded coverage and reject expired or strict catch-up lag',
	{ timeout: 360_000 },
	async () => {
		const ctx = createHarperContext('native-plane-coverage');
		let seed = 42;
		const records = Array.from({ length: 20_000 }, (_, id) => {
			const vector = Array.from({ length: 128 }, () => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return (seed / 4294967296) * 2 - 1;
			});
			const length = Math.hypot(...vector);
			return { id, vector: vector.map((value) => value / length) };
		});
		const target = records.at(-1)!.vector;
		const expected = records
			.map(({ id, vector }) => ({
				id,
				dot: vector.reduce((sum, value, i) => sum + value * target[i], 0),
			}))
			.sort((a, b) => b.dot - a.dot)
			.slice(0, 10)
			.map(({ id }) => id);
		try {
			await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'fixtures/native-plane-coverage'), {
				config: { threads: { count: 6 }, logging: { level: 'warn' } },
				env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
				harperBinPath: resolve('dist/bin/harper.js'),
			});
			const headers = {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
				'Connection': 'close',
			};
			async function request(path: string, method = 'GET', body?: unknown) {
				const response = await fetch(`${ctx.harper.httpURL}${path}`, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(30_000),
				});
				const text = await response.text();
				return {
					status: response.status,
					coverage: response.headers.get('harper-index-coverage'),
					body: text ? JSON.parse(text) : undefined,
				};
			}
			const query = (tolerance?: unknown, wait?: unknown, queryTarget = target, path = '/PlaneProbe/') =>
				request(path, 'QUERY', {
					sort: {
						attribute: 'vector',
						target: queryTarget,
						distance: 'cosine',
						ef: 200,
						...(tolerance === undefined ? {} : { maxIndexLagMilliseconds: tolerance }),
						...(wait === undefined ? {} : { waitForIndexMilliseconds: wait }),
					},
					select: ['id', '$distance'],
					limit: 10,
				});
			await waitFor(async () => (await request('/PlaneStatus/')).body.readiness.state === 'ready', 30_000);
			await waitFor(async () => (await query(0)).status === 200, 30_000);
			for (let start = 0; start < records.length; start += 500) {
				const result = await request('/PlaneProbe/', 'PUT', records.slice(start, start + 500));
				assert(result.status < 300, JSON.stringify(result));
			}
			for (const path of ['/PlaneProbe/', '/MappedPlane/', '/ConcatenatedPlane/']) {
				const shortWait = await query(1_000_000, 1, target, path);
				assert.equal(shortWait.status, 200, JSON.stringify(shortWait));
				assert.equal(shortWait.coverage, null);
				const errors = shortWait.body.filter((record: any) => record.error);
				if (errors.length) {
					assert.equal(errors.length, 1, JSON.stringify(shortWait));
					assert.match(errors[0].error, /^DerivedIndexLagError/);
				} else assert(shortWait.body.some(({ id }: { id: number }) => id === records.length - 1));
			}
			// Three ef=200 queries over a 20k-node plane: a waiter that samples this every tick
			// competes with the durability barrier it is waiting for, so the catch-up loop below
			// bounds how many times it runs.
			async function sampleLagContracts() {
				const strict = await query(0);
				if (strict.status === 503) {
					assert.equal(strict.body.code, 'DERIVED_INDEX_LAGGING', JSON.stringify(strict));
				} else {
					assert.equal(strict.status, 200, JSON.stringify(strict));
					assert.match(strict.coverage ?? '', /^current; lag=0; tolerance=0$/);
					assert(strict.body.some(({ id }) => id === records.length - 1));
				}
				const normal = await query();
				if (normal.status === 503) {
					assert.equal(normal.body.code, 'DERIVED_INDEX_LAGGING', JSON.stringify(normal));
				} else {
					assert.equal(normal.status, 200, JSON.stringify(normal));
					assert.match(
						normal.coverage ?? '',
						/^(current|bounded); lag=[0-9.e+-]+; tolerance=3000$/,
						JSON.stringify(normal)
					);
				}
				const tolerant = await query(1_000_000);
				if (tolerant.status === 200) {
					assert(Array.isArray(tolerant.body));
					assert.match(tolerant.coverage ?? '', /^(current|bounded); lag=[0-9.e+-]+; tolerance=1000000$/);
				} else assert.equal(tolerant.body.code, 'DERIVED_INDEX_LAGGING', JSON.stringify(tolerant));
				return strict.status;
			}
			let progress: unknown;
			let lastTuple = '';
			const trail: string[] = [];
			const catchUpStartedAt = Date.now();
			let contractSamples = 0;
			try {
				await waitFor(
					async () => {
						const before = (await request('/PlaneStatus/')).body;
						progress = before;
						const tuple = `${before.mappings}/${before.pending}/${before.nativeNodes}`;
						if (tuple !== lastTuple) {
							lastTuple = tuple;
							trail.push(`${Date.now() - catchUpStartedAt}ms ${tuple}`);
						}
						let strictStatus: number | undefined;
						if (contractSamples < 5) {
							contractSamples++;
							strictStatus = await sampleLagContracts();
						}
						if (before.mappings !== records.length) return false;
						return (strictStatus ?? (await query(0)).status) === 200;
					},
					{ timeout: 180_000, interval: 500, message: 'native plane did not certify current coverage' }
				);
			} catch (error) {
				const samples = trail.length > 40 ? [...trail.slice(0, 20), '…', ...trail.slice(-20)] : trail;
				throw new Error(
					`Native catch-up failed after ${Date.now() - catchUpStartedAt}ms. Mappings publish as one durability unit, so this is what became externally visible, not the barrier's own progress — mappings/pending/nativeNodes: ${samples.join(', ')}; last progress: ${JSON.stringify(progress)}`,
					{ cause: error }
				);
			}
			console.log(`native plane certified current coverage in ${Date.now() - catchUpStartedAt}ms`);
			const final = await query(0);
			assert.equal(final.status, 200, JSON.stringify(final));
			const ids = final.body.map((record: { id: number }) => record.id);
			assert(ids.includes(records.length - 1), 'the newest vector is missing after catch-up');
			assert(expected.filter((id) => ids.includes(id)).length >= 9, 'recall@10 fell below 90% after catch-up');
			for (const invalid of [-1, null, '1000']) {
				const result = await query(invalid);
				assert.equal(result.status, 400, JSON.stringify(result));
				assert.match(result.body.title, /maxIndexLagMilliseconds/);
			}
			for (const invalid of [-1, null, '1000', 30_001]) {
				const result = await query(undefined, invalid);
				assert.equal(result.status, 400, JSON.stringify(result));
				assert.match(result.body.title, /waitForIndexMilliseconds/);
			}
			for (let start = 0; start < 200; start += 20) {
				await Promise.all(
					Array.from({ length: 20 }, async (_, offset) => {
						const sequence = start + offset;
						const id = records.length + sequence;
						const vector = records[sequence].vector;
						await waitFor(
							async () => {
								const written = await request(`/PlaneProbe/${id}`, 'PUT', { vector });
								if (written.status === 503 && written.body.code === 'DERIVED_INDEX_LAGGING') return false;
								assert(written.status < 300, JSON.stringify(written));
								return true;
							},
							{ timeout: 30_000, interval: 100, message: `write ${id} stayed backpressured` }
						);
						const result = await query(
							undefined,
							20_000,
							vector,
							['/PlaneProbe/', '/MappedPlane/', '/ConcatenatedPlane/'][sequence % 3]
						);
						assert.equal(result.status, 200, JSON.stringify(result));
						assert.equal(result.coverage, null);
						assert(!result.body.some((record: any) => record.error), JSON.stringify(result));
						assert(
							result.body.some((record: { id: number }) => record.id === id),
							`prior write ${id} missing`
						);
					})
				);
			}
			await killHarper(ctx);
			await startHarper(ctx, {
				config: { threads: { count: 6 }, logging: { level: 'warn' } },
				env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
				harperBinPath: resolve('dist/bin/harper.js'),
			});
			await waitFor(
				async () => {
					const result = await query(0, 10_000);
					if (result.status === 503) return false;
					assert.equal(result.status, 200, JSON.stringify(result));
					assert.equal(result.coverage, null);
					if (result.body.some((record: any) => record.error)) {
						for (const record of result.body.filter((record: any) => record.error))
							assert.match(
								record.error,
								/^(DerivedIndexLagError|ServerError: The native HNSW index is (unavailable|rebuilding))/
							);
						return false;
					}
					assert(result.body.some(({ id }: { id: number }) => id === records.length - 1));
					return true;
				},
				{ timeout: 30_000, message: 'restarted native index did not certify its persisted coverage' }
			);
		} finally {
			await teardownHarper(ctx);
		}
	}
);
