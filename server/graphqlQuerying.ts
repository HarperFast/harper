import * as graphql from 'graphql';
import type { RequestParams } from 'graphql-http';
import { getDeserializer } from './serverHelpers/contentTypes';
import { resources } from '../resources/Resources';

// This code makes heavy use of the word "node" to refer to a node in the GraphQL AST.

/**
 * Assert a given node is an executable definition node.
 */
function assertExecutableDefinitionNode(
	definitionNode: graphql.DefinitionNode
): asserts definitionNode is graphql.OperationDefinitionNode | graphql.FragmentDefinitionNode {
	if (
		definitionNode.kind !== graphql.Kind.OPERATION_DEFINITION &&
		definitionNode.kind !== graphql.Kind.FRAGMENT_DEFINITION
	) {
		throw new GraphQLQueryingError(`Unexpected non-executable definition type ${definitionNode.kind}.`);
	}
}

/**
 * Asserts that the given data is a valid request body.
 */
function assertRequestParams(data: unknown): asserts data is RequestParams {
	if (typeof data !== 'object' || data === null) {
		throw new HTTPError('Request body must be an object.');
	}
	if (!('query' in data)) {
		throw new HTTPError('Request body must contain a `query` field.');
	}
	if (typeof data.query !== 'string') {
		throw new HTTPError('Request body `query` field must be a string.');
	}
	if ('variables' in data && (typeof data.variables !== 'object' || data.variables === null)) {
		throw new HTTPError('Request body `variables` field must be an object.');
	}
	if ('operationName' in data && typeof data.operationName !== 'string') {
		throw new HTTPError('Request body `operationName` field must be a string.');
	}
}

/**
 * Transforms a GraphQL IntValueNode into a JavaScript number.
 */
function processIntValueNode(valueNode: graphql.IntValueNode) {
	return parseInt(valueNode.value, 10);
}

/**
 * Transforms a GraphQL FloatValueNode into a JavaScript number.
 */
function processFloatValueNode(valueNode: graphql.FloatValueNode) {
	return parseFloat(valueNode.value);
}

// NOTE: `processValueNode` and `processConstValueNode` are very similar and could probably be merged, but it makes TypeScript unhappy and they are simple enough to keep separate.

/**
 * NOTE: This function is not used since we removed support for lists. It may be useful in the future.
 *
 * While very similar to `processConstValueNode`, this function can handle variables as well.
 * It is responsible for converting a value node into a JavaScript value.
 * - Objects should not be flattened (nested structures should be preserved).
 * - Lists and Enum values are not supported.
 * - Null values are returned as JavaScript `null`.
 * - Strings and Booleans are returned as is.
 * - Numbers are parsed by their relevant JavaScript parsers (`parseInt` and `parseFloat`).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function processValueNode(valueNode: graphql.ValueNode, resolvedVariables: Map<string, unknown>) {
	switch (valueNode.kind) {
		case graphql.Kind.NULL:
			return null;
		case graphql.Kind.INT:
			return processIntValueNode(valueNode);
		case graphql.Kind.FLOAT:
			return processFloatValueNode(valueNode);
		case graphql.Kind.BOOLEAN:
		case graphql.Kind.STRING:
			return valueNode.value;
		case graphql.Kind.VARIABLE:
			return resolvedVariables.get(valueNode.name.value).toString();
		case graphql.Kind.OBJECT:
			return valueNode.fields.reduce(
				(acc, field) => ({ [field.name.value]: processValueNode(field.value, resolvedVariables), ...acc }),
				{}
			);
		case graphql.Kind.LIST:
		// No longer supporting lists as values, as they are not supported by HarperDB.
		// return valueNode.values.map((valueNode) => processValueNode(valueNode, resolvedVariables));
		// eslint-disable-next-line no-fallthrough
		case graphql.Kind.ENUM:
		default:
			throw new GraphQLQueryingError(`Value type, ${valueNode.kind}, is not supported.`);
	}
}

/**
 * Process a variable node into an attribute query.
 * - If the variable is an object, it will be transformed into a series of conditions.
 * - If the variable is a single value, it will be returned as an attribute and value pair.
 */
