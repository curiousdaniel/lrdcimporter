import { getDatabaseUrl, getSql } from '../../../../lib/db';

type RowIn = {
  row_key: string;
  supporter_id?: string | null;
  email?: string | null;
  donor_name?: string | null;
  amount?: string | null;
  payment_method?: string | null;
  memo?: string | null;
  recorded?: boolean;
};

export async function POST(req: Request) {
  if (!getDatabaseUrl()) {
    return Response.json({ error: 'Database not configured' }, { status: 503 });
  }
  let body: { rows?: RowIn[] };
  try {
    body = (await req.json()) as { rows?: RowIn[] };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return Response.json({ ok: true, upserted: 0 });
  }
  if (rows.length > 2000) {
    return Response.json({ error: 'Too many rows (max 2000 per request)' }, { status: 400 });
  }

  try {
    const sql = getSql();
    let n = 0;
    for (const r of rows) {
      const rk = String(r.row_key || '').slice(0, 2048);
      if (!rk) continue;
      const rec = !!r.recorded;
      await sql`
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
          ${rk},
          ${r.supporter_id ?? null},
          ${r.email ?? null},
          ${r.donor_name ?? null},
          ${r.amount ?? null},
          ${r.payment_method ?? null},
          ${r.memo ?? null},
          ${rec},
          CASE WHEN ${rec} THEN NOW() ELSE NULL END,
          NOW(),
          NOW()
        )
        ON CONFLICT (row_key) DO UPDATE SET
          supporter_id = EXCLUDED.supporter_id,
          email = EXCLUDED.email,
          donor_name = EXCLUDED.donor_name,
          amount = EXCLUDED.amount,
          payment_method = EXCLUDED.payment_method,
          memo = EXCLUDED.memo,
          recorded = donation_import_row.recorded OR EXCLUDED.recorded,
          recorded_at = CASE
            WHEN donation_import_row.recorded OR EXCLUDED.recorded
              THEN COALESCE(donation_import_row.recorded_at, EXCLUDED.recorded_at)
            ELSE NULL
          END,
          last_imported_at = NOW()
      `;
      n++;
    }
    return Response.json({ ok: true, upserted: n });
  } catch (e) {
    console.error('[donation-rows/sync]', e);
    return Response.json({ error: 'Database write failed' }, { status: 500 });
  }
}
