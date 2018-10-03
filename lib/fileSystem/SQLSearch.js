'use strict';

/**
 * SQLSearch.js
 * This class is used to receive the alasql generated AST from a SQL SELECT,
 * process the HarperDB file system and return results by passing the raw values into the alasql SQL parser
 */

const async = require('async'),
    _ = require('lodash'),
    alasql = require('alasql'),
    alasql_function_importer = require('../../sqlTranslator/alasqlFunctionImporter'),
    fs = require('fs'),
    clone = require('clone'),
    RecursiveIterator = require('recursive-iterator'),
    path = require('path'),
    PropertiesReader = require('properties-reader'),
    common_utils = require('../../utility/common_utils');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const getAttributeValues = Symbol('getAttributeValues'),
    retrieveIds =Symbol('retrieveIds'),
    consolidateData = Symbol('consolidateData'),
    processJoins = Symbol('processJoins'),
    getColumns = Symbol('getColumns'),
    findColumn = Symbol('findColumn'),
    getTables = Symbol('getTables'),
    readAttributeValues = Symbol('readAttributeValues'),
    finalSQL = Symbol('finalSQL'),
    readBlobFiles = Symbol('readBlobFiles'),
    addFetchColumns = Symbol('addFetchColumns'),
    buildSQL = Symbol('buildSQL'),
    stripFileExtension = Symbol('stripFileExtension'),
    checkEmptySQL = Symbol('checkEmptySQL'),
    conditionsToFetchAttributeValues = Symbol('conditionsToFetchAttributeValues'),
    readRawFiles = Symbol('readRawFiles'),
    readAttributeFilesByIds = Symbol('readAttributeFilesByIds'),
    decideReadPattern = Symbol('decideReadPattern'),
    checkHashValueExists = Symbol('checkHashValueExists'),
    readBlobFilesForSetup = Symbol('readBlobFilesForSetup'),
    backtickAllSchemaItems = Symbol('backtickAllSchemaItems');


const exclude_attributes = ['__hash_values','__hash_name','__merged_data','__has_hash'];
const escaped_slash_regex = /U\+002F/g;
const base_path = path.join(hdb_properties.get('HDB_ROOT'), 'schema');
    //TODO research how best to optimize this number for async.eachLimit
const async_limit = 50;
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const OK_ERR = 'ok';
//used to determin when we just want to read the raw files files vs traverse indices
const RAW_FILE_READ_LIMIT = 1000;

const ENOENT_CODE = 'ENOENT';
const HDB_EXTENSION = '.hdb';
const BLOB_FOLDER_NAME = 'blob';
const WHERE_CLAUSE_IS_NULL = 'IS NULL';

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

