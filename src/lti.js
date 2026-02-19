/**
 * Minimal LTI 1.3 provider — no database required.
 *
 * Flow:
 *   1. Admin registers tool via /registration (dynamic registration)
 *   2. Blackboard sends user to /login (OIDC initiation)
 *      → we redirect to BB's auth endpoint
 *   3. Blackboard POSTs signed JWT to /launch
 *      → we verify it, extract courseId, set cookie, redirect to /ui/home
 */

const express = require('express')
const router = express.Router()
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { getRegistration } = require('./registration')

const COOKIE_SECRET = process.env.LTI_COOKIE_SECRET || 'change-me-in-production'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Fetch BB's public JWKS and return the PEM for the matching kid */
function fetchPublicKey (jwksUrl, kid) {
  return new Promise((resolve, reject) => {
    const lib = jwksUrl.startsWith('https') ? https : http
    lib.get(jwksUrl, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const { keys } = JSON.parse(data)
          const key = keys.find(k => k.kid === kid) || keys[0]
          if (!key) return reject(new Error('No matching JWK found'))
          const pubKey = crypto.createPublicKey({ key, format: 'jwk' })
          resolve(pubKey.export({ type: 'spki', format: 'pem' }))
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

/** Sign a cookie value so it can't be tampered with */
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

// In-memory nonce store (replay protection) — fine for single instance
const nonces = new Map()
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000
  for (const [k, v] of nonces) if (v < cutoff) nonces.delete(k)
}, 60_000)

// ── LTI routes ────────────────────────────────────────────────────────────────

/**
 * Step 1 — OIDC Login Initiation
 * Blackboard sends the user here first.
 * We redirect to BB's authorization endpoint.
 */
router.get('/login', handleLogin)
router.post('/login', handleLogin)

function handleLogin (req, res) {
  const reg = getRegistration()
  if (!reg) {
    return res.status(500).send(`
      <h2>Tool not registered</h2>
      <p>Complete dynamic registration first by visiting 
      <a href="/registration">/registration</a> from Blackboard's admin panel.</p>
    `)
  }

  // Debug — log exactly what BB sends so we can diagnose missing params
  console.log('[LTI /login] method:', req.method)
  console.log('[LTI /login] query:', JSON.stringify(req.query))
  console.log('[LTI /login] body:', JSON.stringify(req.body))

  const p = { ...req.query, ...req.body }
  const nonce = crypto.randomBytes(16).toString('hex')
  const state = crypto.randomBytes(16).toString('hex')
  nonces.set(nonce, Date.now())

  // Always use https for redirect_uri — ignore whatever target_link_uri says
  // (old registrations may have stored http://)
  const redirectUri = `https://${req.get('host')}/launch`

  // login_hint may arrive URL-encoded — decode it before forwarding
  const loginHint = p.login_hint ? decodeURIComponent(p.login_hint) : null

  if (!loginHint) {
    console.error('[LTI /login] login_hint missing! Full params:', JSON.stringify(p))
    return res.status(400).send('<h2>LTI Error</h2><p>login_hint missing from OIDC initiation request. Check Render logs.</p>')
  }

  // Blackboard SaaS always uses the developer portal as the OIDC auth endpoint,
  // regardless of which BB instance the tool is deployed on.
  const authUrl = new URL('https://developer.blackboard.com/api/v1/gateway/oidcauth')
  authUrl.searchParams.set('response_type', 'id_token')
  authUrl.searchParams.set('response_mode', 'form_post')
  authUrl.searchParams.set('scope', 'openid')
  authUrl.searchParams.set('prompt', 'none')
  authUrl.searchParams.set('client_id', reg.client_id)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('login_hint', loginHint)
  authUrl.searchParams.set('lti_message_hint', p.lti_message_hint || '')
  authUrl.searchParams.set('nonce', nonce)
  authUrl.searchParams.set('state', state)

  res.redirect(authUrl.toString())
}

/**
 * Step 2 — LTI Launch
 * Blackboard POSTs the signed id_token here.
 * We verify it and extract the course context.
 */
router.post('/launch', async (req, res) => {
  const reg = getRegistration()
  if (!reg) {
    return res.status(500).send('Tool not registered — complete dynamic registration first.')
  }

  const idToken = req.body.id_token
  if (!idToken) return res.status(400).send('Missing id_token')

  try {
    // Decode header to get kid, fetch matching public key from BB's JWKS
    const headerB64 = idToken.split('.')[0]
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString())
    const publicKey = await fetchPublicKey(reg.platform_jwks_url, header.kid)

    // Verify signature + standard claims
    const claims = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      audience: reg.client_id
    })

    // Validate nonce (replay attack protection)
    if (!nonces.has(claims.nonce)) {
      return res.status(400).send('Invalid or expired nonce — please try launching again.')
    }
    nonces.delete(claims.nonce)

    // Enforce instructor-only access — belt-and-suspenders beyond the placement type
    const roles = claims['https://purl.imsglobal.org/spec/lti/claim/roles'] || []
    const INSTRUCTOR_ROLES = [
      'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
      'http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper',
      'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
      'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator'
    ]
    const isInstructor = roles.some(r => INSTRUCTOR_ROLES.includes(r))
    if (!isInstructor) {
      return res.status(403).send('<h2>Access denied</h2><p>This tool is only available to instructors.</p>')
    }

    // Extract course context from LTI claims
    const context = claims['https://purl.imsglobal.org/spec/lti/claim/context']
    const courseId = context?.id || ''

    // Store in a signed cookie (no DB needed)
    const sessionData = { courseId, exp: Date.now() + 3600_000 }
    res.cookie('lti_session', signCookie(sessionData, COOKIE_SECRET), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'None',  // required for iframe embedding in Blackboard
      maxAge: 3600_000
    })

    return res.redirect(`/ui/home?courseId=${encodeURIComponent(courseId)}`)
  } catch (err) {
    console.error('[LTI] launch error:', err.message)
    return res.status(400).send(`
      <h2>LTI Launch Failed</h2>
      <pre>${err.message}</pre>
      <p>Check Render logs for details.</p>
    `)
  }
})

router.verifyCookie = (cookie) => verifyCookie(cookie, COOKIE_SECRET)

module.exports = router
