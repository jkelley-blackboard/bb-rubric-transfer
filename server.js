require('dotenv').config()
const lti = require('./src/lti')
const uiRouter = require('./src/routes/ui')

const app = lti.app // ltijs exposes the Express instance
app.use('/ui', uiRouter)

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`[bb-rubric-transfer] listening on :${port}`)
})
