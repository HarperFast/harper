"use strict"
/**
 * This class is meant as a getter object that sits between the alasql (or other module) AST and any module requiring interpreted
 * AST SQL values such as attributes, tables, etc.
 **/

const alasql = require('alasql');
const RecursiveIterator = require('recursive-iterator');
const harper_logger = require('../utility/logging/harper_logger');


class sql_statement_bucket {
    constructor(ast) {
        this.ast = ast;
        // affected_attributes stores a table and it's attributes as a Map [schema, Map[table, [attributes_array]]].
        this.affected_attributes = new Map();
        this.table_lookup = new Map();
        interpretAST(this.ast, this.affected_attributes, this.table_lookup);
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
        if(!schema_name || !this.affected_attributes) return [];
        return Array.from(this.affected_attributes.get(schema_name).keys());
    }

    /**
     * Gets an array of schemas that were inferred from the passed in AST
     * @returns {Array}
     */
    getSchemas() {
        if(!this.affected_attributes) {
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


}

function interpretAST(ast, affected_attributes, table_lookup) {
    getRecordAttributesAST(ast, affected_attributes, table_lookup);
}

/**
 * Takes an AST definition and adds it to the schema/table affected_attributes parameter as well as adding table alias' to the table_lookup parameter.
 * @param record - An AST style record
 * @param {Map} affected_attributes - A map of attributes affected in the call.  Defined as [schema, Map[table, [attributes_array]]].
 * @param {Map} table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function addSchemaTableToMap(record, affected_attributes, table_lookup) {
    if(!record || !record.databaseid) {
        return;
    }
    if(!affected_attributes.has(record.databaseid)) {
        affected_attributes.set(record.databaseid, new Map());
    }
    if(!affected_attributes.get(record.databaseid).has(record.tableid)) {
        affected_attributes.get(record.databaseid).set(record.tableid, []);
    }
    if(record.as) {
        if(!table_lookup.has(record.as)) {
            table_lookup.set(record.as, record.tableid)
        }
    }
}


/**
 * Pull the table attributes specified in the AST statement and adds them to the affected_attributes and table_lookup parameters.
 * @param ast - the syntax tree containing SQL specifications
 * @param {Map} affected_attributes - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param {Map} table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getRecordAttributesAST(ast, affected_attributes, table_lookup) {
    if(!ast) {
        harper_logger.info(`getRecordAttributesAST: invalid SQL syntax tree`);
        return;
    }
    // We can reference any schema/table attributes, so we need to check each possibility
    // affected attributes is a Map of Maps like so [schema, Map[table, [attributes_array]]];
    if(ast instanceof alasql.yy.Insert) {
        getInsertAttributes(ast, affected_attributes, table_lookup);
    } else if (ast instanceof alasql.yy.Select) {
        getSelectAttributes(ast, affected_attributes, table_lookup);
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
 * @param ast - SQL command converted to an AST
 * @param affected_attributes - - A map containing attributes affected by the statement. Defined as [schema, Map[table, [attributes_array]]].
 * @param table_lookup - A map that will be filled in.  This map contains alias to table definitions as [alias, table_name].
 */
function getSelectAttributes(ast, affected_attributes, table_lookup) {
    if(!ast) {
        harper_logger.info(`getSelectAttributes: invalid SQL syntax tree`);
        return;
    }
    if(!ast.from || ast.from[0] === undefined) {
        return;
    }
    let schema = ast.from[0].databaseid;
    ast.from.forEach((from)=>{
        addSchemaTableToMap(from, affected_attributes, table_lookup);
    });
    if(ast.joins){
        ast.joins.forEach((join)=> {
            //copying the 'as' to the table rather than on the join allows for a more generic function in addSchemaTableToMap().
            // as it can take a .table as well as a .join record. It's a bit hacky, but I don't think this should cause any problems.
            if(join.as) {
                join.table.as = join.as;
            }
            addSchemaTableToMap(join.table, affected_attributes, table_lookup)
        });
    }
    ast.columns.forEach((col)=>{
        let table_name = col.tableid;
        if(!table_name) {
            table_name = ast.from[0].tableid;
        }
        if(!affected_attributes.get(schema).has(table_name)) {
            if(!table_lookup.has(table_name)) {
                harper_logger.info(`table specified as ${table_name} not found.`);
                return;
            } else {
                table_name = table_lookup.get(table_name);
            }
        }
        affected_attributes.get(schema).get(table_name).push(col.columnid);
    });
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