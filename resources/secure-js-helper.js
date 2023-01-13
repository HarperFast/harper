async function doLockdown() {
	require('ses');
	lockdown({ domainTaming: 'unsafe', consoleTaming: 'unsafe', errorTaming: 'unsafe', errorTrapping: 'none', stackFiltering: 'verbose' });
	const { StaticModuleRecord } = await import('@endo/static-module-record');
	return { harden, StaticModuleRecord };
}
module.exports = {
	doLockdown
};