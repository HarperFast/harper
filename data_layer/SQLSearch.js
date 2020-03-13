'use strict';

/**
 * SQLSearch.js
 * This class is used to receive the alasql generated AST from a SQL SELECT,
 * process the HarperDB file system and return results by passing the raw values into the alasql SQL parser
 */

const _ = require('lodash');
const alasql = require('alasql');
const alasql_function_importer = require('../sqlTranslator/alasqlFunctionImporter');
const clone = require('clone');
const RecursiveIterator = require('recursive-iterator');
const log = require('../utility/logging/harper_logger');
const common_utils = require('../utility/common_utils');
const harperBridge = require('./harperBridge/harperBridge');
const hdbTerms = require('../utility/hdbTerms');

const WHERE_CLAUSE_IS_NULL = 'IS NULL';
const SEARCH_ERROR_MSG = 'There was a problem performing this search. Please check the logs and try again.';

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

class SQLSearch {
    /**
     * Constructor for FileSearch class
     *
     * @param statement - the AST for the SQL SELECT to process
     * @param attributes - all attributes that are part of the schema for the tables in select
     */
    constructor(statement, attributes) {
        if (common_utils.isEmpty(statement)) {
            log.error('AST statement for SQL select process cannot be empty');
            throw 'statement cannot be null';
        }

        this.statement = statement;
        //this is every attribute that we need to pull data for
        this.columns = {};

        this.all_table_attributes = attributes;

        this.fetch_attributes = [];
        this.exact_search_values = {};
        this.comparator_search_values = {};
        this.tables = [];

        //holds the data from the file system to be evaluated by the sql processor
        this.data = {};

        this.has_aggregator = false;

        this._getColumns();
        this._getTables();
        this._conditionsToFetchAttributeValues();
        this._setAliasesForColumns();
        this._backtickAllSchemaItems();
    }

    /**
     * Starting point function to execute the search
     * @returns {Promise<results|final_results[]|Array>}
     */
    async search() {
        let search_results = undefined;
        try {
            let empty_sql_results = await this._checkEmptySQL();
            if (!common_utils.isEmptyOrZeroLength(empty_sql_results)) {
                log.trace('No results returned from checkEmptySQL SQLSearch method.');
                return empty_sql_results;
            }
        } catch (err) {
            log.error('Error thrown from checkEmptySQL in SQLSearch class method search.');
            log.error(err);
            throw new Error(SEARCH_ERROR_MSG);
        }

        try {
            // Search for fetch attribute values and consolidate them into this.data[table].__merged_data property
            const simple_query_results = await this._getFetchAttributeValues();
            if (simple_query_results) {
                return simple_query_results;
            }
        } catch (err) {
            log.error('Error thrown from getFetchAttributeValues in SQLSearch class method search.');
            log.error(err);
            throw new Error(SEARCH_ERROR_MSG);
        }

        // In the instance of null data this.data would not have schema/table defined or created as there is no data backing up what would sit in data.
        if (Object.keys(this.data).length === 0) {
            log.trace('SQLSearch class field: "data" is empty.');
            return [];
        }

        let join_results;
        try {
            // Consolidate initial data required for first pass of sql join - narrows list of hash ids for second pass to collect all data resulting from sql request
            join_results = await this._processJoins();
        } catch (err) {
            log.error('Error thrown from processJoins in SQLSearch class method search.');
            log.error(err);
            throw new Error(SEARCH_ERROR_MSG);
        }

        try {
            // Decide the most efficient way to make the second/final pass for collecting all additional data needed for sql request
            await this._getFinalAttributeData(join_results.existing_attributes, join_results.joined_length);
        } catch (err) {
            log.error('Error thrown from getFinalAttributeData in SQLSearch class method search.');
            log.error(err);
            throw new Error(SEARCH_ERROR_MSG);
        }

        try {
            search_results = await this._finalSQL();
            return search_results;
        } catch (err) {
            log.error('Error thrown from finalSQL in SQLSearch class method search.');
            log.error(err);
            throw new Error(SEARCH_ERROR_MSG);
        }
    }

    /**
     * Gets the raw column from each section of the statement and puts them in a map
     * @private
     */
    _getColumns() {
        let iterator = new RecursiveIterator(this.statement);
        for (let {node, path} of iterator) {
            if (node && node.columnid){
                if (!this.columns[path[0]]) {
                    this.columns[path[0]] = [];
                }
                this.columns[path[0]].push(clone(node));
            }
        }
    }

    /**
     * Extracts the table info from the attributes
     * @private
     */
    _getTables() {
        let tbls = [];
        this.all_table_attributes.forEach(attribute => {
            tbls.push(attribute.table);
        });

        this.tables = _.uniqBy(tbls, tbl => [tbl.databaseid, tbl.tableid, tbl.as].join());
        this.tables.forEach(table => {
            const schema_table = `${table.databaseid}_${table.tableid}`;
            this.data[schema_table] = {};
            this.data[schema_table].__hash_name = global.hdb_schema[table.databaseid][table.tableid].hash_attribute;
            this.data[schema_table].__merged_data = {};
            this.data[schema_table].__merged_attributes = [];
            this.data[schema_table].__merged_attr_map = {};
        });
    }

