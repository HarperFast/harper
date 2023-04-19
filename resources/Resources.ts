import { Resource } from './Resource';

/**
 * This is the global set of all resources that have been registered on this server.
 */
export class Resources extends Map<string, typeof Resource> {
	isWorker = true;
	loginPath?: (request) => string;
	set(path, Resource, type?: string): void {
		if (path.startsWith('/')) path = path.replace(/^\/+/, '');
		const entry = {
			Resource,
			path,
			type,
			hasSubPaths: false,
			remainingPath: '', // reset after each match
		};
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
	 * @param type Optional request content type, allows layering of resources, specifically for defining HTML handlers
	 * that can further transform data from the main structured object resources.
	 * @return The matched Resource class. Note that the remaining path is "returned" by setting the remainingPath property
	 */
	getMatch(path: string, type?: string) {
		let slash_index = 2;
		let found_entry;
		while ((slash_index = path.indexOf('/', slash_index)) > -1) {
			const resource_path = path.slice(0, slash_index);
			const entry = this.get(resource_path);
			if (entry) {
				if (!entry.hasSubPaths) {
					entry.remainingPath = path.slice(slash_index + 1);
					return entry;
				}
				found_entry = entry;
			}
			slash_index += 2;
		}
		if (!found_entry) {
			found_entry = this.get(path);
			if (!found_entry) {
				// still not found, see if there is an explicit root path
				found_entry = this.get('');
				if (found_entry) {
					found_entry.remainingPath = path;
					return found_entry;
				}
			}
		} // try the exact path
		if (found_entry) found_entry.remainingPath = '';
		return found_entry;
	}

	getResource(path: string, resource_info) {
		const entry = this.getMatch(path);
		if (entry) {
			return entry.remainingPath ? entry.Resource.getResource(entry.remainingPath, resource_info) : entry.Resource;
		}
	}
	setRepresentation(path, type, representation) {}
}
export let resources: Resources;
export function resetResources() {
	return (resources = new Resources());
}
