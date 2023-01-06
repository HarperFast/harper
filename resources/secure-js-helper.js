const smrModule = import('@endo/static-module-record');
function doLockdown() {
	require('ses');
	lockdown({ domainTaming: 'unsafe', consoleTaming: 'unsafe', errorTaming: 'unsafe', errorTrapping: 'none', stackFiltering: 'verbose' });
	return { harden };
}
module.exports = {
	smrModule,
	doLockdown
};