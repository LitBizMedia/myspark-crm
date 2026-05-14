// api/email/ses-inbound.js (Lambda)
//
// Triggered by SNS topic 'myspark-ses-inbound' when SES receives an email
// matching a receipt rule. The SNS message contains metadata + reference
// to the S3 object containing the raw email.
//
// Flow:
//   1. Parse SNS message → SES inbound notification
//   2. Extract recipient(s) to find reply+TOKEN@ address
//   3. Look up conversation by reply_token
//   4. Fetch raw email from S3
//   5. Parse email body (text + html)
//   6. Insert conversation_messages row (direction='inbound')
//   7. Update conversation aggregates
//   8. Or log to inbound_unmatched if no match

const db = require('./lib/db');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const simpleParser = require('mailparser').simpleParser;

// Wrap a Message-ID with <...> if not already wrapped. Used to keep stored
// Message-IDs consistent across inbound and outbound (RFC 5322 format).
function wrapMid(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  if (s[0] === '<' && s[s.length - 1] === '>') return s;
  return '<' + s + '>';
}

const S3_REGION = process.env.AWS_REGION || 'us-east-2';
const s3Client = new S3Client({ region: S3_REGION });

const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);

// Find a reply+TOKEN@<anything> address in the recipients array
function extractReplyToken(recipients) {
  if (!Array.isArray(recipients)) return null;
  for (const addr of recipients) {
    if (!addr || typeof addr !== 'string') continue;
    const m = addr.match(/reply\+([a-f0-9]{32})@/i);
    if (m) return { token: m[1].toLowerCase(), address: addr };
  }
  return null;
}

// Stream-to-string helper for S3 GetObject response body
async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function fetchRawEmail(bucket, key) {
  try {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const res = await s3Client.send(cmd);
    return await streamToString(res.Body);
  } catch (e) {
    console.error('S3 fetch error:', e.message);
    return null;
  }
}

async function logUnmatched(toAddr, fromAddr, subject, payload, reason) {
  try {
    await db.insertOne('inbound_unmatched', {
      to_address: toAddr || null,
      from_address: fromAddr || null,
      subject: subject || null,
      raw_payload: payload || {},
      reason: reason || 'unknown'
    });
  } catch (e) {
    console.error('logUnmatched error:', e.message);
  }
}

async function processInboundNotification(notification) {
  // SES inbound notification structure:
  // {
  //   notificationType: 'Received',
  //   receipt: { recipients, action: { type, bucketName, objectKey, topicArn }, ... },
  //   mail: { source, destination, commonHeaders, messageId, timestamp, ... },
  // }

  const mail = notification.mail || {};
  const receipt = notification.receipt || {};
  const recipients = receipt.recipients || mail.destination || [];
  const fromAddr = mail.source || (mail.commonHeaders && mail.commonHeaders.from && mail.commonHeaders.from[0]) || '';
  const subject = (mail.commonHeaders && mail.commonHeaders.subject) || '';
  const externalMessageId = mail.messageId || null;
  const receivedAt = mail.timestamp || new Date().toISOString();

  // Extract reply token
  const tokenMatch = extractReplyToken(recipients);
  if (!tokenMatch) {
    console.log('No reply token in recipients:', recipients.join(','));
    await logUnmatched(recipients.join(','), fromAddr, subject, notification, 'no_token_in_address');
    return;
  }

  // Look up conversation
  let conv;
  try {
    conv = await db.findOne('conversations',
      { reply_token: tokenMatch.token },
      { select: 'id, subaccount_id, contact_id, channel, status, unread_count' }
    );
  } catch (e) {
    console.error('Conversation lookup error:', e.message);
    await logUnmatched(tokenMatch.address, fromAddr, subject, notification, 'lookup_error');
    return;
  }

  if (!conv) {
    console.log('No conversation matched token:', tokenMatch.token);
    await logUnmatched(tokenMatch.address, fromAddr, subject, notification, 'token_not_found');
    return;
  }

  // Fetch raw email from S3.
  // The receipt.action in the SNS payload describes the SNS action itself.
  // S3 action runs first; we construct the key from mail.messageId.
  // Bucket comes from env var (set at provision time).
  const bucket = process.env.INBOUND_BUCKET;
  const key = mail.messageId ? ('inbound/' + mail.messageId) : null;
  let bodyText = null;
  let bodyHtml = null;
  let inReplyToHeader = null;

  if (bucket && key) {
    console.log('Fetching raw email from s3://' + bucket + '/' + key);
    const rawEmail = await fetchRawEmail(bucket, key);
    if (rawEmail) {
      try {
        const parsed = await simpleParser(rawEmail);
        bodyText = parsed.text || null;
        bodyHtml = parsed.html || null;
        // Capture In-Reply-To header for threading. mailparser returns this as
        // either a string or an array; normalize to first value.
        if (parsed.inReplyTo) {
          inReplyToHeader = Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo[0] : parsed.inReplyTo;
        }
      } catch (e) {
        console.error('Email parse error:', e.message);
      }
    } else {
      console.warn('Raw email empty from S3: ' + key);
    }
  } else {
    console.warn('No S3 location available; bucket=' + bucket + ' key=' + key);
  }

  // Insert inbound message
  const msgId = 'msg_' + uid();
  try {
    await db.insertOne('conversation_messages', {
      id: msgId,
      conversation_id: conv.id,
      subaccount_id: conv.subaccount_id,
      direction: 'inbound',
      channel: 'email',
      source: 'manual',
      from_address: fromAddr,
      to_address: tokenMatch.address,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      external_id: externalMessageId,
      external_message_id: wrapMid(externalMessageId),
      in_reply_to: wrapMid(inReplyToHeader),
      status: 'received',
      sent_at: receivedAt
    });
  } catch (e) {
    console.error('Inbound message insert error:', e.message);
    await logUnmatched(tokenMatch.address, fromAddr, subject, notification, 'insert_error');
    return;
  }

  // Update conversation aggregates
  const now = new Date().toISOString();
  const preview = (bodyText || subject || '').slice(0, 140);
  const updates = {
    last_message_at: now,
    last_inbound_message_at: now,
    last_message_preview: preview,
    last_message_direction: 'inbound',
    unread_count: (conv.unread_count || 0) + 1,
    updated_at: now
  };
  if (conv.status === 'closed' || conv.status === 'archived') {
    updates.status = 'open';
  }
  try {
    await db.update('conversations', updates, { id: conv.id });
  } catch (e) {
    console.error('Conversation aggregate update error:', e.message);
  }

  console.log('Inbound message stored: ' + msgId + ' for conv ' + conv.id);
}

exports.handler = async (event, context) => {
  const records = event.Records || [];
  for (const record of records) {
    if (record.EventSource !== 'aws:sns' && record.eventSource !== 'aws:sns') {
      console.warn('Unexpected record source:', record.EventSource || record.eventSource);
      continue;
    }
    const sns = record.Sns || {};
    if (!sns.Message) {
      console.warn('SNS record missing Message');
      continue;
    }
    let notification;
    try {
      notification = JSON.parse(sns.Message);
    } catch (e) {
      console.error('Failed to parse SNS message:', e.message);
      continue;
    }
    if (notification.notificationType !== 'Received') {
      console.log('Skipping non-Received notification:', notification.notificationType);
      continue;
    }
    try {
      await processInboundNotification(notification);
    } catch (e) {
      console.error('Error processing notification:', e.message, e.stack);
    }
  }
  return { ok: true, processed: records.length };
};
