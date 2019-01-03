"use strict";

/**
 *
 */
class FileObject {
    constructor(path, value, link_path) {
        this.path = path;
        this.value = value;
        this.link_path = link_path;
    }
}

module.exports = FileObject;