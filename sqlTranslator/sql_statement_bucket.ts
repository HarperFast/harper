'use strict';
/**
 * This class is meant as a getter object that sits between the alasql (or other module) AST and any module requiring interpreted
 * AST SQL values such as attributes, tables, etc.
 **/

import alasql from 'alasql';
import _harperLogger from '../utility/logging/harper_logger.ts';
const harperLogger = _harperLogger;
import * as hdbUtils from '../utility/common_utils.ts';
import * as terms from '../utility/hdbTerms.ts';
import { findDatabasesWithTable, loadDatabaseRegistry } from '../sqlEngine/binder/defaultDatabase.ts';
import { declaringTables, usingLeftOwner, type ScopeTable } from '../sqlEngine/binder/columnScope.ts';

class sqlStatementBucket {
	ast: any;
	affected_attributes: any;
	table_lookup: any;
	schema_lookup: any;
	table_to_schema_lookup: any;
	unresolved_columns: Set<string>;
	constructor(ast) {
		this.ast = ast;
		// affectedAttributes stores a table and it's attributes as a Map [schema, Map[table, [attributesArray]]].
		this.affected_attributes = new Map();
		this.table_lookup = new Map();
		this.schema_lookup = new Map();
		this.table_to_schema_lookup = new Map();
		this.unresolved_columns = new Set();
		interpretAST(
			this.ast,
			this.affected_attributes,
			this.table_lookup,
			this.schema_lookup,
			this.table_to_schema_lookup,
			this.unresolved_columns
		);
	}

	/**
	 * Returns all attributes stored under a schema/table key set.
	 * @param schemaName - Name of the schema to search under
	 * @param tableName - Name of the table to pull attributes for.
	 * @returns {Array}
	 */
	getAttributesBySchemaTableName(schemaName, tableName) {
		if (!schemaName || !tableName || !this.affected_attributes) {
			return [];
		}
		if (this.affected_attributes.has(schemaName)) {
			if (!this.affected_attributes.get(schemaName).has(tableName)) {
				tableName = this.table_lookup.get(tableName);
				if (!tableName) return [];
			}
			return this.affected_attributes.get(schemaName).get(tableName);
		}
	}

	/**
	 * Returns all tables that were inferred from the AST.
	 * @returns {Array}
	 */
	getAllTables() {
		let tables = [];
		if (!this.affected_attributes) {
			return tables;
		}
		for (const schema of this.affected_attributes.keys()) {
			tables.push(Array.from(this.affected_attributes.get(schema).keys()));
		}
		return tables;
	}

	/**
	 * Get an array of all tables under the passed in schema name.  Will return an empty array with invalid parameters
	 * @param schemaName - name of the schema
	 * @returns {Array}
	 */
	getTablesBySchemaName(schemaName) {
		if (!schemaName || !this.affected_attributes) return [];
		return Array.from(this.affected_attributes.get(schemaName).keys());
	}

	/**
	 * Gets an array of schemas that were inferred from the passed in AST
	 * @returns {Array}
	 */
	getSchemas() {
		if (!this.affected_attributes) {
			return [];
		}
		return Array.from(this.affected_attributes.keys());
	}

	/**
	 * Get the full AST
	 * @returns {*}
	 */
	getAst() {
		return this.ast;
	}

	/**
	 * Tables the statement references that did NOT make it into the affected-attribute map — the
	 * map permission checking iterates. Anything listed here would execute unchecked, so the
	 * caller must fail the statement closed (GHSA-5c29-q62v-jrwf).
	 *
	 * A reference goes unrecorded when it could not be resolved to a single database (bare name
	 * that no database defines, or that several define), when it is a construct we cannot reduce
	 * to a named table (a derived table), or when it is a target the collectors do not model
	 * (a SELECT's INTO). Returning descriptions rather than a boolean keeps the denial loggable.
	 *
	 * An empty result for a statement that names no table is correct and expected — that is a
	 * calc-only select such as `SELECT ABS(-12)`.
	 *
	 * @returns {Array} - human-readable descriptions of the unauthorizable references
	 */
	getUnauthorizedTableRefs() {
		const { named, opaque } = getTableTargets(this.ast);
		const unauthorized = [...opaque];
		for (const ref of named) {
			const databaseid = ref.databaseid;
			if (hdbUtils.isEmptyOrZeroLength(databaseid)) {
				unauthorized.push(ref.tableid);
			} else if (!this.affected_attributes.get(databaseid)?.has(ref.tableid)) {
				unauthorized.push(`${databaseid}.${ref.tableid}`);
			}
		}
		return unauthorized;
	}

