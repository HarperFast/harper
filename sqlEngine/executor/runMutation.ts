/**
 * Phase 4 mutation executors: INSERT / UPDATE / DELETE.
 *
 * Writes go through the Resource API exactly as production code does: the
 * `databases`-resolved entry is the Table class, whose static
 * `create`/`put`/`patch`/`delete`/`get` methods each call `transaction(context,
 * …)` internally and *join* an already-open transaction on the context
 * (resources/Resource.ts). So the whole mutation runs inside a single
 * `transaction(context, …)`; every per-row write joins it and the batch commits
 * (or aborts) atomically.
 *
 * UPDATE/DELETE find their target rows by running the ordinary SELECT pipeline
 * (a synthetic `SELECT … FROM target WHERE …`) inside the same transaction, so
 * the read sees a consistent snapshot with the writes.
 *
 * Response shapes match the legacy SQL path (dataLayer/insert.ts,
 * dataLayer/delete.ts) so callers see no difference:
 *   INSERT → { message: "inserted N of M records", inserted_hashes, skipped_hashes }
 *   UPDATE → { message: "updated N of M records",  update_hashes,  skipped_hashes }
 *   DELETE → { message: "N of M records successfully deleted", deleted_hashes, skipped_hashes }
 */

import type { BoundInsert, BoundUpdate, BoundDelete, BoundTable } from '../binder/bind.ts';
import { bindSelect } from '../binder/bind.ts';
import type { ExprNode, SelectNode } from '../parser/ast.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import { buildLogicalPlan } from '../logical/build.ts';
import { optimize } from '../optimizer/optimize.ts';
import { compileToPhysical } from '../physical/plan.ts';
import type { PhysicalOp } from '../physical/op.ts';
import { runSelect } from './runSelect.ts';
import { compileExpr } from '../expressions/compile.ts';
import { EngineRuntimeError } from '../errors.ts';
import { Addition } from '../../resources/tracked.ts';

/**
 * If a SET assignment is a self-referential increment/decrement by a numeric
 * literal — `col = col + N`, `col = N + col`, or `col = col - N` — return the
 * signed delta. Such an assignment MUST be applied as an atomic CRDT `Addition`
 * (the same primitive REST/ops `addTo` uses), not as a read-compute-write of an
 * absolute value: two concurrent `SET qty = qty + 1` statements that both read
 * the same pre-value would otherwise clobber each other and silently lose an
 * increment (F-146). Returns undefined for any other shape (including
 * `col = col + col` or `col = otherCol + N`), which stays on the absolute path.
 */
function selfIncrementDelta(column: string, expr: ExprNode): number | bigint | undefined {
	if (expr.kind !== 'binop' || (expr.op !== '+' && expr.op !== '-')) return undefined;
	const isThisColumn = (n: ExprNode): boolean => n.kind === 'column' && n.name === column && n.table == null;
	const numericLiteral = (n: ExprNode): number | bigint | undefined =>
		n.kind === 'literal' && (typeof n.value === 'number' || typeof n.value === 'bigint') ? n.value : undefined;
	if (expr.op === '+') {
		// col + N  or  N + col (addition commutes)
		if (isThisColumn(expr.left)) return numericLiteral(expr.right);
		if (isThisColumn(expr.right)) return numericLiteral(expr.left);
		return undefined;
	}
	// col - N only (N - col is not an accumulator)
	if (!isThisColumn(expr.left)) return undefined;
	const n = numericLiteral(expr.right);
	if (n === undefined) return undefined;
	return -n;
}

/**
 * Collects every column an assignment expression reads, so the UPDATE selector
 * can project exactly what's needed instead of the whole row (see call site in
 * runUpdate for why over-fetching matters here). Assignments are compiled via
 * compileExpr before this runs, which already rejects `cast`/`aggCall`/`subquery`
 * nodes, so those are unreachable here and need no case.
 */
