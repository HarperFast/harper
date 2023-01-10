import { parse, Source, Kind, NamedTypeNode, StringValueNode } from 'graphql';
import { ensureTable } from './database';
import { Transaction } from './Transaction';
import { snake_case } from './Table';
import { registerResourceType } from './resource-server';
import {restHandler} from './REST-handler';

export function registerGraphQL() {
	registerResourceType('graphql', createHandler);
	registerResourceType('gql', createHandler);
	function createHandler(gql_content, file_path) {
		let ast = parse(new Source(gql_content, file_path));
		let handlers = new Map();
		let types = new Map();
		for (let definition of ast.definitions) {
			switch (definition.kind) {
				case Kind.OBJECT_TYPE_DEFINITION:
					let type_name = definition.name.value;
					// use type name as the default table (converted to snake case)
					let type_def = { table: null, schema: null };
					types.set(type_name, type_def);
					for (let directive of definition.directives) {
						if (directive.name.value === 'table') {
							for (let arg of directive.arguments) {
								type_def[arg.name.value] = (arg.value as StringValueNode).value;
							}
							if (!type_def.table)
								type_def.table = snake_case(type_name);
						}
					}
					if (type_def.table) {
						let attributes = [];
						for (let field of definition.fields) {
							let type = (field.type as NamedTypeNode).name?.value;
							attributes.push({
								name: field.name.value,
								type,
								is_hash_attribute: type === 'ID',
							});
						}
						ensureTable(type_def.table, attributes, type_def.schema);
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
							class GraphQLResource extends Transaction {
								get(id) {
									let role = this.user?.role;
									if (role && authorized_roles.indexOf(role.name) > -1 ||
											role?.permission?.super_user) {
										let record = this.useTable(type_def.table, type_def.schema)?.get(id);
										return record;
									} else throw new Error('Unauthorized');
								}
							}
							handlers.set(query_name, restHandler(GraphQLResource));
						}
					}
			}

		}
		return handlers;
	}
}