	/**
	 * Column references whose table qualifier names no table in scope, or several. They were not
	 * attributed to any table, so the caller must refuse the statement.
	 */
	getUnresolvedColumnRefs(): string[] {
		return [...this.unresolved_columns];
	}

	/**
	 * Expressions that read a whole row instead of naming a column: AlaSQL's `_` (`SELECT VALUE`,
	 * `ROW`, `x._`, `_->attr`) and JavaScript expressions. Attribute permissions cannot apply to them,
	 * and legacy SQL's row container always carries the primary key.
	 */
	getRowAccessors(): string[] {
		const accessors = [];
		for (const node of astNodes(this.ast)) {
			if (node instanceof (alasql as any).yy.Column && node.columnid === '_') accessors.push('_');
			else if (node instanceof (alasql as any).yy.JavaScript) accessors.push('JavaScript expression');
			// A JSON literal's `__proto__` key hides an expression in the prototype, where every walk here
			// (own properties only) misses it but AlaSQL's JSON compiler still evaluates it.
			else if (!isKnownPrototype(Object.getPrototypeOf(node))) accessors.push('JSON literal with __proto__');
		}
		return accessors;
	}

	/**
	 * Attributes an UPDATE or DELETE reads to pick rows (WHERE) or compute values (SET expressions).
	 * They need read permission on top of the write permission the statement already needs. The primary
	 * key is left out: the statement reports the keys of the rows it touched, as NoSQL update and delete do.
	 */
	getWriteStatementReads(): { schema: string; table: string; attributes: string[] } | undefined {
		const ast = this.ast;
		const isUpdate = ast instanceof (alasql as any).yy.Update;
		if (!isUpdate && !(ast instanceof (alasql as any).yy.Delete)) return undefined;
		const { databaseid: schema, tableid: table } = ast.table;
		const tables = loadDatabaseRegistry()?.[schema];
		const primaryKey = tables && Object.hasOwn(tables, table) ? (tables[table] as any)?.primaryKey : undefined;
		const attributes = [];
		const trees = [ast.where, ...(isUpdate ? (ast.columns ?? []).map((column) => column?.expression) : [])];
		for (const tree of trees) {
			for (const node of columnNodes(tree)) {
				if (node.columnid !== primaryKey && !attributes.includes(node.columnid)) attributes.push(node.columnid);
			}
		}
		return { schema, table, attributes };
	}

