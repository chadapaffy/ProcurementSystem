/*
 * ทดสอบ supabase/schema.sql กับ Postgres จริง (จำลองส่วน auth ของ Supabase ด้วย shim.sql)
 *
 *   PGHOST=/tmp/pgtest PGPORT=5544 PGUSER=postgres node run.js
 *
 * ทุกการเรียกจำลองการเรียกจากเบราว์เซอร์: role = authenticated และ auth.uid() = ผู้ใช้ที่ระบุ
 */
const { Client } = require('pg');

const db = new Client({ database: process.env.PGDATABASE || 'sp' });
let fails = 0;
let passes = 0;
const ok = (name, cond, extra) => {
  if (cond) passes += 1; else { fails += 1; console.log('FAIL', name, extra === undefined ? '' : '| ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))); }
};

/** เรียก SQL ในฐานะผู้ใช้ (authenticated); คืน { rows } หรือ { error } */
async function as(uid, sql, params) {
  await db.query('begin');
  try {
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid || '']);
    const res = await db.query(sql, params);
    await db.query('commit');
    return { rows: res.rows };
  } catch (e) {
    await db.query('rollback');
    return { error: e.message, code: e.code };
  }
}
const rpc = async (uid, fn, args) => {
  const cast = (a) => (typeof a === 'number' ? '::integer' : typeof a === 'string' ? '::text' : '::jsonb');
  const marks = args.map((a, i) => '$' + (i + 1) + cast(a)).join(', ');
  const r = await as(uid, `select public.${fn}(${marks}) as r`, args.map((a) => (typeof a === 'number' || typeof a === 'string' ? a : JSON.stringify(a))));
  return r.error ? r : { data: r.rows[0].r };
};
// ฟังก์ชันที่รับ text/uuid/boolean ไม่ใช่ jsonb
const call = async (uid, sql, params) => {
  const r = await as(uid, sql, params);
  return r.error ? r : { data: r.rows[0] && r.rows[0].r };
};

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