function collectReferencedColumns(expr: ExprNode, out: Set<string>): void {
	switch (expr.kind) {
		case 'column':
			out.add(expr.name);
			return;
		case 'literal':
		case 'star':
			return;
		case 'binop':
			collectReferencedColumns(expr.left, out);
			collectReferencedColumns(expr.right, out);
			return;
		case 'logical':
			for (const a of expr.args) collectReferencedColumns(a, out);
			return;
		case 'in':
			collectReferencedColumns(expr.expr, out);
			for (const e of expr.list as ExprNode[]) collectReferencedColumns(e, out);
			return;
		case 'between':
			collectReferencedColumns(expr.expr, out);
			collectReferencedColumns(expr.low, out);
			collectReferencedColumns(expr.high, out);
			return;
		case 'like':
			collectReferencedColumns(expr.expr, out);
			collectReferencedColumns(expr.pattern, out);
			if (expr.escape) collectReferencedColumns(expr.escape, out);
			return;
		case 'isNull':
			collectReferencedColumns(expr.expr, out);
			return;
		case 'case':
			for (const c of expr.cases) {
				collectReferencedColumns(c.when, out);
				collectReferencedColumns(c.then, out);
			}
			if (expr.else) collectReferencedColumns(expr.else, out);
			return;
		case 'funcCall':
			for (const a of expr.args) collectReferencedColumns(a, out);
			return;
	}
}

/** A Table-class shape: the static Resource methods the write path needs. */
interface WritableTable {
	primaryKey?: string;
	/** false/undefined for a dynamic-schema table whose columns evolve on write. */
	schemaDefined?: boolean;
	attributes?: Array<{ name: string }>;
	getNewId?: () => unknown;
	get(id: unknown, context: unknown): unknown;
	put(record: unknown, context: unknown): unknown;
	patch(id: unknown, update: unknown, context: unknown): unknown;
	delete(id: unknown, context: unknown): unknown;
	addAttributes?(attributes: Array<{ name: string; indexed: boolean }>): Promise<unknown>;
}

/**
 * Mirror the legacy ResourceBridge.upsertRecords schema-evolution path: on a
 * dynamic-schema (non-`schemaDefined`) table, any referenced column that isn't
 * yet an attribute is added via `Table.addAttributes` (indexed, matching legacy).
 *
 * Two reasons this must run, not just be skipped:
 *  - Parity of side effect: legacy INSERT/UPDATE auto-creates+indexes new
 *    columns, so the new engine must too or later queries on that column diverge.
 *  - Parity of validation: `addAttributes` enforces the attribute-name rules and
 *    throws `ClientError('Attribute names cannot include backticks or forward
 *    slashes')` for an invalid name — the same 400 the legacy path produces. This
 *    is a deterministic client error (not `EngineUnsupportedError`), so `auto`
 *    surfaces it identically rather than falling back.
 *
 * Called inside the write transaction (as legacy does), before any row write, so
 * an invalid-name rejection aborts the txn with nothing persisted.
 */
async function ensureAttributes(table: WritableTable, columns: readonly string[]): Promise<void> {
	if (table.schemaDefined || !table.addAttributes) return;
	const existing = table.attributes ?? [];
	const seen = new Set<string>();
	const newAttributes: Array<{ name: string; indexed: boolean }> = [];
	for (const name of columns) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (!existing.find((a) => a.name === name)) newAttributes.push({ name, indexed: true });
	}
	if (newAttributes.length > 0) await table.addAttributes(newAttributes);
}

/** A minimal context carrying the user; `transaction()` attaches `.transaction`. */
interface WriteContext {
	user?: unknown;
	transaction?: unknown;
}

type TransactionRunner = <T>(context: WriteContext, callback: () => Promise<T>) => Promise<T>;

let _transactionRunner: TransactionRunner | null = null;

/** Test hook: override the transaction runner. Pass null to restore the default. */
export function _setTransactionRunner(runner: TransactionRunner | null): void {
	_transactionRunner = runner;
}

function getTransactionRunner(): TransactionRunner {
	if (_transactionRunner) return _transactionRunner;
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const mod = require('../../resources/transaction.js');
	return mod.transaction as TransactionRunner;
}

