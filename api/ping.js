module.exports = function handler(req, res) {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    runtime: process.version,
    msg: 'Vercel Serverless Function is alive ✅',
  });
};
