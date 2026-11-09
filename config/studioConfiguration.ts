import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseDocument } from 'yaml';
import harperLogger from '../utility/logging/harper_logger.ts';
import { COMPONENT_CONFIG_FILES, CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { getHdbBasePath } from '../utility/environment/environmentManager.ts';
import { packageCandidates } from '../components/packageCandidates.ts';
import { getConfigPath, getRootConfigFilePath } from './configUtils.ts';
import { ConfigParseError, parseConfigFile } from './parseConfigFile.ts';
import { readConfigFileSync } from './readConfigFileSync.ts';

export type StudioNavigationState = 'visible' | 'tucked' | 'hidden';

export interface StudioPage {
	component: string;
	application: string;
	plugins?: string[];
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
	rootNavigation?: Record<string, StudioNavigationState>;
	landing?: string;
	pages: StudioPage[];
}

interface WarningLogger {
	warn(message: string): void;
}

type ReadTextFile = (path: string, encoding: 'utf8') => Promise<string>;

type PageTemplate = Omit<StudioPage, 'component' | 'application' | 'plugins'>;

interface ComponentUse {
	component: string;
	application: string;
	plugins: string[];
	tier: number;
}

const KEY_PATTERN = /^[a-z0-9-]{1,64}$/;
const TAB_KEY_PATTERN = /^[a-z0-9-]+$/;
const PLUGIN_KEY_PATTERN = /^[A-Za-z0-9_@-][A-Za-z0-9_@/.-]*$/;
// A page id holds no dot, so in `<component>.<pageId>` the last dot is the separator.
const PAGE_KEY_PATTERN = /^(?:[a-z0-9-]+|[A-Za-z0-9_@-][A-Za-z0-9_@/.-]*\.[a-z0-9-]{1,64})$/;
const MAX_KEY_LENGTH = 128;
const VISIBILITY: Record<StudioNavigationState, number> = { hidden: 0, tucked: 1, visible: 2 };
const PLACEMENTS = new Set(['tab', 'config']);
const COMPONENT_READ_CONCURRENCY = 8;
const MAX_PLUGIN_USES = 1000;
const ROOT_SOURCE = 'the root config';
const PLUGINS_SOURCE = 'the installed plugins';
const ROOT_TIER = 0;
const APPLICATION_TIER = 1;
const PAGE_DEFAULT_TIER = Number.MAX_SAFE_INTEGER;

// Problems name the field and what it must be, never the value found there: a mistyped block can hold anything,
// credentials included.

function isMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPageKey(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_KEY_LENGTH && PAGE_KEY_PATTERN.test(value);
}

function isNavigationState(value: unknown): value is StudioNavigationState {
	return typeof value === 'string' && Object.hasOwn(VISIBILITY, value);
}

// The loader joins the key onto `node_modules`, so a `..` segment would read outside it.
function isPluginKey(key: string): boolean {
	return (
		key.length <= MAX_KEY_LENGTH &&
		PLUGIN_KEY_PATTERN.test(key) &&
		key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
	);
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
		else if (!isNavigationState(state)) problems.push(`studio.navigation.${tab} must be visible, tucked or hidden`);
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

function validateStudioPages(
	studio: unknown,
	problems: string[],
	defaults: Map<string, StudioNavigationState>
): PageTemplate[] {
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
	const valid: PageTemplate[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < pages.length; index++) {
		const page = pages[index];
		const label = `studio.pages[${index}]`;
		if (!isMap(page)) {
			problems.push(`${label} must be a map`);
			continue;
		}
		const { id, name, icon, placement, description, access, content, navigation } = page;
		if (typeof id !== 'string' || !KEY_PATTERN.test(id)) {
			problems.push(`${label}.id must be a string matching [a-z0-9-]{1,64}`);
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
		const accepted: PageTemplate = { id, name, placement: placement as StudioPage['placement'] };
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
		if (isNavigationState(navigation)) defaults.set(id, navigation);
		else if (navigation != null)
			problems.push(`${label} ('${id}') navigation must be visible, tucked or hidden; it is left out`);
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

async function readComponentConfig(directory: string, readTextFile: ReadTextFile): Promise<unknown> {
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
			return parsed.toJSON();
		} catch (error) {
			throw new ConfigParseError(configFilePath, error);
		}
	}
	return undefined;
}

function concurrencyLimit(limit: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(work: () => Promise<T>): Promise<T> => {
		if (active < limit) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await work();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

// A plugin directory is shared by every component that loads it, so a problem one of its uses finds can repeat.
function noteOnce(problems: string[], problem: string) {
	if (!problems.includes(problem)) problems.push(problem);
}

function exists(path: string): Promise<boolean> {
	// Any failure counts as absent, as `existsSync` does in the loader.
	return stat(path).then(
		() => true,
		() => false
	);
}

interface ComponentNode {
	where: string;
	problems: string[];
	pages: PageTemplate[];
	pageDefaults: Map<string, StudioNavigationState>;
	/** Keys as the config wrote them: a dotted one is relative to this component. */
	navigation: [string, StudioNavigationState][];
	/** `directory` is where the loader finds the plugin; `real` is what it loads it as, once. */
	plugins: { key: string; directory: string; real: string }[];
}

async function resolvePlugins(directory: string, config: Record<string, unknown>, problems: string[]) {
	const plugins: ComponentNode['plugins'] = [];
	if (process.env.HARPER_SAFE_MODE) return plugins;
	const hdbBasePath = getHdbBasePath();
	for (const [key, entry] of Object.entries(config)) {
		if (key === 'env' || !isMap(entry) || !entry.package) continue;
		if (entry.loadComponent === 'dev-only' && !process.env.DEV_MODE) continue;
		if (!isPluginKey(key)) {
			// The key itself is not quoted: a mistyped entry can be a URL with credentials in it.
			problems.push('a package entry has a key Studio cannot address, so its pages are not read');
			continue;
		}
		// Not found: `if-installed` skips it, and otherwise the loader reports the missing package itself.
		for (const candidate of packageCandidates(directory, key, hdbBasePath)) {
			if (!(await exists(candidate))) continue;
			const real = await realpath(candidate).catch(() => undefined);
			if (real) plugins.push({ key, directory: candidate, real });
			break;
		}
	}
	return plugins;
}

async function readComponent(directory: string, where: string, readTextFile: ReadTextFile): Promise<ComponentNode> {
	const node: ComponentNode = { where, problems: [], pages: [], pageDefaults: new Map(), navigation: [], plugins: [] };
	try {
		const config = await readComponentConfig(directory, readTextFile);
		if (!isMap(config)) return node;
		const { studio } = config;
		node.pages = validateStudioPages(studio, node.problems, node.pageDefaults);
		if (isMap(studio)) {
			node.navigation = Object.entries(validateStudioNavigation(studio.navigation, node.problems) ?? {});
			if (studio.landing != null) node.problems.push('studio.landing is read from the root config only');
		}
		node.plugins = await resolvePlugins(directory, config, node.problems);
	} catch (error) {
		node.problems.push(`its config could not be read: ${error.message}`);
	}
	return node;
}

/**
 * Keyed by real path, as the loader loads a directory once: symlinks that lead back into a plugin would otherwise give
 * it a new lexical path, and a new read, at every level.
 */
async function readComponentGraph(sources: (ComponentSource & { real: string })[], readTextFile: ReadTextFile) {
	const nodes = new Map<string, ComponentNode>();
	const reads = new Map<string, Promise<void>>();
	const limit = concurrencyLimit(COMPONENT_READ_CONCURRENCY);
	const request = (real: string, directory: string, where: string) => {
		if (reads.has(real)) return;
		reads.set(
			real,
			limit(() => readComponent(directory, where, readTextFile)).then((node) => {
				nodes.set(real, node);
				for (const plugin of node.plugins) request(plugin.real, plugin.directory, `plugin at ${plugin.directory}`);
			})
		);
	};
	for (const source of sources) request(source.real, source.directory, source.where);
	for (let settled = 0; settled < reads.size;) {
		const pending = [...reads.values()];
		await Promise.all(pending);
		settled = pending.length;
	}
	return nodes;
}

function contributingDirectories(nodes: Map<string, ComponentNode>): Set<string> {
	const parents = new Map<string, string[]>();
	const contributing = new Set<string>();
	for (const [real, node] of nodes) {
		if (node.pages.length > 0 || node.navigation.length > 0) contributing.add(real);
		for (const plugin of node.plugins) {
			if (!parents.has(plugin.real)) parents.set(plugin.real, []);
			parents.get(plugin.real).push(real);
		}
	}
	const queue = [...contributing];
	while (queue.length > 0) {
		for (const parent of parents.get(queue.pop()) ?? []) {
			if (contributing.has(parent)) continue;
			contributing.add(parent);
			queue.push(parent);
		}
	}
	return contributing;
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
		const pluginProblems: string[] = [];
		const problemsBySource = new Map([
			[ROOT_SOURCE, rootProblems],
			[PLUGINS_SOURCE, pluginProblems],
		]);
		const root = readRootStudioSettings(rootProblems);
		const sources = await Promise.all(
			(await componentSources(rootProblems)).map(async (source) => ({
				...source,
				real: await realpath(source.directory).catch(() => source.directory),
			}))
		);
		const nodes = await readComponentGraph(sources, readTextFile);
		for (const node of nodes.values()) problemsBySource.set(node.where, node.problems);
		const contributing = contributingDirectories(nodes);

		// Between peers the most visible state wins, so the result is the same in any load order.
		const navigation = new Map<string, { tier: number; state: StudioNavigationState }>();
		const contribute = (tier: number, key: string, state: StudioNavigationState) => {
			const current = navigation.get(key);
			if (!current || tier < current.tier || (tier === current.tier && VISIBILITY[state] > VISIBILITY[current.state]))
				navigation.set(key, { tier, state });
		};
		for (const [key, state] of Object.entries(root.navigation ?? {})) contribute(ROOT_TIER, key, state);

		const pages = new Map<
			string,
			{ page: StudioPage; where: string; use: string; default?: StudioNavigationState }[]
		>();
		let uses = 0;
		const expand = (real: string, use: ComponentUse, chain: Set<string>) => {
			const node = nodes.get(real);
			for (const template of node.pages) {
				const key = `${use.component}.${template.id}`;
				if (key.length > MAX_KEY_LENGTH) {
					noteOnce(
						node.problems,
						`its page '${template.id}' is left out: ${key} is longer than ${MAX_KEY_LENGTH} characters`
					);
					continue;
				}
				const page: StudioPage = { component: use.component, application: use.application, ...template };
				if (use.plugins.length > 0) page.plugins = use.plugins;
				if (!pages.has(key)) pages.set(key, []);
				pages.get(key).push({
					page,
					where: node.where,
					use: [use.application, ...use.plugins].join('\0'),
					default: node.pageDefaults.get(template.id),
				});
			}
			for (const [relativeKey, state] of node.navigation) {
				const key = TAB_KEY_PATTERN.test(relativeKey) ? relativeKey : `${use.component}.${relativeKey}`;
				if (key.length > MAX_KEY_LENGTH)
					noteOnce(node.problems, `studio.navigation names ${key}, which is longer than ${MAX_KEY_LENGTH} characters`);
				else contribute(use.tier, key, state);
			}
			for (const plugin of node.plugins) {
				// The loader loads a directory once, so a plugin that leads back to itself adds nothing more.
				if (!contributing.has(plugin.real) || chain.has(plugin.real)) continue;
				if (++uses > MAX_PLUGIN_USES) return;
				expand(
					plugin.real,
					{
						component: `${use.component}.${plugin.key}`,
						application: use.application,
						plugins: [...use.plugins, plugin.key],
						tier: use.tier + 1,
					},
					new Set(chain).add(plugin.real)
				);
			}
		};
		for (const source of sources) {
			if (!contributing.has(source.real)) continue;
			expand(
				source.real,
				{ component: source.name, application: source.name, plugins: [], tier: APPLICATION_TIER },
				new Set([source.real])
			);
		}
		if (uses > MAX_PLUGIN_USES)
			pluginProblems.push(`only the first ${MAX_PLUGIN_USES} plugin uses that declare Studio settings are read`);

		const configuration: StudioConfiguration = { pages: [] };
		for (const [key, entries] of pages) {
			const kept = entries[entries.length - 1];
			if (entries.some((entry) => entry.use !== kept.use)) {
				// Different components claim one key, which navigation could not tell apart.
				for (const entry of entries)
					noteOnce(
						problemsBySource.get(entry.where),
						`its page '${entry.page.id}' is left out: another component's page has the key ${key}`
					);
				continue;
			}
			// The same component from two sources: the `harper dev` application, which sorts after, replaces the other.
			for (const earlier of entries.slice(0, -1))
				if (earlier.where !== kept.where)
					problemsBySource
						.get(earlier.where)
						.push(`its page '${earlier.page.id}' is replaced by the one in ${kept.where}`);
			configuration.pages.push(kept.page);
			if (kept.default) contribute(PAGE_DEFAULT_TIER, key, kept.default);
		}
		if (navigation.size > 0) {
			configuration.navigation = Object.fromEntries([...navigation].map(([key, { state }]) => [key, state]));
			// Studio writes its root settings back from this, so it must never fall back to the merged map.
			configuration.rootNavigation = root.navigation ?? {};
		}
		if (root.landing !== undefined) configuration.landing = root.landing;
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