    /**
     * Iterates the where AST with the goal of finding exact values to match directly on. Matching on values allows us to skip parsing an index
     * If a condition has a columnid, and op of '=' or 'IN' and only is comparing to raw values we will limit the column to the raw value match.
     * If a column condition does not have these criteria or another condition for the same column does not adhere to the criteria then we ignore it for exact matching.
     * @private
     */
    _conditionsToFetchAttributeValues() {
        if (common_utils.isEmpty(this.statement.where)) {
            log.trace('AST "where" statement is empty.');
            return;
        }

        //if there is an OR in the where clause we will not perform exact match search on attributes as it ends up excluding values incorrectly.
        let total_ignore = false;
        for (let {node} of new RecursiveIterator(this.statement.where)) {
            if (node && node.op && node.op === 'OR') {
                total_ignore = true;
            }
        }

        if (total_ignore) {
            log.trace('Where clause contains "OR", exact match search not performed on attributes.');
            return;
        }

        for (let {node} of new RecursiveIterator(this.statement.where)) {
            if (node && node.left && node.right && (node.left.columnid || node.right.value) && node.op) {
                let values = new Set();
                let column = node.left.columnid ? node.left : node.right;
                let found_column = this._findColumn(column);
                if(!found_column) {
                    continue;
                }
                //buildFolderPath returns the needed key for FS (attribute dir key)
                let attribute_key = common_utils.buildFolderPath(found_column.table.databaseid, found_column.table.tableid, found_column.attribute);

                // Check for value range search first
                if (!common_utils.isEmpty(hdbTerms.FS_VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[node.op])) {
                    if (common_utils.isEmpty(this.comparator_search_values[attribute_key])) {
                        this.comparator_search_values[attribute_key] = {
                            ignore: false,
                            comparators: []
                        };
                    }

                    if (!this.comparator_search_values[attribute_key].ignore) {
                        if (common_utils.isEmptyOrZeroLength(node.left.columnid) || common_utils.isEmptyOrZeroLength(node.right.value)) {
                            this.comparator_search_values[attribute_key].ignore = true;
                            this.comparator_search_values[attribute_key].comparators = [];
                            continue;
                        }

                        this.comparator_search_values[attribute_key].comparators.push({
                            attribute: node.left.columnid,
                            operation: node.op,
                            search_value: `${node.right.value}`
                        });
                    }
                    continue;
                }

                if (common_utils.isEmpty(this.exact_search_values[attribute_key])) {
                    this.exact_search_values[attribute_key] = {
                        ignore: false,
                        values: new Set()
                    };
                }

                if (!this.exact_search_values[attribute_key].ignore) {
                    let ignore = false;

                    switch (node.op) {
                        case '=':
                            if (!common_utils.isEmpty(node.right.value) || !common_utils.isEmpty(node.left.value)) {
                                values.add(!common_utils.isEmpty(node.right.value) ? node.right.value.toString() : node.left.value.toString());
                            } else {
                                ignore = true;
                            }
                            break;
                        case 'IN':
                            let in_array = Array.isArray(node.right) ? node.right : node.left;

                            for (let x = 0; x < in_array.length; x++) {
                                if (in_array[x].value) {
                                    values.add(in_array[x].value.toString());
                                } else {
                                    ignore = true;
                                    break;
                                }
                            }
                            break;
                        default:
                            ignore = true;
                            break;
                    }
                    this.exact_search_values[attribute_key].ignore = ignore;

                    //if we are ignoring the column for exact matches we clear out it's values to match later
                    if (ignore) {
                        this.exact_search_values[attribute_key].values = new Set();
                    } else {
                        this.exact_search_values[attribute_key].values = new Set([...this.exact_search_values[attribute_key].values, ...values]);
                    }
                }
            }
        }
    }

    /**
     * Iterates the columns in the AST and assigns an alias to each column if one does not exist.  This is necessary to ensure
     * that the final result returned from alasql include the correct column header
     * @private
     */
    _setAliasesForColumns() {
        //this scenario is reached by doing a select with only calculations and, therefore, this step can be skipped.
        if (common_utils.isEmptyOrZeroLength(this.all_table_attributes) && common_utils.isEmptyOrZeroLength(this.statement.from) && common_utils.isEmptyOrZeroLength(this.columns.columns)) {
            return;
        }
        let wildcard_index = -1;
        this.statement.columns.forEach((col, index) => {
            if (col.columnid === '*') {
                wildcard_index = index;
                return;
            }

            if (col.aggregatorid) {
                this.has_aggregator = true;
            }

            if (!col.aggregatorid && !col.funcid) {
                col.as_orig = col.as ? col.as : col.columnid;
                col.as = `[${col.as_orig}]`;
            }

            if (col.aggregatorid && col.expression.columnid !== '*') {
                col.as_orig = col.as ?
                    col.as :
                    col.expression.tableid ?
                        `${col.aggregatorid}(${col.expression.tableid}.${col.expression.columnid})` :
                        `${col.aggregatorid}(${col.expression.columnid})`;
                col.as = `[${col.as_orig}]`;
            }
        });

        if (this.statement.columns.length > 1 && wildcard_index >= 0) {
            this.statement.columns.splice(wildcard_index, 1);
        }
    }

