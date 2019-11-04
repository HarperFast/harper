"use strict";

const BridgeMethods = require("./BridgeMethods");
const hdb_license = require('../../utility/registration/hdb_license');
const license = hdb_license.licenseSearch();
const terms = require('../../utility/hdbTerms');

const FileSystemBridge = require('./fsBridge/FileSystemBridge');
let harper_bridge = undefined;

function getDataStoreType() {
    return license.storage_type;
}

function getBridge() {
    if (harper_bridge instanceof BridgeMethods) {
        return harper_bridge;
    }

    //if harper_bridge has not been set, identify the correct data store, instantiate and return the associated bridge class
    const data_store = getDataStoreType();
    switch (data_store) {
        case terms.STORAGE_TYPES_ENUM.FILE_SYSTEM:

            harper_bridge = new FileSystemBridge();
            break;
        case terms.STORAGE_TYPES_ENUM.HELIUM:
            const HeliumBridge = require('./heBridge/HeliumBridge');
            harper_bridge = new HeliumBridge();
            break;
        default:

            harper_bridge = new FileSystemBridge();
    }
    return harper_bridge;
}

module.exports = getBridge();