export function parseToQuery(queryString) {
	let conditions = [];
	for (let [ name, value ] of new URLSearchParams(queryString).entries()) {
		conditions.push({
			attribute: name,
			value,
			type: 'equals',
		});
	}
	return { conditions };
}