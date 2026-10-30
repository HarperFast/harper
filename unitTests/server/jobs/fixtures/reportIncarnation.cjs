'use strict';
// Prints this process's job-owner instance id. Run as a child so the id comes from a genuinely separate
// Harper process — the premise the boot sweep rests on is that a restart mints a new one.
const manageThreads = require('#src/server/threads/manageThreads');
process.stdout.write(String(manageThreads.processIncarnation ?? ''));