(async () => {
  await db.connect();
  await db.query('truncate public.app_requests, public.app_budgets, public.app_master, public.app_counters cascade');
  await db.query('delete from auth.users');
  // คืนบทบาทตั้งต้นและลบบทบาทที่การทดสอบรอบก่อนสร้างไว้
  await db.query('delete from public.app_roles where not is_system');
  await db.query(`update public.app_roles r set permissions = d.p from (values
    ('admin', array['budget.view_all','master.manage','user.manage']), ('requester', array['request.create']),
    ('finance', array['budget.view_all','budget.manage','master.manage','request.decide','payment.record']),
    ('accounting', array['budget.view_all','accounting.record'])) as d(k, p) where r.key = d.k`);

  // ---- ผู้ใช้ (สร้างใน auth.users เหมือนที่ Supabase Dashboard ทำ → trigger สร้าง profile)
  const mk = async (email) => (await db.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
  const F = await mk('fin@example.com');
  const F2 = await mk('fin2@example.com');
  const R1 = await mk('req1@example.com');
  const R2 = await mk('req2@example.com');
  const A = await mk('acc@example.com');
  const X = await mk('new@example.com'); // ยังไม่ได้รับบทบาท
  const ADM = await mk('admin@example.com');
  const profiles = (await db.query('select count(*)::int n from public.profiles')).rows[0].n;
  ok('trigger สร้าง profile ให้ผู้ใช้ใหม่ทุกคน', profiles === 7, profiles);
  await db.query("update public.profiles set role='finance', name='การเงิน 1' where id=$1", [F]);
  await db.query("update public.profiles set role='finance', name='การเงิน 2' where id=$1", [F2]);
  await db.query("update public.profiles set role='requester', name='ผู้ขอ 1' where id=$1", [R1]);
  await db.query("update public.profiles set role='requester', name='ผู้ขอ 2' where id=$1", [R2]);
  await db.query("update public.profiles set role='accounting', name='บัญชี' where id=$1", [A]);
  await db.query("update public.profiles set role='admin', name='ผู้ดูแล' where id=$1", [ADM]);

  // ---- 1. ปิดการเข้าถึงตารางตรง ๆ
  for (const t of ['profiles', 'app_budgets', 'app_requests', 'app_master', 'app_counters']) {
    const r = await as(F, `select count(*) from public.${t}`);
    ok('อ่านตาราง ' + t + ' ตรง ๆ ไม่ได้ (แม้เป็นการเงิน)', !!r.error && /permission denied/.test(r.error), r);
  }
  ok('เขียนตารางตรง ๆ ไม่ได้', !!(await as(R1, "update public.profiles set role='finance' where id=$1", [R1])).error);
  ok('anon เรียกฟังก์ชันไม่ได้', await db.query('begin').then(async () => {
    await db.query('set local role anon');
    try { await db.query('select public.app_load()'); await db.query('rollback'); return false; } catch (e) { await db.query('rollback'); return /permission denied/.test(e.message); }
  }));
  ok('ฟังก์ชันภายใน _app_* เรียกจากเบราว์เซอร์ไม่ได้', !!(await as(F, "select public._app_next('x')")).error);

  // ---- 2. ผู้ใช้ที่ยังไม่มีบทบาท
  const me = await call(X, 'select public.app_me() as r');
  ok('app_me ของผู้ใช้ใหม่: role เป็น null', me.data && me.data.role === null && me.data.email === 'new@example.com', me);
  ok('ผู้ใช้ที่ไม่มีบทบาท app_load ไม่ได้', !!(await call(X, 'select public.app_load() as r')).error);
  ok('ไม่ล็อกอิน (ไม่มี uid) app_load ไม่ได้', !!(await call('', 'select public.app_load() as r')).error);

  // ---- 3. งบ (การเงิน)
  const budget = {
    id: 'b1', type: 'CAPEX', company: 'PSL', fiscalYear: 2026, group: '01', code: 'EN0001', name: 'ปรับปรุงสายการผลิต', department: 'ฝ่ายวิศวกรรม',
    ownerId: R1, note: '', items: [
      { id: 'c1', code: '2026-01-EN001', name: 'เครื่องตัด', assetType: 'เครื่องจักร', doa: '2.4', amount: 500000 },
      { id: 'c2', code: '2026-01-EN002', name: 'อุปกรณ์', assetType: 'เครื่องมือและอุปกรณ์', doa: '2.5', amount: 610000 }],
    revisions: [{ no: 0, at: '2026-01-01T00:00:00.000Z', by: F, note: 'ตั้งงบ', total: 1110000, items: [] }]
  };
  ok('ผู้ขอบันทึกงบไม่ได้', !!(await rpc(R1, 'app_save_budget', [budget])).error);
  ok('ผู้ขอที่เป็นเจ้าของ owner ไม่ใช่ requester ไม่ได้', !!(await rpc(F, 'app_save_budget', [Object.assign({}, budget, { ownerId: A })])).error);
  const sb = await rpc(F, 'app_save_budget', [budget]);
  ok('การเงินบันทึกงบได้ version=1', sb.data && sb.data.version === 1, sb);
  ok('รหัสงบซ้ำไม่ได้', /มีอยู่แล้ว/.test((await rpc(F, 'app_save_budget', [Object.assign({}, budget, { id: 'bX' })])).error || ''));
  const upd = await rpc(F, 'app_save_budget', [Object.assign({}, sb.data, { name: 'ชื่อใหม่' }), 1]);
  ok('แก้งบด้วย version ถูกต้อง → version=2', upd.data && upd.data.version === 2 && upd.data.name === 'ชื่อใหม่', upd);
  ok('แก้งบด้วย version เก่า → ชนกัน', /มีผู้อื่นแก้ไข/.test((await rpc(F2, 'app_save_budget', [sb.data, 1])).error || ''));

  const cbs = {
    id: 'b3', type: 'CBS', company: 'PSL', fiscalYear: 2026, code: 'PJ0001-1', parentCode: 'PJ0001', name: 'ผลิตกล้าไม้', department: 'ฝ่ายโครงการ', ownerId: R2,
    status: 'On Progress', note: '', production: {}, items: [
      { id: 'i1', code: '1', name: 'วัตถุดิบ', amount: 0, vat: 0, glCode: '', glName: '' },
      { id: 'i2', code: '1.1', name: 'ดินผสม', amount: 20000, vat: 0, glCode: '510101', glName: 'ค่าวัตถุดิบ' },
      { id: 'i3', code: '1.2', name: 'ถุงเพาะ', amount: 15000, vat: 0, glCode: '510101', glName: 'ค่าวัตถุดิบ' }],
    revisions: [{ no: 0, at: '2026-01-01T00:00:00.000Z', by: F, note: 'ตั้งงบ', total: 35000, items: [] }]
  };
  ok('การเงินบันทึกงบ CBS', !!(await rpc(F, 'app_save_budget', [cbs])).data);

  // ---- 4. app_load ตามบทบาท
  const lf = (await call(F, 'select public.app_load() as r')).data;
  const l1 = (await call(R1, 'select public.app_load() as r')).data;
  const l2 = (await call(R2, 'select public.app_load() as r')).data;
  const la = (await call(A, 'select public.app_load() as r')).data;
  ok('การเงินเห็นงบทั้งหมด', lf.budgets.length === 2, lf.budgets.length);
  ok('ผู้ขอ 1 เห็นเฉพาะงบของตน', l1.budgets.length === 1 && l1.budgets[0].id === 'b1', l1.budgets.map((b) => b.id));
  ok('ผู้ขอ 2 เห็นเฉพาะงบของตน', l2.budgets.length === 1 && l2.budgets[0].id === 'b3');
  ok('บัญชีเห็นงบทั้งหมด', la.budgets.length === 2);
  ok('งบที่โหลดมีเวอร์ชันและ id', lf.budgets[0].id && lf.budgets[0].version >= 1);
  ok('รายชื่อผู้ใช้ไม่มีผู้ที่ยังไม่มีบทบาท', lf.users.length === 6 && !lf.users.some((u) => u.id === X), lf.users.length);
  ok('รายชื่อผู้ใช้บอกว่าใครขอเบิกได้ (canRequest)', lf.users.find((u) => u.id === R1).canRequest === true && lf.users.find((u) => u.id === F).canRequest === false);
  ok('app_load ส่งสิทธิ์ของผู้ใช้', lf.me.perms.includes('request.decide') && l1.me.perms.length === 1 && l1.me.perms[0] === 'request.create' && l1.me.roleName === 'ผู้ขอใช้งบ', [lf.me.perms, l1.me]);
  ok('รายชื่อผู้ใช้ไม่เปิดเผยอีเมล', !lf.users.some((u) => 'email' in u));

  // ---- 5. ขอเบิก CAPEX
  const line = (itemId, before, vat) => ({ itemId, description: 'รายการ', amountBeforeVat: before, vat: vat ? 7 : 0 });
  const req = (extra) => Object.assign({ budgetId: 'b1', payee: 'Supplier', poNo: 'N/A', purpose: 'ใช้งาน', lines: [line('c1', 100000, true)], paymentPlan: { mode: 'single', installments: [] }, paymentTerms: 'จ่ายครั้งเดียว' }, extra);
  ok('ผู้ขอ 2 ขอเบิกงบของผู้ขอ 1 ไม่ได้', !!(await rpc(R2, 'app_submit_request', [req()])).error);
  ok('การเงินสร้างคำขอไม่ได้', !!(await rpc(F, 'app_submit_request', [req()])).error);
  ok('CAPEX เกินงบคงเหลือไม่ได้', /เกินงบคงเหลือ/.test((await rpc(R1, 'app_submit_request', [req({ lines: [line('c1', 600000, false)] })])).error || ''));
  ok('CAPEX หลายรายการย่อยในใบเดียวไม่ได้', /รายการย่อยเดียว/.test((await rpc(R1, 'app_submit_request', [req({ lines: [line('c1', 1000), line('c2', 1000)] })])).error || ''));
  ok('บรรทัดที่ไม่มีรายการงบ → error', !!(await rpc(R1, 'app_submit_request', [req({ lines: [line('zzz', 1000)] })])).error);
  ok('แบ่งงวดรวมไม่ถึง 100% ไม่ได้', !!(await rpc(R1, 'app_submit_request', [req({ paymentPlan: { mode: 'installments', installments: [{ pct: 40 }, { pct: 50 }] } })])).error);
  const r1 = await rpc(R1, 'app_submit_request', [req({ paymentPlan: { mode: 'installments', installments: [{ pct: 40, note: 'a' }, { pct: 60, note: 'b' }] }, amount: 1, status: 'approved', docNo: 'HACK' })]);
  ok('ส่งคำขอ CAPEX ได้ สถานะ pending', r1.data && r1.data.status === 'pending' && r1.data.no === 'REQ-2026-0001', r1);
  ok('ยอดคำนวณจากบรรทัดฝั่งเซิร์ฟเวอร์ (ไม่เชื่อค่าที่ส่งมา)', r1.data && r1.data.amount === 107000 && r1.data.vat === 7000 && !r1.data.docNo, r1.data);
  ok('มีขั้นตอนรอการเงิน', r1.data && r1.data.steps[0].status === 'waiting');
  const id1 = r1.data.id;
  const r1b = await rpc(R1, 'app_submit_request', [req({ lines: [line('c1', 390000, false)] })]);
  ok('ยอดที่จองไว้แล้วถูกหักจากคงเหลือ: คงเหลือ 393,000 ขอ 390,000 ได้', !!r1b.data && r1b.data.amount === 390000, r1b);
  ok('ยอดเกินหลังรวมคำขอที่จองไว้ → ไม่ได้ (เหลือ 3,000 ขอ 4,000)', !!(await rpc(R1, 'app_submit_request', [req({ lines: [line('c1', 4000, false)] })])).error);
  ok('ผู้ขอเห็นคำขอของตน / ผู้ขอ 2 ไม่เห็น', (await call(R1, 'select public.app_load() as r')).data.requests.length === 2 && (await call(R2, 'select public.app_load() as r')).data.requests.length === 0);

  // ---- 6. ตัดสินใจ
  ok('ผู้ขออนุมัติเองไม่ได้', !!(await call(R1, "select public.app_decide_request($1, 'approved', '') as r", [id1])).error);
  ok('บัญชีอนุมัติไม่ได้', !!(await call(A, "select public.app_decide_request($1, 'approved', '') as r", [id1])).error);
  ok('ไม่อนุมัติต้องมีเหตุผล', !!(await call(F, "select public.app_decide_request($1, 'rejected', '') as r", [id1])).error);
  const ap = await call(F, "select public.app_decide_request($1, 'approved', 'ok') as r", [id1]);
  ok('การเงินอนุมัติ → ออกเลขที่ PSL26-001', ap.data && ap.data.status === 'approved' && ap.data.docNo === 'PSL26-001' && ap.data.steps[0].status === 'approved' && ap.data.steps[0].by === F, ap);
  ok('อนุมัติซ้ำไม่ได้', !!(await call(F, "select public.app_decide_request($1, 'approved', '') as r", [id1])).error);
  const id1b = r1b.data.id;
  const rj = await call(F, "select public.app_decide_request($1, 'rejected', 'ผิดรายการ') as r", [id1b]);
  ok('ไม่อนุมัติ → rejected + เหตุผล', rj.data && rj.data.status === 'rejected' && rj.data.steps[0].comment === 'ผิดรายการ', rj);
  ok('ผู้ขอ 2 ยกเลิกคำขอของผู้ขอ 1 ไม่ได้', !!(await call(R2, 'select public.app_cancel_request($1, $2) as r', [id1b, 'x'])).error);
  // แก้ไขแล้วส่งใหม่
  const rs = await rpc(R1, 'app_submit_request', [req({ id: id1b, lines: [line('c1', 300000, false)] })]);
  ok('แก้ไขส่งใหม่: เลขที่คำขอเดิม + เก็บประวัติรอบก่อน', rs.data && rs.data.no === r1b.data.no && rs.data.status === 'pending' && rs.data.history.length === 1 && rs.data.history[0].status === 'rejected', rs);
  ok('ส่งใหม่กับคำขอที่ไม่ได้ถูกไม่อนุมัติ → ไม่ได้', !!(await rpc(R1, 'app_submit_request', [req({ id: id1 })])).error);
  const cn = await call(R1, 'select public.app_cancel_request($1, $2) as r', [id1b, '']);
  ok('ผู้ขอยกเลิกคำขอที่รออยู่ได้', cn.data && cn.data.status === 'cancelled', cn);
  ok('CAPEX ที่อนุมัติแล้วผู้ขอยกเลิกไม่ได้', !!(await call(R1, 'select public.app_cancel_request($1, $2) as r', [id1, 'x'])).error);
  const bud = (await call(R1, 'select public.app_load() as r')).data;
  ok('ยอดที่ถูกยกเลิกคืนให้ขอใหม่ได้', !!(await rpc(R1, 'app_submit_request', [req({ lines: [line('c1', 390000, false)] })])).data);

  // ---- 7. งวดจ่าย
  ok('ผู้ขอบันทึกงวดจ่ายไม่ได้', !!(await rpc(R1, 'app_record_payment', [id1, {}])).error);
  const pay = (extra) => Object.assign({ label: 'งวดที่ 1 (40%)', deliveryDate: '', dueDate: iso(2026, 11, 1), amountBeforeVat: 40000, vat: 2800 }, extra);
  const p1 = await rpc(F, 'app_record_payment', [id1, pay()]);
  ok('การเงินบันทึกงวดที่ 1', p1.data && p1.data.payments.length === 1 && p1.data.payments[0].amount === 42800, p1);
  ok('งวดเกินยอดค้าง → ไม่ได้', !!(await rpc(F, 'app_record_payment', [id1, pay({ amountBeforeVat: 70000, vat: 4900 })])).error);
  ok('ไม่ระบุวันกำหนดจ่าย → ไม่ได้', !!(await rpc(F, 'app_record_payment', [id1, pay({ dueDate: '' })])).error);
  const p2 = await rpc(F, 'app_record_payment', [id1, pay({ label: 'งวดที่ 2', amountBeforeVat: 60000, vat: 4200 })]);
  ok('งวดที่ 2 ครบยอด', p2.data && p2.data.payments.length === 2 && p2.data.payments[1].amount === 64200, p2);
  const pid1 = p2.data.payments[0].id;
  const pid2 = p2.data.payments[1].id;
  const delp = await call(F, 'select public.app_delete_payment($1, $2) as r', [id1, pid2]);
  ok('ลบงวดที่ยังไม่มีข้อมูลบัญชีได้', delp.data && delp.data.payments.length === 1, delp);
  await rpc(F, 'app_record_payment', [id1, pay({ label: 'งวดที่ 2', amountBeforeVat: 60000, vat: 4200 })]);
  const cur = (await call(F, 'select public.app_load() as r')).data.requests.find((r) => r.id === id1);
  const [pa, pb] = cur.payments.map((p) => p.id);

  // ---- 8. บัญชี
  ok('ผู้ขอบันทึกข้อมูลบัญชีไม่ได้', !!(await rpc(R1, 'app_accounting_save', [id1, { payments: [] }])).error);
  ok('การเงินบันทึกข้อมูลบัญชีไม่ได้', !!(await rpc(F, 'app_accounting_save', [id1, { payments: [] }])).error);
  ok('Asset + Expenses เกินยอดงวด → ไม่ได้', !!(await rpc(A, 'app_accounting_save', [id1, { payments: [{ id: pa, asset: 99999, expense: 0 }] }])).error);
  const ac = await rpc(A, 'app_accounting_save', [id1, { payments: [{ id: pa, paidAt: iso(2026, 11, 5), asset: 40000, expense: 2800 }] }]);
  const pay1 = ac.data && ac.data.payments.find((p) => p.id === pa);
  const pay2 = ac.data && ac.data.payments.find((p) => p.id === pb);
  ok('บัญชีลงวันที่จ่ายและแยก Asset/Expenses งวดที่ 1', pay1 && pay1.paidAt === iso(2026, 11, 5) && pay1.paidBy === A && pay1.asset === 40000 && pay1.expense === 2800 && pay1.acctAt, ac);
  ok('งวดที่ 2 ยังไม่ถูกแตะ', pay2 && !pay2.paidAt && !pay2.acctAt, pay2);
  ok('ลบงวดที่บัญชีบันทึกแล้วไม่ได้', !!(await call(F, 'select public.app_delete_payment($1, $2) as r', [id1, pa])).error);
  const ac2 = await rpc(A, 'app_accounting_save', [id1, { payments: [{ id: pa, paidAt: '' }] }]);
  ok('ล้างวันที่จ่ายได้ (ข้อมูลแยก Asset/Expenses คงเดิม)', ac2.data && !ac2.data.payments[0].paidAt && ac2.data.payments[0].asset === 40000, ac2);

  // ---- 9. CBS
  const creq = (extra) => Object.assign({ budgetId: 'b3', payee: 'ร้านค้า', poNo: 'N/A', expenseDate: iso(2026, 3, 1), lines: [{ itemId: 'i2', description: 'ดินผสม', amountBeforeVat: 5000, vat: 0 }] }, extra);
  ok('CBS เบิกรายการแม่ไม่ได้', /รายการล่างสุด/.test((await rpc(R2, 'app_submit_request', [creq({ lines: [{ itemId: 'i1', description: 'x', amountBeforeVat: 100, vat: 0 }] })])).error || ''));
  const c1 = await rpc(R2, 'app_submit_request', [creq()]);
  ok('CBS ออกเอกสารทันที CBS26-0001 พร้อม GL จากรายการต้นทุน', c1.data && c1.data.status === 'approved' && c1.data.docNo === 'CBS26-0001' && c1.data.lines[0].glCode === '510101' && c1.data.accounting.paymentStatus === 'รอจ่าย', c1);
  ok('CBS เกินงบต้องมีเหตุผล', /เหตุผล/.test((await rpc(R2, 'app_submit_request', [creq({ lines: [{ itemId: 'i2', description: 'ดินผสม', amountBeforeVat: 30000, vat: 0 }] })])).error || ''));
  const c2 = await rpc(R2, 'app_submit_request', [creq({ lines: [{ itemId: 'i2', description: 'ดินผสม', amountBeforeVat: 30000, vat: 7 }, { itemId: 'i3', description: 'ถุง', amountBeforeVat: 1000, vat: 0 }], overBudgetReason: 'ราคาขึ้น' })]);
  ok('CBS เกินงบ + เหตุผล → ออกเอกสาร (overBudget=true), VAT คิดจากเซิร์ฟเวอร์', c2.data && c2.data.overBudget === true && c2.data.docNo === 'CBS26-0002' && c2.data.lines[0].vat === 2100 && c2.data.amount === 33100, c2);
  ok('CBS ยกเลิกต้องมีเหตุผล', !!(await call(R2, 'select public.app_cancel_request($1, $2) as r', [c2.data.id, ' '])).error);
  const cc = await call(R2, 'select public.app_cancel_request($1, $2) as r', [c2.data.id, 'เลือกรายการผิด']);
  ok('ผู้ขอยกเลิกเอกสาร CBS ได้ พร้อมเหตุผล', cc.data && cc.data.status === 'cancelled' && cc.data.cancelReason === 'เลือกรายการผิด', cc);
  ok('บัญชียืนยันจ่าย CBS ต้องมีวันที่จ่าย', !!(await rpc(A, 'app_accounting_save', [c1.data.id, { paymentStatus: 'จ่ายแล้ว', paidAt: '', lines: [{ glCode: '510101', glName: 'x' }] }])).error);
  const ca = await rpc(A, 'app_accounting_save', [c1.data.id, { paymentStatus: 'จ่ายแล้ว', paidAt: iso(2026, 3, 10), lines: [{ glCode: '510109', glName: 'แก้ GL' }] }]);
  ok('บัญชียืนยันจ่ายและแก้ GL รายบรรทัด', ca.data && ca.data.accounting.paymentStatus === 'จ่ายแล้ว' && ca.data.accounting.paidAt === iso(2026, 3, 10) && ca.data.lines[0].glCode === '510109', ca);

  // ---- 10. ผู้ใช้
  ok('ผู้ขอดูรายชื่อผู้ใช้ทั้งหมดไม่ได้', !!(await call(R1, 'select public.app_list_users() as r')).error);
  ok('การเงินจัดการผู้ใช้ไม่ได้ (เป็นสิทธิ์ของ Admin)', !!(await call(F, 'select public.app_list_users() as r')).error);
  const ul = await call(ADM, 'select public.app_list_users() as r');
  ok('Admin ดูรายชื่อผู้ใช้ทั้งหมดพร้อมอีเมลได้ (รวมคนที่ยังไม่มีบทบาท)', ul.data && ul.data.length === 7 && ul.data.some((u) => u.email === 'new@example.com' && u.role === null), ul);
  const setUser = (uid, id, name, title, dept, role, active) => call(uid, 'select public.app_update_user($1::uuid, $2, $3, $4, $5, $6::boolean) as r', [id, name, title, dept, role, active]);
  ok('ผู้ขอแก้สิทธิ์ผู้ใช้ไม่ได้', !!(await setUser(R1, R1, 'x', '', '', 'finance', true)).error);
  const nu = await setUser(ADM, X, 'พนักงานใหม่', 'เจ้าหน้าที่', 'ฝ่ายผลิต', 'requester', true);
  ok('Admin กำหนดบทบาทให้ผู้ใช้ใหม่', nu.data && nu.data.role === 'requester' && nu.data.name === 'พนักงานใหม่', nu);
  ok('ผู้ใช้ใหม่เข้าใช้งานได้หลังได้บทบาท', !!(await call(X, 'select public.app_load() as r')).data);
  ok('ผู้ที่เป็นเจ้าของงบเปลี่ยนบทบาทไม่ได้', /เจ้าของงบ/.test((await setUser(ADM, R1, 'ผู้ขอ 1', '', '', 'accounting', true)).error || ''));
  ok('ปิดการใช้งาน → เข้าใช้ไม่ได้', await (async () => { await setUser(ADM, X, 'พนักงานใหม่', '', '', 'requester', false); return !!(await call(X, 'select public.app_load() as r')).error; })());
  ok('ปิดบัญชีการเงินคนที่ 2 ได้', !!(await setUser(ADM, F2, 'การเงิน 2', '', '', 'finance', false)).data);
  ok('Admin คนสุดท้ายลดบทบาทตัวเองไม่ได้', /อย่างน้อย 1 คน/.test((await setUser(ADM, ADM, 'ผู้ดูแล', '', '', 'accounting', true)).error || ''));
  ok('Admin คนสุดท้ายปิดบัญชีตัวเองไม่ได้', /อย่างน้อย 1 คน/.test((await setUser(ADM, ADM, 'ผู้ดูแล', '', '', 'admin', false)).error || ''));
  ok('กำหนดบทบาทที่ไม่มีอยู่ → error', /ไม่พบบทบาท/.test((await setUser(ADM, F2, 'การเงิน 2', '', '', 'nope', true)).error || ''));

  // ---- 11. ข้อมูลหลัก + เปลี่ยนชื่อแบบ cascade
  ok('ผู้ขอบันทึกข้อมูลหลักไม่ได้', !!(await call(R1, "select public.app_save_master('departments', '[]'::jsonb) as r")).error);
  ok('ชื่อข้อมูลหลักที่ไม่รู้จัก → error', !!(await call(F, "select public.app_save_master('nope', '[]'::jsonb) as r")).error);
  await call(F, "select public.app_save_master('assetTypes', $1::jsonb, $2::jsonb) as r", [JSON.stringify([{ name: 'เครื่องจักรกล' }, { name: 'เครื่องมือและอุปกรณ์' }]), JSON.stringify([{ from: 'เครื่องจักร', to: 'เครื่องจักรกล' }])]);
  await call(F, "select public.app_save_master('departments', $1::jsonb, $2::jsonb) as r", [JSON.stringify([{ name: 'ฝ่ายวิศวกรรมใหม่' }, { name: 'ฝ่ายโครงการ' }]), JSON.stringify([{ from: 'ฝ่ายวิศวกรรม', to: 'ฝ่ายวิศวกรรมใหม่' }])]);
  const ld = (await call(F, 'select public.app_load() as r')).data;
  const b1 = ld.budgets.find((b) => b.id === 'b1');
  ok('เปลี่ยนชื่อประเภทสินทรัพย์ → แก้ในรายการงบ', b1.items[0].assetType === 'เครื่องจักรกล' && b1.items[1].assetType === 'เครื่องมือและอุปกรณ์', b1.items);
  ok('เปลี่ยนชื่อหน่วยงาน → แก้ในงบ', b1.department === 'ฝ่ายวิศวกรรมใหม่' && ld.budgets.find((b) => b.id === 'b3').department === 'ฝ่ายโครงการ');
  ok('ข้อมูลหลักโหลดกลับมาได้', ld.master.departments.length === 2 && ld.master.assetTypes.length === 2);
  ok('งบที่ถูกแก้โดย cascade เพิ่ม version', b1.version >= 3, b1.version);

  // ---- 12. ลบงบ
  ok('ลบงบที่มีคำขอไม่ได้', /ขอเบิกแล้ว/.test((await call(F, 'select public.app_delete_budget($1) as r', ['b1'])).error || ''));
  await rpc(F, 'app_save_budget', [Object.assign({}, cbs, { id: 'b9', code: 'PJ9999', ownerId: R2 })]);
  ok('ผู้ขอลบงบไม่ได้', !!(await call(R2, 'select public.app_delete_budget($1) as r', ['b9'])).error);
  ok('การเงินลบงบที่ไม่มีคำขอได้', !(await call(F, 'select public.app_delete_budget($1) as r', ['b9'])).error);

  // ---- 13. Admin แยกจากการเงิน + บทบาท/สิทธิ์ปรับได้
  const lAdm = (await call(ADM, 'select public.app_load() as r')).data;
  ok('Admin เห็นงบ/คำขอทั้งหมด (สิทธิ์ดูทั้งหมด)', lAdm.budgets.length === 2 && lAdm.requests.length >= 2, [lAdm.budgets.length, lAdm.requests.length]);
  ok('Admin บันทึกงบไม่ได้', !!(await rpc(ADM, 'app_save_budget', [Object.assign({}, cbs, { id: 'bz', code: 'ZZ1' })])).error);
  ok('Admin อนุมัติเอกสารไม่ได้', !!(await call(ADM, "select public.app_decide_request($1, 'approved', '') as r", [id1])).error);
  ok('Admin จัดการข้อมูลหลักได้', !!(await call(ADM, "select public.app_save_master('departments', $1::jsonb) as r", [JSON.stringify([{ name: 'ฝ่ายวิศวกรรมใหม่' }, { name: 'ฝ่ายโครงการ' }])])).data);
  ok('การเงินดูรายการบทบาทไม่ได้', !!(await call(F, 'select public.app_list_roles() as r')).error);
  const lr = (await call(ADM, 'select public.app_list_roles() as r')).data;
  ok('Admin ดูรายการบทบาท + รายการสิทธิ์ทั้งหมด', lr.roles.length === 4 && lr.catalog.length === 8 && lr.roles.find((r) => r.key === 'finance').users >= 1, lr.roles.map((r) => r.key));
  const saveRole = (uid, key, name, desc, perms) => call(uid, 'select public.app_save_role($1, $2, $3, $4::jsonb) as r', [key, name, desc, JSON.stringify(perms)]);
  ok('ผู้ขอสร้างบทบาทไม่ได้', !!(await saveRole(R1, 'hack', 'x', '', ['user.manage'])).error);
  ok('รหัสบทบาทไม่ถูกรูปแบบ → error', !!(await saveRole(ADM, 'Bad Key', 'x', '', [])).error);
  ok('สิทธิ์ที่ไม่รู้จัก → error', /ไม่รู้จักสิทธิ์/.test((await saveRole(ADM, 'mgr', 'ผู้จัดการ', '', ['fly.rocket'])).error || ''));
  const mg = await saveRole(ADM, 'mgr', 'ผู้จัดการฝ่าย', 'อนุมัติเอกสารของฝ่าย', ['request.decide']);
  ok('สร้างบทบาทใหม่ได้', mg.data && mg.data.key === 'mgr' && mg.data.isSystem === false && mg.data.permissions.length === 1, mg);
  await setUser(ADM, X, 'พนักงานใหม่', '', '', 'mgr', true);
  const px = (await call(X, 'select public.app_load() as r')).data;
  ok('ผู้ใช้บทบาทใหม่ได้สิทธิ์ทันที: เห็นคำขอทั้งหมด (เพราะมีสิทธิ์อนุมัติ)', px && px.requests.length >= 2 && px.me.perms[0] === 'request.decide' && px.me.roleName === 'ผู้จัดการฝ่าย', px && px.me);
  const pend = (await call(F, 'select public.app_load() as r')).data.requests.find((r) => r.status === 'pending');
  ok('บทบาทใหม่อนุมัติได้ (ไม่ต้องเป็นการเงิน)', pend && !!(await call(X, "select public.app_decide_request($1, 'approved', 'ok') as r", [pend.id])).data, pend && pend.id);
  ok('แต่บันทึกงวดจ่ายไม่ได้ (ไม่มีสิทธิ์)', !!(await rpc(X, 'app_record_payment', [id1, {}])).error);
  ok('และขอเบิกไม่ได้', !!(await rpc(X, 'app_submit_request', [req()])).error);
  // เอาสิทธิ์ออกจากบทบาท → มีผลทันที
  await saveRole(ADM, 'finance', 'การเงิน', '', ['budget.view_all', 'master.manage', 'request.decide', 'payment.record']);
  ok('ถอนสิทธิ์จัดการงบจากบทบาทการเงิน → บันทึกงบไม่ได้ทันที', !!(await rpc(F, 'app_save_budget', [Object.assign({}, sb.data, { name: 'x' })])).error);
  await saveRole(ADM, 'finance', 'การเงิน', '', ['budget.view_all', 'budget.manage', 'master.manage', 'request.decide', 'payment.record']);
  ok('คืนสิทธิ์แล้วบันทึกงบได้อีก', !!(await rpc(F, 'app_save_budget', [(await call(F, 'select public.app_load() as r')).data.budgets.find((b) => b.id === 'b1')])).data);
  ok('ถอนสิทธิ์จัดการผู้ใช้จากบทบาท admin ไม่ได้ (เหลือผู้ดูแลไม่ถึง 1)', /อย่างน้อย 1 คน/.test((await saveRole(ADM, 'admin', 'ผู้ดูแลระบบ (Admin)', '', ['budget.view_all', 'master.manage'])).error || ''));
  ok('ถอนสิทธิ์ขอเบิกจากผู้ขอที่เป็นเจ้าของงบไม่ได้', /เจ้าของอยู่/.test((await saveRole(ADM, 'requester', 'ผู้ขอใช้งบ', '', [])).error || ''));
  ok('ลบบทบาทตั้งต้นไม่ได้', /ตั้งต้น/.test((await call(ADM, "select public.app_delete_role('finance') as r")).error || ''));
  ok('ลบบทบาทที่ยังมีผู้ใช้ไม่ได้', /ยังมีผู้ใช้/.test((await call(ADM, "select public.app_delete_role('mgr') as r")).error || ''));
  await setUser(ADM, X, 'พนักงานใหม่', '', '', 'requester', true);
  ok('ลบบทบาทที่ไม่มีผู้ใช้ได้', !(await call(ADM, "select public.app_delete_role('mgr') as r")).error);
  // บทบาทที่ไม่มีสิทธิ์เลย: เข้าระบบได้แต่เห็นเฉพาะของตน (ไม่เห็นอะไร)
  await saveRole(ADM, 'viewer0', 'ไม่มีสิทธิ์', '', []);
  await setUser(ADM, X, 'พนักงานใหม่', '', '', 'viewer0', true);
  const v0 = (await call(X, 'select public.app_load() as r')).data;
  ok('บทบาทไม่มีสิทธิ์: โหลดได้แต่ไม่เห็นงบ/คำขอของใคร', v0 && v0.budgets.length === 0 && v0.requests.length === 0, v0 && [v0.budgets.length, v0.requests.length]);

  console.log(`\n${passes} passed, ${fails} failed`);
  await db.end();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
