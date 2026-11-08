#!/usr/bin/env node
'use strict';

// Read-only Firestore exporter for Northfall migration dry-runs.
// It NEVER writes to Firestore and does not connect to PostgreSQL.
// Run explicitly with: FIREBASE_SERVICE_ACCOUNT='...' node tools/firestore-export.js
// Add FIRESTORE_EXPORT_CONFIRM=YES to acknowledge that every exported document is read.

const fs = require('node:fs');
const path = require('node:path');
const admin = require('../netlify/lib/fb');

const PAGE_SIZE = Math.min(500, Math.max(1, Number(process.env.EXPORT_PAGE_SIZE) || 200));
const MAX_DOCS = Math.max(1, Number(process.env.EXPORT_MAX_DOCS) || 100000);
const OUT_DIR = path.resolve(process.env.FIRESTORE_EXPORT_DIR || 'firestore-export');
const EXCLUDED = new Set((process.env.EXPORT_EXCLUDE_COLLECTIONS || '').split(',').map(x => x.trim()).filter(Boolean));

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'collection';
}
function serializable(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { __type: 'timestamp', value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __type: 'bytes-base64', value: value.toString('base64') };
  if (Array.isArray(value)) return value.map(serializable);
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return { __type: 'timestamp', value: value.toDate().toISOString() };
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number') {
      return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    }
    if (typeof value.path === 'string' && value.constructor && value.constructor.name === 'DocumentReference') {
      return { __type: 'document-reference', path: value.path };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializable(v);
    return out;
  }
  return value;
}

async function main() {
  if (process.env.FIRESTORE_EXPORT_CONFIRM !== 'YES') {
    throw new Error('Export not started. Set FIRESTORE_EXPORT_CONFIRM=YES after reviewing the read-cost warning.');
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is required.');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const db = admin.firestore();
  let totalDocs = 0;
  let collectionCount = 0;
  const manifest = {
    format: 'northfall-firestore-jsonl-v1',
    exportedAt: new Date().toISOString(),
    pageSize: PAGE_SIZE,
    maxDocs: MAX_DOCS,
    collections: [],
    note: 'Read-only export. Firestore remains unchanged. Export may incur document read charges.'
  };

  async function exportCollection(collectionRef) {
    if (EXCLUDED.has(collectionRef.id)) return;
    collectionCount++;
    const collectionPath = collectionRef.path;
    const filename = safeName(collectionPath.replace(/\//g, '__')) + '.jsonl';
    const filepath = path.join(OUT_DIR, filename);
    const stream = fs.createWriteStream(filepath, { flags: 'w' });
    let count = 0;
    let cursor = null;

    try {
      while (true) {
        if (totalDocs >= MAX_DOCS) throw new Error('EXPORT_MAX_DOCS reached; export stopped safely.');
        let query = collectionRef.orderBy(admin.firestore.FieldPath.documentId()).limit(Math.min(PAGE_SIZE, MAX_DOCS - totalDocs));
        if (cursor) query = query.startAfter(cursor);
        const snap = await query.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          const record = {
            path: doc.ref.path,
            id: doc.id,
            createTime: doc.createTime ? doc.createTime.toDate().toISOString() : null,
            updateTime: doc.updateTime ? doc.updateTime.toDate().toISOString() : null,
            data: serializable(doc.data())
          };
          if (!stream.write(JSON.stringify(record) + '\n')) {
            await new Promise(resolve => stream.once('drain', resolve));
          }
          count++;
          totalDocs++;
        }
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < PAGE_SIZE) break;
      }
    } finally {
      await new Promise((resolve, reject) => stream.end(err => err ? reject(err) : resolve()));
    }

    manifest.collections.push({ path: collectionPath, file: filename, documents: count });
    // Enumerate subcollections only for documents in this collection.
    const pageQuery = collectionRef.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
    let pageCursor = null;
    while (true) {
      let q = pageQuery;
      if (pageCursor) q = q.startAfter(pageCursor);
      const page = await q.get();
      if (page.empty) break;
      for (const doc of page.docs) {
        const subcollections = await doc.ref.listCollections();
        for (const sub of subcollections) await exportCollection(sub);
      }
      pageCursor = page.docs[page.docs.length - 1];
      if (page.size < PAGE_SIZE) break;
    }
  }

  for (const collection of await db.listCollections()) await exportCollection(collection);

  manifest.totalDocuments = totalDocs;
  manifest.totalCollections = collectionCount;
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ output: OUT_DIR, totalDocuments: totalDocs, totalCollections: collectionCount }, null, 2));
}

main().catch(err => {
  console.error('[firestore-export] ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