class FileSearch{
    /**
     * constructor for class
     * @param statement - the AST for the SQL SELECT to process
     * @param attributes - all attributes that are part of the schema for the tables in select
     */
    constructor(statement, attributes){
        if(common_utils.isEmpty(statement)){
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
     * @param callback
     */
    search(callback){
        async.waterfall([
                this[checkEmptySQL].bind(this),
                this[getAttributeValues].bind(this),
                this[retrieveIds].bind(this),
                this[readBlobFilesForSetup].bind(this),
                this[consolidateData].bind(this),
                this[processJoins].bind(this),
                this[decideReadPattern].bind(this),
                this[finalSQL].bind(this)
            ],
            (err, results)=>{
                if(err && err !== OK_ERR){
                    return callback(err);
                }
                callback(null, results);
        });
    }

    /**
     * This function check to see if there is no from and no columns, or the table has been created but no data has been entered yet
     * if there are not then this is a SELECT used to solely perform a calculation such as SELECT 2*4, or SELECT SQRT(4)
     * @param callback
     * @returns {*}
     */
    [checkEmptySQL](callback){
        //the scenario that allows this to occur is the table has been created but no data has been entered yet, in this case we return an empty array
        if(common_utils.isEmptyOrZeroLength(this.all_table_attributes) && !common_utils.isEmptyOrZeroLength(this.columns.columns)){
            //purpose of this is to break out of the waterfall but return an empty array
            return callback(OK_ERR, []);
        } else if(common_utils.isEmptyOrZeroLength(this.all_table_attributes) && common_utils.isEmptyOrZeroLength(this.statement.from)){
            //this scenario is reached by doing a select with only calculations
            let results = [];
            try {
                results = alasql(this.statement.toString());

            } catch(e){
                return callback(e);
            }
            //purpose of this is to break out of the waterfall but return the results
            return callback(OK_ERR, results);
        }

        return callback();
    }

    /**
     *extracts the table info from the attributes
     */
    [getTables](){
        let tbls = [];
        this.all_table_attributes.forEach((attribute)=>{
            tbls.push(attribute.table);
        });

        this.tables = _.uniqBy(tbls, (tbl)=>{
            return[tbl.databaseid, tbl.tableid, tbl.as].join();
        });
    }

    /**
     *gets the raw column from each section of the statement and puts them in a map
     */
    [getColumns](){
        //before pulling the raw columns we need to set the order by so that aliases match the raw column / function definition
        if(!common_utils.isEmptyOrZeroLength(this.statement.order)){
            //we need to loop each element of the order by and see if it's columnid actually matches an alias in the select.
            // if the order by column is an alias we replace the alias with the actual expression from the select
            this.statement.order.forEach((order_by)=>{
                let found = this.statement.columns.filter((column) => {
                    return common_utils.isEmpty(order_by.expression.tableid) && column.as === order_by.expression.columnid;
                });

                if(found.length > 0){
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
     *iterates an ast segment columns and returns the found column
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
     * @param callback
     */
    [getAttributeValues](callback){
        //get all unique attributes
        this[addFetchColumns](this.columns.joins);

        // in order to perform is null conditions we need to bring in the hash attribute to make sure we coalesce the objects so records that have null values are found.
        let where_string = null;
        try {
            where_string = this.statement.where ? this.statement.where.toString() : '';
        } catch(e){
            return callback(e);
        }
        if(this.columns.where) {
            this[addFetchColumns](this.columns.where);
        }

        //the bitwise or '|' is intentionally used because i want both conditions checked regardless of whether the left condition is false
        if( (!this.columns.where && this.fetch_attributes.length === 0) | where_string.indexOf(WHERE_CLAUSE_IS_NULL) > -1 ) {
            //get unique ids of tables if there is no join or the where is performing an is null check
            this.tables.forEach((table)=>{
                let hash_attribute = {
                    columnid: global.hdb_schema[table.databaseid][table.tableid].hash_attribute,
                    tableid:table.tableid
                };
                let found = this[findColumn](hash_attribute);
                this.fetch_attributes.push(found);
            });
        }

        this[addFetchColumns](this.columns.order);


        this.fetch_attributes = _.uniqBy(this.fetch_attributes, (attribute)=>{
            return[attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join();
        });

        async.each(this.fetch_attributes, (attribute, caller)=>{
            let attribute_path = '';
            let is_hash = false;
            //check if this attribute is the hash attribute for a table, if it is we need to read the files from the __hdh_hash folder, otherwise pull from the value index
            if(attribute.attribute === global.hdb_schema[attribute.table.databaseid][attribute.table.tableid].hash_attribute){
                is_hash = true;
                attribute_path = common_utils.buildFolderPath(base_path, attribute.table.databaseid, attribute.table.tableid, HDB_HASH_FOLDER_NAME, attribute.attribute);
            } else {
                attribute_path = common_utils.buildFolderPath(base_path, attribute.table.databaseid, attribute.table.tableid, attribute.attribute);
            }


            let object_path = common_utils.buildFolderPath(attribute.table.databaseid, attribute.table.tableid, attribute.attribute);
            //if there exact match values for this attribute we just assign them to the attribute, otherwise we pull the index to get all values
            if(!common_utils.isEmpty(this.exact_search_values[object_path]) && !this.exact_search_values[object_path].ignore &&
                !common_utils.isEmptyOrZeroLength(this.exact_search_values[object_path].values)){
                if(is_hash){
                    this[checkHashValueExists](attribute_path, Array.from(this.exact_search_values[object_path].values), (err, existing_values)=>{
                        if(err){
                            return caller(err);
                        }

                        attribute.values = existing_values;
                        return caller();
                    });
                } else {
                    attribute.values = Array.from(this.exact_search_values[object_path].values);
                    return caller();
                }
            } else {

                fs.readdir(attribute_path, (err, values) => {
                    if (err) {
                        return caller(err);
                    }
//if this is a hash attribute we need to strip out the extension '.hdb'
                    if (is_hash) {
                        attribute.values = [];
                        values.forEach((value) => {
                            attribute.values.push(this[stripFileExtension](value));
                        });
                    } else {
                        attribute.values = values;
                    }

                    caller();
                });
            }
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback();
        });
    }

    /***
     * checks to make sure the hash value exists, especially important for when people do search based on primary key
     * @param attribute_path
     * @param values
     * @param callback
     */
    [checkHashValueExists](attribute_path, values, callback){
        let existing_values = [];
        async.forEach(values, (value, callback2)=>{
            fs.access(common_utils.buildFolderPath(attribute_path, value + HDB_EXTENSION), fs.constants.F_OK, (err) => {
                if(common_utils.isEmpty(err)){
                    existing_values.push(value);
                    return callback2();
                } else if(err.code !== ENOENT_CODE){
                    return callback2(err);
                }

                callback2();
            });
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback(null, existing_values);
        });
    }

    /**
     *initializes this.data and retrieves the ids for each attribute value
     * @param callback
     */
    [retrieveIds](callback){
        this.tables.forEach((table)=>{
            this.data[`${table.databaseid}_${table.tableid}`] = {};
            //attributes_data[`${table.schema}_${table.table}`].__hash_values = new Set();
            this.data[`${table.databaseid}_${table.tableid}`].__hash_name = global.hdb_schema[table.databaseid][table.tableid].hash_attribute;
            this.data[`${table.databaseid}_${table.tableid}`].__merged_data = {};
            this.data[`${table.databaseid}_${table.tableid}`].__has_hash = false;
        });

        let blob_paths = {};
        async.each(this.fetch_attributes, (attribute, caller)=>{
            this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`] = {};
            let hash_name = this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__hash_name;

            if(attribute.attribute === hash_name){
                this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__has_hash = true;
                attribute.values.forEach((value)=>{
                    let autocast_value = common_utils.autoCast(value);
                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_value] = {};
                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_value] = autocast_value;
                });
                caller();
            } else {
                let sub_path = common_utils.buildFolderPath(attribute.table.databaseid, attribute.table.tableid, attribute.attribute);
                let attribute_path = common_utils.buildFolderPath(base_path, sub_path);

                async.each(attribute.values, (value, call)=>{
                    let escaped_value = value.replace(escaped_slash_regex, '/');
                    fs.readdir(common_utils.buildFolderPath(attribute_path,value), (err, ids)=>{
                        if(err && err.code !== ENOENT_CODE){
                            return call(err);
                        }

                        if(!common_utils.isEmptyOrZeroLength(ids)){
                            ids.forEach((id)=>{
                                if(id === BLOB_FOLDER_NAME){
                                    blob_paths[common_utils.buildFolderPath(sub_path, value)] = attribute;
                                } else {
                                    //this removes the .hdb extension from the end of the file name in a more performant way than replace
                                    id = this[stripFileExtension](id);
                                    let autocast_id = common_utils.autoCast(id);
                                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_id] = {};
                                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_id] = common_utils.autoCast(escaped_value);
                                }
                            });
                        }

                        call();
                    });

                }, (error)=>{
                    //clear out memory
                    attribute.values = null;

                    if(error){
                        return caller(error);
                    }

                    caller();
                });
            }
        }, (err)=>{
            if(err){
                return callback(err);
            }
            callback(null, blob_paths);
        });
    }

    /**
     *reads actual files when the byte length of the value exceeds 255 bytes.
     * @param blob_paths - path to the blob files to read
     * @param callback
     * @returns {*}
     */
    [readBlobFilesForSetup](blob_paths, callback){
        let keys = Object.keys(blob_paths);

        if(!keys || keys.length === 0 ){
            return callback();
        }

        async.eachLimit(keys, async_limit, (key, caller)=>{
            let column = blob_paths[key];
            fs.readdir(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME), (err, ids)=>{
                if(common_utils.isEmptyOrZeroLength(ids)){
                    return caller();
                }
                async.eachLimit(ids, async_limit, (id, call)=>{
                    let the_id = common_utils.autoCast(this[stripFileExtension](id));
                    fs.readFile(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME, id), (err, file_data)=>{
                        this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id] = {};
                        this.data[`${column.table.databaseid}_${column.table.tableid}`][`${column.attribute}`][the_id] = common_utils.autoCast(file_data.toString());
                        call();
                    });
                }, ()=>{
                    caller();
                });
            });
        }, ()=>{
            callback();
        });
    }

    /**
     *converts the raw indexed data into individual rows by hash attribute
     * @param callback
     */
    //consolidate based on tables
    [consolidateData](callback){
        async.each(Object.keys(this.data), (table, caller)=>{
            let hash_name = this.data[table].__hash_name;
            let object_keys = Object.keys(this.data[table].__merged_data);

            //here we set up the hash value on every object
            object_keys.forEach((id_value) =>{
                this.data[table].__merged_data[id_value][hash_name] = common_utils.autoCast(id_value);
            });

            Object.keys(this.data[table]).forEach((attribute)=>{
                if(exclude_attributes.indexOf(attribute) >= 0 || attribute === hash_name){
                    return;
                }

                object_keys.forEach((value)=>{
                    value = value.replace(escaped_slash_regex, '/');

                    if(this.data[table][attribute][value] === null || this.data[table][attribute][value] === undefined){
                        this.data[table].__merged_data[value][attribute] = null;
                    } else {
                        this.data[table].__merged_data[value][attribute] = this.data[table][attribute][value];
                    }
                });
                //This is to free up memory, after consolidation we no longer need these values
                this.data[table][attribute] = null;
            });

            caller();
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback();
        });
    }

    /**
     *takes an intitial pass on the data by processing just the joins, conditions and order by.
     * This allows us to limit the broader select based on just the ids we need based on this pass
     * @param callback
     */
    [processJoins](callback){
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
            joined = alasql(`SELECT ${select.join(',')} FROM ${from_clause.join(' ')} ${where_clause} ${order_clause} ${limit}`, table_data);
        } catch(e){
            return callback(e);
        }

        if(joined && joined.length > 0) {
//here we get the keys for each hash attribute and compare them to what we have in merged data. we then pair down the results for later use.
            joined.forEach((row) => {
                hash_attributes.forEach((hash) => {
                    if(row[hash.key] !== null && row[hash.key] !== undefined){
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

        return callback(null, existing_attributes, joined.length);
    }

    /***
     *
     * @param existing_attributes
     * @param callback
     */
    [decideReadPattern](existing_attributes, row_count, callback){
        if(row_count === 0){
            return callback();
        }
        let all_columns = [];
        let iterator = new RecursiveIterator(this.columns);
        for(let {node} of iterator) {
            if (node && node.columnid) {
                let found = this[findColumn](node);
                if(found && existing_attributes[found.table.tableid].indexOf(found.attribute) < 0){
                    all_columns.push(found);
                }
            }
        }

        all_columns = _.uniqBy(all_columns, (attribute)=>{
            return[attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join();
        });

        let read_function;
        if(row_count > RAW_FILE_READ_LIMIT){
            read_function = this[readAttributeValues].bind(this);
        } else{
            read_function = this[readRawFiles].bind(this);
        }

        read_function(all_columns, (err)=>{
            if(err){
                return callback(err);
            }

            return callback();
        });
    }

    /***
     * setup function for getting all object values from raw files rather than from the indices
     * figures out the remaining attributes to retrieve and the ids, both used to generate paths to open  all the files
     * this can be slow as it is overhead intensive
     * @param all_columns
     * @param callback
     */
    [readRawFiles](all_columns, callback) {
        async.eachLimit(all_columns, 1, (the_column, callback2)=>{
            let ids = Object.keys(this.data[`${the_column.table.databaseid}_${the_column.table.tableid}`].__merged_data);
            this[readAttributeFilesByIds](the_column, ids, ()=>{
                callback2();
            });
        }, ()=>{
            callback();
        });
    }

    /***
     * reads the actual hdb files which in small batches is more performant
     * @param column
     * @param ids
     * @param callback
     */
    [readAttributeFilesByIds](column, ids, callback){
        let attribute_path = common_utils.buildFolderPath(base_path, column.table.databaseid, column.table.tableid, HDB_HASH_FOLDER_NAME, column.attribute);
        async.eachLimit(ids, async_limit, (id, callback2)=>{
            fs.readFile(common_utils.buildFolderPath(attribute_path, id + HDB_EXTENSION), (err, data)=>{
                if(err && err.code === ENOENT_CODE){
                    this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[id][column.attribute] = null;
                    return callback2();
                } else if(err) {
                    return callback2(err);
                }

                let the_value = common_utils.autoCast(data.toString());
                this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[id][column.attribute] = the_value;

                callback2();
            });
        }, (err)=>{
            callback(err);
        });
    }

    /**
     *reads the values for all remaining attributes not processed in the initial pass on the data.
     * the data retained is limited to the ids evaluated from processJoIns
     * @param all_columns
     * @param callback
     */
    [readAttributeValues](all_columns, callback){
        let blob_paths = {};
        async.each(all_columns, (column, call)=>{
            let sub_path = common_utils.buildFolderPath(column.table.databaseid, column.table.tableid, column.attribute);

            let attribute_path = common_utils.buildFolderPath(base_path,sub_path);
            fs.readdir(attribute_path, (err, results)=>{
                async.eachLimit(results, async_limit, (value, caller)=>{
                    let the_value = common_utils.autoCast(value.replace(escaped_slash_regex, '/'));
                    fs.readdir(common_utils.buildFolderPath(attribute_path,value), (err, ids)=>{
                        ids.forEach((id)=>{
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
                        });
                        caller();
                    });
                }, (err)=>{
                    call();
                });
            });
        }, (err)=>{
            if(err){
                return callback(err);
            }

            this[readBlobFiles](blob_paths, (err)=>{
                if(err){
                    return callback(err);
                }

                return callback();
            });
        });
    }

    /**
     *reads actual files when the byte length of the value exceeds 255 bytes.
     * @param blob_paths - path to the blob files to read
     * @param callback
     * @returns {*}
     */
    [readBlobFiles](blob_paths, callback){
        let keys = Object.keys(blob_paths);

        if(!keys || keys.length === 0 ){
            return callback();
        }

        async.eachLimit(keys, async_limit, (key, caller)=>{
            let column = blob_paths[key];
            fs.readdir(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME), (err, ids)=>{
                if(common_utils.isEmptyOrZeroLength(ids)){
                    return caller();
                }

                async.eachLimit(ids, async_limit, (id, call)=>{
                    let the_id = common_utils.autoCast(this[stripFileExtension](id));
                    let the_key = this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                    if(the_key) {
                        fs.readFile(common_utils.buildFolderPath(base_path,key,BLOB_FOLDER_NAME, id), (err, file_data)=>{
                            this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = common_utils.autoCast(file_data.toString());
                            call();
                        });
                    } else {
                        call();
                    }
                }, ()=>{
                    caller();
                });
            });
        }, ()=>{
            return callback();
        });
    }

    /**
     *takes all of the raw data and executes the full SQL from the AST against the data.
     * @param callback
     */
    [finalSQL](callback){
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

        try {
            let sql = this[buildSQL]();
            let final_results = alasql(sql, table_data);
            return callback(null, final_results);
        } catch(e){
            return callback(e);
        }
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