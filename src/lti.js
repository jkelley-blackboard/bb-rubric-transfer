/**
 * Minimal LTI 1.3 provider — no database required.
 *
 * Flow:
 *   1. Blackboard sends GET/POST to /login (OIDC initiation)
 *      → we redirect to BB's auth endpoint with required params
 *   2. Blackboard POSTs a signed JWT (id_token) to /launch
 *      → we verify it using BB's public JWKS, extract courseId,
 *        store it in a signed cookie, redirect to /ui/home
 *
 * Required env vars:
 *   LTI_CLIENT_ID      - the Client ID from BB's LTI tool registration
 *   LTI_PLATFORM_URL   - your BB base URL e.g. https://learn.example.edu
 *   LTI_COOKIE_SECRET  - any long random string for signing the session cookie
 */

const express = require('express')
const router = express.Router()
const https = require('https')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')

// ── helpers ──────────────────────────────────────────────────────────────────

/** Fetch Blackboard's public JWKS and find the key matching `kid` */
function fetchPublicKey (platformUrl, kid) {
  return new Promise((resolve, reject) => {
    const url = `${platformUrl}/learn/api/public/v1/lti/tools/jwks`
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const { keys } = JSON.parse(data)
          const key = keys.find(k => k.kid === kid) || keys[0]
          if (!key) return reject(new Error('No matching JWK found'))
          // Convert JWK to PEM using Node's built-in crypto
          const pubKey = crypto.createPublicKey({ key, format: 'jwk' })
          resolve(pubKey.export({ type: 'spki', format: 'pem' }))
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

/** Simple signed cookie — base64(payload):base64(hmac) */
function signCookie (data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyCookie (cookie, secret) {
  if (!cookie) return null
  const [payload, sig] = cookie.split('.')
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  if (sig !== expected) return null
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()) }
  catch { return null }
}

// ── LTI routes ────────────────────────────────────────────────────────────────

const CLIENT_ID   = process.env.LTI_CLIENT_ID
const PLATFORM    = (process.env.LTI_PLATFORM_URL || '').replace(/\/$/, '')
const COOKIE_SECRET = process.env.LTI_COOKIE_SECRET || 'change-me-in-production'

// Store nonces in memory (fine for single-instance; expires after 5 min)
const nonces = new Map()
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [k, v] of nonces) if (v < cutoff) nonces.delete(k)
}, 60_000)

/**
 * Step 1 — OIDC Login Initiation
 * Blackboard sends the user here first. We redirect to BB's auth endpoint.
 */
router.get('/login', handleLogin)
router.post('/login', handleLogin)

function handleLogin (req, res) {
  const p = { ...req.query, ...req.body }

  const nonce = crypto.randomBytes(16).toString('hex')
  const state = crypto.randomBytes(16).toString('hex')
  nonces.set(nonce, Date.now())

  // BB's OIDC auth endpoint
  const authUrl = new URL(`${PLATFORM}/learn/api/public/v1/lti/oidc/authorize`)
  authUrl.searchParams.set('response_type', 'id_token')
  authUrl.searchParams.set('response_mode', 'form_post')
  authUrl.searchParams.set('scope', 'openid')
  authUrl.searchParams.set('prompt', 'none')
  authUrl.searchParams.set('client_id', CLIENT_ID || p.client_id)
  authUrl.searchParams.set('redirect_uri', p.target_link_uri || `${req.protocol}://${req.get('host')}/launch`)
  authUrl.searchParams.set('login_hint', p.login_hint)
  authUrl.searchParams.set('lti_message_hint', p.lti_message_hint || '')
  authUrl.searchParams.set('nonce', nonce)
  authUrl.searchParams.set('state', state)

  res.redirect(authUrl.toString())
}

/**
 * Step 2 — LTI Launch (id_token POST)
 * Blackboard posts the signed JWT here after the user authenticates.
 */
router.post('/launch', async (req, res) => {
  const idToken = req.body.id_token
  if (!idToken) return res.status(400).send('Missing id_token')

  try {
    // Decode header to get kid, then fetch matching public key
    const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString())
    const publicKey = await fetchPublicKey(PLATFORM, header.kid)

    // Verify signature and standard claims
    const claims = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      audience: CLIENT_ID
    })

    // Validate nonce (replay protection)
    if (!nonces.has(claims.nonce)) {
      return res.status(400).send('Invalid or expired nonce')
    }
    nonces.delete(claims.nonce)

    // Extract course context
    const context = claims['https://purl.imsglobal.org/spec/lti/claim/context']
    const courseId = context?.id || ''

    // Store courseId in a signed cookie (no DB needed)
    const sessionData = { courseId, exp: Date.now() + 3600_000 }
    res.cookie('lti_session', signCookie(sessionData, COOKIE_SECRET), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'None',   // required for iframe embedding in BB
      maxAge: 3600_000
    })

    return res.redirect(`/ui/home?courseId=${encodeURIComponent(courseId)}`)
  } catch (err) {
    console.error('[LTI] launch error:', err.message)
    return res.status(400).send(`LTI launch failed: ${err.message}`)
  }
})

// Export the cookie verifier so UI routes can use it if needed
router.verifyCookie = (cookie) => verifyCookie(cookie, COOKIE_SECRET)

module.exports = router
