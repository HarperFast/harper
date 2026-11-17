import { packageJson } from '../utility/packageUtils.js';
import { SERVER_CAPABILITIES } from '../utility/serverCapabilities.ts';

export function getRegistrationInfo() {
	return {
		version: packageJson.version,
		deprecated: true,
		capabilities: [...SERVER_CAPABILITIES],
	};
}
