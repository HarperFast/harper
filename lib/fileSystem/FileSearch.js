const async = require('async'),
    _ = require('lodash'),
    autocast = require('autocast'),
    ls = require('node-ls'),
    alasql = require('alasql'),
    fs = require('fs'),
    RecursiveIterator = require('recursive-iterator'),
    clone = require('clone');

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
    readAttributeFiles = Symbol('readAttributeFiles'),
    readAttributeValues = Symbol('readAttributeValues'),
    readFiles = Symbol('readFiles'),
    finalSQL = Symbol('finalSQL'),
    cleanSQL = Symbol('cleanSQL');

const exclude_attributes = ['__hash_values','__hash_name','__merged_data','__has_hash'],
    join_regex = /, (\w+|\w+ \w+) JOIN/g,
    escaped_slash_regex = /U\+002F/g;

class FileSearch{
    constructor(statement, attributes, base_path){
        this.statement = statement;
        this.columns = {};
        this.base_path = base_path;
        this.all_table_attributes = attributes;
        this.attributes = [];
        this.tables = [];

        this[getColumns]();
        this[getTables]();
    }

    search(callback){
        async.waterfall([
                this[getAttributeValues].bind(this),
                this[retrieveIds].bind(this),
                this[consolidateData].bind(this),
                this[processJoins].bind(this),
                //this[readAttributeFiles].bind(this),
                this[readAttributeValues].bind(this),
                this[finalSQL].bind(this)
            ],
            (err, data)=>{
                if(err){
                    return callback(err);
                }
                callback(null, data);
        });
    }

    [getTables](){
        let tbls = new Set();
        this.all_table_attributes.forEach((attribute)=>{
            tbls.add(attribute.table);
        });

        this.tables = [...tbls];
    }

