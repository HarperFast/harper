'use strict';

const { ResourceBridge } = require('./ResourceBridge.ts');
const envMngr = require('../../utility/environment/environmentManager.js');
envMngr.initSync();

let harperBridge;

/**
 *
 * @returns {LMDBBridge|undefined}
 */
function getBridge() {
	if (harperBridge) {
		return harperBridge;
	}
	harperBridge = new ResourceBridge();
	return harperBridge;
}

module.exports = getBridge();
