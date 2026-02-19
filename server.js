require('dotenv').config()

// Prevent a single unhandled async error from crashing the server
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err)
})

const express = require('express')
const cookieParser = require('cookie-parser')
const path = require('path')
const ltiRouter = require('./src/lti')
const oauthRouter = require('./src/oauth')
const registrationRouter = require('./src/registration')
const uiRouter = require('./src/routes/ui')

const app = express()

// Trust Render's load balancer so req.protocol returns 'https' correctly
app.set('trust proxy', 1)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Root — tool must be launched from Blackboard
app.get('/', (req, res) => res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Rubric Transfer</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#475569}</style>
</head><body>
<h2>Rubric Transfer</h2>
<p>This tool must be launched from within a Blackboard course.</p>
<p>Contact your administrator if you need access.</p>
</body></html>`))

// LTI Dynamic Registration
app.use('/', registrationRouter)

// OAuth 3LO
app.use('/', oauthRouter)

// LTI 1.3 endpoints
app.use('/', ltiRouter)

// UI routes
app.use('/ui', uiRouter)

const port = parseInt(process.env.PORT || '3000', 10)
app.listen(port, () => console.log(`[bb-rubric-transfer] listening on :${port}`))
