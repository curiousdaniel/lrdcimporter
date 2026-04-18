import { getDatabaseUrl, getSql } from '../../../../lib/db';

type Update = { rowKey?: string; recorded?: boolean };

export async function POST(req: Request) {
  if (!getDatabaseUrl()) {
    return Response.json({ error: 'Database not configured' }, { status: 503 });
  }
  let body: { updates?: Update[] };
  try {
    body = (await req.json()) as { updates?: Update[] };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (updates.length === 0) {
    return Response.json({ ok: true, updated: 0, results: [] });
  }
  if (updates.length > 500) {
    return Response.json({ error: 'Too many updates (max 500)' }, { status: 400 });
  }

  try {
    const sql = getSql();
    const results: { row_key: string; recorded: boolean; recorded_at: string | null }[] = [];
    for (const u of updates) {
      const rowKey = String(u.rowKey || '').slice(0, 2048);
      if (!rowKey) continue;
      const recorded = !!u.recorded;
      const out = await sql`
        INSERT INTO donation_import_row (
          row_key,
          supporter_id,
          email,
          donor_name,
          amount,
          payment_method,
          memo,
          recorded,
          recorded_at,
          first_imported_at,
          last_imported_at
        )
        VALUES (
          ${rowKey},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          ${recorded},
          CASE WHEN ${recorded} THEN NOW() ELSE NULL END,
          NOW(),
          NOW()
        )
        ON CONFLICT (row_key) DO UPDATE SET
          recorded = EXCLUDED.recorded,
          recorded_at = CASE
            WHEN EXCLUDED.recorded THEN COALESCE(donation_import_row.recorded_at, NOW())
            ELSE NULL
          END,
          last_imported_at = NOW()
        RETURNING row_key, recorded, recorded_at
      `;
      const row = (out as { row_key: string; recorded: boolean; recorded_at: Date | null }[])[0];
      if (row) {
        results.push({
          row_key: row.row_key,
          recorded: row.recorded,
          recorded_at: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
        });
      }
    }
    return Response.json({ ok: true, updated: results.length, results });
  } catch (e) {
    console.error('[donation-rows/recorded]', e);
    return Response.json({ error: 'Database update failed' }, { status: 500 });
  }
}
