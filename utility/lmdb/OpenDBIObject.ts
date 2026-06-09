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
	freezeData: boolean;
	encoder: any;
	randomAccessStructure: boolean;
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
		this.encoder = { Encoder: RecordEncoder };
		// Only enable struct (random-access) encoding on primary DBIs. Struct headers occupy
		// the 0x20-0x3f range, which readers without struct support (msgpackr v1 / Harper v4)
		// decode as positive fixints. v4 likewise gated struct mode behind is_primary, so
		// non-primary stores (e.g. the __dbis__ metadata DBI) stay in records mode and remain
		// decodable after a downgrade. RecordEncoder still reads struct data so existing v5
		// struct entries decode.
		// As of 5.1 the primary default is itself opt-in via storage.randomAccessFields (default
		// off; overridable per-table via databases.ts before the store opens). Typed structures key
		// on per-field value WIDTH, so wide/variably-typed schemas can mint an unbounded dictionary
		// (OOM) and diverge across replicas. Read the config here at construction — not at module
		// import — so an env/CLI override applied during startup is honored (DBIs open after config
		// is finalized).
		this.randomAccessStructure = isPrimary && envMngr.get(terms.CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS) === true;
		if (isPrimary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.freezeData = true;
		}
	}
}
