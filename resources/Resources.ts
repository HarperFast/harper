import { Resource } from './Resource';
import { transaction } from './transaction';
import { ErrorResource } from './ErrorResource';
import logger from '../utility/logging/harper_logger';
import { ServerError } from '../utility/errors/hdbError';
import { server } from '../server/Server';

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
	set(path, resource, export_types?: { [key: string]: boolean }, force?: boolean): void {
		if (!resource) throw new Error('Must provide a resource');
		if (path.startsWith('/')) path = path.replace(/^\/+/, '');
		const entry = {
			Resource: resource,
			path,
			exportTypes: export_types,
			hasSubPaths: false,
			relativeURL: '', // reset after each match
		};
		const existing_entry = super.get(path);
		if (
			existing_entry &&
			(existing_entry.Resource.databaseName !== resource.databaseName ||
				existing_entry.Resource.tableName !== resource.tableName) &&
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
			let slash_index = 2;
			while ((slash_index = path.indexOf('/', slash_index)) > -1) {
				const parent_entry = this.get(path.slice(0, slash_index));
				if (parent_entry) parent_entry.hasSubPaths = true;
				slash_index += 2;
			}
		}
	}

	/**
	 * Find the best (longest) match resource path that matches the (beginning of the) provided path, in order to find
	 * the correct Resource to handle this URL path.
	 * @param path The URL Path
	 * @param export_type Optional request content or protocol type, allows control of which protocols can access a resource
	 * and future layering of resources (for defining HTML handlers
	 * that can further transform data from the main structured object resources).
	 * @return The matched Resource class. Note that the remaining path is "returned" by setting the relativeURL property
	 */
	getMatch(url: string, export_type?: string): ResourceEntry | undefined {
		let slash_index = 2;
		let prevSlashIndex = 0;
		let found_entry: ResourceEntry;

		const urlLength = url.length;

		while (slash_index < urlLength) {
			prevSlashIndex = slash_index;
			slash_index = url.indexOf('/', slash_index);

			if (slash_index === -1) {
				slash_index = urlLength;
			}

			const resourcePath = slash_index === urlLength ? url : url.slice(0, slash_index);
			let entry = this.get(resourcePath);
			let queryIndex = -1;
			if (!entry && slash_index === urlLength) {
				// try to match the first part of the path if there's a query
				queryIndex = resourcePath.indexOf('?', prevSlashIndex);
				if (queryIndex !== -1) {
					const pathPart = resourcePath.slice(0, queryIndex);
					entry = this.get(pathPart);
				}
			}
			if (entry && (!export_type || entry.exportTypes?.[export_type] !== false)) {
				entry.relativeURL = url.slice(queryIndex !== -1 ? queryIndex : slash_index);
				if (!entry.hasSubPaths) {
					return entry;
				}
				found_entry = entry;
			}

			slash_index += 2;
		}

		if (found_entry) return found_entry;

		// try the exact path
		const search_index = url.indexOf('?');
		const path = search_index > -1 ? url.slice(0, search_index) : url;
		found_entry = this.get(path);
		if (!found_entry && path.indexOf('.') > -1) {
			found_entry = this.get(path.split('.')[0]);
		}
		if (found_entry && (!export_type || found_entry.exportTypes?.[export_type] !== false)) {
			found_entry.relativeURL = search_index > -1 ? url.slice(search_index) : '';
		} else if (!found_entry) {
			// still not found, see if there is an explicit root path
			found_entry = this.get('');
			if (found_entry && (!export_type || found_entry.exportTypes?.[export_type] !== false)) {
				if (url.charAt(0) !== '/') url = '/' + url;
				found_entry.relativeURL = url;
			}
		}
		return found_entry;
	}

	getResource(path: string, resource_info) {
		const entry = this.getMatch(path);
		if (entry) {
			path = entry.relativeURL;
			return entry.Resource.getResource(this.pathToId(path, entry.Resource), resource_info);
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
