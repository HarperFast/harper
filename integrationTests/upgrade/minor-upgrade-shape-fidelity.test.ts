/**
 * QA-767: previous-minor records retain exact returned JSON values and types through upgrade,
 * new writes, and cold restart on RocksDB with random-access fields enabled.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';
import { waitFor } from '../../unitTests/waitFor.js';
import {
	previousMinorInstalls,
	FIRST_BOOT_ENV,
	NO_PREVIOUS_MINOR,
	SUITE_TIMEOUT_MS,
	skipCrossVersion,
} from './minorVersionFixtures.ts';

type FidelityRecord = { id: string; [key: string]: unknown };

const MANIFEST: FidelityRecord[] = [
	{ id: 'm-int8-pos', kind: 'int8-positive', value: 7 },
	{ id: 'm-int8-neg', kind: 'int8-negative', value: -100 },
	{ id: 'm-int16', kind: 'int16', value: 30000 },
	{ id: 'm-int32-pos', kind: 'int32-positive', value: 2_000_000_000 },
	{ id: 'm-int32-neg', kind: 'int32-negative', value: -2_000_000_000 },
	{ id: 'm-int64-long', kind: 'needs-Long (>32-bit)', value: 5_000_000_000 },
	{ id: 'm-int64-long-big', kind: 'needs-Long (near 2^53)', value: 9_007_199_254_740_000 },
	{ id: 'm-float32-a', kind: 'float32-representable-a', value: 1.5 },
	{ id: 'm-float32-b', kind: 'float32-representable-b', value: 0.25 },
	{ id: 'm-float64-pi', kind: 'float64-only-pi', value: Math.PI },
	{ id: 'm-float64-tiny', kind: 'float64-only-tiny', value: 1e-10 },
	{ id: 'm-float64-huge', kind: 'float64-only-huge', value: 1e100 },
	{ id: 'm-float64-precise', kind: 'float64-only-precise', value: 1.23456789012345 },
	{ id: 'm-str-empty', kind: 'string-empty', value: '' },
	{ id: 'm-str-short', kind: 'string-short', value: 'hi' },
	{ id: 'm-str-long', kind: 'string-long-500', value: 'L'.repeat(500) },
	{ id: 'm-str-unicode', kind: 'string-unicode', value: '标签-étiquette-🎉-résumé' },
	{ id: 'm-bool-true', kind: 'boolean-true', value: true },
	{ id: 'm-bool-false', kind: 'boolean-false', value: false },
	{ id: 'm-null', kind: 'null-value', value: null },
	{ id: 'm-empty-obj', kind: 'empty-object', value: {} },
	{ id: 'm-empty-arr', kind: 'empty-array', value: [] },
	{ id: 'm-nested-obj', kind: 'nested-object', value: { a: { b: { c: [1, 2, 3], d: 'x' } }, e: null } },
	{ id: 'm-mixed-arr', kind: 'mixed-type-array', value: [1, 'two', true, null, { x: 1 }, [1, 2, 3], 3.14] },
];

function counterValue(tier: number, idx: number): number {
	if (tier === 0) return 3 + (idx % 29);
	if (tier === 1) return 100_000 + (idx % 900_000);
	return Number.MAX_SAFE_INTEGER - (idx % 1_000_000);
}
function scoreValue(tier: number, idx: number): number {
	if (tier === 0) return idx % 31;
	if (tier === 1) return 300_000 + (idx % 700_000);
	return Number.MAX_SAFE_INTEGER - 7 - (idx % 500_000) * 3;
}
function gaugeValue(tier: number, idx: number): number {
	if (tier === 0) return 1.5 + (idx % 8) * 0.25;
	return Math.PI * (1 + (idx % 97));
}
function labelValue(tier: number, idx: number): string {
	if (tier === 0) return '';
	if (tier === 1) return 'lbl' + (idx % 97);
	if (tier === 2) return 'L'.repeat(300);
	return 'étiquette-' + (idx % 50);
}
function tagValue(tier: number, idx: number): string {
	if (tier === 0) return '';
	if (tier === 1) return 'tg' + (idx % 89);
	if (tier === 2) return 'T'.repeat(300);
	return '标签-' + (idx % 50);
}
function counterPhase(idx: number, total: number): number {
	if (idx < total / 3) return 0;
	if (idx < (2 * total) / 3) return 1;
	return 2;
}
const RADICES = [3, 2, 4, 4];
const ODOMETER_SIZE = RADICES.reduce((a, b) => a * b, 1);
function odometerDigits(idx: number): number[] {
	const rem = idx % ODOMETER_SIZE;
	const digits: number[] = [];
	for (let i = 0; i < RADICES.length; i++) {
		let placeValue = 1;
		for (let j = i + 1; j < RADICES.length; j++) placeValue *= RADICES[j];
		digits.push(Math.floor(rem / placeValue) % RADICES[i]);
	}
	return digits;
}
function hetBody(idx: number, total: number): Record<string, unknown> {
	const ct = counterPhase(idx, total);
	const [st, gt, lt, tt] = odometerDigits(idx);
	return {
		counter: counterValue(ct, idx),
		score: scoreValue(st, idx),
		gauge: gaugeValue(gt, idx),
		label: labelValue(lt, idx),
		tag: tagValue(tt, idx),
	};
}
function newShapeBody(idx: number, total: number): Record<string, unknown> {
	return { ...hetBody(idx, total), extra: 'post-upgrade-field-' + (idx % 11), extraFlag: idx % 2 === 0 };
}

const TOTAL = 4000;
const OLD_COUNT = 3000;
const SAME_COUNT = 1000;
const NEW_COUNT = 500;
const recordId = (prefix: string, i: number) => prefix + String(i).padStart(6, '0');
const OLD_RECORDS = Array.from({ length: OLD_COUNT }, (_, i) => ({ id: recordId('p', i), ...hetBody(i, TOTAL) }));
const SAME_RECORDS = Array.from({ length: SAME_COUNT }, (_, i) => ({
	id: recordId('s', i),
	...hetBody(OLD_COUNT + i, TOTAL),
}));
const NEW_RECORDS = Array.from({ length: NEW_COUNT }, (_, i) => ({ id: recordId('n', i), ...newShapeBody(i, TOTAL) }));
const ALL_RECORDS = [...OLD_RECORDS, ...SAME_RECORDS, ...NEW_RECORDS];
const PREVIOUS_CONFIG = { storage: { randomAccessFields: false }, threads: { count: 1 } };
const CURRENT_CONFIG = { storage: { randomAccessFields: true }, threads: { count: 1 } };
const ENV = { ...FIRST_BOOT_ENV, HARPER_STORAGE_ENGINE: 'rocksdb' };
const FIXTURE = join(import.meta.dirname, 'minor-upgrade-shape-fidelity');

function assertRecord(actual: FidelityRecord, expected: FidelityRecord, table: string) {
	// These timestamps are generated by Harper, not part of the input value/type contract.
	const fields = Object.keys(actual).filter((key) => key !== '__createdtime__' && key !== '__updatedtime__');
	assert.deepStrictEqual(fields.sort(), Object.keys(expected).sort(), `${table}/${expected.id}: fields`);
	for (const field of Object.keys(expected)) {
		assert.ok(
			typeof actual[field] === typeof expected[field] && isDeepStrictEqual(actual[field], expected[field]),
			`${table}/${expected.id}.${field}: value/type mismatch`
		);
	}
}

async function upsert(ctx: ContextWithHarper, table: string, records: FidelityRecord[]) {
	for (let i = 0; i < records.length; i += 500)
		await sendOperation(ctx.harper, { operation: 'upsert', table, records: records.slice(i, i + 500) });
}

async function checkTable(ctx: ContextWithHarper, table: string, expected: FidelityRecord[]) {
	const description = await sendOperation(ctx.harper, { operation: 'describe_table', table, exact_count: true });
	assert.strictEqual(description.record_count, expected.length, `${table}: full table count`);
	const rows: FidelityRecord[] = await sendOperation(ctx.harper, {
		operation: 'search_by_conditions',
		table,
		conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'a' }],
	});
	assert.ok(Array.isArray(rows), `${table}: array response`);
	assert.strictEqual(rows.length, expected.length, `${table}: count`);
	assert.deepStrictEqual(rows.map(({ id }) => id).sort(), expected.map(({ id }) => id).sort(), `${table}: exact IDs`);
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const row of expected) assertRecord(byId.get(row.id)!, row, table);
	return byId;
}

async function checkEncoder(ctx: ContextWithHarper, enabled: boolean) {
	const client = createApiClient(ctx.harper);
	let response;
	await waitFor(
		async () => {
			response = await client.reqRest('/Encoder767/').timeout(5000);
			return response.status !== 404;
		},
		{ timeout: 30000, interval: 100, message: 'Encoder767 route readiness' }
	);
	assert.strictEqual(response.status, 200, 'Encoder767 response');
	assert.strictEqual(response.body.randomAccessStructure, enabled, 'WidthShapes encoder mode');
	assert.ok(existsSync(join(ctx.harper.dataRootDir, 'database', 'data', 'CURRENT')), 'data must use RocksDB');
}

if (previousMinorInstalls.length === 0)
	suite('minor-upgrade byte/type fidelity', { skip: NO_PREVIOUS_MINOR }, () => {});

for (const previousMinor of previousMinorInstalls) {
	suite(
		`QA-767 v${previousMinor.version} → current JSON value/type fidelity [rocksdb]`,
		{ skip: skipCrossVersion, timeout: SUITE_TIMEOUT_MS },
		(ctx: ContextWithHarper) => {
			before(
				async () => {
					await startHarper(ctx, { config: PREVIOUS_CONFIG, env: ENV, harperBinPath: previousMinor.binPath });
					await sendOperation(ctx.harper, {
						operation: 'create_table',
						table: 'FidelityCheck',
						primary_key: 'id',
						attributes: [
							{ name: 'id', type: 'ID' },
							{ name: 'kind', type: 'String' },
							{ name: 'value', type: 'Any' },
						],
					});
					await sendOperation(ctx.harper, {
						operation: 'create_table',
						table: 'WidthShapes',
						primary_key: 'id',
						attributes: [{ name: 'id', type: 'ID' }],
					});
					await upsert(ctx, 'FidelityCheck', MANIFEST);
					await upsert(ctx, 'WidthShapes', OLD_RECORDS);
					await checkTable(ctx, 'FidelityCheck', MANIFEST);
					await checkTable(ctx, 'WidthShapes', OLD_RECORDS);
					await killHarper(ctx);
					const component = join(ctx.harper.dataRootDir, 'components', 'qa767-encoder');
					await mkdir(component, { recursive: true });
					await cp(FIXTURE, component, { recursive: true });
					await startHarper(ctx, { config: PREVIOUS_CONFIG, env: ENV, harperBinPath: previousMinor.binPath });
					await checkEncoder(ctx, false);
					await killHarper(ctx);
					await startHarper(ctx, { config: CURRENT_CONFIG, env: ENV });
				},
				{ timeout: SUITE_TIMEOUT_MS }
			);

			after(async () => {
				await teardownHarper(ctx);
			});

			test('upgrade preserves every old value and type with random-access fields enabled', async () => {
				await checkEncoder(ctx, true);
				await checkTable(ctx, 'FidelityCheck', MANIFEST);
				await checkTable(ctx, 'WidthShapes', OLD_RECORDS);
			});

			test('measured-copy controls reject only the corrupted string or numeric type', async () => {
				const measured = await checkTable(ctx, 'FidelityCheck', MANIFEST);
				for (const id of ['m-str-unicode', 'm-int64-long']) {
					const expected = MANIFEST.find((row) => row.id === id)!;
					const copy = structuredClone(measured.get(id)!);
					assertRecord(copy, expected, 'FidelityCheck');
					copy.value = typeof copy.value === 'string' ? copy.value.replace('é', 'e') : String(copy.value);
					assert.throws(() => assertRecord(copy, expected, 'FidelityCheck'), {
						name: 'AssertionError',
						message: `FidelityCheck/${id}.value: value/type mismatch`,
					});
					assertRecord(measured.get(id)!, expected, 'FidelityCheck');
				}
			});

			test('1000 same-shape and 500 new-shape writes preserve all 3000 old records', async () => {
				await upsert(ctx, 'WidthShapes', SAME_RECORDS);
				await upsert(ctx, 'WidthShapes', NEW_RECORDS);
				await checkTable(ctx, 'FidelityCheck', MANIFEST);
				await checkTable(ctx, 'WidthShapes', ALL_RECORDS);
			});

			test('cold restart preserves all 24 manifest and 4500 mixed-generation records', async () => {
				await killHarper(ctx);
				await startHarper(ctx, { config: CURRENT_CONFIG, env: ENV });
				await checkEncoder(ctx, true);
				await checkTable(ctx, 'FidelityCheck', MANIFEST);
				await checkTable(ctx, 'WidthShapes', ALL_RECORDS);
			});
		}
	);
}
