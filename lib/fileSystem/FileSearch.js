const async = require('async'),
    _ = require('lodash'),
    mathjs = require('mathjs'),
    autocast = require('autocast'),
    ls = require('node-ls'),
    alasql = require('alasql'),
fs = require('fs');

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
    evaluateConditionString = Symbol('evaluateConditionString'),
    processJoins = Symbol('processJoins');

class FileSearch{
    constructor(conditions, base_path, condition_string, tables){

        this.conditions = conditions;
        this.base_path = base_path;
        this.condition_string = condition_string;
        this.attributes = [];
        this.tables = tables;
    }

    search(callback){
        async.waterfall([
                this[getAttributeValues].bind(this),
                this[retrieveIds].bind(this),
                this[consolidateData].bind(this),
                this[processJoins].bind(this),
                this[evaluateConditionString].bind(this)
            ],
            (err, data)=>{
                if(err){
                    return callback(err);
                }
                callback(null, data);
        });
    }

    [getAttributeValues](callback){
        //get all unique attributes
        this.conditions.forEach((condition)=>{
            this.attributes = this.attributes.concat(condition.attributes);
        });

        this.tables.forEach((table)=>{
            if(table.column_conditions && table.column_conditions.length > 0){
                this.attributes = this.attributes.concat(table.column_conditions);
            }
        });

        this.attributes = _.uniqBy(this.attributes, (attribute)=>{
            return[attribute.schema, attribute.table, attribute.attribute].join();
        });

        async.each(this.attributes, (attribute, caller)=>{
            let attribute_path = `${this.base_path}/${attribute.schema}/${attribute.table}/${attribute.attribute}/`;
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

    [evaluateConditions](callback){
        //first evaluate all conditions that only have 1 attribute
        let one_attribute_conditions = this.conditions.filter((condition)=>{
            return condition.attributes.length === 1;
        });

        one_attribute_conditions.forEach((condition)=>{
            //find attribute
            let condition_attribute = condition.attributes[0];
            let attribute = this.attributes.filter((attribute)=>{
                return attribute.schema === condition_attribute.schema && attribute.table === condition_attribute.table && attribute.attribute === condition_attribute.attribute;
            })[0];


            let values = [];
            /*if(!attribute.filtered_values){
                attribute.filtered_values = [];
            }*/

            let compiled_condition = mathjs.compile(condition.node);

            attribute.values.forEach((value)=>{
                let scope = {};
                scope[condition_attribute.alias] = autocast(value);
                try {
                    if (compiled_condition.eval(scope)) {
                        //attribute.filtered_values.push(value);
                        values.push(value);
                    }
                } catch(e){
                }
            });
            attribute.values = values;
        });

        callback();
    }

    [retrieveIds](callback){
        //group attributes by table
        let hash_values = {};
        let attributes_data = {};
        //let hash_name = global.hdb_schema[this.attributes[0].schema][this.attributes[0].table].hash_attribute;

        this.tables.forEach((table)=>{
            attributes_data[`${table.schema}_${table.table}`] = {};
            //attributes_data[`${table.schema}_${table.table}`].__hash_values = new Set();
            attributes_data[`${table.schema}_${table.table}`].__hash_name = global.hdb_schema[table.schema][table.table].hash_attribute;
            attributes_data[`${table.schema}_${table.table}`].__merged_data = {};
        });

        /*let hash_names = this.tables.filter((table)=>{
            return  `${table.}` global.hdb_schema[table.schema][table.table].hash_attribute;
        });*/

        async.each(this.attributes, (attribute, caller)=>{
            attributes_data[`${attribute.schema}_${attribute.table}`][`${attribute.alias}`] = {};
            let hash_name = attributes_data[`${attribute.schema}_${attribute.table}`].__hash_name;

            if(attribute.attribute === hash_name){
                attribute.values.forEach((value)=>{
                    //attributes_data[`${attribute.schema}_${attribute.table}`].__hash_values.add(autocast(value));
                    attributes_data[`${attribute.schema}_${attribute.table}`].__merged_data[autocast(value)] = {};
                    attributes_data[`${attribute.schema}_${attribute.table}`][`${attribute.alias}`][value] = autocast(value);
                });
                caller();
            } else {
                let attribute_path = `${this.base_path}/${attribute.schema}/${attribute.table}/${attribute.attribute}/`;

                async.each(attribute.values, (value, call)=>{
                    ls(attribute_path+value, '-a', (err, ids)=>{
                        ids.forEach((id)=>{
                            id = id.replace('.hdb', '');
                            attributes_data[`${attribute.schema}_${attribute.table}`].__merged_data[autocast(id)] = {};
                            //attributes_data[`${attribute.schema}_${attribute.table}`].__hash_values.add(autocast(id));
                            attributes_data[`${attribute.schema}_${attribute.table}`][`${attribute.alias}`][id] = autocast(value);
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
            Object.keys(data[table]).forEach((attribute)=>{
                if(attribute === '__hash_values' || attribute === '__hash_name'|| attribute === '__merged_data'){
                    return;
                }

                hash_values.forEach((value)=>{
                    data[table].__merged_data[value][`${table}_${data[table].__hash_name}`] = autocast(value);
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
        fs.writeFileSync('../test/data.json', JSON.stringify(data));
        let from_clause = [];
        let table_data = [];
        this.tables.forEach((table, index)=>{
            let from = ` ? AS ${table.alias}`;

            if(table.join && table.join.type){
                from = table.join.type + from;

                if(table.column_conditions && table.column_conditions.length > 1){
                    from += ` ON ${table.column_conditions[0].table_alias}.${table.column_conditions[0].alias} = ${table.column_conditions[1].table_alias}.${table.column_conditions[1].alias}`;
                }
            }

            from_clause.push(from);
            table_data.push(data[`${table.schema}_${table.table}`].__merged_data);


            /*if(table.column_conditions && table.column_conditions.length > 1){
                let join_function = null;

                let right_table = data[`${table.schema}_${table.table}`].__merged_data;



                switch(table.join.type){
                    case "join":
                    case "inner join":
                        join_function = lodash_joins.sortedMergeInnerJoin;
                        break;
                }

                //let left_table = data[`${previous_table.schema}_${previous_table.table}`].__merged_data;
                let right_table = data[`${table.schema}_${table.table}`].__merged_data;

                joined = join_function(joined, (obj) => {
                    return obj[table.column_conditions[0].alias];
                }, right_table, (obj) => {
                    return obj[table.column_conditions[1].alias];
                });

                console.log(joined.length);
            } else {
                joined = data[`${table.schema}_${table.table}`].__merged_data;
            }*/
        });

        let where_clause = this.condition_string ? this.condition_string.replace(/==/g, /=/) : "1=1";

        let joined = alasql(`SELECT * FROM ${from_clause.join(' ')} WHERE ${where_clause}`, table_data);

        callback(null, joined);
    }

    //here we are parsing the entire condition against our result set
    [evaluateConditionString](data, callback){
        let final_results = [];

        let compiled_condition = mathjs.compile(this.condition_string);

        data.forEach((record)=>{
            try {
                if(compiled_condition.eval(record)){
                    final_results.push(record);
                }
            } catch(e){
                console.error(e);
                /*console.error(record);
                console.error(e);*/
            }
        });

        callback(null, final_results);
    }
}

module.exports = FileSearch;