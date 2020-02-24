"use strict";

const LMDBBridge = require('./lmdbBridge/LMDBBridge');
const BridgeMethods = require("./BridgeMethods");
const terms = require('../../utility/hdbTerms');
const env_mngr = require('../../utility/environment/environmentManager');
if(!env_mngr.isInitialized()){
    env_mngr.initSync();
}


let harper_bridge = undefined;

function getBridge() {
    if (harper_bridge instanceof BridgeMethods) {
        return harper_bridge;
    }

    //if harper_bridge has not been set, identify the correct data store, instantiate and return the associated bridge class
    const data_store = env_mngr.getDataStoreType();
    switch (data_store) {
        case terms.STORAGE_TYPES_ENUM.FILE_SYSTEM:
            const FileSystemBridge = require('./fsBridge/FileSystemBridge');
            harper_bridge = new FileSystemBridge();
            break;
        case terms.STORAGE_TYPES_ENUM.LMDB:
            harper_bridge = new LMDBBridge();
            break;
        default:
            harper_bridge = new LMDBBridge();
            break;
    }
    return harper_bridge;
}

module.exports = getBridge();