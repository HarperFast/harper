import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseDocument } from 'yaml';
import harperLogger from '../utility/logging/harper_logger.ts';
import { COMPONENT_CONFIG_FILES, CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { getConfigPath, getRootConfigFilePath } from './configUtils.ts';
import { ConfigParseError, parseConfigFile } from './parseConfigFile.ts';
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

type ReadTextFile = (path: string, encoding: 'utf8') => Promise<string>;

const KEY_PATTERN = /^[a-z0-9-]+$/;
// A page id holds no dot, so in `<component>.<pageId>` the last dot is the separator.
const PAGE_KEY_PATTERN = /^(?:[a-z0-9-]+|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[a-z0-9-]+)$/;
const NAVIGATION_STATES = new Set(['visible', 'tucked', 'hidden']);
const PLACEMENTS = new Set(['tab', 'config']);
const COMPONENT_READ_CONCURRENCY = 8;
const ROOT_SOURCE = 'the root config';

// Problems name the field and what it must be, never the value found there: a mistyped block can hold anything,
// credentials included.

function isMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPageKey(value: unknown): value is string {
	return typeof value === 'string' && PAGE_KEY_PATTERN.test(value);
}

// The config env layers split paths on dots, so a `<component>.<pageId>` key they set arrives as nested maps.
function navigationEntries(
	navigation: Record<string, unknown>,
	problems: string[],
	prefix = '',
	ancestors = new Set<object>()
): [string, unknown][] {
	ancestors.add(navigation);
	const entries: [string, unknown][] = [];
	for (const [key, value] of Object.entries(navigation)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (!isMap(value) || Object.keys(value).length === 0) entries.push([path, value]);
		else if (ancestors.has(value)) problems.push('studio.navigation holds a value that refers to itself');
		else entries.push(...navigationEntries(value, problems, path, ancestors));
	}
	ancestors.delete(navigation);
	return entries;
}

/** `acceptNested` is for reading what an env layer composed; a write takes `<component>.<pageId>` keys only. */
export function validateStudioNavigation(
	navigation: unknown,
	problems: string[],
	acceptNested = true
): Record<string, StudioNavigationState> | undefined {
	if (navigation == null) return undefined;
	if (!isMap(navigation)) {
		problems.push('studio.navigation must be a map of tab keys to visible, tucked or hidden');
		return undefined;
	}
	const valid: Record<string, StudioNavigationState> = {};
	let count = 0;
	for (const [tab, state] of acceptNested ? navigationEntries(navigation, problems) : Object.entries(navigation)) {
		if (!isPageKey(tab))
			problems.push('studio.navigation has a key that is neither a tab key nor <component>.<pageId>');
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
	if (isPageKey(landing)) return landing;
	problems.push('studio.landing must be a tab key or <component>.<pageId>');
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
		// Claimed by a page rejected below as well, so fixing it adds a page rather than swapping out a later one.
		ids.add(id);
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

interface ComponentSource {
	/** The name `get_components` reports, and a page key's `<component>` part. */
	name: string;
	directory: string;
	/** Unique across sources: an installed component and the `harper dev` application can share a name. */
	where: string;
}

async function isSameDirectory(a: string, b: string): Promise<boolean> {
	try {
		return (await realpath(a)) === (await realpath(b));
	} catch {
		return false;
	}
}

/** The components the loader would load, sorted by name, with the `harper dev` application after an installed one of its name. */
async function componentSources(problems: string[]): Promise<ComponentSource[]> {
	const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	const sources: ComponentSource[] = [];
	if (componentsRoot) {
		try {
			for (const entry of await readdir(componentsRoot, { withFileTypes: true })) {
				// The loader's own filter: Harper's staging, aside and lock directories are dot-prefixed.
				if ((entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
					sources.push({
						name: entry.name,
						directory: join(componentsRoot, entry.name),
						where: `component '${entry.name}'`,
					});
			}
		} catch (error) {
			if (error.code !== 'ENOENT') problems.push(`the components root could not be listed: ${error.message}`);
		}
	}
	const devApplication = process.env.RUN_HDB_APP;
	if (devApplication) {
		const name = basename(devApplication);
		const installed = sources.find((source) => source.name === name);
		// The loader loads both directories under the one name; only the same directory is read once.
		if (!installed || !(await isSameDirectory(installed.directory, devApplication)))
			sources.push({ name, directory: devApplication, where: `component '${name}' at ${devApplication}` });
	}
	return sources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function readComponentStudioBlock(directory: string, readTextFile: ReadTextFile): Promise<unknown> {
	for (const fileName of COMPONENT_CONFIG_FILES) {
		const configFilePath = join(directory, fileName);
		let contents: string;
		try {
			contents = await readTextFile(configFilePath, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
			throw error;
		}
		// The loader reads past every YAML error; this reads past a duplicate key only, which leaves each value under
		// its own key. An unclosed quote folds the rest of the file, secrets included, into one string every role reads.
		try {
			const parsed = parseDocument(contents, { logLevel: 'error' });
			const refused = parsed.errors.find((error) => error.code !== 'DUPLICATE_KEY');
			if (refused) throw refused;
			return parsed.toJSON()?.studio;
		} catch (error) {
			throw new ConfigParseError(configFilePath, error);
		}
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

/** One scan runs at a time; a source's problems are logged when they change. */
export function createStudioConfigurationReader(logger: WarningLogger, readTextFile: ReadTextFile = readFile) {
	let loggedProblems = new Map<string, string>();
	let scanning: Promise<StudioConfiguration> | undefined;
	let followUp: { scan: Promise<StudioConfiguration>; start: () => void } | undefined;

	function logChangedProblems(problemsBySource: Map<string, string[]>) {
		const logged = new Map<string, string>();
		for (const [source, problems] of problemsBySource) {
			if (problems.length === 0) continue;
			const fingerprint = problems.join('; ');
			logged.set(source, fingerprint);
			if (loggedProblems.get(source) === fingerprint) continue;
			logger.warn(`Ignoring part of the Studio configuration in ${source}: ${fingerprint}`);
		}
		loggedProblems = logged;
	}

	async function scan(): Promise<StudioConfiguration> {
		const rootProblems: string[] = [];
		const problemsBySource = new Map([[ROOT_SOURCE, rootProblems]]);
		const configuration: StudioConfiguration = { ...readRootStudioSettings(rootProblems), pages: [] };
		const sources = await componentSources(rootProblems);
		for (const source of sources) problemsBySource.set(source.where, []);
		const pagesBySource = await mapBounded(sources, COMPONENT_READ_CONCURRENCY, async (source) => {
			const problems = problemsBySource.get(source.where);
			try {
				return validateStudioPages(
					source.name,
					await readComponentStudioBlock(source.directory, readTextFile),
					problems
				);
			} catch (error) {
				problems.push(`its config could not be read: ${error.message}`);
				return [];
			}
		});
		// A page key both same-named sources declare goes to the `harper dev` application, which sorts after.
		const pages = new Map<string, { page: StudioPage; where: string }>();
		sources.forEach((source, index) => {
			for (const page of pagesBySource[index]) {
				const key = `${page.component}.${page.id}`;
				const earlier = pages.get(key);
				if (earlier)
					problemsBySource.get(earlier.where).push(`its page '${page.id}' is replaced by the one in ${source.where}`);
				pages.set(key, { page, where: source.where });
			}
		});
		for (const { page } of pages.values()) configuration.pages.push(page);
		logChangedProblems(problemsBySource);
		return configuration;
	}

	function startScan(): Promise<StudioConfiguration> {
		const current = scan();
		scanning = current;
		// Registered before any caller's continuation, so the waiting callers' scan starts before anyone else's.
		const handOff = () => {
			const waiting = followUp;
			followUp = undefined;
			scanning = undefined;
			waiting?.start();
		};
		current.then(handOff, handOff);
		return current;
	}

	return function readStudioConfiguration(): Promise<StudioConfiguration> {
		if (!scanning) return startScan();
		// The scan in flight may have read before this caller's own write, so the caller waits for the next scan,
		// which every caller arriving meanwhile shares.
		if (!followUp) {
			let start: () => void;
			const next = new Promise<StudioConfiguration>((resolve) => {
				start = () => resolve(startScan());
			});
			followUp = { scan: next, start };
		}
		return followUp.scan;
	};
}

const readStudioConfiguration = createStudioConfigurationReader(harperLogger);

export function getStudioConfiguration(): Promise<StudioConfiguration> {
	return readStudioConfiguration();
}
