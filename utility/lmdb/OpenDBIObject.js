'use strict';
const env_mngr = require('../environment/environmentManager');
const terms = require('../../utility/hdbTerms');
env_mngr.initSync();
const LMDB_COMPRESSION = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_COMPRESSION);
const LMDB_CACHING = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_CACHING) !== false;

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
		this.compression = LMDB_COMPRESSION && is_primary;
		this.sharedStructuresKey = Symbol.for('structures');
		if (is_primary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.randomAccessStructure = true;
			this.freezeData = true;
		}
	}
}

module.exports = OpenDBIObject;
