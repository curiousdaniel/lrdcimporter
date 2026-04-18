import { neon } from '@neondatabase/serverless';

export function getDatabaseUrl(): string | undefined {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL
  );
}

export function getSql() {
  const url = getDatabaseUrl();
  if (!url) {
    throw new Error('Missing DATABASE_URL (or POSTGRES_URL)');
  }
  return neon(url);
}
