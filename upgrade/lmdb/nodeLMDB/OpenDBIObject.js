'use strict';

const lmdb_terms = require('./terms');

/**
 * Defines how a DBI will be created/opened
 */
class OpenDBIObject{
    /**
     * @param {String} name - name of the dbi
     * @param {Boolean} create - whether to create the dbi or not
     * @param {Boolean} dup_sort - if the dbi allows duplicate keys
     * @param {lmdb_terms.DBI_KEY_TYPES} key_type - the data type of the key
     */
    constructor(name, create, dup_sort, key_type) {
        this.name = name;
        this.create = create;
        this.dupSort = dup_sort === true;
        switch(key_type){
            case lmdb_terms.DBI_KEY_TYPES.STRING:
                this.keyIsString = true;
                break;
            case lmdb_terms.DBI_KEY_TYPES.NUMBER:
                this.keyIsBuffer = true;
                break;
            default:
                this.keyIsString = true;
                break;
        }
    }
}

module.exports = OpenDBIObject;