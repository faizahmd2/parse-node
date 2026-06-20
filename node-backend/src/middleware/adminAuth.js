function requireAdminSession(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireAdminSession };