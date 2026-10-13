import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { MongoClient, ObjectId, GridFSBucket } from 'mongodb';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'marginalia';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const MAX_PDF_BYTES = Math.max(1, Number(process.env.MAX_PDF_MB || 100)) * 1024 * 1024;
const origins = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!MONGODB_URI || !ADMIN_EMAIL || !ADMIN_PASSWORD_HASH || JWT_SECRET.length < 32) {
  console.error('Configuration missing. Set MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD_HASH, and a JWT_SECRET of at least 32 characters in .env.');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(DB_NAME);
const papers = db.collection('papers');
const cloudRecords = db.collection('cloud_records');
const cloudFiles = db.collection('cloud_files');
const bucket = new GridFSBucket(db, { bucketName: 'pdfs' });
await papers.createIndex({ ownerId: 1, updatedAt: -1 });
await papers.createIndex({ ownerId: 1, title: 'text', authors: 'text', tags: 'text' });
await cloudRecords.createIndex({ ownerId: 1, store: 1, key: 1 }, { unique: true });
await cloudFiles.createIndex({ ownerId: 1, key: 1 }, { unique: true });

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      workerSrc: ["'self'", 'blob:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
if (origins.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || origins.includes(origin)) {
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      return next();
    }
    return res.status(403).json({ error: 'Origin not allowed.' });
  });
}
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf';
    cb(isPdf ? null : new Error('Only PDF files are allowed.'), isPdf);
  }
});

function sendError(res, status, message) { return res.status(status).json({ error: message }); }
function validId(value) { return typeof value === 'string' && ObjectId.isValid(value); }
function toId(value) { return new ObjectId(value); }
function safePaper(doc) {
  if (!doc) return null;
  const { _id, ownerId, pdfFileId, ...rest } = doc;
  return { id: String(_id), hasPdf: Boolean(pdfFileId), ...rest };
}
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return sendError(res, 401, 'Please sign in.');
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    if (payload.sub !== ADMIN_EMAIL) throw new Error('wrong user');
    req.user = { id: ADMIN_EMAIL };
    next();
  } catch {
    return sendError(res, 401, 'Your session has expired. Please sign in again.');
  }
}
function cleanString(value, max = 10000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => cleanString(String(v), 60)).filter(Boolean))].slice(0, 50);
}
function publicPaperFilter(id, ownerId) {
  return { _id: toId(id), ownerId };
}
async function findOwnedPaper(id, ownerId) {
  if (!validId(id)) return null;
  return papers.findOne(publicPaperFilter(id, ownerId));
}

