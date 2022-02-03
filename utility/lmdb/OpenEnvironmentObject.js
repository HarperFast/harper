'use strict';

class OpenEnvironmentObject {
	constructor(path, map_size, max_dbs, max_readers, no_sync = false) {
		this.path = path;
		this.mapSize = map_size;
		this.maxDbs = max_dbs;
		this.maxReaders = max_readers;
		this.sharedStructuresKey = Symbol.for('structures');
		this.overlappingSync = !no_sync;
	}
}

module.exports = OpenEnvironmentObject;
