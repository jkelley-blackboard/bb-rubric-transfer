require('dotenv').config()

const express = require('express')
const path = require('path')
const ltiRouter = require('./src/lti')
const registrationRouter = require('./src/registration')
const uiRouter = require('./src/routes/ui')

const app = express()

// Trust Render's load balancer so req.protocol returns 'https' correctly
app.set('trust proxy', 1)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// LTI Dynamic Registration
app.use('/', registrationRouter)

// LTI 1.3 endpoints
app.use('/', ltiRouter)

// UI routes
app.use('/ui', uiRouter)

const port = parseInt(process.env.PORT || '3000', 10)
app.listen(port, () => console.log(`[bb-rubric-transfer] listening on :${port}`))
