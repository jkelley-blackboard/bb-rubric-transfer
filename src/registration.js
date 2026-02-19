/**
 * LTI Advantage Dynamic Registration + JWKS endpoint
 *
 * Blackboard requires a jwks_uri in the registration document.
 * We generate an RSA keypair on first boot and expose the public key at /jwks.
 * The keypair is persisted to /tmp (survives restarts on paid Render plans;
 * on free/starter it resets on redeploy — that's fine, just re-register).
 *
 * Tool Initiation URL to give the BB admin:
 *   https://your-app.onrender.com/registration
 */

const express = require('express')
const router = express.Router()
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const KEYS_FILE = path.join('/tmp', 'lti_keypair.json')
const REG_FILE  = path.join('/tmp', 'lti_registration.json')

// ── Keypair ───────────────────────────────────────────────────────────────────

function loadOrCreateKeypair () {
  if (fs.existsSync(KEYS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
      return saved
    } catch { /* regenerate below */ }
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  })

  const kid = crypto.randomBytes(8).toString('hex')
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }

  const keypair = {
    kid,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicJwk: jwk
  }

  fs.writeFileSync(KEYS_FILE, JSON.stringify(keypair, null, 2))
  console.log('[LTI] Generated new RSA keypair, kid:', kid)
  return keypair
}

// Load keypair at module init so /jwks is always ready
const KEYPAIR = loadOrCreateKeypair()

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

// ── JWKS endpoint ─────────────────────────────────────────────────────────────

/**
 * GET /jwks
 * Returns our public key in JWK Set format.
 * Blackboard calls this to verify any JWTs we sign (e.g. deep linking responses).
 */
router.get('/jwks', (req, res) => {
  res.json({ keys: [KEYPAIR.publicJwk] })
})

// ── Registration endpoint ─────────────────────────────────────────────────────

/**
 * GET /registration
 * Tool Initiation URL — paste this into Blackboard's Dynamic Registration page.
 * BB redirects the admin's browser here with openid_configuration + registration_token.
 */
router.get('/registration', async (req, res) => {
  const { openid_configuration, registration_token } = req.query

  if (!openid_configuration) {
    return res.send(`
      <h2>LTI Dynamic Registration</h2>
      <p>This is the <strong>Tool Initiation URL</strong> for dynamic registration.</p>
      <p>Paste it into Blackboard's LTI Dynamic Registration page — don't open it directly.</p>
      <p><code>${req.protocol}://${req.get('host')}/registration</code></p>
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
    const toolRegistration = {
      client_name: 'BB Rubric Transfer',

      // jwks_uri is REQUIRED by Blackboard — points to our /jwks endpoint
      jwks_uri: `${toolUrl}/jwks`,

      redirect_uris: [`${toolUrl}/launch`],
      initiate_login_uri: `${toolUrl}/login`,

      'https://purl.imsglobal.org/spec/lti-tool-configuration': {
        domain: req.get('host'),
        target_link_uri: `${toolUrl}/launch`,
        // Request roles claim so we can enforce instructor-only in /launch
        claims: ['iss', 'sub', 'name', 'email',
          'https://purl.imsglobal.org/spec/lti/claim/roles'],
        messages: [
          {
            type: 'LtiResourceLinkRequest',
            target_link_uri: `${toolUrl}/launch`,
            label: 'Rubric Transfer',
            // course_tool = Course Management panel (Original) + Books & Tools (Ultra)
            // Instructor/course builder only — students cannot see or access this.
            placements: [
              {
                type: 'course_tool',
                target_link_uri: `${toolUrl}/launch`,
                label: 'Rubric Transfer',
                placement: 'course_tool',
                allowStudentAccess: false
              }
            ]
          }
        ]
      },

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
    const savedReg = {
      client_id: clientId,
      platform_url: new URL(openid_configuration).origin,
      platform_oidc_url: openid_configuration,
      platform_auth_url: openidConfig.authorization_endpoint,
      platform_jwks_url: openidConfig.jwks_uri,
      registered_at: new Date().toISOString()
    }

    fs.writeFileSync(REG_FILE, JSON.stringify(savedReg, null, 2))

    console.log('\n╔══════════════════════════════════════════════════╗')
    console.log('║         LTI REGISTRATION COMPLETE                ║')
    console.log('╠══════════════════════════════════════════════════╣')
    console.log(`║  LTI_CLIENT_ID     = ${clientId}`)
    console.log(`║  LTI_PLATFORM_URL  = ${savedReg.platform_url}`)
    console.log(`║  LTI_JWKS_URL      = ${savedReg.platform_jwks_url}`)
    console.log('╚══════════════════════════════════════════════════╝\n')

    // Step 5: Return success page to the admin
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Registration Complete</title>
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
          .box { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 24px; }
          .env { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 0.85em; line-height: 1.8; }
          code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>✅ Registration Complete</h2>
          <p>BB Rubric Transfer has been registered with Blackboard.</p>
          <h3>Set these in Render → Environment:</h3>
          <div class="env">
            LTI_CLIENT_ID=${clientId}<br>
            LTI_PLATFORM_URL=${savedReg.platform_url}<br>
            LTI_JWKS_URL=${savedReg.platform_jwks_url}
          </div>
          <p style="margin-top:16px; color:#64748b; font-size:0.9em">
            After saving the env vars, trigger a manual redeploy in Render.
          </p>
        </div>
      </body>
      </html>
    `)

  } catch (err) {
    console.error('[DynReg] Registration error:', err.message)
    res.status(500).send(`
      <h2>Registration Failed</h2>
      <pre>${err.message}</pre>
      <p>Check the Render logs for details.</p>
    `)
  }
})

// ── Load saved registration ───────────────────────────────────────────────────

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
  // Fall back to file written during registration
  if (fs.existsSync(REG_FILE)) {
    try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')) }
    catch { /* fall through */ }
  }
  return null
}

router.getRegistration = getRegistration
module.exports = router
