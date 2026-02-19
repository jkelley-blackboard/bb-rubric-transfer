require('dotenv').config()

const path = require('path')
const { Provider } = require('ltijs')  // ltijs v5: Provider is a singleton instance, not a class

const port = parseInt(process.env.PORT || '3000', 10)

// Configure via setup() — do NOT use "new Provider()"
Provider.setup(
  process.env.LTI_ENCRYPTION_KEY,
  { url: process.env.MONGO_URL || 'mongodb://localhost:27017/lti' },
  {
    staticPath: path.join(__dirname, 'src', 'views'),
    serverAddon: (app) => {
      // Health check — no DB/LTI dependency
      app.get('/health', (req, res) => res.json({ status: 'ok' }))

      // Mount UI routes
      const uiRouter = require('./src/routes/ui')
      app.use('/ui', uiRouter)
    }
  }
)

Provider.appUrl('/')
Provider.loginUrl('/login')

Provider.onConnect(async (token, req, res) => {
  const destContext = token?.platformContext?.context
  const destCourseId = destContext?.id
  req.session = req.session || {}
  req.session.destCourseId = destCourseId
  return res.redirect(`/ui/home?courseId=${encodeURIComponent(destCourseId || '')}`)
})

Provider.deploy({ port })
  .then(() => console.log(`[bb-rubric-transfer] listening on :${port}`))
  .catch(err => {
    console.error('[LTI] deploy error:', err)
    process.exit(1)
  })