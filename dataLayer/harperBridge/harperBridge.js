'use strict';

const { ResourceBridge } = require('./ResourceBridge');
const env_mngr = require('../../utility/environment/environmentManager');
env_mngr.initSync();

let harper_bridge;

/**
 *
 * @returns {LMDBBridge|undefined}
 */
function getBridge() {
	if (harper_bridge) {
		return harper_bridge;
	}
	harper_bridge = new ResourceBridge();
	return harper_bridge;
}

module.exports = getBridge();
