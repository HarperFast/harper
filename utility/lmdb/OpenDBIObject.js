'use strict';

/**
 * Defines how a DBI will be created/opened
 */
class OpenDBIObject{
    /**
     * @param {Boolean} create - whether to create the dbi or not
     * @param {Boolean} dup_sort - if the dbi allows duplicate keys
     */
    constructor(create, dup_sort) {
        this.create = create;
        this.dupSort = dup_sort === true;
    }
}

module.exports = OpenDBIObject;