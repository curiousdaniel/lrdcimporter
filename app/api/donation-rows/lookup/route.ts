import { getDatabaseUrl, getSql } from '../../../../lib/db';

type Body = { keys?: string[] };

export async function POST(req: Request) {
  if (!getDatabaseUrl()) {
    return Response.json({ error: 'Database not configured' }, { status: 503 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string') : [];
  if (keys.length === 0) {
    return Response.json({ rows: [] });
  }
  if (keys.length > 800) {
    return Response.json({ error: 'Too many keys (max 800 per request)' }, { status: 400 });
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT row_key, recorded, recorded_at, donor_name, amount, payment_method, memo, last_imported_at
      FROM donation_import_row
      WHERE row_key = ANY(${keys}::text[])
    `;
    return Response.json({ rows });
  } catch (e) {
    console.error('[donation-rows/lookup]', e);
    return Response.json({ error: 'Database query failed' }, { status: 500 });
  }
}
