/**
 * PageDrop Worker
 * Single-file backend: upload -> R2, metadata -> D1, search, health, serve.
 *
 * Routes:
 *   POST /api/upload            multipart/form-data { files[], name?, tags? }
 *   GET  /api/search?q=term     -> { results: [...] }
 *   GET  /api/project/:id       -> project metadata + file list
 *   GET  /api/health            -> { status, projects, bytesStored }
 *   GET  /:id/:path             -> serves the actual stored file from R2
 */

const NANOID_ALPHABET =
  "useandom26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

function generateId(size = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = "";
  for (let i = 0; i < size; i++) id += NANOID_ALPHABET[bytes[i] & 63];
  return id;
}

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
};

function guessContentType(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

// ---------- Route handlers ----------

async function handleUpload(request, env) {
  const form = await request.formData();
  const files = form.getAll("files").filter((f) => typeof f !== "string");

  if (!files.length) return json({ error: "No files provided" }, 400);

  const maxSize = Number(env.MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024);
  let totalSize = 0;
  for (const f of files) {
    if (f.size > maxSize) {
      return json(
        { error: `"${f.name}" exceeds the ${Math.round(maxSize / 1024 / 1024)}MB limit` },
        400
      );
    }
    totalSize += f.size;
  }

  const id = generateId(12);
  const name = (form.get("name") || files[0]?.name || "Untitled").toString().slice(0, 120);
  const tagsRaw = (form.get("tags") || "").toString();
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  const isPublic = form.get("private") === "true" ? 0 : 1;

  // Upload every file into R2 under a common id-prefixed "folder"
  await Promise.all(
    files.map((f) =>
      env.BUCKET.put(`${id}/${f.name}`, f.stream(), {
        httpMetadata: { contentType: f.type || guessContentType(f.name) },
      })
    )
  );

  await env.DB.prepare(
    `INSERT INTO projects (id, name, tags, total_size, file_count, is_public, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, tags.join(","), totalSize, files.length, isPublic, new Date().toISOString())
    .run();

  return json({ id, url: `/${id}/`, fileCount: files.length, totalSize });
}

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ results: [] });

  const like = `%${q}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, name, tags, total_size, file_count, created_at
     FROM projects
     WHERE is_public = 1 AND (name LIKE ? OR tags LIKE ?)
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(like, like)
    .all();

  return json({
    results: results.map((r) => ({
      ...r,
      tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    })),
  });
}

async function handleProject(id, env) {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Not found" }, 404);

  const listed = await env.BUCKET.list({ prefix: `${id}/` });
  const files = listed.objects.map((o) => ({
    key: o.key.slice(id.length + 1),
    size: o.size,
  }));

  return json({
    ...row,
    tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
    files,
  });
}

async function handleHealth(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as projects, COALESCE(SUM(total_size), 0) as bytesStored FROM projects`
  ).first();
  return json({ status: "ok", projects: row.projects, bytesStored: row.bytesStored });
}

async function serveFile(pathname, env) {
  const key = pathname.replace(/^\//, "");
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

// ---------- Router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      if (pathname === "/api/upload" && request.method === "POST") {
        return withCors(await handleUpload(request, env), env);
      }
      if (pathname === "/api/search" && request.method === "GET") {
        return withCors(await handleSearch(request, env), env);
      }
      if (pathname.startsWith("/api/project/") && request.method === "GET") {
        const id = pathname.split("/")[3];
        return withCors(await handleProject(id, env), env);
      }
      if (pathname === "/api/health" && request.method === "GET") {
        return withCors(await handleHealth(env), env);
      }
      // Anything else matching /{id}/{filepath} is a hosted static file.
      if (/^\/[A-Za-z0-9_-]{6,}\/.+/.test(pathname)) {
        return serveFile(pathname, env);
      }
      return withCors(json({ error: "Not found" }, 404), env);
    } catch (err) {
      return withCors(json({ error: "Server error", message: err.message }, 500), env);
    }
  },
};
