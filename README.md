# FindIt@Thapar

Campus lost-and-found portal starter project.

## Stack
- Frontend: React + Vite
- Backend: Node.js + Express REST API
- Initial development data: in-memory sample listings (resets when the backend restarts)
- Planned next steps: Supabase PostgreSQL/authentication, S3 image storage, Docker, AWS deployment, GitHub Actions

## Requirements
- Node.js 20.19+ or 22.12+ recommended
- npm

## Run locally

Open two terminal windows.

### Terminal 1: backend
```bash
cd backend
npm install
npm run dev
```
API runs at http://localhost:4000

### Terminal 2: frontend
```bash
cd frontend
npm install
npm run dev
```
Open the URL Vite prints, usually http://localhost:5173.

## Current API
- `GET /api/health` - health check
- `GET /api/items` - list/search/filter listings
- `GET /api/items/:id` - fetch one listing
- `POST /api/items` - create a listing
- `PATCH /api/items/:id/resolve` - mark a listing resolved
- `DELETE /api/items/:id` - delete a listing (temporary; ownership/auth will be added later)

## Important
This is the first working scaffold, not the finished production application. The backend currently uses in-memory data so we can verify the UI and API before adding persistent storage and authentication. Do not use real personal information in this prototype.
