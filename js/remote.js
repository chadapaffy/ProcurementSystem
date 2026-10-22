/*
 * ตัวเชื่อม Supabase แบบเบา (ไม่ต้องใช้ไลบรารีภายนอก)
 *   - ล็อกอินด้วยอีเมล + รหัสผ่าน (Supabase Auth / GoTrue REST) เก็บ session ใน localStorage และต่ออายุให้เอง
 *   - เรียกฟังก์ชันในฐานข้อมูล app_* ผ่าน PostgREST (/rest/v1/rpc/<ชื่อ>) — ดู supabase/schema.sql
 * เบราว์เซอร์ไม่มีสิทธิ์อ่านเขียนตารางตรง ๆ ทุกการเรียกตรวจสิทธิ์ที่ฝั่งเซิร์ฟเวอร์
 */
(function () {
  'use strict';

  const CFG = window.PROCUREMENT_CONFIG || {};
  const enabled = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const base = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
  const STORE_KEY = 'procurement.auth';

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code; // 'AUTH' = ต้องล็อกอินใหม่, 'NETWORK' = เชื่อมต่อไม่ได้, อื่น ๆ = รหัสจากฐานข้อมูล
    }
  }

  let session = null;
  try { session = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { session = null; }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s)); else localStorage.removeItem(STORE_KEY);
    } catch (e) { /* ignore */ }
  }

  const nowSec = () => Math.floor(Date.now() / 1000);

  async function http(path, options) {
    let res;
    try {
      res = await fetch(base + path, options);
    } catch (e) {
      throw new ApiError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', 0, 'NETWORK');
    }
    let body = null;
    const text = await res.text();
    if (text) { try { body = JSON.parse(text); } catch (e) { body = { message: text }; } }
    return { status: res.status, ok: res.ok, body };
  }

  const baseHeaders = () => ({ apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' });

  function authMessage(body) {
    const raw = body && (body.error_description || body.msg || body.message || body.error) || '';
    if (/invalid login credentials|invalid_grant/i.test(raw)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
    if (/email not confirmed/i.test(raw)) return 'บัญชียังไม่ได้ยืนยันอีเมล กรุณาติดต่อผู้ดูแลระบบ';
    if (/rate limit|too many/i.test(raw)) return 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่';
    return raw || 'เข้าสู่ระบบไม่สำเร็จ';
  }

  function toSession(body) {
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at || nowSec() + Number(body.expires_in || 3600),
      user: { id: body.user && body.user.id, email: body.user && body.user.email }
    };
  }

  async function signIn(email, password) {
    const r = await http('/auth/v1/token?grant_type=password', { method: 'POST', headers: baseHeaders(), body: JSON.stringify({ email, password }) });
    if (!r.ok) throw new ApiError(authMessage(r.body), r.status, 'LOGIN');
    saveSession(toSession(r.body));
    return session.user;
  }

  let refreshing = null;
  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new ApiError('หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่', 401, 'AUTH'));
    if (!refreshing) {
      refreshing = http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: baseHeaders(), body: JSON.stringify({ refresh_token: session.refresh_token }) })
        .then((r) => {
          if (!r.ok) { saveSession(null); throw new ApiError('หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่', 401, 'AUTH'); }
          saveSession(toSession(r.body));
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function signOut() {
    const token = session && session.access_token;
    saveSession(null);
    if (!token) return;
    try { await fetch(base + '/auth/v1/logout', { method: 'POST', headers: Object.assign(baseHeaders(), { Authorization: 'Bearer ' + token }) }); } catch (e) { /* ออฟไลน์: session ในเครื่องถูกลบแล้ว */ }
  }

  /** เรียกฟังก์ชันในฐานข้อมูล: args = พารามิเตอร์ตามชื่อ (p_...) */
  async function rpc(fn, args) {
    if (!session) throw new ApiError('กรุณาเข้าสู่ระบบ', 401, 'AUTH');
    if (session.expires_at - nowSec() < 60) await refresh();
    const call = () => http('/rest/v1/rpc/' + fn, {
      method: 'POST', headers: Object.assign(baseHeaders(), { Authorization: 'Bearer ' + session.access_token }), body: JSON.stringify(args || {})
    });
    let r = await call();
    if (r.status === 401) { await refresh(); r = await call(); }
    if (r.status === 401) { saveSession(null); throw new ApiError('หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่', 401, 'AUTH'); }
    if (!r.ok) throw new ApiError((r.body && (r.body.message || r.body.hint)) || 'ทำรายการไม่สำเร็จ (' + r.status + ')', r.status, r.body && r.body.code);
    return r.body === undefined ? null : r.body;
  }

  window.RemoteApi = {
    enabled,
    ApiError,
    hasSession: () => !!session,
    sessionUser: () => (session && session.user) || null,
    signIn,
    signOut,
    me: () => rpc('app_me'),
    load: () => rpc('app_load'),
    saveMaster: (key, data, renames) => rpc('app_save_master', { p_key: key, p_data: data, p_renames: renames || [] }),
    saveBudget: (budget, expectedVersion) => rpc('app_save_budget', { p_budget: budget, p_expected_version: expectedVersion == null ? null : expectedVersion }),
    deleteBudget: (id) => rpc('app_delete_budget', { p_id: id }),
    submitRequest: (request) => rpc('app_submit_request', { p_request: request }),
    decide: (id, decision, comment) => rpc('app_decide_request', { p_id: id, p_decision: decision, p_comment: comment || '' }),
    cancel: (id, reason) => rpc('app_cancel_request', { p_id: id, p_reason: reason || '' }),
    recordPayment: (id, payment) => rpc('app_record_payment', { p_id: id, p_payment: payment }),
    deletePayment: (id, payId) => rpc('app_delete_payment', { p_id: id, p_pay_id: payId }),
    accountingSave: (id, data) => rpc('app_accounting_save', { p_id: id, p_data: data }),
    listUsers: () => rpc('app_list_users'),
    updateUser: (u) => rpc('app_update_user', { p_id: u.id, p_name: u.name, p_title: u.title, p_department: u.department, p_role: u.role || '', p_active: u.active })
  };
})();