function processVariableNode(
	variableNode: graphql.VariableNode,
	attributeName: string | string[],
	resolvedVariables: Map<string, unknown>
) {
	const value = resolvedVariables.get(variableNode.name.value);

	return isObject(value)
		? transformObjectIntoQueryCondition(value, attributeName)
		: { attribute: attributeName, value };
}

/**
 * Utility function to check if a value is an object.
 * Does not include `null` or arrays.
 */
function isObject(value: unknown): value is object {
	return typeof value === 'object' && value != null && !Array.isArray(value);
}

/**
 * Intended to be used when a variable value is an object, this transforms the object into a series of conditions.
 * It compiles attributes into a list, and returns everything as a flat array of conditions, which will further be flattened into the final query.
 */
function transformObjectIntoQueryCondition(object: object, attributes: string | string[]) {
	attributes = typeof attributes === 'string' ? [attributes] : attributes;

	return Object.entries(object).flatMap(([key, value]) => {
		attributes = [...attributes, key];

		return isObject(value) ? transformObjectIntoQueryCondition(value, attributes) : { attribute: attributes, value };
	});
}

/**
 * Processes an object field node into a condition query.
 * For many values, it simply returns the attribute and value.
 * For objects, it returns a list of conditions.
 * Lists and Enums are not supported.
 */
function processObjectFieldNode(
	objectFieldNode: graphql.ObjectFieldNode,
	attributes: string[],
	resolvedVariables: Map<string, unknown>
) {
	attributes = [...attributes, objectFieldNode.name.value];
	switch (objectFieldNode.value.kind) {
		case graphql.Kind.NULL:
			return { attribute: attributes, value: null };
		case graphql.Kind.INT:
			return { attribute: attributes, value: processIntValueNode(objectFieldNode.value) };
		case graphql.Kind.FLOAT:
			return { attribute: attributes, value: processFloatValueNode(objectFieldNode.value) };
		case graphql.Kind.BOOLEAN:
		case graphql.Kind.STRING:
			return {
				attribute: attributes,
				value: objectFieldNode.value.value,
			};
		case graphql.Kind.VARIABLE: {
			return processVariableNode(objectFieldNode.value, attributes, resolvedVariables);
		}
		case graphql.Kind.OBJECT:
			return processObjectValueNode(objectFieldNode.value, attributes, resolvedVariables);
		case graphql.Kind.LIST:
		// No longer supporting lists as values, as they are not supported by HarperDB.
		// return {
		// 	attribute: attributes,
		// 	value: objectFieldNode.value.values.map((valueNode) => processValueNode(valueNode, resolvedVariables)),
		// };
		// eslint-disable-next-line no-fallthrough
		case graphql.Kind.ENUM:
		default:
			throw new GraphQLQueryingError(`Value type, ${objectFieldNode.value.kind}, is not supported.`);
	}
}

/**
 * Object Value Nodes have unique handling; each field must be transformed into a condition and all conditions must be flattened for the query.
 * For example, `{ name: "Lincoln", owner: { name: "Ethan" } }` would be transformed into two conditions:
 * 1. `{ attribute: ["name"], value: "Lincoln" }`
 * 2. `{ attribute: ["owner", "name"], value: "Ethan" }`
 */
function processObjectValueNode(
	objectValueNode: graphql.ObjectValueNode,
	attributes: string[],
	resolvedVariables: Map<string, unknown>
) {
	return objectValueNode.fields.flatMap((field) => processObjectFieldNode(field, attributes, resolvedVariables));
}

/**
 * Processes an argument node into a condition query.
 * - Lists and Enum values are not supported.
 * - Null values are returned as JavaScript `null`.
 * - Strings and Booleans are returned as is.
 * - Numbers are parsed by their relevant JavaScript parsers (`parseInt` and `parseFloat`).
 * - Objects are the most complex, as we need to flatten their nested structure into a series of conditions.
 */
