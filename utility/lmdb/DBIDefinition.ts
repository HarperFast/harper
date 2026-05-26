'use strict';

/**
 * used to define specific attributes of a dbi.
 * dupSort for allowing duplicate keys, or not
 * intKey defines if the key entries are integers or not
 */
class DBIDefinition {
	dup_sort: boolean;
	isPrimaryKey: boolean;
	useVersions: boolean;
	/**
	 * @param {Boolean} dupSort - allow duplicate keys, or not
	 * @param {Boolean} isPrimaryKey - defines if this is the primary key
	 */
	constructor(dupSort = false, isPrimaryKey = false) {
		this.dup_sort = dupSort;
		this.isPrimaryKey = isPrimaryKey;
		this.useVersions = isPrimaryKey;
	}
}

export default DBIDefinition;
