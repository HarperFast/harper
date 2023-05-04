/**
 * There is a crazy bug in NodeJS where dynamic imports will cause a segmentation fault due to the caller context
 * (in the host dynamic module callback handler in C++)
 * referencing module ids of scripts that have been garbage collected, which is made possible due to an unusual path
 * in the NodeJS module wrapping code, that use the node's virtual machine context, that is triggered when a module
 * alters the normal module wrapping code. The
 * perpetrator of this module modification is rewire. The equally crazy hack to fix this is to intercept this alternate
 * module wrapping that uses the vm script mechanism, and force every script to be pinned into memory. This is
 * terrible, but better than frequent segmentation faults.
 */
const { Script } = require('vm');
let pinned_scripts = [];
let originalRun = Script.prototype.runInThisContext;
Script.prototype.runInThisContext = function (options) {
	pinned_scripts.push(this);
	return originalRun.call(this, options);
};
