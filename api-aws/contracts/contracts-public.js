// api-aws/contracts/contracts-public.js
//
// Public-facing Lambda for the contract signing flow.
// No auth, wide-open CORS. Dispatches three endpoints by URL path.
//
// Routes:
//   GET  /api/contracts/public/get             load envelope (sanitized)
//   POST /api/contracts/public/verify-email    send or verify email code
//   POST /api/contracts/public/sign            record signature
//
// See docs/MySpark-Contracts-Spec.md (Stage 4)

const crypto = require('crypto');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');
const tokens = require('./lib/contract-tokens');
const mailgun = require('./lib/mailgun');
const contractPdf = require('./lib/contract-pdf');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const CONTRACTS_BUCKET = 'myspark-contracts';
const KMS_KEY_ARN = 'arn:aws:kms:us-east-2:993939946677:key/559c69e7-115b-41fb-b0c0-1080e04f3df1';
const s3Client = new S3Client({ region: 'us-east-2' });

const CODE_EXPIRY_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;

// ----- Helpers -----

function maskEmail(email){
  if(!email || typeof email !== 'string') return '';
  var at = email.indexOf('@');
  if(at < 2) return email;
  var local = email.slice(0, at);
  var domain = email.slice(at);
  if(local.length <= 2) return local[0] + '***' + domain;
  return local[0] + '***' + local[local.length - 1] + domain;
}

