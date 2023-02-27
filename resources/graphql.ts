import { table } from './database';
import { isMainThread } from 'worker_threads';
import { dirname } from 'path';
import { snake_case } from './Table';
/*import { registerResourceType } from './resource-server';

export function registerGraphQL() {
	registerResourceType('graphql', createHandler);
	registerResourceType('gql', createHandler);
}*/
export async function handleFile(gql_content, relative_path, file_path, resources) {
	// lazy load the graphql package so we don't load it for users that don't use graphql
	const { parse, Source, Kind, NamedTypeNode, StringValueNode } = await import('graphql');
	let ast = parse(new Source(gql_content.toString(), file_path));
	let handlers = new Map();
	let types = new Map();
	for (let definition of ast.definitions) {
		switch (definition.kind) {
			case Kind.OBJECT_TYPE_DEFINITION:
				let type_name = definition.name.value;
				// use type name as the default table (converted to snake case)
				let type_def = { table: null, schema: null, attributes: [], table: null };
				types.set(type_name, type_def);
				for (let directive of definition.directives) {
					if (directive.name.value === 'table') {
						for (let arg of directive.arguments) {
							type_def.table = (arg.value as StringValueNode).value;
						}
						if (!type_def.table)
							type_def.table = snake_case(type_name);
					}
					if (directive.name.value === 'sealed') {
						type_def.sealed = true;
					}
				}
				if (type_def.table) {
					let attributes = [];
					let has_primary_key = false;
					for (let field of definition.fields) {
						let type = (field.type as NamedTypeNode).name?.value;
						let attribute = {
							name: field.name.value,
							type,
							is_number: type === 'Int' || type === 'Float',
						};
						attributes.push(attribute);
						for (let directive of field.directives) {
							if (directive.name.value === 'primaryKey') {
								if (has_primary_key)
									console.warn('Can not define two attributes as a primary key');
								else {
									attribute.is_primary_key = true;
									has_primary_key = true;
								}
							} else if (directive.name.value === 'indexed') {
								attribute.indexed = true;
							}
						}
						if (!has_primary_key) {
							let id_attribute = attributes.find(attribute => attribute.name === 'id');
							if (id_attribute)
								id_attribute.is_primary_key = true;
							else
								// Do we wait until we have auto-incrementing numbers before auto-adding a primary key?
								attributes.push({
									name: 'id',
									type: 'ID',
									is_primary_key: true,
								});
						}
					}
					type_def.attributes = attributes;
					// with graphql schema definitions, this is a declaration that the table should exist and that it
					// should be created if it does not exist
					type_def.tableClass = await table(type_def);
				}
				if (type_name === 'Query') {
					for (let field of definition.fields) {
						let query_name = field.name.value;
						let type_name = (field.type as NamedTypeNode).name.value;
						let type_def = types.get(type_name);
						let authorized_roles = [];
						for (let directive of definition.directives) {
							if (directive.name.value === 'allow') {
								for (let arg of directive.arguments) {
									if (arg.name.value === 'role') {
										authorized_roles.push((arg.value as StringValueNode).value);
									}
								}
							}
						}
						// the resource that is generated for this query and instantiated for each request:
						/*class GraphQLResource extends Resource {
							get(id) {
								let role = this.user?.role;
								if (role && authorized_roles.indexOf(role.name) > -1 ||
										role?.permission?.super_user) {
									let record = this.useTable(type_def.table, type_def.schema)?.get(id);
									return record;
								} else throw new Error('Unauthorized');
							}
							subscribe(path, options) {
								let role = this.user?.role;
								if (role && authorized_roles.indexOf(role.name) > -1 ||
									role?.permission?.super_user) {
									return this.useTable(type_def.table, type_def.schema)?.subscribe(path, options);
								} else throw new Error('Unauthorized');
							}
							put(id, body) {
								return this.useTable(type_def.table, type_def.schema)?.put(id, body);
							}
						}
						handlers.set(query_name, restHandler(GraphQLResource));*/
						if (!isMainThread) {
							let web_path = dirname(relative_path);
							if (web_path === '.') web_path = '/';
							else web_path = '/' + web_path + '/';
							resources.set(web_path + query_name, type_def.tableClass);
							//handlers.set(query_name, restHandler(relative_path + '/' + query_name, type_def.tableClass));
						}
					}
				}
		}
	}
	return handlers;
}

export const setupFile = handleFile;
