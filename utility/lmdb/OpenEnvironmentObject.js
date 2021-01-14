'use strict';

class OpenEnvironmentObject{
    constructor(path, map_size, max_dbs, max_readers) {
        this.path = path;
        this.mapSize = map_size;
        this.maxDbs = max_dbs;
        this.maxReaders = max_readers;
        this.sharedStructuresKey = Symbol.for('structures');
    }
}

module.exports = OpenEnvironmentObject;