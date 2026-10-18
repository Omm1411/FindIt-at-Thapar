# FindIt@Thapar

**A Campus Lost and Found Community Platform**

FindIt@Thapar is a web application designed to help students report lost belongings, discover found items, and connect owners with people who may have found their possessions. It provides a central place for campus members to manage listings and coordinate the return of items.

## Features

- **User authentication:** Sign up and log in using Supabase Authentication.
- **Lost and found listings:** Create and browse item listings.
- **Search and categorization:** Find listings using available search and category filters.
- **Listing management:** Edit your own listings and delete them when appropriate.
- **Image uploads:** Upload, view, replace, and remove item images using private Amazon S3 storage and temporary signed URLs.
- **Claim system:** Submit claims explaining why an item belongs to you.
- **Claim review:** Listing owners can review, approve, or reject claims.
- **Handover tracking:** Approved claims move an item to a claimed state. The owner can mark it resolved after the item has been returned.
- **Access control:** The backend verifies authenticated requests, and claim information is restricted to the relevant claimant and listing owner.

## Technology Stack

| Component | Technology |
|---|---|
| Frontend | React, Vite, JavaScript, CSS |
| Backend | Node.js, Express.js |
| Database | Supabase PostgreSQL |
| Authentication | Supabase Auth |
| Image storage | Amazon S3 |
| API security | Supabase access-token verification |
| Containerization | Docker, Docker Compose |
| Version control | Git, GitHub |

## Architecture

The frontend communicates with the Express backend through HTTP API requests. Supabase provides authentication and PostgreSQL database services, while Amazon S3 stores uploaded item images.

```text
                 Student / User
                       |
                       v
              React + Vite Frontend
                       |
                       v
                Express Backend
                 /            \
                v              v
       Supabase Services     Amazon S3
       - Authentication     - Item images
       - PostgreSQL         - Private objects
       - Claim records      - Signed URLs
```

The application uses cloud services for authentication, database operations, and image storage. The frontend and backend can be run locally using Docker Compose.

## Getting Started

### Prerequisites

Install the following:

- Node.js and npm
- Docker Desktop with Docker Compose
- A Supabase project
- An AWS account and an appropriately configured S3 bucket

### 1. Clone the repository

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd FindIt-at-Thapar
```

Replace the placeholder with the actual GitHub repository URL.

### 2. Configure environment variables

Create local environment files from the provided examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Fill in the required values using the variable names documented in the example files. These may include:

- Supabase project URL and the appropriate API keys
- Backend port and frontend API URL
- AWS region and S3 bucket configuration
- Other settings required by the Docker Compose configuration

Never commit real credentials, access keys, tokens, or secret environment files to GitHub.

### 3. Configure Supabase

Make sure your Supabase project has the required database schema and authentication configuration.

Review and apply the SQL migrations in `supabase/migrations/` to the intended Supabase project:

- `20261019000000_add_items_image_object_key.sql`
- `20261019000100_add_item_claims.sql`

Apply only migrations that have not already been applied. Verify that each migration completes successfully.

Configure the Supabase Authentication settings and redirect URLs as appropriate for your local or deployed application.

### 4. Configure Amazon S3

Create or select an S3 bucket for item images. Configure the backend with the correct bucket name, region, and permissions.

The bucket should remain private. The application uses signed URLs to provide temporary access to stored images. Do not make the bucket public merely to display uploaded images.

The backend should use appropriately scoped AWS permissions. For a deployed application on AWS, prefer an IAM role over long-lived access keys where supported.

### 5. Start the application

From the repository root, run:

```bash
docker compose --env-file frontend/.env up --build -d
```

Once the containers start, open:

**Frontend:** http://localhost:8080

The backend API runs on port `4000` in the current local configuration.

To inspect running containers:

```bash
docker compose ps
```

To inspect logs:

```bash
docker compose logs -f
```

To stop the application:

```bash
docker compose down
```

## Item Claim Workflow

1. A user creates a found-item listing.
2. Another authenticated user submits a claim with an explanation.
3. The claimant can view their claims, while the listing owner can review claims associated with their listings.
4. The owner approves or rejects a claim.
5. An approved claim moves the listing to the claimed state while the physical handover is pending.
6. After the item has been returned, the owner marks the listing as resolved.

The backend validates the user's identity and permissions. It also prevents invalid claims and coordinates claim decisions with listing status changes.

## API Overview

The backend exposes endpoints for listing management, image operations, and claims.

### Claims API

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/items/:id/claims` | Submit a claim |
| GET | `/api/claims/mine` | View your claims |
| GET | `/api/claims/for-my-listings` | View claims on your listings |
| GET | `/api/items/:id/claims` | Retrieve claims for an eligible listing |
| POST | `/api/claims/:id/approve` | Approve a claim |
| POST | `/api/claims/:id/reject` | Reject a claim |

Authenticated endpoints require a valid Supabase access token. The backend derives the claimant and reviewer identities from the verified token rather than trusting user IDs supplied by the client.

## Testing

Backend tests are located in `backend/test/`. They cover item routes, claim operations, and image-related functionality.

From the backend directory, install dependencies and run the configured test script:

```bash
cd backend
npm install
npm test
```

Check `backend/package.json` for the available test scripts.

Build the frontend from the frontend directory:

```bash
cd frontend
npm install
npm run build
```

The frontend production build should complete successfully before deployment.

## Security Considerations

- Keep environment files and credentials out of version control.
- Keep the S3 bucket private and use temporary signed URLs for image access.
- Use verified Supabase tokens for authenticated API operations.
- Restrict claim information to authorized users.
- Use least-privilege IAM permissions for AWS resources.
- Configure HTTPS, production CORS origins, and production authentication redirect URLs before public deployment.

## Deployment Status

The project uses Supabase for database and authentication services and Amazon S3 for image storage. The frontend and backend currently support local execution through Docker Compose.

Deployment of the complete application to AWS is a separate step and requires production hosting, API configuration, secrets management, and HTTPS setup.

## Project Purpose

FindIt@Thapar demonstrates full-stack web development, REST API design, authentication, database-backed workflows, private cloud object storage, containerization, and version control in a campus-focused lost-and-found application.
