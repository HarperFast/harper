import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import harperLogger from '../utility/logging/harper_logger.ts';
import { COMPONENT_CONFIG_FILES, CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { getConfigPath, getRootConfigFilePath } from './configUtils.ts';
import { parseConfigFile } from './parseConfigFile.ts';
import { readConfigFileSync } from './readConfigFileSync.ts';

export type StudioNavigationState = 'visible' | 'tucked' | 'hidden';

export interface StudioPage {
	component: string;
	id: string;
	name: string;
	icon?: string;
	placement: 'tab' | 'config';
	description?: string;
	access?: unknown;
	content?: unknown;
}

export interface StudioConfiguration {
	navigation?: Record<string, StudioNavigationState>;
	landing?: string;
	pages: StudioPage[];
}

interface WarningLogger {
	warn(message: string): void;
}

const KEY_PATTERN = /^[a-z0-9-]+$/;
const NAVIGATION_STATES = new Set(['visible', 'tucked', 'hidden']);
const PLACEMENTS = new Set(['tab', 'config']);
const COMPONENT_READ_CONCURRENCY = 8;
const ROOT_SOURCE = '';

// Problems name the field and what it must be, never the value found there: a mistyped block can hold anything,
// credentials included.

function isMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateStudioNavigation(
	navigation: unknown,
	problems: string[]
): Record<string, StudioNavigationState> | undefined {
	if (navigation == null) return undefined;
	if (!isMap(navigation)) {
		problems.push('studio.navigation must be a map of tab keys to visible, tucked or hidden');
		return undefined;
	}
	const valid: Record<string, StudioNavigationState> = {};
	let count = 0;
	for (const [tab, state] of Object.entries(navigation)) {
		if (!KEY_PATTERN.test(tab)) problems.push('studio.navigation has a key that does not match [a-z0-9-]+');
		else if (state == null) continue;
		else if (typeof state !== 'string' || !NAVIGATION_STATES.has(state))
			problems.push(`studio.navigation.${tab} must be visible, tucked or hidden`);
		else {
			valid[tab] = state as StudioNavigationState;
			count++;
		}
	}
	return count > 0 ? valid : undefined;
}

export function validateStudioLanding(landing: unknown, problems: string[]): string | undefined {
	if (landing == null) return undefined;
	if (typeof landing === 'string' && landing.trim() !== '') return landing;
	problems.push('studio.landing must be a non-empty string');
	return undefined;
}

function validateStudioPages(component: string, studio: unknown, problems: string[]): StudioPage[] {
	if (studio == null) return [];
	if (!isMap(studio)) {
		problems.push('studio must be a map');
		return [];
	}
	const { pages } = studio;
	if (pages == null) return [];
	if (!Array.isArray(pages)) {
		problems.push('studio.pages must be a list');
		return [];
	}
	const valid: StudioPage[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < pages.length; index++) {
		const page = pages[index];
		const label = `studio.pages[${index}]`;
		if (!isMap(page)) {
			problems.push(`${label} must be a map`);
			continue;
		}
		const { id, name, icon, placement, description, access, content } = page;
		if (typeof id !== 'string' || !KEY_PATTERN.test(id)) {
			problems.push(`${label}.id must be a string matching [a-z0-9-]+`);
			continue;
		}
		if (ids.has(id)) {
			problems.push(`${label}.id '${id}' repeats an earlier page's id`);
			continue;
		}
		if (typeof name !== 'string' || name.trim() === '') {
			problems.push(`${label} ('${id}') must have a non-empty name`);
			continue;
		}
		if (typeof placement !== 'string' || !PLACEMENTS.has(placement)) {
			problems.push(`${label} ('${id}') placement must be tab or config`);
			continue;
		}
		const accepted: StudioPage = { component, id, name, placement: placement as StudioPage['placement'] };
		if (typeof icon === 'string') accepted.icon = icon;
		else if (icon != null) problems.push(`${label} ('${id}') icon must be a string; it is left out`);
		if (typeof description === 'string') accepted.description = description;
		else if (description != null) problems.push(`${label} ('${id}') description must be a string; it is left out`);
		if (access !== undefined) accepted.access = access;
		if (content !== undefined) accepted.content = content;
		try {
			// A YAML alias can make `access` or `content` refer to itself, which no response can carry.
			JSON.stringify(accepted);
		} catch {
			problems.push(`${label} ('${id}') holds a value that cannot be returned as JSON`);
			continue;
		}
		ids.add(id);
		valid.push(accepted);
	}
	return valid;
}

function readRootStudioSettings(problems: string[]): Pick<StudioConfiguration, 'navigation' | 'landing'> {
	let studio: unknown;
	try {
		// The file set_configuration writes, read synchronously: an open read handle on the root config blocks
		// `atomicWriteFile`'s Windows rename retry on this same thread (config/DESIGN.md).
		const configFilePath = getRootConfigFilePath();
		studio = parseConfigFile(readConfigFileSync(configFilePath), configFilePath)?.studio;
	} catch (error) {
		problems.push(`the root config could not be read: ${error.message}`);
		return {};
	}
	if (studio == null) return {};
	if (!isMap(studio)) {
		problems.push('studio must be a map');
		return {};
	}
	const settings: Pick<StudioConfiguration, 'navigation' | 'landing'> = {};
	const navigation = validateStudioNavigation(studio.navigation, problems);
	if (navigation) settings.navigation = navigation;
	const landing = validateStudioLanding(studio.landing, problems);
	if (landing !== undefined) settings.landing = landing;
	return settings;
}

/** The components the loader would load, as `[name, directory]` sorted by name; the name is the one `get_components` reports. */
async function componentDirectories(problems: string[]): Promise<[string, string][]> {
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	const directories = new Map<string, string>();
	try {
		for (const entry of await readdir(componentsRoot, { withFileTypes: true })) {
			// The loader's own filter: Harper's staging, aside and lock directories are dot-prefixed.
			if ((entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
				directories.set(entry.name, join(componentsRoot, entry.name));
		}
	} catch (error) {
		if (error.code !== 'ENOENT') problems.push(`the components root could not be listed: ${error.message}`);
	}
	const devApplication = process.env.RUN_HDB_APP;
	if (devApplication && !directories.has(basename(devApplication)))
		directories.set(basename(devApplication), devApplication);
	return [...directories].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function readComponentStudioBlock(directory: string): Promise<unknown> {
	for (const fileName of COMPONENT_CONFIG_FILES) {
		const configFilePath = join(directory, fileName);
		let contents: string;
		try {
			contents = await readFile(configFilePath, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
			throw error;
		}
		return parseConfigFile(contents, configFilePath)?.studio;
	}
	return undefined;
}

async function mapBounded<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	const drain = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await map(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
	return results;
}

/**
 * A reader of the Studio configuration on this node's disk. Every scan reads the root config and each component's
 * config afresh, so it agrees on every thread and reflects a completed `set_configuration`, `deploy_component` or
 * `drop_component` without a restart. One scan runs at a time; a source's problems are logged when they change.
 */
export function createStudioConfigurationReader(logger: WarningLogger) {
	let loggedProblems = new Map<string, string>();
	let scanning: Promise<StudioConfiguration> | undefined;
	let queued: Promise<StudioConfiguration> | undefined;

	function logChangedProblems(problemsBySource: Map<string, string[]>) {
		const logged = new Map<string, string>();
		for (const [source, problems] of problemsBySource) {
			if (problems.length === 0) continue;
			const fingerprint = problems.join('; ');
			logged.set(source, fingerprint);
			if (loggedProblems.get(source) === fingerprint) continue;
			const where = source === ROOT_SOURCE ? 'the root config' : `component '${source}'`;
			logger.warn(`Ignoring part of the Studio configuration in ${where}: ${fingerprint}`);
		}
		loggedProblems = logged;
	}

	async function scan(): Promise<StudioConfiguration> {
		const rootProblems: string[] = [];
		const problemsBySource = new Map([[ROOT_SOURCE, rootProblems]]);
		const configuration: StudioConfiguration = { ...readRootStudioSettings(rootProblems), pages: [] };
		const pagesByComponent = await mapBounded(
			await componentDirectories(rootProblems),
			COMPONENT_READ_CONCURRENCY,
			async ([component, directory]) => {
				const problems: string[] = [];
				problemsBySource.set(component, problems);
				try {
					return validateStudioPages(component, await readComponentStudioBlock(directory), problems);
				} catch (error) {
					problems.push(`its config could not be read: ${error.message}`);
					return [];
				}
			}
		);
		for (const pages of pagesByComponent) configuration.pages.push(...pages);
		logChangedProblems(problemsBySource);
		return configuration;
	}

	return function readStudioConfiguration(): Promise<StudioConfiguration> {
		if (!scanning) {
			scanning = scan().finally(() => {
				scanning = undefined;
			});
			return scanning;
		}
		// The scan in flight may have read before this caller's own write, so the caller waits for the next scan,
		// which every caller arriving meanwhile shares.
		queued ??= scanning
			.then(
				() => {},
				() => {}
			)
			.then(() => {
				queued = undefined;
				return readStudioConfiguration();
			});
		return queued;
	};
}

const readStudioConfiguration = createStudioConfigurationReader(harperLogger);

/** `get_studio_configuration`: open to every authenticated role, so it returns only the validated Studio keys. */
export function getStudioConfiguration(): Promise<StudioConfiguration> {
	return readStudioConfiguration();
}
