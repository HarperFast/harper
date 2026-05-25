import systemSchema from '../json/systemSchema.json';
import { promisify } from 'util';
import { getDatabases } from '../resources/databases.ts';

export const setSchemaDataToGlobalAsync = promisify(setSchemaDataToGlobal);

export function setSchemaDataToGlobal(callback?: any) {
	(global as any).hdb_schema = getDatabases();
	if (callback) callback();
}

export function getTableSchema(schemaName: string, tableName: string, callback: any) {
	const database = getDatabases()[schemaName];
	if (!database) {
		return callback(`schema ${schemaName} does not exist`);
	}
	const table = database[tableName];
	if (!table) {
		return callback(`table ${schemaName}.${tableName} does not exist`);
	}
	return callback(null, {
		schema: schemaName,
		name: tableName,
		hash_attribute: table.primaryKey,
	});
}

export function getSystemSchema() {
	return systemSchema;
}
