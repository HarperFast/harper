import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './packageUtils.js';
import { promisify } from 'util';
// Import JSON without static import attributes (unsupported in CJS output; `with {type:'json'}` unsupported in tsc NodeNext+CJS)
const systemSchema: Record<string, any> = JSON.parse(
	readFileSync(join(PACKAGE_ROOT, 'json/systemSchema.json'), 'utf-8')
);
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
