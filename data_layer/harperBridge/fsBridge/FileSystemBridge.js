"use strict";

const BridgeMethods = require("../BridgeMethods.js");
const fsGetDataByHash = require("./fsMethods/fsGetDataByHash");

class FileSystemBridge extends BridgeMethods {

    getDataByHash(search_object, callback) {
        return fsGetDataByHash(search_object, callback);
    }

    searchByHash(search_object, callback) {
        fsGetDataByHash(search_object, (error, data) => {
            if (error) {
                callback(error);
                return;
            }

            const search_results = Object.values(data);
            callback(null, search_results);
        });
    }

}


module.exports = FileSystemBridge;