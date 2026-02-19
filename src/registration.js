/**
 * LTI Advantage Dynamic Registration
 *
 * Flow:
 *   1. BB admin pastes your Tool Initiation URL into Blackboard:
 *        https://your-app.onrender.com/registration
 *
 *   2. Blackboard GETs /registration?openid_configuration=...&registration_token=...
 *      → your tool fetches BB's OpenID config from that URL
 *      → your tool POSTs a registration document back to BB's registration endpoint
 *      → BB responds with the client_id and platform details
 *      → your tool saves them to a local JSON file (written to /tmp or process.env)
 *      → your tool returns a success page to the admin
 *
 *   3. Admin sees "Registration complete" in Blackboard.
 *
 *   4. Restart the Render service — it reads the saved registration on boot.
 *
 * After registration, set these env vars on Render from the saved registration:
 *   LTI_CLIENT_ID      (written to console during registration)
 *   LTI_PLATFORM_URL   (your BB base URL)
 */

const express = require('express')
const router = express.Router()
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// Where we persist the registration between restarts.
// On Render free tier the filesystem is ephemeral, so we also log to console
// so you can copy the values into env vars.
const REG_FILE = path.join('/tmp', 'lti_registration.json')

// ── helpers ──────────────────────────────────────────────────────────────────

function httpsGet (url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    lib.get(url, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Failed to parse response from ${url}: ${e.message}`)) }
      })
    }).on('error', reject)
  })
}

function httpsPost (url, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const parsed = new URL(url)
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }
    const lib = url.startsWith('https') ? https : http
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch (e) { reject(new Error(`Failed to parse registration response: ${data}`)) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── Registration endpoint ─────────────────────────────────────────────────────

/**
 * GET /registration
 * This is the Tool Initiation URL you give to the Blackboard admin.
 * BB will redirect the admin's browser here with query params attached.
 */
router.get('/registration', async (req, res) => {
  const { openid_configuration, registration_token } = req.query

  if (!openid_configuration) {
    return res.status(400).send(`
      <h2>LTI Dynamic Registration</h2>
      <p>This URL is the <strong>Tool Initiation URL</strong> for dynamic registration.</p>
      <p>Paste it into Blackboard's LTI tool registration page — don't open it directly.</p>
      <p>URL: <code>${req.protocol}://${req.get('host')}/registration</code></p>
    `)
  }

  const toolUrl = `${req.protocol}://${req.get('host')}`

  try {
    // Step 1: Fetch Blackboard's OpenID configuration
    console.log('[DynReg] Fetching OpenID config from:', openid_configuration)
    const openidConfig = await httpsGet(openid_configuration)

    const registrationEndpoint = openidConfig.registration_endpoint
    if (!registrationEndpoint) {
      throw new Error('No registration_endpoint in OpenID config')
    }

    // Step 2: Build our tool registration document
    // This tells Blackboard everything about our tool
    const toolRegistration = {
      // Tool display name
      client_name: 'BB Rubric Transfer',

      // All redirect URIs our tool will accept id_tokens at
      redirect_uris: [`${toolUrl}/launch`],

      // The OIDC login initiation URL
      initiate_login_uri: `${toolUrl}/login`,

      // Where Blackboard should send the user after deep linking (not used here but required)
      // jwks_uri would go here if we signed our own JWTs — we don't need it for this tool

      // LTI-specific claims
      'https://purl.imsglobal.org/spec/lti-tool-configuration': {
        domain: req.get('host'),
        target_link_uri: `${toolUrl}/launch`,
        claims: ['iss', 'sub', 'name', 'email'],
        messages: [
          {
            type: 'LtiResourceLinkRequest',
            target_link_uri: `${toolUrl}/launch`,
            label: 'BB Rubric Transfer',
            placements: [
              {
                type: 'course_navigation',
                target_link_uri: `${toolUrl}/launch`,
                label: 'Rubric Transfer',
                placement: 'course_navigation'
              }
            ]
          }
        ]
      },

      // Standard OIDC fields
      response_types: ['id_token'],
      grant_types: ['implicit', 'client_credentials'],
      application_type: 'web',
      token_endpoint_auth_method: 'private_key_jwt',
      scope: 'openid https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly'
    }

    // Step 3: POST registration to Blackboard
    console.log('[DynReg] Registering with:', registrationEndpoint)
    const result = await httpsPost(registrationEndpoint, toolRegistration, registration_token)

    if (result.status !== 200 && result.status !== 201) {
      throw new Error(`Registration failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`)
    }

    const reg = result.body
    const clientId = reg.client_id

    // Step 4: Save registration details
    // These are what we need to put in env vars on Render
    const savedReg = {
      client_id: clientId,
      platform_url: new URL(openid_configuration).origin,
      platform_oidc_url: openid_configuration,
      platform_auth_url: openidConfig.authorization_endpoint,
      platform_jwks_url: openidConfig.jwks_uri,
      registered_at: new Date().toISOString()
    }

    fs.writeFileSync(REG_FILE, JSON.stringify(savedReg, null, 2))

    // Also log prominently so you can copy into Render env vars
    console.log('\n╔══════════════════════════════════════════════════╗')
    console.log('║         LTI REGISTRATION COMPLETE                ║')
    console.log('╠══════════════════════════════════════════════════╣')
    console.log(`║  LTI_CLIENT_ID     = ${clientId}`)
    console.log(`║  LTI_PLATFORM_URL  = ${savedReg.platform_url}`)
    console.log(`║  LTI_JWKS_URL      = ${savedReg.platform_jwks_url}`)
    console.log('╚══════════════════════════════════════════════════╝\n')

    // Step 5: Return success page to the admin's browser
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Registration Complete</title>
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
          .box { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 24px; }
          code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
          .env { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 0.85em; line-height: 1.8; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>✅ Registration Complete</h2>
          <p>BB Rubric Transfer has been successfully registered with Blackboard.</p>
          <h3>Set these environment variables in Render:</h3>
          <div class="env">
            LTI_CLIENT_ID=${clientId}<br>
            LTI_PLATFORM_URL=${savedReg.platform_url}<br>
            LTI_JWKS_URL=${savedReg.platform_jwks_url}
          </div>
          <p style="margin-top:16px; color:#64748b; font-size:0.9em">
            After setting the env vars, redeploy the Render service.
          </p>
        </div>
      </body>
      </html>
    `)

  } catch (err) {
    console.error('[DynReg] Registration error:', err)
    res.status(500).send(`
      <h2>Registration Failed</h2>
      <pre>${err.message}</pre>
      <p>Check the Render logs for details.</p>
    `)
  }
})

// ── Load saved registration ───────────────────────────────────────────────────

/**
 * Returns the saved registration, preferring env vars over the file.
 * Call this from lti.js when verifying launches.
 */
function getRegistration () {
  // Env vars take priority (set these in Render after first registration)
  if (process.env.LTI_CLIENT_ID && process.env.LTI_PLATFORM_URL) {
    return {
      client_id: process.env.LTI_CLIENT_ID,
      platform_url: process.env.LTI_PLATFORM_URL,
      platform_jwks_url: process.env.LTI_JWKS_URL ||
        `${process.env.LTI_PLATFORM_URL}/learn/api/public/v1/lti/tools/jwks`
    }
  }
  // Fall back to file (only available until next Render restart)
  if (fs.existsSync(REG_FILE)) {
    try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')) }
    catch { /* fall through */ }
  }
  return null
}

router.getRegistration = getRegistration
module.exports = router
