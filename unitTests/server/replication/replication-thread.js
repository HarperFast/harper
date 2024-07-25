const { createNode, createTestTable } = require('./setup-replication');

async function startNode() {
	try {
		const index = +process.argv[2];
		const database_path = process.argv[3];
		const TestTable = await createTestTable(database_path);
		await createNode(index, database_path, 3);

		//await new Promise((resolve) => setTimeout(resolve, 1000));
		process.send({ type: 'replication-started' });
		process.on('message', async (message) => {
			if (message.action === 'put') {
				TestTable.put(message.data, message);
			}
			if (message.action === 'get') {
				const data = await TestTable.get(message.id);
				process.send({ type: 'get-result', data });
			}
		});
	} catch (e) {
		console.error(e);
	}
}
startNode();