function processArgumentNode(argumentNode: graphql.ArgumentNode, resolvedVariables: Map<string, unknown>) {
	switch (argumentNode.value.kind) {
		case graphql.Kind.NULL:
			return { attribute: argumentNode.name.value, value: null };

		case graphql.Kind.INT:
			return { attribute: argumentNode.name.value, value: processIntValueNode(argumentNode.value) };
		case graphql.Kind.FLOAT:
			return { attribute: argumentNode.name.value, value: processFloatValueNode(argumentNode.value) };
		case graphql.Kind.BOOLEAN:
		case graphql.Kind.STRING:
			return { attribute: argumentNode.name.value, value: argumentNode.value.value };
		case graphql.Kind.VARIABLE:
			return processVariableNode(argumentNode.value, argumentNode.name.value, resolvedVariables);
		case graphql.Kind.OBJECT:
			return processObjectValueNode(argumentNode.value, [argumentNode.name.value], resolvedVariables);
		case graphql.Kind.LIST:
		// No longer supporting lists as values, as they are not supported by HarperDB.
		// return {
		// 	attribute: argumentNode.name.value,
		// 	value: argumentNode.value.values.map((valueNode) => processValueNode(valueNode, resolvedVariables)),
		// };
		// eslint-disable-next-line no-fallthrough
		case graphql.Kind.ENUM:
		default:
			throw new GraphQLQueryingError(`Argument type, ${argumentNode.value.kind}, is not supported.`);
	}
}

/**
 * Builds a conditions query from a list of argument nodes.
 *
 * We support two querying forms:
 * 1. Short form: direct attribute and value matching
 * 2. (TODO) Long form: HarperDB Resource Query API
 *
 * This method should return an array that is assigned to the top level `conditions` field of the query.
 */
function buildConditionsQuery(argumentNodes: readonly graphql.ArgumentNode[], resolvedVariables: Map<string, unknown>) {
	// Note (@Ethan-Arrowood): This is simple for now, but I imagine we will need to implement some more checks when we support Long Form queries.

	// `flatMap` is necessary for handling the list of conditions from an ObjectValueNode
	return argumentNodes.flatMap((argumentNode) => processArgumentNode(argumentNode, resolvedVariables));
}

/**
 * This method does not modify the input selection set node.
 * It replaces fragment nodes with their respective selection sets.
 * It only operates on the first level of selections, so nested fragments will not be resolved.
 * The resulting selection set can then be used for further processing where every node should now be a `FieldNode`.
 * And since a Field Node can still contain a fragment, whatever is processing the Field Node needs to pass those selections back to this method.
 * This is best exemplified by `buildSelectQuery`, which starts with a list of selection nodes, these are passed to `fillInFragments`, and then mapped.
 * If the resulting field node has further selections, it is passed back to `buildSelectQuery` and the process repeats.
 */
function fillInFragments(
	selectionSetNode: graphql.SelectionSetNode,
	fragments: Map<string, graphql.FragmentDefinitionNode>
): ReadonlyArray<graphql.FieldNode> {
	return selectionSetNode.selections.flatMap((selectionNode) => {
		switch (selectionNode.kind) {
			case graphql.Kind.FIELD:
				return selectionNode;
			case graphql.Kind.FRAGMENT_SPREAD: {
				const fragment_name = selectionNode.name.value;
				const fragment = fragments.get(fragment_name);

				if (fragment == null) {
					throw new GraphQLQueryingError(`Fragment \`${fragment_name}\` not found.`);
				}

				return fillInFragments(fragment.selectionSet, fragments);
			}
			case graphql.Kind.INLINE_FRAGMENT:
				return fillInFragments(selectionNode.selectionSet, fragments);
		}
	});
}

/**
 * Builds a select query from a selection set node by iterating through the selections.
 * Supports nested selections.
 */
