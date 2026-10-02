// Browser security headers for every response of server/server.mjs (#583).
//
// Every response carries nosniff, no-referrer and a refusal to be framed (X-Frame-Options DENY and CSP frame-ancestors
// 'none'), so the signed-in app cannot be laid under another site's page to click a buy-off, an approval or Send to QA.
// A response that is not a page (JSON, a stylesheet, a script file, an image, an archive download) gets a policy that
// allows nothing: it is never a document that runs anything. Evidence bytes are also a sandboxed attachment.
//
// The page is one file with its scripts inline, so its policy lists the SHA-256 of each inline script it serves,
// computed from the exact HTML of that response (the build stamp and the server context script change it, so the list
// is never written by hand). 'unsafe-inline' is not used for scripts: an injected <script> or event handler does not
// run. The page writes two inline handler attributes into its own markup (INLINE_HANDLERS); they are allowed by hash
// through 'unsafe-hashes', and tests/test_server_headers.mjs fails if a new one appears in index.html. Styles keep
// 'unsafe-inline': the app sets style attributes throughout its templates, and those cannot be listed by hash.
// Every runtime dependency is local, so scripts, styles, fonts and images come from this server only; fonts and small
// images may also be data: URLs, and recordings, prints and the training certificate preview (an iframe) are blob:
// URLs the page made itself.
// connect-src is this server only, plus any origin the operator lists in FLIGHT_CSP_CONNECT_SRC (an identity provider,
// the optional mirror or the integration bridge configured in index.html).
import { createHash } from 'node:crypto';

export const BASE_HEADERS = Object.freeze({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
export const NON_PAGE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const EVIDENCE_CSP = `${NON_PAGE_CSP}; sandbox`;
export const INLINE_HANDLERS = Object.freeze(['window.print()', 'skSignOut()']);

export const hashSource = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

// The HTML parser ends a script at the first "</script" followed by white space, "/" or ">", and turns CR LF and a
// lone CR into LF before the browser hashes the text, so both are done the same way here.
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script[\s/>]/gi;
const hashCache = new Map();
export function inlineScriptHashes(html) {
  const text = String(html);
  if (hashCache.has(text)) return hashCache.get(text);
  const hashes = new Set();
  for (const [, attributes, body] of text.matchAll(SCRIPT)) if (!/\bsrc\s*=/i.test(attributes)) hashes.add(hashSource(body.replace(/\r\n?/g, '\n')));
  const list = Object.freeze([...hashes]);
  if (hashCache.size >= 8) hashCache.delete(hashCache.keys().next().value);
  hashCache.set(text, list);
  return list;
}

// FLIGHT_CSP_CONNECT_SRC: origins separated by spaces or commas, each http(s) or ws(s) with no credentials, path, query
// or fragment, and no wildcard. The written entry may hold no delimiter (; , quote, backslash, *, %), and the host as
// parsed (an international name becomes its punycode form) must be letters, digits, dots and hyphens or a bracketed
// IPv6 address, so an entry cannot end connect-src and add a directive of its own (a frame-ancestors that would let a
// site frame the app) or decode into a wildcard. Anything else is refused, so a typo cannot widen the policy (a bare *, a scheme alone,
// https://* or https://*.example.com would allow any host or any subdomain). A valid spelling that is not canonical (a default port, capitals in the host) is stored as its origin. The
// refusal names the entry by its position and never repeats it: an entry typed by mistake can hold a credential, and
// the startup error reaches the server log.
export function connectSources(value) {
  const origins = [];
  for (const [index, item] of String(value || '').split(/[\s,]+/).filter(Boolean).entries()) {
    let url = null;
    try { url = new URL(item); } catch {}
    if (!url || !['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.origin === 'null' || !/^(?:https?|wss?):\/\/[^/?#@\\;,'"*%\s]+\/?$/i.test(item) || !/^(?:(?:[a-z0-9-]+\.)*[a-z0-9-]+\.?|\[[0-9a-f:.]+\])$/.test(url.hostname) || url.username || url.password) {
      throw new Error(`FLIGHT_CSP_CONNECT_SRC entry ${index + 1} is not an origin (it is not repeated here, since it may hold a credential). List origins such as https://skyryse.okta.com, separated by spaces, with no wildcard, user name, password, path, query or fragment.`);
    }
    origins.push(url.origin);
  }
  return [...new Set(origins)];
}

export function pageCsp(scriptHashes, connect = []) {
  return [
    "default-src 'self'",
    `script-src 'self' ${[...scriptHashes, "'unsafe-hashes'", ...INLINE_HANDLERS.map(hashSource)].join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...connect].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

// Wraps res.writeHead so every response gets the base headers and the non-page policy, unless the route names its own
// Content-Security-Policy (a page) or adds to the headers (evidence).
export function withSecurityHeaders(res) {
  const writeHead = res.writeHead;
  res.writeHead = function (status, headers = {}) { return writeHead.call(this, status, { ...BASE_HEADERS, 'Content-Security-Policy': NON_PAGE_CSP, ...headers }); };
  return res;
}
