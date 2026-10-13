# SAGAR-NETRA backend starter

Stack: React + Vite frontend, Express API, PostgreSQL, JWT auth, bcrypt password hashing, report image uploads, and YOLO detection persistence.

## Setup
1. Create PostgreSQL database `sagar_netra`.
2. Run `psql -U postgres -d sagar_netra -f sql/schema.sql` (or run the SQL in pgAdmin).
3. In `backend`, copy `.env.example` to `.env`, set `DATABASE_URL` and a random `JWT_SECRET` of 32+ characters.
4. Run `npm install`, then `npm run dev`.
5. Copy `frontend/.env.example` to your React/Vite project's root as `.env`. Copy `frontend/api.js` and `frontend/ReportLocation.jsx` into your app.
6. API base URL defaults to `http://localhost:4000/api`.

## Endpoints
- `POST /api/auth/register` `{name,email,password}` (new accounts get `diver` role; admin cannot be self-assigned)
- `POST /api/auth/login` `{email,password}`
- `GET /api/users/me` (Bearer token)
- `GET /api/user-types`, `GET /api/debris-types`
- `POST /api/reports` multipart form fields: `latitude`, `longitude`, optional `image`, `depth`, `water_temp`, `visibility`, `comments`
- `GET /api/reports` (own reports; admins see all)
- `GET /api/reports/:id` (owner/admin)
- `POST /api/reports/:id/detections` `{detections:[{class_name,confidence,bbox,mask_url,comment}]}`
- `PATCH /api/debris/:id` `{status,comment}`

YOLO class names must exactly match the 22 seeded names in the SQL schema. Detection persistence is implemented; inference itself remains in your Python/YOLO process. For production, do not trust detections posted by arbitrary clients: use a protected inference service.

Images are saved locally under `backend/uploads` for development. For production, use object storage and save its URL. GPS requires browser permission and HTTPS except on localhost; manual coordinates are supported.

Security: never commit `.env`; enable HTTPS, password reset/email verification, stricter rate limiting and secure cookie strategy before public deployment.
