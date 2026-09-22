import { parse } from 'yaml';

// yaml's prettyErrors frames the offending source lines into `message`, and a config file holds
// credentials. Neither the cause nor the original stack is carried for the same reason.
export class ConfigParseError extends Error {
	constructor(filePath: string, error: unknown) {
		const { name, code, linePos } = (error ?? {}) as {
			name?: string;
			code?: string;
			linePos?: { line: number; col: number }[];
		};
		const at = linePos?.[0] ? ` at line ${linePos[0].line}, column ${linePos[0].col}` : '';
		super(`Unable to parse the Harper configuration file at ${filePath}: ${code ?? name ?? 'parse failure'}${at}`);
		this.name = 'ConfigParseError';
	}
}

export function parseConfigFile(contents: string, filePath: string): any {
	try {
		// yaml routes warnings through `process.emitWarning` rather than a throw, so a framed
		// warning would reach stderr with the config's own source lines in it, around this scrub.
		return parse(contents, { logLevel: 'error' });
	} catch (error) {
		// Only yaml's own parse errors frame the source into `message`. Anything else is a fault in
		// the parser, where the message is the whole of the debugging context.
		if (!isYamlParseError(error)) throw error;
		throw new ConfigParseError(filePath, error);
	}
}

function isYamlParseError(error: unknown): boolean {
	const { name, linePos } = (error ?? {}) as { name?: string; linePos?: unknown };
	return linePos !== undefined || name === 'YAMLParseError';
}
