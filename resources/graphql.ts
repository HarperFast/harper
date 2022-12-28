import { parser } from 'graphql';
import { database } from './database';
import { Resource } from './Resource';
import { Transaction } from './Transaction';

module.exports = {
	createHandler(gql_content) {
		let ast = parser(gql_content);
		let definition = ast.definitions[0];
		let table_name;
		let table = database[table_name];
		// the resource that is generated for this query and instantiated for each request:
		class GraphQLResource extends Transaction/* Implements Resource */ {
			get(id) {
				let record = this.database[table_name].get(id);
				return record;
			}
		}
		function handleGraphQL(path, request, response) {
			let resolution = new GraphQLResource(path);
			if (path) {
				let entry = resolution.getEntry(request);
				if (entry.version === request.headers['if-modified-since'])
					response.writeHead('304');
				// TODO: Generic way to handle REST headers
			}
		}
		return handleGraphQL;
	}
}