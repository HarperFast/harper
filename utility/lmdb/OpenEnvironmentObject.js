'use strict';
//Set initial map size to 1Gb
// eslint-disable-next-line no-magic-numbers
const MAP_SIZE = 1024 * 1024 * 1024;
//allow up to 1,000 named data bases in an environment
const MAX_DBS = 10000;
const MAX_READERS = 1000;
const env_mngr = require('../environment/environmentManager');
const terms = require('../../utility/hdbTerms');
env_mngr.initSync();

const LMDB_NOSYNC =
	env_mngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === true ||
	env_mngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === 'true' ||
	env_mngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === 'TRUE';

const LMDB_OVERLAPPING_SYNC = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC);
const LMDB_NOREADAHEAD = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_NOREADAHEAD);
const MAX_FREE_SPACE_TO_LOAD = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETOLOAD);
const MAX_FREE_SPACE_TO_RETAIN = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETORETAIN);

class OpenEnvironmentObject {
	constructor(path, read_only = false) {
		this.path = path;
		this.mapSize = MAP_SIZE;
		this.maxDbs = MAX_DBS;
		this.maxReaders = MAX_READERS;
		this.sharedStructuresKey = Symbol.for('structures');
		this.readOnly = read_only;
		this.trackMetrics = true;
		this.noSync = LMDB_NOSYNC;
		this.noFSAccess = true;
		// otherwise overlappingSync uses lmdb-js default, which is enabled on linux/mac, disabled on windows
		if (LMDB_OVERLAPPING_SYNC !== undefined) this.overlappingSync = LMDB_OVERLAPPING_SYNC;
		if (MAX_FREE_SPACE_TO_LOAD) this.maxFreeSpaceToLoad = MAX_FREE_SPACE_TO_LOAD;
		if (MAX_FREE_SPACE_TO_RETAIN) this.maxFreeSpaceToRetain = MAX_FREE_SPACE_TO_RETAIN;
		this.noReadAhead = LMDB_NOREADAHEAD;
	}
}

module.exports = OpenEnvironmentObject;
OpenEnvironmentObject.MAX_DBS = MAX_DBS;
