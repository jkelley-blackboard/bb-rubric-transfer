require('dotenv').config()
const lti = require('./src/lti')
const uiRouter = require('./src/routes/ui')

const app = lti.app // ltijs exposes the Express instance

// Health check endpoint for Render (responds immediately, no LTI/DB dependency)
app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.use('/ui', uiRouter)

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`[bb-rubric-transfer] listening on :${port}`)
})
