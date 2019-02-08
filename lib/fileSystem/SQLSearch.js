'use strict';

/**
 * SQLSearch.js
 * This class is used to receive the alasql generated AST from a SQL SELECT,
 * process the HarperDB file system and return results by passing the raw values into the alasql SQL parser
 */

const _ = require('lodash');
const alasql = require('alasql');
const alasql_function_importer = require('../../sqlTranslator/alasqlFunctionImporter');
const fs = require('fs-extra');
const clone = require('clone');
const RecursiveIterator = require('recursive-iterator');
const path = require('path');
const PropertiesReader = require('properties-reader');
const log = require('../../utility/logging/harper_logger');
const common_utils = require('../../utility/common_utils');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const getFetchAttributeValues = Symbol('getFetchAttributeValues');
const retrieveIds =Symbol('retrieveIds');
const consolidateData = Symbol('consolidateData');
const processJoins = Symbol('processJoins');
const getColumns = Symbol('getColumns');
const findColumn = Symbol('findColumn');
const getTables = Symbol('getTables');
const readAttributeValues = Symbol('readAttributeValues');
const finalSQL = Symbol('finalSQL');
const readBlobFiles = Symbol('readBlobFiles');
const addFetchColumns = Symbol('addFetchColumns');
const buildSQL = Symbol('buildSQL');
const stripFileExtension = Symbol('stripFileExtension');
const checkEmptySQL = Symbol('checkEmptySQL');
const conditionsToFetchAttributeValues = Symbol('conditionsToFetchAttributeValues');
const readRawFiles = Symbol('readRawFiles');
const readAttributeFilesByIds = Symbol('readAttributeFilesByIds');
const decideReadPattern = Symbol('decideReadPattern');
const checkHashValueExists = Symbol('checkHashValueExists');
const readBlobFilesForSetup = Symbol('readBlobFilesForSetup');
const backtickAllSchemaItems = Symbol('backtickAllSchemaItems');

const exclude_attributes = ['__hash_values','__hash_name','__merged_data','__has_hash'];
const escaped_slash_regex = /U\+002F/g;
const base_path = path.join(hdb_properties.get('HDB_ROOT'), 'schema');
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
//used to determin when we just want to read the raw files files vs traverse indices
const RAW_FILE_READ_LIMIT = 1000;
const ENOENT_CODE = 'ENOENT';
const HDB_EXTENSION = '.hdb';
const BLOB_FOLDER_NAME = 'blob';
const WHERE_CLAUSE_IS_NULL = 'IS NULL';

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

class FileSearch {
    /**
     * constructor for class
     * @param statement - the AST for the SQL SELECT to process
     * @param attributes - all attributes that are part of the schema for the tables in select
     */
    constructor(statement, attributes) {
        if(common_utils.isEmpty(statement)) {
            throw 'statement cannot be null';
        }

        this.statement = statement;
        //this is every attribute that we need to pull data for
        this.columns = {};

        this.all_table_attributes = attributes;

        this.fetch_attributes = [];
        this.exact_search_values = {};
        this.tables = [];

        //holds the data from the file system to be evalueted by the sql processor
        this.data = {};

        this[getColumns]();
        this[getTables]();
        this[conditionsToFetchAttributeValues]();
        this[backtickAllSchemaItems]();
    }

    /**
     *starting point function to execute the search
     */
    async search() {
        let search_results = undefined;
        try {
            let empty_sql_results = await this[checkEmptySQL]();
            if(empty_sql_results && empty_sql_results.length > 0) {
                return empty_sql_results;
            }
            await this[getFetchAttributeValues]();
            let blob_paths = await this[retrieveIds]();
            await this[readBlobFilesForSetup](blob_paths);

            //In the instance of null data this.data would not have schema/table defined or created as there is no data backing up what would sit in data.
            if(Object.keys(this.data).length === 0)
            { return []; }

            await this[consolidateData]();
            let join_results = await this[processJoins]();
            await this[decideReadPattern](join_results.existing_attributes,join_results.joined_length);
            search_results = await this[finalSQL]();
        } catch(e) {
            log.error(e);
            throw new Error('There was a problem performing this search.  Please check the logs and try again.');
        }
        return search_results;
    }


