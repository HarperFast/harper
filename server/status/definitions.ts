/**
 * Single source of truth for Harper status system definitions
 */

// Define status configurations with const assertion for literal types
export const STATUS_DEFINITIONS = {
	primary: {
		allowedValues: null, // Any string is valid
	},
	maintenance: {
		allowedValues: null, // Any string is valid
	},
	availability: {
		allowedValues: ['Available', 'Unavailable'] as const,
	},
} as const;

// Derive types from the definitions
export type StatusDefinitions = typeof STATUS_DEFINITIONS;
export type StatusId = keyof StatusDefinitions;

// Status value types derived from definitions
export type StatusValueMap = {
	[K in StatusId]: StatusDefinitions[K]['allowedValues'] extends readonly (infer U)[] ? U : string;
};

// Status record structure
export interface StatusRecord<T extends StatusId = StatusId> {
	id: T;
	status: StatusValueMap[T];
	__createdtime__?: number;
	__updatedtime__?: number;
}

// Utility constants
export const STATUS_IDS = Object.keys(STATUS_DEFINITIONS) as StatusId[];
export const DEFAULT_STATUS_ID: StatusId = 'primary';
