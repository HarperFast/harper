"use strict";

const FileSystemBridge = require('./fsBridge/FileSystemBridge');
const HeliumBridge = require('./heliumBridge/HeliumBridge');

const terms = require('../../utility/hdbTerms');

let harper_bridge = undefined;

function getBridge() {
    if (harper_bridge) {
        return harper_bridge;
    }

    //if harper_bridge has not been set, identify the correct data store, instantiate and return the associated bridge class
    const data_store = getDataStoreType();
    switch (data_store) {
        case terms.HDB_DATA_STORE_TYPES.FILE_SYSTEM:
            harper_bridge = new FileSystemBridge();
            break;
        case terms.HDB_DATA_STORE_TYPES.HELIUM:
            harper_bridge = new HeliumBridge();
            break;
        default:
            harper_bridge = new FileSystemBridge();
    }
    return harper_bridge;
}

function getDataStoreType() {
    //Process for parsing correct data store type from HDB license is still TBD
    return terms.HDB_DATA_STORE_TYPES.FILE_SYSTEM;
}

module.exports = getBridge();