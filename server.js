/**
 * Standalone Blackboard 3LO test
 * 
 * Deploy this as a separate Render service, or temporarily replace server.js.
 * Visit https://your-app.onrender.com/ to start the flow.
 * 
 * Required env vars:
 *   BB_KEY           - your app key (NOT the Application ID — the Key)
 *   BB_SECRET        - your app secret
 *   BB_URL           - https://nahe.blackboard.com
 *   APP_URL          - https://your-app.onrender.com
 *   PORT             - set automatically by Render
 */

require('dotenv').config()
const express = require('express')
const crypto = require('crypto')
const axios = require('axios')
const app = express()

const BB_URL      = process.env.BB_URL || process.env.LTI_PLATFORM_URL
const BB_KEY      = process.env.BB_KEY
const BB_SECRET   = process.env.BB_SECRET
const APP_URL     = (process.env.APP_URL || '').replace(/\/$/, '')
const CALLBACK    = `${APP_URL}/callback`

// Simple in-memory state (fine for a test, single instance)
let pendingState = null

app.get('/', (req, res) => {
  const authUrl = new URL(`${BB_URL}/learn/api/public/v1/oauth2/authorizationcode`)
  pendingState = crypto.randomBytes(16).toString('hex')

  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', BB_KEY)
  authUrl.searchParams.set('redirect_uri', CALLBACK)
  authUrl.searchParams.set('scope', 'read write')
  authUrl.searchParams.set('state', pendingState)

  console.log('[3LO] Starting auth, redirecting to:', authUrl.toString())

  res.send(`<!DOCTYPE html><html><body>
    <h2>Blackboard 3LO Test</h2>
    <p>Config:</p>
    <ul>
      <li>BB_URL: ${BB_URL}</li>
      <li>BB_KEY: ${BB_KEY}</li>
      <li>CALLBACK: ${CALLBACK}</li>
    </ul>
    <p><a href="${authUrl.toString()}">Click here to start 3LO auth →</a></p>
    <p><small>(Opens Blackboard login/consent page directly)</small></p>
  </body></html>`)
})

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query

  console.log('[3LO callback] query:', req.query)

  if (error) {
    return res.send(`<h2>Error from BB:</h2><pre>${error}</pre>`)
  }

  if (state !== pendingState) {
    return res.send(`<h2>State mismatch</h2><p>Expected: ${pendingState}</p><p>Got: ${state}</p>`)
  }

  try {
    const resp = await axios.post(
      `${BB_URL}/learn/api/public/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK
      }),
      { auth: { username: BB_KEY, password: BB_SECRET } }
    )

    const { access_token, refresh_token, expires_in, user_id } = resp.data
    console.log('[3LO] Token exchange success! user_id:', user_id)

    // Test: fetch the current user's profile
    const me = await axios.get(
      `${BB_URL}/learn/api/public/v1/users/me`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    )

    res.send(`<!DOCTYPE html><html><body>
      <h2>✅ 3LO Success!</h2>
      <p><strong>User ID:</strong> ${user_id}</p>
      <p><strong>Username:</strong> ${me.data.userName}</p>
      <p><strong>Name:</strong> ${me.data.name?.given} ${me.data.name?.family}</p>
      <p><strong>Token expires in:</strong> ${expires_in}s</p>
      <p><strong>Has refresh token:</strong> ${!!refresh_token}</p>
      <hr>
      <pre>${JSON.stringify(me.data, null, 2)}</pre>
    </body></html>`)
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message
    console.error('[3LO] token exchange failed:', detail)
    res.send(`<h2>❌ Token exchange failed</h2><pre>${detail}</pre>`)
  }
})

const port = parseInt(process.env.PORT || '3000', 10)
app.listen(port, () => {
  console.log(`[3LO test] listening on :${port}`)
  console.log(`[3LO test] BB_URL: ${BB_URL}`)
  console.log(`[3LO test] BB_KEY: ${BB_KEY}`)
  console.log(`[3LO test] CALLBACK: ${CALLBACK}`)
})
