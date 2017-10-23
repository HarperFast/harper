const fs = require('graceful-fs'),
    async = require('async'),
    _ = require('lodash'),
mathjs = require('mathjs'),
autocast = require('autocast'),
ls = require('node-ls');

const findTable = Symbol('findTable'),
    readFolderValues = Symbol('readFolderValues'),
    getAttributeValues = Symbol('getAttributeValues'),
    evaluateConditions = Symbol('evaluateConditions');

class FileSearch{
    constructor(conditions, base_path){
        this.conditions = conditions;
        this.base_path = base_path;
        this.attributes = [];
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

        console.log(this.attributes);
    }

    [retrieveIds](){
        this.attributes.forEach((attribute)=>{
            let attribute_path = `${this.base_path}/${attribute.schema}/${attribute.table}/${attribute.attribute}/`;
            async.each(attribute.filtered_values, (value, callback)=>{
                ls(attribute_path+value, '-a', (err, ids)=>{

                });
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


                //callback(null, folders);
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



/*module.exports = {
    findIDsByRegex,
    getFiles,
    findDirectoriesByRegex,
    //searchFileSystem
};*/



function findIDsByRegex(base_path, condition, blob_search, callback){
    async.waterfall([
        findDirectoriesByRegex.bind(null, base_path, regex),
        //getFiles.bind(null, base_path)
        searchFileSystem.bind(null, base_path, regex, blob_search)
    ], (err, ids)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, ids);
    });
}

function findDirectoriesByRegex(base_path, regex, callback){
    fs.readdir(base_path, (err, folders)=> {
        if (err) {
            if(err.code === 'ENOENT'){
                callback(null, [], []);
                return;
            }

            callback(err);
        } else {
            let filtered_folders = folders.filter((folder) => {
                return regex.test(folder);
            });

            callback(null, filtered_folders, folders);
        }
    });
}

function searchFileSystem(base_path, regex, blob_search, filtered_folders, all_folders, callback){
    all_folders = _.filter(all_folders, (folder)=>{
        return Buffer.byteLength(folder) >= 230;
    });

    async.parallel({
            standard: getFiles.bind(null, base_path, filtered_folders),
            blob: (caller) => {
                if (blob_search) {
                    let search_results = [];
                    async.eachLimit(all_folders, 1000, (folder, call) => {
                        blobSearch(`${base_path}${folder}/blob`, regex, (err, results) => {
                            if (err) {
                                return call(err);
                            }

                            search_results = search_results.concat(results);
                            call();
                        });


                    }, (err) => {
                        if (err) {
                            return caller(err);
                        }

                        caller(null, search_results);
                    });
                } else {
                    caller();
                }
            }
        }, (err, results)=> {
            if(err){
                return callback(err);
            }

            let ids = [];

            if(results.standard && results.standard.length > 0) {
                ids = ids.concat(results.standard);
            }

        if(results.blob && results.blob.length > 0){
            ids = ids.concat(results.blob);
        }

        callback(null, ids);
    });
}

function blobSearch(base_path, regex, callback){
    async.waterfall([
        (caller)=>{
            fs.readdir(base_path, (err, files)=>{
                if(err) {
                    if (err.code === 'ENOENT') {
                        return caller(null, []);
                    }

                    return caller(err);
                }

                caller(null, files);
            });
        },
        (files, caller)=>{
            let matching_files = [];
            async.eachLimit(files, 1000, (file, call)=>{
                fs.readFile(base_path+ '/' +file, (err, file_data)=>{
                    if(err){
                        return call(err);
                    }

                    if(regex.test(file_data.toString())){
                        matching_files.push(file);
                    }

                    call();
                });
            }, (err)=>{
                if(err){
                    return caller(err);
                }

                caller(null, convertFileNamesToId(matching_files));
            });
        }
    ], (err, results)=>{
        if(err){
            return callback(err);
        }

        callback(null, results);
    });
}

function getFiles(base_path, folders, callback){
    //if the search sends us actual hdb files we just need to pass them on.
    if(folders && folders.length > 0 && folders[0].endsWith('.hdb')) {
        callback(null, convertFileNamesToId(folders));
        return;
    }

    let all_files = [];
    async.each(folders, (folder, caller)=>{
        fs.readdir(base_path + folder, (err, files)=>{
            if(err){
                if(err.code === 'ENOENT'){
                    caller();
                    return;
                }

                caller(err);
                return;
            }
            files = _.filter(files, (file)=>{
                return file.endsWith('.hdb');
            });

            all_files = all_files.concat(files);
            caller();
        });
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, convertFileNamesToId(all_files));
    });
}


function convertFileNamesToId(all_files){
    let match_set = new Set();
    all_files.forEach(function(match) {
        match_set.add(match.replace('.hdb', ''));
    });

    return Array.from(match_set);
}