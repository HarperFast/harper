import { parse, Source, Kind, NamedTypeNode, StringValueNode } from 'graphql';
import { Transaction } from './Transaction';
import { registerResourceType } from './resource-server';

export function registerGraphQL() {
	registerResourceType('graphql', createHandler);
	registerResourceType('gql', createHandler);
	function createHandler(gql_content) {
		let ast = parse(new Source(gql_content, 'somewhere'));
		let handlers = new Map();
		let types = new Map();
		for (let definition of ast.definitions) {
			switch (definition.kind) {
				case Kind.OBJECT_TYPE_DEFINITION:
					let type_name = definition.name.value;
					let type_def = { table: null };
					types.set(type_name, type_def);
					for (let directive of definition.directives) {
						if (directive.name.value === 'table') {
							let settings = new Map();
							for (let arg of directive.arguments) {
								type_def[arg.name.value] = (arg.value as StringValueNode).value;
							}
						}
					}
					if (type_name === 'Query') {
						for (let field of definition.fields) {
							let query_name = field.name.value;
							let type_name = (field.type as NamedTypeNode).name.value;
							let type_def = types.get(type_name);
							// the resource that is generated for this query and instantiated for each request:
							class GraphQLResource extends Transaction {
								get(id) {
									let record = this.getTable(type_def.table, type_def.schema)?.get(id);
									return record;
								}
							}
							handlers.set(query_name, GraphQLResource);
						}
					}
			}

		}
		return handlers;
	}
}