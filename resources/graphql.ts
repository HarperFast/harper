import { dirname } from 'path';
import { Script } from 'node:vm';
import { table } from './databases.ts';
import { getWorkerIndex } from '../server/threads/manageThreads.js';

const PRIMITIVE_TYPES = ['ID', 'Int', 'Float', 'Long', 'String', 'Boolean', 'Date', 'Bytes', 'Any', 'BigInt', 'Blob'];

if (server.knownGraphQLDirectives) {
	server.knownGraphQLDirectives = [
		'table',
		'sealed',
		'export',
		'primaryKey',
		'indexed',
		'computed',
		'relationship',
		'createdTime',
		'updatedTime',
		'expiresAt',
		'allow',
	];
}
/**
 * This is the entry point for handling GraphQL schemas (and server-side defined queries, eventually). This will be
 * called for schemas, and this will parse the schema (into an AST), and use it to ensure all specified tables and their
 * attributes exist. This is intended to be the default/primary way to define a table in HarperDB. This supports various
 * directives for configuring indexing, attribute types, table configuration, and more.
 *
 * @param gqlContent
 * @param relativePath
 * @param filePath
 * @param resources
 */
export function start({ ensureTable }) {
	return {
		handleFile,
		setupFile: handleFile,
	};

	async function handleFile(gqlContent, urlPath, filePath, resources) {
		// lazy load the graphql package so we don't load it for users that don't use graphql
		const { parse, Source, Kind, NamedTypeNode, StringValueNode } = await import('graphql');
		const ast = parse(new Source(gqlContent.toString(), filePath));
		const types = new Map();
		const tables = [];
		let query;
		// we begin by iterating through the definitions in the AST to get the types and convert them
		// to a friendly format for table attributes
		for (const definition of ast.definitions) {
			switch (definition.kind) {
				case Kind.OBJECT_TYPE_DEFINITION:
					const typeName = definition.name.value;
					// use type name as the default table
					const properties = [];
					const typeDef = { table: null, database: null, properties };
					types.set(typeName, typeDef);
					for (const directive of definition.directives) {
						const directiveName = directive.name.value;
						if (directiveName === 'table') {
							for (const arg of directive.arguments) {
								typeDef[arg.name.value] = (arg.value as StringValueNode).value;
							}
							if (typeDef.schema) typeDef.database = typeDef.schema;
							if (!typeDef.table) typeDef.table = typeName;
							if (typeDef.audit) typeDef.audit = typeDef.audit !== 'false';
							typeDef.attributes = typeDef.properties;
							tables.push(typeDef);
						}
						if (directive.name.value === 'sealed') typeDef.sealed = true;
						if (directive.name.value === 'splitSegments') typeDef.splitSegments = true;
						if (directive.name.value === 'replicate') typeDef.replicate = true;
						if (directive.name.value === 'export') {
							typeDef.export = true;
							for (const arg of directive.arguments) {
								if (typeof typeDef.export !== 'object') typeDef.export = {};
								typeDef.export[arg.name.value] = (arg.value as StringValueNode).value;
							}
						}
					}
					let hasPrimaryKey = false;
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
						const typeName = (type as NamedTypeNode).name?.value;
						const property = { type: typeName };
						Object.defineProperty(property, 'location', { value: type.loc.startToken });
						return property;
					}
					const attributesObject = {};
					for (const field of definition.fields) {
						const property = getProperty(field.type);
						property.name = field.name.value;
						properties.push(property);
						attributesObject[property.name] = undefined; // this is used as a backup scope for computed properties
						for (const directive of field.directives) {
							const directiveName = directive.name.value;
							if (directiveName === 'primaryKey') {
								if (hasPrimaryKey) console.warn('Can not define two attributes as a primary key at', directive.loc);
								else {
									property.isPrimaryKey = true;
									hasPrimaryKey = true;
								}
							} else if (directiveName === 'indexed') {
								const indexedDefinition = {};
								for (const arg of directive.arguments || []) {
									indexedDefinition[arg.name.value] = (arg.value as StringValueNode).value;
								}
								property.indexed = indexedDefinition;
							} else if (directiveName === 'computed') {
								for (const arg of directive.arguments || []) {
									if (arg.name.value === 'from') {
										const computedFromExpression = (arg.value as StringValueNode).value;
										property.computed = {
											from: createComputedFrom(computedFromExpression, arg, attributesObject),
										};
										// if the version is not defined, we use the computed from expression as the version, any changes to the computed from expression will trigger a version change and reindex
										if (property.version == undefined) property.version = computedFromExpression;
									} else if (arg.name.value === 'version') {
										property.version = (arg.value as StringValueNode).value;
									}
								}
								property.computed = property.computed || true;
							} else if (directiveName === 'relationship') {
								const relationshipDefinition = {};
								for (const arg of directive.arguments) {
									relationshipDefinition[arg.name.value] = (arg.value as StringValueNode).value;
								}
								property.relationship = relationshipDefinition;
							} else if (directiveName === 'createdTime') {
								property.assignCreatedTime = true;
							} else if (directiveName === 'updatedTime') {
								property.assignUpdatedTime = true;
							} else if (directiveName === 'expiresAt') {
								property.expiresAt = true;
							} else if (directiveName === 'allow') {
								const authorizedRoles = (property.authorizedRoles = []);
								for (const arg of directive.arguments) {
									if (arg.name.value === 'role') {
										authorizedRoles.push((arg.value as StringValueNode).value);
									}
								}
							} else if (server.knownGraphQLDirectives.includes(directiveName)) {
								console.warn(`@${directiveName} is an unknown directive, at`, directive.loc);
							}
						}
					}
					typeDef.type = typeName;
					if (typeName === 'Query') {
						query = typeDef;
					}
			}
		}
		// check the types and if any types reference other types, fill those in.
		function connectPropertyType(property) {
			const targetTypeDef = types.get(property.type);
			if (targetTypeDef) {
				Object.defineProperty(property, 'properties', { value: targetTypeDef.properties });
				Object.defineProperty(property, 'definition', { value: targetTypeDef });
			} else if (property.type === 'array') connectPropertyType(property.elements);
			else if (!PRIMITIVE_TYPES.includes(property.type)) {
				if (getWorkerIndex() === 0)
					console.error(
						`The type ${property.type} is unknown at line ${property.location.line}, column ${property.location.column}, in ${filePath}`
					);
			}
		}
		for (const typeDef of types.values()) {
			for (const property of typeDef.properties) connectPropertyType(property);
		}
		// any tables that are defined in the schema can now be registered
		for (const typeDef of tables) {
			// with graphql database definitions, this is a declaration that the table should exist and that it
			// should be created if it does not exist
			typeDef.tableClass = ensureTable(typeDef);
			if (typeDef.export) {
				// allow empty string to be used to declare a table on the root path
				if (typeDef.export.name === '') resources.set(dirname(urlPath), typeDef.tableClass);
				else
					resources.set(
						dirname(urlPath) + '/' + (typeDef.export.name || typeDef.type),
						typeDef.tableClass,
						typeDef.export
					);
			}
		}
		function createComputedFrom(computedFrom: string, arg: any, attributes: any) {
			// Create a function from a computed "from" directive. This can look like:
			// @computed(from: "fieldOne + fieldTwo")
			// We use Node's built-in Script class to compile the function and run it in the context of the record object, which allows us to specify the source
			const script = new Script(
				// we use the inner with statement to allow the computed function to access the record object's properties directly as top level names
				// we use the outer with statement with attributes as a fallback so any access to an attribute that isn't defined on the record still returns undefined (instead of a ReferenceError)
				`function computed(attributes) { return function(record) { with(attributes) { with (record) { return ${computedFrom}; } } } } computed;`,
				{
					filename: filePath, // specify the file path and line position for better error messages/debugging
					lineOffset: arg.loc.startToken.line - 1,
					columnOffset: arg.loc.startToken.column,
				}
			);
			return script.runInThisContext()(attributes); // run the script in the context of the current context/global and return the function we defined
		}
	}
}

export const startOnMainThread = start;
// useful for testing
export const loadGQLSchema = start({ ensureTable: table }).handleFile;
