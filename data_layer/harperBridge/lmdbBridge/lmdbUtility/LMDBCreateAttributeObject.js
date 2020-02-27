'use strict';

const CreateAttributeObject = require('../../../CreateAttributeObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');

class LMDBCreateAttributeObject extends CreateAttributeObject{
    /**
     *
     * @param {String} schema
     * @param {String} table
     * @param {String} attribute
     * @param {*} [id] - optional, the predefined id for this attribute
     * @param {Boolean} [dup_sort] - optional, whether this attribute will allow duplicate keys in the lmdb dbi, defaults to true
     * @param {lmdb_terms.DBI_KEY_TYPES} [key_type] - optional, whether this attribute will have an int for it's keys, defaults to string
     */
    constructor(schema, table, attribute, id, dup_sort = true, key_type = lmdb_terms.DBI_KEY_TYPES.STRING, is_hash_attribute = false) {
        super(schema, table, attribute, id);
        this.dup_sort = dup_sort;
        this.key_type = key_type;
        this.is_hash_attribute = is_hash_attribute;
    }
}

module.exports = LMDBCreateAttributeObject;