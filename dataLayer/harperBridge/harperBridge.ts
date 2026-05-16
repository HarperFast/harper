'use strict';

import { ResourceBridge } from './ResourceBridge.ts';
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

export default getBridge();