function tableOf(bound: { boundTable: BoundTable }): WritableTable {
	return bound.boundTable.resource as WritableTable;
}

function primaryKeyOf(boundTable: BoundTable): string {
	if (!boundTable.primaryKey) {
		throw new EngineRuntimeError(`table "${boundTable.database}.${boundTable.table}" has no primary key`);
	}
	return boundTable.primaryKey;
}

/**
 * Builds the physical plan for `SELECT <projection> FROM <target> WHERE <where>`.
 * Kept separate from execution so it runs BEFORE the write transaction is opened:
 * if the selector can't be planned (e.g. a non-indexable WHERE), the
 * EngineUnsupportedError is thrown before any transaction/side effect, so 'auto'
 * mode falls back to legacy cleanly rather than aborting a half-open txn.
 */
function buildSelectorPlan(
	boundTable: BoundTable,
	where: ExprNode | undefined,
	projection: SelectNode['projections']
): PhysicalOp {
	const select: SelectNode = {
		kind: 'select',
		distinct: false,
		projections: projection,
		from: { database: boundTable.database, table: boundTable.table, alias: boundTable.alias },
		joins: [],
		where,
	};
	return compileToPhysical(optimize(buildLogicalPlan(bindSelect(select))));
}

export async function runInsert(bound: BoundInsert, ctx: SqlEngineContext): Promise<unknown> {
	const table = tableOf(bound);
	const pk = primaryKeyOf(bound.boundTable);

	// Evaluate every VALUES row up front (literals / constant expressions — no
	// per-table row context). The normalizer only produces the VALUES (array)
	// form; INSERT … SELECT is rejected earlier.
	if (!Array.isArray(bound.values)) {
		throw new EngineRuntimeError('INSERT … SELECT is not supported');
	}
	const records: Row[] = bound.values.map((row) => {
		const record: Row = {};
		for (let i = 0; i < bound.columns.length; i++) {
			record[bound.columns[i]] = compileExpr(row[i], false).eval({});
		}
		return record;
	});

	const transaction = getTransactionRunner();
	const context: WriteContext = { user: ctx.user };

	return transaction(context, async () => {
		// Auto-create + validate any new columns first (legacy parity, and the
		// source of the attribute-name validation), before any row write.
		await ensureAttributes(table, bound.columns);
		const inserted_hashes: unknown[] = [];
		const skipped_hashes: unknown[] = [];
		for (const record of records) {
			let id = record[pk];
			if (id == null) {
				// No primary key supplied: generate one (UUID by default).
				id = table.getNewId ? table.getNewId() : undefined;
				if (id == null) throw new EngineRuntimeError('could not generate a primary key for INSERT');
				record[pk] = id;
			} else {
				// INSERT (not upsert) skips rows whose key already exists, matching
				// the legacy createRecords semantics (reported in skipped_hashes).
				const existing = await table.get(id, context);
				if (existing != null) {
					skipped_hashes.push(id);
					continue;
				}
			}
			await table.put(record, context);
			inserted_hashes.push(id);
		}
		const total = inserted_hashes.length + skipped_hashes.length;
		return {
			message: `inserted ${inserted_hashes.length} of ${total} records`,
			inserted_hashes,
			skipped_hashes,
		};
	});
}

