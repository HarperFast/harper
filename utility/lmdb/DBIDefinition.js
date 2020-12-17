'use strict';

/**
 * used to define specific attributes of a dbi.
 * dup_sort for allowing duplicate keys, or not
 * int_key defines if the key entries are integers or not
 */
class DBIDefinition{
    /**
     * @param {Boolean} dup_sort - allow duplicate keys, or not
     * @param {Boolean} is_hash_attribute - defines if this attribute is a hash attribute
     */
    constructor(dup_sort = false, is_hash_attribute = false) {
        this.dup_sort = dup_sort;
        this.is_hash_attribute = is_hash_attribute;
        this.useVersions = is_hash_attribute;
    }
}

module.exports = DBIDefinition;