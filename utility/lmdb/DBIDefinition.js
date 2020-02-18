'use strict';

const lmdb_terms = require('./terms');

/**
 * used to define specific attributes of a dbi.
 * dup_sort for allowing duplicate keys, or not
 * int_key defines if the key entries are integers or not
 */
class DBIDefinition{
    /**
     * @param {Boolean} dup_sort - allow duplicate keys, or not
     * @param {lmdb_terms.DBI_KEY_TYPES} key_type - defines the data type of the key
     */
    constructor(dup_sort = false, key_type = lmdb_terms.DBI_KEY_TYPES.STRING) {
        this.dup_sort = dup_sort;
        this.key_type = key_type;
    }
}

module.exports = DBIDefinition;