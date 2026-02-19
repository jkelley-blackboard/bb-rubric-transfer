const axios = require('axios')

// BB_BASE_URL is optional — falls back to LTI_PLATFORM_URL which is already required
const BB_BASE = process.env.BB_BASE_URL || process.env.LTI_PLATFORM_URL
const BB_KEY  = process.env.BB_KEY
const BB_SECRET = process.env.BB_SECRET

async function getAccessToken () {
  const resp = await axios.post(
    `${BB_BASE}/learn/api/public/v1/oauth2/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    { auth: { username: BB_KEY, password: BB_SECRET } }
  )
  return resp.data.access_token
}

// ---- Courses ----
async function listCourses () {
  const token = await getAccessToken()
  const resp = await axios.get(
    `${BB_BASE}/learn/api/public/v1/courses`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return resp.data
}

// ---- Rubrics (Source) ----
async function listRubrics (courseId) {
  const token = await getAccessToken()
  const resp = await axios.get(
    `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/rubrics`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return resp.data
}

async function getRubric (courseId, rubricId) {
  const token = await getAccessToken()
  const resp = await axios.get(
    `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/rubrics/${encodeURIComponent(rubricId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return resp.data
}

// ---- Rubrics (Destination) ----
async function createRubric (destCourseId, payload) {
  const token = await getAccessToken()
  const resp = await axios.post(
    `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(destCourseId)}/rubrics`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return resp.data
}

async function patchRubric (destCourseId, rubricId, payload) {
  const token = await getAccessToken()
  const resp = await axios.patch(
    `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(destCourseId)}/rubrics/${encodeURIComponent(rubricId)}`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return resp.data
}

async function deleteRubric (destCourseId, rubricId) {
  const token = await getAccessToken()
  await axios.delete(
    `${BB_BASE}/learn/api/public/v1/courses/${encodeURIComponent(destCourseId)}/rubrics/${encodeURIComponent(rubricId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
}

module.exports = {
  listCourses,
  listRubrics,
  getRubric,
  createRubric,
  patchRubric,
  deleteRubric
}
