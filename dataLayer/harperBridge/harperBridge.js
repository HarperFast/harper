'use strict';

const { ResourceBridge } = require('./ResourceBridge.ts');
const envMngr = require('../../utility/environment/environmentManager.js');
envMngr.initSync();

let harperBridge; // ResourceBridge

/**
 *
 * @returns {ResourceBridge|undefined}
 */
function getBridge() {
	if (harperBridge) {
		return harperBridge;
	}
	harperBridge = new ResourceBridge();
	return harperBridge;
}

module.exports = getBridge();
