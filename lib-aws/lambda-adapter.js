// lib/lambda-adapter.js
//
// Converts AWS Lambda (API Gateway HTTP API v2.0 payload) into a Vercel-style
// req/res handler interface, so endpoints written in Vercel's style work
// without major changes.
//
// Usage in a Lambda function:
//
//   const { wrap } = require('./lib/lambda-adapter');
//
//   async function handler(req, res) {
//     // Standard Vercel-style code:
//     // req.method, req.headers, req.body (parsed), req.query
//     // res.status(200).json({...})
//     // res.setHeader(...)
//   }
//
//   exports.handler = wrap(handler);
//
// What this adapter handles:
//   - req.method, req.url, req.headers, req.body (parsed JSON or raw string), req.query
//   - res.status(code), res.json(data), res.send(text), res.setHeader(name, value)
//   - res.end(), res.json() can be called multiple times safely (last wins for header writes)
//   - Cookies set via res.setHeader('Set-Cookie', ...) - supports single or array
//   - CORS headers added automatically based on env config
//
// What it does NOT handle:
//   - Streaming responses (Lambda doesn't support streaming over API Gateway HTTP API anyway)
//   - File uploads via multipart - parse manually if needed
//   - WebSocket - use API Gateway WebSocket separately

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://mysparkplus.app,https://www.mysparkplus.app,https://aws.mysparkplus.app').split(',');

function buildCORSHeaders(originHeader) {
  // Echo back the request origin if it's in our allow list, otherwise the first allowed origin.
  // Browsers require an exact match (not wildcards) when sending credentials.
  const origin = ALLOWED_ORIGINS.includes(originHeader) ? originHeader : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Cookie',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

// Convert API Gateway event into a Vercel-style req object
function buildReq(event) {
  const headers = event.headers || {};
  
  // Normalize headers to lowercase (Vercel/Node convention)
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }
  
  // API Gateway HTTP API v2 sends cookies in event.cookies (array) instead of
  // event.headers.cookie. Merge them back into the cookie header so downstream
  // code can read them via req.headers.cookie.
  if (Array.isArray(event.cookies) && event.cookies.length > 0) {
    const existing = normalizedHeaders.cookie || '';
    const fromArray = event.cookies.join('; ');
    normalizedHeaders.cookie = existing ? existing + '; ' + fromArray : fromArray;
  }
  
  // Parse body - JSON if Content-Type allows, otherwise raw string
  let body = event.body;
  if (body && event.isBase64Encoded) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }
  
  const contentType = normalizedHeaders['content-type'] || '';
  if (body && contentType.includes('application/json')) {
    try {
      body = JSON.parse(body);
    } catch (e) {
      // Leave as string if parse fails - handler can decide what to do
    }
  }
  
  return {
    method:  (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET',
    url:     event.rawPath || (event.requestContext && event.requestContext.http && event.requestContext.http.path) || '/',
    headers: normalizedHeaders,
    body:    body,
    query:   event.queryStringParameters || {},
    
    // Vercel exposes some extras that endpoints sometimes use:
    cookies: parseCookies(normalizedHeaders.cookie || ''),
    
    // Original event for advanced cases
    _event: event
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (name) cookies[name] = decodeURIComponent(val);
  });
  return cookies;
}

// Build a Vercel-style res object that captures responses for Lambda return
function buildRes(corsHeaders) {
  let statusCode = 200;
  let body = '';
  let isJson = false;
  const headers = Object.assign({}, corsHeaders);
  const setCookies = []; // Multiple Set-Cookie values supported
  let ended = false;
  
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    
    json(data) {
      isJson = true;
      body = JSON.stringify(data);
      headers['Content-Type'] = 'application/json';
      ended = true;
      return res;
    },
    
    send(data) {
      if (typeof data === 'object' && data !== null) {
        return res.json(data);
      }
      body = String(data);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'text/plain; charset=utf-8';
      }
      ended = true;
      return res;
    },
    
    setHeader(name, value) {
      // Special case: Set-Cookie supports arrays / multiple values
      if (String(name).toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) {
          setCookies.push(...value);
        } else {
          setCookies.push(value);
        }
      } else {
        headers[name] = value;
      }
      return res;
    },
    
    getHeader(name) {
      return headers[name];
    },
    
    removeHeader(name) {
      delete headers[name];
      return res;
    },
    
    end(data) {
      if (data !== undefined) body = String(data);
      ended = true;
      return res;
    },
    
    redirect(urlOrCode, maybeUrl) {
      let code = 302;
      let url = urlOrCode;
      if (typeof urlOrCode === 'number') {
        code = urlOrCode;
        url = maybeUrl;
      }
      statusCode = code;
      headers['Location'] = url;
      ended = true;
      return res;
    },
    
    // Internal: extract the captured response for Lambda return
    _toLambdaResponse() {
      const response = {
        statusCode: statusCode,
        headers: headers,
        body: body
      };
      // API Gateway HTTP API v2.0 supports cookies as a separate top-level array
      if (setCookies.length > 0) {
        response.cookies = setCookies;
      }
      return response;
    }
  };
  
  return res;
}

// Main wrapper. Takes a Vercel-style handler, returns a Lambda handler.
function wrap(handler, options) {
  options = options || {};
  
  return async function lambdaHandler(event, context) {
    const requestOrigin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
    const corsHeaders = buildCORSHeaders(requestOrigin);
    
    // Handle CORS preflight automatically
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method)
      || event.httpMethod
      || 'GET';
    if (method === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: corsHeaders,
        body: ''
      };
    }
    
    const req = buildReq(event);
    const res = buildRes(corsHeaders);
    
    try {
      await handler(req, res);
      return res._toLambdaResponse();
    } catch (err) {
      console.error('[lambda-adapter] Handler threw:', err);
      console.error(err.stack);
      
      // Don't leak internal errors in production response
      const isDev = process.env.NODE_ENV === 'development' || process.env.AWS_SAM_LOCAL;
      return {
        statusCode: 500,
        headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          error: 'Internal server error',
          ...(isDev ? { detail: err.message, stack: err.stack } : {})
        })
      };
    }
  };
}

module.exports = { wrap, buildReq, buildRes };