    //gets the raw column from each section of the statement and puts them in a map
    [getColumns](){
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

    [findColumn](column){
        //TODO manage *

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

        let found = clone(found_columns[0]);

        return found;
    }

    [getAttributeValues](callback){
        //get all unique attributes
        let columns = [];

        if(this.columns.joins) {
            columns.push(...this.columns.joins);
        }

        if(this.columns.where) {
            columns = columns.concat(this.columns.where);
        } else if(columns.length === 0) {
            //get unique ids of tables if there is no join
            this.tables.forEach((table)=>{
                 columns.push({
                    columnid: global.hdb_schema[table.databaseid][table.tableid].hash_attribute,
                    tableid:table.tableid
                });
            });
        }

        if(this.columns.order) {
            columns.push(...this.columns.order);
        }

        this.attributes = [];
        columns.forEach((column)=>{
            let found = this[findColumn](column);
            if(found){
                this.attributes.push(found);
            }
        });

        this.attributes = _.uniqBy(this.attributes, (attribute)=>{
            return[attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join();
        });

        async.each(this.attributes, (attribute, caller)=>{
            let attribute_path = `${this.base_path}/${attribute.table.databaseid}/${attribute.table.tableid}/${attribute.attribute}/`;
            ls(attribute_path, '-a', (err, values)=>{
                if(err){
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

    [retrieveIds](callback){
        //group attributes by table
        let hash_values = {};
        let attributes_data = {};
        //let hash_name = global.hdb_schema[this.attributes[0].schema][this.attributes[0].table].hash_attribute;

        this.tables.forEach((table)=>{
            attributes_data[`${table.databaseid}_${table.tableid}`] = {};
            //attributes_data[`${table.schema}_${table.table}`].__hash_values = new Set();
            attributes_data[`${table.databaseid}_${table.tableid}`].__hash_name = global.hdb_schema[table.databaseid][table.tableid].hash_attribute;
            attributes_data[`${table.databaseid}_${table.tableid}`].__merged_data = {};
            attributes_data[`${table.databaseid}_${table.tableid}`].__has_hash = false;
        });

        /*let hash_names = this.tables.filter((table)=>{
            return  `${table.}` global.hdb_schema[table.schema][table.table].hash_attribute;
        });*/

        async.each(this.attributes, (attribute, caller)=>{
            attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`] = {};
            let hash_name = attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__hash_name;

            if(attribute.attribute === hash_name){
                attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__has_hash = true;
                attribute.values.forEach((value)=>{
                    //attributes_data[`${attribute.schema}_${attribute.table}`].__hash_values.add(autocast(value));
                    let autocast_value = autocast(value);
                    attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_value] = {};
                    attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_value] = autocast_value;
                });
                caller();
            } else {
                let attribute_path = `${this.base_path}/${attribute.table.databaseid}/${attribute.table.tableid}/${attribute.attribute}/`;

                async.each(attribute.values, (value, call)=>{
                    ls(attribute_path+value, '-a', (err, ids)=>{
                        ids.forEach((id)=>{
                            id = id.replace('.hdb', '');
                            let autocast_id = autocast(id);
                            attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast_id] = {};
                            //attributes_data[`${attribute.schema}_${attribute.table}`].__hash_values.add(autocast(id));
                            attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][autocast_id] = autocast(value);
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
            callback(null, attributes_data);
        });
    }



    //consolidate based on tables
    [consolidateData](data, callback){
        async.each(Object.keys(data), (table, caller)=>{
            /*let merged_data = {};
            data[table].__hash_values.forEach((value)=>{
                merged_data[value] = {};
                //merged_data[value][`${table.__hash_name}`] = value;
            });*/
            let hash_values = Object.keys(data[table].__merged_data);
            let has_hash = data[table].__has_hash;
            Object.keys(data[table]).forEach((attribute)=>{
                if(exclude_attributes.indexOf(attribute) >= 0){
                    return;
                }

                hash_values.forEach((value)=>{
                    value = value.replace(escaped_slash_regex, '/');
                    if(!has_hash){
                        data[table].__merged_data[value][`${data[table].__hash_name}`] = autocast(value);
                    }
                    if(data[table][attribute][value] === null || data[table][attribute][value] === undefined){
                        data[table].__merged_data[value][attribute] = null;
                    } else {
                        data[table].__merged_data[value][attribute] = data[table][attribute][value];
                    }
                });

            });

            //data[table].__merged_data = Object.values(data[table].__merged_data);
            caller();
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback(null, data);
        });
    }

    [processJoins](data, callback){
        //fs.writeFileSync('../test/data.json', JSON.stringify(data));
        let table_data = [];
        let select = [];
        //TODO posibbly need to loop the from here, need to investigate
        let from_statement = this.statement.from[0];
        let from_clause = [
            '? ' + (from_statement.as ? ' AS ' + from_statement.as : from_statement.tableid)
        ];

        table_data.push(Object.values(data[`${from_statement.databaseid}_${from_statement.tableid}`].__merged_data));


        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                let from = join.joinmode + ' JOIN ? AS ' + (join.as ? join.as : join.table.tableid);

                if(join.on) {
                    from += ' ON ' + join.on.toString();
                }
                from_clause.push(from);
                table_data.push(Object.values(data[`${join.table.databaseid}_${join.table.tableid}`].__merged_data));
            });
        }

        //record the fetched attributes so we can compare to what else needs to be grabbed from them file system

        let hash_attributes = [];
        let existing_attributes = {};
        this.tables.forEach((table)=>{
            let hash = data[`${table.databaseid}_${table.tableid}`].__hash_name;
            hash_attributes.push({
                key:`'${table.tableid}.${hash}'`,
                schema:table.databaseid,
                table:table.tableid,
                keys: new Set()
            });
            select.push(`${(table.as ? table.as : table.tableid)}.${hash} AS "${table.tableid}.${hash}"`);

            for(let prop in data[`${table.databaseid}_${table.tableid}`].__merged_data){
                existing_attributes[table.tableid] = Object.keys(data[`${table.databaseid}_${table.tableid}`].__merged_data[prop]);
                break;
            }
        });

        //TODO there is an error with between statements being converted back to string.  need to handle
        let where_clause = this.statement.where ? 'WHERE ' + this.statement.where : '';

        let order_clause = '';
        if(this.statement.order){
            let order = [];
            this.statement.order.forEach((order_by)=>{
                order.push(order_by.toString() + ' ' + order_by.direction);
            });

            let order_clause = 'ORDER BY ' + order.join(',');
        }

        let limit = this.statement.limit ? 'LIMIT ' + this.statement.limit : '';

//we should only select the primary key of each table then remove the rows that exist from each table
        let joined = alasql(`SELECT ${select.join(',')} FROM ${from_clause.join(' ')} ${where_clause} ${order_clause} ${limit}`, table_data);

        if(joined && joined.length > 0) {
//here we get the keys for each hash attribute and compare them to what we have in merged data. we then pair down the results for later use.
            joined.forEach((row) => {
                hash_attributes.forEach((hash) => {
                    hash.keys.add(row[hash.key].toString());
                });
            });

            hash_attributes.forEach((hash) => {
                let keys = Object.keys(data[`${hash.schema}_${hash.table}`].__merged_data);
                let delete_keys = _.difference(keys, [...hash.keys]);
                delete_keys.forEach((key) => {
                    delete data[`${hash.schema}_${hash.table}`].__merged_data[key];
                });
            });
        }

        callback(null, data, existing_attributes);
    }

    [readAttributeValues](data, existing_attributes, callback){
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

        async.each(all_columns, (column, call)=>{
            let attribute_path = `${this.base_path}/${column.table.databaseid}/${column.table.tableid}/${column.attribute}/`;
            let keys = Object.keys(data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data);
            fs.readdir(attribute_path, (err, results)=>{
                async.eachLimit(results, 100, (value, caller)=>{
                    let the_value = autocast(value.replace(escaped_slash_regex, '/'));
                    fs.readdir(attribute_path+value, (err, ids)=>{
                        /*let match_keys = _.intersectionWith(keys, ids, (a,b)=>{
                            return a === b.replace('.hdb', '');
                        });
                        if(!match_keys || match_keys.length === 0){
                            return caller();
                        }*/
                        ids.forEach((id)=>{
                            let the_id = autocast(id.replace('.hdb', ''));
                            let the_key = data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id];
                            if(the_key) {
                                data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[the_id][column.attribute] = the_value;
                            }
                        });
                        //all_ids[dir+value] = ids;
                        caller()
                    });
                }, (err)=>{
                    call();
                });
            });
        }, (err)=>{
            console.error(err);

            callback(null, data);
        });
    }

    [readAttributeFiles](data, existing_attributes, callback){
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

        //fetch needed attributes
        async.each(all_columns, (column, caller)=>{
            let attribute_path = `${this.base_path}/${column.table.databaseid}/${column.table.tableid}/__hdb_hash/${column.attribute}/`;
            let keys = Object.keys(data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data);
            this[readFiles](attribute_path, keys, (err, results)=>{
                if(err){
                    return caller(err);
                }

                keys.forEach((key)=>{
                    data[`${column.table.databaseid}_${column.table.tableid}`].__merged_data[key][column.attribute] = results[key] ? autocast(results[key]) : null;
                });

                caller();
            });
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback(null, data);
        });

        //perform full sql
    }

    [readFiles](attribute_path, hash_files, callback){
        let attribute_data = {};
        async.eachLimit(hash_files, 1000, (file, caller)=>{
            fs.readFile(`${attribute_path}${file}.hdb`, 'utf-8', (error, data)=>{
                if(error){
                    if(error.code === 'ENOENT'){
                        caller(null, null);
                    } else {
                        caller(error);
                    }
                    return;
                }

                let value = autocast(data.toString());
                //autocast is unable to convert string to object/array so we need to figure it out
                if(typeof value === 'string'){
                    if((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))){
                        try{
                            value = JSON.parse(value);
                        }catch(e){
                        }
                    }
                }

                attribute_data[file]=value;
                caller();
            });
        }, (err)=>{
            if(err){
                callback(err);
                return;
            }

            callback(null, attribute_data);
        });
    }

    [finalSQL](data, callback){
        let table_data = [];
        //TODO posibbly need to loop the from here, need to investigate
        let from_statement = this.statement.from[0];
        table_data.push(Object.values(data[`${from_statement.databaseid}_${from_statement.tableid}`].__merged_data));
        from_statement.as = (from_statement.as ? from_statement.as : from_statement.tableid);
        from_statement.databaseid = '';
        from_statement.tableid = '?';

        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                join.as = (join.as ? join.as : join.table.tableid);

                table_data.push(Object.values(data[`${join.table.databaseid}_${join.table.tableid}`].__merged_data));
                join.table.databaseid = '';
                join.table.tableid = '?';
            });
        }

        let sql = this[cleanSQL]();

        let final_results = alasql(sql, table_data);

        callback(null, final_results);
    }

    [cleanSQL](){
        let sql = this.statement.toString();

        let matches= sql.match(join_regex);

        if(matches && matches.length > 0){
            matches.forEach((match)=>{
                sql = sql.replace(match, match.replace(',', ''));
            });
        }

        //clean up order by: the sort direction is stripped on conversion back
        if(this.statement.order){
            let order_by_index = sql.lastIndexOf('ORDER BY');

            //let order_by_clause = sql.substr(order_by_index + 9, sql.length);
            let order_by_array = [];
            this.statement.order.forEach((order_by, index, array)=>{
                order_by_array.push(order_by.toString() + ' ' + order_by.direction);
            });

            sql = sql.substr(0, order_by_index + 9) + order_by_array.join(',');

            if(this.statement.limit){
                sql += ' LIMIT ' + this.statement.limit;
            }
        }

        return sql;
    }
}



module.exports = FileSearch;