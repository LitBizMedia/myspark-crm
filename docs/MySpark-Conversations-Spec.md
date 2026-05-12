# MySpark+ Conversations Specification

Last reviewed: May 12, 2026

This document specifies the Conversations feature for MySpark+. It covers the email and SMS inbox surface, the agency vs subaccount email partition, the data model, public API endpoints, the migration of the existing email_log table, and a 5-stage rollout plan.

When building any future feature that touches Conversations or email/SMS infrastructure, follow this doc. When in doubt, this doc wins.

The principle behind this doc: a clinic's communication with a patient is sacred. Every staff-to-patient message must land in one place, attributable to a contact, threaded for context, and auditable for HIPAA. Agency-to-admin communication is a separate concern and must never bleed into patient inboxes.

## Architecture Principles

### 1. One inbox per subaccount, scoped per contact per channel

Conversations is a subaccount-level surface. Each subaccount sees only its own threads. Threads are uniquely identified by (subaccount_id, contact_id, channel). All email with Jane Doe lives in one thread forever. All SMS with Jane lives in a separate thread. Same contact, different channel, different thread.

This matches GHL and the SMS mental model. It also avoids the "which thread do I reply in" problem that subject-based threading creates.

### 2. Reply-only inbound (Architecture A)

Patients cannot initiate a new conversation TO the CRM via email. They reply to messages the clinic sends. Each outbound message has a unique Reply-To address that routes back to the originating thread. The clinic's primary inbox still handles cold inbound.

Rationale: full inbox support (Gmail OAuth, IMAP, Microsoft Graph) is months of work and not justified by client demand at this stage. Reply-only covers 90% of value at 10% of build cost.

### 3. One source of truth: conversation_messages

The existing email_log table gets migrated and dropped. Every send, every reply, every system email to a contact lands in conversation_messages. Agency emails to admins go to a separate agency_email_log table. No dual writes.

### 4. Agency vs subaccount email partition (critical)

LitBiz Media operates as both the agency (parent platform owner) and as a subaccount (its own marketing agency workspace). These are two distinct email contexts that must not be conflated.

**Agency emails**
- Sender: the agency (LitBiz Media as platform owner)
- Recipient: a subaccount admin, owner, or prospective user (identified by email, optionally by subaccount_users.id)
- Storage: agency_email_log
- Examples: workspace welcome, billing receipts, subscription expiration warnings, password resets to admin users, agency 2FA codes
- NEVER appears in any subaccount's Conversations inbox

**Subaccount emails**
- Sender: a specific subaccount (LitBiz Media's own subaccount, or a clinic)
- Recipient: a contact (patient or lead) of that subaccount
- Storage: conversation_messages, parent conversation
- Examples: appointment reminders, manual staff-to-patient messages, booking widget confirmations, appointment cancellation notices
- ALWAYS appears in the originating subaccount's Conversations

The send-path helper (`lib-aws/email-send.js` or equivalent) takes a required `scope` parameter. Refactor every existing caller to declare scope explicitly. No defaults. Errors on missing scope.

### 5. Per-client custom domain for sending and receiving

Each subaccount must verify their own domain before they can send email through Conversations. No shared fallback domain (e.g. send-from-mysparkplus.app). Sharing the platform's sending reputation across all clinics risks contaminating deliverability for every clinic.

For inbound, each subaccount adds an MX record on a `reply.<theirdomain>.com` subdomain. The subdomain is configurable but defaults to "reply". This keeps their existing mail records untouched and gives a fully white-labeled experience.

## Channels

Stage 1 launches with email only. SMS and chat are deferred to later stages, but the data model and UI accommodate them from day one.

| Channel | Stage | Provider | Notes |
|---------|-------|----------|-------|
| email | 1 | Resend (BAA in place) | Reply-only inbound on reply.<domain> |
| sms | 2 | Twilio (BAA available) | Requires per-subaccount Twilio number and approved A2P campaign |
| chat | 3+ | Custom-built widget | Real-time web chat, future |

Across all channels, threading and storage use the same conversations / conversation_messages structure. Channel-specific fields (resend_email_id, twilio_sid, etc.) all share the external_id column with a channel discriminator.

## Data Model

### `conversations` table (RDS)

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,

  channel TEXT NOT NULL DEFAULT 'email'
    CHECK (channel IN ('email','sms','chat')),

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed','archived')),

  assigned_to TEXT,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_direction TEXT
    CHECK (last_message_direction IN ('inbound','outbound')),
  unread_count INTEGER NOT NULL DEFAULT 0,

  reply_token TEXT NOT NULL UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (subaccount_id, contact_id, channel)
);

