import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import env from '../utility/environment/environmentManager.js';

Object.defineProperty(server, 'hostname', {
	get() {
		return getThisNodeName();
	},
	configurable: true, // allow component to override this
});

let commonNameFromCert: string | undefined;
function getCommonNameFromCert() {
	if (commonNameFromCert !== undefined) return commonNameFromCert;
	const certificatePath: string | undefined =
		env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE) || env.get(CONFIG_PARAMS.TLS_CERTIFICATE);
	if (certificatePath) {
		// we can use this to get the hostname if it isn't provided by config
		const certParsed = new X509Certificate(readFileSync(certificatePath));
		const subject = certParsed.subject;
		return (commonNameFromCert = subject?.match(/CN=(.*)/)?.[1] ?? null);
	}
}

let nodeName: string | undefined;
export function getThisNodeName(): string {
	return (
		nodeName ||
		(nodeName =
			env.get(CONFIG_PARAMS.NODE_HOSTNAME) ??
			getCommonNameFromCert() ??
			getHostFromListeningPort('operationsapi_network_secureport') ??
			getHostFromListeningPort('operationsapi_network_port') ??
			'127.0.0.1')
	);
}

export function clearThisNodeName() {
	nodeName = undefined;
}

function getHostFromListeningPort(key: string) {
	const port: string | undefined = env.get(key);
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) return port.slice(0, lastColon);
}
function getPortFromListeningPort(key: string) {
	const port: string | undefined = env.get(key);
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) return +port.slice(lastColon + 1).replace(/[[\]]/g, '');
	return +port;
}

export function hostnameToUrl(hostname) {
	let port = getPortFromListeningPort('operationsapi_network_port');
	if (port) return `ws://${hostname}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_secureport');
	if (port) return `wss://${hostname}:${port}`;
}

export function urlToNodeName(nodeUrl?: string | URL): string | undefined {
	if (nodeUrl) return new URL(nodeUrl).hostname; // this the part of the URL that is the node name, as we want it to match common name in the certificate
}

export function getThisNodeUrl() {
	const url: string | undefined = env.get(CONFIG_PARAMS.NODE_URL);
	if (url) return url;
	return hostnameToUrl(getThisNodeName());
}
