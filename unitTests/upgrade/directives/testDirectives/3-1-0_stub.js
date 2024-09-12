'use strict';
const upgrade_directive = require('../../../../upgrade/UpgradeDirective');

let this_ver = '3.1.0';
let directive = new upgrade_directive(this_ver);

function updateSettingsFunc() {
	const msg = `processing settings func for ${this_ver} upgrade`;
	console.log(msg);
	return msg;
}
directive.sync_functions.push(updateSettingsFunc);

async function doSomething() {
	const msg = `processing other func for ${this_ver} upgrade`;
	await new Promise((resolve) => {
		console.log(msg);
		resolve();
	});
	return msg;
}
directive.async_functions.push(doSomething);

module.exports = directive;
