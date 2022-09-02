'use strict';

/**
 * Defines how a DBI will be created/opened
 */
class OpenDBIObject {
	/**
	 * @param {Boolean} dup_sort - if the dbi allows duplicate keys
	 * @param {Boolean} use_versions - if the dbi uses versions
	 */
	constructor(dup_sort, is_primary = false) {
		this.dupSort = dup_sort === true;
		this.encoding = dup_sort ? 'ordered-binary' : 'msgpack';
		this.useVersions = is_primary;
		this.sharedStructuresKey = Symbol.for('structures');
		if (is_primary) {
			this.cache = { validated: true };
			this.randomAccessStructure = true;
		}
	}
}

module.exports = OpenDBIObject;
