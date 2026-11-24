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

/** The SEP-2127 server card fields an application supplies; `url` is the canonical MCP endpoint for `remotes`. */
export interface McpServerCardInfo {
	name?: string;
	title?: string;
	description?: string;
	version?: string;
	websiteUrl?: string;
	icons?: McpServerCardIcon[];
	url?: string;
}

export interface McpServerCardIcon {
	src: string;
	mimeType?: string;
	sizes?: string[];
	theme?: 'light' | 'dark';
}

export type CompleteServerCardInfo = McpServerCardInfo & { name: string; description: string };

const MAX_ICONS = 32;
const MAX_URL_LENGTH = 2048;
const MAX_DATA_URI_LENGTH = 65_536;
const CARD_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
// SEP-2127 refuses version ranges (^1.2.3, ~1.2.3, >=1.2.3, 1.x, 1.*)
const VERSION_RANGE = /[\s^~<>=*|]|(^|\.)[xX](\.|$)/;
const ICON_SIZE = /^(\d+x\d+|any)$/;
const ICON_KEYS = new Set(['src', 'mimeType', 'sizes', 'theme']);

const CARD_FIELDS: Record<keyof McpServerCardInfo, (value: unknown) => string | undefined> = {
	name: (value) =>
		typeof value === 'string' && value.length >= 3 && value.length <= 200 && CARD_NAME.test(value)
			? undefined
			: 'must be a namespaced name of 3 to 200 characters, like com.example/weather',
	title: (value) => boundedString(value, 100),
	description: (value) => boundedString(value, 100),
	version: (value) =>
		typeof value === 'string' && value.length > 0 && value.length <= 255 && !VERSION_RANGE.test(value)
			? undefined
			: 'must be a version (not a range) of at most 255 characters',
	websiteUrl: (value) => (isWebUrl(value) ? undefined : 'must be an absolute http(s) URL'),
	icons: iconsProblem,
	url: (value) =>
		isWebUrl(value) && isSecureOrLoopback(value as string)
			? undefined
			: 'must be the absolute https URL of the MCP endpoint (http only for a loopback host)',
};

function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max
		? undefined
		: `must be a string of 1 to ${max} characters`;
}

function parseUrl(value: unknown): URL | undefined {
	if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

function isWebUrl(value: unknown): boolean {
	const url = parseUrl(value);
	return url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:');
}

function isSecureOrLoopback(value: string): boolean {
	const url = new URL(value);
	return (
		url.protocol === 'https:' ||
		url.hostname === 'localhost' ||
		url.hostname === '[::1]' ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
	);
}

function iconsProblem(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length > MAX_ICONS) return `must be an array of at most ${MAX_ICONS} icons`;
	for (const icon of value) {
		if (!icon || typeof icon !== 'object' || Array.isArray(icon)) return 'must hold icon objects';
		for (const key of Object.keys(icon)) if (!ICON_KEYS.has(key)) return `has an icon with unknown key '${key}'`;
		const src = (icon as McpServerCardIcon).src;
		const dataUri = typeof src === 'string' && src.startsWith('data:') && src.length <= MAX_DATA_URI_LENGTH;
		if (!dataUri && !isWebUrl(src)) return 'has an icon whose src is not an http(s) or data: URI';
		const { mimeType, sizes, theme } = icon as McpServerCardIcon;
		if (mimeType !== undefined && boundedString(mimeType, 255)) return 'has an icon whose mimeType is not a string';
		if (
			sizes !== undefined &&
			!(Array.isArray(sizes) && sizes.every((size) => typeof size === 'string' && ICON_SIZE.test(size)))
		) {
			return 'has an icon whose sizes are not WxH or "any"';
		}
		if (theme !== undefined && theme !== 'light' && theme !== 'dark')
			return 'has an icon whose theme is not light or dark';
	}
	return undefined;
}

/**
 * Why `card` is not a valid (possibly partial) server card, naming the field, or `undefined` when it is.
 * Never echoes the value, which config validation prints.
 */
export function serverCardProblem(card: unknown): string | undefined {
	if (!card || typeof card !== 'object' || Array.isArray(card)) return 'must be an object';
	for (const [key, value] of Object.entries(card)) {
		if (!Object.hasOwn(CARD_FIELDS, key)) return `has unknown key '${key}'`;
		const check = CARD_FIELDS[key as keyof McpServerCardInfo];
		if (value === undefined) continue;
		const problem = check(value);
		if (problem) return `${key} ${problem}`;
	}
	return undefined;
}

// Validates a copy, so getters and later mutation of the caller's object cannot change what was checked or what
// is served.
function validCard(card: unknown): McpServerCardInfo {
	let copy: unknown;
	try {
		copy = structuredClone(card);
	} catch {
		throw new TypeError('MCP server card must be plain data');
	}
	const problem = serverCardProblem(copy);
	if (problem) throw new TypeError(`MCP server card ${problem}`);
	const snapshot: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(copy as McpServerCardInfo)) {
		if (value === undefined) continue;
		snapshot[key] =
			key === 'icons'
				? Object.freeze(
						(value as McpServerCardIcon[]).map((icon) =>
							Object.freeze({ ...icon, ...(icon.sizes ? { sizes: Object.freeze([...icon.sizes]) } : {}) })
						)
					)
				: value;
	}
	return Object.freeze(snapshot) as McpServerCardInfo;
}

let configuredCard: McpServerCardInfo | undefined;
let registeredCard: McpServerCardInfo | undefined;
let mergedCard: { card: CompleteServerCardInfo | undefined; generation: number } = { card: undefined, generation: 0 };

function mergeCards(): void {
	const card = Object.freeze({ ...registeredCard, ...configuredCard });
	mergedCard = {
		card: card.name && card.description ? (card as CompleteServerCardInfo) : undefined,
		generation: mergedCard.generation + 1,
	};
}

export function configureApplicationServerCard(card: unknown): void {
	configuredCard = card !== undefined && !serverCardProblem(card) ? validCard(card) : undefined;
	mergeCards();
}

/**
 * `server.setMcpServerCard`: validated and copied now, so a mistake throws at the component's load rather than
 * when a client asks. The latest registration wins; `undefined` clears it. Config fields override these.
 */
export function setMcpServerCard(card: McpServerCardInfo | undefined): void {
	registeredCard = card === undefined ? undefined : validCard(card);
	mergeCards();
}

/** Config fields over registered ones; `card` is `undefined` while `name` or `description` is missing. */
export function applicationServerCard(): { card: CompleteServerCardInfo | undefined; generation: number } {
	return mergedCard;
}

/** Test seam: forget config and registrations. */
export function _resetApplicationInfoForTest(): void {
	configuredInstructions = undefined;
	registeredInstructions = undefined;
	configuredCard = undefined;
	registeredCard = undefined;
	mergeCards();
}
