"use strict";
/**
 * This class is meant as a getter object that sits between the alasql (or other module) AST and any module requiring interpreted
 * AST SQL values such as attributes, tables, etc.
 **/

const alasql = require('alasql');
const RecursiveIterator = require('recursive-iterator');
const harper_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');

class sql_statement_bucket {
    constructor(ast) {
        this.ast = ast;
        // affected_attributes stores a table and it's attributes as a Map [schema, Map[table, [attributes_array]]].
        this.affected_attributes = new Map();
        this.table_lookup = new Map();
        this.schema_lookup = new Map();
        this.table_to_schema_lookup = new Map();
        interpretAST(this.ast, this.affected_attributes, this.table_lookup, this.schema_lookup, this.table_to_schema_lookup);
    }

    /**
     * Returns all attributes stored under a schema/table key set.
     * @param schema_name - Name of the schema to search under
     * @param table_name - Name of the table to pull attributes for.
     * @returns {Array}
     */
    getAttributesBySchemaTableName(schema_name, table_name) {
        if(!schema_name || !table_name || !this.affected_attributes) {
            return [];
        }
        if(this.affected_attributes.has(schema_name)) {
            if(!this.affected_attributes.get(schema_name).has(table_name)) {
                table_name = this.table_lookup.get(table_name);
                if(!table_name) return [];
            }
            return this.affected_attributes.get(schema_name).get(table_name);
        }
    }

    /**
     * Returns all tables that were inferred from the AST.
     * @returns {Array}
     */
    getAllTables() {
        let tables = [];
        if(!this.affected_attributes) {
            return tables;
        }
        for(const schema of this.affected_attributes.keys()) {
            tables.push(Array.from(this.affected_attributes.get(schema).keys()));
        }
        return tables;
    }

