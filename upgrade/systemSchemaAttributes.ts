import { databases } from '../resources/databases.ts';
import systemSchema from '../json/systemSchema.json';
import hdbLogger from '../utility/logging/harper_logger.ts';

interface SchemaAttribute {
	attribute?: string;
	name?: string;
	indexed?: unknown;
	isPrimaryKey?: boolean;
}

/**
 * Register every attribute `json/systemSchema.json` declares on a system table that already exists but lacks it.
 * A fresh install builds each table from the schema, while an upgraded one keeps the catalog its table was created
 * with, so an attribute added later reaches it only through this. It only adds: an attribute the catalog has is
 * left as it is, and a table this node does not have is skipped.
 */
export async function registerSystemSchemaAttributes(): Promise<string[]> {
	const registered: string[] = [];
	for (const [tableName, definition] of Object.entries(
		systemSchema as Record<string, { attributes?: SchemaAttribute[] }>
	)) {
		const Table = (databases as any).system?.[tableName];
		if (!Table) continue;
		const present = new Set<string>(Table.attributes.map((attribute: { name: string }) => attribute.name));
		const missing = [];
		for (const attribute of definition.attributes ?? []) {
			const name = attribute.name ?? attribute.attribute;
			if (!name || attribute.isPrimaryKey || present.has(name)) continue;
			// The legacy `{ attribute }` form, which most entries use, is indexed when a fresh install creates the table.
			missing.push({ name, indexed: attribute.name ? attribute.indexed : true });
		}
		if (missing.length === 0) continue;
		hdbLogger.info(`Registering ${missing.map(({ name }) => name).join(', ')} on system.${tableName}`);
		await Table.addAttributes(missing);
		registered.push(...missing.map(({ name }) => `${tableName}.${name}`));
	}
	return registered;
}
