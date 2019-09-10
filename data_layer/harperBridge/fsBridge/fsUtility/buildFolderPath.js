'use strict';

const path = require('path');

module.exports = buildFolderPath;

/**
 * takes an array of strings and joins them with the folder separator to return a path
 * @param path_elements
 */
function buildFolderPath(...path_elements){
    try {
        return path_elements.join(path.sep);
    } catch(e){
        console.error(path_elements);
    }
}
