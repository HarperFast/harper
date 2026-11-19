/**
 * Function registry.
 *
 * Single source of truth for SQL functions in the new engine: standard library
 * (UPPER, LENGTH, COALESCE, ...), date/geo extensions reused from the
 * existing utility/functions/ tree, and aggregates (COUNT/SUM/AVG/MIN/MAX
 * plus the AlaSQL-extension aggregates MAD/MEAN/MODE/PROD/MEDIAN).
 *
 * Phase 0: registry shape and singleton only. Function bodies are wired in
 * standard.ts/date.ts/geo.ts/extensions.ts during phases 1–2.
 */

import type { SqlType } from '../types.ts';

export type ScalarFn = (args: unknown[]) => unknown;

export interface Accumulator {
	step(value: unknown): void;
	finalize(): unknown;
}

export interface AggFn {
	factory(): Accumulator;
}

export interface FunctionDescriptor {
	name: string;
	aliases: string[];
	kind: 'scalar' | 'aggregate';
	returnType: SqlType;
	impl: ScalarFn | AggFn;
}

class FunctionRegistry {
	private byName = new Map<string, FunctionDescriptor>();

	register(desc: FunctionDescriptor): void {
		const names = [desc.name, ...desc.aliases].map((n) => n.toLowerCase());
		for (const n of names) this.byName.set(n, desc);
	}

	lookup(name: string): FunctionDescriptor | undefined {
		return this.byName.get(name.toLowerCase());
	}

	has(name: string): boolean {
		return this.byName.has(name.toLowerCase());
	}

	all(): FunctionDescriptor[] {
		return [...new Set(this.byName.values())];
	}
}

export const functionRegistry = new FunctionRegistry();
