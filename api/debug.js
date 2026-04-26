module.exports = async (req, res) => {
  return res.status(200).json({
    hasCronSecret: !!process.env.CRON_SECRET,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasResendKey: !!process.env.RESEND_API_KEY
  });
};
