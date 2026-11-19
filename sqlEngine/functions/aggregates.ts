/**
 * Aggregate function registrations for the new SQL engine.
 *
 * Standard aggregates: COUNT, SUM, AVG, MIN, MAX.
 * Custom aggregates (ported from alaSQLExtension.js): MEAN, PROD, MEDIAN, MODE, MAD.
 *   MEAN is an alias for AVG.
 *   PROD, MEDIAN, MODE, MAD buffer all values (same as mathjs-backed originals).
 *
 * DISTINCT_ARRAY scalar is also registered here since it shares the extensions file.
 * SEARCH_JSON is intentionally omitted in phase 2 (depends on AlaSQL context).
 */

import { functionRegistry } from './registry.ts';

let registered = false;

export function registerAggregateFunctions(): void {
	if (registered) return;
	registered = true;

	// -------------------------------------------------------------------------
	// COUNT
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'count',
		aliases: ['COUNT'],
		kind: 'aggregate',
		returnType: 'int',
		impl: {
			factory: () => {
				let n = 0;
				return {
					step: (v: unknown) => {
						if (v != null) n++;
					},
					finalize: () => n,
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// SUM
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'sum',
		aliases: ['SUM'],
		kind: 'aggregate',
		returnType: 'number',
		impl: {
			factory: () => {
				let total: number | null = null;
				return {
					step: (v: unknown) => {
						if (v == null) return;
						const n = Number(v);
						if (Number.isNaN(n)) return;
						total = (total ?? 0) + n;
					},
					finalize: () => total,
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// AVG / MEAN
	// -------------------------------------------------------------------------
	const avgFactory = () => {
		let sum = 0;
		let count = 0;
		return {
			step: (v: unknown) => {
				if (v == null) return;
				const n = Number(v);
				if (Number.isNaN(n)) return;
				sum += n;
				count++;
			},
			finalize: () => (count === 0 ? null : sum / count),
		};
	};
	functionRegistry.register({
		name: 'avg',
		aliases: ['AVG', 'mean', 'MEAN'],
		kind: 'aggregate',
		returnType: 'number',
		impl: { factory: avgFactory },
	});

	// -------------------------------------------------------------------------
	// MIN
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'min',
		aliases: ['MIN'],
		kind: 'aggregate',
		returnType: 'unknown',
		impl: {
			factory: () => {
				let minVal: unknown = null;
				return {
					step: (v: unknown) => {
						if (v == null) return;
						if (minVal === null || compareValues(v, minVal) < 0) minVal = v;
					},
					finalize: () => minVal,
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// MAX
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'max',
		aliases: ['MAX'],
		kind: 'aggregate',
		returnType: 'unknown',
		impl: {
			factory: () => {
				let maxVal: unknown = null;
				return {
					step: (v: unknown) => {
						if (v == null) return;
						if (maxVal === null || compareValues(v, maxVal) > 0) maxVal = v;
					},
					finalize: () => maxVal,
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// PROD
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'prod',
		aliases: ['PROD'],
		kind: 'aggregate',
		returnType: 'number',
		impl: {
			factory: () => {
				let product: number | null = null;
				return {
					step: (v: unknown) => {
						if (v == null) return;
						const n = Number(v);
						if (Number.isNaN(n)) return;
						product = (product ?? 1) * n;
					},
					finalize: () => product,
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// MEDIAN — buffers all values, O(n log n) finalize
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'median',
		aliases: ['MEDIAN'],
		kind: 'aggregate',
		returnType: 'number',
		impl: {
			factory: () => {
				const vals: number[] = [];
				return {
					step: (v: unknown) => {
						if (v == null) return;
						const n = Number(v);
						if (!Number.isNaN(n)) vals.push(n);
					},
					finalize: () => {
						if (vals.length === 0) return null;
						const s = [...vals].sort((a, b) => a - b);
						const m = Math.floor(s.length / 2);
						return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
					},
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// MODE — returns the most frequent value (first occurrence wins on tie)
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'mode',
		aliases: ['MODE'],
		kind: 'aggregate',
		returnType: 'unknown',
		impl: {
			factory: () => {
				const counts = new Map<string, { val: unknown; count: number }>();
				return {
					step: (v: unknown) => {
						if (v == null) return;
						const key = JSON.stringify(v);
						const entry = counts.get(key);
						if (entry) entry.count++;
						else counts.set(key, { val: v, count: 1 });
					},
					finalize: () => {
						if (counts.size === 0) return null;
						let best: { val: unknown; count: number } | null = null;
						for (const entry of counts.values()) {
							if (!best || entry.count > best.count) best = entry;
						}
						return best!.val;
					},
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// MAD (median absolute deviation)
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'mad',
		aliases: ['MAD'],
		kind: 'aggregate',
		returnType: 'number',
		impl: {
			factory: () => {
				const vals: number[] = [];
				return {
					step: (v: unknown) => {
						if (v == null) return;
						const n = Number(v);
						if (!Number.isNaN(n)) vals.push(n);
					},
					finalize: () => {
						if (vals.length === 0) return null;
						const sorted = [...vals].sort((a, b) => a - b);
						const m = Math.floor(sorted.length / 2);
						const med = sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
						const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
						const m2 = Math.floor(devs.length / 2);
						return devs.length % 2 === 0 ? (devs[m2 - 1] + devs[m2]) / 2 : devs[m2];
					},
				};
			},
		},
	});

	// -------------------------------------------------------------------------
	// DISTINCT_ARRAY scalar (deduplicates an array-valued column)
	// -------------------------------------------------------------------------
	functionRegistry.register({
		name: 'distinct_array',
		aliases: ['DISTINCT_ARRAY'],
		kind: 'scalar',
		returnType: 'unknown',
		impl: (args: unknown[]) => {
			const arr = args[0];
			if (!Array.isArray(arr)) return arr;
			const seen = new Set<string>();
			return arr.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		},
	});
}

function compareValues(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	const an = Number(a);
	const bn = Number(b);
	if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
	const as = String(a);
	const bs = String(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}
