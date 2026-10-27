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
	icon?: unknown;
	placement: 'tab' | 'config';
	description?: unknown;
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
const OPAQUE_PAGE_FIELDS = ['icon', 'description', 'access', 'content'] as const;
const ROOT_SOURCE = '';

function isMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Config text reaches the log only as a short, control-free quote.
function quote(value: unknown): string {
	const text = typeof value === 'string' ? value : String(JSON.stringify(value));
	// eslint-disable-next-line no-control-regex
	return `'${text.slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, '?')}'`;
}

/** The valid entries of a `studio.navigation` map, or undefined when it holds none; each invalid entry is a problem. */
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
		if (state == null) continue;
		if (!KEY_PATTERN.test(tab)) problems.push(`studio.navigation key ${quote(tab)} must match [a-z0-9-]+`);
		else if (typeof state !== 'string' || !NAVIGATION_STATES.has(state))
			problems.push(`studio.navigation.${tab} must be visible, tucked or hidden, not ${quote(state)}`);
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
	problems.push(`studio.landing must be a non-empty string, not ${quote(landing)}`);
	return undefined;
}

/** The valid pages of a component's `studio` block; each dropped page is a problem. */
export function validateStudioPages(component: string, studio: unknown, problems: string[]): StudioPage[] {
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
		const { id, name, placement } = page;
		if (typeof id !== 'string' || !KEY_PATTERN.test(id)) {
			problems.push(`${label}.id must match [a-z0-9-]+, not ${quote(id)}`);
		} else if (ids.has(id)) {
			problems.push(`${label}.id '${id}' repeats an earlier page's id`);
		} else if (typeof name !== 'string' || name.trim() === '') {
			problems.push(`${label} ('${id}') must have a non-empty name`);
		} else if (typeof placement !== 'string' || !PLACEMENTS.has(placement)) {
			problems.push(`${label} ('${id}') placement must be tab or config, not ${quote(placement)}`);
		} else {
			ids.add(id);
			const accepted: StudioPage = { component, id, name, placement: placement as StudioPage['placement'] };
			for (const field of OPAQUE_PAGE_FIELDS) if (page[field] !== undefined) accepted[field] = page[field];
			valid.push(accepted);
		}
	}
	return valid;
}

/** The root config's Studio settings, read from the file `set_configuration` writes, so a write is visible at once. */
function readRootStudioSettings(problems: string[]): Pick<StudioConfiguration, 'navigation' | 'landing'> {
	let studio: unknown;
	try {
		// Synchronous: an open read handle on the root config blocks `atomicWriteFile`'s Windows rename retry on
		// this same thread (config/DESIGN.md, "Root config watchers must read synchronously").
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

/** The components the loader would load, as `[name, directory]` sorted by name; the name is `get_components`'. */
async function componentDirectories(): Promise<[string, string][]> {
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	const directories = new Map<string, string>();
	try {
		for (const entry of await readdir(componentsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			// Harper's own staging, aside and lock directories are dot-prefixed, as the loader relies on.
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			directories.set(entry.name, join(componentsRoot, entry.name));
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
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
			if (error.code === 'ENOENT') continue;
			throw error;
		}
		return parseConfigFile(contents, configFilePath)?.studio;
	}
	return undefined;
}

/**
 * A reader of the Studio configuration this node's disk holds. Each call reads the root config and every component's
 * config afresh, so it agrees on every thread and reflects a completed `set_configuration`, `deploy_component` or
 * `drop_component` without a restart. A source's problems are logged once, when they change.
 */
export function createStudioConfigurationReader(logger: WarningLogger) {
	let loggedProblems = new Map<string, string>();
	let latestRead = 0;

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

	return async function readStudioConfiguration(): Promise<StudioConfiguration> {
		const read = ++latestRead;
		const problemsBySource = new Map<string, string[]>();
		const rootProblems: string[] = [];
		problemsBySource.set(ROOT_SOURCE, rootProblems);
		const configuration: StudioConfiguration = { ...readRootStudioSettings(rootProblems), pages: [] };

		let directories: [string, string][] = [];
		try {
			directories = await componentDirectories();
		} catch (error) {
			rootProblems.push(`the components root could not be listed: ${error.message}`);
		}
		const pagesByComponent = await Promise.all(
			directories.map(async ([component, directory]) => {
				const problems: string[] = [];
				problemsBySource.set(component, problems);
				try {
					return validateStudioPages(component, await readComponentStudioBlock(directory), problems);
				} catch (error) {
					problems.push(`its config could not be read: ${error.message}`);
					return [];
				}
			})
		);
		for (const pages of pagesByComponent) configuration.pages.push(...pages);
		// An earlier read finishing after a later one has older problems; only the latest decides what was logged.
		if (read === latestRead) logChangedProblems(problemsBySource);
		return configuration;
	};
}

const readStudioConfiguration = createStudioConfigurationReader(harperLogger);

/** `get_studio_configuration`: open to every authenticated role, so it returns only the allowlisted Studio keys. */
export function getStudioConfiguration(): Promise<StudioConfiguration> {
	return readStudioConfiguration();
}
