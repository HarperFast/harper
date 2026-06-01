'use strict';
/**
 * Tiny registry that breaks the common_utils ↔ databases circular dependency.
 *
 * databases.ts and its transitive dependencies (Table.ts, auditStore.ts, etc.)
 * import common_utils.ts. common_utils.ts previously used lazy `require()` calls
 * to avoid the cycle; in ESM (Node 24 type-strip) `require` is unavailable.
 *
 * This module has no dependencies of its own.  databases.ts calls
 * `setDatabasesGetter` once after it initialises, and common_utils.ts calls
 * `getDatabases()` lazily at runtime — after full startup the getter is always set.
 */

let _getter: (() => any) | undefined;

export function setDatabasesGetter(fn: () => any): void {
	_getter = fn;
}

export function getDatabases(): any {
	return _getter?.() ?? {};
}
