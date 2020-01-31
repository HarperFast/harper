'use strict';

/**
 * used to define specific attributes of a dbi.
 * dup_sort for allowing duplicate keys, or not
 * int_key defines if the key entries are integers or not
 */
class DBIDefinition{
    /**
     * @param {Boolean} dup_sort - allow duplicate keys, or not
     * @param {Boolean} int_key - defines if the key entries are integers or not
     */
    constructor(dup_sort, int_key) {
        this.dup_sort = dup_sort;
        this.int_key = int_key;
    }
}

module.exports = DBIDefinition;