CREATE INDEX idx_conv_subaccount_status ON conversations(subaccount_id, status);
CREATE INDEX idx_conv_subaccount_last_msg ON conversations(subaccount_id, last_message_at DESC);
CREATE INDEX idx_conv_contact ON conversations(contact_id);
CREATE INDEX idx_conv_assigned ON conversations(assigned_to) WHERE assigned_to IS NOT NULL;
```

`reply_token` is a high-entropy random string (32 chars). Used as the local-part on the Reply-To address for outbound email. When an inbound webhook arrives at reply+<token>@reply.<domain>, we look up the conversation by token.

### `conversation_messages` table (RDS)

```sql
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,

  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','chat')),

  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','reminder','confirmation','cancellation','widget','system')),

  from_address TEXT,
  to_address TEXT,
  cc_addresses JSONB,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,

  external_id TEXT,
  external_message_id TEXT,
  in_reply_to TEXT,

  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('queued','sent','delivered','failed','received','bounced')),
  error TEXT,

  sent_by_user_id TEXT,
  sent_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_convmsg_conv ON conversation_messages(conversation_id, created_at);
CREATE INDEX idx_convmsg_external ON conversation_messages(external_id);
CREATE INDEX idx_convmsg_subaccount ON conversation_messages(subaccount_id, created_at DESC);
CREATE INDEX idx_convmsg_message_id ON conversation_messages(external_message_id)
  WHERE external_message_id IS NOT NULL;
```

### `agency_email_log` table (RDS, NEW)

For agency-to-admin emails that don't belong to any subaccount's Conversations.

```sql
CREATE TABLE agency_email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  recipient_email TEXT NOT NULL,
  recipient_user_id TEXT,
  recipient_subaccount_id TEXT,

  from_email TEXT NOT NULL,
  subject TEXT,
  template_type TEXT,

  resend_email_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT,

  sent_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agency_email_recipient ON agency_email_log(recipient_email, sent_at DESC);
CREATE INDEX idx_agency_email_template ON agency_email_log(template_type);
```

`recipient_subaccount_id` is contextual only. The recipient is a person, not a subaccount. The column exists to answer "which workspace creation triggered this welcome?" not to scope ownership.

### `subaccount_email_domains` table additions

Extending the existing table with inbound setup fields:

```sql
ALTER TABLE subaccount_email_domains
  ADD COLUMN inbound_subdomain TEXT NOT NULL DEFAULT 'reply',
  ADD COLUMN inbound_status TEXT NOT NULL DEFAULT 'not_setup'
    CHECK (inbound_status IN ('not_setup','pending','verified','failed')),
  ADD COLUMN inbound_mx_target TEXT,
  ADD COLUMN inbound_verified_at TIMESTAMPTZ;
