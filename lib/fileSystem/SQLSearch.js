'use strict';

/**
 * SQLSearch.js
 * This class is used to receive the alasql generated AST from a SQL SELECT,
 * process the HarperDB file system and return results by passing the raw values into the alasql SQL parser
 */

const async = require('async'),
    _ = require('lodash'),
    autocast = require('autocast'),
    ls = require('node-ls'),
    alasql = require('alasql'),
    alasql_function_importer = require('../../sqlTranslator/alasqlFunctionImporter'),
    fs = require('fs'),
    clone = require('clone'),
    RecursiveIterator = require('recursive-iterator'),
    path = require('path'),
    PropertiesReader = require('properties-reader'),
    sql_keywords = require('../../json/sqlKeywords'),
    common_utils = require('../../utility/common_utils'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));

const findTable = Symbol('findTable'),
    readFolderValues = Symbol('readFolderValues'),
    getAttributeValues = Symbol('getAttributeValues'),
    evaluateConditions = Symbol('evaluateConditions'),
    retrieveIds =Symbol('retrieveIds'),
    consolidateData = Symbol('consolidateData'),
    processJoins = Symbol('processJoins'),
    getColumns = Symbol('getColumns'),
    findColumn = Symbol('findColumn'),
    getTables = Symbol('getTables'),
    readAttributeValues = Symbol('readAttributeValues'),
    finalSQL = Symbol('finalSQL'),
    cleanSQL = Symbol('cleanSQL'),
    readBlobFiles = Symbol('readBlobFiles'),
    addFetchColumns = Symbol('addFetchColumns'),
    buildSQL = Symbol('buildSQL');


