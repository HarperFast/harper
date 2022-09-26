'use strict';

class OpenEnvironmentObject {
	constructor(path, map_size, max_dbs, max_readers, read_only = false, no_sync = false, overlapping_sync = undefined) {
		this.path = path;
		this.mapSize = map_size;
		this.maxDbs = max_dbs;
		this.maxReaders = max_readers;
		this.sharedStructuresKey = Symbol.for('structures');
		this.readOnly = read_only;
		this.trackMetrics = true;
		this.noSync = no_sync;
		if (overlapping_sync !== undefined)
			this.overlappingSync = overlapping_sync;
		// otherwise overlappingSync uses lmdb-js default, which is enabled on linux/mac, disabled on windows
	}
}

module.exports = OpenEnvironmentObject;
