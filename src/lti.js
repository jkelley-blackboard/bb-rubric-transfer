const path = require('path')
const { Provider } = require('ltijs')

const LTI = new Provider(
  process.env.LTI_ENCRYPTION_KEY,
  { url: process.env.MONGO_URL || 'mongodb://localhost:27017/lti' },
  { staticPath: path.join(__dirname, 'views') }
)

// Basic app/launch routes (ltijs sets up /login and launch behind the scenes)
LTI.appUrl('/')
LTI.loginUrl('/login')

LTI.deploy().then(() => {
  // On successful LTI launch (valid OIDC + ID token)
  LTI.onConnect(async (token, req, res) => {
    const destContext = token?.platformContext?.context
    const destCourseId = destContext?.id // Blackboard courseId (destination)
    req.session = req.session || {}
    req.session.destCourseId = destCourseId
    return res.redirect(`/ui/home?courseId=${encodeURIComponent(destCourseId || '')}`)
  })
}).catch(err => {
  console.error('[LTI] deploy error:', err)
  process.exit(1) // Exit so Render knows the service failed to start
})

module.exports = LTI
