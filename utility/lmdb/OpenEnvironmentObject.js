'use strict';

class OpenEnvironmentObject {
	constructor(path, map_size, max_dbs, max_readers, no_sync = false) {
		this.path = path;
		this.mapSize = map_size;
		this.maxDbs = max_dbs;
		this.maxReaders = max_readers;
		this.sharedStructuresKey = Symbol.for('structures');

		//TODO figure out how to get overlappingSync = true to pass ci tests, suspect it is something with AWS storage.
		this.overlappingSync = false;
		if (no_sync === true) {
			this.noSync = true;
		}
	}
}

module.exports = OpenEnvironmentObject;