	/**
	 *When a SELECT * is included in the AST for a non-SU, we need to convert the star into the specific attributes the
	 * user has READ permissions
	 *
	 * @param rolePerms - role permission set to update the wildcard to the permitted attributes
	 * @returns {ast} - this function returns the updated AST that can be used for final validation and the additional
	 * steps to complete the request
	 */
	updateAttributeWildcardsForRolePerms(rolePerms) {
		const astWildcards = this.ast.columns.filter((col) => terms.SEARCH_WILDCARDS.includes(col.columnid));

		//If there are no wildcards, we can skip this step
		if (astWildcards.length === 0) {
			return this.ast;
		}

		//This function will need to be updated if/when we start to do cross-schema joins - i.e. function will need
		// to handle multiple schema values instead of just the one below
		const fromDatabaseid = this.ast.from[0].databaseid;
		this.ast.columns = this.ast.columns.filter((col) => !terms.SEARCH_WILDCARDS.includes(col.columnid));

		astWildcards.forEach((val) => {
			let colSchema = this.table_to_schema_lookup.has(val.tableid)
				? this.table_to_schema_lookup.get(val.tableid)
				: fromDatabaseid;
			let colTable = this.table_lookup.has(val.tableid) ? this.table_lookup.get(val.tableid) : this.ast.from[0].tableid;

			//We only want to do this if the table that is being SELECT *'d has READ permissions - if not, we will only
			// want to send the table permissions error response so we can skip this step.
			if (
				rolePerms[colSchema] &&
				rolePerms[colSchema].tables[colTable] &&
				rolePerms[colSchema].tables[colTable][terms.PERMS_CRUD_ENUM.READ]
			) {
				let finalTableAttrs;
				if (rolePerms[colSchema].tables[colTable].attribute_permissions.length > 0) {
					finalTableAttrs = filterReadRestrictedAttrs(rolePerms[colSchema].tables[colTable].attribute_permissions);
				} else {
					//If the user has READ perms for the table but no perms for the attributes in it, we add all the attrs
					// into the AST * affectedAttributes map so that the individual attribute permissions error responses
					// are returned to the user
					finalTableAttrs = global.hdb_schema[colSchema][colTable].attributes.map((attr) => ({
						attribute_name: attr.attribute,
					}));
				}

				//It's important to REMOVE the wildcard as we replace it with the actual attributes that will be selected
				const tableAffectedAttrs = this.affected_attributes
					.get(colSchema)
					.get(colTable)
					.filter((attr) => !terms.SEARCH_WILDCARDS.includes(attr));
				// In a join an unqualified expansion would bind to whichever table declares the name, not
				// necessarily the one whose permissions were just applied.
				const isJoin = this.ast.from.length > 1 || this.ast.joins?.length > 0;
				const qualifier = val.tableid ?? (isJoin ? (this.ast.from[0].as ?? this.ast.from[0].tableid) : undefined);
				finalTableAttrs.forEach(({ attribute_name }) => {
					let newColumn = new (alasql as any).yy.Column({ columnid: attribute_name });
					if (qualifier) {
						newColumn.tableid = qualifier;
					}
					this.ast.columns.push(newColumn);
					if (!tableAffectedAttrs.includes(attribute_name)) {
						tableAffectedAttrs.push(attribute_name);
					}
				});
				this.affected_attributes.get(colSchema).set(colTable, tableAffectedAttrs);
			}
		});

		return this.ast;
	}
}

/**
 * Takes full table attribute permissions array and filters out attributes w/ FALSE READ perms
 *
 * @param attrPerms [] - attribute permissions for a table
 * @returns [] - array of attribute permissions objects w/ READ perms === TRUE
 */

function filterReadRestrictedAttrs(attrPerms: any[]) {
	return attrPerms.filter((perm) => perm[terms.PERMS_CRUD_ENUM.READ]);
}

let astPrototypes: Set<object> | undefined;
function isKnownPrototype(prototype: object | null): boolean {
	astPrototypes ??= new Set(
		Object.values((alasql as any).yy)
			.filter((value) => typeof value === 'function')
			.map((astClass: any) => astClass.prototype)
	);
	return (
		prototype === null ||
		prototype === Object.prototype ||
		prototype === Array.prototype ||
		astPrototypes.has(prototype)
	);
}

/**
 * Every object node under `root`, each once. Iterative and unbounded: an expression nested arbitrarily
 * deep must still be seen, and AlaSQL shares one subquery node between two fields (EXISTS).
 */
function* astNodes(root: any): Generator<any> {
	const seen = new Set();
	const pending = root !== null && typeof root === 'object' ? [root] : [];
	while (pending.length > 0) {
		const node = pending.pop();
		if (seen.has(node)) continue;
		seen.add(node);
		yield node;
		for (const key in node) {
			if (!Object.hasOwn(node, key)) continue;
			const child = node[key];
			if (child !== null && typeof child === 'object') pending.push(child);
		}
	}
}

/**
 * Column references under `root`. Inside a JSON literal only real Column nodes count; its own objects are
 * data. The `*` of a plain COUNT(*) names no attribute.
 */
function* columnNodes(root: any): Generator<any> {
	const notColumns = new Set();
	for (const node of astNodes(root)) {
		if (node instanceof (alasql as any).yy.Json) {
			// Only the literal's own plain objects and arrays: nested AST nodes, a nested JSON literal
			// included, are reached by the outer walk, so each is marked once.
			const pending = [node.value];
			while (pending.length > 0) {
				const value = pending.pop();
				if (value === null || typeof value !== 'object' || notColumns.has(value)) continue;
				if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) continue;
				notColumns.add(value);
				for (const child of Object.values(value)) pending.push(child);
			}
		} else if (node.expression && isRowCountWildcard(node, node.expression)) {
			notColumns.add(node.expression);
		} else if (node.columnid && !notColumns.has(node)) {
			yield node;
		}
	}
}

