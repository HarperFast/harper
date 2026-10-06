const records = new Map([['r1', { id: 'r1', label: 'readonly-r1' }]]);

export class Widget extends tables.Widget {}

export class ReadOnlyThing extends Resource {
	get(target) {
		return records.get(target.id);
	}
	search() {
		return [...records.values()];
	}
}

export class WriteOnlyThing extends Resource {
	post(data) {
		records.set(data.id, data);
		return data;
	}
	put(data, target) {
		const record = { ...data, id: target.id };
		records.set(target.id, record);
		return record;
	}
}

export class CreateOnlyThing extends Resource {
	static primaryKey = 'id';
	create(_id, data) {
		records.set(data.id, data);
		return data;
	}
}

export class ThrowingCanary extends Resource {
	allowCreate() {
		return true;
	}
	post() {
		throw new Error('QA736_DELIBERATE_CANARY_THROW');
	}
}

export class PermissiveCanary extends Resource {
	allowCreate(user) {
		return !!user?.username;
	}
	post(data) {
		records.set(data.id, data);
		return data;
	}
}
