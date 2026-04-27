# Wiring requireSubaccountAuth into Existing Endpoints

## What this guide is for

After Checkpoint 2, the new `lib/require-subaccount-auth.js` middleware is available. This guide shows how to apply it to existing API endpoints so they no longer trust whatever the browser sends in the request body.

The pattern is the same for every endpoint. Once you do one, the rest are repetitive.

## Priority order

These endpoints accept actions from logged-in subaccount users and currently have no server-side auth check:

**Critical (do first):**
1. `api/square/charge.js` - charges cards. Anyone calling this could charge someone else's customers.
2. `api/square/refund.js` - issues refunds.
3. `api/square/void.js` - voids transactions.
4. `api/square/save.js` - saves cards to file.

**High:**
5. `api/email/send.js` - sends transactional emails (could be abused for spam from the subaccount's domain).
6. `api/email/domains/add.js` - adds verified sending domains.
7. `api/email/domains/verify.js` - triggers DNS verification.
8. `api/email/domains/remove.js` - removes verified domains.

**Medium:**
9. `api/square/customers.js` - looks up Square customers.
10. `api/square/find.js` - looks up cards.
11. `api/square/connect.js` - OAuth flow start. Scope-locked already by OAuth state but worth tightening.
12. `api/square/disconnect.js` - revokes Square OAuth.
13. `api/square/config.js` - reads or writes Square config.

**Lower (already protected by other means but still good practice):**
- `api/subaccount/change-password.js` - already requires session in the new endpoint.

## The pattern

For each endpoint, three things change:

### 1. Import the middleware

At the top of the file, add:

```javascript
const { requireSubaccountAuth } = require('../../lib/require-subaccount-auth');
```

(Adjust the relative path based on where the file lives. From `api/square/charge.js` it's `../../lib/...`. From `api/email/domains/add.js` it's `../../../lib/...`.)

### 2. Validate session at the top of the handler

```javascript
module.exports = async function handler(req, res) {
  // FIRST line of the handler: validate session
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return; // 401 already sent

  // ... existing logic ...
};
```

### 3. Replace body-trusted fields with auth-derived values

Most current endpoints take `slug` from `req.body` and trust it. Don't. Instead:

```javascript
// BEFORE:
const { slug, contactId, amount } = req.body;
// ...uses slug to look up the subaccount...

// AFTER:
const { contactId, amount } = req.body;
const subaccountId = auth.subaccount_id; // trusted, from session
// or convert to slug:
const slug = subaccountId.replace(/^sub-/, '');
```

If the endpoint MUST accept a slug for some reason (e.g. for backward compat with an existing caller), validate it matches the session:

```javascript
const requestedId = 'sub-' + (req.body.slug || '');
if (auth.subaccount_id !== requestedId) {
  return res.status(403).json({ error: 'Slug does not match session' });
}
```

### 4. Optional: role gates

For destructive operations (refunds, voids, deletions), require admin or manager role:

```javascript
const auth = await requireSubaccountAuth(req, res, { requireRole: ['admin', 'manager'] });
if (!auth) return;
```

A non-admin trying to refund will get 403 with the attempt logged in audit_log.

## Example: api/square/charge.js (before and after)

### Before

```javascript
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { slug, sourceId, amount, contactId } = req.body;
  if (!slug || !sourceId || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const creds = await getSquareCredsForSlug(slug);
  // ... charge logic ...
};
```

### After

```javascript
const { requireSubaccountAuth } = require('../../lib/require-subaccount-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const { sourceId, amount, contactId } = req.body;
  if (!sourceId || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Trust the session, not the request body
  const slug = auth.subaccount_id.replace(/^sub-/, '');
  const creds = await getSquareCredsForSlug(slug);
  // ... charge logic, now scoped to auth.user_id and auth.subaccount_id ...
};
```

## Checklist for each endpoint

For every endpoint you wire:

- [ ] Imported `requireSubaccountAuth`
- [ ] Called it as the first line of the handler
- [ ] Removed any blind trust in `req.body.slug` or `req.body.subaccountId`
- [ ] Used `auth.subaccount_id` and `auth.user_id` for scoping
- [ ] Added role gate for destructive operations (refund, void, delete, disconnect)
- [ ] Tested: valid session works
- [ ] Tested: missing cookie returns 401
- [ ] Tested: a session for a DIFFERENT subaccount cannot operate on this one (if cross-tenant is even possible to test)

## Frontend impact

Most frontend `fetch()` calls already include `credentials: 'include'` because they're same-origin. If you find an endpoint where the frontend isn't sending credentials, add it:

```javascript
fetch('/api/square/charge', {
  method: 'POST',
  credentials: 'include',  // <-- this
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({...})
});
```

Without that, the browser does not send the HttpOnly session cookie and the endpoint returns 401.

## Testing one endpoint end-to-end

After wiring `api/square/charge.js`:

1. Log into the subaccount normally
2. Try a small charge from POS - should work as before
3. In DevTools, clear the `msp_session` cookie
4. Try the charge again - should fail with "Not authenticated"
5. Log in again - charge works again

Repeat for each endpoint.

## When you're done

Update the master handoff document to note which priority items are complete. Ship in batches (e.g., do all four Square endpoints in one commit, all four email endpoints in another) so each commit is reviewable.

## What this closes

After all endpoints are wired:
- A user editing `state.user.role = 'admin'` in DevTools no longer grants admin powers (server checks the real role from the session)
- A subaccount cannot call another subaccount's endpoints (server enforces scope)
- API calls from non-logged-in attackers fail at the middleware level
- All denied attempts are audit-logged with IP and user agent

This is the single biggest piece of attack-surface reduction left after Checkpoints 1-2.
