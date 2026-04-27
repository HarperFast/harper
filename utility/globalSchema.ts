import * as systemSchema from '../json/systemSchema.json';
import { promisify } from 'util';
import { getDatabases } from '../resources/databases.js';

export {
	setSchemaDataToGlobal,
	getTableSchema,
	getSystemSchema,
	setSchemaDataToGlobalAsync,
};

const setSchemaDataToGlobalAsync = promisify(setSchemaDataToGlobal);

function setSchemaDataToGlobal(callback: () => void) {
	(global as any).hdb_schema = getDatabases();
	if (callback) callback();
}

function getTableSchema(schemaName: string, tableName: string, callback: (err: any, data?: any) => void) {
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

function getSystemSchema(): any {
	return systemSchema;
}
