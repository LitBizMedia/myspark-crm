# MySpark+ SMS Framework Handoff

**Date created:** May 14, 2026
**Status:** SMS framework fully functional end-to-end. Items below are remaining work.

---

## ✅ WHAT'S DONE (don't redo)

### Backend infrastructure
- AWS Secrets Manager: `myspark/integrations/twilio` (API Key auth: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET)
- `lib-aws/twilio.js` — canonical sender, single status gate (only `live` sends)
- `lib-aws/contacts.js` — extended with `getContactByPhone` (3-tier match) and `createStubContactFromSms`
- Lambdas deployed:
  - `myspark-api-sms-send` (outbound, uses lib/twilio)
  - `myspark-api-sms-inbound` (Twilio webhook, verified working)
  - `myspark-api-sms-status` (delivery callbacks)
  - `myspark-api-agency-sms-requests` (lists pending + provisioned)
  - `myspark-api-agency-sms-provision` (creates sms_settings row, manual number entry)
  - `myspark-api-agency-sms-status-update` (single status field + rejection_note)
  - `myspark-api-subaccount-sms-toggle` (pause/resume, kept but unused in UI)
  - `myspark-api-subaccount-sms-status` (returns settings + request for clinic UI)
  - `myspark-api-subaccount-sms-registration-submit` (4-step wizard, supports draft mode)

### Twilio production setup
- LitBiz brand: APPROVED at Twilio Trust Hub
- LitBiz campaign: PENDING A2P (awaiting carrier approval)
- Number: +13176890766 (PN52027fc7d1edda2a882b91a97cb5f368)
- Webhook URL configured: `https://api.mysparkplus.app/api/sms/inbound`

### Schema (current state)
- `sms_settings`: id, subaccount_id, twilio_number, twilio_number_sid, campaign_status (pending|live|paused), rejection_note, opt_in_message, created_at, updated_at. NO enabled column.
- `sms_registration_requests`: 30+ columns including business_type, business_industry, business_country, address fields, contact first/last/title, use_case, use_case_description, 3 sample messages, opt_in_method, opt_in_description. Status: draft|requested|in_progress|provisioned|rejected.
- `conversations` + `conversation_messages` tables hold SMS records alongside email.

### Frontend
- Subaccount Settings → SMS: 4-step wizard with pre-fill + draft save, shows status when registered (no controls, agency-only)
- Subaccount Conversations: SMS composer routes to /api/sms/send, channel-aware char counter (GSM-7 vs UCS-2 segment math), pending/paused banners, SMS bubble badge, subject hidden on SMS messages
- Agency dashboard: View Details modal with Copy-as-JSON, Provision modal (manual Twilio number entry), Update Status modal (pending/live/paused + rejection_note textarea)

### Architecture decision (locked in)
- **Three states only**: pending, live, paused
- **No dual-gate**: campaign_status is the single source of truth
- **Agency controls all state**: clinic has no Pause/Resume button
- **Rejection notification**: agency sets status to pending + fills rejection_note; clinic sees the note

---

## ⚠️ WHAT'S LEFT (ordered by priority for next sessions)

### P0 — Compliance / risk

**1. Opt-out handling (STOP keyword)** — Est. 1-2 hr
- Patient texts STOP → Twilio auto-blocks future sends on their end
- BUT MySpark+ doesn't track this. Need to:
  - Detect STOP/UNSUBSCRIBE/CANCEL/END/QUIT in `sms-inbound.js`
  - Add `sms_opted_out BOOLEAN DEFAULT FALSE` to contacts table
  - Flip flag to true when opt-out detected
  - Check flag in `lib/twilio.js` before sending → return early with "opted out" error
  - Show "opted out of SMS" badge on contact card in UI
  - Exclude opted-out contacts from bulk sending
- Why P0: protects A2P trust score, avoids carrier penalties, legal compliance

### P1 — Product value

**2. SMS appointment reminders / confirmations** — Est. 2-3 hr
- Currently appointment reminders/confirmations send via EMAIL only via lib-aws/appointment-emails.js
- Add SMS path: when SMS is live for subaccount AND contact has phone AND contact is not opted out → also send SMS
- Settings: per-subaccount toggle "Send SMS reminders" + "Send SMS confirmations" + "Send SMS cancellations"
- Templates: reuse the sample messages from registration form as defaults, allow per-subaccount customization
- Hook points: booking-submit.js, appointment-upsert.js, cron-reminders.js, appointment cancel flow

**3. Inbound SMS notifications to staff** — Est. 1-2 hr
- When patient texts in, message lands in Conversations panel silently
- Need: desktop notification trigger (existing notifDing()), badge update, optional email digest to assigned staff
- Configurable per-subaccount: who gets notified? (all admins, specific user, role)

### P2 — Operational

**4. Clinic notification on approval** — Est. 30-45 min
- When agency flips campaign_status from pending → live, clinic should be notified
- Options:
  - Simplest: email via existing SES (use lib-aws/ses.js sendEmail helper)
  - Trigger: hook into agency/sms-status-update.js after successful DB write
