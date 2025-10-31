import envMngr from '../environment/environmentManager.js';
import * as terms from '../../utility/hdbTerms.ts';
import { RecordEncoder } from '../../resources/RecordEncoder.ts';
envMngr.initSync();

const LMDB_CACHING = envMngr.get(terms.CONFIG_PARAMS.STORAGE_CACHING) !== false;

/**
 * Defines how a DBI will be created/opened
 */
export class OpenDBIObject {
	dupSort: boolean;
	encoding: 'msgpack' | 'ordered-binary';
	useVersions: boolean;
	sharedStructuresKey: symbol;
	cache?: { validated: boolean };
	randomAccessStructure?: boolean;
	freezeData?: boolean;
	encoder?: { Encoder: typeof RecordEncoder };

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
