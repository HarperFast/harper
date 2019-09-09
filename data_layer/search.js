'use strict';

const FileSearch = require('../lib/fileSystem/SQLSearch');
const SelectValidator = require('../sqlTranslator/SelectValidator');

module.exports = {
    searchByValue:searchByValue,
    searchByHash:searchByHash,
    searchByConditions: searchByConditions,
    search: search
};

const harperBridge = require('./harperBridge/harperBridge');
const util = require('util');
const c_search_by_hash = util.callbackify(harperBridge.searchByHash);
const c_search_by_value = util.callbackify(harperBridge.searchByValue);
const c_search_by_conditions = util.callbackify(harperBridge.searchByConditions);

function searchByHash(search_object, callback){
    try {
        c_search_by_hash(search_object, (err, results) => {
            if (err) {
                callback(err);
                return;
            }
            callback(null, results);
        });
    } catch(err) {
        return callback(err);
    }
}

function searchByValue (search_object, callback) {
    try {
        c_search_by_value(search_object, (err, results) => {
            if (err) {
                callback(err);
                return;
            }
            callback(null, results);
        });
    } catch(err){
        return callback(err);
    }
}

function searchByConditions(search_object, callback){
    try {
        c_search_by_conditions(search_object, (err, results) => {
            if (err) {
                callback(err);
                return;
            }
            callback(null, results);
        });
    } catch(err){
        return callback(err);
    }

}

function search(statement, callback) {
    try {
        let validator = new SelectValidator(statement);
        validator.validate();

        let search = new FileSearch(validator.statement, validator.attributes);

        search.search().then(data => {
            callback(null, data);
        }).catch(e => {
           callback(e, null);
        });
    } catch(e){
        return callback(e);
    }
}