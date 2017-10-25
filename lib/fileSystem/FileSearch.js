const fs = require('graceful-fs'),
    async = require('async'),
    _ = require('lodash'),
mathjs = require('mathjs'),
autocast = require('autocast'),
ls = require('node-ls');

const findTable = Symbol('findTable'),
    readFolderValues = Symbol('readFolderValues'),
    getAttributeValues = Symbol('getAttributeValues'),
    evaluateConditions = Symbol('evaluateConditions'),
    retrieveIds =Symbol('retrieveIds');

class FileSearch{
    constructor(conditions, base_path, joins){
        this.conditions = conditions;
        this.base_path = base_path;
        this.attributes = [];
        this.joins = joins;
    }

    search(callback){
        let values = {};

        //get all unique attributes
        this.conditions.forEach((condition)=>{
            this.attributes = this.attributes.concat(condition.attributes);
        });

        this.attributes = _.uniqBy(this.attributes, (attribute)=>{
            return[attribute.schema, attribute.table, attribute.attribute].join();
        });

        let paths = [];
        this.attributes.forEach((attribute)=>{
            paths.push(`${this.base_path}/${attribute.schema}/${attribute.table}/${attribute.attribute}/`);
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
           // console.log(this.attributes);
            this[evaluateConditions]();
            this[retrieveIds]();
            callback();
        });
    }

    [evaluateConditions](){
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

        //console.log(this.attributes);
    }

    [retrieveIds](callback){
        //group attributes by table

        this.attributes.forEach((attribute)=>{

            let attribute_path = `${this.base_path}/${attribute.schema}/${attribute.table}/${attribute.attribute}/`;
            let hash = global.
            async.each(attribute.filtered_values, (value, caller)=>{
                ls(attribute_path+value, '-a', (err, ids)=>{
                    console.log(ids);
                });
            }, (error)=>{
                callback();
            });
        });
    }

    [readFolderValues](base_path, callback){
        fs.readdir(base_path, (err, folders)=> {
            if (err) {
                if(err.code === 'ENOENT'){
                    callback(null, [], []);
                    return;
                }

                callback(err);
            } else {
                async.eachLimit(folders, 1000, (folder, caller)=>{
                    fs.readdir(base_path + folder, (err, ids)=> {
                        if(err){
                            if(err.code === 'ENOENT'){
                                caller(null, [], []);
                                return;
                            }

                            caller(err);
                        }

                        console.log(ids);
                        caller();
                    });
                }, (err)=>{callback()});
            }
        });
    }

    [getAttributeValues](attribute){
         return this.attributes.filter((attr)=>{
            return attr.schema === attribute.schema && attr.table === attribute.table && attr.attribute === attribute.attribute;
        })[0].values;
    }
}

module.exports = FileSearch;


function convertFileNamesToId(all_files){
    let match_set = new Set();
    all_files.forEach(function(match) {
        match_set.add(match.replace('.hdb', ''));
    });

    return Array.from(match_set);
}