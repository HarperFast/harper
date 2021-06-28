"use strict";

const LMDBBridge = require('./lmdbBridge/LMDBBridge');
const BridgeMethods = require("./BridgeMethods");
const env_mngr = require('../../utility/environment/environmentManager');
if(!env_mngr.isInitialized()){
    env_mngr.initSync();
}

let harper_bridge = undefined;

/**
 *
 * @returns {LMDBBridge|undefined}
 */
function getBridge() {
    if (harper_bridge instanceof BridgeMethods) {
        return harper_bridge;
    }

    return new LMDBBridge();
}

module.exports = getBridge();