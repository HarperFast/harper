import { table } from '#src/resources/databases';
import { schemaHandler } from '#src/server/itc/serverHandlers';
import { waitFor } from '../../waitFor.js';

export async function writeSettled(database: string, id: string, data: Record<string, unknown>) {
	let settled = false;
	const remove = schemaHandler.addListener((message) => {
		if (message.schema === database && message.table === 'Record') settled = true;
	});
	try {
		const Own = table({
			database,
			table: 'Record',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Own.put(id, data);
		await waitFor(() => settled);
		return Own;
	} finally {
		remove();
	}
}
