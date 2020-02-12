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
     * @param {Boolean} [int_key] - optional, whether this attribute will have an int for it's keys, defaults to false
     */
    constructor(schema, table, attribute, id, dup_sort = true, int_key = false) {
        super(schema, table, attribute, id);
        this.dup_sort = dup_sort;
        this.int_key = int_key;
    }
}

module.exports = LMDBCreateAttributeObject;