// FIRST(*), ARRAY(*) and COUNT(DISTINCT *) read the value of an attribute literally named `*`, so they stay collected.
function isRowCountWildcard(parent: any, node: any): boolean {
	return node.columnid === '*' && parent?.aggregatorid === 'COUNT' && parent.expression === node && !parent.distinct;
}

function interpretAST(
	ast: any,
	affectedAttributes: any,
	tableLookup: any,
	schemaLookup: any,
	tableToSchemaLookup: any,
	unresolvedColumns: Set<string>
) {
	qualifyBareTableRefs(ast);
	getRecordAttributesAST(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup, unresolvedColumns);
}

interface TableTargets {
	/** References carrying a table name — the ones the engine binds one table each from. */
	named: any[];
	/**
	 * FROM entries that don't reduce to a named table (a derived table / subquery). We can't say
	 * which tables they reach, so they can't be authorized and must fail the statement closed.
	 */
	opaque: string[];
}

/**
 * AlaSQL fields that carry a nested or compound query: a WHERE subquery (`queries`), an EXISTS
 * subquery (`exists`), a compound-query branch (`union`/`unionall`/`except`/`intersect`), and an
 * INSERT's source SELECT (`select`). The attribute collectors below don't descend into any of
 * them, so a table referenced only from one of these is invisible to permission checking.
 */
const NESTED_QUERY_FIELDS = ['queries', 'exists', 'union', 'unionall', 'except', 'intersect', 'select'];

/**
 * Every table the statement would touch. Mirrors the set of references the engine's binder
 * resolves — FROM entries and JOIN targets for a SELECT, or the single target of a write.
 *
 * Anything the collectors do not model is reported as opaque rather than ignored, so the
 * authorization check refuses it. That covers derived tables, nested and compound queries, a
 * SELECT's INTO target, and PIVOT/UNPIVOT. Opaque is deliberately preferred over recursing into
 * these constructs:
 * a nested reference would still never be recorded in the affected-attribute map, so descending
 * to name it would not make it checkable — only refusable, which is what opaque already does.
 */
function getTableTargets(ast: any): TableTargets {
	const named: any[] = [];
	const opaque: string[] = [];
	if (!ast) return { named, opaque };

	const addRef = (ref: any, description: string) => {
		if (!ref) return;
		if (ref.tableid) named.push(ref);
		else opaque.push(description);
	};

	const addNestedQueries = () => {
		for (const field of NESTED_QUERY_FIELDS) {
			const value = ast[field];
			if (!value) continue;
			if (Array.isArray(value) ? value.length > 0 : true) opaque.push(`nested query in "${field}"`);
		}
	};

	if (ast instanceof (alasql as any).yy.Select) {
		if (Array.isArray(ast.from)) {
			ast.from.forEach((from, index) => addRef(from, `subquery in FROM position ${index + 1}`));
		}
		if (Array.isArray(ast.joins)) {
			ast.joins.forEach((join, index) => {
				if (!join) return;
				const description = `subquery in JOIN position ${index + 1}`;
				// A derived JOIN (`JOIN (SELECT ...) AS s`) carries `join.select` and no `join.table`.
				// It has to be marked opaque explicitly — passing the absent table to addRef would
				// drop it from the inventory entirely.
				if (join.table) addRef(join.table, description);
				else opaque.push(description);
			});
		}
		// Always opaque, never a named ref: SELECT INTO is a write whose permission is not modeled,
		// and treating it as named would let it satisfy the affected-attribute check on an entry the
		// FROM collector created — `SELECT * INTO data.t FROM data.t` would authorize a write on the
		// strength of a read.
		if (ast.into) opaque.push('SELECT INTO target');
		// PIVOT/UNPIVOT expose a column's values as-is, but the attribute collectors don't walk
		// pivot.expr/pivot.columnid — refuse rather than authorize on an attribute list that never
		// saw the pivoted column.
		if (ast.pivot) opaque.push('PIVOT clause');
		if (ast.unpivot) opaque.push('UNPIVOT clause');
		addNestedQueries();
	} else if (ast instanceof (alasql as any).yy.Insert) {
		addRef(ast.into, 'INSERT target');
		addNestedQueries();
	} else if (ast instanceof (alasql as any).yy.Update || ast instanceof (alasql as any).yy.Delete) {
		addRef(ast.table, 'write target');
		addNestedQueries();
	}
	return { named, opaque };
}

