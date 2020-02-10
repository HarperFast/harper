'use strict';

const SearchObject = require('../../../SearchObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');

class ThreadSearchObject {
    /**
     * @param {SearchObject} search_object
     * @param {lmdb_terms.SEARCH_TYPES} search_type
     * @param {String} hash_attribute
     * @param {Boolean} return_map
     */
    constructor(search_object, search_type, hash_attribute, return_map) {
        this.search_object = search_object;
        this.search_type = search_type;
        this.hash_attribute = hash_attribute;
        this.return_map = return_map;
    }
}

module.exports = ThreadSearchObject;