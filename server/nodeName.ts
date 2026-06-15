import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { logger } from '../utility/logging/logger.ts';
import { server } from './Server.ts';

Object.defineProperty(server, 'hostname', {
	get() {
		return getThisNodeName();
	},
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
	if (nodeName) return nodeName; // if already determined, just return
	nodeName = env.get(CONFIG_PARAMS.NODE_HOSTNAME); // standard config
	if (nodeName) {
		const replicationHostname = env.get('replication_hostname');
		if (replicationHostname && replicationHostname !== nodeName) {
			// If these are both set and differ, the node identity is ambiguous. node.hostname
			// wins (it is what this node identifies as), but if it doesn't match the name this
			// node is registered under in hdb_nodes, replication for that name silently turns
			// off (harper-pro#351). Do NOT blindly recommend cementing the already-picked
			// node.hostname value — that's how a wrong identity (e.g. 'localhost') gets locked
			// in. Steer the operator to reconcile against the registered node name instead.
			logger.warn?.(
				`The node.hostname (${nodeName}) and replication.hostname (${replicationHostname}) configuration values are both set and differ. This node will identify as "${nodeName}". Ensure that name matches this node's row in system.hdb_nodes; if it does not, set node.hostname (or remove it to fall back to replication.hostname) to match the registered node name, otherwise replication for this node will be disabled.`
			);
		}
		return nodeName;
	}
	// fallback to other means of getting the node name
	nodeName =
		env.get('replication_hostname') ?? // for backwards compatibility
		urlToNodeName(env.get('replication_url') as string) ??
		getCommonNameFromCert() ??
		getHostFromListeningPort('operationsapi_network_secureport') ??
		getHostFromListeningPort('operationsapi_network_port') ??
		'127.0.0.1';
	return nodeName;
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
	if (!hostname) return undefined;
	let port = getPortFromListeningPort('replication_port');
	if (port) return `ws://${hostname}:${port}`;
	port = getPortFromListeningPort('replication_secureport');
	if (port) return `wss://${hostname}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_port');
	if (port) return `ws://${hostname}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_secureport');
	if (port) return `wss://${hostname}:${port}`;
}

export function urlToNodeName(nodeUrl?: string | URL): string | undefined {
	if (nodeUrl) return new URL(nodeUrl).hostname; // this the part of the URL that is the node name, as we want it to match common name in the certificate
}

export function getThisNodeUrl() {
	const url: string | undefined = env.get(CONFIG_PARAMS.REPLICATION_URL);
	if (url) return url;
	return hostnameToUrl(getThisNodeName());
}
