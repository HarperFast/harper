import { table } from './tableLoader';
import { isMainThread } from 'worker_threads';
import { dirname } from 'path';
import { snake_case } from './Table';
import { createRequire } from 'module';
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
export async function handleFile(gql_content, url_path, file_path, resources) {
	// lazy load the graphql package so we don't load it for users that don't use graphql
	const { parse, Source, Kind, NamedTypeNode, StringValueNode } = require('graphql');
	// This crashes Node:
	//const { parse, Source, Kind, NamedTypeNode, StringValueNode } = await import('graphql');
	const ast = parse(new Source(gql_content.toString(), file_path));
	const handlers = new Map();
	const types = new Map();
	for (const definition of ast.definitions) {
		switch (definition.kind) {
			case Kind.OBJECT_TYPE_DEFINITION:
				const type_name = definition.name.value;
				// use type name as the default table (converted to snake case)
				const type_def = { table: null, database: null, attributes: [], table: null };
				types.set(type_name, type_def);
				for (const directive of definition.directives) {
					if (directive.name.value === 'table') {
						for (const arg of directive.arguments) {
							type_def[arg.name.value] = (arg.value as StringValueNode).value;
						}
						if (type_def.schema) type_def.database = type_def.schema;
						if (!type_def.table) type_def.table = snake_case(type_name);
					}
					if (directive.name.value === 'sealed') {
						type_def.sealed = true;
					}
				}
				if (type_def.table) {
					const attributes = [];
					let has_primary_key = false;
					for (const field of definition.fields) {
						const type = (field.type as NamedTypeNode).name?.value;
						const attribute = {
							name: field.name.value,
							type,
							is_number: type === 'Int' || type === 'Float',
						};
						attributes.push(attribute);
						for (const directive of field.directives) {
							if (directive.name.value === 'primaryKey') {
								if (has_primary_key) console.warn('Can not define two attributes as a primary key');
								else {
									attribute.is_primary_key = true;
									has_primary_key = true;
								}
							} else if (directive.name.value === 'indexed') {
								attribute.indexed = true;
							}
						}
						if (!has_primary_key) {
							const id_attribute = attributes.find((attribute) => attribute.name === 'id');
							if (id_attribute) id_attribute.is_primary_key = true;
							// Do we wait until we have auto-incrementing numbers before auto-adding a primary key?
							else
								attributes.push({
									name: 'id',
									type: 'ID',
									is_primary_key: true,
								});
						}
					}
					type_def.attributes = attributes;
					// with graphql database definitions, this is a declaration that the table should exist and that it
					// should be created if it does not exist
					type_def.tableClass = await table(type_def);
				}
				if (type_name === 'Query') {
					for (const field of definition.fields) {
						const query_name = field.name.value;
						const type_name = (field.type as NamedTypeNode).name.value;
						const type_def = types.get(type_name);
						const authorized_roles = [];
						for (const directive of definition.directives) {
							if (directive.name.value === 'allow') {
								for (const arg of directive.arguments) {
									if (arg.name.value === 'role') {
										authorized_roles.push((arg.value as StringValueNode).value);
									}
								}
							}
						}
						// Eventually we may create a custom resource that is generated for this query and instantiated for
						// each request, that can handle any GraphQL defined sets of properties that should be returned
						/*class GraphQLResource extends Resource {
							get(id) {
								let role = this.user?.role;
								if (role && authorized_roles.indexOf(role.name) > -1 ||
										role?.permission?.super_user) {
									let record = this.useTable(type_def.table, type_def.database)?.get(id);
									return record;
								} else throw new Error('Unauthorized');
							}
							subscribe(path, options) {
								let role = this.user?.role;
								if (role && authorized_roles.indexOf(role.name) > -1 ||
									role?.permission?.super_user) {
									return this.useTable(type_def.table, type_def.database)?.subscribe(path, options);
								} else throw new Error('Unauthorized');
							}
							put(id, body) {
								return this.useTable(type_def.table, type_def.database)?.put(id, body);
							}
						}
						handlers.set(query_name, restHandler(GraphQLResource));*/
						// the main thread should only be setting up tables, worker threads actually register the resources
						// for server usage
						resources.set(dirname(url_path) + '/' + query_name, type_def.tableClass);
						//handlers.set(query_name, restHandler(relative_path + '/' + query_name, type_def.tableClass));
					}
				}
		}
	}
	return handlers;
}

export const setupFile = handleFile;