const exclude_attributes = ['__hash_values','__hash_name','__merged_data','__has_hash'],
    escaped_slash_regex = /U\+002F/g,
    base_path = path.join(hdb_properties.get('HDB_ROOT'), 'schema'),
    //TODO research how best to optimize this number for async.eachLimit
    async_limit = 50;

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
        this.tables = [];

        //holds the data from the file system to be evalueted by the sql processor
        this.data = {};

        this[getColumns]();
        this[getTables]();
    }

    /**
     *starting point function to execute the search
     * @param callback
     */
    search(callback){
        async.waterfall([
                this[getAttributeValues].bind(this),
                this[retrieveIds].bind(this),
                this[consolidateData].bind(this),
                this[processJoins].bind(this),
                this[readAttributeValues].bind(this),
                this[readBlobFiles].bind(this),
                this[finalSQL].bind(this)
            ],
            (err, results)=>{
                if(err){
                    return callback(err);
                }
                callback(null, results);
        });
    }

    /**
     *extracts the table info from the attributes
     */
    [getTables](){
        let tbls = new Set();
        this.all_table_attributes.forEach((attribute)=>{
            tbls.add(attribute.table);
        });

        this.tables = [...tbls];
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


        var iterator = new RecursiveIterator(this.statement);
        for(let {node, path} of iterator) {
            if(node && node.columnid){
                if(!this.columns[path[0]]){
                    this.columns[path[0]] = [];
                }
                this.columns[path[0]].push(node);
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
            } else {
                return attribute.attribute === column.columnid;
            }
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
                    this.fetch_attributes.push(found);
                }
            });
        }
    }

    /**
     *gets  the list of all attribute values for the where & join attributes
     * @param callback
     */
    [getAttributeValues](callback){
        //get all unique attributes
        this[addFetchColumns](this.columns.joins);

        if(this.columns.where) {
            this[addFetchColumns](this.columns.where);
        } else if(this.fetch_attributes.length === 0) {
            //get unique ids of tables if there is no join
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
            let attribute_path = common_utils.buildFolderPath(base_path, attribute.table.databaseid, attribute.table.tableid, attribute.attribute);

            ls(attribute_path, '-a', (err, values) => {
                if (err) {
                    return caller(err);
                }

                attribute.values = values;
                caller();
            });
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback();
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

        async.each(this.fetch_attributes, (attribute, caller)=>{
            this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`] = {};
            let hash_name = this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__hash_name;

            if(attribute.attribute === hash_name){
                this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__has_hash = true;
                attribute.values.forEach((value)=>{
                    let autocast_value = autocast(value);
                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_value] = {};
                    this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_value] = autocast_value;
                });
                caller();
            } else {
                let attribute_path = common_utils.buildFolderPath(base_path, attribute.table.databaseid, attribute.table.tableid, attribute.attribute);

                async.each(attribute.values, (value, call)=>{
                    let escaped_value = value.replace(escaped_slash_regex, '/');
                    ls(common_utils.buildFolderPath(attribute_path,value), '-a', (err, ids)=>{
                        ids.forEach((id)=>{
                            //this removes the .hdb extension from the end of the file name in a more performant way than replace
                            id = id.substr(0, id.length-4);
                            let autocast_id = autocast(id);
                            this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_id] = {};
                            this.data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_id] = autocast(escaped_value);
                        });

                        call();
                    });
                }, (error)=>{
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
            let object_keys = Object.keys(this.data[table].__merged_data);
            let has_hash = this.data[table].__has_hash;
            Object.keys(this.data[table]).forEach((attribute)=>{
                if(exclude_attributes.indexOf(attribute) >= 0){
                    return;
                }

                object_keys.forEach((value)=>{
                    value = value.replace(escaped_slash_regex, '/');
                    if(!has_hash){
                        this.data[table].__merged_data[value][`${this.data[table].__hash_name}`] = autocast(value);
                    }
                    if(this.data[table][attribute][value] === null || this.data[table][attribute][value] === undefined){
                        this.data[table].__merged_data[value][attribute] = null;
                    } else {
                        this.data[table].__merged_data[value][attribute] = this.data[table][attribute][value];
                    }
                });

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
        let from_clause = [
            '? ' + (from_statement.as ? ' AS ' + from_statement.as : from_statement.tableid)
        ];

        table_data.push(Object.values(this.data[`${from_statement.databaseid}_${from_statement.tableid}`].__merged_data));


        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                let from = join.joinmode + ' JOIN ? AS ' + (join.as ? join.as : join.table.tableid);

                if(join.on) {
                    from += ' ON ' + join.on.toString();
                }
                from_clause.push(from);
                table_data.push(Object.values(this.data[`${join.table.databaseid}_${join.table.tableid}`].__merged_data));
            });
        }

        //record the fetched attributes so we can compare to what else needs to be grabbed from them file system

        let hash_attributes = [];
        let existing_attributes = {};
        this.tables.forEach((table)=>{
            let hash = this.data[`${table.databaseid}_${table.tableid}`].__hash_name;
            hash_attributes.push({
                key:`'${table.tableid}.${hash}'`,
                schema:table.databaseid,
                table:table.tableid,
                keys: new Set()
            });
            select.push(`${(table.as ? table.as : table.tableid)}.${hash} AS "${table.tableid}.${hash}"`);

            for(let prop in this.data[`${table.databaseid}_${table.tableid}`].__merged_data){
                existing_attributes[table.tableid] = Object.keys(this.data[`${table.databaseid}_${table.tableid}`].__merged_data[prop]);
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

        callback(null, existing_attributes);
    }

    /**
     *reads the values for all remaining attributes not processed in the initial pass on the data.
     * the data retained is limited to the ids evaluated from processJoIns
     * @param existing_attributes
     * @param callback
     */
    [readAttributeValues](existing_attributes, callback){
        //get all needed attributes from the full select
        let all_columns = new Set();
        var iterator = new RecursiveIterator(this.statement);
        for(let {node} of iterator) {
            if (node && node.columnid) {
                let found = this[findColumn](node);
                if(found && existing_attributes[found.table.tableid].indexOf(found.attribute) < 0){
                    all_columns.add(found);
                }
            }
        }

        let blob_paths = {};
        async.each(all_columns, (column, call)=>{
            let sub_path = common_utils.buildFolderPath(column.table.databaseid, column.table.tableid, column.attribute);

            let attribute_path = common_utils.buildFolderPath(base_path,sub_path);
            fs.readdir(attribute_path, (err, results)=>{
                async.eachLimit(results, async_limit, (value, caller)=>{
                    let the_value = autocast(value.replace(escaped_slash_regex, '/'));
                    fs.readdir(common_utils.buildFolderPath(attribute_path,value), (err, ids)=>{
                        ids.forEach((id)=>{
                            if(id==='blob'){
                                if(!blob_paths[sub_path+value]){
                                    blob_paths[sub_path+value] = column;
                                }
                            } else{
                                //the substr removes the .hdb more efficiently
                                let the_id = autocast(id.substr(0, id.length-4));
                                let the_key = this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                                if(the_key) {
                                    this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = the_value;
                                }
                            }
                        });
                        caller()
                    });
                }, (err)=>{
                    call();
                });
            });
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
    [readBlobFiles](blob_paths, callback){
        let keys = Object.keys(blob_paths);

        if(!keys || keys.length === 0 ){
            return callback();
        }

        async.eachLimit(keys, async_limit, (key, caller)=>{
            let column = blob_paths[key];
            fs.readdir(common_utils.buildFolderPath(base_path,key,'blob'), (err, ids)=>{
                async.eachLimit(ids, async_limit, (id, call)=>{
                    //the substr removes the .hdb more efficiently
                    let the_id = autocast(id.substr(0, id.length-4));
                    let the_key = this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                    if(the_key) {
                        fs.readFile(common_utils.buildFolderPath(base_path,key,'blob', id), (err, file_data)=>{
                            this.data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = autocast(file_data.toString());
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
            callback();
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
        table_data.push(Object.values(this.data[`${from_statement.databaseid}_${from_statement.tableid}`].__merged_data));
        from_statement.as = (from_statement.as ? from_statement.as : from_statement.tableid);
        from_statement.databaseid = '';
        from_statement.tableid = '?';

        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                join.as = (join.as ? join.as : join.table.tableid);

                table_data.push(Object.values(this.data[`${join.table.databaseid}_${join.table.tableid}`].__merged_data));
                join.table.databaseid = '';
                join.table.tableid = '?';
            });
        }

        let sql = this[buildSQL]();
        try {
            let final_results = alasql(sql, table_data);
            callback(null, final_results);
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
        let iterator = new RecursiveIterator(this.statement);
        for(let {node} of iterator) {
            if(!common_utils.isEmpty(node)) {
                if (!common_utils.isEmpty(node.columnid) && sql_keywords.indexOf(node.columnid.toUpperCase()) >= 0) {
                    node.columnid = `[${node.columnid}]`;
                }

                if (!common_utils.isEmpty(node.as) && sql_keywords.indexOf(node.as.toUpperCase()) >= 0) {
                    node.as = `[${node.as}]`;
                }
            }
        }


        let sql = this.statement.toString();

        this.statement.columns.filter((column)=>{
            if(column.funcid && column.as){
                let column_string = column.toString()
                    .replace(' AS ' + column.as, '');
                sql = sql.replace(column.toString(), column_string);
            }

            if(column.as !== null && column.as !== undefined && sql_keywords.indexOf(column.as)){
                column.toString()
            }
        });

        return sql;
    }

}



module.exports = FileSearch;