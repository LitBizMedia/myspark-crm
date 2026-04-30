// lib/secrets.js
//
// AWS Secrets Manager helper with cold-start caching.
//
// Why this exists:
// Lambdas should not call Secrets Manager on every invocation - that adds
// 50-150ms of latency and racks up charges. Instead we load each secret
// ONCE per cold start (the first time a particular Lambda container is
// instantiated) and cache the result in memory.
//
// Secrets are stored as JSON blobs. Example:
//   secret name: "myspark/integrations/resend"
//   secret value: {"RESEND_API_KEY":"re_xxx","RESEND_WEBHOOK_SECRET":"whsec_xxx"}
//
// Usage:
//   const secrets = require('./secrets');
//
//   // Load a secret as an object
//   const resend = await secrets.get('myspark/integrations/resend');
//   const apiKey = resend.RESEND_API_KEY;
//
//   // Or pull a specific key with a default fallback to env var
//   const apiKey = await secrets.getKey('myspark/integrations/resend', 'RESEND_API_KEY');
//
// Behavior:
//   - First call: hits Secrets Manager (~100ms), caches result
//   - Subsequent calls: returns from cache (~1ms)
//   - Cache lives for the duration of the Lambda container (5min-2hr typical)
//   - Errors are NOT cached - if a load fails, next call will retry

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.AWS_REGION || 'us-east-2';

// Lazy-initialized client (saves ~30ms on cold start when secrets aren't used)
let _client = null;
function getClient() {
  if (!_client) {
    _client = new SecretsManagerClient({ region: REGION });
  }
  return _client;
}

// In-memory cache: { secretName: { ... parsed JSON ... } }
const cache = {};

// In-flight promises so concurrent calls don't trigger duplicate fetches
const inFlight = {};

/**
 * Fetch a secret from AWS Secrets Manager. Returns the parsed JSON object.
 * Caches per Lambda container.
 *
 * @param {string} secretName - e.g. 'myspark/integrations/resend'
 * @returns {Promise<Object>} parsed secret value
 */
async function get(secretName) {
  if (!secretName) throw new Error('secrets.get: secretName is required');
  
  // Cache hit - fast path
  if (cache[secretName]) return cache[secretName];
  
  // Already fetching this secret in another promise - join it
  if (inFlight[secretName]) return inFlight[secretName];
  
  const promise = (async () => {
    try {
      const client = getClient();
      const cmd = new GetSecretValueCommand({ SecretId: secretName });
      const result = await client.send(cmd);
      
      let parsed;
      if (result.SecretString) {
        try {
          parsed = JSON.parse(result.SecretString);
        } catch (e) {
          // Some secrets are plain strings (like a single API key) rather than JSON
          // Wrap in an object with the secret name as the key for consistency
          parsed = { value: result.SecretString };
        }
      } else if (result.SecretBinary) {
        // Binary secrets - rarely used, but support them anyway
        parsed = { binary: Buffer.from(result.SecretBinary).toString('utf8') };
      } else {
        throw new Error('Secret has neither SecretString nor SecretBinary');
      }
      
      cache[secretName] = parsed;
      return parsed;
    } finally {
      delete inFlight[secretName];
    }
  })();
  
  inFlight[secretName] = promise;
  return promise;
}

/**
 * Get a specific key from a secret. Falls back to process.env if Secrets Manager
 * is unreachable or the key is missing - useful for local development and
 * graceful degradation.
 *
 * @param {string} secretName - the secret to load
 * @param {string} keyName - the key within the secret
 * @param {string} [envFallback] - env var name to fall back to (defaults to keyName)
 * @returns {Promise<string|undefined>}
 */
async function getKey(secretName, keyName, envFallback) {
  const fallbackEnv = envFallback || keyName;
  try {
    const secret = await get(secretName);
    if (secret && secret[keyName] !== undefined) {
      return secret[keyName];
    }
  } catch (e) {
    console.warn('secrets.getKey: ' + secretName + ' load failed, falling back to env:', e.message);
  }
  // Fall back to env var
  return process.env[fallbackEnv];
}

/**
 * Clear the cache. Useful for testing or after a known secret rotation.
 */
function clearCache() {
  for (const k of Object.keys(cache)) delete cache[k];
}

module.exports = { get, getKey, clearCache };
