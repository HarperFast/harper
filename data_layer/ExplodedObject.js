"use strict";

/**
 * @param operation
 * @param data_folders
 *
 */
class ExplodedObject {
    constructor(operation, data_folders, raw_data, skipped) {
        this.operation =  operation;
        this.data_folders = data_folders;
        this.raw_data = raw_data;
        this.skipped =  skipped;
    }
}

module.exports = ExplodedObject;