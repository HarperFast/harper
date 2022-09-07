'use strict';

class OpenEnvironmentObject {
	constructor(path, map_size, max_dbs, max_readers, read_only = false) {
		this.path = path;
		this.mapSize = map_size;
		this.maxDbs = max_dbs;
		this.maxReaders = max_readers;
		this.sharedStructuresKey = Symbol.for('structures');
		this.readOnly = read_only;
		// overlappingSync uses lmdb-js default, which is enabled on linux/mac, disabled on windows
	}
}

module.exports = OpenEnvironmentObject;
