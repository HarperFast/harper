import { packageJson } from '../utility/packageUtils.js';

export function getRegistrationInfo() {
	return {
		version: packageJson.version,
		deprecated: true,
	}
}
