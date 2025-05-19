import { Resource } from './Resource.ts';
import { transaction } from './transaction.ts';
import { ErrorResource } from './ErrorResource.ts';
import logger from '../utility/logging/harper_logger.js';
import { ServerError } from '../utility/errors/hdbError.js';
import { server } from '../server/Server.ts';

interface ResourceEntry {
	Resource: typeof Resource;
	path: string;
	exportTypes: any;
	hasSubPaths: boolean;
	relativeURL: string;
}

/**
 * This is the global set of all resources that have been registered on this server.
 */
export class Resources extends Map<string, ResourceEntry> {
	isWorker = true;
	loginPath?: (request) => string;
	set(path, resource, exportTypes?: { [key: string]: boolean }, force?: boolean): void {
		if (!resource) throw new Error('Must provide a resource');
		if (path.startsWith('/')) path = path.replace(/^\/+/, '');
		const entry = {
			Resource: resource,
			path,
			exportTypes,
			hasSubPaths: false,
			relativeURL: '', // reset after each match
		};
		const existingEntry = super.get(path);
		if (
			existingEntry &&
			(existingEntry.Resource.databaseName !== resource.databaseName ||
				existingEntry.Resource.tableName !== resource.tableName) &&
			!force
		) {
			// there was a conflict in endpoint paths. We don't want this to be ignored, so we log it
			// and create an error resource to make sure it is reported in any attempt to access this path.
			// it was be a 500 error; clearly a server error (not client error), unfortunate that the 5xx errors
			// don't provide anything more descriptive.
			const error = new ServerError(`Conflicting paths for ${path}`);
			logger.error(error);
			entry.Resource = new ErrorResource(error);
		}
		super.set(path, entry);
		// now mark any entries that have sub paths so we can efficiently route forward
		for (const [path, entry] of this) {
			let slashIndex = 2;
			while ((slashIndex = path.indexOf('/', slashIndex)) > -1) {
				const parentEntry = this.get(path.slice(0, slashIndex));
				if (parentEntry) parentEntry.hasSubPaths = true;
				slashIndex += 2;
			}
		}
	}

	/**
	 * Find the best (longest) match resource path that matches the (beginning of the) provided path, in order to find
	 * the correct Resource to handle this URL path.
	 * @param path The URL Path
	 * @param exportType Optional request content or protocol type, allows control of which protocols can access a resource
	 * and future layering of resources (for defining HTML handlers
	 * that can further transform data from the main structured object resources).
	 * @return The matched Resource class. Note that the remaining path is "returned" by setting the relativeURL property
	 */
	getMatch(url: string, exportType?: string): ResourceEntry | undefined {
		let slashIndex = 2;
		let prevSlashIndex = 0;
		let foundEntry: ResourceEntry;

		const urlLength = url.length;

		while (slashIndex < urlLength) {
			prevSlashIndex = slashIndex;
			slashIndex = url.indexOf('/', slashIndex);

			if (slashIndex === -1) {
				slashIndex = urlLength;
			}

			const resourcePath = slashIndex === urlLength ? url : url.slice(0, slashIndex);
			let entry = this.get(resourcePath);
			let queryIndex = -1;
			if (!entry && slashIndex === urlLength) {
				// try to match the first part of the path if there's a query
				queryIndex = resourcePath.indexOf('?', prevSlashIndex);
				if (queryIndex !== -1) {
					const pathPart = resourcePath.slice(0, queryIndex);
					entry = this.get(pathPart);
				}
			}
			if (entry && (!exportType || entry.exportTypes?.[exportType] !== false)) {
				entry.relativeURL = url.slice(queryIndex !== -1 ? queryIndex : slashIndex);
				if (!entry.hasSubPaths) {
					return entry;
				}
				foundEntry = entry;
			}

			slashIndex += 2;
		}

		if (foundEntry) return foundEntry;

		// try the exact path
		const searchIndex = url.indexOf('?');
		const path = searchIndex > -1 ? url.slice(0, searchIndex) : url;
		foundEntry = this.get(path);
		if (!foundEntry && path.indexOf('.') > -1) {
			foundEntry = this.get(path.split('.')[0]);
		}
		if (foundEntry && (!exportType || foundEntry.exportTypes?.[exportType] !== false)) {
			foundEntry.relativeURL = searchIndex > -1 ? url.slice(searchIndex) : '';
		} else if (!foundEntry) {
			// still not found, see if there is an explicit root path
			foundEntry = this.get('');
			if (foundEntry && (!exportType || foundEntry.exportTypes?.[exportType] !== false)) {
				if (url.charAt(0) !== '/') url = '/' + url;
				foundEntry.relativeURL = url;
			}
		}
		return foundEntry;
	}

	getResource(path: string, resourceInfo) {
		const entry = this.getMatch(path);
		if (entry) {
			path = entry.relativeURL;
			return entry.Resource.getResource(this.pathToId(path, entry.Resource), resourceInfo);
		}
	}
	call(path: string, request, callback: Function) {
		return transaction(request, async () => {
			const entry = this.getMatch(path);
			if (entry) {
				path = entry.relativeURL;
				return callback(entry.Resource, entry.path, path);
			}
		});
	}
	setRepresentation(path, type, representation) {}
}
export let resources: Resources;
export function resetResources() {
	resources = new Resources();
	server.resources = resources;
	return resources;
}

export function keyArrayToString(key) {
	if (Array.isArray(key)) {
		if (key[key.length - 1] === null) return key.slice(0, -1).join('/') + '/';
		else return key.join('/');
	}
	return key;
}