    /**
     * This function check to see if there is no from and no columns, or the table has been created but no data has been entered yet
     * if there are not then this is a SELECT used to solely perform a calculation such as SELECT 2*4, or SELECT SQRT(4)
     * @returns {*}
     */
    async [checkEmptySQL]() {
        let results = undefined;
        //the scenario that allows this to occur is the table has been created but no data has been entered yet, in this case we return an empty array
        if(common_utils.isEmptyOrZeroLength(this.all_table_attributes) && !common_utils.isEmptyOrZeroLength(this.columns.columns)) {
            //purpose of this is to break out of the waterfall but return an empty array
            return results;
        } else if(common_utils.isEmptyOrZeroLength(this.all_table_attributes) && common_utils.isEmptyOrZeroLength(this.statement.from)) {
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
     *extracts the table info from the attributes
     */
    [getTables]() {
        let tbls = [];
        this.all_table_attributes.forEach((attribute)=> {
            tbls.push(attribute.table);
        });

        this.tables = _.uniqBy(tbls, (tbl)=> {
            return[tbl.databaseid, tbl.tableid, tbl.as].join();
        });
        this.tables.forEach((table) => {
            this.data[`${table.databaseid}_${table.tableid}`] = {};
            //attributes_data[`${table.schema}_${table.table}`].__hash_values = new Set();
            this.data[`${table.databaseid}_${table.tableid}`].__hash_name = global.hdb_schema[table.databaseid][table.tableid].hash_attribute;
            this.data[`${table.databaseid}_${table.tableid}`].__merged_data = {};
            this.data[`${table.databaseid}_${table.tableid}`].__has_hash = false;
        });
    }

    /**
     *gets the raw column from each section of the statement and puts them in a map
     */
    [getColumns]() {
        //before pulling the raw columns we need to set the order by so that aliases match the raw column / function definition
        if(!common_utils.isEmptyOrZeroLength(this.statement.order)){
            //we need to loop each element of the order by and see if it's columnid actually matches an alias in the select.
            // if the order by column is an alias we replace the alias with the actual expression from the select
            this.statement.order.forEach((order_by)=>{
                let found = this.statement.columns.filter((column) => {
                    return common_utils.isEmpty(order_by.expression.tableid) && column.as === order_by.expression.columnid;
                });

                if(found.length > 0) {
                    order_by.expression = clone(found[0]);
                    delete order_by.expression.as;
                }
            });
        }


        let iterator = new RecursiveIterator(this.statement);
        for(let {node, path} of iterator) {
            if(node && node.columnid){
                if(!this.columns[path[0]]){
                    this.columns[path[0]] = [];
                }
                this.columns[path[0]].push(clone(node));
            }
        }
    }

    /**
     *searches the attributes for the matching column based on attribute name table name/alais
     * @param column - the column to search for
     */
    [findColumn](column){
        //look to see if this attribute exists on one of the tables we are selecting from
        let found_columns = this.all_table_attributes.filter((attribute)=>{
            if(column.tableid){
                return (attribute.table.as === column.tableid || attribute.table.tableid === column.tableid) && attribute.attribute === column.columnid;
            }

            return attribute.attribute === column.columnid;
        });

        //this is to handle aliases.  if we did not find the actual column we look at the aliases in the select columns
        if(!found_columns || found_columns.length === 0){
            found_columns = this.columns.columns.filter((select_column)=>{
                return column.columnid === select_column.as;
            });
        }

        return found_columns[0];
    }

    /**
     *iterates an ast segment columns and returns the found column.  Typically fetch columns are columns specified in a
     * join, where, or orderby clause.
     * @param segment_attributes
     */
    [addFetchColumns](segment_attributes){
        if(segment_attributes && segment_attributes.length > 0){
            segment_attributes.forEach((attribute)=>{
                let found = this[findColumn](attribute);
                if(found){
                    this.fetch_attributes.push(clone(found));
                }
            });
        }
    }

    /***
     * Iterates the where AST with the goal of finding exact values to match directly on. Matching on values allows us to skip parsing an index
     * If a condition has a columnid, and op of '=' or 'IN' and only is comparing to raw values we will limit the column to the raw value match.
     * If a column condition does not have these criteria or another condition for the same column does not adhere to the criteria then we ignore it for exact matching.
     */
    [conditionsToFetchAttributeValues](){
        if(common_utils.isEmpty(this.statement.where)) {
            return;
        }

        //if there is an OR in the where clause we will not perform exact match search on attributes as it ends up excluding values incorrectly.
        let total_ignore = false;
        for (let {node} of new RecursiveIterator(this.statement.where)) {
            if(node && node.op && node.op === 'OR'){
                total_ignore = true;
            }
        }

        if(total_ignore){
            return;
        }

        for (let {node} of new RecursiveIterator(this.statement.where)) {
            if (node && node.left && node.right && (node.left.columnid || node.right.columid) && node.op) {
                let values = new Set();
                let column = node.left.columnid ? node.left : node.right;
                let found_column = this[findColumn](column);
                if(!found_column) {
                    continue;
                }
                let attribute_key = common_utils.buildFolderPath(found_column.table.databaseid, found_column.table.tableid, found_column.attribute);
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
                            if (node.right.value || node.left.value) {
                                values.add(node.right.value ? node.right.value.toString() : node.left.value.toString());
                            } else {
                                ignore = true;
                            }
                            break;
                        case 'IN' :
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
     * AUtomatically adds backticks "`" to all schema elements, the reason for this is in SQL you can surround a reserved word with backticks as an escape to allow a schema element which is named the same as a reserved word to be used.
     * The issue is once alasql parses the sql the backticks are removed and we need them when we execute the sql.
     */
    [backtickAllSchemaItems](){
        let iterator = new RecursiveIterator(this.statement);
        for(let {node} of iterator) {
            if(node){
                if(node.columnid && !node.columnid.startsWith('`')){
                    node.columnid_orig = node.columnid;
                    node.columnid = `\`${node.columnid}\``;
                }
                if(node.tableid && !node.tableid.startsWith('`')){
                    node.tableid_orig = node.tableid;
                    node.tableid = `\`${node.tableid}\``;

                }
                if(node.databaseid  && !node.databaseid.startsWith('`')){
                    node.databaseid_orig = node.databaseid
                    node.databaseid = `\`${node.databaseid}\``;
                }

                if(node.as && typeof node.as === "string"){
                    node.as = `\`${node.as}\``;
                }

            }
        }
    }

    /**
     *gets  the list of all attribute values for the where & join attributes
     */
    async [getFetchAttributeValues]() {
        let blob_paths = {};
        //get all unique attributes
        this[addFetchColumns](this.columns.joins);

        // in order to perform is null conditions we need to bring in the hash attribute to make sure we coalesce the objects so records that have null values are found.
        let where_string = null;
        try {
            where_string = this.statement.where ? this.statement.where.toString() : '';
        } catch (e) {
            throw new Error('Could not generate proper where clause');
        }
        if (this.columns.where) {
            this[addFetchColumns](this.columns.where);
        }

        //the bitwise or '|' is intentionally used because i want both conditions checked regardless of whether the left condition is false
        if ((!this.columns.where && this.fetch_attributes.length === 0) | where_string.indexOf(WHERE_CLAUSE_IS_NULL) > -1) {
            //get unique ids of tables if there is no join or the where is performing an is null check
            this.tables.forEach((table) => {
                let hash_attribute = {
                    columnid: global.hdb_schema[table.databaseid][table.tableid].hash_attribute,
                    tableid: table.tableid
                };
                let found = this[findColumn](hash_attribute);
                this.fetch_attributes.push(found);
            });
        }

        this[addFetchColumns](this.columns.order);

        // do we need this uniqueby, could just use object as map
        this.fetch_attributes = _.uniqBy(this.fetch_attributes, (attribute) => {
            return [attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join();
        });


        for (const attribute of this.fetch_attributes) {
            let attribute_path = '';
            let is_hash = false;
            //check if this attribute is the hash attribute for a table, if it is we need to read the files from the __hdh_hash folder, otherwise pull from the value index
            if (attribute.attribute === global.hdb_schema[attribute.table.databaseid][attribute.table.tableid].hash_attribute) {
                is_hash = true;
                attribute_path = common_utils.buildFolderPath(base_path, attribute.table.databaseid, attribute.table.tableid, HDB_HASH_FOLDER_NAME, attribute.attribute);
            } else {
                attribute_path = common_utils.buildFolderPath(base_path, attribute.table.databaseid, attribute.table.tableid, attribute.attribute);
            }

            let object_path = common_utils.buildFolderPath(attribute.table.databaseid, attribute.table.tableid, attribute.attribute);
            //if there exact match values for this attribute we just assign them to the attribute, otherwise we pull the index to get all values
            // This query will test the if statement below
            // "sql":"select weight_lbs, age, owner_name from dev.dog where owner_name = 'Kyle'"
            if (!common_utils.isEmpty(this.exact_search_values[object_path]) && !this.exact_search_values[object_path].ignore &&
                !common_utils.isEmptyOrZeroLength(this.exact_search_values[object_path].values)) {
                if (is_hash) {
                    try {
                        let existing_values = await this[checkHashValueExists](attribute_path, Array.from(this.exact_search_values[object_path].values));
                        attribute.values = existing_values;
                    } catch (e) {
                        log.error(e);
                    }
                } else {
                    attribute.values = Array.from(this.exact_search_values[object_path].values);
                }
            } else {
                try {
                    let values = await fs.readdir(attribute_path);
                    if (is_hash) {
                        attribute.values = [];
                        values.forEach((value) => {
                            attribute.values.push(this[stripFileExtension](value));
                        });
                    } else {
                        attribute.values = values;
                    }
                } catch (e) {
                    // no-op
                }
            }
        }
        return blob_paths;
    }

    /***
     * checks to make sure the hash value exists, especially important for when people do search based on primary key
     * @param attribute_path
     * @param values
     */
    async [checkHashValueExists](attribute_path, values) {
        let existing_values = [];
        await Promise.all(values.map(async (value) => {
            try {
                await fs.access(common_utils.buildFolderPath(attribute_path, value + HDB_EXTENSION), fs.constants.F_OK);
                existing_values.push(value);
            } catch (e) {
                log.error(e);
                // no-op
            }
        }));
        return existing_values;
    }

    /**
     *initializes this.data and retrieves the ids for each attribute value
     */
    async [retrieveIds](){
        let blob_paths = {};

        for(const attribute of this.fetch_attributes) {
            this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`] = {};
            let hash_name = this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__hash_name;

            if(attribute.attribute === hash_name){
                this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__has_hash = true;
                attribute.values.forEach((value) => {
                    let autocast_value = common_utils.autoCast(value);
                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_value] = {};
                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_value] = autocast_value;
                });
            } else {
                let sub_path = common_utils.buildFolderPath(attribute.table.databaseid, attribute.table.tableid, attribute.attribute);
                let attribute_path = common_utils.buildFolderPath(base_path, sub_path);

                await Promise.all(attribute.values.map(async (value) => {
                    try {
                        let escaped_value = value.replace(escaped_slash_regex, '/');
                        let ids = await fs.readdir(common_utils.buildFolderPath(attribute_path, value));
                        //ids.forEach((id) => {
                        for(let id of ids) {
                            if (id === BLOB_FOLDER_NAME) {
                                blob_paths[common_utils.buildFolderPath(sub_path, value)] = attribute;
                            } else {
                                //this removes the .hdb extension from the end of the file name in a more performant way than replace
                                id = this[stripFileExtension](id);
                                let autocast_id = common_utils.autoCast(id);
                                //TODO Sould add the value as an object here, avoiding a step in consolidate data.
                                this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_id] = {};
                                this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_id] = common_utils.autoCast(escaped_value);
                            }
                        }
                    } catch (e) {
                        log.error(e);
                        // no-op
                    }
                    // TODO: Why do we need this?
                    attribute.values = null;
                }));
            }
        }
        return blob_paths;
    }

    /**
     *reads actual files when the byte length of the value exceeds 255 bytes.
     * @param blob_paths - path to the blob files to read
     * @returns {*}
     */
    async [readBlobFilesForSetup](blob_paths){
        let keys = Object.keys(blob_paths);

        if(!keys || keys.length === 0 ){
            return;
        }

        await Promise.all(keys.map(async (key) => {
            try {
                let column = blob_paths[key];
                let ids = await fs.readdir(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME));
                if(common_utils.isEmptyOrZeroLength(ids)){
                    return;
                }
                await Promise.all(ids.map(async (id) => {
                    let the_id = common_utils.autoCast(this[stripFileExtension](id));
                    let file_data = await fs.readFile(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME, id));
                    this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id] = {};
                    this.data[`${column.table.databaseid}_${column.table.tableid}`][`${column.attribute}`][the_id] = common_utils.autoCast(file_data.toString());
                })).catch((e) => {
                    log.error(e);
                });
            } catch (e) {
                log.error(e);
                // no-op
            }
        }));
    }

    /**
     *converts the raw indexed data into individual rows by hash attribute
     * @param callback
     */
    //consolidate based on tables
    async [consolidateData]() {
        await Promise.all(Object.keys(this.data).map(async (table) => {
            try {
                let hash_name = this.data[table].__hash_name;
                let object_keys = Object.keys(this.data[table].__merged_data);

                object_keys.forEach((id_value) => {
                    this.data[table].__merged_data[id_value][hash_name] = common_utils.autoCast(id_value);
                });

                Object.keys(this.data[table]).forEach((attribute)=>{
                    if(exclude_attributes.indexOf(attribute) >= 0 || attribute === hash_name){
                        return;
                    }
                    // TODO: This is another loop through the data
                    object_keys.forEach((value)=>{
                        value = value.replace(escaped_slash_regex, '/');
                        let temp = this.data[table][attribute][value];
                        if(this.data[table][attribute][value] === null || this.data[table][attribute][value] === undefined){
                            this.data[table].__merged_data[value][attribute] = null;
                        } else {
                            this.data[table].__merged_data[value][attribute] = this.data[table][attribute][value];
                        }
                    });
                    //This is to free up memory, after consolidation we no longer need these values
                    this.data[table][attribute] = null;
                });
            } catch (e) {
                log.error(e);
                // no-op
            }
        }));
    }

    /**
     *takes an intitial pass on the data by processing just the joins, conditions and order by.
     * This allows us to limit the broader select based on just the ids we need based on this pass
     */
    async [processJoins]() {
        let table_data = [];
        let select = [];

        //TODO posibbly need to loop the from here, need to investigate
        let from_statement = this.statement.from[0];

        let tables = [from_statement];

        let from_clause = [
            '? ' + (from_statement.as ? ' AS ' + from_statement.as : from_statement.tableid)
        ];

        table_data.push(Object.values(this.data[`${from_statement.databaseid_orig}_${from_statement.tableid_orig}`].__merged_data));


        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                tables.push(join.table);
                let from = join.joinmode + ' JOIN ? AS ' + (join.as ? join.as : join.table.tableid);

                if(join.on) {
                    from += ' ON ' + join.on.toString();
                }
                from_clause.push(from);
                table_data.push(Object.values(this.data[`${join.table.databaseid_orig}_${join.table.tableid_orig}`].__merged_data));
            });
        }

        //record the fetched attributes so we can compare to what else needs to be grabbed from them file system

        let hash_attributes = [];
        let existing_attributes = {};
        tables.forEach((table)=>{
            let hash = this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__hash_name;
            hash_attributes.push({
                key:`'${table.tableid_orig}.${hash}'`,
                schema:table.databaseid_orig,
                table:table.tableid_orig,
                keys: new Set()
            });
            select.push(`${(table.as ? table.as : table.tableid)}.\`${hash}\` AS "${table.tableid_orig}.${hash}"`);

            for(let prop in this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__merged_data){
                existing_attributes[table.tableid_orig] = Object.keys(this.data[`${table.databaseid_orig}_${table.tableid_orig}`].__merged_data[prop]);
                //TODO: Why is this break here?
                break;
            }
        });

        //TODO there is an error with between statements being converted back to string.  need to handle
        let where_clause = this.statement.where ? 'WHERE ' + this.statement.where : '';

        let order_clause = '';
        if(this.statement.order){
            //in this stage we only want to order by non-aggregates
            let non_aggr_order_by = this.statement.order.filter((order_by)=>{
                return !order_by.expression.aggregatorid;
            });

            if(!common_utils.isEmptyOrZeroLength(non_aggr_order_by)){
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

        if(joined && joined.length > 0) {
            joined.forEach((row) => {
                hash_attributes.forEach((hash) => {
                    if (row[hash.key] !== null && row[hash.key] !== undefined) {
                        hash.keys.add(row[hash.key].toString());
                    }
                });
            });

            hash_attributes.forEach((hash) => {
                let keys = Object.keys(this.data[`${hash.schema}_${hash.table}`].__merged_data);
                let delete_keys = _.difference(keys, [...hash.keys]);
                delete_keys.forEach((key) => {
                    delete this.data[`${hash.schema}_${hash.table}`].__merged_data[key];
                });
            });
        }
        let join_results = {
            'existing_attributes': existing_attributes,
            'joined_length': (joined)?joined.length:0
        };
        return join_results;
    }

    /***
     *
     * @param existing_attributes
     */
    async [decideReadPattern](existing_attributes, row_count) {
        if(row_count === 0) {
            return;
        }

        let all_columns = [];
        let iterator = new RecursiveIterator(this.columns);
        for(let {node} of iterator) {
            if (node && node.columnid) {
                let found = this[findColumn](node);
                if(found && (!existing_attributes[found.table.tableid] || existing_attributes[found.table.tableid].indexOf(found.attribute) < 0)){
                    all_columns.push(found);
                }
            }
        }

        all_columns = _.uniqBy(all_columns, (attribute)=> {
            return[attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join();
        });

        let read_function;
        if(row_count > RAW_FILE_READ_LIMIT) {
            read_function = this[readAttributeValues].bind(this);
        } else{
            read_function = this[readRawFiles].bind(this);
        }

        await read_function(all_columns).catch((e) => {
            log.error(e);
        });
    }

    /***
     * setup function for getting all object values from raw files rather than from the indices
     * figures out the remaining attributes to retrieve and the ids, both used to generate paths to open  all the files
     * this can be slow as it is overhead intensive
     * @param all_columns
     */
    async [readRawFiles](all_columns) {
        await Promise.all(all_columns.map(async (the_column) => {
            try {
                let ids = Object.keys(this.data[`${the_column.table.databaseid}_${the_column.table.tableid}`].__merged_data);
                await this[readAttributeFilesByIds](the_column, ids);
            } catch (e) {
                log.error(e);
            }
        }));
    }

    /***
     * reads the actual hdb files which in small batches is more performant
     * @param column
     * @param ids
     */
    async [readAttributeFilesByIds](column, ids){
        let attribute_path = common_utils.buildFolderPath(base_path, column.table.databaseid, column.table.tableid, HDB_HASH_FOLDER_NAME, column.attribute);
        await Promise.all(ids.map(async (id) => {
            try {
                let data = await fs.readFile(common_utils.buildFolderPath(attribute_path, id + HDB_EXTENSION));
                if(!data) {
                    return;
                }
                this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[id][column.attribute] = common_utils.autoCast(data.toString());
            } catch (err) {
                if(err && err.code === ENOENT_CODE){
                    this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[id][column.attribute] = null;
                } else if(err) {
                    log.error(err);
                }
            }
        }));
    }

    /**
     *reads the values for all remaining attributes not processed in the initial pass on the data.
     * the data retained is limited to the ids evaluated from processJoIns
     * @param all_columns
     */
    async [readAttributeValues](all_columns) {
        let blob_paths = {};
        await Promise.all(all_columns.map(async (column) => {
            try {
                let sub_path = common_utils.buildFolderPath(column.table.databaseid, column.table.tableid, column.attribute);

                let attribute_path = common_utils.buildFolderPath(base_path,sub_path);
                let results = await fs.readdir(attribute_path);
                await Promise.all(results.map(async (value) => {
                    try {
                        let the_value = common_utils.autoCast(value.replace(escaped_slash_regex, '/'));
                        let ids = await fs.readdir(common_utils.buildFolderPath(attribute_path,value));
                        for(let id of ids) {
                            if(id===BLOB_FOLDER_NAME){
                                let blob_path = common_utils.buildFolderPath(sub_path, value);
                                if(!blob_paths[blob_path]){
                                    blob_paths[blob_path] = column;
                                }
                            } else{
                                let the_id = common_utils.autoCast(this[stripFileExtension](id));
                                let the_key = this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                                if(the_key) {
                                    this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = the_value;
                                }
                            }
                        }
                    } catch (e) {
                        log.error(e);
                    }
                    await this[readBlobFiles](blob_paths).catch((e) => {
                        log.error(e);
                    });
                }));
            } catch (e) {
                log.error(e);
            }
        }));
    }

    /**
     *reads actual files when the byte length of the value exceeds 255 bytes.
     * @param blob_paths - path to the blob files to read
     * @returns {*}
     */
    async [readBlobFiles](blob_paths){
        let keys = Object.keys(blob_paths);

        if(!keys || keys.length === 0 ){
            return;
        }

        await Promise.all(blob_paths.map(async (key) => {
            try {
                let column = blob_paths[key];
                let ids = await fs.readdir(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME));
                if(!ids || ids.length === 0) {
                    return;
                }
                await Promise.all(ids.map(async (id) => {
                    try {
                        let the_id = common_utils.autoCast(this[stripFileExtension](id));
                        let the_key = this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                        if(the_key) {
                            let file_data = await fs.readFile(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME, id));
                            this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = common_utils.autoCast(file_data.toString());
                        }
                    } catch(e) {
                        log.error(e);
                    }
                }));
            } catch (e) {
                log.error(e);
            }
        }));
    }

    /**
     *takes all of the raw data and executes the full SQL from the AST against the data.
     */
    async [finalSQL](){
        let table_data = [];
        //TODO posibbly need to loop the from here, need to investigate
        let from_statement = this.statement.from[0];
        table_data.push(Object.values(this.data[`${from_statement.databaseid_orig}_${from_statement.tableid_orig}`].__merged_data));
        from_statement.as = (from_statement.as ? from_statement.as : from_statement.tableid);
        from_statement.databaseid = '';
        from_statement.tableid = '?';

        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                join.as = (join.as ? join.as : join.table.tableid);

                table_data.push(Object.values(this.data[`${join.table.databaseid_orig}_${join.table.tableid_orig}`].__merged_data));
                join.table.databaseid = '';
                join.table.tableid = '?';
            });
        }
        let final_results = undefined;
        try {
            let sql = this[buildSQL]();
            final_results = await alasql.promise(sql, table_data);
        } catch(e){
            throw new Error('There was a problem running the generated sql.')
        }
        return final_results;
    }

    /**
     * there is a bug in alasql where functions with aliases get their alias duplicated in the sql string.
     * we need to parse out the duplicate and replace with an empty string
     * @returns {string}
     */
    [buildSQL](){
        let sql = this.statement.toString();

        this.statement.columns.filter((column)=>{
            if(column.funcid && column.as){
                let column_string = column.toString()
                    .replace(' AS ' + column.as, '');
                sql = sql.replace(column.toString(), column_string);
            }

            if(column.as !== null && column.as !== undefined){
                column.toString();
            }
        });

        return sql;
    }

    /**
     * utility function to strip the .hdb from file names in order to get the raw value.
     * @param value
     * @returns {*}
     */
    [stripFileExtension](value){
        if(!common_utils.isEmpty(value)){
            return value.substr(0, value.length-4);
        }

        return value;
    }
}

module.exports = FileSearch;