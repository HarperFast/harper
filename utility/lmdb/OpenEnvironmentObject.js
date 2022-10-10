'use strict';
//Set initial map size to 1Gb
// eslint-disable-next-line no-magic-numbers
const MAP_SIZE = 1024 * 1024 * 1024;
//allow up to 1,000 named data bases in an environment
const MAX_DBS = 10000;
const MAX_READERS = 1000;
const env_mngr = require('../environment/environmentManager');
env_mngr.initSync();

const LMDB_NOSYNC =
	env_mngr.get('STORAGE_WRITEASYNC') === true ||
	env_mngr.get('STORAGE_WRITEASYNC') === 'true' ||
	env_mngr.get('STORAGE_WRITEASYNC') === 'TRUE';

const LMDB_OVERLAPPING_SYNC = env_mngr.get('STORAGE_OVERLAPPINGSYNC');


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
		if (LMDB_OVERLAPPING_SYNC !== undefined)
			this.overlappingSync = LMDB_OVERLAPPING_SYNC;
		// otherwise overlappingSync uses lmdb-js default, which is enabled on linux/mac, disabled on windows
	}
}

module.exports = OpenEnvironmentObject;