```

Existing columns (id, subaccount_id, domain, resend_domain_id, status, dkim_records, spf_record, return_path, verified_at, created_at) stay as-is. The existing `status` column governs OUTBOUND verification. The new `inbound_status` governs INBOUND verification. Both must be 'verified' before a subaccount can use Conversations end-to-end.

`inbound_mx_target` is Resend's MX record value, fetched at the time of inbound setup.

### Existing `email_log` table: deprecated and dropped

After the migration in Stage 1, email_log is dropped. No reads, no writes. Single source of truth wins.

## Send Path

The current `lib-aws/email-send.js` (or wherever Resend is invoked) gets refactored. Required parameter: `scope`.

```js
// Pseudo-code
sendEmail({
  scope: 'agency' | 'subaccount',  // REQUIRED, no default
  
  // For agency scope
  recipientUserId,      // optional
  recipientSubaccountId, // optional, contextual
  
  // For subaccount scope
  subaccountId,         // required if scope='subaccount'
  contactId,            // required if scope='subaccount'
  source,               // 'manual'|'reminder'|'confirmation'|'cancellation'|'widget'|'system'
  conversationId,       // optional, derived if absent
  
  // Common
  to, from, subject, html, text, attachments,
  replyTo,              // auto-generated for subaccount scope; omitted for agency
  inReplyTo,            // for threading
  
  templateType,
});
```

Routing:
- `scope='agency'` writes to agency_email_log only. No Reply-To token. No Conversations.
- `scope='subaccount'` writes to conversation_messages, upserts the parent conversation, and includes a Reply-To address `reply+<reply_token>@<inbound_subdomain>.<subaccount_domain>`.

### Outbound conversation upsert logic

When a subaccount-scope email is sent:

1. Find or create the conversation by (subaccount_id, contact_id, channel='email')
2. If new, generate a reply_token (32-char random)
3. Generate the Reply-To address: reply+<reply_token>@<inbound_subdomain>.<domain>
4. Send via Resend with that Reply-To
5. On send success, insert into conversation_messages with direction='outbound', external_id=resend_email_id
6. Update conversation: last_message_at, last_message_preview (first 140 chars of body_text), last_message_direction='outbound'
7. Do NOT increment unread_count on outbound (only inbound increments unread)

### System-source upsert behavior

System sources (reminder, confirmation, cancellation, widget) do upsert the conversation, but do NOT update last_message_at or last_message_preview if the conversation already has manual activity. Rationale: reminder cron firing 100 times shouldn't push the conversation to the top of the inbox above a real reply.

Tiebreaker rule: inbox sort = MAX(last_manual_message_at, last_inbound_message_at) DESC. System outbound messages don't move conversations in the inbox. They only appear in thread view.

This means conversations table also needs:

```sql
ALTER TABLE conversations
  ADD COLUMN last_manual_message_at TIMESTAMPTZ,
  ADD COLUMN last_inbound_message_at TIMESTAMPTZ;
