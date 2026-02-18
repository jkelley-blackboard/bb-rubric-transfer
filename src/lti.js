const path = require('path')
const { Provider } = require('ltijs')

const LTI = new Provider(
  process.env.LTI_ENCRYPTION_KEY,                // random string
  { url: process.env.MONGO_URL || 'mongodb://localhost:27017/lti' },
  { staticPath: path.join(__dirname, 'views') }
)

// Basic app/launch routes (ltijs sets up /login and launch behind the scenes)
LTI.appUrl('/')     // main app URL
LTI.loginUrl('/login')

LTI.deploy().then(() => {
  // On successful LTI launch (valid OIDC + ID token)
  LTI.onConnect(async (token, req, res) => {
    const destContext = token?.platformContext?.context
    const destCourseId = destContext?.id // Blackboard courseId (destination)
    // Save in a simple session (ltijs attaches session to req) or pass via query
    req.session = req.session || {}
    req.session.destCourseId = destCourseId
    return res.redirect(`/ui/home?courseId=${encodeURIComponent(destCourseId || '')}`)
  })
}).catch(err => {
  console.error('[LTI] deploy error:', err)
})

module.exports = LTI
