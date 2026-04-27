'use strict';;
import * as envMngr from '../environment/environmentManager.js';
import * as terms from '../../utility/hdbTerms.js';
import { RecordEncoder } from '../../resources/RecordEncoder.js';
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

export const OpenDBIObject = OpenDBIObject;
