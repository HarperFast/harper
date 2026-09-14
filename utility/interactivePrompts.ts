import { confirm, input, password, select } from '@inquirer/prompts';

// `@inquirer/prompts` is a genuine ES module, so its named exports are non-writable bindings —
// `require('@inquirer/prompts').input = stub` silently no-ops even after CJS interop, unlike a
// CJS default export's own properties (see the chokidar seam in watcherFallback.ts). Routing every
// call through this plain, mutable object gives unit tests a real seam to stub while production
// code still calls straight through to the real prompts.
export const prompts = { confirm, input, password, select };
