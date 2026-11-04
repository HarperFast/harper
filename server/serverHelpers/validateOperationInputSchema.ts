import { loadNativePackage } from '../../utility/packageUtils.js';

const MAX_OPERATION_INPUT_SCHEMA_BYTES = 64 * 1024;

function getDialect(schemaId: unknown): { key: string; entryPath: string; schemaId?: string } | { error: string } {
	if (schemaId === undefined) return { key: 'draft-07', entryPath: '' };
	if (typeof schemaId !== 'string') return { error: '$schema must be a string' };
	if (/^https?:\/\/json-schema\.org\/draft-0?6\/schema#?$/.test(schemaId)) {
		return { key: 'draft-06', entryPath: '', schemaId: 'http://json-schema.org/draft-06/schema#' };
	}
	if (/^https?:\/\/json-schema\.org\/draft-0?7\/schema#?$/.test(schemaId)) {
		return { key: 'draft-07', entryPath: '', schemaId: 'http://json-schema.org/draft-07/schema#' };
	}
	if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/.test(schemaId)) {
		return { key: '2019-09', entryPath: 'dist/2019', schemaId: 'https://json-schema.org/draft/2019-09/schema' };
	}
	if (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(schemaId)) {
		return { key: '2020-12', entryPath: 'dist/2020', schemaId: 'https://json-schema.org/draft/2020-12/schema' };
	}
	return { error: `unsupported JSON Schema dialect '${schemaId}'` };
}

function createValidator(dialect: { key: string; entryPath: string }): any {
	const AjvModule = loadNativePackage('ajv', dialect.entryPath);
	const Ajv = AjvModule.default ?? AjvModule;
	const validator = new Ajv({ addUsedSchema: false, strict: false, validateSchema: true, validateFormats: false });
	if (dialect.key === 'draft-06') {
		validator.addMetaSchema(loadNativePackage('ajv', 'dist/refs/json-schema-draft-06.json'));
	}
	return validator;
}

export function normalizeOperationInputSchema(inputSchema: unknown): { schema?: object; error?: string } {
	if (inputSchema === undefined) return {};
	if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
		return { error: 'inputSchema must be a JSON object' };
	}

	try {
		const serialized = JSON.stringify(inputSchema);
		if (!serialized) return { error: 'inputSchema must be a JSON object' };
		if (Buffer.byteLength(serialized) > MAX_OPERATION_INPUT_SCHEMA_BYTES) {
			return { error: `inputSchema exceeds ${MAX_OPERATION_INPUT_SCHEMA_BYTES} bytes` };
		}
		const schema = JSON.parse(serialized);
		if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
			return { error: 'inputSchema must be a JSON object' };
		}
		if (!Object.hasOwn(schema, 'type') || schema.type !== 'object') {
			return { error: "inputSchema must declare type: 'object'" };
		}
		// These exact empty-object contracts are valid without loading a compiler.
		if (
			Object.keys(schema).every((key) => key === 'type' || key === 'properties') &&
			(!Object.hasOwn(schema, 'properties') ||
				(schema.properties &&
					typeof schema.properties === 'object' &&
					!Array.isArray(schema.properties) &&
					Object.keys(schema.properties).length === 0))
		)
			return { schema };
		const dialect = getDialect(schema.$schema);
		if ('error' in dialect) return dialect;
		const schemaToValidate = dialect.schemaId ? { ...schema, $schema: dialect.schemaId } : schema;
		// Ajv's compiler scope retains generated functions even after removeSchema().
		// Keep each instance local so replaced registrations can be collected.
		createValidator(dialect).compile(schemaToValidate);
		return { schema: schemaToValidate };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
