import { getDatabaseUrl } from '../../../lib/db';

export function GET() {
  const configured = !!getDatabaseUrl();
  return Response.json({ configured });
}
