"use strict";

/**
 * defines the results from exploding json into the HDB data model
 * @param operation
 * @param data_folders
 * @param raw_data
 * @param skipped
 *
 */
class ExplodedObject {
    constructor(written_hashes, skipped, folders, raw_data, unlinks) {
        this.written_hashes =  written_hashes;
        this.folders = folders;
        this.raw_data = raw_data;
        this.skipped =  skipped;
        this.unlinks = unlinks;
    }
}

module.exports = ExplodedObject;