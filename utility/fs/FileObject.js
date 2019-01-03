"use strict";

/**
 * represents an object which will be used to write a file or symlink to the file system
 */
class FileObject {
    constructor(path, value, link_path) {
        this.path = path;
        this.value = value;
        this.link_path = link_path;
    }
}

module.exports = FileObject;