function buildSelectQuery(
	selectionSetNode: graphql.SelectionSetNode,
	fragments: Map<string, graphql.FragmentDefinitionNode>
) {
	return fillInFragments(selectionSetNode, fragments).map((fieldNode) => {
		return fieldNode.selectionSet?.selections.length > 0
			? { name: fieldNode.name.value, select: buildSelectQuery(fieldNode.selectionSet, fragments) }
			: fieldNode.name.value;
	});
}

/**
 * This is the main execution function for the GraphQL handler.
 * Queries must use HarperDB Resources in the top-level selection set.
 * This function maps those top-level selections to HarperDB Resources, builds a query, and executes the search operation.
 * Results are returned as a tuple with the selection (Resource) name and the array of results.
 */
async function processFieldNode(
	fieldNode: graphql.FieldNode,
	resolvedVariables: Map<string, unknown>,
	fragments: Map<string, graphql.FragmentDefinitionNode>,
	request: unknown
): Promise<[string, unknown[]]> {
	const entry = resources.getMatch(fieldNode.name.value, 'graphql');
	const resource = entry.Resource;

	const query = {
		select: buildSelectQuery(fieldNode.selectionSet, fragments),
		conditions: buildConditionsQuery(fieldNode.arguments, resolvedVariables),
	};

	const results = [];
	// @ts-expect-error: `authorize` is a custom property on the request object.
	request.authorize = true;
	for await (const result of resource.search(query, request)) {
		results.push(result);
	}
	return [fieldNode.name.value, results];
}

/**
 * This method processes the default value of a variable definition node into a JavaScript value.
 * - Objects should not be flattened (nested structures should be preserved).
 * - Lists and Enum values are not supported.
 * - Null values are returned as JavaScript `null`.
 * - Strings and Booleans are returned as is.
 * - Numbers are parsed by their relevant JavaScript parsers (`parseInt` and `parseFloat`).
 */
function processConstValueNode(constValueNode: graphql.ConstValueNode) {
	switch (constValueNode.kind) {
		case graphql.Kind.NULL:
			return null;
		case graphql.Kind.INT:
			return processIntValueNode(constValueNode);
		case graphql.Kind.FLOAT:
			return parseFloat(constValueNode.value);
		case graphql.Kind.STRING:
		case graphql.Kind.BOOLEAN:
			return constValueNode.value;
		case graphql.Kind.OBJECT:
			return constValueNode.fields.reduce(
				(acc, field) => ({
					[field.name.value]: processConstValueNode(field.value),
					...acc,
				}),
				{}
			);
		case graphql.Kind.LIST:
		// No longer supporting lists as values, as they are not supported by HarperDB.
		// return constValueNode.values.map((currentNode) => processConstValueNode(currentNode));
		// eslint-disable-next-line no-fallthrough
		case graphql.Kind.ENUM:
		default:
			throw new GraphQLQueryingError(`Value type, ${constValueNode.kind}, is not supported.`);
	}
}

/**
 * A query is responsible for declaring its variables. This function uses the
 * variable definitions of a query and the variables provided in the request to
 * create a Map of resolved variables.
 *
 * It handles `null` values, default values, and required variables.
 */
function resolveVariables(
	variableDefinitions: readonly graphql.VariableDefinitionNode[],
	variables: Record<string, unknown>
) {
	const resolved_variables = new Map<string, unknown>();

	for (const variableDefinition of variableDefinitions) {
		const variable_name = variableDefinition.variable.name.value;

		// First, check if the variable is provided in the request
		let variable_value = variables?.[variable_name];

		// If not, and there is a default, process the default value
		if (variable_value === undefined && variableDefinition.defaultValue !== undefined) {
			variable_value = processConstValueNode(variableDefinition.defaultValue);
		}

		// If the variable is non-nullable, not provided, and has no default, throw an error
		if (
			variableDefinition.type.kind === graphql.Kind.NON_NULL_TYPE &&
			!(variable_name in variables) &&
			variable_value === undefined
		) {
			throw new GraphQLQueryingError(`Variable $${variable_name} is required, but not provided.`);
		}

		resolved_variables.set(variableDefinition.variable.name.value, variable_value ?? null);
	}

	return resolved_variables;
}

