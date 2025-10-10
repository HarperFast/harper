'use strict';
//Set initial map size to 1Gb
// eslint-disable-next-line no-magic-numbers
const MAP_SIZE = 1024 * 1024 * 1024;
//allow up to 1,000 named data bases in an environment
const MAX_DBS = 10000;
const MAX_READERS = 2048;
const envMngr = require('../environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
envMngr.initSync();

class OpenEnvironmentObject {
	constructor(path, readOnly = false) {
		this.path = path;
		this.mapSize = MAP_SIZE;
		this.maxDbs = MAX_DBS;
		this.maxReaders = MAX_READERS;
		this.sharedStructuresKey = Symbol.for('structures');
		this.readOnly = readOnly;
		this.trackMetrics = true;
		this.eventTurnBatching = false; // event turn batching is not needed in HarperDB
		this.noSync =
			envMngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === true ||
			envMngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === 'true' ||
			envMngr.get(terms.CONFIG_PARAMS.STORAGE_WRITEASYNC) === 'TRUE';
		//this.noFSAccess = true; // we might re-enable this if we want secure JS environments
		// otherwise overlappingSync uses lmdb-js default, which is enabled on linux/mac, disabled on windows
		if (envMngr.get(terms.CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC) !== undefined)
			this.overlappingSync = envMngr.get(terms.CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC);
		if (envMngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETOLOAD))
			this.maxFreeSpaceToLoad = envMngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETOLOAD);
		if (envMngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETORETAIN))
			this.maxFreeSpaceToRetain = envMngr.get(terms.CONFIG_PARAMS.STORAGE_MAXFREESPACETORETAIN);
		if (envMngr.get(terms.CONFIG_PARAMS.STORAGE_PAGESIZE))
			this.pageSize = envMngr.get(terms.CONFIG_PARAMS.STORAGE_PAGESIZE);
		this.noReadAhead = envMngr.get(terms.CONFIG_PARAMS.STORAGE_NOREADAHEAD);
	}
}

module.exports = OpenEnvironmentObject;
OpenEnvironmentObject.MAX_DBS = MAX_DBS;