    /**
     * Automatically adds backticks "`" to all schema elements, the reason for this is in SQL you can surround a reserved
     * word with backticks as an escape to allow a schema element which is named the same as a reserved word to be used.
     * The issue is once alasql parses the sql the backticks are removed and we need them when we execute the sql.
     * @private
     */
    _backtickAllSchemaItems() {
        try {
            let iterator = new RecursiveIterator(this.statement);
            for (let {node} of iterator) {
                if (node) {
                    if (node.columnid && (typeof node.columnid !== "string")) {
                        node.columnid = node.columnid.toString();
                    }
                    if (node.columnid && !node.columnid.startsWith('`')) {
                        node.columnid_orig = node.columnid;
                        node.columnid = `\`${node.columnid}\``;
                    }
                    if (node.tableid && !node.tableid.startsWith('`')) {
                        node.tableid_orig = node.tableid;
                        node.tableid = `\`${node.tableid}\``;
                    }
                    if (node.databaseid && !node.databaseid.startsWith('`')) {
                        node.databaseid_orig = node.databaseid;
                        node.databaseid = `\`${node.databaseid}\``;
                    }

                    if (node.as && typeof node.as === "string" && !node.as.startsWith('[')) {
                        node.as_orig = node.as;
                        node.as = `\`${node.as}\``;
                    }
                }
            }
        } catch(err) {
            log.error(`Got an error back ticking items.`);
            log.error(err);
        }
    }

    /**
     * Searches the attributes for the matching column based on attribute & table name/alias
     *
     * @param column - the column to search for
     * @returns {found_columns}
     * @private
     */
    _findColumn(column) {
        //look to see if this attribute exists on one of the tables we are selecting from
        let found_columns = this.all_table_attributes.filter(attribute => {
            if (column.columnid_orig) {
                return (attribute.table.as === column.tableid_orig || attribute.table.tableid === column.tableid_orig) && attribute.attribute === column.columnid_orig;
            }

            if (column.tableid) {
                return (attribute.table.as === column.tableid || attribute.table.tableid === column.tableid) && attribute.attribute === column.columnid;
            }

            return attribute.attribute === column.columnid;
        });

        //this is to handle aliases.  if we did not find the actual column we look at the aliases in the select columns and then return the matching column from all_table_attrs, if it exists
        if (common_utils.isEmptyOrZeroLength(found_columns)) {
            const found_alias = this.columns.columns.filter(select_column => select_column.as ? column.columnid === select_column.as : false);
            if (!common_utils.isEmptyOrZeroLength(found_alias)) {
                found_columns = this.all_table_attributes.filter(col => col.attribute === found_alias[0].columnid
                    && (found_alias[0].tableid && found_alias[0].tableid === (col.table.as ? col.table.as : col.table.tableid))
                );
            }
        }

        return found_columns[0];
    }

    /**
     * This function check to see if there is no from and no columns, or the table has been created but no data has been entered yet
     * if there are not then this is a SELECT used to solely perform a calculation such as SELECT 2*4, or SELECT SQRT(4)
     * @returns {Promise<[]>}
     * @private
     */
    async _checkEmptySQL() {
        let results = [];
        //the scenario that allows this to occur is the table has been created but no data has been entered yet, in this case we return an empty array
        if (common_utils.isEmptyOrZeroLength(this.all_table_attributes) && !common_utils.isEmptyOrZeroLength(this.columns.columns)) {
            //purpose of this is to break out of the waterfall but return an empty array
            return results;
        } else if (common_utils.isEmptyOrZeroLength(this.all_table_attributes) && common_utils.isEmptyOrZeroLength(this.statement.from)) {
            //this scenario is reached by doing a select with only calculations
            try {
                results = await alasql.promise(this.statement.toString());
            } catch(e) {
                log.error('Error thrown from AlaSQL in SQLSearch class method checkEmptySQL.');
                log.error(e);
                throw new Error('There was a problem with the SQL statement');
            }
        }
        return results;
    }

    /**
     * Iterates an ast segment columns and returns the found column.  Typically fetch columns are columns specified in a
     * join, where, or orderby clause.
     * @param segment_attributes
     * @private
     */
    _addFetchColumns(segment_attributes) {
        if (segment_attributes && segment_attributes.length > 0) {
            segment_attributes.forEach(attribute => {
                let found = this._findColumn(attribute);
                if (found) {
                    this.fetch_attributes.push(clone(found));
                }
            });
        }
    }

    /**
     * Adds new attribute metadata for the specified table to enable more easily accessing/adding/updating row data being built out
     * @param schema_table <String> the table to add the metadata to
     * @param attr <String> the attribute to add to the table row metadata
     * @private
     */
    _addColumnToMergedAttributes(schema_table, attr) {
        this.data[schema_table].__merged_attributes.push(attr);
        this.data[schema_table].__merged_attr_map[attr] = this.data[schema_table].__merged_attributes.length - 1;
    }

    /**
     * Adds the hash attribute to the specified table - this is similar to the above but unique for hash attributes because we always
     * add hash keys to the first index position in the table metadata and do not need to add it to the `__merged_attr_map`
     * @param schema_table <String> the table to add the metadata to
     * @param hash_value <String> the hash key to add to the table row metadata
     * @private
     */
    _setMergedHashAttribute(schema_table, hash_value) {
        this.data[schema_table].__merged_data[hash_value].splice(0, 1, hash_value);
    }

