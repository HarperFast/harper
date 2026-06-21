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
	const assignments = bound.assignments.map((a) => ({ column: a.column, eval: compileExpr(a.expr, false).eval }));

	// Plan the selector before opening the transaction (clean fallback on reject).
	// Fetch the full matched rows so relative assignments (e.g. age = age + 1) can
	// read existing values.
	const selector = buildSelectorPlan(bound.boundTable, bound.where, [{ expr: { kind: 'star' } }]);

	const transaction = getTransactionRunner();
	const context: WriteContext = { user: ctx.user };

	return transaction(context, async () => {
		// Auto-create + validate any new columns the SET clause introduces
		// (legacy parity + attribute-name validation), before any row write.
		await ensureAttributes(
			table,
			assignments.map((a) => a.column)
		);
		const rows = await runSelect(selector, ctx);
		const update_hashes: unknown[] = [];
		const skipped_hashes: unknown[] = [];
		for (const row of rows) {
			const id = row[pk];
			if (id == null) {
				skipped_hashes.push(id);
				continue;
			}
			const patch: Row = {};
			for (const a of assignments) patch[a.column] = a.eval(row);
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

	return transaction(context, async () => {
		const rows = await runSelect(selector, ctx);
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