- Skipped tonight per "defer notifications" decision

**5. Twilio Brand/Campaign API automation** — Est. 3-4 hr
- Currently agency manually: buys number on twilio.com, copies number+SID into Provision modal, submits Brand+Campaign in Twilio Trust Hub UI
- Full automation: Provision button calls Twilio API to (a) search for available numbers in clinic area code, (b) buy one, (c) configure SmsUrl, (d) submit Brand registration via Trust Hub API, (e) submit Campaign with use_case data, (f) store Brand SID + Campaign SID in sms_settings
- Add columns: twilio_brand_sid TEXT, twilio_campaign_sid TEXT to sms_settings
- LitBiz brand is already approved so only Campaign API needed for litbiz-tenant clinics; sub-accounts probably need their own Brand

**6. Twilio status polling cron** — Est. 2-3 hr
- Cron Lambda hits Twilio API daily, checks campaign_status for each pending registration
- Auto-updates DB when Twilio reports approved
- Removes the "wait for Twilio email, manually check, flip status" friction
- Best paired with item 5 above

**7. Reject UI in agency dashboard** — Est. 15 min
- Today: agency sets status back to 'pending' + fills rejection_note
- Cosmetic improvement: dedicated "Reject Submission" button in Update Status modal that requires a rejection_note before saving

### P3 — Money

**8. SMS credit purchase / overflow** — Est. 6-8 hr
- Today: when monthly plan limit hits (starter=300, professional=1000, business=4000, enterprise=8000) sending fails
- No "buy more credits" option
- Real product feature requiring:
  - Schema: credit pool per subaccount, separate from monthly allowance
  - Pricing tiers (100/500/1000 credits at $X each)
  - Square purchase flow (use existing billing infrastructure)
  - Decrement order: monthly allowance → credit pool → fail
  - UI: balance display, purchase modal, transaction history
  - Auto-refill thresholds, low-balance notifications

---

## 🔑 KEY FILES TO KNOW
api-aws/sms/ ├── send.js # Outbound (thin wrapper over lib/twilio.sendSms) ├── inbound.js # Twilio webhook handler └── status.js # Delivery callbacks
api-aws/agency/ ├── sms-provision.js # Manual provision (today's flow) ├── sms-status-update.js # Update status + rejection_note └── sms-requests.js # List pending + provisioned
api-aws/subaccount/ ├── sms-status.js # Returns settings + request ├── sms-toggle.js # Pause/resume (unused in UI today) └── sms-registration-submit.js # 4-step wizard backend, draft + final modes
lib-aws/ ├── twilio.js # CANONICAL outbound sender, single status gate └── contacts.js # getContactByPhone + createStubContactFromSms
sql/ ├── 2026-05-14-sms-status-simplification.sql └── 2026-05-14-sms-registration-expansion.sql
Frontend (index.html):
	•	Search "renderSmsSettings" for clinic UI
	•	Search "renderSmsRegistrationWizard" for 4-step wizard
	•	Search "agencyLoadSmsRequests" for agency dashboard
	•	Search "_smsRenderSubmissionModal" for View Details
	•	Search "openAgencyUpdateSmsStatus" for status update flow
	•	Search "_convSmsBlockerReason" for composer gating
	•	Search "convSend" for SMS routing
---

## 🚨 GOTCHAS / IMPORTANT CONTEXT

- Twilio API uses **Basic auth with API Key**: `Basic base64(API_KEY_SID:API_KEY_SECRET)`. Account SID is in the URL, not auth.
- `lib-aws/twilio.js` checks the campaign_status BEFORE calling Twilio (fail-fast, zero cost). Don't change this.
- Drafts hide from agency view (`status='draft'` excluded from sms-requests Lambda query). Don't show drafts to agency.
- The `enabled` column was DROPPED from `sms_settings`. Don't reference it anywhere.
- Sample messages support `{business_name}` placeholder that gets rendered on submit (not on draft save). `{first_name}`, `{date}`, `{time}` are kept as literal templates for Twilio review.
- Twilio `IncomingPhoneNumbers` API needs `PN...` SID; agency must paste both number AND SID.
- LitBiz's existing brand is approved at Twilio — this means LitBiz's own subaccount (`sub-litbiz`) inherits this. Other subaccounts (Wildflower, etc.) need their OWN Brand registration with Twilio, even though they go through LitBiz's master account. This is a Twilio policy.

---

## ✅ TESTED END-TO-END

- Inbound SMS: verified May 14 from Patrick's real phone → contact stub created, conversation row created, message appeared in Conversations panel
- 4-step wizard: tested by Patrick with Wildflower data, draft save works, resume works, submission moves to "Request Received" status
- Agency View Details: shows full submission organized in sections, Copy-as-JSON works
- Composer banner: shows correct message per status, send button correctly disabled
- Status update flow: agency flips pending → live → paused → live; rejection_note appears for clinic when set
