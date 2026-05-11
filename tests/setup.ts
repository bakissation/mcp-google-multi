// Some unit tests import from src/tools/*.ts which transitively load src/accounts.ts.
// That module parses GOOGLE_ACCOUNTS at import time and throws if it's unset (CI has no .env).
// Inject a harmless fixture before any test module loads so the import chain succeeds.
process.env.GOOGLE_ACCOUNTS ||= 'test:test@example.com';