/**
 * Executes a GraphQL operation via the OperationDefinitionNode.
 * It starts by resolving variables, then iterating over the top level selections
 * and executing HarperDB search queries using the relative Resources.
 */
async function executeOperation(
	operationNode: graphql.OperationDefinitionNode,
	variables: Record<string, unknown>,
	fragments: Map<string, graphql.FragmentDefinitionNode>,
	request: unknown
) {
	if (operationNode.operation === graphql.OperationTypeNode.SUBSCRIPTION) {
		throw new GraphQLQueryingError('Subscriptions are not supported.');
	}

	if (operationNode.operation === graphql.OperationTypeNode.MUTATION) {
		throw new GraphQLQueryingError('Mutations are not supported yet.');
	}

	// Resolve variables ahead of execution.
	// Based on the specification, variables must be defined in the query (i.e. `query GetDogs($id: ID!) { ... }`)
	// So even if the variables are provided in the request, they must also be defined in the query.
	// Thus, we can resolve all of the specified variables ahead of time, and then the execution process can use them as needed.
	// We can catch missing variables early (non-nullable variables without a value) and throw an error.
	// We can resolve default values for variables if they are not provided.
	const resolved_variables = resolveVariables(operationNode.variableDefinitions, variables);

	// This is the top level of a query or mutation.
	// Due to the constraints of our system, users must use HarperDB Resources in the selection set.
	// Multiple resources can be queried in a single operation and any attribute of a resource can be selected.
	const results = await Promise.all(
		fillInFragments(operationNode.selectionSet, fragments).map((fieldNode) =>
			processFieldNode(fieldNode, resolved_variables, fragments, request)
		)
	);

	const result = {
		data: {},
	};

	for (const [key, value] of results) {
		result.data[key] = value;
	}

	return result;
}

async function resolver({ query, variables = {}, operationName }: RequestParams, request: unknown) {
	const ast = graphql.parse(query);

	const operations = new Map<string, graphql.OperationDefinitionNode>();
	const fragments = new Map<string, graphql.FragmentDefinitionNode>();

	// Iterate through each operation definition in the document
	for (const definition_node of ast.definitions) {
		// If they aren't executable, error (spec: https://spec.graphql.org/October2021/#sel-DAFPDPAACRAo1T)
		assertExecutableDefinitionNode(definition_node);

		// At the top level of the document there can be only operations and fragments
		// Operations are limited to queries and mutations. Subscriptions are not supported. These are differentiated by the operation type (definitionNode.operation)
		// Fragments do not have multiple types.

		// If the document contains only one operation, it can be unnamed. And if that operation has no variables or directives, it can be a shorthand query (omitting the `query` keyword).
		// Luckily, the AST handles this for us. The definitionNode will have `operation` set to `query` if it is an unnamed or shorthand query. And the `name` property will be undefined.

		// This automatic resolver can only match query/field names to existing HarperDB Resources.
		// All queries, named or unnamed, must use HarperDB Resources in the selection set. For example, all three of the following queries are identical (aside from their name):
		// 1. `{ Dog { name breed } }` (shorthand query)
		// 2. `query { Dog { name breed } }` (unnamed query)
		// 3. `query GetDogs { Dog { name breed } }` (named query)
		// We must be careful not to conflate the query name with the HarperDB Resource name. The query name is only used to differentiate multiple queries in the same document.
		// So if the query is `query Dog { name breed }`, we should error.
		// (This is a pattern we _could_ support, but it may make the resolution process more complex.)

		if (definition_node.kind === graphql.Kind.FRAGMENT_DEFINITION) {
			// Fragments are stored in a separate map for later reference
			// They only need to be processed if referenced in the operation being executed
			// However, since fragments can be nested, we need to collect all of them and recursively resolve later.
			fragments.set(definition_node.name.value, definition_node);
		} else {
			// Error if unnamed operation is not the only operation in the document
			if (definition_node.name === undefined && ast.definitions.length > 1) {
				throw new GraphQLQueryingError(
					`Unnamed operations are only allowed when there is a single operation in the document.`
				);
			}

			// Safely default the definition name to 'Unnamed Query'
			const operation_name = definition_node.name?.value ?? 'Unnamed Query';

			if (operations.has(operation_name)) {
				throw new GraphQLQueryingError(`Duplicate operation definition: ${operation_name}`);
			}

			operations.set(operation_name, definition_node);
		}
	}

	// After all of the operations and fragments have been processed, we can determine which operation to execute.
	// This is based off of the GraphQl Spec `ExecuteRequest` algorithm (https://spec.graphql.org/draft/#sec-Executing-Requests)

	// 1. Determine Operation using GetOperation algorithm (https://spec.graphql.org/draft/#GetOperation())
	let operation: graphql.OperationDefinitionNode;

	if (operationName == null) {
		if (operations.size === 1) {
			operation = operations.entries().next().value[1];
		} else {
			throw new GraphQLQueryingError('Operation name is required when there are multiple operations in the document.');
		}
	} else {
		operation = operations.get(operationName);

		if (operation == null) {
			throw new GraphQLQueryingError(`Operation \`${operationName}\` not found.`);
		}
	}

	// This is where our implementation diverges from the spec.
	// We will not be executing the operation as specified (using provided GraphQL resolvers), but instead using a custom resolution algorithm based on HarperDB resources.
	const response_body = await executeOperation(operation, variables, fragments, request);

	return {
		status: 200,
		headers: {
			'Content-Type': 'application/graphql-response+json; charset=utf-8',
		},
		body: JSON.stringify(response_body),
	};
}

