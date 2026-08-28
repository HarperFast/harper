/**
 * Start monitoring for MQTT events, ensuring that we have a SYS_CON table to pub/sub the events
 * and return that table so that we can subscribe to it.
 * @param ensureTable
 * @return {*}
 */
export function startMonitoring(ensureTable) {
	const { clustering } = server.config;
	// Note that this won't necessarily work with new replication, where
	// replication config is spelled "replication" instead of "clustering"
	const NODE_NAME = clustering?.nodeName;
	const SYS_CON = ensureTable({ table: 'SYS_CON', database: 'mqtt_monitor', attributes: [] });
	if (!server.mqtt?.events) return; // on the main thread, there are no MQTT events to monitor
	server.mqtt.events.on('connection', async (socket) => {
		await SYS_CON.publish(['monitor', 'con', 'connects'], {
			timestamp: Date.now(),
			remoteAddress: socket?.remoteAddress,
			remotePort: socket?.remotePort,
			type: 'connecting',
			instance_name: NODE_NAME
		});
	});
	server.mqtt.events.on('connected', async (session, socket) => {
		await SYS_CON.publish('connects', {
			timestamp: Date.now(),
			remoteAddress: socket?.remoteAddress,
			remotePort: socket?.remotePort,
			type: 'connected',
			instance_name: NODE_NAME,
			clientId: session?.sessionId,
			userName: session?.user?.username,
			authGroups: session?.user?.authGroups
		});
	});
	server.mqtt.events.on('disconnected', async (session, socket) => {
		await SYS_CON.publish('drops', {
			timestamp: Date.now(),
			remoteAddress: socket?.remoteAddress,
			remotePort: socket?.remotePort,
			type: 'disconnected',
			instance_name: NODE_NAME,
			clientId: session?.sessionId,
			userName: session?.user?.username,
			authGroups: session?.user?.authGroups
		});
	});
	server.mqtt.events.on('auth-failed', async (session, socket, error) => {
		await SYS_CON.publish('errors', {
			timestamp: Date.now(),
			remoteAddress: socket?.remoteAddress,
			remotePort: socket?.remotePort,
			type: 'auth-failed',
			error: error?.message,
			instance_name: NODE_NAME,
			clientId: session?.clientId,
			userName: session?.username,
		});
	});
	server.mqtt.events.on('error', async (error, socket, packet, session) => {
		if(error.message === 'Unauthorized access to resource') {
			server.recordAnalytics(true, "acl-fail", packet.topic);
		}
		await SYS_CON.publish('errors', {
			timestamp: Date.now(),
			remoteAddress: socket?.remoteAddress,
			remotePort: socket?.remotePort,
			type: 'error',
			error: error?.message,
			instance_name: NODE_NAME,
			clientId: session?.clientId,
			userName: session?.username
		});
	});
	return SYS_CON;
}