/**
 * Resolve schema-unqualified table references in place, using the same default-database rule the
 * engine's binder applies.
 *
 * Without this the authorization layer saw `databaseid === undefined`, recorded no table at all,
 * and authorized the statement against an empty set — while the engine went on to resolve the
 * same bare name to a real database and read or write it (GHSA-5c29-q62v-jrwf). Writing the
 * resolved database back onto the AST means authorization and execution share one resolution
 * rather than performing two that can disagree.
 *
 * A name that resolves to zero or to several databases is deliberately left bare: it stays
 * unrecorded, so the affected-table check below refuses it instead of guessing a database.
 */
function qualifyBareTableRefs(ast: any): void {
	const { named } = getTableTargets(ast);
	const bare = named.filter((ref) => hdbUtils.isEmptyOrZeroLength(ref.databaseid));
	if (bare.length === 0) return;
	// One registry load per statement, not per reference.
	const databases = loadDatabaseRegistry();
	if (!databases) return;
	for (const ref of bare) {
		const matches = findDatabasesWithTable(databases, ref.tableid);
		if (matches.length === 1) {
			ref.databaseid = matches[0];
		}
	}
}

/**
 * Takes an AST definition and adds it to the schema/table affectedAttributes parameter as well as adding table alias'
 * to the tableLookup parameter.
 *
 * @param record - An AST style record
 * @param {Map} affectedAttributes - A map of attributes affected in the call.  Defined as [schema, Map[table, [attributesArray]]].
 * @param {Map} tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function addSchemaTableToMap(
	record: any,
	affectedAttributes: any,
	tableLookup: any,
	schemaLookup?: any,
	tableToSchemaLookup?: any
) {
	if (!record || !record.databaseid) {
		return;
	}
	if (!affectedAttributes.has(record.databaseid)) {
		affectedAttributes.set(record.databaseid, new Map());
	}
	if (!affectedAttributes.get(record.databaseid).has(record.tableid)) {
		affectedAttributes.get(record.databaseid).set(record.tableid, []);
	}
	if (record.as) {
		if (!tableLookup.has(record.as)) {
			tableLookup.set(record.as, record.tableid);
		}
		if (schemaLookup && !schemaLookup.has(record.as)) {
			schemaLookup.set(record.as, record.databaseid);
		}
	}
	if (tableToSchemaLookup) {
		const schemaId = record.databaseid;
		let tableId = record.tableid;
		if (record.as) {
			tableId = record.as;
		}

		tableToSchemaLookup.set(tableId, schemaId);
	}
}

/**
 * Pull the table attributes specified in the AST statement and adds them to the affectedAttributes and tableLookup parameters.
 *
 * @param ast - the syntax tree containing SQL specifications
 * @param {Map} affectedAttributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param {Map} tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getRecordAttributesAST(
	ast: any,
	affectedAttributes: any,
	tableLookup: any,
	schemaLookup: any,
	tableToSchemaLookup: any,
	unresolvedColumns?: Set<string>
) {
	if (!ast) {
		harperLogger.info(`getRecordAttributesAST: invalid SQL syntax tree`);
		return;
	}
	// We can reference any schema/table attributes, so we need to check each possibility
	// affected attributes is a Map of Maps like so [schema, Map[table, [attributesArray]]];
	if (ast instanceof (alasql as any).yy.Insert) {
		getInsertAttributes(ast, affectedAttributes, tableLookup);
	} else if (ast instanceof (alasql as any).yy.Select) {
		getSelectAttributes(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup, unresolvedColumns);
	} else if (ast instanceof (alasql as any).yy.Update) {
		getUpdateAttributes(ast, affectedAttributes, tableLookup, unresolvedColumns);
	} else if (ast instanceof (alasql as any).yy.Delete) {
		getDeleteAttributes(ast, affectedAttributes, tableLookup, unresolvedColumns);
	} else {
		harperLogger.error(`AST in getRecordAttributesAST() is not a valid SQL type.`);
	}
}

interface AttributionTable extends ScopeTable {
	databaseid: string;
	/** False when the registry could not describe the table; attribution then fails closed. */
	attributesKnown: boolean;
}

/**
 * FROM entries then JOIN targets, in the order the engines bind them. A derived JOIN keeps its slot
 * (so later ON/USING indexes line up) but records nothing — getTableTargets() refuses it.
 */
