'use strict';
import * as envMngr from '../environment/environmentManager.ts';
import * as terms from '../../utility/hdbTerms.ts';
import { RecordEncoder } from '../../resources/RecordEncoder.ts';
envMngr.initSync();

const LMDB_CACHING = envMngr.get(terms.CONFIG_PARAMS.STORAGE_CACHING) !== false;

/**
 * Defines how a DBI will be created/opened
 */
export class OpenDBIObject {
	[key: string]: any;
	dupSort: boolean;
	encoding: 'string' | 'json' | 'binary' | 'msgpack' | 'ordered-binary';
	useVersions: boolean;
	sharedStructuresKey: symbol;
	compression: any;
	cache: any;
	randomAccessStructure: boolean;
	freezeData: boolean;
	encoder: any;
	/**
	 * @param {Boolean} dupSort - if the dbi allows duplicate keys
	 * @param {Boolean} [isPrimary] - if the dbi is the primary dbi
	 */
	constructor(dupSort, isPrimary = false) {
		/** @type {boolean} */
		this.dupSort = dupSort === true;
		/** @type {"string" | "json" | "binary" | "msgpack" | "ordered-binary"} */
		this.encoding = dupSort ? 'ordered-binary' : 'msgpack';
		/** @type {boolean} */
		this.useVersions = isPrimary;
		/** @type {Symbol} */
		this.sharedStructuresKey = Symbol.for('structures');
		/** @type {any} */
		this.compression = undefined;
		if (isPrimary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.randomAccessStructure = true;
			this.freezeData = true;
			this.encoder = { Encoder: RecordEncoder };
		}
	}
}