class GraphQLQueryingError extends Error {}

class HTTPError extends Error {
	statusCode: number;
	headers: Record<string, string>;
	constructor(message: string, statusCode: number = 400, headers: Record<string, string> = {}) {
		super(message);
		this.statusCode = statusCode;
		this.headers = headers;
	}
}

// TODO: Improve type here with an actual representation of the request object (its WHATWG Request like but has some differences).
async function graphqlQueryingHandler(request: Request) {
	switch (request.method) {
		case 'GET': {
			const search_params = new URLSearchParams(request.url.split('?')[1]);
			const request_params = {};
			for (const [key, value] of search_params) {
				request_params[key] = key === 'variables' || key === 'extensions' ? JSON.parse(value) : value;
			}
			assertRequestParams(request_params);
			return resolver(request_params, request);
		}
		case 'POST': {
			const request_body_deserialize = getDeserializer(request.headers.get('content-type'), true);
			// @ts-expect-error: _nodeRequest is a custom property on request and is the IncomingMessage with is a Readable
			const request_params = await request_body_deserialize(request._nodeRequest);
			assertRequestParams(request_params);
			return resolver(request_params, request);
		}
		default: {
			throw new HTTPError('Method Not Allowed', 405, { Allow: 'GET, POST' });
		}
	}
}

