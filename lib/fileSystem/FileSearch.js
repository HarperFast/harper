const async = require('async'),
    _ = require('lodash'),
    mathjs = require('mathjs'),
    autocast = require('autocast'),
    ls = require('node-ls');

const findTable = Symbol('findTable'),
    readFolderValues = Symbol('readFolderValues'),
    getAttributeValues = Symbol('getAttributeValues'),
    evaluateConditions = Symbol('evaluateConditions'),
    retrieveIds =Symbol('retrieveIds'),
    consolidateData = Symbol('consolidateData'),
    evaluateConditionString = Symbol('evaluateConditionString');

class FileSearch{
    constructor(conditions, base_path, condition_string){

        this.conditions = conditions;
        this.base_path = base_path;
        this.condition_string = condition_string;
        this.attributes = [];
    }

    search(callback){
        async.waterfall([
                this[getAttributeValues].bind(this),
                this[evaluateConditions].bind(this),
                this[retrieveIds].bind(this),
                this[consolidateData].bind(this),
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
            if(!attribute.filtered_values){
                attribute.filtered_values = [];
            }

            let compiled_condition = mathjs.compile(condition.node);

            attribute.values.forEach((value)=>{
                let scope = {};
                scope[condition_attribute.alias] = autocast(value);
                try {
                    if (compiled_condition.eval(scope)) {
                        attribute.filtered_values.push(value);
                    }
                } catch(e){
                }
            });

        });

        callback();
    }

    [retrieveIds](callback){
        //group attributes by table
        let hash_values = new Set();
        let attributes_data = {};
        let hash_name = global.hdb_schema[this.attributes[0].schema][this.attributes[0].table].hash_attribute;
        async.each(this.attributes, (attribute, caller)=>{
            attributes_data[`${attribute.alias}`] = {};
            let attribute_path = `${this.base_path}/${attribute.schema}/${attribute.table}/${attribute.attribute}/`;


            if(attribute.attribute === hash_name){
                attribute.filtered_values.forEach((value)=>{
                    hash_values.add(autocast(value));
                    attributes_data[`${attribute.alias}`][value] = autocast(value);
                });
                caller();
            } else {

                async.each(attribute.filtered_values, (value, call)=>{
                    ls(attribute_path+value, '-a', (err, ids)=>{
                        ids.forEach((id)=>{
                            id = id.replace('.hdb', '');
                            hash_values.add(autocast(id));
                            attributes_data[`${attribute.alias}`][id] = autocast(value);
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
            callback(null, attributes_data, hash_values, hash_name);
        });
    }

    [consolidateData](data, hash_values, hash_name, callback){
        let merged_data = {};
        hash_values.forEach((value)=>{
            merged_data[value] = {};
            merged_data[value][hash_name] = value;
        });

        async.each(Object.keys(data), (attribute, caller)=>{
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
        });
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
                console.error(record);
                console.error(e);
            }
        });

        callback(null, final_results);
    }
}

module.exports = FileSearch;