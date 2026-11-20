import { packageJson } from '../utility/packageUtils.js';
import { SERVER_CAPABILITIES } from '../utility/serverCapabilities.ts';

/** This node's Harper version, and what it does that a client cannot infer from that version. */
export function getServerInfo() {
	return {
		version: packageJson.version,
		capabilities: [...SERVER_CAPABILITIES],
	};
}
