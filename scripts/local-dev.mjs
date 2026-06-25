import http from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 3000);

const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mockRes(res) {
  return {
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return this;
    },
  };
}

const tagHandlerPromise = import(
  pathToFileURL(join(root, 'api/tag.ts')).href
).then((mod) => mod.default);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/api/tag') {
    const handler = await tagHandlerPromise;
    const body = await readBody(req);
    await handler(
      {
        method: req.method,
        body,
        headers: req.headers,
        socket: req.socket,
      },
      mockRes(res),
    );
    if (!res.writableEnded) res.end();
    return;
  }

  let filePath = join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!existsSync(filePath) && !extname(filePath)) {
    filePath += '.html';
  }
  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.setHeader('Content-Type', mime[extname(filePath)] || 'application/octet-stream');
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Local dev server running at http://localhost:${port}`);
  if (process.env.GEMINI_API_KEY?.trim()) {
    console.log('Gemini tagging is enabled.');
  } else {
    console.log('Set GEMINI_API_KEY in .env to enable live tagging.');
  }
});
