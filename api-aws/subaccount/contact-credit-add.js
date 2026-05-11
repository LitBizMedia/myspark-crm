// POST /api/subaccount/contact-credit-add
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

const ALLOWED_TYPES = ['credit', 'debit', 'refund', 'adjustment'];

function uid() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const contactId = b.contact_id;
    const type = b.type;
    const rawAmount = Number(b.amount);
    const reason = b.reason ? String(b.reason).trim() : null;
    const paymentId = b.payment_id || null;

    if (!contactId) return res.status(400).json({ error: 'contact_id is required' });
    if (!ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: 'type must be one of credit, debit, refund, adjustment' });
    }
    if (!isFinite(rawAmount) || rawAmount === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }

    let signedAmount;
    if (type === 'credit' || type === 'refund') signedAmount = Math.abs(rawAmount);
    else if (type === 'debit') signedAmount = -Math.abs(rawAmount);
    else signedAmount = rawAmount;

    signedAmount = Math.round(signedAmount * 100) / 100;

    const id = uid();

    const result = await db.transaction(async (client) => {
      const c = await client.query(
        `SELECT id, credit_balance FROM contacts WHERE id = $1 AND subaccount_id = $2 FOR UPDATE`,
        [contactId, auth.subaccount_id]
      );
      if (!c.rows.length) return null;

      const oldBalance = Number(c.rows[0].credit_balance);
      const newBalance = Math.round((oldBalance + signedAmount) * 100) / 100;

      if (type === 'debit' && newBalance < 0) {
        throw new Error('INSUFFICIENT_CREDIT');
      }

      await client.query(
        `INSERT INTO contact_credit_log (id, contact_id, subaccount_id, amount, type, reason, payment_id, balance_after, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
        [id, contactId, auth.subaccount_id, signedAmount, type, reason, paymentId, newBalance, auth.user_id]
      );

      await client.query(
        `UPDATE contacts SET credit_balance = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3`,
        [newBalance, auth.user_id, contactId]
      );

      return { newBalance };
    });

    if (!result) return res.status(404).json({ error: 'Contact not found' });

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: 'subaccount.contact_credit.add',
      targetType: 'contact_credit_log', targetId: id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { contact_id: contactId, type, amount: signedAmount, payment_id: paymentId, new_balance: result.newBalance }
    });

    return res.status(200).json({
      success: true,
      id,
      entry: {
        id, contact_id: contactId, amount: signedAmount, type, reason,
        payment_id: paymentId, balance_after: result.newBalance,
        created_at: new Date().toISOString()
      },
      new_balance: result.newBalance
    });
  } catch (e) {
    if (e.message === 'INSUFFICIENT_CREDIT') {
      return res.status(400).json({ error: 'Debit would result in negative balance' });
    }
    console.error('contact-credit-add error:', e.message);
    return res.status(500).json({ error: 'Failed to add credit entry' });
  }
}
exports.handler = wrap(handler);
