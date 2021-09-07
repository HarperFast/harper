'use strict';

const lmdb_terms = require('./terms');

/**
 * used to define specific attributes of a dbi.
 * dup_sort for allowing duplicate keys, or not
 * int_key defines if the key entries are integers or not
 */
class DBIDefinition {
	/**
	 * @param {Boolean} dup_sort - allow duplicate keys, or not
	 * @param {lmdb_terms.DBI_KEY_TYPES} key_type - defines the data type of the key
	 * @param {Boolean} is_hash_attribute - defines if this attribute is a hash attribute
	 */
	constructor(dup_sort = false, key_type = lmdb_terms.DBI_KEY_TYPES.STRING, is_hash_attribute = false) {
		this.dup_sort = dup_sort;
		this.key_type = key_type;
		this.is_hash_attribute = is_hash_attribute;
	}
}

module.exports = DBIDefinition;
