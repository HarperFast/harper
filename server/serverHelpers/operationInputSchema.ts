import Ajv from 'ajv';

export const MAX_OPERATION_INPUT_SCHEMA_BYTES = 64 * 1024;

const ajv = new Ajv({ addUsedSchema: false, strict: false, validateSchema: true });

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
		if (!ajv.validateSchema(schema)) {
			return { error: ajv.errorsText(ajv.errors) };
		}
		return { schema };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
