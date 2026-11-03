'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const YAML = require('yaml');

async function run() {
	const phase = process.argv[2];
	if (phase === 'verify' || phase === 'boot') {
		require('#src/utility/environment/environmentManager').initSync(true);
	} else {
		const held = {};
		for (const key of ['HDB_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_CONFIG', 'HARPER_SET_CONFIG']) {
			held[key] = process.env[key];
			delete process.env[key];
		}
		const template = held.HDB_CONFIG;
		if (template) fs.renameSync(template, `${template}.loading`);
		let installer;
		try {
			installer = require('#src/utility/install/installer');
		} finally {
			if (template) fs.renameSync(`${template}.loading`, template);
		}
		for (const [key, value] of Object.entries(held)) if (value !== undefined) process.env[key] = value;
		if (phase === 'pending') {
			const config = YAML.parse(fs.readFileSync(template, 'utf8'));
			const staged = require('#src/config/harperConfigEnvVars').prepareRuntimeEnvConfig(config, process.env.ROOTPATH);
			assert.strictEqual(staged.saveState(), true);
			fs.writeFileSync(template, YAML.stringify(staged.config));
			console.log('install-destination-guard-ok');
			return;
		}
		installer.setIgnoreExisting(process.env.GUARD_OVERRIDE === 'true');
		await installer.install();
	}
	const db = require('#src/resources/databases');
	if (phase === 'seed' || phase === 'verify') {
		db.getDatabases();
		const users = db.databases.system.hdb_user;
		const admin = await users.get('admin');
		if (phase === 'seed') {
			await users.put({ username: 'guard-sentinel', password: 'preserved-value', role: 'super_user', active: true });
			fs.writeFileSync(process.env.GUARD_SNAPSHOT, JSON.stringify(admin));
		} else {
			assert.deepStrictEqual(
				JSON.parse(JSON.stringify(admin)),
				JSON.parse(fs.readFileSync(process.env.GUARD_SNAPSHOT))
			);
			assert.strictEqual((await users.get('guard-sentinel')).password, 'preserved-value');
			assert.strictEqual(
				(await require('#src/security/user').findAndValidateUser('admin', 'original-guard-password')).username,
				'admin'
			);
		}
	}
	if (phase === 'boot') {
		db.getDatabases();
		assert.strictEqual(
			(await require('#src/security/user').findAndValidateUser('admin', 'original-guard-password')).username,
			'admin'
		);
	}
	await db.closeLoadedDatabases();
	console.log('install-destination-guard-ok');
}

run().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