// Cloud storage adapter matching the original Marginalia app's IndexedDB-like API.
// Only authenticated owner-scoped records are ever returned. PDF binary files use private GridFS storage.
const cloudStoreNames = new Set(['papers', 'annots', 'files']);
function validCloudStore(store) { return cloudStoreNames.has(store); }
function cloudRecordFilter(store, key, ownerId) { return { ownerId, store, key }; }
function legacyMillis(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}
async function migrateLegacyPapers(ownerId) {
  // Preserve papers uploaded with the previous workspace version; import each row once.
  const legacy = await papers.find({ ownerId, cloudMigratedAt: { $exists: false } }).limit(500).toArray();
  for (const doc of legacy) {
    const key = String(doc._id);
    const oldAnnotations = Array.isArray(doc.annotations) ? doc.annotations : [];
    const legacyAnnotationText = oldAnnotations.map(a => {
      const details = [a.text ? `Passage: ${a.text}` : '', a.note || ''].filter(Boolean).join('\n');
      return `${String(a.type || 'note').toUpperCase()} (page ${Number(a.page) || 1})\n${details}`.trim();
    }).filter(Boolean).join('\n\n');
    const noteText = [typeof doc.notes === 'string' ? doc.notes : '', legacyAnnotationText].filter(Boolean).join('\n\n');
    const legacyData = {
      id: key,
      title: String(doc.title || 'Untitled paper'),
      authors: String(doc.authors || ''),
      year: String(doc.year || ''),
      venue: String(doc.journal || ''),
      doi: String(doc.doi || ''),
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      status: doc.status === 'reading' ? 'reading' : doc.status === 'read' ? 'read' : 'toread',
      key: false,
      notes: noteText ? { other: noteText } : {},
      fileName: String(doc.pdfFilename || ''),
      size: Number(doc.pdfSize || 0),
      pages: Number(doc.pages || 0),
      hlCount: 0,
      stCount: 0,
      added: legacyMillis(doc.createdAt || doc.added),
      opened: 0,
      updated: legacyMillis(doc.updatedAt || doc.updated),
      asset: doc.pdfFileId ? `legacy_${key}` : null
    };
    await cloudRecords.updateOne(cloudRecordFilter('papers', key, ownerId), {
      $setOnInsert: { ownerId, store: 'papers', key, data: legacyData, updatedAt: new Date() }
    }, { upsert: true });
    await cloudRecords.updateOne(cloudRecordFilter('annots', key, ownerId), {
      $setOnInsert: { ownerId, store: 'annots', key, data: { hl: [], st: [] }, updatedAt: new Date() }
    }, { upsert: true });
    if (doc.pdfFileId) {
      const fileMeta = await db.collection('pdfs.files').findOne({ _id: doc.pdfFileId, 'metadata.ownerId': ownerId });
      if (fileMeta) {
        await cloudFiles.updateOne({ ownerId, key: `legacy_${key}` }, {
          $setOnInsert: { ownerId, key: `legacy_${key}`, fileId: doc.pdfFileId, filename: doc.pdfFilename || fileMeta.filename || 'paper.pdf', size: fileMeta.length || 0, legacy: true, legacyPaperId: key, updatedAt: new Date() }
        }, { upsert: true });
        legacyData.size = Number(fileMeta.length || 0);
        legacyData.fileName = String(doc.pdfFilename || fileMeta.filename || 'paper.pdf');
        await cloudRecords.updateOne(cloudRecordFilter('papers', key, ownerId), { $set: { 'data.size': legacyData.size, 'data.fileName': legacyData.fileName } });
      }
    }
    await papers.updateOne({ _id: doc._id, ownerId }, { $set: { cloudMigratedAt: new Date() } });
  }
}

app.get('/api/cloud-store/:store/keys', requireAuth, async (req, res, next) => {
  try {
    const { store } = req.params;
    if (!validCloudStore(store) || store === 'files') return sendError(res, 400, 'Invalid cloud store.');
    if (store === 'papers') await migrateLegacyPapers(req.user.id);
    const docs = await cloudRecords.find({ ownerId: req.user.id, store }, { projection: { key: 1 } }).sort({ key: 1 }).toArray();
    res.json({ keys: docs.map(doc => doc.key) });
  } catch (err) { next(err); }
});

app.get('/api/cloud-store/:store/all', requireAuth, async (req, res, next) => {
  try {
    const { store } = req.params;
    if (!validCloudStore(store) || store === 'files') return sendError(res, 400, 'Invalid cloud store.');
    if (store === 'papers') await migrateLegacyPapers(req.user.id);
    const docs = await cloudRecords.find({ ownerId: req.user.id, store }).sort({ key: 1 }).toArray();
    res.json({ values: docs.map(doc => doc.data) });
  } catch (err) { next(err); }
});

