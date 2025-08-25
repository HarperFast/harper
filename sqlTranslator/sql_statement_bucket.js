'use strict';
/**
 * This class is meant as a getter object that sits between the alasql (or other module) AST and any module requiring interpreted
 * AST SQL values such as attributes, tables, etc.
 **/

const alasql = require('alasql');
const RecursiveIterator = require('recursive-iterator');
const harperLogger = require('../utility/logging/harper_logger.js');
const hdbUtils = require('../utility/common_utils.js');
const terms = require('../utility/hdbTerms.ts');

class sqlStatementBucket {
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
			let colTable = this.table_lookup.has(val.tableid)
				? this.table_lookup.get(val.tableid)
				: this.ast.from[0].tableid;

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
					let newColumn = new alasql.yy.Column({ columnid: attribute_name });
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

function filterReadRestrictedAttrs(attrPerms) {
	return attrPerms.filter((perm) => perm[terms.PERMS_CRUD_ENUM.READ]);
}

function interpretAST(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup) {
	getRecordAttributesAST(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
}

/**
 * Takes an AST definition and adds it to the schema/table affectedAttributes parameter as well as adding table alias'
 * to the tableLookup parameter.
 *
 * @param record - An AST style record
 * @param {Map} affectedAttributes - A map of attributes affected in the call.  Defined as [schema, Map[table, [attributesArray]]].
 * @param {Map} tableLookup - A map that will be filled in.  This map contains alias to table definitions as [alias, tableName].
 */
function addSchemaTableToMap(record, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup) {
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
function getRecordAttributesAST(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup) {
	if (!ast) {
		harperLogger.info(`getRecordAttributesAST: invalid SQL syntax tree`);
		return;
	}
	// We can reference any schema/table attributes, so we need to check each possibility
	// affected attributes is a Map of Maps like so [schema, Map[table, [attributesArray]]];
	if (ast instanceof alasql.yy.Insert) {
		getInsertAttributes(ast, affectedAttributes, tableLookup);
	} else if (ast instanceof alasql.yy.Select) {
		getSelectAttributes(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup);
	} else if (ast instanceof alasql.yy.Update) {
		getUpdateAttributes(ast, affectedAttributes, tableLookup);
	} else if (ast instanceof alasql.yy.Delete) {
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
function getSelectAttributes(ast, affectedAttributes, tableLookup, schemaLookup, tableToSchemaLookup) {
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

			if (!affectedAttributes.get(columnSchema).has(tableName)) {
				if (!tableLookup.has(tableName)) {
					harperLogger.info(`table specified as ${tableName} not found.`);
					return;
				} else {
					tableName = tableLookup.get(tableName);
				}
			}

			if (affectedAttributes.get(columnSchema).get(tableName).indexOf(node.columnid) < 0) {
				affectedAttributes.get(columnSchema).get(tableName).push(node.columnid);
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

				if (!affectedAttributes.get(schema).has(table)) {
					if (!tableLookup.has(table)) {
						harperLogger.info(`table specified as ${table} not found.`);
						continue;
					} else {
						table = tableLookup.get(table);
					}
				}
				//We need to check to ensure this columnid wasn't already set in the Map
				if (affectedAttributes.get(schema).get(table).indexOf(node.columnid) < 0) {
					affectedAttributes.get(schema).get(table).push(node.columnid);
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

					if (!affectedAttributes.get(schema).has(table)) {
						if (!tableLookup.has(table)) {
							harperLogger.info(`table specified as ${table} not found.`);
							continue;
						} else {
							table = tableLookup.get(table);
						}
					}
					//We need to check to ensure this columnid wasn't already set in the Map
					if (affectedAttributes.get(schema).get(table).indexOf(node.columnid) < 0) {
						affectedAttributes.get(schema).get(table).push(node.columnid);
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
function getUpdateAttributes(ast, affectedAttributes, tableLookup) {
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
function getDeleteAttributes(ast, affectedAttributes, tableLookup) {
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
function getInsertAttributes(ast, affectedAttributes, tableLookup) {
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
function pushAttribute(table, schema, columnid, affectedAttributes, tableLookup) {
	if (!affectedAttributes.get(schema)) {
		return;
	}
	let tableId = table;
	if (!affectedAttributes.get(schema).has(tableId)) {
		tableId = tableLookup.get(tableId);
	}
	affectedAttributes.get(schema).get(tableId).push(columnid);
}

module.exports = sqlStatementBucket;
