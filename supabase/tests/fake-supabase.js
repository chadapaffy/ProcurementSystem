/*
 * Supabase จำลองสำหรับทดสอบหน้าเว็บ (ไม่ใช่ของจริง ห้ามใช้งานจริง)
 *   POST /auth/v1/token?grant_type=password|refresh_token   (GoTrue แบบย่อ)
 *   POST /auth/v1/logout
 *   POST /rest/v1/rpc/<ฟังก์ชัน>                              (PostgREST แบบย่อ: เรียก app_* ใน Postgres จริงในฐานะ authenticated)
 *   POST /__admin/sql, /__admin/user, /__admin/ttl, /__admin/revoke   (ตัวช่วยตั้งค่าตอนทดสอบ)
 *
 * ต้องรัน supabase/tests/shim.sql และ supabase/schema.sql ในฐานข้อมูลทดสอบก่อน
 */
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

function startFake(options) {
  const opts = Object.assign({ port: 0, anonKey: 'test-anon-key', database: 'sp' }, options || {});
  const pool = new Pool({ database: opts.database, max: 4 });
  const passwords = new Map(); // email → password
  const refreshTokens = new Map(); // refresh token → user id
  let ttl = 3600;
  const stats = { logins: 0, refreshes: 0, rpcs: 0, rpcLog: [] };

  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, prefer',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } }); });

  const issue = async (userId, email) => {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const refresh = crypto.randomBytes(12).toString('hex');
    refreshTokens.set(refresh, { id: userId, email });
    return { access_token: 'h.' + b64({ sub: userId, exp }) + '.s', token_type: 'bearer', expires_in: ttl, expires_at: exp, refresh_token: refresh, user: { id: userId, email } };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204);
    try {
      if (url.pathname.startsWith('/__admin/')) {
        const body = await readBody(req);
        if (url.pathname === '/__admin/sql') {
          const r = await pool.query(body.sql, body.params || []);
          return send(res, 200, r.rows);
        }
        if (url.pathname === '/__admin/user') {
          const r = await pool.query('insert into auth.users (email) values ($1) on conflict do nothing returning id', [body.email]);
          const id = r.rows[0] ? r.rows[0].id : (await pool.query('select id from auth.users where email = $1', [body.email])).rows[0].id;
          passwords.set(body.email, body.password);
          return send(res, 200, { id });
        }
        if (url.pathname === '/__admin/ttl') { ttl = body.ttl; return send(res, 200, { ttl }); }
        if (url.pathname === '/__admin/revoke') { refreshTokens.clear(); return send(res, 200, {}); }
        if (url.pathname === '/__admin/stats') return send(res, 200, stats);
        return send(res, 404, { message: 'not found' });
      }
      if (req.headers.apikey !== opts.anonKey) return send(res, 401, { message: 'Invalid API key' });

      if (url.pathname === '/auth/v1/token') {
        const body = await readBody(req);
        if (url.searchParams.get('grant_type') === 'password') {
          const row = (await pool.query('select id, email from auth.users where email = $1', [body.email])).rows[0];
          if (!row || passwords.get(body.email) !== body.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
          stats.logins += 1;
          return send(res, 200, await issue(row.id, row.email));
        }
        const rt = refreshTokens.get(body.refresh_token);
        if (!rt) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
        refreshTokens.delete(body.refresh_token);
        stats.refreshes += 1;
        return send(res, 200, await issue(rt.id, rt.email));
      }
      if (url.pathname === '/auth/v1/logout') return send(res, 204);

      const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
      if (m && req.method === 'POST') {
        const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
        let claims;
        try { claims = unb64(auth.split('.')[1]); } catch (e) { return send(res, 401, { code: 'PGRST301', message: 'JWT invalid' }); }
        if (claims.exp < Math.floor(Date.now() / 1000)) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
        const body = await readBody(req);
        const fn = m[1];
        stats.rpcs += 1;
        stats.rpcLog.push(fn);
        const sig = await pool.query(
          `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
        if (!sig.rows.length) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.' + fn });
        const { names, types } = sig.rows[0];
        const keys = Object.keys(body);
        const bad = keys.find((k) => !(names || []).includes(k));
        if (bad) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.' + fn + ' with parameter ' + bad });
        const args = keys.map((k, i) => `${k} => $${i + 1}::${types[names.indexOf(k)]}`).join(', ');
        const vals = keys.map((k) => (body[k] === null ? null : typeof body[k] === 'object' ? JSON.stringify(body[k]) : String(body[k])));
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('set local role authenticated');
          await client.query("select set_config('request.jwt.claim.sub', $1, true)", [claims.sub]);
          const r = await client.query(`select public.${fn}(${args}) as r`, vals);
          await client.query('commit');
          const v = r.rows[0].r;
          return send(res, v === '' ? 204 : 200, v === '' ? undefined : v);
        } catch (e) {
          await client.query('rollback').catch(() => {});
          const status = e.code === '42501' ? 403 : e.code === '40001' ? 409 : e.code === 'P0001' ? 400 : 400;
          return send(res, status, { code: e.code, message: e.message, details: null, hint: null });
        } finally { client.release(); }
      }
      return send(res, 404, { message: 'not found' });
    } catch (e) {
      return send(res, 500, { message: String(e && e.message) });
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + server.address().port,
      anonKey: opts.anonKey,
      stats,
      admin: async (path, body) => { const r = await fetch('http://127.0.0.1:' + server.address().port + '/__admin/' + path, { method: 'POST', body: JSON.stringify(body || {}) }); return r.json(); },
      close: async () => { await new Promise((r) => server.close(r)); await pool.end(); }
    }));
  });
}

module.exports = { startFake };