app.get('/api/cloud-store/:store/:key', requireAuth, async (req, res, next) => {
  try {
    const { store, key } = req.params;
    if (!validCloudStore(store) || key === 'keys' || key === 'all') return sendError(res, 400, 'Invalid cloud store or key.');
    if (store === 'files') {
      const ref = await cloudFiles.findOne({ ownerId: req.user.id, key });
      if (!ref) return sendError(res, 404, 'PDF file not found in your library.');
      const fileId = ref.fileId;
      const metadataFilter = ref.legacy
        ? { _id: fileId, 'metadata.ownerId': req.user.id, 'metadata.paperId': String(ref.legacyPaperId) }
        : { _id: fileId, 'metadata.ownerId': req.user.id, 'metadata.key': key };
      const file = await db.collection('pdfs.files').findOne(metadataFilter);
      if (!file) return sendError(res, 404, 'PDF file not found in your library.');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename || 'paper.pdf')}`);
      res.setHeader('Cache-Control', 'private, no-store');
      return bucket.openDownloadStream(fileId).on('error', next).pipe(res);
    }
    const doc = await cloudRecords.findOne(cloudRecordFilter(store, key, req.user.id));
    if (!doc) return sendError(res, 404, 'Cloud record not found.');
    res.json(doc.data);
  } catch (err) { next(err); }
});

app.put('/api/cloud-store/:store/:key', requireAuth, async (req, res, next) => {
  try {
    const { store, key } = req.params;
    if (!validCloudStore(store) || key === 'keys' || key === 'all' || !key) return sendError(res, 400, 'Invalid cloud store or key.');
    if (store === 'files') {
      const contentType = String(req.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('application/octet-stream') && !contentType.startsWith('application/pdf')) {
        return sendError(res, 415, 'PDF uploads must use application/octet-stream or application/pdf.');
      }
      const rawParser = express.raw({ type: ['application/octet-stream', 'application/pdf'], limit: MAX_PDF_BYTES });
      return rawParser(req, res, async parseErr => {
        if (parseErr) return sendError(res, parseErr.status === 413 ? 413 : 400, parseErr.status === 413 ? `PDF exceeds the ${process.env.MAX_PDF_MB || 100} MB limit.` : 'Could not read PDF upload.');
        try {
          if (!Buffer.isBuffer(req.body) || req.body.length === 0) return sendError(res, 400, 'Empty PDF upload.');
          // Check the file signature rather than trusting only a browser-supplied MIME type.
          if (req.body.subarray(0, 5).toString('ascii') !== '%PDF-') return sendError(res, 400, 'The selected file does not look like a PDF.');
          const prior = await cloudFiles.findOne({ ownerId: req.user.id, key });
          if (prior?.legacyPaperId && ObjectId.isValid(prior.legacyPaperId)) {
            await papers.updateOne({ _id: new ObjectId(prior.legacyPaperId), ownerId: req.user.id }, { $unset: { pdfFileId: '', pdfFilename: '' } });
          }
          const fileId = new ObjectId();
          const filename = `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}.pdf`;
          const stream = bucket.openUploadStreamWithId(fileId, filename, {
            contentType: 'application/pdf', metadata: { ownerId: req.user.id, key }
          });
          await new Promise((resolve, reject) => {
            stream.once('finish', resolve); stream.once('error', reject); stream.end(req.body);
          });
          await cloudFiles.updateOne({ ownerId: req.user.id, key }, {
            $set: { ownerId: req.user.id, key, fileId, filename, size: req.body.length, updatedAt: new Date() },
            $unset: { legacy: '', legacyPaperId: '' }
          }, { upsert: true });
          if (prior?.fileId) await bucket.delete(prior.fileId).catch(() => {});
          return res.json({ ok: true, size: req.body.length });
        } catch (err) { return next(err); }
      });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return sendError(res, 400, 'Record must be a JSON object.');
    await cloudRecords.updateOne(cloudRecordFilter(store, key, req.user.id), {
      $set: { ownerId: req.user.id, store, key, data: req.body, updatedAt: new Date() }
    }, { upsert: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/api/cloud-store/:store/:key', requireAuth, async (req, res, next) => {
  try {
    const { store, key } = req.params;
    if (!validCloudStore(store) || key === 'keys' || key === 'all') return sendError(res, 400, 'Invalid cloud store or key.');
    if (store === 'files') {
      const ref = await cloudFiles.findOneAndDelete({ ownerId: req.user.id, key });
      if (ref?.legacyPaperId && ObjectId.isValid(ref.legacyPaperId)) {
        await papers.updateOne({ _id: new ObjectId(ref.legacyPaperId), ownerId: req.user.id }, { $unset: { pdfFileId: '', pdfFilename: '' } });
      }
      if (ref?.fileId) await bucket.delete(ref.fileId).catch(() => {});
    } else {
      await cloudRecords.deleteOne(cloudRecordFilter(store, key, req.user.id));
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'marginalia-api' }));

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = cleanString(req.body?.email, 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const emailOkay = email === ADMIN_EMAIL;
  const passwordOkay = await bcrypt.compare(password || 'invalid-password', ADMIN_PASSWORD_HASH).catch(() => false);
  if (!emailOkay || !passwordOkay) return sendError(res, 401, 'Email or password is incorrect.');
  const token = jwt.sign({ sub: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '8h', issuer: 'marginalia' });
  res.json({ token, user: { email: ADMIN_EMAIL }, expiresIn: 28800 });
});

app.get('/api/auth/me', requireAuth, (_req, res) => res.json({ user: { email: ADMIN_EMAIL } }));

app.get('/api/papers', requireAuth, async (req, res, next) => {
  try {
    const q = cleanString(req.query.q, 200);
    const filter = { ownerId: req.user.id };
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: { $regex: escaped, $options: 'i' } },
        { authors: { $regex: escaped, $options: 'i' } },
        { tags: { $regex: escaped, $options: 'i' } }
      ];
    }
    const docs = await papers.find(filter).sort({ updatedAt: -1 }).limit(500).toArray();
    res.json({ papers: docs.map(safePaper) });
  } catch (err) { next(err); }
});

app.post('/api/papers', requireAuth, async (req, res, next) => {
  try {
    const title = cleanString(req.body?.title, 500);
    if (!title) return sendError(res, 400, 'Paper title is required.');
    const now = new Date();
    const doc = {
      ownerId: req.user.id,
      title,
      authors: cleanString(req.body?.authors, 2000),
      year: cleanString(String(req.body?.year ?? ''), 12),
      doi: cleanString(req.body?.doi, 300),
      journal: cleanString(req.body?.journal, 500),
      abstract: cleanString(req.body?.abstract, 12000),
      tags: cleanTags(req.body?.tags),
      status: ['to-read', 'reading', 'read', 'reference'].includes(req.body?.status) ? req.body.status : 'to-read',
      notes: cleanString(req.body?.notes, 12000),
      annotations: [],
      createdAt: now,
      updatedAt: now
    };
    const result = await papers.insertOne(doc);
    res.status(201).json({ paper: safePaper({ ...doc, _id: result.insertedId }) });
  } catch (err) { next(err); }
});

app.get('/api/papers/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.id, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    res.json({ paper: safePaper(doc) });
  } catch (err) { next(err); }
});

app.patch('/api/papers/:id', requireAuth, async (req, res, next) => {
  try {
    const existing = await findOwnedPaper(req.params.id, req.user.id);
    if (!existing) return sendError(res, 404, 'Paper not found.');
    const allowed = {};
    for (const key of ['title', 'authors', 'year', 'doi', 'journal', 'abstract', 'notes']) {
      if (key in (req.body || {})) allowed[key] = cleanString(String(req.body[key] ?? ''), key === 'abstract' || key === 'notes' ? 12000 : 2000);
    }
    if ('title' in allowed && !allowed.title) return sendError(res, 400, 'Paper title cannot be empty.');
    if ('tags' in (req.body || {})) allowed.tags = cleanTags(req.body.tags);
    if ('status' in (req.body || {})) {
      if (!['to-read', 'reading', 'read', 'reference'].includes(req.body.status)) return sendError(res, 400, 'Invalid status.');
      allowed.status = req.body.status;
    }
    allowed.updatedAt = new Date();
    await papers.updateOne(publicPaperFilter(req.params.id, req.user.id), { $set: allowed });
    const updated = await findOwnedPaper(req.params.id, req.user.id);
    res.json({ paper: safePaper(updated) });
  } catch (err) { next(err); }
});

app.delete('/api/papers/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.id, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    if (doc.pdfFileId) await bucket.delete(toId(String(doc.pdfFileId))).catch(() => {});
    await papers.deleteOne({ _id: doc._id, ownerId: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/papers/:id/pdf', requireAuth, upload.single('pdf'), async (req, res, next) => {
  let tempPath = req.file?.path;
  try {
    const doc = await findOwnedPaper(req.params.id, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    if (!req.file) return sendError(res, 400, 'Choose a PDF file.');
    const fileId = new ObjectId();
    const filename = path.basename(req.file.originalname || 'paper.pdf').slice(0, 240);
    const stream = bucket.openUploadStreamWithId(fileId, filename, {
      contentType: 'application/pdf',
      metadata: { ownerId: req.user.id, paperId: String(doc._id) }
    });
    await pipeline(createReadStream(tempPath), stream);
    if (doc.pdfFileId) await bucket.delete(toId(String(doc.pdfFileId))).catch(() => {});
    await papers.updateOne({ _id: doc._id, ownerId: req.user.id }, {
      $set: { pdfFileId: fileId, pdfFilename: filename, updatedAt: new Date() }
    });
    res.status(201).json({ ok: true, filename });
  } catch (err) { next(err); }
  finally { if (tempPath) await unlink(tempPath).catch(() => {}); }
});

app.get('/api/papers/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.id, req.user.id);
    if (!doc || !doc.pdfFileId) return sendError(res, 404, 'PDF not found for this paper.');
    const fileId = toId(String(doc.pdfFileId));
    const file = await db.collection('pdfs.files').findOne({ _id: fileId, 'metadata.ownerId': req.user.id });
    if (!file) return sendError(res, 404, 'PDF not found.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename || 'paper.pdf')}`);
    res.setHeader('Cache-Control', 'private, no-store');
    bucket.openDownloadStream(fileId).on('error', next).pipe(res);
  } catch (err) { next(err); }
});

