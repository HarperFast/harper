'use strict';

// The no-config logging window — install, and any host with no harperdb-config.yaml.
// initLogSettings() picks that branch at module load, from the machine's own config resolution,
// which is why this is a child: the caller spawns it with ROOTPATH at a directory holding no
// config, and the branch is then taken on an installed machine and a bare one alike.

const { warn } = require('#src/utility/logging/harper_logger');

warn('no-config stream check');

// stdioLogging() stashes its 'error' listener on the stream it guards, and the fallback branch
// returns before the call at the end of initLogSettings().
const guarded = (stream) => typeof stream.harperStdioErrorHandler === 'function';
process.stdout.write(`stdout-guard=${guarded(process.stdout)} stderr-guard=${guarded(process.stderr)}\n`);
