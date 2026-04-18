import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL;

if (!url) {
  console.error('Set DATABASE_URL (or POSTGRES_URL) to run migrations.');
  process.exit(1);
}

const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
const raw = fs.readFileSync(schemaPath, 'utf8');
const statements = raw
  .split(/;\s*[\r\n]+/)
  .map((s) => s.trim())
  .filter((s) => s.length && !s.startsWith('--'));

const client = new pg.Client({ connectionString: url });
await client.connect();
for (const st of statements) {
  await client.query(st + (st.endsWith(';') ? '' : ';'));
}
await client.end();

console.log('Migration finished:', statements.length, 'statement(s).');
