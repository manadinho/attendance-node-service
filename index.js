const express = require('express');
require('dotenv').config();

const { startAttendanceCron } = require('./crons/attendanceCron');
const { startUpdateRedisCacheCron } = require('./crons/updateRedisCacheCron');
const { startAdminAlertsCron } = require('./crons/adminAlertsCron');
const { getRedis } = require('./redisClient');

const PORT = process.env.PORT || 3300;
const app = express();
app.use(express.json());

let redis;
(async () => {
  redis = await getRedis(); // connect once at startup
})();
// ------- Routes only -------

app.get('/', (_req, res) => {
  res.send('<h2>✅ Server is running.</h2>');
});

app.get('/status', (_req, res) => {
  res.json(getStatus());
});

/* REDIS SPECIC ROUTE START */

// POST /redis/set
// Body: { "hash": "schools", "key": "3C-61-05-11-DD-18", "value": { ... } }
app.post('/redis/set', async (req, res) => {
  try {
    const { hash, key, value } = req.body || {};

    if (!hash || typeof hash !== 'string' || !hash.trim()) {
      return res.status(400).json({ error: 'hash (hashmap name) is required' });
    }
    if (!key || typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'key (field in the hash) is required' });
    }
    if (typeof value === 'undefined') {
      return res.status(400).json({ error: 'value (object or string) is required' });
    }

    const toStore = (typeof value === 'string') ? value : JSON.stringify(value);

    // HSET returns 1 if new field created, 0 if existing field updated
    const result = await redis.hSet(hash, key, toStore);
    const created = result === 1;

    return res.json({
      ok: true,
      hash,
      key,
      created,                 // true = inserted, false = updated
      storedAs: 'json-string'  // value saved as JSON string (if object)
    });
  } catch (e) {
    console.error('POST /redis/set error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/redis/hdel', async (req, res) => {
  try {
    // accept from body (preferred) or query
    const hash = (req.body?.hash || req.query?.hash || '').toString().trim();
    const key  = (req.body?.key  || req.query?.key  || '').toString().trim();

    if (!hash) return res.status(400).json({ error: 'hash (hashmap name) is required' });
    if (!key)  return res.status(400).json({ error: 'key (field in the hash) is required' });

    const removed = await redis.hDel(hash, key); // 1 if field removed, 0 if not found
    console.log(`🗑 Deleted ${removed} field(s) from hash "${hash}"`);

    return res.json({
      ok: true,
      hash,
      key,
      deleted: removed === 1
    });
  } catch (e) {
    console.error('DELETE /redis/hdel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /redis/preview?pattern=schools:*&limit=100&sample=20
app.get('/redis/preview', async (req, res) => {
  try {
    const pattern = (req.query.pattern || '*').toString();
    const limit = Math.max(1, Math.min(+req.query.limit || 100, 500));
    const sample = Math.max(1, Math.min(+req.query.sample || 20, 200));
    let cursor = (req.query.cursor || '0').toString();

    // ---- SCAN keys up to limit ----
    const keys = [];
    let nextCursor = '0';
    do {
      const out = await redis.scan(cursor, { MATCH: pattern, COUNT: 500 });
      // node-redis v4 returns { cursor, keys }; some setups return [cursor, keys]
      cursor = out.cursor ?? out[0];
      const batch = out.keys ?? out[1] ?? [];
      for (const k of batch) {
        keys.push(k);
        if (keys.length >= limit) break;
      }
      nextCursor = cursor;
      if (keys.length >= limit) break;
    } while (cursor !== '0');

    // ---- Build previews per key ----
    const rows = [];
    for (const key of keys) {
      const type = await redis.type(key);
      const ttlRaw = await redis.ttl(key);
      const ttl = ttlRaw === -1 ? '∞' : ttlRaw === -2 ? 'N/A' : `${ttlRaw}s`;

      let previewHtml = '';
      let extra = '';

      const escape = (s) =>
        (s ?? '').toString().replace(/[&<>"']/g, c =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

      const prettyMaybeJson = (s) => {
        if (typeof s !== 'string') return escape(String(s));
        const trimmed = s.trim();
        if (!trimmed) return '';
        try {
          const parsed = JSON.parse(trimmed);
          return `<pre>${escape(JSON.stringify(parsed, null, 2))}</pre>`;
        } catch {
          const isTooLong = trimmed.length > 2000;
          const slice = isTooLong ? trimmed.slice(0, 2000) + '… (truncated)' : trimmed;
          return `<pre>${escape(slice)}</pre>`;
        }
      };

      if (type === 'string') {
        const val = await redis.get(key);
        previewHtml = prettyMaybeJson(val);
      } else if (type === 'hash') {
        const { len, obj } = await readHashSample(redis, key, sample);
        previewHtml = `<div><b>Fields:</b> ${len} (showing up to ${sample})</div><pre>${escape(JSON.stringify(obj, null, 2))}</pre>`;
      } else if (type === 'list') {
        const len = await redis.lLen(key);
        const arr = await redis.lRange(key, 0, sample - 1);
        previewHtml = `<div><b>Length:</b> ${len} (showing first ${Math.min(sample, len)})</div><pre>${escape(JSON.stringify(arr, null, 2))}</pre>`;
      } else if (type === 'set') {
        const len = await redis.sCard(key);
        const sscan = await redis.sScan(key, '0', { COUNT: sample });
        const members = sscan?.members ?? sscan?.[1] ?? [];
        previewHtml = `<div><b>Members:</b> ${len} (sample ${Math.min(sample, members.length)})</div><pre>${escape(JSON.stringify(members.slice(0, sample), null, 2))}</pre>`;
      } else if (type === 'zset') {
        const len = await redis.zCard(key);
        const items = await redis.zRangeWithScores(key, 0, sample - 1);
        previewHtml = `<div><b>Members:</b> ${len} (showing first ${Math.min(sample, len)})</div><pre>${escape(JSON.stringify(items, null, 2))}</pre>`;
      } else {
        previewHtml = `<i>Type "${escape(type)}" not previewed.</i>`;
      }

      rows.push({ key, type, ttl, previewHtml, extra });
    }

    // ---- HTML page ----
    const hasMore = nextCursor !== '0' && keys.length >= limit;
    const qs = (o) =>
      Object.entries(o)
        .filter(([_, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');

    const nextHref = hasMore
      ? `/redis/preview?${qs({ pattern, limit, sample, cursor: nextCursor })}`
      : '';

    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Redis Preview</title>
          <style>
            body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; color: #111; }
            h1 { margin: 0 0 12px; }
            form { margin: 12px 0 20px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
            input[type=text], input[type=number] { padding:8px 10px; border:1px solid #ddd; border-radius:8px; }
            button { padding:8px 12px; border:0; background:#111; color:white; border-radius:8px; cursor:pointer; }
            .meta { color:#555; margin: 0 0 16px; }
            .card { border:1px solid #eee; border-radius:12px; padding:12px 14px; margin: 10px 0; box-shadow: 0 1px 0 rgba(0,0,0,0.03); }
            .row { display:flex; justify-content:space-between; gap:12px; align-items:center; }
            .key { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace; font-size: 13px; word-break: break-all; }
            .pill { font-size: 12px; padding:2px 8px; border-radius:999px; background:#f6f6f6; border:1px solid #eee; }
            pre { background:#fafafa; border:1px solid #eee; border-radius:10px; padding:10px; overflow:auto; max-height:280px; }
            details > summary { cursor:pointer; list-style: none; }
            details summary::-webkit-details-marker { display:none; }
            .summary { display:flex; gap:8px; align-items:center; }
            .footer { margin-top: 16px; }
            a.more { text-decoration:none; color:#0b5; font-weight:600; }
          </style>
        </head>
        <body>
          <h1>Redis Preview</h1>

          <form method="get" action="/redis/preview">
            <label>Pattern: <input type="text" name="pattern" value="${escape(pattern)}" placeholder="*" /></label>
            <label>Limit: <input type="number" name="limit" value="${limit}" min="1" max="500" /></label>
            <label>Sample: <input type="number" name="sample" value="${sample}" min="1" max="200" /></label>
            <button type="submit">Search</button>
          </form>

          <div class="meta">Found <b>${rows.length}</b> key(s)${hasMore ? ' (more available)' : ''} for pattern <code>${escape(pattern)}</code>.</div>

          ${rows.map(r => `
            <div class="card">
              <details>
                <summary class="summary">
                  <span class="key">${escape(r.key)}</span>
                  <span class="pill">${escape(r.type)}</span>
                  <span class="pill">TTL: ${escape(r.ttl)}</span>
                </summary>
                <div style="margin-top:10px">${r.previewHtml}</div>
              </details>
            </div>
          `).join('')}

          <div class="footer">
            ${hasMore ? `<a class="more" href="${escape(nextHref)}">Next &raquo;</a>` : ''}
          </div>
        </body>
      </html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('GET /redis/preview error:', e);
    res.status(500).send(`<pre>${String(e.message || e)}</pre>`);
  }
});

async function readHashSample(redis, key, sample) {
  const len = await redis.hLen(key);
  let obj = {};

  // Try HSCAN sampling (non-blocking)
  try {
    let cursor = '0';
    while (Object.keys(obj).length < sample) {
      const resp = await redis.hScan(key, cursor, { COUNT: sample });

      // Normalize node-redis v4 variants:
      // - Array form: [cursor, [field1, val1, field2, val2, ...]]
      // - Object form: { cursor, tuples: [f1, v1, f2, v2, ...] }
      let nextCursor, tuples;
      if (Array.isArray(resp)) {
        nextCursor = resp[0];
        tuples = resp[1] || [];
      } else if (resp && typeof resp === 'object') {
        nextCursor = resp.cursor ?? '0';
        tuples = resp.tuples || resp.values || resp.keys || [];
      } else {
        break;
      }

      for (let i = 0; i + 1 < tuples.length && Object.keys(obj).length < sample; i += 2) {
        const f = tuples[i];
        const v = tuples[i + 1];
        try { obj[f] = JSON.parse(v); } catch { obj[f] = v; }
      }

      cursor = nextCursor;
      if (cursor === '0') break;
    }
  } catch (_) {
    // ignore; we'll fallback
  }

  // Fallback to HGETALL if HSCAN wasn’t usable or returned nothing
  if (Object.keys(obj).length === 0) {
    const all = await redis.hGetAll(key);
    const entries = Object.entries(all).slice(0, sample);
    obj = {};
    for (const [f, v] of entries) {
      try { obj[f] = JSON.parse(v); } catch { obj[f] = v; }
    }
  }

  return { len, obj };
}

/* REDIS SPECIC ROUTE END */

// ------- Bootstrap -------

(async () => {
  // start crons
  startAttendanceCron();
  startUpdateRedisCacheCron();
  startAdminAlertsCron();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  });
})();
