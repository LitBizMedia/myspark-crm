// POST /api/subaccount/litbiz/sop/clients
// Body: { name, services?, report_due_day? }

const { requireLitBizAccess } = require('./lib/require-litbiz-access');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');

const VALID_SERVICES = ['social', 'ppc', 'smads', 'seo', 'website'];

async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const auth = await requireLitBizAccess(req, res);
    if (!auth) return;

    const body = (typeof req.body === 'object' && req.body) ? req.body : {};

    const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 200);
    if (!name) return res.status(400).json({ error: 'name_required' });

    const rawServices = Array.isArray(body.services) ? body.services : [];
    const services = rawServices.filter(s => VALID_SERVICES.indexOf(s) !== -1);

    let reportDay = null;
    if (body.report_due_day != null && body.report_due_day !== '') {
      const n = parseInt(body.report_due_day, 10);
      if (!isNaN(n) && n >= 1 && n <= 31) reportDay = n;
    }

    const result = await db.query(
      `INSERT INTO litbiz_sop_clients
         (subaccount_id, name, services, report_due_day)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, name, services, report_due_day, created_at, updated_at`,
      [auth.subaccount_id, name, JSON.stringify(services), reportDay]
    );

    const row = result.rows[0];

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.litbiz.sop.client.create',
      targetType: 'litbiz_sop_client',
      targetId: row.id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { name: row.name, services_count: services.length }
    });

    return res.status(200).json({
      id: row.id,
      name: row.name,
      services: row.services || [],
      report_due_day: row.report_due_day,
      created_at: row.created_at,
      updated_at: row.updated_at,
      tasks: {}
    });
  } catch (e) {
    console.error('sop-client-create error:', e.message);
    return res.status(500).json({ error: 'client_create_failed' });
  }
}

exports.handler = wrap(handler);
