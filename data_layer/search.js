'use strict';
const fs = require('fs')
    , settings = require('settings')
    , base_path = settings.HDB_ROOT + "/schema/"
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async'),
    path = require('path'),
    Glob = require('glob').Glob;


const hash_regex = /[^0-9a-z]/gi;
const search_regex =  /[^0-9a-z\*_]/gi;

// search by hash only
// what attributes are you selecting
// table selecting from
// table selecting from
// condition criteria

module.exports = {
    searchByHash: searchByHash,
    searchByValue:searchByValue,
    searchByHashes:searchByHashes
};

function searchByHash(search_object, callback){
    let hash_stripped = String(search_object.hash_value).replace(hash_regex, '').substring(0, 4000);
    let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
    async.waterfall([
        getAttributeFiles.bind(null, search_object.get_attributes, table_path, [hash_stripped]),
        consolidateData.bind(null, search_object.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function searchByHashes(search_object, callback){
    let validation_error = search_validator(search_object, 'hashes');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
    async.waterfall([
        getAttributeFiles.bind(null, search_object.get_attributes, table_path, search_object.hash_values),
        consolidateData.bind(null, search_object.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function searchByValue (search_object, callback) {
    let validation_error = search_validator(search_object, 'value');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    let search_string = String(search_object.search_value).replace(search_regex, '').substring(0, 4000);
    let folder_pattern = `*${search_string}*/*.hdb`;
    let file_pattern = search_string === '*' ? '*' : new RegExp(search_string);
    let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
    let search_path = search_object.search_attribute === search_object.hash_attribute ? `${table_path + '__hdb_hash/' + search_object.search_attribute}/` :
        `${table_path + search_object.search_attribute}/`;

    if(search_object.get_attributes.indexOf(search_object.hash_attribute) < 0){
        search_object.get_attributes.push(search_object.hash_attribute);
    }

    async.waterfall([
        findFiles.bind(null, search_path, folder_pattern),
        verifyFileMatches.bind(null, file_pattern, `${table_path}/__hdb_hash/${search_object.search_attribute}/`),
        getAttributeFiles.bind(null, search_object.get_attributes, table_path),
        consolidateData.bind(null, search_object.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function consolidateData(hash_attribute, attributes_data, callback){
    let data_array = [];
    let data_keys = Object.keys(attributes_data);
    let ids = Object.keys(attributes_data[hash_attribute]);

    ids.forEach(function(key){
        let data_object = {};

        data_keys.forEach(function(attribute){
            data_object[attribute] = attributes_data[attribute][key];
        });
        data_array.push(data_object);
    });
    callback(null, data_array);
}

function getAttributeFiles(get_attributes, table_path, hash_files, callback){
    let attributes_data = {};
    async.each(get_attributes, (attribute, caller)=>{
        readAttributeFiles(table_path, attribute, hash_files, (err, results)=>{
            if(err){
                caller(err);
                return;
            }

            attributes_data[attribute]=results;
            caller();
        });
    }, (error)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, attributes_data);
    });
}

function readAttributeFiles(table_path, attribute, hash_files, callback){
    let attribute_data = {};
    async.each(hash_files, (file, caller)=>{
        fs.readFile(`${table_path}__hdb_hash/${attribute}/${file}.hdb`, (error, data)=>{
            if(error){
                caller(error);
                return;
            }

            attribute_data[file]=data.toString();
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

function verifyFileMatches(pattern, search_path, files, callback){
    if (pattern === '*') {
        callback(null, files);
        return;
    }

    let matches = [];
    async.each(files, function(file_name, caller){

        let file_path = `${search_path}${file_name}.hdb`;
        matchFile(file_path, pattern, (err, is_match)=>{
            if(err){
                //if there is an error log it out but don't halt the process
                console.error(err);
                return;
            }

            if(is_match){
                matches.push(file_name);
            }

            caller();
        });
    }, function(err){
        if(err){
            callback(err);
            return;
        }

        callback(null, matches);
    });
}

function findFiles(cwd, pattern, callback){
    Glob(pattern, {cwd:cwd}, (err, matches)=>{
        if(err){
            callback(err);
            return;
        }

        let match_set = new Set();
        matches.forEach(function(match) {
            match_set.add(path.basename(match).replace('.hdb', ''));
        });
        callback(null, match_set);
    });
}

function matchFile(file_path, pattern, callback){
    fs.readFile(file_path, (err, data)=>{
        if(err) {
            callback(err);
            return;
        }

        callback(null, pattern.test(data.toString()));
    });
}