function getAttributionScope(ast: any): AttributionTable[] {
	const entries = [...ast.from, ...(ast.joins ?? []).map((join) => join?.table ?? { as: join?.as })];
	const scope: AttributionTable[] = entries.map((ref) => ({
		databaseid: ref.databaseid,
		table: ref.tableid ?? '',
		effectiveAlias: ref.as ?? ref.tableid ?? '',
		attributes: [],
		attributesKnown: false,
	}));
	if (scope.length < 2) return scope;
	const databases = loadDatabaseRegistry();
	for (const entry of scope) {
		const tables = entry.databaseid && databases?.[entry.databaseid];
		const table: any = tables && Object.hasOwn(tables, entry.table) ? tables[entry.table] : undefined;
		if (Array.isArray(table?.attributes)) {
			entry.attributes = table.attributes;
			entry.attributesKnown = true;
		}
	}
	return scope;
}

/**
 * Attributes every column reference in a SELECT to the table the engines read it from, using the v2
 * binder's rules (sqlEngine/binder/columnScope.ts). See sqlTranslator/DESIGN.md.
 */
function getSelectAttributes(
	ast: any,
	affectedAttributes: any,
	tableLookup: any,
	schemaLookup: any,
	tableToSchemaLookup: any,
	unresolvedColumns: Set<string> = new Set()
) {
	if (!ast) {
		harperLogger.info(`getSelectAttributes: invalid SQL syntax tree`);
		return;
	}
	if (!ast.from || ast.from[0] === undefined) {
		return;
	}
	if (hdbUtils.isEmptyOrZeroLength(ast.from[0].databaseid)) {
		harperLogger.error('No schema specified');
		return;
	}
	ast.from.forEach((from) => {
		addSchemaTableToMap(from, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
	});
	if (ast.joins) {
		ast.joins.forEach((join) => {
			// A derived JOIN has `join.select` and no `join.table`; there is nothing to record for it.
			// getTableTargets() reports it as opaque so the statement is refused with a 403 rather
			// than dying here on `join.table.as` and surfacing as a 500.
			if (!join?.table) return;
			//copying the 'as' to the table rather than on the join allows for a more generic function in addSchemaTableToMap().
			// as it can take a .table as well as a .join record. It's a bit hacky, but I don't think this should cause any problems.
			if (join.as) {
				join.table.as = join.as;
			}
			addSchemaTableToMap(join.table, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
		});
	}

	const scope = getAttributionScope(ast);

	const record = (entry: AttributionTable, columnid: string) => {
		const attributes = affectedAttributes.get(entry.databaseid)?.get(entry.table);
		if (attributes && !attributes.includes(columnid)) attributes.push(columnid);
	};

	const recordColumn = (node: any, clauseScope: AttributionTable[]) => {
		if (node.tableid) {
			// v2 prefers an alias over a base table name; legacy SQL matches either, against every table in
			// the statement. Only a qualifier exactly one table claims means the same table to both.
			const claimants = scope.filter((entry) => entry.effectiveAlias === node.tableid || entry.table === node.tableid);
			if (claimants.length === 1) record(claimants[0], node.columnid);
			else unresolvedColumns.add(`${node.tableid}.${node.columnid}`);
			return;
		}
		// updateAttributeWildcardsForRolePerms() expands a wildcard on the FROM table, qualified by its alias
		// in a join, so that alias must name one table.
		if (terms.SEARCH_WILDCARDS.includes(node.columnid)) {
			const fromName = scope[0].effectiveAlias;
			const claimants = scope.filter((entry) => entry.effectiveAlias === fromName || entry.table === fromName);
			if (claimants.length === 1) record(scope[0], node.columnid);
			else unresolvedColumns.add(`${fromName}.${node.columnid}`);
			return;
		}
		if (clauseScope.length === 1) {
			record(scope[0], node.columnid);
			return;
		}
		const declarers = (tables: AttributionTable[]) =>
			tables.every((entry) => entry.attributesKnown) ? declaringTables(node.columnid, tables) : tables;
		// Legacy SQL can bind an ON column to a table joined after that ON.
		let owners = declarers(clauseScope);
		if (owners.length === 0 && clauseScope.length < scope.length) owners = declarers(scope);
		if (owners.length === 0) record(scope[0], node.columnid);
		for (const owner of owners) record(owner, node.columnid);
	};

	const recordColumns = (tree: any, clauseScope: AttributionTable[]) => {
		for (const node of columnNodes(tree)) recordColumn(node, clauseScope);
	};

	recordColumns(ast.columns, scope);
	recordColumns(ast.where, scope);
	recordColumns(ast.group, scope);
	recordColumns(ast.having, scope);
	recordColumns(ast.order, scope);
	(ast.joins ?? []).forEach((join, index) => {
		const joinedIdx = ast.from.length + index;
		recordColumns(join?.on, scope.slice(0, joinedIdx + 1));
		for (const column of join?.using ?? []) {
			const columnid = column?.columnid;
			if (!columnid) continue;
			record(scope[joinedIdx], columnid);
			const left = scope.slice(0, joinedIdx);
			if (left.every((entry) => entry.attributesKnown)) record(usingLeftOwner(columnid, scope, joinedIdx), columnid);
			else for (const entry of left) record(entry, columnid);
		}
	});
}

/**
 * Retrieve the schemas, tables, and attributes from the source Update AST.
 * @param ast - SQL command converted to an AST
 * @param affectedAttributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getUpdateAttributes(ast: any, affectedAttributes: any, tableLookup: any, unresolvedColumns?: Set<string>) {
	if (!ast) {
		harperLogger.info(`getUpdateAttributes: invalid SQL syntax tree`);
		return;
	}
	let schema = ast.table.databaseid;

	addSchemaTableToMap(ast.table, affectedAttributes, tableLookup);

	// SET targets need update; what SET expressions and WHERE read needs read (getWriteStatementReads()).
	for (const assignment of ast.columns ?? []) {
		if (assignment?.column?.columnid) {
			pushAttribute(ast.table.tableid, schema, assignment.column.columnid, affectedAttributes, tableLookup);
		}
	}
	reportForeignQualifiers(ast, [ast.columns, ast.where], unresolvedColumns);
}

/** A write statement has one table, so a column qualified by any other name has no table to check it on. */
function reportForeignQualifiers(ast: any, trees: any[], unresolvedColumns?: Set<string>) {
	const { tableid, as } = ast.table;
	for (const tree of trees) {
		for (const node of columnNodes(tree)) {
			if (node.tableid && node.tableid !== tableid && node.tableid !== as) {
				unresolvedColumns?.add(`${node.tableid}.${node.columnid}`);
			}
		}
	}
}

/**
 * Retrieve the schemas, tables, and attributes from the source Delete AST.
 * @param ast - SQL command converted to an AST
 * @param affectedAttributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getDeleteAttributes(ast: any, affectedAttributes: any, tableLookup: any, unresolvedColumns?: Set<string>) {
	if (!ast) {
		harperLogger.info(`getDeleteAttributes: invalid SQL syntax tree`);
		return;
	}
	addSchemaTableToMap(ast.table, affectedAttributes, tableLookup);

	// DELETE writes no attribute; what WHERE reads needs read (getWriteStatementReads()), primary key exempt.
	reportForeignQualifiers(ast, [ast.where], unresolvedColumns);
}

/**
 * Retrieve the schemas, tables, and attributes from the source Insert AST.
 * @param ast - SQL command converted to an AST
 * @param affectedAttributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getInsertAttributes(ast: any, affectedAttributes: any, tableLookup: any) {
	if (!ast) {
		harperLogger.info(`getInsertAttributes: invalid SQL syntax tree`);
		return;
	}
	let schema = ast.into.databaseid;

	addSchemaTableToMap(ast.into, affectedAttributes, tableLookup);

	for (const node of columnNodes(ast.columns)) {
		pushAttribute(ast.into.tableid, schema, node.columnid, affectedAttributes, tableLookup);
	}
}

/**
 * Helper function to add the specified column id to the attributes array of a table.
 * @param schema - The schema to add the column into
 * @param table - the table to add the column into
 * @param columnid - the column name that should be stored
 * @param affectedAttributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function pushAttribute(table: any, schema: any, columnid: any, affectedAttributes: any, tableLookup: any) {
	if (!affectedAttributes.get(schema)) {
		return;
	}
	let tableId = table;
	if (!affectedAttributes.get(schema).has(tableId)) {
		tableId = tableLookup.get(tableId);
	}
	affectedAttributes.get(schema).get(tableId).push(columnid);
}

export default sqlStatementBucket;
