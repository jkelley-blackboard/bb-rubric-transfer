/**
 * 3-Legged OAuth (3LO) for Blackboard REST API
 *
 * Uses the one_time_session_token from the LTI 1.3 JWT to silently authorize
 * the instructor without showing a consent screen. This works because the
 * instructor is already logged into Blackboard when they click the LTI tool.
 *
 * Flow:
 *   1. LTI launch extracts one_time_session_token from JWT claims
 *   2. /oauth/start redirects to BB's authorizationcode endpoint with the token
 *   3. BB silently authorizes (no consent screen) and redirects to /oauth/callback
 *   4. App exchanges code for access+refresh tokens, stores in signed cookie
 *   5. All API calls run as the instructor — BB enforces their course permissions
 *
 * Required env vars:
 *   BB_KEY            - Application ID from Blackboard developer portal
 *   BB_SECRET         - Application secret
 *   LTI_PLATFORM_URL  - e.g. https://nahe.blackboard.com
 *   LTI_COOKIE_SECRET - for signing session cookies
 *   APP_URL           - e.g. https://bb-rubric-transfer.onrender.com
 */

const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const axios = require('axios')

const BB_BASE       = process.env.LTI_PLATFORM_URL
const BB_KEY        = process.env.BB_KEY
const BB_SECRET     = process.env.BB_SECRET
const COOKIE_SECRET = process.env.LTI_COOKIE_SECRET || 'change-me'
const APP_URL       = (process.env.APP_URL || '').replace(/\/$/, '')
const REDIRECT_URI  = `${APP_URL}/oauth/callback`

// ── Cookie helpers ────────────────────────────────────────────────────────────

function signCookie (data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url')
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyCookie (cookie) {
  if (!cookie) return null
  const [payload, sig] = cookie.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url')
  if (sig !== expected) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (data.exp && data.exp < Date.now()) return null
    return data
  } catch { return null }
}

function setCookie (res, data) {
  res.cookie('lti_session', signCookie(data), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'None',  // required for Blackboard iframe embedding
    maxAge: 8 * 3600_000
  })
}

// OAuth state stored in a short-lived signed cookie (survives across server restarts)
// rather than in-memory (which breaks on Render when instances restart between requests)

// ── Step 1: Start OAuth ───────────────────────────────────────────────────────

/**
 * GET /oauth/start?courseId=_123_1&one_time_session_token=...
 * Called after LTI launch. Redirects to BB's authorization endpoint.
 * The one_time_session_token bypasses the consent screen — instructor is
 * already logged in so BB silently authorizes them.
 */
router.get('/oauth/start', (req, res) => {
  const { courseId, one_time_session_token } = req.query

  const state = crypto.randomBytes(16).toString('hex')

  // Store state in a short-lived signed cookie — survives server restarts
  // unlike in-memory Maps which are wiped when Render spins up a new instance
  res.cookie('oauth_state', signCookie({ state, courseId, ts: Date.now() }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'None',
    maxAge: 10 * 60 * 1000  // 10 minutes
  })

  const authUrl = new URL(`${BB_BASE}/learn/api/public/v1/oauth2/authorizationcode`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', BB_KEY)
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('scope', 'read write')
  authUrl.searchParams.set('state', state)

  // Pass the one_time_session_token so BB skips the consent screen
  if (one_time_session_token) {
    authUrl.searchParams.set('one_time_session_token', one_time_session_token)
  }

  res.redirect(authUrl.toString())
})

// ── Step 2: OAuth Callback ────────────────────────────────────────────────────

/**
 * GET /oauth/callback?code=...&state=...
 * Blackboard redirects here after authorizing the instructor.
 */
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query

  if (error) {
    return res.status(400).send(`<h2>Authorization declined</h2><p>${error}</p>`)
  }

  // Recover state from cookie instead of in-memory map
  const savedCookie = verifyCookie(req.cookies?.oauth_state)
  if (!savedCookie || savedCookie.state !== state) {
    return res.status(400).send('<h2>Invalid or expired OAuth state — please try launching the tool again from Blackboard.</h2>')
  }
  const saved = savedCookie
  // Clear the state cookie
  res.clearCookie('oauth_state', { sameSite: 'None', secure: true })

  try {
    const resp = await axios.post(
      `${BB_BASE}/learn/api/public/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      { auth: { username: BB_KEY, password: BB_SECRET } }
    )

    const { access_token, refresh_token, expires_in } = resp.data

    setCookie(res, {
      courseId: saved.courseId,
      access_token,
      refresh_token,
      token_exp: Date.now() + (expires_in - 60) * 1000,
      exp: Date.now() + 8 * 3600_000
    })

    return res.redirect(`/ui/home?courseId=${encodeURIComponent(saved.courseId)}`)
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message
    console.error('[OAuth] token exchange failed:', detail)
    return res.status(500).send(`<h2>OAuth token exchange failed</h2><pre>${detail}</pre>`)
  }
})

// ── Token helper for ui.js ────────────────────────────────────────────────────

/**
 * Get a valid access token from the session cookie.
 * Silently refreshes using the refresh token if expired.
 */
async function getTokenFromCookie (cookieValue, res) {
  const session = verifyCookie(cookieValue)
  if (!session?.access_token) return null

  // Token still valid
  if (session.token_exp > Date.now()) {
    return { token: session.access_token }
  }

  // Token expired — try silent refresh
  if (!session.refresh_token) return null

  try {
    const resp = await axios.post(
      `${BB_BASE}/learn/api/public/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token
      }),
      { auth: { username: BB_KEY, password: BB_SECRET } }
    )

    const { access_token, refresh_token, expires_in } = resp.data
    const updated = {
      ...session,
      access_token,
      refresh_token: refresh_token || session.refresh_token,
      token_exp: Date.now() + (expires_in - 60) * 1000
    }

    if (res) setCookie(res, updated)
    return { token: access_token }
  } catch (err) {
    console.error('[OAuth] refresh failed:', err.response?.data || err.message)
    return null
  }
}

router.verifyCookie = verifyCookie
router.setCookie = setCookie
router.getTokenFromCookie = getTokenFromCookie

module.exports = router