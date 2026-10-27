/**
 * Live same-database sourcedFrom commits keep source versions but use distinct local log keys,
 * without rebuilding unrelated native indexes. https://github.com/HarperFast/harper/issues/3340
 * Uses RocksDB for the reported local-log/native-index boundary; LMDB is outside this fixture.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

suite('live sourcedFrom local log identities', (ctx: ContextWithHarper) => {
	let headers: Record<string, string>;

	async function request(path: string, method = 'GET', body?: unknown) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
		return text ? JSON.parse(text) : undefined;
	}

	async function operation(body: Record<string, unknown>) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, 200, text);
		return JSON.parse(text);
	}

	async function fullTextReadiness() {
		const description = await operation({ operation: 'describe_table', database: 'data', table: 'Probe' });
		const readiness = description.full_text_indexes.find(({ name }) => name === 'probeSearch').readiness;
		return { state: readiness.state, ownerEpoch: readiness.owner_epoch };
	}

	async function search(text: string) {
		const records = await request(`/Probe/?probeSearch=matches=${text}&select(id,body)`);
		assert.ok(Array.isArray(records), JSON.stringify(records));
		assert.ok(
			records.every((record) => typeof record.id === 'string'),
			JSON.stringify(records)
		);
		return records.map(({ id }) => id).sort();
	}

	async function neighbors(target: number[]) {
		const records = await request('/Probe/', 'QUERY', {
			sort: { attribute: 'vector', target, distance: 'cosine' },
			select: ['id', '$distance'],
			limit: 1,
		});
		assert.ok(Array.isArray(records), JSON.stringify(records));
		return records.map(({ id }) => id);
	}

	async function assertIndexesReady(fullTextEpoch: unknown, vectorEpoch: string) {
		const fullText = await fullTextReadiness();
		const { vector } = await request('/SourceState/');
		assert.strictEqual(fullText.state, 'ready', JSON.stringify(fullText));
		assert.strictEqual(vector.state, 'ready', JSON.stringify(vector));
		assert.strictEqual(fullText.ownerEpoch, fullTextEpoch, 'full-text must not rebuild');
		assert.strictEqual(vector.ownerEpoch, vectorEpoch, 'HNSW must not rebuild');
	}

	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'sourcedfrom-log-identity'), {
			config: { threads: { count: 1 } },
			env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
			harperBinPath: resolve('dist/bin/harper.js'),
		});
		headers = {
			'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			'Content-Type': 'application/json',
		};
		await operation({
			operation: 'insert',
			database: 'data',
			table: 'Probe',
			records: [{ id: 'p1', body: 'sentinel lighthouse', vector: [1, 0, 0] }],
		});
		await waitFor(async () => (await fullTextReadiness()).state === 'ready', 30_000);
		await waitFor(async () => (await request('/SourceState/')).vector.state === 'ready', 30_000);
		await waitFor(async () => (await search('lighthouse')).includes('p1'), 30_000);
		await waitFor(async () => (await neighbors([1, 0, 0]))[0] === 'p1', 30_000);
	});

	after(async () => teardownHarper(ctx));

	for (const kind of ['Direct', 'Generic']) {
		test(`${kind} live apply preserves versions, unique commit keys and native index availability`, async () => {
			const source = `${kind}Source`;
			const mirror = `${kind}Mirror`;
			const fullTextBefore = await fullTextReadiness();
			const { vector: vectorBefore } = await request('/SourceState/');
			assert.match(fullTextBefore.ownerEpoch, /^[1-9]\d*$/);
			assert.match(vectorBefore.ownerEpoch, /^[1-9]\d*$/);
			for (const [id, title] of [
				['s1', 'alpha'],
				['s2', 'beta'],
			]) {
				await request(`/${source}/${id}`, 'PUT', { id, title, status: 'active', revision: 'r1' });
			}
			await request(`/${source}/s2`, 'PATCH', { status: 'withdrawn', revision: 'r2' });

			const isCaseRecord = ({ id }) => id === 's1' || id === 's2';
			let state;
			await waitFor(
				async () => {
					state = await request('/SourceState/');
					return state.entries.filter((entry) => entry.table === mirror && isCaseRecord(entry)).length >= 3;
				},
				{ timeout: 30_000, message: `${mirror} must receive all three live writes without a cache read` }
			);
			const sourceEntries = state.entries.filter((entry) => entry.table === source && isCaseRecord(entry));
			const mirrorEntries = state.entries.filter((entry) => entry.table === mirror && isCaseRecord(entry));
			assert.deepStrictEqual(
				sourceEntries.map(({ type }) => type),
				['put', 'put', 'patch']
			);
			assert.deepStrictEqual(
				mirrorEntries.map(({ type }) => type),
				['put', 'put', 'put']
			);
			assert.deepStrictEqual(
				mirrorEntries.map(({ id, version }) => [id, version]),
				sourceEntries.map(({ id, version }) => [id, version]),
				'live apply must preserve source versions'
			);
			const entries = [...sourceEntries, ...mirrorEntries];
			assert.ok(
				entries.every(({ endTxn }) => endTxn),
				'each single-write commit must terminate'
			);
			for (const [index, revision] of ['r1', 'r2'].entries()) {
				const cached = state.records[mirror][index];
				assert.strictEqual(cached.value.revision, revision);
				assert.strictEqual(cached.version, state.records[source][index].version);
			}

			const marker = kind.toLowerCase();
			const vector = kind === 'Direct' ? [0, 1, 0] : [0, 0, 1];
			await request(`/Probe/${marker}`, 'PUT', { body: `${marker}checkpoint`, vector });
			await waitFor(
				async () => {
					await assertIndexesReady(fullTextBefore.ownerEpoch, vectorBefore.ownerEpoch);
					return (await search(`${marker}checkpoint`)).includes(marker) && (await neighbors(vector))[0] === marker;
				},
				{ timeout: 30_000, message: 'the index must consume past the source and cache commits' }
			);
			assert.deepStrictEqual(await search('lighthouse'), ['p1']);
			assert.deepStrictEqual(await neighbors([1, 0, 0]), ['p1']);
			await assertIndexesReady(fullTextBefore.ownerEpoch, vectorBefore.ownerEpoch);
			assert.strictEqual(
				new Set(entries.map(({ key }) => key)).size,
				6,
				`separate local commits must have distinct keys: ${JSON.stringify(entries)}`
			);
		});

		test(`${kind} multi-record live apply keeps each transaction grouped under one fresh key`, async () => {
			await request(`/${kind}Source/`, 'PUT', [
				{ id: 'batch1', title: 'one', revision: 'r1' },
				{ id: 'batch2', title: 'two', revision: 'r1' },
			]);
			let entries;
			let state;
			await waitFor(
				async () => {
					state = await request('/SourceState/');
					entries = state.entries.filter(({ table, id }) => table.startsWith(kind) && id.startsWith('batch'));
					return entries.length >= 4;
				},
				{ timeout: 30_000, message: 'both records must reach the mirror through live apply' }
			);
			const source = entries.filter(({ table }) => table === `${kind}Source`);
			const mirror = entries.filter(({ table }) => table === `${kind}Mirror`);
			for (const group of [source, mirror]) {
				assert.deepStrictEqual(
					group.map(({ id }) => id),
					['batch1', 'batch2']
				);
				assert.strictEqual(group[0].key, group[1].key, 'one transaction must share a log key');
				assert.deepStrictEqual(
					group.map(({ endTxn }) => Boolean(endTxn)),
					[false, true]
				);
			}
			assert.notStrictEqual(source[0].key, mirror[0].key, 'the cache commit needs its own identity');
			const committedKeys = state.entries.filter(({ endTxn }) => endTxn).map(({ key }) => key);
			assert.strictEqual(new Set(committedKeys).size, committedKeys.length, 'no completed commit may reuse a key');
			assert.deepStrictEqual(
				mirror.map(({ version }) => version),
				source.map(({ version }) => version)
			);
		});
	}
});
