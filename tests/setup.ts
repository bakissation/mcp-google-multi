// src/accounts.ts throws at import time if GOOGLE_ACCOUNTS is unset (CI has no .env) — seed a fixture before test imports pull it in.
process.env.GOOGLE_ACCOUNTS ||= 'test:test@example.com';
// ToolRegistry reads GOOGLE_TRIM at construction — pin it so an ambient
// GOOGLE_TRIM=off in a developer shell can't redden the compaction tests.
process.env.GOOGLE_TRIM = '';