app.get('/api/papers/:id/annotations', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.id, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    res.json({ annotations: doc.annotations || [] });
  } catch (err) { next(err); }
});

app.post('/api/papers/:id/annotations', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.id, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    const body = req.body || {};
    const text = cleanString(body.text, 12000);
    const note = cleanString(body.note, 12000);
    const type = ['highlight', 'comment', 'sticky', 'review'].includes(body.type) ? body.type : 'comment';
    if (!text && !note) return sendError(res, 400, 'Add selected text or a note.');
    const annotation = {
      id: randomUUID(),
      type,
      text,
      note,
      page: Math.max(1, Math.min(100000, Number.parseInt(body.page, 10) || 1)),
      color: ['yellow', 'green', 'pink', 'blue', 'orange'].includes(body.color) ? body.color : 'yellow',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await papers.updateOne({ _id: doc._id, ownerId: req.user.id }, {
      $push: { annotations: annotation }, $set: { updatedAt: new Date() }
    });
    res.status(201).json({ annotation });
  } catch (err) { next(err); }
});

app.patch('/api/papers/:paperId/annotations/:annotationId', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.paperId, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    const old = (doc.annotations || []).find(a => a.id === req.params.annotationId);
    if (!old) return sendError(res, 404, 'Annotation not found.');
    const changes = {};
    if ('note' in (req.body || {})) changes.note = cleanString(req.body.note, 12000);
    if ('text' in (req.body || {})) changes.text = cleanString(req.body.text, 12000);
    if ('page' in (req.body || {})) changes.page = Math.max(1, Math.min(100000, Number.parseInt(req.body.page, 10) || 1));
    if ('color' in (req.body || {}) && ['yellow', 'green', 'pink', 'blue', 'orange'].includes(req.body.color)) changes.color = req.body.color;
    if ('type' in (req.body || {}) && ['highlight', 'comment', 'sticky', 'review'].includes(req.body.type)) changes.type = req.body.type;
    changes.updatedAt = new Date();
    await papers.updateOne({ _id: doc._id, ownerId: req.user.id }, {
      $set: Object.fromEntries(Object.entries(changes).map(([k, v]) => [`annotations.$[a].${k}`, v]))
    }, { arrayFilters: [{ 'a.id': req.params.annotationId }] });
    const updated = await findOwnedPaper(req.params.paperId, req.user.id);
    res.json({ annotation: updated.annotations.find(a => a.id === req.params.annotationId) });
  } catch (err) { next(err); }
});

app.delete('/api/papers/:paperId/annotations/:annotationId', requireAuth, async (req, res, next) => {
  try {
    const doc = await findOwnedPaper(req.params.paperId, req.user.id);
    if (!doc) return sendError(res, 404, 'Paper not found.');
    await papers.updateOne({ _id: doc._id, ownerId: req.user.id }, {
      $pull: { annotations: { id: req.params.annotationId } }, $set: { updatedAt: new Date() }
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err?.message || err);
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 413, `PDF exceeds the ${process.env.MAX_PDF_MB || 100} MB limit.`);
  }
  if (err?.message === 'Only PDF files are allowed.') return sendError(res, 400, err.message);
  return sendError(res, 500, 'Server error. Check the server log for details.');
});

const server = app.listen(PORT, () => console.log(`Marginalia running at http://localhost:${PORT}`));
async function shutdown() {
  server.close();
  await client.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
