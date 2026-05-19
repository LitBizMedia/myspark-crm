// api-aws/subaccount/contracts-templates.js
//
// REST resource Lambda for contract templates.
// Single Lambda, dispatches on method + id presence.
//
// Routes (one API Gateway route, ANY method):
//   GET    /api/subaccount/contracts/templates           list (no id) or get (?id=)
//   POST   /api/subaccount/contracts/templates           create (no body.id) or update (body.id)
//   DELETE /api/subaccount/contracts/templates           soft delete (?id= or body.id)
//
// See docs/MySpark-Contracts-Spec.md
// Architecture pattern: hybrid (per docs/MySpark-Lambda-Architecture-Handoff.md)

const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const contracts = require('./lib/contracts');

async function handler(req, res) {
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const method = (req.method || '').toUpperCase();

  try {
    if (method === 'GET') {
      const id = (req.query && req.query.id) || null;
      if (id) return handleGet(req, res, auth, id);
      return handleList(req, res, auth);
    }

    if (method === 'POST') {
      const body = req.body || {};
      if (body.id) return handleUpdate(req, res, auth, body);
      return handleCreate(req, res, auth, body);
    }

    if (method === 'DELETE') {
      const id = (req.query && req.query.id) || (req.body && req.body.id) || null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return handleDelete(req, res, auth, id);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    console.error('contracts-templates error:', e);
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}

async function handleList(req, res, auth) {
  const list = await contracts.listTemplates(auth.subaccount_id);
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract_template.list',
    targetType: 'contract_template',
    targetSubaccountId: auth.subaccount_id,
    metadata: { count: list.length }
  });
  return res.status(200).json({ templates: list });
}

async function handleGet(req, res, auth, id) {
  const tmpl = await contracts.getTemplate(auth.subaccount_id, id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract_template.view',
    targetType: 'contract_template',
    targetId: id,
    targetSubaccountId: auth.subaccount_id
  });
  return res.status(200).json({ template: tmpl });
}

async function handleCreate(req, res, auth, body) {
  if (!body.name || !body.bodyHtml) {
    return res.status(400).json({ error: 'name and bodyHtml required' });
  }
  const created = await contracts.createTemplate(auth.subaccount_id, auth.user_id, body);
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract_template.create',
    targetType: 'contract_template',
    targetId: created.id,
    targetSubaccountId: auth.subaccount_id,
    metadata: { name: created.name }
  });
  return res.status(201).json({ template: created });
}

async function handleUpdate(req, res, auth, body) {
  const existing = await contracts.getTemplate(auth.subaccount_id, body.id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  const updated = await contracts.updateTemplate(auth.subaccount_id, body.id, body);
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract_template.update',
    targetType: 'contract_template',
    targetId: body.id,
    targetSubaccountId: auth.subaccount_id,
    metadata: { fields_updated: Object.keys(body).filter(k => k !== 'id') }
  });
  return res.status(200).json({ template: updated });
}

async function handleDelete(req, res, auth, id) {
  const existing = await contracts.getTemplate(auth.subaccount_id, id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  const result = await contracts.deleteTemplate(auth.subaccount_id, id);
  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.contract_template.delete',
    targetType: 'contract_template',
    targetId: id,
    targetSubaccountId: auth.subaccount_id,
    metadata: { name: existing.name, soft_delete: true }
  });
  return res.status(200).json({ deleted: result.deleted, id });
}

exports.handler = wrap(handler);
