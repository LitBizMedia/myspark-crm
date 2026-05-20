// PUT /api/subaccount/litbiz/sop/clients/:id
// Body: { name?, services?, report_due_day? }

const { requireLitBizAccess } = require('./lib/require-litbiz-access');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');

const VALID_SERVICES = ['social', 'ppc', 'smads', 'seo', 'website'];

async function handler(req, res) {
  try {
    if (req.method !== 'PUT' && req.method !== 'PATCH') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const auth = await requireLitBizAccess(req, res);
    if (!auth) return;

    const params = req.pathParameters || {};
    const id = params.id;
    if (!id) return res.status(400).json({ error: 'id_required' });

    const existing = await db.query(
      `SELECT id FROM litbiz_sop_clients
         WHERE id = $1 AND subaccount_id = $2 AND archived = FALSE`,
      [id, auth.subaccount_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'client_not_found' });
    }

    const body = (typeof req.body === 'object' && req.body) ? req.body : {};

    const sets = [];
    const vals = [];
    let i = 1;
    const changes = {};

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 200);
      if (!name) return res.status(400).json({ error: 'name_empty' });
      sets.push(`name = $${i++}`); vals.push(name); changes.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'services')) {
      const raw = Array.isArray(body.services) ? body.services : [];
      const services = raw.filter(s => VALID_SERVICES.indexOf(s) !== -1);
      sets.push(`services = $${i++}::jsonb`); vals.push(JSON.stringify(services)); changes.services_count = services.length;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'report_due_day')) {
      let reportDay = null;
      if (body.report_due_day != null && body.report_due_day !== '') {
        const n = parseInt(body.report_due_day, 10);
        if (!isNaN(n) && n >= 1 && n <= 31) reportDay = n;
      }
      sets.push(`report_due_day = $${i++}`); vals.push(reportDay); changes.report_due_day = reportDay;
    }

    if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });

    sets.push(`updated_at = NOW()`);
    vals.push(id);
    vals.push(auth.subaccount_id);

    const sql = `UPDATE litbiz_sop_clients SET ${sets.join(', ')}
                   WHERE id = $${i++} AND subaccount_id = $${i++}
                   RETURNING id, name, services, report_due_day, created_at, updated_at`;

    const result = await db.query(sql, vals);
    const row = result.rows[0];

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.litbiz.sop.client.update',
      targetType: 'litbiz_sop_client',
      targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: changes
    });

    return res.status(200).json({
      id: row.id,
      name: row.name,
      services: row.services || [],
      report_due_day: row.report_due_day,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  } catch (e) {
    console.error('sop-client-update error:', e.message);
    return res.status(500).json({ error: 'client_update_failed' });
  }
}

exports.handler = wrap(handler);
