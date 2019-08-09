"use strict";

const BridgeMethods = require("../BridgeMethods.js");
const fsGetDataByHash = require("./fsMethods/fsGetDataByHash");

class FileSystemBridge extends BridgeMethods {

    async getDataByHash(search_object) {
        try {
            return await fsGetDataByHash(search_object);
        } catch(err) {
            throw err;
        }
    }

    async searchByHash(search_object) {
        try {
            const result_data = await fsGetDataByHash(search_object);
            const search_results = Object.values(result_data);

            return search_results;
        } catch(err) {
            throw err;
        }
    }

}

module.exports = FileSystemBridge;