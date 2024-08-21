export { Resource } from './resources/Resource';
import { Resource as Resource_import } from './resources/Resource';
export { Query, Context, SubscriptionRequest } from './resources/ResourceInterface';
export { server } from './server/Server';
import { server as server_import } from './server/Server';
export { tables, databases } from './resources/databases';
import { tables as db_tables, databases as db_databases } from './resources/databases';
declare global {
	const tables: typeof db_tables;
	const databases: typeof db_databases;
	const server: typeof server_import;
	const Resource: typeof Resource_import;
}
