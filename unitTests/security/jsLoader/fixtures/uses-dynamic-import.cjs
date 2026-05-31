module.exports.load = async function () {
	const lib = await import('./libgood.cjs');
	return lib.default || lib;
};
