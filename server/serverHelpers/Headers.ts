/**
 * Fast implementation of standard Headers
 */
export class Headers extends Map<string, { name: string; value: string }> {
	set(name, value) {
		if (typeof name !== 'string') name = '' + name;
		if (typeof value !== 'string') value = '' + value;
		return super.set(name.toLowerCase(), [name, value]);
	}
	get(name) {
		if (typeof name !== 'string') name = '' + name;
		return super.get(name.toLowerCase())?.[1];
	}
	append(name, value, comma_delimited) {
		if (typeof name !== 'string') name = '' + name;
		if (typeof value !== 'string') value = '' + value;
		const lower_name = name.toLowerCase();
		const existing = super.get(lower_name);
		if (existing) {
			const existing_value = existing[1];
			if (comma_delimited)
				value = (typeof existing_value === 'string' ? existing_value : existing_value.join(', ')) + ', ' + value;
			else if (typeof existing_value === 'string') value = [existing_value, value];
			else existing_value.push(value);
		}
		return super.set(lower_name, [name, value]);
	}
	[Symbol.iterator]() {
		return super.values()[Symbol.iterator]();
	}
}
