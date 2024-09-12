import { Resource } from './Resource';
import { transaction } from './transaction';
import { ErrorResource } from './ErrorResource';
import logger from '../utility/logging/harper_logger';
import { ServerError } from '../utility/errors/hdbError';
/**
 * This is the global set of all resources that have been registered on this server.
 */
export class Resources extends Map<string, typeof Resource> {
	isWorker = true;
	loginPath?: (request) => string;
	set(path, resource, export_types?: string[], force?: boolean): void {
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
	getMatch(url: string, export_type?: string) {
		let slash_index = 2;
		let found_entry;
		while ((slash_index = url.indexOf('/', slash_index)) > -1) {
			const resource_path = url.slice(0, slash_index);
			let entry = this.get(resource_path);
			if (!entry && resource_path.indexOf('.') > -1) {
				// try to match the first part of the path if the .extension
				const parts = resource_path.split('.');
				entry = this.get(parts[0]);
			}
			if (entry && (!export_type || entry.exportTypes?.[export_type] !== false)) {
				entry.relativeURL = url.slice(slash_index);
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
				if (url[0] !== '/') url = '/' + url;
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
	return (resources = new Resources());
}

export function keyArrayToString(key) {
	if (Array.isArray(key)) {
		if (key[key.length - 1] === null) return key.slice(0, -1).join('/') + '/';
		else return key.join('/');
	}
	return key;
}
