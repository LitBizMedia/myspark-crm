// GET /api/subaccount/litbiz/sop/data
// Returns all non-archived clients with embedded task state.

const { requireLitBizAccess } = require('./lib/require-litbiz-access');
const { wrap } = require('./lib/lambda-adapter');
const db = require('./lib/db');

async function handler(req, res) {
  try {
    const auth = await requireLitBizAccess(req, res);
    if (!auth) return;

    const clientsResult = await db.query(
      `SELECT id, name, services, report_due_day,
              archived, created_at, updated_at
         FROM litbiz_sop_clients
         WHERE subaccount_id = $1 AND archived = FALSE
         ORDER BY name ASC`,
      [auth.subaccount_id]
    );

    const clients = clientsResult.rows;
    const clientIds = clients.map(c => c.id);

    let tasksByClient = {};
    if (clientIds.length > 0) {
      const tasksResult = await db.query(
        `SELECT client_id, task_key, done_date, done_by, note, updated_at
           FROM litbiz_sop_task_state
           WHERE client_id = ANY($1::uuid[])`,
        [clientIds]
      );
      for (const row of tasksResult.rows) {
        if (!tasksByClient[row.client_id]) tasksByClient[row.client_id] = {};
        tasksByClient[row.client_id][row.task_key] = {
          done_date: row.done_date,
          done_by: row.done_by,
          note: row.note,
          updated_at: row.updated_at
        };
      }
    }

    const clientsWithTasks = clients.map(c => ({
      id: c.id,
      name: c.name,
      services: c.services || [],
      report_due_day: c.report_due_day,
      created_at: c.created_at,
      updated_at: c.updated_at,
      tasks: tasksByClient[c.id] || {}
    }));

    return res.status(200).json({
      clients: clientsWithTasks
    });
  } catch (e) {
    console.error('sop-data error:', e.message);
    return res.status(500).json({ error: 'sop_data_failed' });
  }
}

exports.handler = wrap(handler);