    /**
     * Get an array of all tables under the passed in schema name.  Will return an empty array with invalid parameters
     * @param schema_name - name of the schema
     * @returns {Array}
     */
    getTablesBySchemaName(schema_name) {
        if (!schema_name || !this.affected_attributes) return [];
        return Array.from(this.affected_attributes.get(schema_name).keys());
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
     * @param role_perms - role permission set to update the wildcard to the permitted attributes
     * @returns {ast} - this function returns the updated AST that can be used for final validation and the additional
     * steps to complete the request
     */
    updateAttributeWildcardsForRolePerms(role_perms) {
        const ast_wildcards = this.ast.columns.filter(col => terms.SEARCH_WILDCARDS.includes(col.columnid));

        //If there are no wildcards, we can skip this step
        if (ast_wildcards.length === 0) {
            return this.ast;
        }

        //This function will need to be updated if/when we start to do cross-schema joins - i.e. function will need
        // to handle multiple schema values instead of just the one below
        const from_databaseid = this.ast.from[0].databaseid;
        this.ast.columns = this.ast.columns.filter(col => !terms.SEARCH_WILDCARDS.includes(col.columnid));

        ast_wildcards.forEach(val => {
            // const wc_databaseid = val.
            let col_table;
            if (val.tableid) {
                col_table = this.table_lookup.get(val.tableid);
            } else {
                //If there is no table id, we can assume this is a simple `SELECT * FROM ...` w/ no JOINS
                col_table = this.ast.from[0].tableid;
            }

            //We only want to do this if the table that is being SELECT *'d has READ permissions - if not, we will only
            // want to send the table permissions error response so we can skip this step.
            if (role_perms[from_databaseid].tables[col_table][terms.PERMS_CRUD_ENUM.READ]) {
                const table_attr_perms = filterReadRestrictedAttrs(role_perms[col_schema].tables[col_table].attribute_restrictions);
                let final_table_attrs;
                if (table_attr_perms.length > 0) {
                    final_table_attrs = table_attr_perms;
                } else {
                    //If the user has READ perms for the table but no perms for the attributes in it, we add all the attrs
                    // into the AST * affected_attributes map so that the individual attribute permissions error responses
                    // are returned to the user
                    final_table_attrs = global.hdb_schema[col_schema][col_table].attributes.map(attr => ({attribute_name: attr.attribute}));
                }

                //It's important to REMOVE the wildcard as we replace it with the actual attributes that will be selected
                const table_affected_attrs = this.affected_attributes.get(col_schema).get(col_table)
                    .filter(attr => !terms.SEARCH_WILDCARDS.includes(attr));
                final_table_attrs.forEach(({attribute_name}) => {
                    let new_column = new alasql.yy.Column({ columnid: attribute_name });
                    if (val.tableid) {
                        new_column.tableid = val.tableid;
                    }
                    this.ast.columns.push(new_column);
                    if (!table_affected_attrs.includes(attribute_name)) {
                        table_affected_attrs.push(attribute_name);
                    }
                });
                this.affected_attributes.get(col_schema).set(col_table, table_affected_attrs);
            }
        });

        return this.ast;
    }
}

/**
 * Takes full table attribute permissions array and filters out attributes w/ FALSE READ perms
 *
 * @param attr_perms [] - attribute permissions for a table
 * @returns [] - array of attribute permissions objects w/ READ perms === TRUE
 */

function filterReadRestrictedAttrs(attr_perms) {
    return attr_perms.filter(perm => perm[terms.PERMS_CRUD_ENUM.READ]);
}

function interpretAST(ast, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup) {
    getRecordAttributesAST(ast, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
}

/**
 * Takes an AST definition and adds it to the schema/table affected_attributes parameter as well as adding table alias'
 * to the table_lookup parameter.
 *
 * @param record - An AST style record
 * @param {Map} affected_attributes - A map of attributes affected in the call.  Defined as [schema, Map[table, [attributes_array]]].
 * @param {Map} table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function addSchemaTableToMap(record, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup) {
    if (!record || !record.databaseid) {
        return;
    }
    if (!affected_attributes.has(record.databaseid)) {
        affected_attributes.set(record.databaseid, new Map());
    }
    if (!affected_attributes.get(record.databaseid).has(record.tableid)) {
        affected_attributes.get(record.databaseid).set(record.tableid, []);
    }
    if (record.as) {
        if (!table_lookup.has(record.as)) {
            table_lookup.set(record.as, record.tableid);
        }
        if (schema_lookup && !schema_lookup.has(record.as)) {
            schema_lookup.set(record.as, record.databaseid);
        }
    }
    if (table_to_schema_lookup) {
        const schema_id = record.databaseid;
        let table_id = record.tableid;
        if (record.as) {
            table_id = record.as;
        }

        if (table_to_schema_lookup.has(table_id)) {
            console.log('DOUBEL TABLE_ID - ', table_id);
        }
        table_to_schema_lookup.set(table_id, schema_id);
    }
}


/**
 * Pull the table attributes specified in the AST statement and adds them to the affected_attributes and table_lookup parameters.
 *
 * @param ast - the syntax tree containing SQL specifications
 * @param {Map} affected_attributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param {Map} table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getRecordAttributesAST(ast, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup) {
    if (!ast) {
        harper_logger.info(`getRecordAttributesAST: invalid SQL syntax tree`);
        return;
    }
    // We can reference any schema/table attributes, so we need to check each possibility
    // affected attributes is a Map of Maps like so [schema, Map[table, [attributes_array]]];
    if (ast instanceof alasql.yy.Insert) {
        getInsertAttributes(ast, affected_attributes, table_lookup);
    } else if (ast instanceof alasql.yy.Select) {
        getSelectAttributes(ast, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
    } else if (ast instanceof alasql.yy.Update) {
        getUpdateAttributes(ast, affected_attributes, table_lookup);
    } else if (ast instanceof alasql.yy.Delete) {
        getDeleteAttributes(ast, affected_attributes, table_lookup);
    } else {
        harper_logger.error(`AST in getRecordAttributesAST() is not a valid SQL type.`);
    }
}

/**
 * Retrieve the schemas, tables, and attributes from the source Select AST.
 *
 * @param ast - SQL command converted to an AST
 * @param affected_attributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getSelectAttributes(ast, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup) {
    if (!ast) {
        harper_logger.info(`getSelectAttributes: invalid SQL syntax tree`);
        return;
    }
    if (!ast.from || ast.from[0] === undefined) {
        return;
    }
    let schema = ast.from[0].databaseid;
    if (hdb_utils.isEmptyOrZeroLength(schema)) {
        harper_logger.error('No schema specified');
        return;
    }
    ast.from.forEach(from => {
        addSchemaTableToMap(from, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
    });
    if (ast.joins) {
        ast.joins.forEach(join => {
            //copying the 'as' to the table rather than on the join allows for a more generic function in addSchemaTableToMap().
            // as it can take a .table as well as a .join record. It's a bit hacky, but I don't think this should cause any problems.
            if (join.as) {
                join.table.as = join.as;
            }
            addSchemaTableToMap(join.table, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
        });
    }

    ast.columns.forEach(col => {
        let table_name;
        if (col.expression) {
            table_name = col.expression.tableid;
        } else {
            table_name = col.tableid;
        }
        const column_schema = schema_lookup.has(table_name) ? schema_lookup.get(table_name) : schema;

        if (!table_name) {
            table_name = ast.from[0].tableid;
        }

        if (!affected_attributes.get(column_schema).has(table_name)) {
            if (!table_lookup.has(table_name)) {
                harper_logger.info(`table specified as ${table_name} not found.`);
                return;
            } else {
                table_name = table_lookup.get(table_name);
            }
        }
        if (affected_attributes.get(column_schema).get(table_name).indexOf(col.columnid) < 0) {
            affected_attributes.get(column_schema).get(table_name).push(col.columnid);
        }
    });

    // It's important to iterate through the WHERE clause as well in case there are other columns that are not included in
    // the SELECT clause
    if (ast.where) {
        const iterator = new RecursiveIterator(ast.where);
        const from_table = ast.from[0].tableid;

        for(let {node} of iterator) {
            if(node && node.columnid ) {
                let table = node.tableid ? node.tableid : from_table;

                if (!affected_attributes.get(schema).has(table)) {
                    if (!table_lookup.has(table)) {
                        harper_logger.info(`table specified as ${table} not found.`);
                        continue;
                    } else {
                        table = table_lookup.get(table);
                    }
                }
                //We need to check to ensure this columnid wasn't already set in the Map
                if (affected_attributes.get(schema).get(table).indexOf(node.columnid) < 0) {
                    affected_attributes.get(schema).get(table).push(node.columnid);
                }
            }
        }
    }

    //TODO - SAM - add code comment
    if (ast.joins) {
        const iterator = new RecursiveIterator(ast.joins);

        for(let {node} of iterator) {
            if(node && node.columnid ) {
                let table = node.tableid;
                let schema = table_to_schema_lookup.get(table);

                if (!affected_attributes.get(schema).has(table)) {
                    if (!table_lookup.has(table)) {
                        harper_logger.info(`table specified as ${table} not found.`);
                        continue;
                    } else {
                        table = table_lookup.get(table);
                    }
                }
                //We need to check to ensure this columnid wasn't already set in the Map
                if (affected_attributes.get(schema).get(table).indexOf(node.columnid) < 0) {
                    affected_attributes.get(schema).get(table).push(node.columnid);
                }
            }
        }
    }
}

/**
 * Retrieve the schemas, tables, and attributes from the source Update AST.
 * @param ast - SQL command converted to an AST
 * @param affected_attributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getUpdateAttributes(ast, affected_attributes, table_lookup) {
    if(!ast) {
        harper_logger.info(`getUpdateAttributes: invalid SQL syntax tree`);
        return;
    }
    let iterator = new RecursiveIterator(ast.columns);
    let schema = ast.table.databaseid;

    addSchemaTableToMap(ast.table, affected_attributes, table_lookup);

    for(let {node} of iterator) {
        if(node && node.columnid ) {
            pushAttribute(ast.table.tableid, schema, node.columnid, affected_attributes, table_lookup);
        }
    }
}

/**
 * Retrieve the schemas, tables, and attributes from the source Delete AST.
 * @param ast - SQL command converted to an AST
 * @param affected_attributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getDeleteAttributes(ast, affected_attributes, table_lookup) {
    if(!ast) {
        harper_logger.info(`getDeleteAttributes: invalid SQL syntax tree`);
        return;
    }
    let iterator = new RecursiveIterator(ast.where);
    let schema = ast.table.databaseid;

    addSchemaTableToMap(ast.table, affected_attributes, table_lookup);

    for(let {node} of iterator) {
        if(node && node.columnid ) {
            pushAttribute(ast.table.tableid, schema, node.columnid, affected_attributes, table_lookup);
        }
    }
}

/**
 * Retrieve the schemas, tables, and attributes from the source Insert AST.
 * @param ast - SQL command converted to an AST
 * @param affected_attributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getInsertAttributes(ast, affected_attributes, table_lookup) {
    if(!ast) {
        harper_logger.info(`getInsertAttributes: invalid SQL syntax tree`);
        return;
    }
    let iterator = new RecursiveIterator(ast.columns);
    let schema = ast.into.databaseid;

    addSchemaTableToMap(ast.into, affected_attributes, table_lookup);

    for(let {node} of iterator) {
        if(node && node.columnid ) {
            pushAttribute(ast.into.tableid, schema, node.columnid, affected_attributes, table_lookup);
        }
    }
}

/**
 * Helper function to add the specified column id to the attributes array of a table.
 * @param schema - The schema to add the column into
 * @param table - the table to add the column into
 * @param columnid - the column name that should be stored
 * @param affected_attributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function pushAttribute(table, schema, columnid, affected_attributes, table_lookup) {
    if(!affected_attributes.get(schema)) {
        return;
    }
    let table_id = table;
    if(!affected_attributes.get(schema).has(table_id)) {
        table_id = table_lookup.get(table_id);
    }
    affected_attributes.get(schema).get(table_id).push(columnid);
}

module.exports = sql_statement_bucket;
