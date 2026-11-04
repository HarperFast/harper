/**
 * The dependent-read work both stacks share (app/dependentReads.mjs), against the records the
 * generator writes (workload.mts buildRecord).
 */
import { test } from 'node:test';
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { buildRecord, formatKey, linkTarget, ownerOf } from './workload.mts';
import { chainRecords, inspectRecord, parseHops, parseLink, type StoredRecord } from './app/dependentReads.mjs';

const KEYS = 1000;
const WIDTH = 10;
const shape = { fieldCount: 3, fieldLength: 100 };
const recordAt = (index: number): { id: string } & Record<string, string> => ({
	id: formatKey(index, WIDTH),
	...buildRecord(shape, { index, keyCount: KEYS, keyWidth: WIDTH }),
});
const status500 = { statusCode: 500 };

test('parseLink reads the link buildRecord writes and refuses a record without one', () => {
	deepStrictEqual(parseLink(recordAt(7)), { next: formatKey(linkTarget(7, KEYS), WIDTH), owner: ownerOf(7) });
	for (const field0 of ['no link at all', ':owner01:x', 'user0000000001::x', 'user0000000001:owner01', 42, undefined]) {
		throws(() => parseLink({ id: 'bad', field0 }), status500, `field0 ${JSON.stringify(field0)}`);
	}
});

test('inspectRecord projects for the owner, refuses anyone else, and fails on a record without a link', () => {
	const record = recordAt(5);
	deepStrictEqual(inspectRecord(record, ownerOf(5)), {
		status: 200,
		body: { id: record.id, owner: ownerOf(5), field1: record.field1, field2: record.field2 },
	});
	strictEqual(inspectRecord(record, ownerOf(6)).status, 403);
	strictEqual(inspectRecord(record, undefined).status, 403);
	throws(() => inspectRecord({ id: 'bad', field0: 'x', field1: '', field2: '' }, ownerOf(0)), status500);
});

test('parseHops accepts only integers from 0 to 8', () => {
	strictEqual(parseHops('0'), 0);
	strictEqual(parseHops('4'), 4);
	strictEqual(parseHops('8'), 8);
	for (const value of ['9', '-1', '1.5', '04', 'x', '', null, undefined])
		strictEqual(parseHops(value), undefined, String(value));
});

test('chainRecords reads hops + 1 records, each only after the one before resolves, following stored links', async () => {
	for (const hops of [1, 2, 4]) {
		const fetched: string[] = [];
		let pending = 0;
		const result = await chainRecords(
			async (id: string) => {
				strictEqual(pending, 0, 'a read started before the previous one resolved');
				pending++;
				fetched.push(id);
				await new Promise((resolve) => setTimeout(resolve, 1));
				pending--;
				return recordAt(Number(id.slice(4)));
			},
			formatKey(3, WIDTH),
			hops
		);
		strictEqual(result.status, 200);
		strictEqual(fetched.length, hops + 1);
		let index = 3;
		for (let step = 0; step <= hops; step++) {
			strictEqual(fetched[step], formatKey(index, WIDTH));
			const record = result.body.records[step];
			strictEqual(record.id, formatKey(index, WIDTH));
			strictEqual(record.owner, ownerOf(index));
			index = linkTarget(index, KEYS);
			strictEqual(record.next, formatKey(index, WIDTH));
		}
	}
});

test('chainRecords keeps reading through a cycle and stops at a missing or unlinked record', async () => {
	const cycle: Record<string, StoredRecord> = {
		a: { id: 'a', field0: 'b:owner00:', field1: '', field2: '' },
		b: { id: 'b', field0: 'a:owner01:', field1: '', field2: '' },
	};
	let reads = 0;
	const fromCycle = async (id: string) => (reads++, cycle[id]);
	const looped = await chainRecords(fromCycle, 'a', 4);
	deepStrictEqual(
		looped.body.records.map((r: { id: string }) => r.id),
		['a', 'b', 'a', 'b', 'a']
	);
	strictEqual(reads, 5);

	reads = 0;
	const missing = await chainRecords(async (id: string) => (reads++, id === 'a' ? { ...cycle.a } : undefined), 'a', 4);
	strictEqual(missing.status, 404);
	strictEqual(reads, 2);

	await rejects(
		chainRecords(async (id: string) => (id === 'a' ? cycle.a : { id, field0: 'unlinked' }), 'a', 2),
		status500
	);
});
