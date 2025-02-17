'use strict';
const env_mngr = require('../environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const encoder = require('../../resources/RecordEncoder');
const fs = require('fs');
env_mngr.initSync();

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
		this.sharedStructuresKey = Symbol.for('structures');
		if (is_primary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.randomAccessStructure = true;
			this.freezeData = true;
			this.encoder = { Encoder: encoder.RecordEncoder };
		}
	}
}

module.exports = OpenDBIObject;
