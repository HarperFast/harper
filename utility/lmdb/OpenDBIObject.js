'use strict';
const env_mngr = require('../environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { RecordEncoder } = require('../../resources/RecordEncoder');
const fs = require('fs');
env_mngr.initSync();

const LMDB_COMPRESSION = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_COMPRESSION);
const STORAGE_COMPRESSION_DICTIONARY = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_COMPRESSION_DICTIONARY);
const STORAGE_COMPRESSION_THRESHOLD = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD);
let LMDB_COMPRESSION_OPTS = { startingOffset: 32 };
if (STORAGE_COMPRESSION_DICTIONARY)
	LMDB_COMPRESSION_OPTS['dictionary'] = fs.readFileSync(STORAGE_COMPRESSION_DICTIONARY);
if (STORAGE_COMPRESSION_THRESHOLD) LMDB_COMPRESSION_OPTS['threshold'] = STORAGE_COMPRESSION_THRESHOLD;
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
		this.compression = LMDB_COMPRESSION && is_primary && LMDB_COMPRESSION_OPTS;
		this.sharedStructuresKey = Symbol.for('structures');
		if (is_primary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.randomAccessStructure = true;
			this.freezeData = true;
			this.encoder = { Encoder: RecordEncoder };
		}
	}
}

module.exports = OpenDBIObject;
