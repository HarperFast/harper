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

        this._getColumns();
        this._getTables();
        this._conditionsToFetchAttributeValues();
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
                return empty_sql_results;
            }

            // Search for fetch attribute values and consolidate them into this.data[table].__merged_data property
            await this._getFetchAttributeValues();

            //In the instance of null data this.data would not have schema/table defined or created as there is no data backing up what would sit in data.
            if (Object.keys(this.data).length === 0) {
                return [];
            }

            // Consolidate initial data required for first pass of sql join - narrows list of hash ids for second pass to collect all data resulting from sql request
            let join_results = await this._processJoins();

            // Decide the most efficient way to make the second/final pass for collecting all additional data needed for sql request
            await this._getFinalAttributeData(join_results.existing_attributes,join_results.joined_length);
            search_results = await this._finalSQL();
        } catch(e) {
            log.error(e);
            throw new Error('There was a problem performing this search.  Please check the logs and try again.');
        }
        return search_results;
    }

    /**
     * Gets the raw column from each section of the statement and puts them in a map
     * @private
     */
    _getColumns() {
        //before pulling the raw columns we need to set the order by so that aliases match the raw column / function definition
        if (!common_utils.isEmptyOrZeroLength(this.statement.order)) {
            //we need to loop each element of the order by and see if it's columnid actually matches an alias in the select.
            // if the order by column is an alias we replace the alias with the actual expression from the select
            this.statement.order.forEach(order_by => {
                let found = this.statement.columns.filter(column => common_utils.isEmpty(order_by.expression.tableid) && column.as === order_by.expression.columnid);

                if (found.length > 0) {
                    order_by.expression = clone(found[0]);
                    delete order_by.expression.as;
                }
            });
        }

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
            this.data[schema_table].__has_hash = false;
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
            return;
        }

        for (let {node} of new RecursiveIterator(this.statement.where)) {
            if (node && node.left && node.right && (node.left.columnid || node.right.value) && node.op) {
                let values = new Set();
                // TODO - explore what scenarios would be handled here - when would a left.columnid not be present?
                let column = node.left.columnid ? node.left : node.right;
                let found_column = this._findColumn(column);
                if(!found_column) {
                    continue;
                }
                //buildFolderPath returns the needed key for FS (attribute dir key) and for Helium (datastore key)
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

                continue;
            }
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

                    if (node.as && typeof node.as === "string") {
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
            if (column.tableid) {
                return (attribute.table.as === column.tableid || attribute.table.tableid === column.tableid) && attribute.attribute === column.columnid;
            }

            return attribute.attribute === column.columnid;
        });

        //this is to handle aliases.  if we did not find the actual column we look at the aliases in the select columns
        if (common_utils.isEmptyOrZeroLength(found_columns)) {
            found_columns = this.columns.columns.filter(select_column => column.columnid === select_column.as);
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
     * Gets all values for the where, join, & order by attributes and converts the raw indexed data into individual
     * rows by hash attribute consolidated based on tables
     * @returns {Promise<void>}
     * @private
     */
    async _getFetchAttributeValues() {
        //get all unique attributes
        this._addFetchColumns(this.columns.joins);

        //TODO - move the below comment to a better spot
        //in order to perform is null conditions we need to bring in the hash attribute to make sure we coalesce the
        // objects so records that have null values are found.
        let where_string = null;
        try {
            where_string = this.statement.where ? this.statement.where.toString() : '';
        } catch (e) {
            throw new Error('Could not generate proper where clause');
        }
        if (this.columns.where) {
            this._addFetchColumns(this.columns.where);
        }

        //the bitwise or '|' is intentionally used because i want both conditions checked regardless of whether the left condition is false
        if ((!this.columns.where && this.fetch_attributes.length === 0) | where_string.indexOf(WHERE_CLAUSE_IS_NULL) > -1) {
            //get unique ids of tables if there is no join or the where is performing an is null check
            this.tables.forEach(table => {
                let hash_attribute = {
                    columnid: global.hdb_schema[table.databaseid][table.tableid].hash_attribute,
                    tableid: table.tableid
                };
                let found = this._findColumn(hash_attribute);
                this.fetch_attributes.push(found);
            });
        }

        if (this.columns.order) {
            this._addFetchColumns(this.columns.order);
        }

        // do we need this uniqueby, could just use object as map
        this.fetch_attributes = _.uniqBy(this.fetch_attributes, attribute => [attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join());

        // create an attr template for each table row to ensure each row has a null value for attrs not returned in the search
        const fetch_attributes_objs = this.fetch_attributes.reduce((acc, attr) => {
            const schema_table = `${attr.table.databaseid}_${attr.table.tableid}`;
            if (!acc[schema_table]) {
                const hash_name = this.data[schema_table].__hash_name;
                acc[schema_table] = { [hash_name]: null };
            }
            acc[schema_table][attr.attribute] = null;
            return acc;
        }, {});

        for (const attribute of this.fetch_attributes) {
            const schema_table = `${attribute.table.databaseid}_${attribute.table.tableid}`;
            this.data[schema_table][`${attribute.attribute}`] = {};
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
                        this.data[schema_table].__has_hash = true;
                        search_object.hash_values = Array.from(this.exact_search_values[object_path].values);
                        const attribute_values = Object.values(await harperBridge.getDataByHash(search_object));
                        attribute_values.forEach(hash_obj => {
                            const hash_val = hash_obj[hash_name];
                            if (!this.data[schema_table].__merged_data[hash_val]) {
                                this.data[schema_table].__merged_data[hash_val] = Object.create(fetch_attributes_objs[schema_table]);
                                this.data[schema_table].__merged_data[hash_val][hash_name] = hash_val;
                            }
                        });
                    } catch (e) {
                        log.error(e);
                    }
                } else {
                    search_object.search_attribute = attribute.attribute;
                    await Promise.all(Array.from(this.exact_search_values[object_path].values).map(async (value) => {
                        search_object.search_value = value;
                        const attr_vals = await harperBridge.getDataByValue(search_object);
                        Object.keys(attr_vals).forEach(hash_val => {
                            if (!this.data[schema_table].__merged_data[hash_val]) {
                                this.data[schema_table].__merged_data[hash_val] = Object.create(fetch_attributes_objs[schema_table]);
                                this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                                this.data[schema_table].__merged_data[hash_val][attribute.attribute] = attr_vals[hash_val][attribute.attribute];
                            } else {
                                this.data[schema_table].__merged_data[hash_val][attribute.attribute] = attr_vals[hash_val][attribute.attribute];
                            }
                        });
                    }));
                }
            } else {
                try {
                    // TODO - add comparator check
                    if (!common_utils.isEmpty(this.comparator_search_values[object_path]) && !this.comparator_search_values[object_path].ignore &&
                        !common_utils.isEmptyOrZeroLength(this.comparator_search_values[object_path].comparators)) {
                        const search_value_comparators = this.comparator_search_values[object_path].comparators;
                        for (let i=0; i < search_value_comparators.length; i++) {
                            const comp = search_value_comparators[i];
                            search_object.search_attribute = comp.attribute;
                            search_object.search_value = comp.search_value;
                            const matching_data = await harperBridge.getDataByValue(search_object, comp.operation);
                            if (is_hash) {
                                this.data[schema_table].__has_hash = true;
                                Object.values(matching_data).forEach(hash_obj => {
                                    const hash_val = hash_obj[hash_name];
                                    if (!this.data[schema_table].__merged_data[hash_val]) {
                                        this.data[schema_table].__merged_data[hash_val] = Object.create(fetch_attributes_objs[schema_table]);
                                        this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                                    }
                                });
                            } else {
                                Object.keys(matching_data).forEach(hash_val => {
                                    if (!this.data[schema_table].__merged_data[hash_val]) {
                                        this.data[schema_table].__merged_data[hash_val] = Object.create(fetch_attributes_objs[schema_table]);
                                        this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                                        this.data[schema_table].__merged_data[hash_val][attribute.attribute] = matching_data[hash_val][attribute.attribute];
                                    } else {
                                        this.data[schema_table].__merged_data[hash_val][attribute.attribute] = matching_data[hash_val][attribute.attribute];
                                    }
                                });
                            }
                        }
                    } else {
                        search_object.search_attribute = attribute.attribute;
                        search_object.search_value = '*';
                        const matching_data = await harperBridge.getDataByValue(search_object);
                        if (is_hash) {
                            this.data[schema_table].__has_hash = true;
                            Object.values(matching_data).forEach(hash_obj => {
                                const hash_val = hash_obj[hash_name];
                                if (!this.data[schema_table].__merged_data[hash_val]) {
                                    this.data[schema_table].__merged_data[hash_val] = Object.create(fetch_attributes_objs[schema_table]);
                                    this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                                }
                            });
                        } else {
                            Object.keys(matching_data).forEach(hash_val => {
                                if (!this.data[schema_table].__merged_data[hash_val]) {
                                    this.data[schema_table].__merged_data[hash_val] = Object.create(fetch_attributes_objs[schema_table]);
                                    this.data[schema_table].__merged_data[hash_val][hash_name] = common_utils.autoCast(hash_val);
                                    this.data[schema_table].__merged_data[hash_val][attribute.attribute] = matching_data[hash_val][attribute.attribute];
                                } else {
                                    this.data[schema_table].__merged_data[hash_val][attribute.attribute] = matching_data[hash_val][attribute.attribute];
                                }
                            });
                        }
                    }
                } catch (e) {
                    log.error(e);
                    // no-op
                }
            }
        }
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

        //TODO possibly need to loop the from here, need to investigate
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

            for (let prop in this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__merged_data) {
                existing_attributes[table.tableid_orig] = Object.keys(this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__merged_data[prop]);
                //This break is here b/c we only need to get attr keys from the first object.
                break;
            }
        });

        //TODO there is an error with between statements being converted back to string.  need to handle
        let where_clause = this.statement.where ? 'WHERE ' + this.statement.where : '';

        let order_clause = '';
        if (this.statement.order) {
            //in this stage we only want to order by non-aggregates
            let non_aggr_order_by = this.statement.order.filter(order_by => !order_by.expression.aggregatorid);

            if (!common_utils.isEmptyOrZeroLength(non_aggr_order_by)) {
                order_clause = 'ORDER BY ' + non_aggr_order_by.toString();
            }
        }

        let limit = this.statement.limit ? 'LIMIT ' + this.statement.limit : '';

        //we should only select the primary key of each table then remove the rows that exist from each table
        let joined =[];

        try {
            joined = await alasql.promise(`SELECT ${select.join(',')} FROM ${from_clause.join(' ')} ${where_clause} ${order_clause} ${limit}`, table_data);
        } catch(e) {
            log.error(e);
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

            await Promise.all(Object.values(table_searches).map(async table => {
                const search_object = {
                    schema: table.schema,
                    table: table.table,
                    hash_values: Object.keys(this.data[`${table.schema}_${table.table}`].__merged_data),
                    get_attributes: table.columns
                };
                const search_result = await harperBridge.getDataByHash(search_object);
                Object.keys(search_result).forEach(the_id => {
                    const the_row = search_result[the_id];
                    this.data[`${table.schema}_${table.table}`].__merged_data[the_id] = {
                        ...this.data[`${table.schema}_${table.table}`].__merged_data[the_id],
                        ...the_row
                    };
                });
            }));
        } catch(e) {
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
        //TODO possibly need to loop the from here, need to investigate
        let from_statement = this.statement.from[0];
        table_data.push(Object.values(this.data[`${from_statement.databaseid_orig}_${from_statement.tableid_orig}`].__merged_data));
        from_statement.as = (from_statement.as ? from_statement.as : from_statement.tableid);
        from_statement.databaseid = '';
        from_statement.tableid = '?';

        if (this.statement.joins) {
            this.statement.joins.forEach(join => {
                join.as = (join.as ? join.as : join.table.tableid);

                table_data.push(Object.values(this.data[`${join.table.databaseid_orig}_${join.table.tableid_orig}`].__merged_data));
                join.table.databaseid = '';
                join.table.tableid = '?';
            });
        }
        let final_results = undefined;
        try {
            let sql = this._buildSQL();
            final_results = await alasql.promise(sql, table_data);
        } catch(e){
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

        this.statement.columns.filter(column => {
            if (column.funcid && column.as) {
                let column_string = column.toString()
                    .replace(' AS ' + column.as, '');
                sql = sql.replace(column.toString(), column_string);
            }

            if (column.as !== null && column.as !== undefined) {
                column.toString();
            }
        });

        return sql;
    }
}

module.exports = SQLSearch;