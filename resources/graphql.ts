import { parse, Source, Kind, NamedTypeNode } from 'graphql';
import { Transaction } from './Transaction';
import { registerRESTHandler } from './resource-server';

export function registerGraphQL() {
	registerRESTHandler('graphql', createHandler);
	registerRESTHandler('gql', createHandler);
	function createHandler(gql_content) {
		let ast = parse(new Source(gql_content, 'somewhere'));
		let handlers = new Map();
		for (let definition of ast.definitions) {
			switch (definition.kind) {
				case Kind.OBJECT_TYPE_DEFINITION:
					let type_name = definition.name.value;
					if (type_name === 'Query') {
						for (let field of definition.fields) {
							let query_name = field.name.value;
							let type_name = (field.type as NamedTypeNode).name.value;
							// the resource that is generated for this query and instantiated for each request:
							class GraphQLResource extends Transaction {
								get(id) {
									let record = this.getTable(type_name)?.get(id);
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