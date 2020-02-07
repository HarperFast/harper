'use strict';

const SelectValidator = require('../sqlTranslator/SelectValidator');

module.exports = {
    searchByValue:searchByValue,
    searchByHash:searchByHash,
    search: search
};

const harperBridge = require('./harperBridge/harperBridge');
const util = require('util');
const c_search_by_hash = util.callbackify(harperBridge.searchByHash);
const c_search_by_value = util.callbackify(harperBridge.searchByValue);
const SQLSearch = require('./SQLSearch');

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

function search(statement, callback) {
    try {
        let validator = new SelectValidator(statement);
        validator.validate();

        let sql_search = new SQLSearch(validator.statement, validator.attributes);

        sql_search.search().then(data => {
            callback(null, data);
        }).catch(e => {
           callback(e, null);
        });
    } catch(e){
        return callback(e);
    }
}