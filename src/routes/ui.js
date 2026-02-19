const express = require('express')
const router = express.Router()
router.use(express.urlencoded({ extended: true }))

const { listRubrics, getRubric, createRubric } = require('../rest/bbClient')
const { getTokenFromCookie } = require('../oauth')

// ── HTML shell ────────────────────────────────────────────────────────────────

const page = (title, body) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#1e293b;background:#f8fafc}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:28px 32px;margin-bottom:20px}
    h2{margin:0 0 4px;font-size:1.15rem}
    .sub{color:#64748b;font-size:0.85rem;margin:0 0 20px}
    label{display:block;font-weight:500;font-size:0.88rem;margin-bottom:5px;margin-top:14px}
    input[type=text]{width:100%;padding:9px 11px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.95rem}
    input[type=text]:focus{outline:2px solid #3b82f6;border-color:transparent}
    .btn{display:inline-block;margin-top:18px;padding:9px 22px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:0.9rem;cursor:pointer;text-decoration:none}
    .btn:hover{background:#1d4ed8}
    .btn-ghost{background:transparent;color:#2563eb;border:1px solid #2563eb;margin-left:10px}
    .btn-ghost:hover{background:#eff6ff}
    .rubric-list{list-style:none;padding:0;margin:0}
    .rubric-list li{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f1f5f9}
    .rubric-list li:last-child{border-bottom:none}
    .rubric-list label{margin:0;font-weight:400;font-size:0.95rem;cursor:pointer}
    .tag{display:inline-block;font-size:0.75rem;background:#f1f5f9;color:#475569;padding:2px 7px;border-radius:4px}
    .alert{padding:12px 16px;border-radius:7px;margin-bottom:16px;font-size:0.9rem}
    .alert-err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}
    .alert-ok{background:#f0fdf4;border:1px solid #86efac;color:#166534}
    code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:0.88rem}
  </style>
</head>
<body>${body}</body>
</html>`

// ── Token middleware ──────────────────────────────────────────────────────────

async function requireToken (req, res, next) {
  const result = await getTokenFromCookie(req.cookies?.lti_session, res)
  if (!result) {
    // Session expired or missing — send them back through OAuth
    const courseId = req.query.courseId || req.body?.destId || ''
    return res.redirect(`/oauth/start?courseId=${encodeURIComponent(courseId)}`)
  }
  req.bbToken = result.token
  next()
}

// ── Step 1: Enter source course ID ───────────────────────────────────────────

router.get('/home', requireToken, (req, res) => {
  const destCourseId = req.query.courseId || ''
  const err = req.query.err || ''

  res.send(page('Rubric Transfer', `
    <div class="card">
      <h2>Rubric Transfer</h2>
      <p class="sub">Copy rubrics from a source course into <code>${destCourseId}</code></p>
      ${err ? `<div class="alert alert-err">${decodeURIComponent(err)}</div>` : ''}
      <form method="GET" action="/ui/select-rubrics">
        <input type="hidden" name="destId" value="${destCourseId}"/>
        <label for="sourceId">Source course ID</label>
        <input type="text" id="sourceId" name="sourceId"
               placeholder="e.g. _123_1"/>
        <button class="btn" type="submit">Load rubrics →</button>
      </form>
    </div>
  `))
})

// ── Step 2: List rubrics from source course ───────────────────────────────────

router.get('/select-rubrics', requireToken, async (req, res) => {
  const { sourceId, destId } = req.query

  if (!sourceId) {
    return res.redirect(`/ui/home?courseId=${encodeURIComponent(destId || '')}&err=Please+enter+a+source+course+ID`)
  }

  let rubrics
  try {
    rubrics = await listRubrics(sourceId, req.bbToken)
  } catch (err) {
    const msg = err.response?.status === 404
      ? `Course ${sourceId} not found — check the ID and try again.`
      : `Error loading rubrics: ${err.message}`
    return res.redirect(`/ui/home?courseId=${encodeURIComponent(destId || '')}&err=${encodeURIComponent(msg)}`)
  }

  const results = rubrics.results || []
  if (results.length === 0) {
    return res.redirect(`/ui/home?courseId=${encodeURIComponent(destId || '')}&err=No+rubrics+found+in+that+course`)
  }

  const items = results.map(r => `
    <li>
      <input type="checkbox" name="rubricId" value="${r.id}" id="r_${r.id}"/>
      <label for="r_${r.id}">${r.title || r.id} <span class="tag">${r.rubricType || ''}</span></label>
    </li>`).join('')

  res.send(page('Select Rubrics', `
    <div class="card">
      <h2>Select rubrics to copy</h2>
      <p class="sub">From <code>${sourceId}</code> → into <code>${destId}</code></p>
      <form method="POST" action="/ui/import">
        <input type="hidden" name="sourceId" value="${sourceId}"/>
        <input type="hidden" name="destId" value="${destId}"/>
        <ul class="rubric-list">${items}</ul>
        <div>
          <button class="btn" type="submit">Import selected →</button>
          <a class="btn btn-ghost" href="/ui/home?courseId=${encodeURIComponent(destId)}">Back</a>
        </div>
      </form>
    </div>
  `))
})

// ── Step 3: Import ────────────────────────────────────────────────────────────

router.post('/import', requireToken, async (req, res) => {
  const { sourceId, destId } = req.body
  const rubricIds = Array.isArray(req.body.rubricId)
    ? req.body.rubricId
    : req.body.rubricId ? [req.body.rubricId] : []

  if (rubricIds.length === 0) {
    return res.redirect(`/ui/select-rubrics?sourceId=${encodeURIComponent(sourceId)}&destId=${encodeURIComponent(destId)}`)
  }

  const created = [], failed = []

  for (const rid of rubricIds) {
    try {
      const srcRubric = await getRubric(sourceId, rid, req.bbToken)
      const destRubric = await createRubric(destId, transformRubric(srcRubric), req.bbToken)
      created.push({ title: destRubric.title || srcRubric.title, id: destRubric.id })
    } catch (err) {
      failed.push({ id: rid, reason: err.response?.data?.message || err.message })
    }
  }

  const successItems = created.map(r =>
    `<li>&#x2705; <strong>${r.title}</strong> <span class="tag">${r.id}</span></li>`).join('')
  const failItems = failed.map(f =>
    `<li>&#x274C; <code>${f.id}</code> — ${f.reason}</li>`).join('')

  res.send(page('Import Complete', `
    <div class="card">
      <h2>Import complete</h2>
      <p class="sub">Results for <code>${destId}</code></p>
      ${created.length ? `<div class="alert alert-ok">${created.length} rubric(s) imported successfully.</div><ul class="rubric-list">${successItems}</ul>` : ''}
      ${failed.length ? `<div class="alert alert-err">${failed.length} failed.</div><ul class="rubric-list">${failItems}</ul>` : ''}
      <a class="btn" href="/ui/home?courseId=${encodeURIComponent(destId)}">Transfer more</a>
    </div>
  `))
})

function transformRubric (src) {
  return {
    title: src.title || 'Imported Rubric',
    description: src.description || '',
    rubricType: src.rubricType || 'Points',
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
