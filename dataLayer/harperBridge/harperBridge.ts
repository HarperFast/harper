'use strict';

import { ResourceBridge } from './ResourceBridge.ts';
import * as envMngr from '../../utility/environment/environmentManager.ts';
try {
	envMngr.initSync();
} catch {
	/* tolerate ESM cycle TDZ; bin entry will re-call later */
}
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
