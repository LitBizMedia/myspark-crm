// api/square/config.js (Lambda version - Secrets Manager)
//
// GET /api/square/config
//
// Returns public Square configuration for client SDK initialization.
//
// CREDENTIALS: appId and env loaded from Secrets Manager.

const { getOAuthAppId, getSquareEnv } = require('./lib/square');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const [appId, env] = await Promise.all([
    getOAuthAppId(),
    getSquareEnv()
  ]);
  
  if (!appId) {
    return res.status(500).json({ error: 'Square App ID not configured' });
  }
  
  return res.status(200).json({
    appId: appId,
    env: env
  });
}

exports.handler = wrap(handler);
