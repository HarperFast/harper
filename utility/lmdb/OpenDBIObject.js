'use strict';

/**
 * Defines how a DBI will be created/opened
 */
class OpenDBIObject {
	/**
	 * @param {Boolean} dup_sort - if the dbi allows duplicate keys
	 * @param {Boolean} use_versions - if the dbi uses versions
	 */
	constructor(dup_sort, use_versions = false) {
		this.dupSort = dup_sort === true;
		this.encoding = dup_sort ? 'ordered-binary' : 'msgpack';
		this.useVersions = use_versions;
		this.sharedStructuresKey = Symbol.for('structures');
	}
}

module.exports = OpenDBIObject;
