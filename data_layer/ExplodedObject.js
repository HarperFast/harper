"use strict";

/**
 * defines the results from exploding json into the HDB data model
 * @param {Array.<string>} written_hashes
 * @param {Array.<string>} skipped
 * @param {Array.<string>} folders
 * @param {Array.<FileObject>} raw_data
 * @param unlinks
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