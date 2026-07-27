'use strict';
/**
 * This class is meant as a getter object that sits between the alasql (or other module) AST and any module requiring interpreted
 * AST SQL values such as attributes, tables, etc.
 **/

import * as alasql from 'alasql';
import RecursiveIterator from 'recursive-iterator';
const harperLogger = require('../utility/logging/harper_logger').default || require('../utility/logging/harper_logger');
import * as hdbUtils from '../utility/common_utils.ts';
import * as terms from '../utility/hdbTerms.ts';
import { findDatabasesWithTable, loadDatabaseRegistry } from '../sqlEngine/binder/defaultDatabase.ts';

class sqlStatementBucket {
	ast: any;
	affected_attributes: any;
	table_lookup: any;
	schema_lookup: any;
	table_to_schema_lookup: any;
	constructor(ast) {
		this.ast = ast;
		// affectedAttributes stores a table and it's attributes as a Map [schema, Map[table, [attributesArray]]].
		this.affected_attributes = new Map();
		this.table_lookup = new Map();
		this.schema_lookup = new Map();
		this.table_to_schema_lookup = new Map();
		interpretAST(
			this.ast,
			this.affected_attributes,
			this.table_lookup,
			this.schema_lookup,
			this.table_to_schema_lookup
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
				finalTableAttrs.forEach(({ attribute_name }) => {
					let newColumn = new (alasql as any).yy.Column({ columnid: attribute_name });
					if (val.tableid) {
						newColumn.tableid = val.tableid;
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

function interpretAST(
	ast: any,
	affectedAttributes: any,
	tableLookup: any,
	schemaLookup: any,
	tableToSchemaLookup: any
) {
	qualifyBareTableRefs(ast);
	getRecordAttributesAST(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
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
 * Every table the statement would touch. Mirrors the set of references the engine's binder
 * resolves — FROM entries and JOIN targets for a SELECT, or the single target of a write —
 * plus a SELECT's `INTO` target, which authorization does not model.
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

	if (ast instanceof (alasql as any).yy.Select) {
		if (Array.isArray(ast.from)) {
			ast.from.forEach((from, index) => addRef(from, `subquery in FROM position ${index + 1}`));
		}
		if (Array.isArray(ast.joins)) {
			ast.joins.forEach((join, index) => join?.table && addRef(join.table, `subquery in JOIN position ${index + 1}`));
		}
		// SELECT ... INTO is not implemented as a write today, but the target is invisible to the
		// affected-attribute map, so leave it here to be refused rather than silently authorized.
		if (ast.into) addRef(ast.into, 'SELECT INTO target');
	} else if (ast instanceof (alasql as any).yy.Insert) {
		addRef(ast.into, 'INSERT target');
	} else if (ast instanceof (alasql as any).yy.Update || ast instanceof (alasql as any).yy.Delete) {
		addRef(ast.table, 'write target');
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
	tableToSchemaLookup: any
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
		getSelectAttributes(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
	} else if (ast instanceof (alasql as any).yy.Update) {
		getUpdateAttributes(ast, affectedAttributes, tableLookup);
	} else if (ast instanceof (alasql as any).yy.Delete) {
		getDeleteAttributes(ast, affectedAttributes, tableLookup);
	} else {
		harperLogger.error(`AST in getRecordAttributesAST() is not a valid SQL type.`);
	}
}

/**
 * Retrieve the schemas, tables, and attributes from the source Select AST.
 *
 * @param ast - SQL command converted to an AST
 * @param affectedAttributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getSelectAttributes(
	ast: any,
	affectedAttributes: any,
	tableLookup: any,
	schemaLookup: any,
	tableToSchemaLookup: any
) {
	if (!ast) {
		harperLogger.info(`getSelectAttributes: invalid SQL syntax tree`);
		return;
	}
	if (!ast.from || ast.from[0] === undefined) {
		return;
	}
	let schema = ast.from[0].databaseid;
	if (hdbUtils.isEmptyOrZeroLength(schema)) {
		harperLogger.error('No schema specified');
		return;
	}
	ast.from.forEach((from) => {
		addSchemaTableToMap(from, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
	});
	if (ast.joins) {
		ast.joins.forEach((join) => {
			//copying the 'as' to the table rather than on the join allows for a more generic function in addSchemaTableToMap().
			// as it can take a .table as well as a .join record. It's a bit hacky, but I don't think this should cause any problems.
			if (join.as) {
				join.table.as = join.as;
			}
			addSchemaTableToMap(join.table, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
		});
	}

	const iterator = new RecursiveIterator(ast.columns);
	for (let { node } of iterator) {
		if (node && node.columnid) {
			let tableName = node.tableid;
			const columnSchema = schemaLookup.has(tableName) ? schemaLookup.get(tableName) : schema;

			if (!tableName) {
				tableName = ast.from[0].tableid;
			}

			const schemaTables = affectedAttributes.get(columnSchema);
			if (!schemaTables) {
				// The column's table was never recorded — an unresolvable reference alongside a
				// resolvable one. getUnauthorizedTableRefs() reports it and the statement is denied.
				harperLogger.info(`schema for table ${tableName} not resolved; skipping its attributes.`);
				continue;
			}

			if (!schemaTables.has(tableName)) {
				if (!tableLookup.has(tableName)) {
					harperLogger.info(`table specified as ${tableName} not found.`);
					return;
				} else {
					tableName = tableLookup.get(tableName);
				}
			}

			if (schemaTables.get(tableName).indexOf(node.columnid) < 0) {
				schemaTables.get(tableName).push(node.columnid);
			}
		}
	}

	// It's important to iterate through the WHERE clause in case there are other columns that are not included in
	// the SELECT clause
	if (ast.where) {
		const iterator = new RecursiveIterator(ast.where);
		const fromTable = ast.from[0].tableid;

		for (let { node } of iterator) {
			if (node && node.columnid) {
				let table = node.tableid ? node.tableid : fromTable;

				const schemaTables = affectedAttributes.get(schema);
				if (!schemaTables) {
					harperLogger.info(`schema for table ${table} not resolved; skipping its attributes.`);
					continue;
				}

				if (!schemaTables.has(table)) {
					if (!tableLookup.has(table)) {
						harperLogger.info(`table specified as ${table} not found.`);
						continue;
					} else {
						table = tableLookup.get(table);
					}
				}
				//We need to check to ensure this columnid wasn't already set in the Map
				if (schemaTables.get(table).indexOf(node.columnid) < 0) {
					schemaTables.get(table).push(node.columnid);
				}
			}
		}
	}

	// It's important to also iterate through the JOIN clause in case there are other columns that are not included in
	// the SELECT clause
	if (ast.joins) {
		ast.joins.forEach((join) => {
			const iterator = new RecursiveIterator(join.on);

			for (let { node } of iterator) {
				if (node && node.columnid) {
					let table = node.tableid;
					let schema = tableToSchemaLookup.get(table);

					const schemaTables = affectedAttributes.get(schema);
					if (!schemaTables) {
						harperLogger.info(`schema for table ${table} not resolved; skipping its attributes.`);
						continue;
					}

					if (!schemaTables.has(table)) {
						if (!tableLookup.has(table)) {
							harperLogger.info(`table specified as ${table} not found.`);
							continue;
						} else {
							table = tableLookup.get(table);
						}
					}
					//We need to check to ensure this columnid wasn't already set in the Map
					if (schemaTables.get(table).indexOf(node.columnid) < 0) {
						schemaTables.get(table).push(node.columnid);
					}
				}
			}
		});
	}

	// It's important to iterate through the ORDER clause in case there are other columns that are not included in
	// the SELECT clause with wildcard
	if (ast.order) {
		const orderIterator = new RecursiveIterator(ast.order);
		for (let { node } of orderIterator) {
			if (node && node.columnid) {
				let tableName = node.tableid;
				const orderSchema = schemaLookup.has(tableName) ? schemaLookup.get(tableName) : schema;

				if (!tableName) {
					tableName = ast.from[0].tableid;
				}

				if (!affectedAttributes.get(orderSchema).has(tableName)) {
					if (!tableLookup.has(tableName)) {
						harperLogger.info(`table specified as ${tableName} not found.`);
						return;
					} else {
						tableName = tableLookup.get(tableName);
					}
				}

				if (affectedAttributes.get(orderSchema).get(tableName).indexOf(node.columnid) < 0) {
					affectedAttributes.get(orderSchema).get(tableName).push(node.columnid);
				}
			}
		}
	}
}

/**
 * Retrieve the schemas, tables, and attributes from the source Update AST.
 * @param ast - SQL command converted to an AST
 * @param affectedAttributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getUpdateAttributes(ast: any, affectedAttributes: any, tableLookup: any) {
	if (!ast) {
		harperLogger.info(`getUpdateAttributes: invalid SQL syntax tree`);
		return;
	}
	let iterator = new RecursiveIterator(ast.columns);
	let schema = ast.table.databaseid;

	addSchemaTableToMap(ast.table, affectedAttributes, tableLookup);

	for (let { node } of iterator) {
		if (node && node.columnid) {
			pushAttribute(ast.table.tableid, schema, node.columnid, affectedAttributes, tableLookup);
		}
	}
}

/**
 * Retrieve the schemas, tables, and attributes from the source Delete AST.
 * @param ast - SQL command converted to an AST
 * @param affectedAttributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributesArray]]].
 * @param tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function getDeleteAttributes(ast: any, affectedAttributes: any, tableLookup: any) {
	if (!ast) {
		harperLogger.info(`getDeleteAttributes: invalid SQL syntax tree`);
		return;
	}
	let iterator = new RecursiveIterator(ast.where);
	let schema = ast.table.databaseid;

	addSchemaTableToMap(ast.table, affectedAttributes, tableLookup);

	for (let { node } of iterator) {
		if (node && node.columnid) {
			pushAttribute(ast.table.tableid, schema, node.columnid, affectedAttributes, tableLookup);
		}
	}
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
	let iterator = new RecursiveIterator(ast.columns);
	let schema = ast.into.databaseid;

	addSchemaTableToMap(ast.into, affectedAttributes, tableLookup);

	for (let { node } of iterator) {
		if (node && node.columnid) {
			pushAttribute(ast.into.tableid, schema, node.columnid, affectedAttributes, tableLookup);
		}
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
