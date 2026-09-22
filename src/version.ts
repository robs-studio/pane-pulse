// The one export that proves .mjs tests can import .ts on this machine (Node type
// stripping). Kept dependency-free on purpose: tests/smoke.test.mjs imports it directly.
export const VERSION = '0.2.0';
