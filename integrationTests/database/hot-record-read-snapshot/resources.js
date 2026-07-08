// QA-334 — hot-config fixture resources.

export class WriteConfig extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const version = body && typeof body.version === 'number' ? body.version : 0;
		const flagA = body && typeof body.flagA === 'number' ? body.flagA : 0;
		const flagB = body && typeof body.flagB === 'number' ? body.flagB : 0;
		const payload = body && typeof body.payload === 'string' ? body.payload : '';
		const checksum = flagA + flagB + version;

		const updatable = await tables.Config.update('global', {});
		updatable.set('id', 'global');
		updatable.set('version', version);
		updatable.set('flagA', flagA);
		updatable.set('flagB', flagB);
		updatable.set('payload', payload);
		updatable.set('checksum', checksum);
		await updatable.save();
		return { ok: true, version, checksum };
	}
}

export class BumpReadCount extends Resource {
	static loadAsInstance = false;

	async post(_query, _body) {
		const updatable = await tables.Config.update('global', {});
		updatable.set('id', 'global');
		updatable.addTo('readCount', 1);
		await updatable.save();
		return { ok: true };
	}
}
