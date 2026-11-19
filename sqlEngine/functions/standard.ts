/**
 * Registers the standard scalar functions used by the new SQL engine.
 *
 * Date/geo extensions and the AlaSQL-extension aggregates live in
 * functions/date.ts, functions/geo.ts, and functions/extensions.ts. This file
 * covers the small built-in set: UPPER, LOWER, LENGTH, COALESCE, NULLIF,
 * TRIM, ABS, ROUND.
 */

import { functionRegistry } from './registry.ts';

let registered = false;

export function registerStandardFunctions(): void {
	if (registered) return;
	registered = true;

	functionRegistry.register({
		name: 'upper',
		aliases: ['UPPER'],
		kind: 'scalar',
		returnType: 'string',
		impl: (args: unknown[]) => (args[0] == null ? null : String(args[0]).toUpperCase()),
	});
	functionRegistry.register({
		name: 'lower',
		aliases: ['LOWER'],
		kind: 'scalar',
		returnType: 'string',
		impl: (args: unknown[]) => (args[0] == null ? null : String(args[0]).toLowerCase()),
	});
	functionRegistry.register({
		name: 'length',
		aliases: ['LENGTH', 'LEN'],
		kind: 'scalar',
		returnType: 'int',
		impl: (args: unknown[]) => (args[0] == null ? null : String(args[0]).length),
	});
	functionRegistry.register({
		name: 'trim',
		aliases: ['TRIM'],
		kind: 'scalar',
		returnType: 'string',
		impl: (args: unknown[]) => (args[0] == null ? null : String(args[0]).trim()),
	});
	functionRegistry.register({
		name: 'abs',
		aliases: ['ABS'],
		kind: 'scalar',
		returnType: 'number',
		impl: (args: unknown[]) => (args[0] == null ? null : Math.abs(Number(args[0]))),
	});
	functionRegistry.register({
		name: 'round',
		aliases: ['ROUND'],
		kind: 'scalar',
		returnType: 'number',
		impl: (args: unknown[]) => {
			if (args[0] == null) return null;
			const digits = args[1] == null ? 0 : Number(args[1]);
			const factor = 10 ** digits;
			return Math.round(Number(args[0]) * factor) / factor;
		},
	});
	functionRegistry.register({
		name: 'coalesce',
		aliases: ['COALESCE', 'IFNULL'],
		kind: 'scalar',
		returnType: 'unknown',
		impl: (args: unknown[]) => {
			for (const a of args) if (a != null) return a;
			return null;
		},
	});
	functionRegistry.register({
		name: 'nullif',
		aliases: ['NULLIF'],
		kind: 'scalar',
		returnType: 'unknown',
		impl: (args: unknown[]) => (args[0] === args[1] ? null : args[0]),
	});
}
