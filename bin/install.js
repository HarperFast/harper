const installer = require('../utility/install/installer');
const hdb_logger = require('../utility/logging/harper_logger');

function install(callback) {
	installer.install(function (err) {
		if (err) {
			if (err === 'REFUSED') {
				console.log('Terms & Conditions refused, closing installer.');
				return callback(err, null);
			}
			console.log('There was an error during the install.  Please check the install logs. \n ERROR: ' + err);
			hdb_logger.error(err);
			return callback(err);
		}

		callback(null, 'HarperDB Installation was successful');
	});
}
module.exports = {
	install: install,
};