export function start(options) {
	options.server.http(async (request, nextLayer) => {
		if (!request.url.startsWith('/graphql')) {
			return nextLayer(request);
		}

		try {
			// Await the `graphqlHandler` call here so that errors are caught.
			return await graphqlQueryingHandler(request);
		} catch (error) {
			logger.error(error);

			// Error Handling
			// Based on the GraphQL specification, a GraphQL response (non-http) are a map with a `data` field and an `errors` field.
			// In context of GraphQL Over HTTP, the GraphQL Response is used and will always be returned in the body of the response (regardless of status code).
			// The status code changes based on the Accept header and the response contents.
			// - In `application/json`, the status code is always 200, unless something is wrong with the http request itself (wrong method, invalid body, etc).
			//   - Even if the query itself is invalid (like it doesn't parse), we still use 200, and include the parsing error in `errors`, and `data` is undefined
			//   - It may be difficult to accomplish in our system, but the query can be partially successful, and we would still return 200 with `data` and `errors`.
			// - In `application/graphql-response+json`, the status code will generally be 4xx if anything goes wrong. From HTTP issues to query parsing, and even query execution.
			//   - Using 405 for method not allowed
			//   - 403 for unauthorized
			//   - 400 for bad request (we detect something is wrong, or the parsing step fails, or the operation is not found, or we don't support that piece of the spec)
			//   - 500 for internal server error (like something is bugged in the code in this file).
			//   - If the query is valid, and some part of it is successful, then and only then does the status code become 200.
			//   - If the fails partially, we can include those errors in the `errors` field, and still return 200.
			// "Partial success/failure" - GraphQL has two types of error concepts, Request and Field. Field errors are generally when a single field in a request has an error resolving. Request errors are not about HTTP semantics, but GraphQL semantics (like valid query)
			// In a standard graphql system, that is okay. It can be null and things can continue. When something is specified as non-null, then it can provide an error.
			// Since our system is a bit unique, and we are taking many liberties with the spec, we may not really support partial success.
			// We don't really type check so there is little purpose in strictly validating the data coming out of a query.
			// In general, we will behave as expected regarding request errors (like missing variables, or invalid query syntax).
			// For now, we likely will not support partial failure. If a query fails, it will likely fail entirely. And as confusing as that might be for a `application/json` user, it is
			// the most spec compliant and expected behavior. Furthermore, we will default to `application/graphql-response+json` so that the better UX (of receiving 4xx on any errors) will be the default experience.

			const response_type = request.headers.get('accept') ?? 'application/graphql-response+json';

			switch (response_type) {
				case 'application/json': {
					if (error instanceof HTTPError) {
						return {
							status: error.statusCode,
							body: JSON.stringify({ errors: [{ message: error.message }] }),
							headers: {
								'Content-Type': 'application/json',
								...error.headers,
							},
						};
					} else if (error instanceof graphql.GraphQLError) {
						// This error comes from graphql.parse
						return {
							status: 200,
							body: JSON.stringify({ errors: [error] }),
							headers: {
								'Content-Type': 'application/json',
							},
						};
					} else if (error instanceof GraphQLQueryingError) {
						return {
							status: 200,
							body: JSON.stringify({ errors: [{ message: error.message }] }),
							headers: {
								'Content-Type': 'application/json',
							},
						};
					} else if (error instanceof Error) {
						return {
							status: 500,
							body: JSON.stringify({ errors: [{ message: error.message }] }),
							headers: {
								'Content-Type': 'application/json',
							},
						};
					}

					break;
				}
				// eslint-disable-next-line sonarjs/prefer-default-last, sonarjs/sonar-no-fallthrough
				default:
					logger.info(`Unsupported accept header, ${response_type}, defaulting to application/graphql-response+json`);
				// eslint-disable-next-line no-fallthrough
				case 'application/graphql-response+json': {
					if (error instanceof HTTPError) {
						return {
							status: error.statusCode,
							body: JSON.stringify({ errors: [{ message: error.message }] }),
							headers: {
								'Content-Type': 'application/graphql-response+json',
								...error.headers,
							},
						};
					} else if (error instanceof graphql.GraphQLError) {
						// This error comes from graphql.parse
						return {
							status: 400,
							body: JSON.stringify({ errors: [error] }),
							headers: {
								'Content-Type': 'application/graphql-response+json',
							},
						};
					} else if (error instanceof GraphQLQueryingError) {
						return {
							status: 400,
							body: JSON.stringify({ errors: [{ message: error.message }] }),
							headers: {
								'Content-Type': 'application/graphql-response+json',
							},
						};
					} else if (error instanceof Error) {
						return {
							status: 500,
							body: JSON.stringify({ errors: [{ message: error.message }] }),
							headers: {
								'Content-Type': 'application/graphql-response+json',
							},
						};
					}

					break;
				}
			}

			// The handler should not throw anything but Errors, but rethrow anything else just in case.
			throw error;
		}
	});
}
