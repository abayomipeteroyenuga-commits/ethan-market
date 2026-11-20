'use strict';

const market = require('./market');

module.exports = async function marketWebhook(req, res) {
  const originalUrl = req.url;
  req.url = '/api/market/webhook';
  try {
    return await market(req, res);
  } finally {
    req.url = originalUrl;
  }
};

module.exports.config = { api: { bodyParser: false } };
