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

class OpenEnvironmentObject {
	constructor(path, read_only = false) {
		this.path = path;
		this.mapSize = MAP_SIZE;
		this.maxDbs = MAX_DBS;
		this.maxReaders = MAX_READERS;
		this.sharedStructuresKey = Symbol.for('structures');
		this.readOnly = read_only;
		this.trackMetrics = true;
		this.eventTurnBatching = false; // event turn batching is not needed in HarperDB
		this.noSync =
			env_mngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === true ||
			env_mngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === 'true' ||
			env_mngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === 'TRUE';
		//this.noFSAccess = true; // we might re-enable this if we want secure JS environments
		// otherwise overlappingSync uses lmdb-js default, which is enabled on linux/mac, disabled on windows
		if (env_mngr.get(terms.CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC) !== undefined)
			this.overlappingSync = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC);
		if (env_mngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETOLOAD))
			this.maxFreeSpaceToLoad = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETOLOAD);
		if (env_mngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETORETAIN))
			this.maxFreeSpaceToRetain = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETORETAIN);
		if (env_mngr.get(terms.CONFIG_PARAMS.STORAGE_PAGESIZE))
			this.pageSize = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_PAGESIZE);
		this.noReadAhead = env_mngr.get(terms.CONFIG_PARAMS.STORAGE_NOREADAHEAD);
	}
}

module.exports = OpenEnvironmentObject;
OpenEnvironmentObject.MAX_DBS = MAX_DBS;
