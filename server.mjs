// 로컬 개발 서버: public/ 정적 파일만 제공한다. (AI 는 앱이 사용자 키로 OpenAI 를 직접 호출)
// 실행: node server.mjs  →  http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// .env 읽기 (의존성 없이)
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const PUBLIC = path.join(ROOT, 'public');
const BLOCKED = /(^|\/)\./;

async function handleApi(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, '').replace(/[^a-z0-9-]/gi, '');
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!name || name.startsWith('_') || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"not_found"}');
  }
  const mod = await import(pathToFileURL(file).href);
  const fn = mod[req.method];
  if (!fn) {
    res.writeHead(405, { 'content-type': 'application/json' });
    return res.end('{"error":"method_not_allowed"}');
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await fn(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function handleStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (BLOCKED.test(p)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"server_error"}');
  }
}).listen(PORT, () => {
  console.log(`VOICE FIT dev server → http://localhost:${PORT}`);
  console.log('AI 는 앱 설정의 "내 OpenAI 키"로 기기에서 직접 호출합니다 (서버는 화면 파일만 제공).');
});
