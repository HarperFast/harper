'use strict';

class OpenEnvironmentObject {
	constructor(path, map_size, max_dbs, max_readers, read_only = false) {
		this.path = path;
		this.mapSize = map_size;
		this.maxDbs = max_dbs;
		this.maxReaders = max_readers;
		this.sharedStructuresKey = Symbol.for('structures');
		this.readOnly = read_only;
		this.overlappingSync = true;
	}
}

module.exports = OpenEnvironmentObject;