```

These two columns drive inbox sort. last_message_at stays as a general "last activity" timestamp for thread view.

## Inbound Webhook

Resend supports inbound on verified custom domains via MX record. Webhook fires `email.received` with metadata only. Body and attachments fetched via separate Resend API calls.

### Flow

1. Patient hits Reply on a clinic email
2. Email lands at reply+<token>@reply.<clinicdomain>.com
3. Resend processes it, fires POST to https://api.mysparkplus.app/api/email/inbound-webhook
4. Webhook Lambda verifies Resend signature
5. Webhook extracts To address, parses `reply+<token>@...`, looks up conversation by reply_token
6. If no match, log to a `inbound_unmatched` table for investigation (don't 500, don't bounce)
7. Fetch full body from Resend API using email_id
8. Insert into conversation_messages with direction='inbound', source='manual'
9. Update conversation: last_message_at, last_inbound_message_at, last_message_preview, unread_count++, status set to 'open' if previously closed/archived
10. Send notification to assigned_to staff (or all subaccount admins if unassigned) via existing notification system
11. Return 200 to Resend

### Reply detection

Resend's inbound payload includes parsed In-Reply-To and References headers. Store them on conversation_messages. Useful for future threading sanity checks and for matching multi-segment conversations.

For Stage 1, the reply_token is authoritative. Headers are stored but not used for routing.

### Signature verification

Resend signs inbound webhooks. Validate the signature header against the shared secret. Reject if invalid. Store the shared secret in AWS Secrets Manager, not Lambda env vars.

### unmatched inbound

```sql
CREATE TABLE inbound_unmatched (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address TEXT,
  from_address TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  raw_payload JSONB,
  reason TEXT
);
```

Reasons: 'no_token_in_address', 'token_not_found', 'subaccount_mismatch', 'contact_mismatch', 'signature_fail'. Review periodically. High volume here indicates an attack or a bug.

## Domain Verification Flow

Two halves: outbound (already exists, uses Resend's domain verification) and inbound (NEW, our own MX check + Resend inbound setup).

### Outbound verification (existing, no changes)

Subaccount adds domain in MySpark+. Backend calls Resend create-domain API. Resend returns DKIM, SPF, and return-path records. Subaccount adds those to their DNS. Backend periodically polls Resend until status='verified'. Existing flow.

### Inbound verification (NEW for Stage 1)

1. Outbound must be verified first (gate at UI level)
2. Subaccount clicks "Set Up Inbound Replies"
3. Backend calls Resend's inbound API to enable inbound on the subaccount's domain (or a configured subdomain)
4. Backend stores inbound_mx_target returned by Resend
5. UI displays: "Add this MX record to reply.<theirdomain>.com pointing to <inbound_mx_target>"
6. Subaccount adds the MX record at their DNS provider
7. Subaccount clicks "Verify"
8. Backend performs a DNS MX lookup on reply.<theirdomain>.com
9. If MX matches inbound_mx_target, set inbound_status='verified', inbound_verified_at=NOW()
10. If not, return error with current MX records found

### Sending gate

Conversations cannot send unless:
- subaccount_email_domains.status = 'verified' (outbound)
- subaccount_email_domains.inbound_status = 'verified' (inbound)

If either is missing, the Compose UI shows a setup prompt with a link to Settings → Email Domains.

Rationale: partial setup creates dead-letter mail. If outbound works but inbound doesn't, patients can reply but the clinic never sees the replies. Worse than not having Conversations at all.

## Public API Endpoints

All under `/api/subaccount/conversations/*` (auth required via `requireSubaccountAuth`) except the inbound webhook.

### `GET /api/subaccount/conversations`

List threads for the current subaccount.

Query params: `status` ('open'|'closed'|'archived'|'all'), `channel` ('email'|'sms'|'all'), `assigned_to` (user_id or 'me' or 'unassigned'), `q` (search text), `limit`, `offset`.

Returns:
```json
{
  "conversations": [
    {
      "id": "...",
      "contact_id": "...",
      "contact": { "id", "name", "email", "phone" },
      "channel": "email",
      "status": "open",
      "assigned_to": "user-id" | null,
      "last_message_at": "...",
      "last_message_preview": "Thanks for...",
      "last_message_direction": "inbound",
      "unread_count": 2
    }
  ],
  "total": 47
}
```

### `GET /api/subaccount/conversation`

Get a single thread with messages.

Query: `id`.

Returns:
```json
{
  "conversation": { /* full conversation row + contact */ },
  "messages": [ /* conversation_messages, oldest first */ ]
}
```

Side effect: marks unread_count = 0 for the calling user.

### `POST /api/subaccount/conversations/send`

Send an outbound email.

Body:
```json
{
  "contact_id": "...",
  "channel": "email",
  "subject": "...",
  "body_html": "...",
  "body_text": "...",
  "template_id": "..."  // optional
}
```

Returns:
```json
{
  "conversation_id": "...",
  "message_id": "..."
}
```

Validates: subaccount has both outbound + inbound verified domains, contact has email, body not empty.

Calls the send-path helper with scope='subaccount', source='manual'.

### `PATCH /api/subaccount/conversation`

Update conversation status, assignment, mark read.

Body: `{ id, status?, assigned_to?, mark_read? }`

### `POST /api/subaccount/email-domain/inbound-setup`

Initiates inbound setup. Calls Resend inbound API, returns MX target.

### `POST /api/subaccount/email-domain/inbound-verify`

DNS MX lookup, updates inbound_status.

### `POST /api/email/inbound-webhook` (public, signature-verified)

Resend posts incoming emails here. Signature header verified against secret. See Inbound Webhook section above.

CORS: not applicable (server-to-server). Public via API Gateway.

## Migration Plan: email_log to conversation_messages

226 rows in email_log as of May 12, 2026. Three-bucket migration.

### Bucket A: Agency emails (skip Conversations, route to agency_email_log)

Criteria:
- template_type IN ('welcome')
- OR subject starts with 'Your MySpark+ workspace is ready'
- OR contact_id IS NULL AND template_type IS NULL AND to_email IS NOT a known contact's email

Action: copy to agency_email_log with recipient_email, from_email, subject, template_type, resend_email_id, status, sent_at. recipient_user_id and recipient_subaccount_id derived if possible.

Estimated rows: ~10-18.

### Bucket B: Subaccount transactional (route to conversation_messages)

Criteria:
- template_type IN ('appt-reminder','appt-cancellation','appt-confirmation','booking-confirmation')
- AND contact_id IS NOT NULL

Action:
1. Group by (subaccount_id, contact_id, channel='email')
2. For each group, upsert a conversation (status='open', reply_token generated)
3. Insert each email_log row as a conversation_messages row with:
   - direction='outbound'
   - source = template_type mapped: 'appt-reminder'→'reminder', 'appt-cancellation'→'cancellation', 'appt-confirmation'→'confirmation', 'booking-confirmation'→'widget'
   - body_text=NULL, body_html=NULL (not stored historically; render as "Historical system message - body not captured" in UI)
   - status mapped from email_log.status
   - external_id=resend_email_id

Estimated rows: ~200.

### Bucket C: Skip (test emails)

Criteria:
- contact_id IS NULL
- AND to_email matches an admin email (patrick@litbiz.io, info@litbizmedia.com, hello@litbiz.io, test@litbiz.io, renamer@litbiz.io)
- AND not already classified as agency above

Action: skip. These are dev test emails. They have no value in Conversations.

Estimated rows: ~8.

### Migration Lambda

One-shot Lambda: `myspark-conversations-migrate-email-log`. Idempotent. Reports counts per bucket. Verifies counts match expected before dropping email_log. Built as part of Session 1.

## Frontend Spec

### Conversations Tab (replaces existing placeholder)

Three-pane layout on desktop:

**Left pane: Thread list**
- Header: tabs for Open / Closed / Archived, count badges
- Filter bar: channel (Email/SMS/All), assigned (Me/Anyone/Unassigned), search
- List of conversations sorted by inbox-sort timestamp (MAX of last_manual_message_at and last_inbound_message_at), DESC
- Each row: contact avatar/initials, contact name, channel icon, last message preview (1 line), timestamp, unread badge
- Selected row highlighted

**Middle pane: Thread view**
- Header: contact name (clickable to contact drawer), channel, status pill, assigned-to picker
- Body: chronological message list, oldest at top, scrolled to bottom by default
- Each message: from/to, timestamp, body (or "Historical system message - body not captured" for migrated transactional rows)
- System messages (source != 'manual') rendered as compact gray rows: icon + "Appointment reminder sent" + timestamp
- Footer: composer with To (locked to contact), Subject, body editor, Send button
- Actions toolbar: Close, Archive, Reopen, Assign

**Right pane: Contact context (collapsible)**
- Contact summary: name, email, phone
- Recent appointments
- Tags
- Quick link to full contact drawer

### Mobile

Two-pane drilldown. List view, tap to thread view, back to list. Right pane folds into a sheet behind a button.

### Empty states

- No conversations yet: large illustration + "Send your first email from a contact's profile" + CTA
- No domain set up: "Set up your sending domain to enable Conversations" + CTA to Settings
- Domain partially set up: "Inbound replies not configured. Patients can receive emails but can't reply yet." + CTA

### Compose flow

Two entry points:
1. From Conversations tab: New button → contact picker → composer
2. From a contact's profile drawer: "Send email" button → composer (contact pre-filled)

Composer features Stage 1:
- To: locked to selected contact
- Subject
- Body editor (rich text via existing editor library; if none, plain text + simple HTML wrapper)
- Template insert dropdown (from email_templates table, future polish)
- Send button (disabled if domain not verified)
- Save draft (deferred to Stage 5)

### Settings Tab: Email Domains

Existing tab gets a new "Inbound Setup" section per verified outbound domain.

Section shows:
- Inbound status pill (Not Set Up / Pending / Verified / Failed)
- Subdomain field (default 'reply', editable to 'mail', 'inbox', etc.)
- Set Up button (calls inbound-setup Lambda)
- After setup: MX record value displayed, copy button, "Verify MX Record" button
- After verify: green check + verified_at timestamp

Existing outbound DKIM/SPF/return-path UI stays unchanged.

## Security & HIPAA

### Public exposure
The inbound webhook is the only public surface in Conversations. It accepts POST from Resend, validates signature, no other access.

### Threats and mitigations

| Threat | Mitigation |
|--------|-----------|
| Webhook spoofing | Resend signature verification on every request |
| Reply-Token enumeration | 32-char random tokens; rate limit per IP on the webhook |
| Cross-subaccount data leak | reply_token globally unique; conversation lookup uses token only, joins to subaccount_id |
| Patient email in URLs | Never put email or token in URLs; tokens only in Reply-To addresses |
| Phishing via inbound | Inbound emails are received but never auto-actioned. Staff reads, decides. |
| MX record hijacking | Subaccounts control their own DNS; we verify but don't manage |
| Bouncing replies into a black hole | inbound_unmatched table captures everything we can't route, alerted on threshold |
| Sending from unverified domain | Send Lambda hard-rejects if domain status != 'verified' OR inbound_status != 'verified' |

### CORS

`/api/email/inbound-webhook` does not need CORS (server-to-server). All other endpoints follow the existing subaccount CORS policy (ALLOWED_ORIGINS).

### Audit logging

Every send and every read of a thread logs to audit_log:

- send: `subaccount.conversation.send` with target_id=message_id, metadata={contact_id, channel, source}
- thread view: `subaccount.conversation.view` with target_id=conversation_id
- status change: `subaccount.conversation.update` with metadata={old_status, new_status}
- assignment: `subaccount.conversation.assign` with metadata={old_assignee, new_assignee}
- inbound received: `subaccount.conversation.inbound_received` with target_id=message_id, actorType='public'

Bulk endpoints (list) log aggregate counts, not contents.

### PHI handling

- Patient body text contains PHI by definition (any appointment-related content)
- conversation_messages.body_text and body_html are stored unencrypted in Postgres (RDS encryption-at-rest covers it via KMS)
- Attachments stored in S3 (existing media bucket, KMS-encrypted)
- Resend has BAA in place; covers email transit and storage
- 6-year retention applies to conversation_messages and audit_log entries

## Stage Plan

### Stage 1: Foundation (Email-Only) - This Session Forward

Goal: working email Conversations with agency/subaccount partition, send + receive + thread + display.

Deliverables:
- Schema migrations: conversations, conversation_messages, agency_email_log, subaccount_email_domains additions
- Migration Lambda: email_log three-bucket split, then drop email_log
- Refactored send-path helper with required `scope` parameter
- Refactor every existing email caller to declare scope:
  - Appointment reminder cron: scope='subaccount', source='reminder'
  - Appointment confirmation: scope='subaccount', source='confirmation'
  - Appointment cancellation: scope='subaccount', source='cancellation'
  - Booking widget submission: scope='subaccount', source='widget'
  - Workspace welcome: scope='agency'
  - Password reset to admin: scope='agency'
- Lambda endpoints: list, get, send, update, inbound-setup, inbound-verify, inbound-webhook
- Resend inbound integration including signature verification
- Frontend Conversations tab (replaces placeholder)
- Frontend Settings tab inbound setup UI
- End-to-end test: clinic sends email from Conversations, patient replies, reply lands in thread, status updates

NOT included in Stage 1:
- SMS (Stage 2, gated on Twilio approval)
- Chat widget (Stage 3+)
- Templates integrated into composer (Stage 4)
- Snooze, drafts, scheduled send (Stage 5)

### Stage 2: SMS Channel

Goal: extend Conversations to handle SMS once Twilio campaign approves.

Deliverables:
- Add Twilio inbound webhook: `/api/sms/inbound-webhook`
- Refactor SMS send path with same scope='subaccount' / source='manual' pattern
- Update conversation thread view to render SMS messages distinctly (no subject, character limit display)
- Update Compose UI to support channel switching (Email/SMS toggle, contact must have phone for SMS)
- Migrate any existing sms_log rows similarly (likely 0 rows since SMS is brand new)
- Update Settings tab SMS section to surface campaign status

Gated on: Twilio campaign VERIFIED state.

### Stage 3: Chat Widget Channel

Goal: real-time web chat embedded on client sites, threaded into Conversations.

Deliverables:
- Public chat widget JS (separate from booking widget but same hosting pattern)
- WebSocket or polling layer for real-time delivery (API Gateway WebSocket)
- channel='chat' in conversation_messages
- Real-time push to staff in Conversations
- Visitor identification (cookie + optional name/email capture)
- Auto-link to existing contact by email match

### Stage 4: Templates and Campaigns

Goal: separate Conversations (1:1 threads) from Campaigns (1:many broadcasts), with shared template library.

Deliverables:
- email_templates table extended with template categories
- Composer: template insert with variable substitution
- Campaigns surface: select segment, choose template, schedule send
- Campaign metrics: opens, clicks, unsubscribes per template
- Suppression list (unsubscribed contacts won't receive campaigns)

### Stage 5: Polish

Goal: production-grade UX.

Deliverables:
- Snooze (close conversation until a specified date/time, auto-reopens)
- Drafts (composer auto-saves)
- Scheduled send
- Signatures (per staff)
- Saved replies / canned responses
- Search across threads
- Bulk actions (close all, assign all)
- Per-staff notification preferences (email/SMS/in-app)
- Auto-replies for after-hours
- iCal attachments on appointment-related sends

## Testing Checklist

For any change to Conversations code, test:

1. **Send happy path** - clinic sends email, lands in patient inbox, appears in Conversations
2. **Reply happy path** - patient replies, lands in correct thread with correct subaccount
3. **Reply across subaccounts** - patient at clinic A replies, MUST NOT appear in clinic B
4. **Closed thread reopens on inbound** - status changes from closed to open
5. **Domain unverified blocks send** - send Lambda returns error, UI shows setup prompt
6. **Inbound webhook signature fail** - 401, no message created
7. **Inbound to unknown token** - lands in inbound_unmatched, no 500
8. **Migration idempotency** - rerun migration, no duplicates
9. **Migration completeness** - 226 email_log rows accounted for across three buckets
10. **Agency email isolation** - workspace welcome NEVER appears in any Conversations inbox
11. **System message inbox behavior** - reminder cron fires, conversation does NOT jump in inbox
12. **Audit log** - send, view, update, inbound all logged
13. **Cross-tenant isolation** - direct API call to view conversation from another subaccount returns 403
14. **Unread badge** - inbound increments, opening thread clears, outbound doesn't change
15. **Attachment handling** - inbound with attachment fetches via Resend API, stores in S3
16. **Long thread render** - thread with 50+ messages renders without performance issues
17. **Inbound subdomain change** - subaccount changes from 'reply' to 'mail', flow still works

For Stage 2 (SMS):
18. **SMS send happy path**
19. **SMS reply happy path**
20. **SMS character count display**
21. **Channel switch in composer**

## Common Mistakes to Avoid

1. **Sending without scope parameter** - the send-path helper must error if scope is missing
2. **Putting agency emails in conversation_messages** - workspace welcome, billing receipts NEVER touch Conversations
3. **Reply-Token in URLs** - tokens belong in email addresses only, never logged in URLs or browser history
4. **Updating last_message_at on system messages** - inbox sort must use last_manual_message_at and last_inbound_message_at only
5. **Trusting webhook payload signature loosely** - validate exact signature, reject otherwise
6. **Allowing send when only outbound verified** - both outbound AND inbound must be verified
7. **Cross-subaccount reply_token collision** - tokens globally unique, always join to subaccount_id when looking up
8. **Skipping audit log on send/view** - HIPAA requires both
9. **Storing PHI in agency_email_log** - agency_email_log is for non-PHI agency comms only
10. **Re-fetching body on every thread view** - body is stored at write time, never re-fetched from Resend
11. **Forgetting unsubscribe footer (Stage 4)** - campaigns must include it; 1:1 threads don't need it
12. **Naive thread sort by created_at** - use the inbox-sort tiebreaker rule

## Forward-Path Items Related to Conversations

Items not in Stage 1 that touch Conversations:
- HIPAA Right of Access patient export (must include Conversations history)
- CloudWatch alarms on inbound webhook + send Lambda failures
- Per-IP rate limit on inbound webhook
- Suppression list for unsubscribes
- Auto-link inbound from unknown sender to existing contact by email match
- Migrate email_templates into a unified templates table (shared with future SMS templates)
- Custom domains for chat widget (Stage 3)

## Questions Resolved

These were debated and decided during scoping:

**Q: One table for both agency and subaccount emails, or two?**
A: Two. Agency emails go to agency_email_log. Subaccount emails go to conversation_messages. Different contexts, different ownership models, different retention concerns.

**Q: Architecture A (reply-only) or B (full inbox)?**
A: A. Full inbox (Gmail OAuth, IMAP) is months of work and not justified by client demand. Reply-only covers 90% of the value.

**Q: Per-thread email aliases or one reply token per conversation?**
A: One reply_token per conversation. Resend's catch-all on the verified domain means we don't need per-thread aliases.

**Q: Shared fallback sending domain (e.g. send-from-mysparkplus.app)?**
A: No. Sharing sending reputation across all clinics risks contaminating deliverability. Clients must verify their own domain before sending.

**Q: One conversation per contact per channel, or one per subject thread?**
A: Per contact per channel. Matches GHL, matches SMS mental model, avoids the "which thread do I reply in" problem.

**Q: Default inbound subdomain name?**
A: "reply". Industry standard. Avoids collision with most existing mail records (mail., inbox.).

**Q: Migrate 226 email_log historical rows with body or as metadata-only?**
A: Metadata only. body_text=NULL, body_html=NULL. UI renders as "Historical system message - body not captured." Body history wasn't captured in email_log, so we can't reconstruct it.

**Q: Inbox sort behavior with system messages (reminders, confirmations)?**
A: System outbound does NOT bump the inbox. Only inbound and manual outbound count for inbox sort. Reminders fire constantly; without this rule, every conversation jumps daily.

**Q: Status workflow?**
A: open / closed / archived. No snooze in Stage 1 (Stage 5 polish). Closed reopens automatically on inbound.

**Q: Assignment required or optional?**
A: Optional. Solo clinics don't need it. Multi-staff clinics will. Future: contact-level owner inherits as default assignee.

## Audit History

This doc was created May 12, 2026, after Twilio campaign resubmission and during Stage 1 scoping. Key architectural decisions:

- Agency vs subaccount email partition surfaced when reviewing 226 historical email_log rows, 18 of which were misclassified agency emails sitting in subaccount scope.
- email_log gets dropped in favor of unified conversation_messages.
- agency_email_log is built in Stage 1 (not deferred) to avoid building Conversations on contaminated data.
- Inbound architecture confirmed against Resend documentation (catch-all on verified domain, signature-verified webhook, body fetched via separate API call).
- Twilio campaign resubmitted May 12, 2026. SMS Stage 2 gated on VERIFIED status, expected 10-15 business days.
