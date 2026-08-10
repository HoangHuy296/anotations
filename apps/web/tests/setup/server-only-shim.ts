// Vitest equivalent of `tests/auth-ownership/register-server-only.cjs`: an
// empty module aliased in place of the real `server-only` package (not a
// project dependency) so vitest specs can import modules that transitively
// pull in server-side-only code without a Next.js runtime.
export {};
