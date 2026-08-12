import { neon } from "@neondatabase/serverless";

// Row-returning tagged-template shape. The default neon() HTTP driver (no
// arrayMode/fullResults) resolves to Record<string, any>[]; we surface that as
// a generic so `await sql<T>\`...\`` yields T[] and rows are indexable/mappable.
type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<T[]>;

// Neon HTTP driver — a stateless, serverless-friendly SQL tagged template.
// Ideal for Vercel functions (one round-trip per query, no pooled connection to
// leak). App code imports `sql` and writes parameterized tagged-template queries;
// values are always bound as parameters, never string-interpolated.
//
// Returns a lazily-thrown proxy when DATABASE_URL is missing so importing this
// module never crashes the build — the throw happens only if a query actually
// runs without a configured database.
function makeSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return new Proxy((() => {}) as unknown as ReturnType<typeof neon>, {
      apply() {
        throw new Error("DATABASE_URL is not set — configure it in .env / Vercel env");
      },
    });
  }
  return neon(url);
}

export const sql = makeSql() as unknown as SqlTag;

export function dbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
