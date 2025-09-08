import { packageJson } from '../utility/packageUtils.js';

export function getRegistrationInfo() {
	return {
		version: packageJson.version,
		deprecated: true,
	}
}

export function getFingerprint() {
	return {
		message: "this-is-deprecated",
		deprecated: true,
	}
}

export function setLicense() {
	return {
		deprecated: true,
	}
}
