export const SERVERS = {};

// Socket hygiene defaults shared by every listener Harper creates (HTTP/S, TLS, plain TCP, UDS mirrors),
// kept in one place so the values can't drift between listener types.
export const socketOptionDefaults = {
	noDelay: true, // don't delay for Nagle's algorithm, it is a relic of the past that slows things down: https://brooker.co.za/blog/2024/05/09/nagle.html
	keepAlive: true, // probe idle connections so dead peers are proactively detected and closed
	keepAliveInitialDelay: 600_000, // in ms (net.Server floors it to whole seconds): probe after 10 minutes idle
};

export const portServer = new Map();

export function setPortServerMap(port, server) {
	const portEntry = portServer.get(port) ?? [];
	portServer.set(port, [...portEntry, server]);
}
