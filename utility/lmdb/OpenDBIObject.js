'use strict';
const envMngr = require('../environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
const { RecordEncoder } = require('../../resources/RecordEncoder.ts');
envMngr.initSync();

const LMDB_CACHING = envMngr.get(terms.CONFIG_PARAMS.STORAGE_CACHING) !== false;

/**
 * Defines how a DBI will be created/opened
 */
class OpenDBIObject {
	/**
	 * @param {Boolean} dupSort - if the dbi allows duplicate keys
	 * @param {Boolean} useVersions - if the dbi uses versions
	 */
	constructor(dupSort, isPrimary = false) {
		this.dupSort = dupSort === true;
		this.encoding = dupSort ? 'ordered-binary' : 'msgpack';
		this.useVersions = isPrimary;
		this.sharedStructuresKey = Symbol.for('structures');
		if (isPrimary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.randomAccessStructure = true;
			this.freezeData = true;
			this.encoder = { Encoder: RecordEncoder };
		}
	}
}

exports.OpenDBIObject = OpenDBIObject;
