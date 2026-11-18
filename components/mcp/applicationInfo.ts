/**
 * What the application profile tells clients about itself, from config (`mcp.application.*`, applied by
 * `handleApplication`) or from a component's registration through `server`. Config wins over registration.
 * Registrations are worker-local, like the components that make them.
 */

/** Cap on `initialize` `instructions`, in UTF-16 code units (JavaScript string length). Every `initialize` carries them. */
export const MAX_INSTRUCTIONS_LENGTH = 16_384;

let configuredInstructions: string | undefined;
let registeredInstructions: string | undefined;

export function configureApplicationInstructions(instructions: unknown): void {
	configuredInstructions =
		typeof instructions === 'string' && instructions.length > 0 && instructions.length <= MAX_INSTRUCTIONS_LENGTH
			? instructions
			: undefined;
}

export function setMcpInstructions(instructions: string | undefined): void {
	if (instructions !== undefined && typeof instructions !== 'string') {
		throw new TypeError('MCP instructions must be a string');
	}
	if (instructions !== undefined && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
		throw new RangeError(
			`MCP instructions are ${instructions.length} characters, more than the ${MAX_INSTRUCTIONS_LENGTH} allowed`
		);
	}
	registeredInstructions = instructions || undefined;
}

export function applicationInstructions(): string | undefined {
	return configuredInstructions ?? registeredInstructions;
}

/** Test seam: forget config and registrations. */
export function _resetApplicationInfoForTest(): void {
	configuredInstructions = undefined;
	registeredInstructions = undefined;
}
