export const SERVERS = {};

export const portServer = new Map();

export function setPortServerMap(port, server) {
	const portEntry = portServer.get(port) ?? [];
	portServer.set(port, [...portEntry, server]);
}
