// Shopify application-only access tokens (client credentials grant signed with app private key).
// Replaces non-expiring offline tokens (deprecated by Shopify: delisting 2027-01-01, Admin API 403 from 2027-04-01).
// See: https://shopify.dev/docs/apps/build/authentication-authorization/application-only-access-tokens
//
// Env:
//   SHOPIFY_APP_TOKENS            - 'all' or comma separated myshopify domains (rollout); empty = disabled (old token used)
//   SHOPIFY_APP_PRIVATE_KEY_PATH  - path to private key PEM (RS256), its public JWK is added in Dev Dashboard
//   SHOPIFY_APP_KEY_ID            - "kid" of the public key in Dev Dashboard

'use strict';

const crypto = require('crypto')
  , fs = require('fs')
  , superagent = require('superagent')
  , handy = require('@takinola/handy')
  ;

const REFRESH_BEFORE_MS = 5 * 60 * 1000;   // get new token 5 min before expiration
const ASSERTION_TTL_SEC = 60;
const OAUTH_PATH_PREFIX = '/admin/oauth/';

const tokens = new Map();     // domain -> {token, expiresAt}
const pending = new Map();    // domain -> Promise<token>
let privateKey = null;


/**
 * Is app-only token enabled for the shop (by SHOPIFY_APP_TOKENS env)
 * @param domain {string} myshopify domain
 * @return {boolean}
 */
function isEnabled(domain) {
  const value = (process.env.SHOPIFY_APP_TOKENS || '').trim().toLowerCase();
  if (!value || !domain) {
    return false;
  }
  if (value === 'all') {
    return true;
  }
  return value.split(',').map(s => s.trim()).includes(String(domain).toLowerCase());
}


function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}


function getPrivateKey() {
  if (!privateKey) {
    const keyPath = process.env.SHOPIFY_APP_PRIVATE_KEY_PATH;
    if (!keyPath) {
      throw new Error('app-token: SHOPIFY_APP_PRIVATE_KEY_PATH is not set');
    }
    privateKey = fs.readFileSync(keyPath, 'utf8');
  }
  return privateKey;
}


/**
 * Create signed client assertion (JWT, RS256) for the shop
 * @param domain {string} myshopify domain
 * @return {string}
 */
function createClientAssertion(domain) {
  const clientId = handy.system.systemGlobal.getConfig('shopify_api_key');
  const kid = process.env.SHOPIFY_APP_KEY_ID;
  if (!kid) {
    throw new Error('app-token: SHOPIFY_APP_KEY_ID is not set');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: kid };
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: `https://${domain}/admin/oauth/access_token`,
    iat: now,
    exp: now + ASSERTION_TTL_SEC,
    jti: crypto.randomBytes(16).toString('hex'),
  };

  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(getPrivateKey());
  return unsigned + '.' + base64url(signature);
}


function requestToken(domain) {
  return superagent.post(`https://${domain}/admin/oauth/access_token`)
    .type('form')
    .send({
      grant_type: 'client_credentials',
      client_id: handy.system.systemGlobal.getConfig('shopify_api_key'),
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: createClientAssertion(domain),
    })
    .then(res => {
      const token = res.body && res.body.access_token;
      if (!token) {
        throw new Error(`app-token: no access_token in response for ${domain}`);
      }
      const expiresIn = parseInt(res.body.expires_in, 10) || 3600;
      tokens.set(domain, { token: token, expiresAt: Date.now() + expiresIn * 1000 });
      return token;
    })
    .catch(err => {
      const body = err && err.response && err.response.body;
      const details = body ? JSON.stringify(body) : (err && err.message);
      throw new Error(`app-token: token request failed for ${domain}: ${details}`);
    });
}


/**
 * Get valid app-only access token for the shop (cached until 5 min before expiration)
 * @param domain {string} myshopify domain
 * @return {Promise<string>}
 */
function getToken(domain) {
  const cached = tokens.get(domain);
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > Date.now()) {
    return Promise.resolve(cached.token);
  }
  if (pending.has(domain)) {
    return pending.get(domain);
  }
  const promise = requestToken(domain)
    .then(token => {
      pending.delete(domain);
      return token;
    }, err => {
      pending.delete(domain);
      throw err;
    });
  pending.set(domain, promise);
  return promise;
}


/**
 * Make superagent request use app-only token (header is set right before sending)
 * @param request {Request} superagent request
 * @param domain {string} myshopify domain
 * @return {Request}
 */
function attachToSuperagent(request, domain) {
  if (!isEnabled(domain)) {
    return request;
  }
  const originalEnd = request.end;
  request.end = function (callback) {
    getToken(domain)
      .then(token => {
        this.set('X-Shopify-Access-Token', token);
        originalEnd.call(this, callback);
      }, err => {
        if (callback) {
          callback(err);
        }
      });
    return this;
  };
  return request;
}


/**
 * Make shopify-node-api instance use app-only token (token is set right before each request)
 * @param api {ShopifyAPI} shopify-node-api instance
 * @param domain {string} myshopify domain
 * @return {ShopifyAPI}
 */
function attachToShopifyApi(api, domain) {
  if (!isEnabled(domain)) {
    return api;
  }
  const originalMakeRequest = api.makeRequest;
  api.makeRequest = function (endpoint, method, data, callback, retry) {
    if (String(endpoint).indexOf(OAUTH_PATH_PREFIX) === 0) {
      return originalMakeRequest.call(this, endpoint, method, data, callback, retry);
    }
    getToken(domain)
      .then(token => {
        this.config.access_token = token;
        originalMakeRequest.call(this, endpoint, method, data, callback, retry);
      }, err => {
        if (callback) {
          callback(err);
        }
      });
  };
  return api;
}


module.exports = {
  isEnabled,
  getToken,
  attachToSuperagent,
  attachToShopifyApi,
};
