import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { logger } from '../utility/logging/logger.ts';
import { bareHostViolation } from '../utility/nodeIdentity.ts';
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
		try {
			// use this to get the hostname if it isn't provided by config
			const subject = new X509Certificate(readFileSync(certificatePath)).subject;
			return (commonNameFromCert = subject?.match(/CN=(.*)/)?.[1] ?? null);
		} catch {
			// a missing/unparseable cert file must not throw out of identity resolution — the caller
			// falls back to another source. Do NOT cache the failure, so a later read (e.g. after the
			// cert is created) can still pick up its common name.
			return undefined;
		}
	}
}

let nodeName: string | undefined;
export function getThisNodeName(): string {
	if (nodeName) return nodeName; // if already determined, just return
	const configured = env.get(CONFIG_PARAMS.NODE_HOSTNAME);
	if (configured) {
		const replicationHostname = env.get('replication_hostname');
		if (replicationHostname && replicationHostname !== configured) {
			// If these are both set and differ, the node identity is ambiguous. node.hostname
			// wins (it is what this node identifies as), but if it doesn't match the name this
			// node is registered under in hdb_nodes, replication for that name silently turns
			// off (harper-pro#351). Do NOT blindly recommend cementing the already-picked
			// node.hostname value — that's how a wrong identity (e.g. 'localhost') gets locked
			// in. Steer the operator to reconcile against the registered node name instead.
			logger.warn?.(
				`The node.hostname (${configured}) and replication.hostname (${replicationHostname}) configuration values are both set and differ. This node will identify as "${configured}". Ensure that name matches this node's row in system.hdb_nodes; if it does not, set node.hostname (or remove it to fall back to replication.hostname) to match the registered node name, otherwise replication for this node will be disabled.`
			);
		}
	}
	// Use the first source that is a valid bare host (harper#2218). node.hostname and
	// replication.hostname are rejected at the config boundary when invalid; the remaining derived
	// sources are validated here and skipped — not fatal — if unusable, so a descriptive certificate
	// common name or an empty value can never cache a corrupt identity or crash a request-time caller.
	nodeName =
		asBareHost(configured, 'node.hostname') ??
		asBareHost(env.get('replication_hostname'), 'replication.hostname') ?? // for backwards compatibility
		asBareHost(replicationUrlHost(), 'the host in replication.url') ??
		asBareHost(getCommonNameFromCert(), 'the certificate common name') ??
		asBareHost(getHostFromListeningPort('operationsapi_network_secureport'), 'the operations API host') ??
		asBareHost(getHostFromListeningPort('operationsapi_network_port'), 'the operations API host') ??
		'127.0.0.1';
	return nodeName;
}

export function clearThisNodeName() {
	nodeName = undefined;
}

// Reduce a node name to a host safe to compose a display URL from: strip a scheme/port (defensive —
// a configured node.hostname carrying those is now rejected at the config boundary) and bracket a
// bare IPv6 literal, without which the composed startup URLs are unparseable.
export function nodeNameToDisplayHost(name: string): string {
	if (!name) return name;
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(name);
	const candidates = hasScheme ? [name] : [`http://${name}`, `http://[${name}]`];
	for (const candidate of candidates) {
		try {
			const { hostname } = new URL(candidate);
			if (hostname) return hostname;
		} catch {}
	}
	return name;
}

export function getThisNodeHostname(): string {
	return nodeNameToDisplayHost(getThisNodeName());
}

/**
 * The host of replication.url, or undefined when it is unset or carries no usable host. Warns in the
 * latter case for the same reason asBareHost does: a typo'd URL must not silently cost this node its
 * identity. urlToNodeName itself stays quiet — it is also used for peer URLs, not just this node's.
 */
function replicationUrlHost(): string | undefined {
	const url: string | undefined = env.get(CONFIG_PARAMS.REPLICATION_URL);
	if (!url) return undefined;
	const host = urlToNodeName(url);
	if (host === undefined) {
		logger.warn?.(
			`Ignoring replication.url (${JSON.stringify(url)}) as this node's identity: it is not a URL with a host. Falling back to the next available source, which may leave this node identifying as 127.0.0.1 and unable to replicate.`
		);
	}
	return host;
}

/**
 * A candidate identity source, or undefined when it is unset or not a bare host. Skipping is
 * deliberate (see getThisNodeName) but silence is a diagnosis trap: a typo'd source that quietly
 * resolves identity to 127.0.0.1 looks like a working node until replication fails, so say so.
 */
function asBareHost(value: unknown, source: string): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const violation = bareHostViolation(value);
	if (!violation) return value as string;
	logger.warn?.(
		`Ignoring ${source} (${JSON.stringify(value)}) as this node's identity: it ${violation}. Falling back to the next available source, which may leave this node identifying as 127.0.0.1 and unable to replicate. Set it to a bare hostname or IP literal.`
	);
	return undefined;
}

function getHostFromListeningPort(key: string) {
	const port: string | undefined = env.get(key);
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) {
		const host = port.slice(0, lastColon);
		// A listen address stores IPv6 bracketed ("[::1]:9925"); the node identity is unbracketed.
		return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	}
}
function getPortFromListeningPort(key: string) {
	const port: string | undefined = env.get(key);
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) return +port.slice(lastColon + 1).replace(/[[\]]/g, '');
	return +port;
}

export function hostnameToUrl(hostname) {
	if (!hostname) return undefined;
	// A bare IPv6 literal must be bracketed for the authority to parse: "ws://::1:9925" is rejected by
	// the URL parser, "ws://[::1]:9925" is not. Hostnames and IPv4 pass through unchanged.
	const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	let port = getPortFromListeningPort('replication_port');
	if (port) return `ws://${host}:${port}`;
	port = getPortFromListeningPort('replication_secureport');
	if (port) return `wss://${host}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_port');
	if (port) return `ws://${host}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_secureport');
	if (port) return `wss://${host}:${port}`;
}

export function urlToNodeName(nodeUrl?: string | URL): string | undefined {
	if (!nodeUrl) return undefined;
	try {
		// the part of the URL that is the node name, matched against the certificate common name. URL
		// keeps an IPv6 host bracketed ("[::1]"); the identity is stored unbracketed so it stays one
		// canonical string across sources and net.isIP types it as an IP certificate SAN.
		const host = new URL(nodeUrl).hostname;
		// A hostless scheme ("mailto:", "data:", "file:", "urn:") parses but has an empty hostname —
		// that is no name at all, not an identity, so treat it like a malformed URL.
		if (host === '') return undefined;
		return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	} catch {
		return undefined; // a malformed URL yields no name — callers skip this source rather than crash
	}
}

export function getThisNodeUrl() {
	const url: string | undefined = env.get(CONFIG_PARAMS.REPLICATION_URL);
	if (url) return url;
	return hostnameToUrl(getThisNodeName());
}
