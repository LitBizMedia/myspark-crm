// POST /api/forms/submit
//
// Public endpoint for form submissions from embedded forms. No auth, wide CORS.
// Sends notification email to staff if notifyEmail is configured on the form.
//
// Body shape:
//   {
//     subaccount_id: 'sub-litbiz',
//     form_id: 'form-xxx',
//     form_name: 'Contact Us',
//     notify_email: 'staff@example.com',  // from form.settings.notifyEmail
//     submission_data: { first_name: 'Jane', email: 'jane@x.com', ... },
//     page_url: 'https://embed-site.com/contact',
//     honeypot: ''  // bot trap; must be empty
//   }
//
// Returns: { ok: true, submission_id: '...', notification_sent: true }
//
// Note: contact auto-create + identity match cascade is handled separately
// (Stage 3 of the form builder work). This Lambda focuses on notification only.

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const FALLBACK_DOMAIN = 'mysparkplus.app';
const SES_REGION = process.env.AWS_REGION || 'us-east-2';
const ses = new SESv2Client({ region: SES_REGION });

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtFieldValue(val) {
  if (val == null || val === '') return '<em style="color:#999">empty</em>';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'object') return '<pre style="margin:0">' + esc(JSON.stringify(val, null, 2)) + '</pre>';
  return esc(String(val));
}

function fmtFieldKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildEmailHtml(formName, submissionData, pageUrl, submittedAt) {
  const rows = Object.keys(submissionData)
    .filter(k => k !== '_hp')
    .map(key => `
      <tr>
        <td style="padding:8px 14px;background:#f6f6f9;font-size:13px;font-weight:600;color:#444;border-bottom:1px solid #e8e8ee;width:35%;vertical-align:top">${esc(fmtFieldKey(key))}</td>
        <td style="padding:8px 14px;font-size:14px;color:#111;border-bottom:1px solid #e8e8ee;vertical-align:top">${fmtFieldValue(submissionData[key])}</td>
      </tr>
    `).join('');

  return `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">
      <div style="max-width:640px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
        <div style="background:#6b21ea;color:#fff;padding:20px 24px">
          <div style="font-size:13px;opacity:.85;text-transform:uppercase;letter-spacing:.05em;font-weight:600">New Form Submission</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(formName)}</div>
        </div>
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        <div style="padding:16px 24px;background:#fafafd;font-size:12px;color:#666;border-top:1px solid #e8e8ee">
          <div><strong>Submitted at:</strong> ${esc(submittedAt)}</div>
          ${pageUrl ? `<div style="margin-top:4px"><strong>Page URL:</strong> ${esc(pageUrl)}</div>` : ''}
        </div>
      </div>
      <div style="text-align:center;font-size:11px;color:#999;padding:12px">Sent by MySpark+ Forms</div>
    </body></html>
  `;
}

function buildEmailText(formName, submissionData, pageUrl, submittedAt) {
  const lines = [
    'New form submission: ' + formName,
    '',
    ...Object.keys(submissionData)
      .filter(k => k !== '_hp')
      .map(k => fmtFieldKey(k) + ': ' + (submissionData[k] == null || submissionData[k] === '' ? '(empty)' : String(submissionData[k]))),
    '',
    'Submitted at: ' + submittedAt
  ];
  if (pageUrl) lines.push('Page URL: ' + pageUrl);
  return lines.join('\n');
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const b = req.body || {};

    // Honeypot bot trap
    if (b.honeypot) {
      // Pretend success to confuse the bot, don't actually do anything
      return res.status(200).json({ ok: true, submission_id: 'hp-' + Date.now() });
    }

    const subaccountId = b.subaccount_id;
    const formId = b.form_id;
    const formName = b.form_name || 'Form';
    const notifyEmail = (b.notify_email || '').trim();
    const submissionData = b.submission_data || {};
    const pageUrl = b.page_url || '';

    if (!subaccountId || !formId) {
      return res.status(400).json({ error: 'subaccount_id and form_id are required' });
    }

    const submissionId = 'fsub-' + Math.random().toString(36).slice(2, 14);
    const submittedAt = new Date().toISOString();
    let notificationSent = false;
    let notificationError = null;

    // Send notification email if configured
    if (notifyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
      try {
        // Look up the subaccount's verified domain if any, for branded From
        let fromDomain = FALLBACK_DOMAIN;
        try {
          const domainRow = await db.query(
            `SELECT domain FROM subaccount_email_domains WHERE subaccount_id = $1 AND status = 'verified' LIMIT 1`,
            [subaccountId]
          );
          if (domainRow.rows.length && domainRow.rows[0].domain) {
            fromDomain = domainRow.rows[0].domain;
          }
        } catch (e) {
          console.warn('domain lookup failed, using fallback:', e.message);
        }

        const fromEmail = 'noreply@' + fromDomain;
        const fromName = 'MySpark+ Forms';

        await ses.send(new SendEmailCommand({
          FromEmailAddress: fromName + ' <' + fromEmail + '>',
          Destination: { ToAddresses: [notifyEmail] },
          Content: {
            Simple: {
              Subject: { Data: 'New form submission: ' + formName },
              Body: {
                Html: { Data: buildEmailHtml(formName, submissionData, pageUrl, submittedAt) },
                Text: { Data: buildEmailText(formName, submissionData, pageUrl, submittedAt) }
              }
            }
          }
        }));

        notificationSent = true;
      } catch (e) {
        console.error('SES send failed:', e.message);
        notificationError = e.message;
      }
    }

    // Audit log (best effort; don't fail the whole request if it fails)
    try {
      const auditId = 'log_' + Math.random().toString(36).slice(2, 14);
      await db.query(
        `INSERT INTO audit_log
          (id, subaccount_id, actor_type, actor_id, actor_username, action, target_type, target_id, target_subaccount_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [
          auditId,
          subaccountId,
          'public',
          null,
          'public-form',
          'subaccount.form.submit',
          'form',
          formId,
          subaccountId,
          JSON.stringify({
            form_name: formName,
            submission_id: submissionId,
            notification_sent: notificationSent,
            notification_email: notifyEmail || null,
            page_url: pageUrl || null,
            field_count: Object.keys(submissionData).filter(k => k !== '_hp').length
          })
        ]
      );
    } catch (e) {
      console.warn('audit log failed:', e.message);
    }

    return res.status(200).json({
      ok: true,
      submission_id: submissionId,
      notification_sent: notificationSent,
      notification_error: notificationError
    });
  } catch (e) {
    console.error('form-submit error:', e);
    return res.status(500).json({ error: 'Failed to process submission', detail: e.message });
  }
}

exports.handler = wrap(handler);
