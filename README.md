# Marginalia — original HTML reader + Node.js + MongoDB Atlas

This is the **plain HTML, CSS and JavaScript** version of Marginalia. It does not use React. `public/index.html` preserves the reader interface from your uploaded Marginalia file, including PDF.js rendering in the browser, selectable text, highlights, highlight comments, sticky notes, page navigation, zoom, notes panel, library management and backup/restore tools.

The UI has been adapted to use a private Node.js/Express API instead of local IndexedDB for its main library records. Paper metadata and the original reader's annotation objects are stored as owner-scoped records in MongoDB Atlas. PDF binaries are stored in private MongoDB GridFS. The standalone original file remains preserved at `public/original-marginalia.html`.

## Requirements

- Node.js 20 or newer
- A MongoDB Atlas cluster and database user
- Atlas network access configured for the machine or hosting service running Node

## 1. Configure MongoDB Atlas

1. In MongoDB Atlas, create a cluster or use an existing one.
2. Create a **database user** with a strong password. Do not use your Atlas website login as the database user.
3. Under **Network Access**, allow the server's IP address. For local development, allow your current IP address; avoid `0.0.0.0/0` for a private research library.
4. Choose **Connect → Drivers → Node.js**, copy the connection string, and replace its username/password placeholders. URL-encode special characters in the database user's password.
5. The app creates its collections and indexes automatically after the connection succeeds.

## 2. Configure the one authorised account

Public sign-up is intentionally disabled. One email address and password are configured in `.env`.

1. Copy `.env.example` to `.env` in the project root.
2. From this project folder, generate a bcrypt hash for the password you want to use:

   ```bash
   node --input-type=module -e "import bcrypt from 'bcryptjs'; console.log(await bcrypt.hash(process.argv[1], 12))" "CHOOSE-A-LONG-UNIQUE-PASSWORD"
   ```

   Copy the printed hash after `ADMIN_PASSWORD_HASH=`. At login, type the original password, **not** the hash.
3. Set `ADMIN_EMAIL` to your authorised email address.
4. Put your Atlas driver URI in `MONGODB_URI`.
5. Generate a private token-signing secret:

   ```bash
   node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(48).toString('hex'))"
   ```

   Copy it after `JWT_SECRET=`.
6. Keep `.env` private and out of Git. Never put the Atlas URI, database password, password hash or JWT secret in browser JavaScript.

## 3. Install and run

```bash
npm install
npm start
```

Open **http://localhost:3000**. Sign in with the email in `ADMIN_EMAIL` and the password used to generate the hash. Do not open `public/index.html` directly with `file://`: serve it through Node.js so the authenticated API and security headers work.

Use `npm run dev` during development if you want Node to restart after server edits.

## Included features

- Private single-account email/password sign-in; no public registration route
- Eight-hour signed bearer token held in `sessionStorage`
- Original Marginalia library layout and browser-based PDF reader powered by the PDF.js assets served locally in `public/`
- Page rendering, selectable PDF text, highlight colours, highlight comments and sticky notes
- Zoom controls, page count/navigation, notes panel, metadata editing, tags and reading statuses from the original UI
- Cloud persistence for paper metadata and the original highlight/sticky annotation structures
- Private PDF upload, retrieval and deletion using MongoDB GridFS
- The original library's backup/restore interface, now routed through the cloud storage adapter
- All cloud storage endpoints are protected by the authenticated owner check
- PDF upload limit controlled by `MAX_PDF_MB` (default 100 MB)

## How the cloud storage adapter works

The original UI had IndexedDB helpers for `papers`, `annots` and `files`. In this version those helpers call the same-origin Node API instead: `papers` and `annots` are stored in the `cloud_records` collection, while PDF files live in GridFS with a private owner-scoped reference in `cloud_files`. The API checks the signed-in account on every request. The `MONGODB_URI` and JWT secret remain on the server, never in HTML.

## API endpoints

