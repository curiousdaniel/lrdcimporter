-- Donation rows synced from the offline launcher (Neon / Postgres).
-- Run: npm run db:migrate (requires DATABASE_URL or POSTGRES_URL in env)

CREATE TABLE IF NOT EXISTS donation_import_row (
  row_key TEXT PRIMARY KEY,
  supporter_id TEXT,
  email TEXT,
  donor_name TEXT,
  amount TEXT,
  payment_method TEXT,
  memo TEXT,
  recorded BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ,
  first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_donation_import_row_recorded ON donation_import_row (recorded);
CREATE INDEX IF NOT EXISTS idx_donation_import_row_last_imported ON donation_import_row (last_imported_at DESC);
