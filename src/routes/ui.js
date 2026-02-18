const express = require('express')
const router = express.Router()
router.use(express.urlencoded({ extended: true }))

const {
  listCourses, listRubrics, getRubric, createRubric
} = require('../rest/bbClient')

// Home: pick a source course (destination is from LTI launch)
router.get('/home', async (req, res) => {
  const destCourseId = req.query.courseId || (req.session && req.session.destCourseId) || ''
  const courses = await listCourses()
  const options = (courses.results || []).map(c =>
    `<option value="${c.id}">${c.name || c.id} (${c.courseId || c.id})</option>`
  ).join('')
  res.send(`
    <h2>Import rubrics into destination course: <code>${destCourseId}</code></h2>
    <form method="GET" action="/ui/select-rubrics">
      <label>Source course:</label>
      <select name="sourceId">${options}</select>
      <input type="hidden" name="destId" value="${destCourseId}"/>
      <button type="submit">Next</button>
    </form>
  `)
})

// List rubrics from selected source course
router.get('/select-rubrics', async (req, res) => {
  const { sourceId, destId } = req.query
  const rubrics = await listRubrics(sourceId)
  const list = (rubrics.results || []).map(r => `
    <div>
      <label>
        <input type="checkbox" name="rubricId" value="${r.id}"/>
        ${r.title || r.id} (id: ${r.id})
      </label>
    </div>`).join('')

  res.send(`
    <h3>Select rubrics from <code>${sourceId}</code> to import into <code>${destId}</code></h3>
    <form method="POST" action="/ui/import">
      ${list}
      <input type="hidden" name="sourceId" value="${sourceId}"/>
      <input type="hidden" name="destId" value="${destId}"/>
      <button type="submit">Import</button>
    </form>
  `)
})

// Import selected rubrics: GET (A) → transform → POST (B)
router.post('/import', async (req, res) => {
  const sourceId = req.body.sourceId
  const destId = req.body.destId
  const rubricIds = Array.isArray(req.body.rubricId) ? req.body.rubricId
                   : req.body.rubricId ? [req.body.rubricId] : []

  const created = []
  for (const rid of rubricIds) {
    const srcRubric = await getRubric(sourceId, rid)
    const payload = transformRubricForCreate(srcRubric)
    const destRubric = await createRubric(destId, payload)
    created.push({ source: rid, dest: destRubric.id, title: destRubric.title })
  }

  res.send(`
    <h3>Imported ${created.length} rubric(s) into <code>${destId}</code></h3>
    <pre>${JSON.stringify(created, null, 2)}</pre>
    <a href="/ui/home?courseId=${encodeURIComponent(destId)}">Back</a>
  `)
})

// Map GET rubric schema → POST create schema. Verify against your Learn Swagger.
function transformRubricForCreate (src) {
  return {
    title: src.title || 'Imported Rubric',
    description: src.description || '',
    rubricType: src.rubricType || 'Points', // Points | Percentage | PointsRange | PercentageRange
    rows: (src.rows || []).map(row => ({
      title: row.title,
      cells: (row.cells || []).map(cell => ({
        description: cell.description,
        points: cell.points
      }))
    }))
  }
}

module.exports = router