export async function runUpdate(bound: BoundUpdate, ctx: SqlEngineContext): Promise<unknown> {
	const table = tableOf(bound);
	const pk = primaryKeyOf(bound.boundTable);
	// A `col = col ± N` assignment is applied as an atomic Addition delta (see
	// selfIncrementDelta); every other assignment is evaluated against the matched
	// row and written as an absolute value.
	const assignments = bound.assignments.map((a) => {
		const delta = selfIncrementDelta(a.column, a.expr);
		return delta === undefined
			? { column: a.column, eval: compileExpr(a.expr, false).eval }
			: { column: a.column, delta };
	});

	// Plan the selector before opening the transaction (clean fallback on reject).
	// Project only the primary key plus whatever columns a row-dependent assignment
	// actually reads (e.g. `total = price * qty`) — not the whole row. A `col = col
	// ± N` delta reads nothing (it's applied as an Addition, never evaluated against
	// the row), and most SET clauses are plain literals, so the common case needs
	// only the primary key — the same minimal read legacy's SQL UPDATE and this
	// module's own runDelete already use.
	const neededColumns = new Set<string>([pk]);
	bound.assignments.forEach((a, i) => {
		if (!('delta' in assignments[i])) collectReferencedColumns(a.expr, neededColumns);
	});
	const projection: SelectNode['projections'] = [...neededColumns].map((name) => ({
		expr: { kind: 'column', name },
	}));
	const selector = buildSelectorPlan(bound.boundTable, bound.where, projection);

	const transaction = getTransactionRunner();
	const context: WriteContext = { user: ctx.user };
	// The row-finder above is a SELECT, and a plain SELECT is right to hide a row
	// whose TTL has passed but hasn't been swept yet. An UPDATE isn't a SELECT
	// though: it's about to overwrite that row's TTL, and every other write surface
	// (REST PUT/PATCH, ops update) still finds and resets a not-yet-swept-but-expired
	// row because they load it by id directly, bypassing the freshness check a read
	// applies. Without includeExpiredRows, the row-finder would drop such a row from
	// its result, so the UPDATE silently touches nothing and the TTL never resets
	// (QA-269).
	const selectCtx: SqlEngineContext = { ...ctx, includeExpiredRows: true };

	return transaction(context, async () => {
		// Auto-create + validate any new columns the SET clause introduces
		// (legacy parity + attribute-name validation), before any row write.
		await ensureAttributes(
			table,
			assignments.map((a) => a.column)
		);
		const rows = await runSelect(selector, selectCtx);
		const update_hashes: unknown[] = [];
		const skipped_hashes: unknown[] = [];
		for (const row of rows) {
			const id = row[pk];
			if (id == null) {
				skipped_hashes.push(id);
				continue;
			}
			const patch: Row = {};
			for (const a of assignments) {
				patch[a.column] = 'delta' in a ? new Addition(a.delta) : a.eval(row);
			}
			await table.patch(id, patch, context);
			update_hashes.push(id);
		}
		const total = update_hashes.length + skipped_hashes.length;
		return {
			message: `updated ${update_hashes.length} of ${total} records`,
			update_hashes,
			skipped_hashes,
		};
	});
}

export async function runDelete(bound: BoundDelete, ctx: SqlEngineContext): Promise<unknown> {
	const table = tableOf(bound);
	const pk = primaryKeyOf(bound.boundTable);

	// Plan the selector before opening the transaction (clean fallback on reject).
	// Only the primary key is needed to delete.
	const selector = buildSelectorPlan(bound.boundTable, bound.where, [{ expr: { kind: 'column', name: pk } }]);

	const transaction = getTransactionRunner();
	const context: WriteContext = { user: ctx.user };
	// Same reasoning as runUpdate: REST DELETE removes a not-yet-swept-but-expired
	// row immediately because it targets by id directly; the row-finder here should
	// match that rather than silently skipping a row the sweep hasn't caught up to yet.
	const selectCtx: SqlEngineContext = { ...ctx, includeExpiredRows: true };

	return transaction(context, async () => {
		const rows = await runSelect(selector, selectCtx);
		const deleted_hashes: unknown[] = [];
		const skipped_hashes: unknown[] = [];
		for (const row of rows) {
			const id = row[pk];
			if (id == null) {
				skipped_hashes.push(id);
				continue;
			}
			await table.delete(id, context);
			deleted_hashes.push(id);
		}
		const total = deleted_hashes.length + skipped_hashes.length;
		// Legacy SQL DELETE pluralizes "record" by the deleted count
		// (sqlTranslator/deleteTranslator.ts + harperBridge.deleteRecords):
		// "1 of 1 record …" but "0 of 0 records …".
		const noun = deleted_hashes.length === 1 ? 'record' : 'records';
		return {
			message: `${deleted_hashes.length} of ${total} ${noun} successfully deleted`,
			deleted_hashes,
			skipped_hashes,
		};
	});
}