    /**
     * Updates the table row data for a specific hash value
     * @param schema_table <String> the table to update the hash value row in
     * @param hash_value <String> the hash value to update an attr for
     * @param attr <String> the attr to update in the table row
     * @param update_value <String> the value to update in the table row
     * @private
     */
    _updateMergedAttribute(schema_table, hash_value, attr, update_value) {
        const attr_index = this.data[schema_table].__merged_attr_map[attr];
        this.data[schema_table].__merged_data[hash_value].splice(attr_index, 1, update_value);
    }

    /**
     * Gets all values for the where, join, & order by attributes and converts the raw indexed data into individual
     * rows by hash attribute consolidated based on tables. If the SQL statement is a simple SELECT query, this method
     * will return the results from that select and bypass the additional alasql steps.
     * @returns {Promise<void>}
     * @private
     */
    async _getFetchAttributeValues() {
        //get all unique attributes
        this._addFetchColumns(this.columns.joins);

        let where_string = null;
        try {
            where_string = this.statement.where ? this.statement.where.toString() : '';
        } catch (e) {
            throw new Error('Could not generate proper where clause');
        }
        if (this.columns.where) {
            this._addFetchColumns(this.columns.where);
        }

        //We need to check if statement only includes basic columns and a from value in the statement
        // - if so, cannot treat as a simple select query and need to run through alasql
        const simple_select_query = this._isSimpleSelect();
        if (simple_select_query) {
            this._addFetchColumns(this.columns.columns);
        }
        //the bitwise or '|' is intentionally used because I want both conditions checked regardless of whether the left condition is false
        else if ((!this.columns.where && this.fetch_attributes.length === 0) | where_string.indexOf(WHERE_CLAUSE_IS_NULL) > -1) {
            //get unique ids of tables if there is no join or the where is performing an is null check
            this.tables.forEach(table => {
                let hash_attribute = {
                    columnid: global.hdb_schema[table.databaseid][table.tableid].hash_attribute,
                    tableid: table.tableid
                };
                this._addFetchColumns([hash_attribute]);
            });
        }

        if (this.statement.order) {
            this._updateOrderByToAliases();
            this._addNonAggregatorsToFetchColumns();
        }

        // do we need this uniqueby, could just use object as map
        this.fetch_attributes = _.uniqBy(this.fetch_attributes, attribute => [attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join());

        if (simple_select_query) {
            return await this._simpleSQLQuery();
        }

        // create a template for each table row to ensure each row has a null value for attrs not returned in the search
        const fetch_attr_row_templates = this.fetch_attributes.reduce((acc, attr) => {
            const schema_table = `${attr.table.databaseid}_${attr.table.tableid}`;
            const hash_name = this.data[schema_table].__hash_name;

            if (!acc[schema_table]) {
                acc[schema_table] = [];
                acc[schema_table].push(null);
                this._addColumnToMergedAttributes(schema_table, hash_name);
            }

            if (attr.attribute !== hash_name) {
                acc[schema_table].push(null);
                this._addColumnToMergedAttributes(schema_table, attr.attribute);
            }

            return acc;
        }, {});

        for (const attribute of this.fetch_attributes) {
            const schema_table = `${attribute.table.databaseid}_${attribute.table.tableid}`;
            let hash_name = this.data[schema_table].__hash_name;

            let search_object = {
                schema: attribute.table.databaseid,
                table: attribute.table.tableid,
                get_attributes: [attribute.attribute]
            };
            let is_hash = false;
            let object_path = common_utils.buildFolderPath(attribute.table.databaseid, attribute.table.tableid, attribute.attribute);

            //check if this attribute is the hash attribute for a table, if it is we need to read the files from the __hdh_hash
            // folder, otherwise pull from the value index
            if (attribute.attribute === hash_name) {
                is_hash = true;
            }

            // if there exact match values for this attribute we just assign them to the attribute, otherwise we pull the
            // index to get all values.  This query will test the if statement below
            // "sql":"select weight_lbs, age, owner_name from dev.dog where owner_name = 'Kyle'"
            if (!common_utils.isEmpty(this.exact_search_values[object_path]) && !this.exact_search_values[object_path].ignore &&
                !common_utils.isEmptyOrZeroLength(this.exact_search_values[object_path].values)) {
                if (is_hash) {
                    try {
                        search_object.hash_values = Array.from(this.exact_search_values[object_path].values);
                        const attribute_values = Object.values(await harperBridge.getDataByHash(search_object));

                        attribute_values.forEach(hash_obj => {
                            const hash_val = hash_obj[hash_name];
                            if (!this.data[schema_table].__merged_data[hash_val]) {
                                this.data[schema_table].__merged_data[hash_val] = [...fetch_attr_row_templates[schema_table]];
                                this._setMergedHashAttribute(schema_table, hash_val);
                            }
                        });
                    } catch (err) {
                        log.error('Error thrown from getDataByHash function in SQLSearch class method getFetchAttributeValues exact match.');
                        log.error(err);
                    }
                } else {
                    try {
                        search_object.search_attribute = attribute.attribute;
                        await Promise.all(Array.from(this.exact_search_values[object_path].values).map(async (value) => {
                            let exact_search_object = Object.assign({}, search_object);
                            exact_search_object.search_value = value;
                            const attribute_values = await harperBridge.getDataByValue(exact_search_object);

                            Object.keys(attribute_values).forEach(hash_val => {
                                if (!this.data[schema_table].__merged_data[hash_val]) {
                                    this.data[schema_table].__merged_data[hash_val] = [...fetch_attr_row_templates[schema_table]];
                                    this._updateMergedAttribute(schema_table, hash_val, attribute.attribute, attribute_values[hash_val][attribute.attribute]);
                                    this._setMergedHashAttribute(schema_table, common_utils.autoCast(hash_val));
                                } else {
                                    this._updateMergedAttribute(schema_table, hash_val, attribute.attribute, attribute_values[hash_val][attribute.attribute]);
                                }
                            });
                        }));
                    } catch (err) {
                        log.error('Error thrown from getDataByValue function in SQLSearch class method getFetchAttributeValues exact match.');
                        log.error(err);
                    }
                }
            } else {
                if (!common_utils.isEmpty(this.comparator_search_values[object_path]) && !this.comparator_search_values[object_path].ignore &&
                    !common_utils.isEmptyOrZeroLength(this.comparator_search_values[object_path].comparators)) {
                    try {
                        const search_value_comparators = this.comparator_search_values[object_path].comparators;
                        for (let i = 0; i < search_value_comparators.length; i++) {
                            const comp = search_value_comparators[i];
                            search_object.search_attribute = comp.attribute;
                            search_object.search_value = comp.search_value;
                            const matching_data = await harperBridge.getDataByValue(search_object, comp.operation);

                            if (is_hash) {
                                const matching_data_values = Object.values(matching_data);

                                matching_data_values.forEach(hash_obj => {
                                    const hash_val = hash_obj[hash_name];
                                    if (!this.data[schema_table].__merged_data[hash_val]) {
                                        this.data[schema_table].__merged_data[hash_val] = [...fetch_attr_row_templates[schema_table]];
                                        this._setMergedHashAttribute(schema_table, hash_val);
                                    }
                                });
                            } else {
                                const matching_data_keys = Object.keys(matching_data);

                                matching_data_keys.forEach(hash_val => {
                                    if (!this.data[schema_table].__merged_data[hash_val]) {
                                        this.data[schema_table].__merged_data[hash_val] = [...fetch_attr_row_templates[schema_table]];
                                        this._updateMergedAttribute(schema_table, hash_val, attribute.attribute, matching_data[hash_val][attribute.attribute]);
                                        this._setMergedHashAttribute(schema_table, common_utils.autoCast(hash_val));
                                    } else {
                                        this._updateMergedAttribute(schema_table, hash_val, attribute.attribute, matching_data[hash_val][attribute.attribute]);
                                    }
                                });
                            }
                        }
                    } catch (err) {
                        log.error('Error thrown from getDataByValue function in SQLSearch class method getFetchAttributeValues comparator search values.');
                        log.error(err);
                    }
                } else {
                    try {
                        search_object.search_attribute = attribute.attribute;
                        search_object.search_value = '*';
                        const matching_data = await harperBridge.getDataByValue(search_object);
                        if (is_hash) {
                            const matching_data_values = Object.values(matching_data);

                            matching_data_values.forEach(hash_obj => {
                                const hash_val = hash_obj[hash_name];
                                if (!this.data[schema_table].__merged_data[hash_val]) {
                                    this.data[schema_table].__merged_data[hash_val] = [...fetch_attr_row_templates[schema_table]];
                                    this._setMergedHashAttribute(schema_table, hash_val);
                                }
                            });
                        } else {
                            const matching_data_keys = Object.keys(matching_data);

                            matching_data_keys.forEach(hash_val => {
                                if (!this.data[schema_table].__merged_data[hash_val]) {
                                    this.data[schema_table].__merged_data[hash_val] = [...fetch_attr_row_templates[schema_table]];
                                    this._updateMergedAttribute(schema_table, hash_val, attribute.attribute, matching_data[hash_val][attribute.attribute]);
                                    this._setMergedHashAttribute(schema_table, common_utils.autoCast(hash_val));
                                } else {
                                    this._updateMergedAttribute(schema_table, hash_val, attribute.attribute, matching_data[hash_val][attribute.attribute]);
                                }
                            });
                        }
                    } catch (err) {
                        log.error('Error thrown from getDataByValue function in SQLSearch class method getFetchAttributeValues no comparator search values.');
                        log.error(err);
                    }
                }
            }
        }
    }

    /**
     * Checks if SQL statement only includes basic SELECT columns FROM one table
     * @returns {boolean} is SQL statement a simple select
     * @private
     */
    _isSimpleSelect() {
        let isSimpleSelect = true;

        if (Object.keys(this.statement).length !== 2 ||
            !this.statement.columns || !this.statement.from || this.statement.from.length !== 1) {
            isSimpleSelect = false;
            return isSimpleSelect;
        }

        this.statement.columns.forEach(col => {
            if (col instanceof alasql.yy.Column === false) {
                isSimpleSelect = false;
                return;
            }
        });

        return isSimpleSelect;
    }

    /**
     * Updates the AST order by values to utilize the aliases already set for the corresponding column values.  This is required to
     * resolve a bug in alasql where column values/references in the order by are not parsed by the library correctly.
     * @private
     */
    _updateOrderByToAliases() {
        this.statement.order.forEach(order_by => {
            //We don't need to do anything with the alias if the orderby is an aggregator
            if (order_by.expression.aggregatorid) {
                order_by.is_aggregator = true;
                return;
            }

            if (order_by.expression.value) {
                order_by.is_ordinal = true;
                return;
            } else {
                order_by.is_ordinal = false;
            }

            const found_column = this.statement.columns.filter(col => {
                const col_expression = col.aggregatorid ? col.expression : col;
                const col_alias = col.aggregatorid ? col.as_orig : col_expression.as_orig;

                if (!order_by.expression.tableid) {
                    return col_expression.columnid_orig === order_by.expression.columnid_orig || order_by.expression.columnid_orig === col_alias;
                } else {
                    return col_expression.columnid_orig === order_by.expression.columnid_orig && col_expression.tableid_orig === order_by.expression.tableid_orig;
                }
            });

            let select_column = found_column[0];

            order_by.is_aggregator = !!select_column.aggregatorid;
            if (select_column.as && !order_by.expression.tableid) {
                order_by.expression.columnid = select_column.as;
                order_by.expression.columnid_orig = select_column.as_orig;
            }
            else {
                let alias_expression = new alasql.yy.Column();
                alias_expression.columnid = select_column.as;
                alias_expression.columnid_orig = select_column.as_orig;
                order_by.expression = alias_expression;
            }
            if (!order_by.is_aggregator) {
                order_by.initial_select_column = Object.assign({}, select_column);
            }
        });
    }

    /**
     * This ensures that the non-aggregator columns included in the order by statement are included in the table data for the
     * first pass of alasql
     * @private
     */
    _addNonAggregatorsToFetchColumns() {
        const non_aggr_order_by_cols = this.statement.order.filter(ob => !ob.is_aggregator && !ob.is_ordinal);
        const non_aggr_columnids = non_aggr_order_by_cols.map(col => ({ columnid: col.expression.columnid_orig }));
        this._addFetchColumns(non_aggr_columnids);
    }

    /**
     * Takes an initial pass on the data by processing just the joins, conditions and order by.
     * This allows us to limit the broader select based on just the ids we need based on this pass
     * @returns {Promise<{existing_attributes, joined_length: number}>}
     * @private
     */
    async _processJoins() {
        let table_data = [];
        let select = [];
        //TODO need to loop from here to ensure cross joins are covered - i.e. 'from tablea a, tableb b, tablec c' -
        // this is not high priority but is covered in CORE-894
        let from_statement = this.statement.from[0];
        let tables = [from_statement];
        let from_clause = [
            '? ' + (from_statement.as ? ' AS ' + from_statement.as : from_statement.tableid)
        ];

        table_data.push(Object.values(this.data[`${from_statement.databaseid_orig}_${from_statement.tableid_orig}`].__merged_data));

        if (this.statement.joins) {
            this.statement.joins.forEach(join => {
                tables.push(join.table);
                let from = join.joinmode + ' JOIN ? AS ' + (join.as ? join.as : join.table.tableid);

                if (join.on) {
                    from += ' ON ' + join.on.toString();
                }
                from_clause.push(from);

                table_data.push(Object.values(this.data[`${join.table.databaseid_orig}_${join.table.tableid_orig}`].__merged_data));
            });
        }

        //record the fetched attributes so we can compare to what else needs to be grabbed from them file system
        let hash_attributes = [];
        let existing_attributes = {};
        tables.forEach(table => {
            let hash = this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__hash_name;
            hash_attributes.push({
                key:`'${table.tableid_orig}.${hash}'`,
                schema:table.databaseid_orig,
                table:table.tableid_orig,
                keys: new Set()
            });
            select.push(`${(table.as ? table.as : table.tableid)}.\`${hash}\` AS "${table.tableid_orig}.${hash}"`);

            existing_attributes[table.tableid_orig] = this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__merged_attributes;
        });

        //TODO there is an error with between statements being converted back to string.  need to handle
        let where_clause = this.statement.where ? 'WHERE ' + this.statement.where : '';

        let order_clause = '';
        if (this.statement.order) {
            //in this stage we only want to order by non-aggregates
            let non_aggr_order_by = this.statement.order.filter(ob => !ob.is_aggregator && !ob.is_ordinal && ob.initial_select_column);

            if (!common_utils.isEmptyOrZeroLength(non_aggr_order_by)) {
                order_clause = 'ORDER BY ' + non_aggr_order_by.toString();
                //because of the alasql bug with orderby (CORE-929), we need to add the ORDER BY column to the select with the
                // alias to ensure it's available for sorting in the first pass
                non_aggr_order_by.forEach(ob => {
                    if (ob.initial_select_column.tableid) {
                        select.push(`${ob.initial_select_column.tableid}.${ob.initial_select_column.columnid} AS ${ob.expression.columnid}`);
                    } else {
                        select.push(`${ob.initial_select_column.columnid} AS ${ob.expression.columnid}`);
                    }
                });
            }
        }

        let limit = '';
        let offset = '';
        if (!this.has_aggregator || !this.statement.group) {
            limit = this.statement.limit ? 'LIMIT ' + this.statement.limit : '';
            offset = this.statement.offset ? 'OFFSET ' + this.statement.offset : '';
        }

        //we should only select the primary key of each table then remove the rows that exist from each table
        //see note above about selecting appropriate orderby columns as well due to bug in alasql (CORE-929)
        let joined =[];

        try {
            const initial_sql = `SELECT ${select.join(', ')} FROM ${from_clause.join(' ')} ${where_clause} ${order_clause} ${limit} ${offset}`;
            const final_sql_operation = this._convertColumnsToIndexes(initial_sql, tables);
            joined = await alasql.promise(final_sql_operation, table_data);
            table_data = null;
        } catch(err) {
            log.error('Error thrown from AlaSQL in SQLSearch class method processJoins.');
            log.error(err);
            throw new Error('There was a problem processing the data.');
        }

        //collect returned hash values and remove others from table's __merged_data
        if (joined && joined.length > 0) {
            joined.forEach((row) => {
                hash_attributes.forEach(hash => {
                    if (row[hash.key] !== null && row[hash.key] !== undefined) {
                        hash.keys.add(row[hash.key].toString());
                    }
                });
            });

            hash_attributes.forEach(hash => {
                let keys = Object.keys(this.data[`${hash.schema}_${hash.table}`].__merged_data);
                let delete_keys = _.difference(keys, [...hash.keys]);
                delete_keys.forEach((key) => {
                    delete this.data[`${hash.schema}_${hash.table}`].__merged_data[key];
                });
            });
        }
        let join_results = {
            'existing_attributes': existing_attributes,
            'joined_length': joined ? joined.length : 0
        };

        return join_results;
    }

    /**
     * Gets remaining attribute values for final SQL operation that were not grabbed during first pass
     * @param existing_attributes
     * @param row_count
     * @returns {Promise<void>}
     * @private
     */
    async _getFinalAttributeData(existing_attributes, row_count) {
        if (row_count === 0) {
            return;
        }

        let all_columns = [];
        let iterator = new RecursiveIterator(this.columns);
        for (let {node} of iterator) {
            if (node && node.columnid) {
                let found = this._findColumn(node);
                if (found && (!existing_attributes[found.table.tableid] || existing_attributes[found.table.tableid].indexOf(found.attribute) < 0)) {
                    all_columns.push(found);
                }
            }
        }

        all_columns = _.uniqBy(all_columns, attribute => [attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join());

        try {
            await this._getData(all_columns);
        } catch(e) {
            log.error('Error thrown from getData in SQLSearch class method getFinalAttributeData.');
            log.error(e);
        }
    }

    /**
     * Organizes the final data searches based on tables being search to ensure we are only searching each table once
     * @param all_columns - remaining columns to be searched in
     * @returns {Promise<void>}
     * @private
     */
    async _getData(all_columns) {
        try {
            const table_searches = all_columns.reduce((acc, column) => {
                const table_key = `${column.table.databaseid}_${column.table.tableid}`;
                if (!acc[table_key]) {
                    acc[table_key] = {
                        schema: column.table.databaseid,
                        table: column.table.tableid,
                        columns: [column.attribute]
                    };
                } else {
                    acc[table_key].columns.push(column.attribute);
                }
                return acc;
            }, {});

            for (const table of Object.values(table_searches)) {
                const schema_table = `${table.schema}_${table.table}`;
                const merged_hash_keys = Object.keys(this.data[schema_table].__merged_data);
                this.data[schema_table].__merged_attributes.push(...table.columns);

                const search_object = {
                    schema: table.schema,
                    table: table.table,
                    hash_values: merged_hash_keys,
                    get_attributes: table.columns
                };

                const search_result = await harperBridge.getDataByHash(search_object);

                merged_hash_keys.forEach(the_id => {
                    const the_row = search_result[the_id];
                    table.columns.forEach(val => {
                        const attr_val = the_row[val] === undefined ? null : the_row[val];
                        this.data[schema_table].__merged_data[the_id].push(attr_val);
                    });
                });
            };
        } catch(e) {
            log.error('Error thrown from getDataByHash function in SQLSearch class method getData.');
            log.error(e);
            throw e;
        }
    }

    /**
     * Takes all of the raw data and executes the full SQL from the AST against the data.
     * @returns {Promise<[final_results]>}
     * @private
     */
    async _finalSQL() {
        let table_data = [];
        //TODO need to loop from here to ensure cross joins are covered - i.e. 'from tablea a, tableb b, tablec c' -
        // this is not high priority but is covered in CORE-894
        let from_statement = this.statement.from[0];
        table_data.push(Object.values(this.data[`${from_statement.databaseid_orig}_${from_statement.tableid_orig}`].__merged_data));
        from_statement.as = (from_statement.as ? from_statement.as : from_statement.tableid);
        from_statement.databaseid = '';
        from_statement.tableid = '?';

        if (this.statement.joins) {
            this.statement.joins.forEach(join => {
                join.as = join.as ? join.as : join.table.tableid;

                table_data.push(Object.values(this.data[`${join.table.databaseid_orig}_${join.table.tableid_orig}`].__merged_data));
                join.table.databaseid = '';
                join.table.tableid = '?';
            });
        }

        //since we processed the offset in first sql pass it will force it again which will cause no records to be returned
        if ((!this.has_aggregator || !this.statement.group) && this.statement.offset){
            delete this.statement.offset;
        }

        let final_results = undefined;
        try {
            let sql = this._buildSQL();
            log.trace(`Final SQL: ${sql}`);
            final_results = await alasql.promise(sql, table_data);
            log.trace(`Final AlaSQL results data included ${final_results.length} rows`);
        } catch(err) {
            log.error('Error thrown from AlaSQL in SQLSearch class method finalSQL.');
            log.error(err);
            throw new Error('There was a problem running the generated sql.');
        }

        return final_results;
    }

    /**
     * There is a bug in alasql where functions with aliases get their alias duplicated in the sql string.
     * we need to parse out the duplicate and replace with an empty string
     * @returns {string}
     * @private
     */
    _buildSQL(){
        let sql = this.statement.toString();

        this.statement.columns.forEach(column => {
            if (column.funcid && column.as) {
                let column_string = column.toString()
                    .replace(' AS ' + column.as, '');
                sql = sql.replace(column.toString(), column_string);
            }
        });

        return this._convertColumnsToIndexes(sql, this.tables);
    }

    /**
     * Updates the sql_statment string to use index values instead of table column names
     * @param sql_statement
     * @param tables
     * @returns {*}
     * @private
     */
    _convertColumnsToIndexes(sql_statement, tables) {
        let final_sql = sql_statement;
        const tables_map = {};
        tables.forEach(table => {
            if (table.databaseid_orig) {
                tables_map[`${table.databaseid_orig}_${table.tableid_orig}`] = table.as ? table.as : table.tableid;
            } else {
                tables_map[`${table.databaseid}_${table.tableid}`] = `\`${table.as ? table.as : table.tableid}\``;
            }
        });
        Object.keys(this.data).forEach(schema_table => {
            this.data[schema_table].__merged_attributes.forEach((attr, index) => {
                const table = tables_map[schema_table];
                let find;
                let replace;
                if (tables.length > 1) {
                    find = new RegExp(`${table}.\`${attr}\``, 'g');
                    replace = `${table}.[${index}]`;
                } else {
                    find = new RegExp(`\`${attr}\``, 'g');
                    replace = `[${index}]`;
                }

                final_sql = final_sql.replace(find, replace);
            });
        });
        return final_sql;
    }

    /**
     * Builds out the final result JSON for a simple SQL query to return to the main search method without using alasql
     * @returns {Promise<unknown[]>}
     * @private
     */
    async _simpleSQLQuery() {
        const fetch_attributes_objs = this.fetch_attributes.reduce((acc, attr) => {
            const schema_table = `${attr.table.databaseid}_${attr.table.tableid}`;
            if (!acc[schema_table]) {
                const hash_name = this.data[schema_table].__hash_name;
                acc[schema_table] = {[hash_name]: null};
            }
            acc[schema_table][attr.attribute] = null;
            return acc;
        }, {});

        for (const attribute of this.fetch_attributes) {
            const schema_table = `${attribute.table.databaseid}_${attribute.table.tableid}`;
            let hash_name = this.data[schema_table].__hash_name;

            let search_object = {
                schema: attribute.table.databaseid,
                table: attribute.table.tableid,
                get_attributes: [attribute.attribute]
            };
            let is_hash = false;

            //check if this attribute is the hash attribute for a table, if it is we need to read the files from the __hdh_hash
            // folder, otherwise pull from the value index
            if (attribute.attribute === hash_name) {
                is_hash = true;
            }

            try {
                search_object.search_attribute = attribute.attribute;
                search_object.search_value = '*';
                const matching_data = await harperBridge.getDataByValue(search_object);

                if (is_hash) {
                    Object.values(matching_data).forEach(hash_obj => {
                        const hash_val = hash_obj[hash_name];
                        if (!this.data[schema_table].__merged_data[hash_val]) {
                            this.data[schema_table].__merged_data[hash_val] = Object.assign({}, fetch_attributes_objs[schema_table]);
                            this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                        }
                    });
                } else {
                    Object.keys(matching_data).forEach(hash_val => {
                        if (!this.data[schema_table].__merged_data[hash_val]) {
                            this.data[schema_table].__merged_data[hash_val] = Object.assign({}, fetch_attributes_objs[schema_table]);
                            this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                            this.data[schema_table].__merged_data[hash_val][attribute.attribute] = matching_data[hash_val][attribute.attribute];
                        } else {
                            this.data[schema_table].__merged_data[hash_val][attribute.attribute] = matching_data[hash_val][attribute.attribute];
                        }
                    });
                }
            } catch (err) {
                log.error('There was an error when processing this SQL operation.  Check your logs');
                log.error(err);
            }
        }

        return Object.values(Object.values(this.data)[0].__merged_data);
    }
}

module.exports = SQLSearch;