Login and account:
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/health`

Original-reader cloud storage (all routes except health/login require `Authorization: Bearer <token>`):
- `GET /api/cloud-store/:store/keys`
- `GET /api/cloud-store/:store/all`
- `GET|PUT|DELETE /api/cloud-store/:store/:key`

Allowed stores are `papers`, `annots` and `files`. File routes use private GridFS; `papers` and `annots` are owner-scoped JSON records. The app also retains the earlier `/api/papers` workspace endpoints for compatibility, but the main page uses `/api/cloud-store` to preserve the original reader data structures. On first library load, rows created by the earlier workspace version are imported into the original-reader format; their existing GridFS PDFs are linked so they can still be opened in the reader. Any old comment/highlight text that had no page geometry is preserved as text in the paper's **Other notes** rather than being recreated as a visible highlight.


## Deploy online with Render + MongoDB Atlas

This repository includes `render.yaml`, which preconfigures a Render Node web service. The site and API run together on one HTTPS origin, while PDFs and research data stay in MongoDB Atlas.

### A. Put the project on GitHub

1. Extract the ZIP on your computer.
2. Create a **private** repository on GitHub (for example `marginalia-private-library`).
3. Upload/commit the contents of the extracted `marginalia-atlas-html` folder to the repository root. Make sure `package.json`, `render.yaml`, `.node-version`, `server/`, and `public/` are at the repository root.
4. Do **not** upload `.env`. It is excluded by `.gitignore`. Uploading a private repository is recommended because the app source contains no user PDFs or database secrets.

### B. Create the Render service

1. Sign in to Render and choose **New → Blueprint** (or create a **Web Service** connected to the repository).
2. Select your GitHub repository and apply the `render.yaml` configuration. If creating a Web Service manually, set runtime **Node**, build command `npm install`, and start command `npm start`.
3. Add the required secret environment variables in the Render service settings: `MONGODB_URI`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, and `JWT_SECRET`. The Blueprint marks these as values you supply privately. `MONGODB_DB` should be `marginalia`; `NODE_ENV` should be `production`.
4. Keep the Render service and database secrets private. Do not add a `VITE_` or other browser-visible prefix to them.

### C. Allow Render to reach Atlas securely

Atlas permits database connections only from IPs on its project IP access list. In Render, open your service's **Connect** menu and look at the **Outbound** IP ranges for the service's region. Add the needed Render outbound ranges to Atlas under **Network Access → IP Access List**. Do not use `0.0.0.0/0` for your private research library. You may need to redeploy/restart once network access is set.

In Atlas, use a dedicated database user with a strong password and only the database permissions this application needs. Put the complete Atlas driver URI into Render's `MONGODB_URI` secret value. If the database password contains special characters, URL-encode them in the URI.

### D. Verify the online app

1. Wait for the Render deploy to finish successfully. Open the `onrender.com` URL shown in the Render dashboard.
2. Check that `/api/health` returns JSON with `ok: true`.
3. Sign in with the email in `ADMIN_EMAIL` and the original password used to generate `ADMIN_PASSWORD_HASH`.
4. Upload a small test PDF, open it in the in-browser reader, add a highlight and sticky note, reload the page and verify the data remains. Test backup/restore before migrating your full research library.

### Free-plan note

Render's free web services spin down after 15 minutes without requests and can take about a minute to wake up. The local filesystem is ephemeral; this project stores PDFs in Atlas GridFS, so the app does not rely on Render disk storage for your library. For more consistent availability, choose a paid web service. See the current [Render free service limitations](https://render.com/docs/free).

## Existing papers from the standalone HTML

The original local `.html` file used that file's browser storage. The cloud version does not automatically have access to that old browser database, because the standalone `file://` origin and `http://localhost:3000` are different storage origins. **Keep the old HTML and its browser data unchanged.**

To transfer an existing library, open your original HTML file in the same browser and use its **backup/export** feature to create a library backup. Then sign in to this Node version and use its **restore** feature to restore that backup to the cloud library. Verify a few PDFs and highlights afterwards before relying on the cloud copy. Do not delete the local copy until you have checked that restore succeeded.

## Security and deployment

- Use HTTPS when hosting publicly.
- Restrict Atlas network access to the server's outbound IP range where supported.
- Keep `.env` and database backups private.
- The included login is designed for one authorised account; it has no self-registration or password reset. Protect the email account and use a unique password.
- A standalone HTML file can be a front end, but secure multi-device cloud access still requires the Node backend to be running and reachable.
- Hosting the front end and API at the same HTTPS origin is recommended.

## Test status

The server and browser JavaScript files have been syntax-checked. The project has not yet been connected to your live Atlas cluster or tested with your actual PDF collection; verify upload, PDF rendering, annotation persistence and backup restore with a sample PDF first.
