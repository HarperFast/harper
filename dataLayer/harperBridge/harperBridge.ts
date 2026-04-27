import { ResourceBridge } from './ResourceBridge.js';
import envMngr from '../../utility/environment/environmentManager.js';
envMngr.initSync();

let harperBridge: ResourceBridge;

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
