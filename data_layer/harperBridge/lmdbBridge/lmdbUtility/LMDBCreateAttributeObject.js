'use strict';

const CreateAttributeObject = require('../../../CreateAttributeObject');

class LMDBCreateAttributeObject extends CreateAttributeObject{
    /**
     *
     * @param {String} schema
     * @param {String} table
     * @param {String} attribute
     * @param {*} [id] - optional, the predefined id for this attribute
     * @param {Boolean} [dup_sort] - optional, whether this attribute will allow duplicate keys in the lmdb dbi, defaults to true
     * @param {Boolean} [is_hash_attribute]
     */
    constructor(schema, table, attribute, id, dup_sort = true, is_hash_attribute = false) {
        super(schema, table, attribute, id);
        this.dup_sort = dup_sort;
        this.is_hash_attribute = is_hash_attribute;
    }
}

module.exports = LMDBCreateAttributeObject;