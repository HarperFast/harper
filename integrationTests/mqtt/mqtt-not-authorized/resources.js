server.mqtt.authorizeClient = (connection) => {
	if (connection.clientId?.startsWith('denied-')) {
		throw Object.assign(new Error('client id is not permitted'), { statusCode: 403 });
	}
};
