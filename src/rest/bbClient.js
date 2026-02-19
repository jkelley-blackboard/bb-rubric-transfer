const axios = require('axios')

const BB_BASE = process.env.LTI_PLATFORM_URL

function bbError (err) {
  const status = err.response?.status
  const body   = err.response?.data
  const detail = typeof body === 'object' ? JSON.stringify(body) : body
  const msg = `BB API ${status || 'network error'}: ${detail || err.message}`
  console.error('[bbClient]', msg)
  const wrapped = new Error(msg)
  wrapped.response = err.response
  return wrapped
}

function authHeader (token) {
  return { headers: { Authorization: `Bearer ${token}` } }
}

async function listRubrics (courseId, token) {
  try {
    const resp = await axios.get(
      `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/rubrics`,
      authHeader(token)
    )
    return resp.data
  } catch (err) { throw bbError(err) }
}

async function getRubric (courseId, rubricId, token) {
  try {
    const resp = await axios.get(
      `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/rubrics/${encodeURIComponent(rubricId)}`,
      authHeader(token)
    )
    return resp.data
  } catch (err) { throw bbError(err) }
}

async function createRubric (destCourseId, payload, token) {
  try {
    const resp = await axios.post(
      `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(destCourseId)}/rubrics`,
      payload,
      authHeader(token)
    )
    return resp.data
  } catch (err) { throw bbError(err) }
}

module.exports = { listRubrics, getRubric, createRubric }
