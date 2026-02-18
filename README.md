# Blackboard Rubric Transfer Tool (Node.js + LTI 1.3)

Instructor **pull** workflow: launch inside destination **Course B**, choose source **Course A**, select rubrics, and the tool **creates** those rubrics in Course B via Blackboard REST (2‑legged OAuth).

## Stack
- Node.js + Express
- [ltijs](https://github.com/Cvmcosta/ltijs) for LTI 1.3 provider
- Axios for Blackboard REST (client credentials / 2‑legged OAuth)

## Quick start (local)
1. `cp .env.example .env` and fill in:
   ```
   BB_BASE_URL=https://your-learn.example.edu
   BB_KEY=your_rest_key
   BB_SECRET=your_rest_secret
   LTI_ENCRYPTION_KEY=some_long_random_secret
   MONGO_URL=mongodb://localhost:27017/lti
   ```
2. `npm install`
3. `npm start`

> Launch via Blackboard LTI placement (recommended). Directly hitting `/login` requires a proper OIDC launch from Learn.

## Blackboard setup summary
- **LTI 1.3 tool**: Register the tool, create a placement.
  - OIDC initiation: `https://<your-host>/login`
  - Redirect/Target: `https://<your-host>/`
- **REST application**: Create in developer portal → Admin enables Integration in Learn → store **key/secret** in `.env`.

## Endpoints used (Rubrics CRUD)
- `GET /learn/api/public/v1/courses/{courseId}/rubrics`
- `GET /learn/api/public/v1/courses/{courseId}/rubrics/{rubricId}`
- `POST /learn/api/public/v1/courses/{courseId}/rubrics`
- `PATCH /learn/api/public/v1/courses/{courseId}/rubrics/{rubricId}`
- `DELETE /learn/api/public/v1/courses/{courseId}/rubrics/{rubricId}`

## Security
- Do **not** commit real credentials.
- Use environment variables locally / Render.

## Render (optional)
- Create a Web Service, set env vars (same as `.env`), deploy.
- TLS is automatic for onrender.com and custom domains.
