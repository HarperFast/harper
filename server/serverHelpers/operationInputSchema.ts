export const MAX_OPERATION_INPUT_SCHEMA_BYTES = 64 * 1024;

const validators = new Map<string, any>();

function getDialect(schemaId: unknown): { key: string; module: string; schemaId?: string } | { error: string } {
	if (schemaId === undefined) return { key: 'draft-07', module: 'ajv' };
	if (typeof schemaId !== 'string') return { error: '$schema must be a string' };
	if (/json-schema\.org\/draft-0?6\/schema#?$/.test(schemaId)) {
		return { key: 'draft-06', module: 'ajv', schemaId: 'http://json-schema.org/draft-06/schema#' };
	}
	if (/json-schema\.org\/draft-0?7\/schema#?$/.test(schemaId)) {
		return { key: 'draft-07', module: 'ajv', schemaId: 'http://json-schema.org/draft-07/schema#' };
	}
	if (/json-schema\.org\/draft\/2019-09\/schema#?$/.test(schemaId)) {
		return { key: '2019-09', module: 'ajv/dist/2019', schemaId: 'https://json-schema.org/draft/2019-09/schema' };
	}
	if (/json-schema\.org\/draft\/2020-12\/schema#?$/.test(schemaId)) {
		return { key: '2020-12', module: 'ajv/dist/2020', schemaId: 'https://json-schema.org/draft/2020-12/schema' };
	}
	return { error: `unsupported JSON Schema dialect '${schemaId}'` };
}

function getValidator(dialect: { key: string; module: string }): any {
	let validator = validators.get(dialect.key);
	if (validator) return validator;
	const AjvModule = require(dialect.module);
	const Ajv = AjvModule.default ?? AjvModule;
	validator = new Ajv({ addUsedSchema: false, strict: false, validateSchema: true });
	if (dialect.key === 'draft-06') {
		validator.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'));
	}
	validators.set(dialect.key, validator);
	return validator;
}

export function normalizeOperationInputSchema(inputSchema: unknown): { schema?: object; error?: string } {
	if (inputSchema === undefined) return {};

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
		const dialect = getDialect(schema.$schema);
		if ('error' in dialect) return dialect;
		const validator = getValidator(dialect);
		const schemaToValidate = dialect.schemaId ? { ...schema, $schema: dialect.schemaId } : schema;
		if (!validator.validateSchema(schemaToValidate)) {
			return { error: validator.errorsText(validator.errors) };
		}
		return { schema };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
