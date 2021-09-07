'use strict';

class OpenEnvironmentObject {
	constructor(path, map_size, max_dbs, no_meta_sync, no_sync, max_readers) {
		this.path = path;
		this.mapSize = map_size;
		this.maxDbs = max_dbs;
		this.noMetaSync = no_meta_sync;
		this.noSync = no_sync;
		this.maxReaders = max_readers;
	}
}

module.exports = OpenEnvironmentObject;
