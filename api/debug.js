module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  return res.status(200).json({
    secretLength: secret.length,
    secretFirst4: secret.substring(0, 4),
    secretLast4: secret.substring(secret.length - 4),
    authHeader: req.headers['authorization'] || 'none',
    authLength: (req.headers['authorization'] || '').length
  });
};
