// @ts-check
// Single sign-on adapter interface. NOT IMPLEMENTED: no identity provider is connected.
// Email and password sign-in (server/auth.js) is the active method. This file defines the
// shape an OpenID Connect implementation must have so that it can be added without
// touching the rest of the application, and it refuses to pretend to be configured.

/**
 * @typedef {Object} SsoConfig
 * @property {string} issuer      OpenID Connect issuer URL, e.g. the tenant-specific Entra ID issuer
 * @property {string} clientId
 * @property {string} clientSecret Stored encrypted (encryptSecret); never sent to the browser
 * @property {string} redirectUri  Must exactly match the redirect registered with the provider
 * @property {string[]} [allowedDomains] Email domains permitted to sign in
 *
 * @typedef {Object} SsoIdentity
 * @property {string} subject  Stable provider user id (the `sub` claim)
 * @property {string} email    Verified email
 * @property {string} name
 *
 * @typedef {Object} SsoAdapter
 * @property {() => boolean} configured
 * @property {(state: string, nonce: string, codeChallenge: string) => string} authorizeUrl
 * @property {(code: string, codeVerifier: string, nonce: string) => Promise<SsoIdentity>} exchange
 * @property {() => Promise<{ok: boolean, detail: string}>} test
 */

const notConfigured = () => { throw Object.assign(new Error('Single sign-on is not configured.'), { code: 'SSO_NOT_CONFIGURED' }); };

/**
 * Returns the adapter for the given configuration. Until an implementation is written and
 * verified against a real tenant, this always returns an adapter that reports "not configured".
 * @param {SsoConfig | null} [_config]
 * @returns {SsoAdapter}
 */
export function ssoAdapter(_config = null) {
  return {
    configured: () => false,
    authorizeUrl: notConfigured,
    exchange: async () => notConfigured(),
    test: async () => ({ ok: false, detail: 'No single sign-on implementation is installed. Email and password sign-in is active.' }),
  };
}

// Implementation notes for whoever builds this:
//  - Authorization code flow with PKCE; validate state and nonce; verify the ID token signature
//    against the provider's published keys, plus issuer, audience and expiry.
//  - Map the identity to an existing invited user by verified email. Do not auto-create users
//    or assign roles from provider groups without an explicit administrator decision.
//  - On success call createSession() from server/auth.js so cookies, CSRF and revocation
//    behave exactly as they do for password sign-in. Live only; Demo keeps role preview.
