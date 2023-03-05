export class Resources extends Map {
	remainingPath = ''
	set(path, Resource, type) {
		let entry = {
			Resource,
			path,
			type,
			hasSubPaths: false,
		};
		super.set(path, entry);
		// now mark any entries that have sub paths so we can efficiently route forward
		for (let [ path, entry ] of this) {
			let slash_index = 2;
			while((slash_index = path.indexOf(slash_index)) > -1) {
				let parent_entry = this.get(path.slice(0, slash_index));
				if (parent_entry) parent_entry.hasSubPaths = true;
				slash_index += 2;
			}
		}
	}

	/**
	 * Find the best (longest) match resource path that matches the (beginning of the) provided path
	 * @param path
	 * @param type
	 */
	getMatch(path: string, type?: string) {
		let slash_index = 2;
		let found_entry;
		while((slash_index = path.indexOf('/', slash_index)) > -1) {
			let resource_path = path.slice(0, slash_index);
			let entry = this.get(resource_path);
			if (entry) {
				if (!entry.hasSubPaths) {
					this.remainingPath = path.slice(slash_index + 1);
					return entry;
				}
				found_entry = entry;
			}
			slash_index += 2;
		}
		return found_entry;
	}

/*	set(path, Resource) {
		let current_location = { paths: this.paths };
		for (let path_part of path.split('/')) {
			if (!path_part) continue;
			if (!current_location.paths)
				current_location.paths = Object.create(null);
			let next = current_location.paths[path_part];
			if (!next) {
				current_location.paths[path_part] = next = {
				};
			}
			current_location = next;
		}
		current_location.Resource = Resource;
	}*/
	setRepresentation(path, type, representation) {

	}

}
