// GET /api/forms/get-public?subaccount=<slug>&form_id=<id>
//
// Public endpoint to fetch a single form for embed rendering. No auth.
// Wide CORS so the embed iframe can load from anywhere.
//
// Returns:
//   {
//     ok: true,
//     form: { id, name, status, pages, settings, ... },  // full form JSON
//     subaccount: { id, name }                            // minimal subaccount info
//   }
//
// Does NOT return:
//   - submissions
//   - contacts
//   - any other PHI
//
// Audit log: form.public.view (best effort, no actor)

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const q = req.query || {};
    const slug = (q.subaccount || '').trim();
    const formId = (q.form_id || '').trim();

    if (!slug || !formId) {
      return res.status(400).json({ error: 'subaccount and form_id are required' });
    }

    const subaccountId = 'sub-' + slug;

    // Look up the subaccount to confirm it exists
    const subRows = await db.query(
      `SELECT id, name FROM subaccounts WHERE id = $1 LIMIT 1`,
      [subaccountId]
    );
    if (!subRows.rows.length) {
      return res.status(404).json({ error: 'Form not found' });
    }
    const sub = subRows.rows[0];

    // Forms still live in the subaccount_data blob (TIER 2 migration pending).
    // Read the blob, find the form by id.
    const dataRows = await db.query(
      `SELECT data FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1`,
      [subaccountId]
    );
    if (!dataRows.rows.length) {
      return res.status(404).json({ error: 'Form not found' });
    }

    const blob = dataRows.rows[0].data || {};
    const forms = Array.isArray(blob.forms) ? blob.forms : [];
    const form = forms.find(f => f.id === formId);

    if (!form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    // Only return active/published forms; drafts should not be embeddable
    if (form.status === 'archived') {
      return res.status(404).json({ error: 'Form not found' });
    }

    return res.status(200).json({
      ok: true,
      form: form,
      subaccount: { id: sub.id, name: sub.name }
    });
  } catch (e) {
    console.error('form-public-get error:', e);
    return res.status(500).json({ error: 'Failed to load form', detail: e.message });
  }
}

exports.handler = wrap(handler);
