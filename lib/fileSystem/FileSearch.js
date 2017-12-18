const async = require('async'),
    _ = require('lodash'),
    mathjs = require('mathjs'),
    autocast = require('autocast'),
    ls = require('node-ls'),
    alasql = require('alasql'),
    fs = require('fs'),
    RecursiveIterator = require('recursive-iterator'),
    clone = require('clone');

mathjs.import([
    require('../../utility/functions/math/count'),
    require('../../utility/functions/math/avg'),
   // require('../../utility/functions/date/dateFunctions'),
    require('../../utility/functions/string/compare')
]);

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
    readAttributeFiles = Symbol('readAttributeFiles');

class FileSearch{
    constructor(statement, sql, attributes, base_path){
        this.statement = statement;
        this.columns = {};
        this.base_path = base_path;
        this.sql = sql;
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
                this[readAttributeFiles].bind(this)
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
            if(node && node.columnid && node.columnid !== '*'){
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
            found_columns = this.columns.select.map((select_column)=>{
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
            columns = columns.concat(this.columns.joins);
        }

        if(this.columns.where) {
            columns = columns.concat(this.columns.where);
        }

        this.attributes = columns.map((column)=>{
            return this[findColumn](column);
        });

        this.attributes = _.uniqBy(this.attributes, (attribute)=>{
            return[attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join();
        });

        //TODO handle order by
        /*
        let order_columns = this[getColumns](this.statement.order);
        let found_order_columns =columns.map((column)=>{
            return this[findColumn](column);
        });*/



        /*this.conditions.forEach((condition)=>{
            this.attributes = this.attributes.concat(condition.attributes);
        });

        this.tables.forEach((table)=>{
            if(table.column_conditions && table.column_conditions.length > 0){
                this.attributes = this.attributes.concat(table.column_conditions);
            }
        });

        this.attributes = _.uniqBy(this.attributes, (attribute)=>{
            return[attribute.schema, attribute.table, attribute.attribute].join();
        });*/

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
                    attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast(value)] = {};
                    attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][value] = autocast(value);
                });
                caller();
            } else {
                let attribute_path = `${this.base_path}/${attribute.table.databaseid}/${attribute.table.tableid}/${attribute.attribute}/`;

                async.each(attribute.values, (value, call)=>{
                    ls(attribute_path+value, '-a', (err, ids)=>{
                        ids.forEach((id)=>{
                            id = id.replace('.hdb', '');
                            attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`].__merged_data[autocast(id)] = {};
                            //attributes_data[`${attribute.schema}_${attribute.table}`].__hash_values.add(autocast(id));
                            attributes_data[`${attribute.table.databaseid}_${attribute.table.tableid}`][`${attribute.attribute}`][id] = autocast(value);
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
                if(attribute === '__hash_values' || attribute === '__hash_name'|| attribute === '__merged_data' || attribute === '__has_hash'){
                    return;
                }

                hash_values.forEach((value)=>{
                    //TODO don't create the hash entry is there already is one
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

            data[table].__merged_data = Object.values(data[table].__merged_data);
            caller();
        }, (err)=>{
            if(err){
                return callback(err);
            }

            callback(null, data);
        });


        /*async.each(Object.keys(data), (attribute, caller)=>{
            hash_values.forEach((value)=>{
                if(data[attribute][value] === null || data[attribute][value] === undefined){
                    merged_data[value][attribute] = null;
                } else {
                    merged_data[value][attribute] = data[attribute][value];
                }

            });
            caller();
        }, (err)=>{
            if(err){
                return callback(err);
            }
            callback(null, Object.values(merged_data));
        });*/
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

        table_data.push(data[`${from_statement.databaseid}_${from_statement.tableid}`].__merged_data);


        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                let from = join.joinmode + ' JOIN ? AS ' + (join.as ? join.as : join.table.tableid);

                if(join.on) {
                    from += ' ON ' + join.on.toString();
                }
                from_clause.push(from);
                table_data.push(data[`${join.table.databaseid}_${join.table.tableid}`].__merged_data);
            });
        }

        //record the fetched attributes so we can compare to what else needs to be grabbed from them file system
        let existing_attributes = {};
        this.tables.forEach((table)=>{
            existing_attributes[table.tableid] = [];

            Object.keys(data[`${table.databaseid}_${table.tableid}`].__merged_data[0]).forEach((attribute)=>{
                existing_attributes[table.tableid].push(attribute);
                select.push(`${(table.as ? table.as : table.tableid)}.${attribute} AS "${table.tableid}.${attribute}"`);
            });
        });

        //TODO there is an error with between statements being converted back to string.  need to handle
        let where_clause = '1=1';
        if(this.statement.where){
            where_clause = this.statement.where.toString();
        }

        let joined = alasql(`SELECT ${select.join(',')} FROM ${from_clause.join(' ')} WHERE ${where_clause}`, table_data);

        callback(null, joined, existing_attributes);
    }

    [readAttributeFiles](data, existing_attributes, callback){
        //get all needed attributes from the full select

        let all_columns = new Set();
        var iterator = new RecursiveIterator(this.statement);
        for(let {node, path} of iterator) {
            if (node && node.columnid) {
                let found = this[findColumn](node);
                if(found && existing_attributes[found.table.tableid].indexOf(found.attribute) < 0){
                    all_columns.add(found);
                }
            }
        }

        console.log(all_columns);

        //fetch needed attributes

        //perform full sql
    }
}

module.exports = FileSearch;