function formatDate(d){
  if(!d) return '';
  var dt = d instanceof Date ? d : new Date(d);
  if(isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
         ' at ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function generateCode(){
  // 6 digit zero-padded
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function hashCode(code){
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function timingSafeStrEq(a, b){
  if(a == null || b == null) return false;
  var ab = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if(ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getClientIp(req){
  var h = req.headers || {};
  var fwd = h['x-forwarded-for'] || h['X-Forwarded-For'] || '';
  if(fwd && typeof fwd === 'string') return fwd.split(',')[0].trim();
  return null;
}

function getUserAgent(req){
  var h = req.headers || {};
  return h['user-agent'] || h['User-Agent'] || null;
}

// Sub slug from subaccount_id ("sub-xxx" -> "xxx")
function slugFromSubaccountId(id){
  return String(id || '').replace(/^sub-/, '');
}

async function fetchEnvelopeAndValidateToken(envelopeId, token){
  if(!envelopeId || !token) return { error: 'Invalid link.' };
  var payload = await tokens.verifyToken(token);
  if(!payload || payload.envelopeId !== envelopeId){
    return { error: 'This link is no longer valid.' };
  }
  var tokenHash = tokens.hashToken(token);
  var r = await db.query(
    `SELECT * FROM contract_envelopes WHERE id = $1 AND token_hash = $2 LIMIT 1`,
    [envelopeId, tokenHash]
  );
  var env = r.rows[0];
  if(!env) return { error: 'This link is no longer valid.' };
  if(env.status === 'voided') return { error: 'This document has been withdrawn.' };
  if(env.status === 'signed') return { error: 'This document has already been signed.' };
  if(env.status === 'expired') return { error: 'This document has expired.' };
  if(env.expires_at && new Date(env.expires_at) < new Date()){
    return { error: 'This document has expired.' };
  }
  return { envelope: env };
}

async function fetchSubaccountSummary(subaccountId){
  var r = await db.query(
    `SELECT id, slug, name, admin_email, settings FROM subaccounts WHERE id = $1`,
    [subaccountId]
  );
  return r.rows[0] || null;
}

// ----- GET endpoint -----

async function handleGet(req, res){
  var q = req.query || {};
  var envelopeId = q.envelope_id;
  var token = q.token;

  var v = await fetchEnvelopeAndValidateToken(envelopeId, token);
  if(v.error) return res.status(400).json({ error: v.error });
  var env = v.envelope;

  // Mark as viewed on first fetch
  var isFirstView = !env.first_viewed_at;
  await db.query(
    `UPDATE contract_envelopes
       SET first_viewed_at = COALESCE(first_viewed_at, NOW()),
           last_viewed_at  = NOW(),
           view_count      = view_count + 1,
           status          = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
       WHERE id = $1`,
    [envelopeId]
  );

  // Subaccount for branding
  var sub = await fetchSubaccountSummary(env.subaccount_id);

  await logAudit({
    req,
    actorType: 'public',
    actorId: env.contact_id,
    actorUsername: env.recipient_email,
    action: isFirstView ? 'contract.public.first_view' : 'contract.public.view',
    targetType: 'contract_envelope',
    targetId: envelopeId,
    targetSubaccountId: env.subaccount_id,
    metadata: {
      ip: getClientIp(req),
      user_agent: getUserAgent(req)
    }
  });

  var requireVerify = env.require_email_verification === true;

  // Sanitized response. body_html only included if email verification NOT required.
  var response = {
    envelope: {
      id: env.id,
      title: env.title,
      status: env.status === 'sent' ? 'viewed' : env.status,
      expires_at: env.expires_at,
      expires_at_formatted: formatDate(env.expires_at),
      recipient_email_masked: maskEmail(env.recipient_email),
      subaccount_name: sub ? sub.name : '',
      require_email_verification: requireVerify
    }
  };

  if (!requireVerify) {
    response.envelope.body_html = env.body_html;
    response.envelope.agree_text = env.agree_text;
  }

  return res.status(200).json(response);
}

// ----- POST verify-email endpoint -----

async function handleVerifyEmail(req, res){
  var body = req.body || {};
  var envelopeId = body.envelope_id;
  var token = body.token;
  var action = body.action;

  var v = await fetchEnvelopeAndValidateToken(envelopeId, token);
  if(v.error) return res.status(400).json({ error: v.error });
  var env = v.envelope;

  if(action === 'send_code'){
    return await sendVerificationCode(req, res, env);
  }
  if(action === 'verify_code'){
    return await verifyCode(req, res, env, body.code);
  }
  return res.status(400).json({ error: 'Invalid action.' });
}

async function sendVerificationCode(req, res, env){
  var code = generateCode();
  var codeHash = hashCode(code);
  var expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  await db.query(
    `UPDATE contract_envelopes
       SET email_verification_code_hash = $1,
           email_verification_expires_at = $2,
           email_verification_attempts = 0
       WHERE id = $3`,
    [codeHash, expiresAt, env.id]
  );

  var sub = await fetchSubaccountSummary(env.subaccount_id);
  var slug = sub ? sub.slug : slugFromSubaccountId(env.subaccount_id);
  var subSettings = (sub && sub.settings) || {};
  var businessName = subSettings.businessName || subSettings.business_name || (sub && sub.name) || 'MySpark+';

  // Send via Mailgun. Inline subject/html because this is a one-shot transactional code email.
  var subject = 'Your signing code: ' + code;
  var html = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:24px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">' +
    '<tr><td align="center"><table cellpadding="0" cellspacing="0" border="0" width="480" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">' +
      '<tr><td style="padding:24px 32px;background:#6b21ea;color:#ffffff"><div style="font-size:18px;font-weight:700">' + businessName + '</div></td></tr>' +
      '<tr><td style="padding:28px 32px">' +
        '<h1 style="margin:0 0 12px;font-size:18px;color:#1a1030">Your signing verification code</h1>' +
        '<p style="margin:0 0 20px;color:#5a4d7a;font-size:14px;line-height:1.6">Use this code to access the document <strong>' + env.title.replace(/[<>&"']/g, '') + '</strong>.</p>' +
        '<div style="font-family:Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#1a1030;background:#f3f0fa;border:1px solid #d1c4f5;border-radius:8px;padding:18px;text-align:center;margin:0 0 20px">' + code + '</div>' +
        '<p style="margin:0;font-size:12px;color:#9ca3af">This code expires in ' + CODE_EXPIRY_MINUTES + ' minutes. If you did not request this, you can ignore this email.</p>' +
      '</td></tr>' +
    '</table></td></tr></table>';

  var sendResult;
  try {
    sendResult = await mailgun.sendEmail(slug, {
      scope: 'subaccount',
      to: env.recipient_email,
      contactId: env.contact_id,
      subject: subject,
      html: html
    });
  } catch(e){
    console.error('verification code send error:', e);
    sendResult = { ok: false, error: e.message };
  }

  if(!sendResult || !sendResult.ok){
    return res.status(502).json({ error: 'Could not send verification code. Please try again.' });
  }

  await logAudit({
    req,
    actorType: 'public',
    actorId: env.contact_id,
    actorUsername: env.recipient_email,
    action: 'contract.public.email_verify_sent',
    targetType: 'contract_envelope',
    targetId: env.id,
    targetSubaccountId: env.subaccount_id,
    metadata: { ip: getClientIp(req) }
  });

  return res.status(200).json({ ok: true });
}

async function verifyCode(req, res, env, providedCode){
  if(!providedCode || typeof providedCode !== 'string'){
    return res.status(400).json({ error: 'Code is required.' });
  }

  // Re-fetch fresh state (attempt count etc)
  var fresh = await db.query(`SELECT * FROM contract_envelopes WHERE id = $1`, [env.id]);
  env = fresh.rows[0];

  if(!env.email_verification_code_hash || !env.email_verification_expires_at){
    return res.status(400).json({ error: 'Please request a code first.' });
  }
  if(env.email_verification_attempts >= MAX_VERIFY_ATTEMPTS){
    return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
  }
  if(new Date(env.email_verification_expires_at) < new Date()){
    return res.status(400).json({ error: 'This code has expired. Please request a new one.' });
  }

  var providedHash = hashCode(providedCode.trim());
  var match = timingSafeStrEq(providedHash, env.email_verification_code_hash);

  if(!match){
    await db.query(
      `UPDATE contract_envelopes
         SET email_verification_attempts = email_verification_attempts + 1
         WHERE id = $1`,
      [env.id]
    );
    await logAudit({
      req,
      actorType: 'public',
      actorId: env.contact_id,
      actorUsername: env.recipient_email,
      action: 'contract.public.email_verify_failed',
      targetType: 'contract_envelope',
      targetId: env.id,
      targetSubaccountId: env.subaccount_id,
      metadata: { attempts: (env.email_verification_attempts || 0) + 1, ip: getClientIp(req) }
    });
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }

  // Mark verified, clear code so it cannot be reused
  await db.query(
    `UPDATE contract_envelopes
       SET email_verified_at = NOW(),
           email_verification_code_hash = NULL,
           email_verification_expires_at = NULL
       WHERE id = $1`,
    [env.id]
  );

  var sub = await fetchSubaccountSummary(env.subaccount_id);

  await logAudit({
    req,
    actorType: 'public',
    actorId: env.contact_id,
    actorUsername: env.recipient_email,
    action: 'contract.public.email_verify_success',
    targetType: 'contract_envelope',
    targetId: env.id,
    targetSubaccountId: env.subaccount_id,
    metadata: { ip: getClientIp(req) }
  });

  // Now return the full envelope with body_html
  return res.status(200).json({
    ok: true,
    envelope: {
      id: env.id,
      title: env.title,
      body_html: env.body_html,
      agree_text: env.agree_text,
      expires_at: env.expires_at,
      expires_at_formatted: formatDate(env.expires_at),
      subaccount_name: sub ? sub.name : ''
    }
  });
}

// ----- POST sign endpoint -----

async function handleSign(req, res){
  var body = req.body || {};
  var envelopeId = body.envelope_id;
  var token = body.token;
  var typedName = (body.typed_name || '').toString().trim();
  var agreed = !!body.agreed;

  if(!typedName){
    return res.status(400).json({ error: 'Typed name is required.' });
  }
  if(typedName.length > 200){
    return res.status(400).json({ error: 'Typed name is too long.' });
  }
  if(!agreed){
    return res.status(400).json({ error: 'You must agree to electronically sign.' });
  }

  var v = await fetchEnvelopeAndValidateToken(envelopeId, token);
  if(v.error) return res.status(400).json({ error: v.error });
  var env = v.envelope;

  if(env.require_email_verification === true && !env.email_verified_at){
    return res.status(403).json({ error: 'Please verify your email first.' });
  }

  var ip = getClientIp(req);
  var ua = getUserAgent(req);
  var signedAt = new Date();

  // Fetch supporting data needed for the PDF
  var sub = await fetchSubaccountSummary(env.subaccount_id);
  var businessName = (sub && sub.settings && (sub.settings.businessName || sub.settings.business_name)) || (sub && sub.name) || 'Document';

  // Generate PDF
  var s3Key = null;
  var pdfSha256 = null;
  var pdfResult = null;
  try {
    pdfResult = await contractPdf.generateContractPdf({
      envelopeId: env.id,
      title: env.title,
      businessName: businessName,
      recipientName: env.recipient_name,
      recipientEmail: env.recipient_email,
      senderName: env.sender_name,
      sentAt: env.sent_at,
      signedAt: signedAt,
      signedTypedName: typedName,
      signedIp: ip,
      signedUserAgent: ua,
      agreeText: env.agree_text,
      bodyHtml: env.body_html
    });

    // Upload to S3 with KMS encryption
    var year = signedAt.getUTCFullYear();
    s3Key = env.subaccount_id + '/' + year + '/' + env.id + '/signed.pdf';
    await s3Client.send(new PutObjectCommand({
      Bucket: CONTRACTS_BUCKET,
      Key: s3Key,
      Body: pdfResult.buffer,
      ContentType: 'application/pdf',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ARN,
      Metadata: {
        envelope_id: env.id,
        sha256: pdfResult.sha256,
        signed_at: signedAt.toISOString()
      }
    }));
    pdfSha256 = pdfResult.sha256;
  } catch (e) {
    console.error('PDF generation/upload failed (non-fatal, envelope still signs):', e);
    // Don't block signing on PDF failure. Envelope still flips to signed.
    // Admin can regenerate from dashboard later (Stage 5 feature).
  }

  await db.query(
    `UPDATE contract_envelopes
       SET status = 'signed',
           signed_at = $1,
           signed_typed_name = $2,
           signed_ip = $3,
           signed_user_agent = $4,
           signed_pdf_s3_key = $5,
           signed_pdf_sha256 = $6
       WHERE id = $7
         AND status IN ('sent', 'viewed')`,
    [signedAt, typedName, ip, ua, s3Key, pdfSha256, env.id]
  );

  // Bump template sign_count
  if(env.template_id){
    await db.query(
      `UPDATE contract_templates SET sign_count = sign_count + 1
         WHERE subaccount_id = $1 AND id = $2`,
      [env.subaccount_id, env.template_id]
    ).catch(e => console.warn('sign_count bump failed:', e.message));
  }

  // Audit
  await logAudit({
    req,
    actorType: 'public',
    actorId: env.contact_id,
    actorUsername: env.recipient_email,
    action: 'contract.public.sign',
    targetType: 'contract_envelope',
    targetId: env.id,
    targetSubaccountId: env.subaccount_id,
    metadata: {
      typed_name: typedName,
      ip: ip,
      user_agent: ua
    }
  });

  // Email receipt to signer with PDF attachment
  try {
    var subForReceipt = await fetchSubaccountSummary(env.subaccount_id);
    var slugForReceipt = subForReceipt ? subForReceipt.slug : slugFromSubaccountId(env.subaccount_id);
    var businessNameForReceipt = (subForReceipt && subForReceipt.name) || 'MySpark+';
    var safeTitle = String(env.title || '').replace(/[<>&"']/g, '');
    var subject = 'Signed: ' + env.title;
    var html =
      '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:24px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">' +
      '<tr><td align="center"><table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">' +
        '<tr><td style="padding:24px 32px;background:#10b981;color:#ffffff">' +
          '<div style="font-size:14px;opacity:.85;margin-bottom:4px">Signed and confirmed</div>' +
          '<div style="font-size:20px;font-weight:700">' + safeTitle + '</div>' +
        '</td></tr>' +
        '<tr><td style="padding:28px 32px">' +
          '<p style="margin:0 0 16px;color:#1a1030;font-size:14px;line-height:1.6">Thank you for signing <strong>' + safeTitle + '</strong> with ' + businessNameForReceipt + '.</p>' +
          '<p style="margin:0 0 20px;color:#5a4d7a;font-size:14px;line-height:1.6">Signed on <strong>' + formatDate(signedAt) + '</strong>.</p>' +
          (pdfSha256 ? '<p style="margin:0 0 16px;color:#5a4d7a;font-size:13px;line-height:1.6">A signed PDF copy is attached to this email for your records.</p>' : '<p style="margin:0 0 16px;color:#5a4d7a;font-size:13px;line-height:1.6">Your signed copy is stored securely with ' + businessNameForReceipt + '.</p>') +
          '<p style="margin:0;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:18px">Document ID: <code style="font-family:Menlo,monospace;font-size:11px">' + env.id + '</code></p>' +
        '</td></tr>' +
      '</table></td></tr></table>';

    var emailOpts = {
      scope: 'subaccount',
      to: env.recipient_email,
      contactId: env.contact_id,
      subject: subject,
      html: html
    };

    // Attach PDF if generation succeeded
    if (pdfResult && pdfResult.buffer) {
      emailOpts.attachments = [{
        filename: 'signed-contract.pdf',
        content: pdfResult.buffer,
        contentType: 'application/pdf'
      }];
    }

    await mailgun.sendEmail(slugForReceipt, emailOpts)
      .catch(e => console.warn('receipt email failed (non-fatal):', e.message));
  } catch(e){
    console.warn('post-sign email block failed:', e.message);
  }

  // Generate presigned download URL (7-day expiry, generous for email links)
  var downloadUrl = null;
  if (s3Key) {
    try {
      downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: CONTRACTS_BUCKET,
        Key: s3Key
      }), { expiresIn: 7 * 24 * 60 * 60 });
    } catch (e) {
      console.warn('presigned URL generation failed:', e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    signed_at: signedAt.toISOString(),
    signed_at_formatted: formatDate(signedAt),
    pdf_download_url: downloadUrl
  });
}

// ----- GET verify endpoint -----

async function handleVerify(req, res){
  var q = req.query || {};
  var envelopeId = q.envelope_id;
  if (!envelopeId) return res.status(400).json({ error: 'envelope_id required' });

  var r = await db.query(
    `SELECT id, status, signed_at, signed_typed_name, signed_pdf_sha256, recipient_email, title, subaccount_id
       FROM contract_envelopes WHERE id = $1`,
    [envelopeId]
  );
  var env = r.rows[0];
  if (!env) return res.status(404).json({ error: 'Document not found' });
  if (env.status !== 'signed') {
    return res.status(400).json({ error: 'This document has not been signed.', status: env.status });
  }

  var sub = await fetchSubaccountSummary(env.subaccount_id);

  return res.status(200).json({
    envelope_id: env.id,
    title: env.title,
    status: env.status,
    signed_at: env.signed_at,
    signed_at_formatted: formatDate(env.signed_at),
    signed_typed_name: env.signed_typed_name,
    pdf_sha256: env.signed_pdf_sha256,
    business_name: sub ? sub.name : '',
    instructions: 'Compute SHA-256 of your downloaded PDF and compare to pdf_sha256. If they match, the document is unaltered.'
  });
}

// ----- Router -----

async function handler(req, res){
  var method = (req.method || '').toUpperCase();
  if(method === 'OPTIONS') return res.status(204).end();

  var path = (req.url || '').split('?')[0];

  try {
    if(method === 'GET' && path.endsWith('/get')){
      return await handleGet(req, res);
    }
    if(method === 'POST' && path.endsWith('/verify-email')){
      return await handleVerifyEmail(req, res);
    }
    if(method === 'POST' && path.endsWith('/sign')){
      return await handleSign(req, res);
    }
    if(method === 'GET' && path.endsWith('/verify')){
      return await handleVerify(req, res);
    }
    return res.status(404).json({ error: 'Not found' });
  } catch(e){
    console.error('contracts-public error:', e);
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}

exports.handler = wrap(handler);
