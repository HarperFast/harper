import { dirname } from 'path';
import { table } from './databases';
import { getWorkerIndex } from '../server/threads/manageThreads';

const PRIMITIVE_TYPES = ['ID', 'Int', 'Float', 'Long', 'String', 'Boolean', 'Date', 'Bytes', 'Any', 'BigInt'];

/**
 * This is the entry point for handling GraphQL schemas (and server-side defined queries, eventually). This will be
 * called for schemas, and this will parse the schema (into an AST), and use it to ensure all specified tables and their
 * attributes exist. This is intended to be the default/primary way to define a table in HarperDB. This supports various
 * directives for configuring indexing, attribute types, table configuration, and more.
 *
 * @param gql_content
 * @param relative_path
 * @param file_path
 * @param resources
 */
export function start({ ensureTable }) {
	return {
		handleFile,
		setupFile: handleFile,
	};

	async function handleFile(gql_content, url_path, file_path, resources) {
		// lazy load the graphql package so we don't load it for users that don't use graphql
		const { parse, Source, Kind, NamedTypeNode, StringValueNode } = await import('graphql');
		const ast = parse(new Source(gql_content.toString(), file_path));
		const types = new Map();
		const tables = [];
		let query;
		// we begin by iterating through the definitions in the AST to get the types and convert them
		// to a friendly format for table attributes
		for (const definition of ast.definitions) {
			switch (definition.kind) {
				case Kind.OBJECT_TYPE_DEFINITION:
					const type_name = definition.name.value;
					// use type name as the default table
					const properties = [];
					const type_def = { table: null, database: null, properties };
					types.set(type_name, type_def);
					for (const directive of definition.directives) {
						if (directive.name.value === 'table') {
							for (const arg of directive.arguments) {
								type_def[arg.name.value] = (arg.value as StringValueNode).value;
							}
							if (type_def.schema) type_def.database = type_def.schema;
							if (!type_def.table) type_def.table = type_name;
							if (type_def.audit) type_def.audit = type_def.audit !== 'false';
							type_def.attributes = type_def.properties;
							tables.push(type_def);
						}
						if (directive.name.value === 'sealed') {
							type_def.sealed = true;
						}
						if (directive.name.value === 'export') {
							type_def.export = true;
							for (const arg of directive.arguments) {
								if (arg.name.value === 'name') type_def.export = { name: (arg.value as StringValueNode).value };
							}
						}
					}
					let has_primary_key = false;
					function getProperty(type) {
						if (type.kind === 'NonNullType') {
							const property = getProperty(type.type);
							property.nullable = false;
							return property;
						}
						if (type.kind === 'ListType') {
							return {
								type: 'array',
								elements: getProperty(type.type),
							};
						}
						const type_name = (type as NamedTypeNode).name?.value;
						const property = { type: type_name };
						Object.defineProperty(property, 'location', { value: type.loc.startToken });
						return property;
					}
					for (const field of definition.fields) {
						const property = getProperty(field.type);
						property.name = field.name.value;
						properties.push(property);
						for (const directive of field.directives) {
							if (directive.name.value === 'primaryKey') {
								if (has_primary_key) console.warn('Can not define two attributes as a primary key');
								else {
									property.isPrimaryKey = true;
									has_primary_key = true;
								}
							} else if (directive.name.value === 'indexed') {
								property.indexed = true;
							} else if (directive.name.value === 'relationship') {
								const relationship_definition = {};
								for (const arg of directive.arguments) {
									relationship_definition[arg.name.value] = (arg.value as StringValueNode).value;
								}
								property.relationship = relationship_definition;
							} else if (directive.name.value === 'createdTime') {
								property.assignCreatedTime = true;
							} else if (directive.name.value === 'updatedTime') {
								property.assignUpdatedTime = true;
							} else if (directive.name.value === 'expiresAt') {
								property.expiresAt = true;
							} else if (directive.name.value === 'allow') {
								const authorized_roles = (property.authorizedRoles = []);
								for (const arg of directive.arguments) {
									if (arg.name.value === 'role') {
										authorized_roles.push((arg.value as StringValueNode).value);
									}
								}
							}
						}
					}
					type_def.type = type_name;
					if (type_name === 'Query') {
						query = type_def;
					}
			}
		}
		// check the types and if any types reference other types, fill those in.
		function connectPropertyType(property) {
			const target_type_def = types.get(property.type);
			if (target_type_def) {
				Object.defineProperty(property, 'properties', { value: target_type_def.properties });
				Object.defineProperty(property, 'definition', { value: target_type_def });
			} else if (property.type === 'array') connectPropertyType(property.elements);
			else if (!PRIMITIVE_TYPES.includes(property.type)) {
				if (getWorkerIndex() === 0)
					console.error(
						`The type ${property.type} is unknown at line ${property.location.line}, column ${property.location.column}, in ${file_path}`
					);
			}
		}
		for (const type_def of types.values()) {
			for (const property of type_def.properties) connectPropertyType(property);
		}
		// any tables that are defined in the schema can now be registered
		for (const type_def of tables) {
			// with graphql database definitions, this is a declaration that the table should exist and that it
			// should be created if it does not exist
			type_def.tableClass = ensureTable(type_def);
			if (type_def.export) {
				// allow empty string to be used to declare a table on the root path
				if (type_def.export.name === '') resources.set(dirname(url_path), type_def.tableClass);
				else resources.set(dirname(url_path) + '/' + (type_def.export.name || type_def.type), type_def.tableClass);
			}
		}
		// and if there was a `type Query` definition, we use that to created exported resources
		if (query) {
			for (const property of query.properties) {
				const type_def = types.get(property.type);
				if (!type_def) throw new Error(`${property.type} was not found as a Query export`);
				resources.set(dirname(url_path) + '/' + property.name, type_def.tableClass);
			}
		}
	}
}

export const startOnMainThread = start;
// useful for testing
export const loadGQLSchema = start({ ensureTable: table }).handleFile;
