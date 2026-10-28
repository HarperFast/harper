/**
 * Unit tests for target/generator CPU placement. Run with:
 *   node --test benchmarks/ycsb-vs-pg/
 */
import { test } from 'node:test';
import { deepStrictEqual, throws } from 'node:assert';
import { chooseCpuSets, assertDisjointCores, parseCpuList, type CpuTopology } from './resources.mts';
import { targetOrder } from './run-compare.mts';

/** i7-12700H shape: 6 SMT P-cores (cpu0-11, sibling pairs), 8 E-cores (cpu12-19). */
const HYBRID: CpuTopology[] = [
	...Array.from({ length: 12 }, (_, cpu) => ({
		cpu,
		siblings: [cpu - (cpu % 2), cpu - (cpu % 2) + 1],
		maxKHz: 2_300_000,
	})),
	...Array.from({ length: 8 }, (_, i) => ({ cpu: 12 + i, siblings: [12 + i], maxKHz: 1_700_000 })),
];

test('chooses one logical CPU per fastest physical core and leaves their siblings idle', () => {
	const { server, driver } = chooseCpuSets(HYBRID, 4);
	deepStrictEqual(server, [0, 2, 4, 6]);
	deepStrictEqual(driver, [8, 9, 10, 11, ...parseCpuList('12-19')]);
	assertDisjointCores(HYBRID, server, driver);
});

test('refuses a target set that spills into a slower core class', () => {
	throws(() => chooseCpuSets(HYBRID, 7), /fastest class/);
	throws(() => chooseCpuSets(HYBRID, 0), /positive integer/);
});

test('rejects explicit sets that share a physical core or name an unknown CPU', () => {
	throws(() => assertDisjointCores(HYBRID, [0, 2], [1, 12]), /shares a physical core/);
	throws(() => assertDisjointCores(HYBRID, [0, 2], [40]), /not online/);
});

test('alternates target order per rep', () => {
	deepStrictEqual(targetOrder(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
	deepStrictEqual(targetOrder(['a', 'b', 'c'], 1), ['c', 'b', 'a']);
	deepStrictEqual(targetOrder(['a', 'b', 'c'], 2), ['a', 'b', 'c']);
});

test('parses CPU lists strictly, sorted and deduplicated', () => {
	deepStrictEqual(parseCpuList('6,0-2,2'), [0, 1, 2, 6]);
	for (const bad of ['2,', '-2', '4-2', 'a']) throws(() => parseCpuList(bad), /bad CPU list/);
});
