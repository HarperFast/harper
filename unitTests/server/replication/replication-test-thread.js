const { createNode, createTestTable } = require('./setup-replication');

async function startNode() {
	try {
		const index = +process.argv[2];
		const database_path = process.argv[3];
		const TestTable = await createTestTable(index, database_path);
		await createNode(index, database_path, 3);

		//await new Promise((resolve) => setTimeout(resolve, 1000));
		process.send({ type: 'replication-started' });
		process.on('message', (message) => {
			if (message.action === 'put') {
				TestTable.put(message.data);
			}
		});
	} catch (e) {
		console.error(e);
	}
}
startNode();
