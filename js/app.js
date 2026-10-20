/*
 * ระบบขอเบิกใช้งบประมาณ (ต้นแบบ)
 *
 * งบได้รับอนุมัติมาแล้ว ระบบนี้ใช้ยืนยันว่าใช้ถูกตัวงบ และติดตามยอดคงเหลือ
 *
 * - การเงิน: บันทึกงบที่อนุมัติแล้ว และปรับงบ (เก็บประวัติทุกครั้ง)
 *     CAPEX = รหัสโครงการ (Project No.) → รายการย่อย (Item No.)
 *     CBS   = Job No. → รายการต้นทุนหลายชั้น (1 → 1.1 → 1.1.1) พร้อม GL Code
 * - ผู้ขอใช้งบ: ดูยอดคงเหลือ แล้วจัดทำเอกสารขอเบิกโดยระบุตัวงบทุกครั้งที่จะใช้
 *     CAPEX: ส่งให้การเงินตรวจสอบ → อนุมัติ (ออกใบเบิกงบประมาณ) / ไม่อนุมัติ (แก้ไขส่งใหม่หรือยกเลิก)
 *     CBS:   ออกเอกสารทันที ไม่ผ่านการเงิน (ใช้เกินงบได้แต่ต้องระบุเหตุผล) และผู้ขอยกเลิกเองได้
 * - บัญชี: บันทึกข้อมูลบัญชีของเอกสารที่ออกแล้ว (CAPEX แยก Asset/Expense, CBS GL Code/สถานะจ่าย)
 *
 * ข้อมูลเก็บใน localStorage ของเบราว์เซอร์ (ยังไม่มี backend) — ข้อมูลตัวอย่างทั้งหมดเป็นข้อมูลสมมติ
 */
(function () {
  'use strict';

  const DB_KEY = 'procurement.budget.v4';
  const VAT_RATE = 0.07;

  const USERS = [
    { id: 'req1', name: 'สมชาย ใจดี', title: 'วิศวกร ฝ่ายวิศวกรรม', role: 'requester' },
    { id: 'req2', name: 'สุดา รักงาน', title: 'เจ้าหน้าที่โครงการ ฝ่ายโครงการ', role: 'requester' },
    { id: 'fin1', name: 'มาลี เงินดี', title: 'เจ้าหน้าที่การเงิน', role: 'finance' },
    { id: 'acc1', name: 'วิไล บัญชีดี', title: 'เจ้าหน้าที่บัญชี', role: 'accounting' }
  ];

  const ROLE_LABEL = {
    requester: 'ผู้ขอใช้งบ',
    finance: 'การเงิน',
    accounting: 'บัญชี'
  };

  const COMPANIES = { PSL: 'บริษัท PSL (ตัวอย่าง)', PCC: 'บริษัท PCC (ตัวอย่าง)' };
  const TYPE_LABEL = { CAPEX: 'งบลงทุน (CAPEX)', CBS: 'งบโครงการ (CBS)' };
  const STATUS_LABEL = {
    pending: 'รอการเงินตรวจสอบ',
    approved: 'ออกเอกสารแล้ว',
    rejected: 'ไม่อนุมัติ — รอแก้ไข',
    cancelled: 'ยกเลิก'
  };
  const CBS_STATUS = ['Plan', 'On Progress', 'แล้วเสร็จ'];
  const ASSET_TYPES = ['เครื่องจักร', 'เครื่องมือและอุปกรณ์', 'อาคารและสิ่งปลูกสร้าง', 'ยานพาหนะ', 'อุปกรณ์สำนักงาน', 'ซอฟต์แวร์', 'อื่นๆ'];

  /** ตารางอำนาจอนุมัติ (DOA) ตามแบบฟอร์มใบเบิกงบประมาณเดิม — m = จำนวนเงิน (ล้านบาท) */
  const DOA = {
    '2.4': {
      title: '2.4 การทำรายการได้มา/จำหน่ายไปซึ่งสินทรัพย์ (เช่น ที่ดิน, อาคาร, เครื่องจักร, เงินลงทุน เป็นต้น)',
      short: '2.4 สินทรัพย์ลงทุน (ที่ดิน อาคาร เครื่องจักร)',
      rows: [
        { code: '2.4.4.2.2 (1)', label: 'มากกว่า 30 ลบ. แต่ไม่ถึง 50 ลบ.', approver: 'BOD', match: (m) => m > 30 && m < 50 },
        { code: '2.4.4.2.2 (2)', label: 'มากกว่า 1 ลบ. แต่ไม่ถึง 30 ลบ.', approver: 'CEO', match: (m) => m > 1 && m <= 30 },
        { code: '2.4.4.2.2 (3)', label: 'น้อยกว่า 1 ลบ.', approver: 'COO/MD', match: (m) => m <= 1 }
      ]
    },
    '2.5': {
      title: '2.5 การทำรายการได้มา/จำหน่ายไปซึ่งสินทรัพย์ที่ใช้ในการดำเนินงานทั่วไป ที่เป็นไปตามงบประมาณที่ได้รับอนุมัติแล้ว (อุปกรณ์เครื่องใช้สำนักงาน, งานปรับปรุงซ่อมบำรุงพื้นที่ อาคาร ยานพาหนะ เป็นต้น)',
      short: '2.5 สินทรัพย์ดำเนินงานทั่วไป (อุปกรณ์สำนักงาน ซ่อมบำรุง ยานพาหนะ)',
      rows: [
        { code: '2.5(1)', label: 'มากกว่าหรือเท่ากับ 0.5 ลบ.', approver: 'BOD', match: (m) => m >= 0.5 },
        { code: '2.5(2)', label: 'มากกว่า 0.1 ลบ. แต่น้อยกว่า 0.5 ลบ.', approver: 'CEO', match: (m) => m > 0.1 && m < 0.5 },
        { code: '2.5(3)', label: 'มากกว่า 0.05 ลบ. แต่น้อยกว่าหรือเท่ากับ 0.1 ลบ.', approver: 'COO/MD/CTO/CFO (ตามสายบังคับบัญชา)', match: (m) => m > 0.05 && m <= 0.1 },
        { code: '2.5(4)', label: 'มากกว่า 0.01 ลบ. แต่น้อยกว่าหรือเท่ากับ 0.05 ลบ.', approver: 'SDM/DM', match: (m) => m > 0.01 && m <= 0.05 },
        { code: '2.5(5)', label: 'น้อยกว่าหรือเท่ากับ 0.01 ลบ.', approver: 'SSM/SM', match: (m) => m <= 0.01 }
      ]
    }
  };

  // ---------------------------------------------------------------- storage

  function seed() {
    const now = new Date().toISOString();
    const year = new Date().getFullYear();
    const prev = year - 1;
    const item = (id, code, name, assetType, doa, amount) => ({ id, code, name, assetType, doa, amount });
    const cbs = (id, code, name, extra) => Object.assign({ id, code, name, qty: '', unit: '', amount: 0, vat: 0, glCode: '', glName: '' }, extra || {});
    const budgets = [
      {
        id: 'b1', type: 'CAPEX', company: 'PSL', fiscalYear: year, group: '01', code: 'EN0001',
        name: 'ปรับปรุงสายการผลิต Phase 1', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: 'งบตัวอย่าง',
        items: [
          item('c1', year + '-01-EN001', 'เครื่องตัดชิ้นงาน', 'เครื่องจักร', '2.4', 500000),
          item('c2', year + '-01-EN002', 'เครื่องมือและอุปกรณ์ห้องปฏิบัติการ', 'เครื่องมือและอุปกรณ์', '2.5', 610000),
          item('c3', year + '-01-EN003', 'ระบบลำเลียงวัตถุดิบ (Conveyor)', 'เครื่องจักร', '2.4', 1500000)
        ]
      },
      {
        id: 'b2', type: 'CAPEX', company: 'PSL', fiscalYear: year, group: '01', code: 'IT0001',
        name: 'อุปกรณ์ IT สำนักงาน', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: '',
        items: [item('c4', year + '-01-IT001', 'คอมพิวเตอร์และอุปกรณ์ต่อพ่วง', 'อุปกรณ์สำนักงาน', '2.5', 450000)]
      },
      {
        id: 'b3', type: 'CBS', company: 'PSL', fiscalYear: year, code: 'PJ0001-1', parentCode: 'PJ0001',
        name: 'ผลิตกล้าไม้ 10,000 กล้า', department: 'ฝ่ายโครงการ', ownerId: 'req2', note: '',
        status: 'On Progress', startDate: year + '-01-05', endDate: year + '-03-31',
        production: { site: 'โรงเรือน 1', product: 'กล้าไม้', qty: 10000, unit: 'กล้า' },
        items: [
          cbs('i1', '1', 'ต้นทุนวัตถุดิบ'),
          cbs('i2', '1.1', 'กล้าพันธุ์ (รวมค่าขนส่ง)', { qty: 10000, unit: 'ต้น', amount: 230000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i3', '1.2', 'วัสดุปลูก'),
          cbs('i4', '1.2.1', 'ดินผสม', { amount: 20000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i5', '1.2.2', 'ถุงเพาะ ขนาด 6x12 นิ้ว', { amount: 15000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i6', '1.3', 'วัสดุสิ้นเปลืองอื่น ๆ', { amount: 4500, vat: 315, glCode: '510102', glName: 'วัสดุสิ้นเปลือง' }),
          cbs('i7', '2', 'ต้นทุนค่าแรง'),
          cbs('i8', '2.1', 'คนงานประจำ', { qty: 2, unit: 'คน', amount: 20000, glCode: '520101', glName: 'ค่าแรงงาน' }),
          cbs('i9', '2.2', 'คนงานรายวัน', { unit: 'คน', amount: 45000, glCode: '520101', glName: 'ค่าแรงงาน' }),
          cbs('i10', '3', 'ต้นทุนค่าเช่า'),
          cbs('i11', '3.1', 'ค่าระบบน้ำ', { amount: 3000, glCode: '530101', glName: 'ค่าเช่าและสาธารณูปโภค' }),
          cbs('i12', '4', 'รายการส่วนเพิ่มอื่นๆ'),
          cbs('i13', '4.1', 'ค่าขนส่ง', { amount: 5000, glCode: '540101', glName: 'ค่าขนส่ง' })
        ]
      },
      {
        id: 'b4', type: 'CAPEX', company: 'PSL', fiscalYear: prev, group: '02', code: 'EN0002',
        name: 'ระบบไอน้ำ (ยกมาจากปีก่อน)', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: 'งบปีก่อน ยกมาใช้ต่อ',
        items: [item('c5', prev + '-02-EN001', 'ชุดหม้อไอน้ำและท่อ', 'เครื่องจักร', '2.4', 800000)]
      },
      {
        id: 'b5', type: 'CAPEX', company: 'PCC', fiscalYear: year, group: '04', code: 'PD0001',
        name: 'อุปกรณ์คลังสินค้า', department: 'ฝ่ายผลิต', ownerId: 'req2', note: '',
        items: [
          item('c6', year + '-04-PD001', 'รถยกไฟฟ้า', 'ยานพาหนะ', '2.5', 1200000),
          item('c7', year + '-04-PD002', 'ชั้นวางสินค้า', 'อื่นๆ', '2.5', 300000)
        ]
      }
    ];
    budgets.forEach((b) => {
      b.createdAt = now;
      b.revisions = [{ no: 0, at: now, by: 'fin1', note: 'บันทึกงบที่ได้รับอนุมัติ', total: budgetTotal(b), items: snapshotItems(b) }];
    });
    // ตัวอย่างการปรับงบ: เครื่องตัดชิ้นงาน 400,000 → 500,000
    budgets[0].revisions[0].items[0].total = 400000;
    budgets[0].revisions[0].total -= 100000;
    budgets[0].revisions.push({ no: 1, at: now, by: 'fin1', note: 'ปรับเพิ่มงบเครื่องตัดชิ้นงานตามใบเสนอราคาจริง', total: budgetTotal(budgets[0]), items: snapshotItems(budgets[0]) });
    return { seq: { req: 0, id: 100, doc: {} }, budgets, requests: [] };
  }

  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ใช้ข้อมูลตัวอย่างแทน */ }
    return seed();
  }

  let db;
  let currentUserId = 'fin1';
  try { currentUserId = localStorage.getItem(DB_KEY + '.user') || currentUserId; } catch (e) { /* ignore */ }

  function save() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }

  function nextId(prefix) {
    db.seq.id += 1;
    return prefix + db.seq.id;
  }

  function nextReqNo() {
    db.seq.req += 1;
    return 'REQ-' + new Date().getFullYear() + '-' + String(db.seq.req).padStart(4, '0');
  }

  /** เลขที่เอกสาร: CAPEX ใช้รูปแบบใบเบิกเดิม <บริษัท><ปี 2 หลัก>-<ลำดับ> เช่น PSL26-001, CBS เป็น CBS26-0001 */
  function nextDocNo(r, b, at) {
    const yy = String(new Date(at).getFullYear()).slice(-2);
    const key = (r.type === 'CAPEX' ? b.company : 'CBS') + yy;
    db.seq.doc[key] = (db.seq.doc[key] || 0) + 1;
    return key + '-' + String(db.seq.doc[key]).padStart(r.type === 'CAPEX' ? 3 : 4, '0');
  }

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** ยอดเงิน ถ้าติดลบแสดงเป็นสีแดง */
  function moneyCell(n) {
    return Number(n) < 0 ? '<span class="neg">' + money(n) + '</span>' : money(n);
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtDay(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('th-TH', { dateStyle: 'medium' });
  }

  const today = () => new Date().toISOString().slice(0, 10);
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

  const user = (id) => USERS.find((u) => u.id === id);
  const userName = (id) => (user(id) ? user(id).name : '-');
  const me = () => user(currentUserId) || USERS[0];
  const budgetById = (id) => db.budgets.find((b) => b.id === id);
  const requestById = (id) => db.requests.find((r) => r.id === id);
  const itemById = (b, id) => (b ? b.items.find((i) => i.id === id) : null);
  const uniq = (arr) => Array.from(new Set(arr));

  /** เรียงรหัสแบบ 1, 1.2, 1.10 */
  function compareCode(a, b) {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      const na = Number(pa[i]);
      const nb = Number(pb[i]);
      const c = !isNaN(na) && !isNaN(nb) ? na - nb : pa[i].localeCompare(pb[i]);
      if (c) return c;
    }
    return 0;
  }

  const itemTotal = (it) => round2(Number(it.amount || 0) + Number(it.vat || 0));
  const isLeaf = (b, it) => !b.items.some((x) => x !== it && x.code.startsWith(it.code + '.'));
  const leaves = (b) => b.items.filter((it) => isLeaf(b, it));
  const sortedItems = (b) => (b.type === 'CBS' ? b.items.slice().sort((x, y) => compareCode(x.code, y.code)) : b.items);
  const depth = (it) => String(it.code).split('.').length - 1;

  function leafIdsUnder(b, it) {
    return b.items.filter((x) => (x === it || x.code.startsWith(it.code + '.')) && isLeaf(b, x)).map((x) => x.id);
  }

  function budgetTotal(b) {
    return round2(leaves(b).reduce((s, i) => s + itemTotal(i), 0));
  }

  function snapshotItems(b) {
    return leaves(b).map((i) => ({ code: i.code, name: i.name, total: itemTotal(i) }));
  }

  /**
   * ยอดงบของทั้งงบ หรือของรายการ (รวมรายการลูก)
   * approved = งบที่ได้รับ, used = ออกเอกสารแล้ว, reserved = รอการเงินตรวจสอบ
   */
  function usage(b, itemId) {
    let ids = null;
    let approved;
    if (itemId) {
      const it = itemById(b, itemId);
      if (!it) return { approved: 0, used: 0, reserved: 0, remaining: 0 };
      ids = leafIdsUnder(b, it);
      approved = round2(b.items.filter((x) => ids.includes(x.id)).reduce((s, x) => s + itemTotal(x), 0));
    } else {
      approved = budgetTotal(b);
    }
    let used = 0;
    let reserved = 0;
    db.requests.forEach((r) => {
      if (r.budgetId !== b.id || (ids && !ids.includes(r.itemId))) return;
      if (r.status === 'approved') used += r.amount;
      if (r.status === 'pending') reserved += r.amount;
    });
    used = round2(used);
    reserved = round2(reserved);
    return { approved, used, reserved, remaining: round2(approved - used - reserved) };
  }

  /** CAPEX ต้องผ่านฝ่ายการเงินตรวจสอบ ส่วน CBS ไม่มีขั้นตรวจสอบ (ออกเอกสารทันที) */
  function stepsFor(budget) {
    if (budget.type === 'CBS') return [];
    return [{ key: 'fin', label: 'ฝ่ายการเงินรับเอกสารและตรวจสอบ', role: 'finance', status: 'waiting' }];
  }

  const currentStep = (r) => (r.status === 'pending' ? r.steps.find((s) => s.status === 'waiting') : null);
  const canAct = (u, step) => !!step && (step.assignee === u.id || (step.role && step.role === u.role));
  const stepAssigneeText = (step) => (step.assignee ? userName(step.assignee) : ROLE_LABEL[step.role]);
  const inbox = (u) => db.requests.filter((r) => canAct(u, currentStep(r)));
  const needsAccounting = (r) => r.status === 'approved' && !(r.accounting && r.accounting.updatedAt);

  function badge(cls, text) {
    return '<span class="badge ' + esc(cls) + '">' + esc(text) + '</span>';
  }

  function usageBar(u) {
    const pct = (v) => (u.approved > 0 ? Math.min(100, (v / u.approved) * 100) : 0);
    return '<div class="bar" role="img" aria-label="ใช้แล้ว ' + money(u.used) + ' รอตรวจสอบ ' + money(u.reserved) + '">' +
      '<div class="used" style="width:' + pct(u.used) + '%"></div>' +
      '<div class="reserved" style="width:' + pct(u.reserved) + '%"></div></div>' +
      '<div class="legend"><span><i class="l-used"></i>ใช้แล้ว</span>' +
      '<span><i class="l-reserved"></i>รอตรวจสอบ</span>' +
      '<span><i class="l-left"></i>คงเหลือ</span></div>';
  }

  function usageKv(u) {
    return '<dl class="kv">' +
      '<dt>งบที่ได้รับอนุมัติ</dt><dd>' + money(u.approved) + '</dd>' +
      '<dt>ใช้แล้ว (ออกเอกสาร)</dt><dd>' + money(u.used) + '</dd>' +
      '<dt>รอตรวจสอบ (จองไว้)</dt><dd>' + money(u.reserved) + '</dd>' +
      '<dt>คงเหลือ</dt><dd class="big">' + moneyCell(u.remaining) + '</dd></dl>';
  }

  let flash = null;
  function setFlash(type, text) { flash = { type, text }; }
  function takeFlash() {
    if (!flash) return '';
    const html = '<div class="alert ' + flash.type + '">' + esc(flash.text) + '</div>';
    flash = null;
    return html;
  }

  function showErrors(errors) {
    document.getElementById('formError').innerHTML = '<div class="alert error">' + errors.map(esc).join('<br>') + '</div>';
    window.scrollTo(0, 0);
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  const opt = (v, label, sel) => '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(label) + '</option>';

  // ---------------------------------------------------------------- navigation

  function homeFor(u) {
    if (u.role === 'finance') return '#/budgets';
    if (u.role === 'accounting') return '#/accounting';
    return '#/my-budgets';
  }

  const NAV_ICON = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">' +
    [4, 10, 16].map((y) => [4, 10, 16].map((x) =>
      '<circle cx="' + x + '" cy="' + y + '" r="1.7" fill="currentColor"/>').join('')).join('') + '</svg>';

  function renderNav(route) {
    const u = me();
    const count = (n) => (n ? '<span class="count">' + n + '</span>' : '');
    const links = [];
    // [href, ข้อความ, เส้นทางที่ให้ไฮไลต์เมนูนี้]
    if (u.role === 'finance') links.push(['#/budgets', 'จัดการงบประมาณ', ['#/budgets', '#/budget/']]);
    if (u.role === 'accounting') links.push(['#/budgets', 'งบประมาณ', ['#/budgets', '#/budget/']]);
    if (u.role === 'requester') links.push(['#/my-budgets', 'งบของฉัน', ['#/my-budgets', '#/budget/', '#/request/new']]);
    if (u.role === 'finance') links.push(['#/approvals', 'รอตรวจสอบ' + count(inbox(u).length), ['#/approvals']]);
    if (u.role === 'accounting') {
      links.push(['#/accounting', 'รอบันทึกบัญชี' + count(db.requests.filter(needsAccounting).length), ['#/accounting']]);
    }
    links.push(['#/requests', u.role === 'requester' ? 'คำขอของฉัน' : 'คำขอใช้งบทั้งหมด', ['#/requests', '#/request/', '#/doc/']]);
    let activeDone = false;
    document.getElementById('nav').innerHTML = links.map(([href, text, prefixes]) => {
      const active = !activeDone && prefixes.some((p) => route.startsWith(p));
      if (active) activeDone = true;
      return '<a href="' + href + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + NAV_ICON + '<span>' + text + '</span></a>';
    }).join('');
  }

  // ---------------------------------------------------------------- budget list

  // ตัวกรองหน้ารายการงบ จำค่าไว้ตอนสลับแท็บ
  const budgetFilter = { q: '', dept: '', year: '' };

  const ICON_SEARCH = '<svg class="lead" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_CAL = '<svg class="trail" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function budgetSubline(b, mine) {
    const parts = [b.company, b.department, 'ปีงบ ' + b.fiscalYear];
    if (b.type === 'CBS') parts.push(b.status);
    if (!mine) parts.push(userName(b.ownerId));
    return parts.filter(Boolean).map(esc).join(' · ');
  }

  function viewBudgets(params) {
    const u = me();
    const mine = u.role === 'requester';
    const all = db.budgets.filter((b) => !mine || b.ownerId === u.id);
    const count = (t) => (t === 'ALL' ? all.length : all.filter((b) => b.type === t).length);
    const type = TYPE_LABEL[params.get('type')] ? params.get('type') : 'ALL';
    const list = type === 'ALL' ? all : all.filter((b) => b.type === type);
    const base = mine ? '#/my-budgets' : '#/budgets';
    const tab = (t, label) => '<a href="' + base + (t === 'ALL' ? '' : '?type=' + t) + '"' + (type === t ? ' class="active" aria-current="page"' : '') + '>' +
      label + '<span class="tab-count">(' + count(t) + ')</span></a>';
    const depts = uniq(all.map((b) => b.department)).sort();
    const years = uniq(all.map((b) => String(b.fiscalYear))).sort().reverse();
    const title = mine ? 'งบของฉัน' : u.role === 'finance' ? 'จัดการงบประมาณ' : 'งบประมาณ';

    let html = '<div class="page-head"><h1>' + title + '</h1>' +
      '<span class="pill">' + esc(u.title) + '</span></div>' + takeFlash() +
      '<nav class="tabs" aria-label="ประเภทงบ">' + tab('ALL', 'ทั้งหมด') + tab('CAPEX', 'งบลงทุน (CAPEX)') + tab('CBS', 'งบโครงการ (CBS)') + '</nav>' +
      '<div class="filters">' +
      '<label class="input-wrap search">' + ICON_SEARCH +
      '<input id="fSearch" type="search" placeholder="ค้นหาชื่องบ รหัส หรือหน่วยงาน" aria-label="ค้นหา" value="' + esc(budgetFilter.q) + '"></label>' +
      '<label class="input-wrap select-wrap"><select id="fDept" aria-label="หน่วยงาน">' + opt('', 'หน่วยงาน: ทั้งหมด', budgetFilter.dept) +
      depts.map((d) => opt(d, 'หน่วยงาน: ' + d, budgetFilter.dept)).join('') + '</select></label>' +
      '<label class="input-wrap"><select id="fYear" aria-label="ปีงบประมาณ">' + opt('', 'ปี: ทั้งหมด', budgetFilter.year) +
      years.map((y) => opt(y, 'ปี: ' + y, budgetFilter.year)).join('') + '</select>' + ICON_CAL + '</label>' +
      (u.role === 'finance'
        ? '<a class="btn primary tall" href="#/budget/new"><span aria-hidden="true">+</span> เพิ่มงบที่อนุมัติ</a>'
        : '<span></span>') +
      '</div>';

    if (!list.length) {
      return html + '<div class="card empty">' +
        (mine ? 'ยังไม่มี' + (TYPE_LABEL[type] || 'งบ') + 'ที่การเงินบันทึกไว้ให้คุณ' : 'ยังไม่มี' + (TYPE_LABEL[type] || 'งบประมาณ')) + '</div>';
    }

    html += '<div class="grid" id="budgetGrid">' + list.map((b) => {
      const us = usage(b);
      const search = [b.name, b.code, b.parentCode, b.department, b.company, userName(b.ownerId)]
        .concat(b.items.map((i) => i.code + ' ' + i.name)).join(' ').toLowerCase();
      const sub = b.type === 'CAPEX' ? b.items.length + ' รายการย่อย' : leaves(b).length + ' รายการต้นทุน';
      return '<article class="card budget-card" data-search="' + esc(search) + '" data-dept="' + esc(b.department) +
        '" data-year="' + esc(b.fiscalYear) + '">' +
        '<div class="card-head"><div><h3>' + esc(b.name) + '</h3><div class="code">' + esc(b.code) + ' · ' + sub + '</div></div>' +
        badge(b.type + ' lg', b.type) + '</div>' +
        '<div class="card-body"><p class="card-sub">' + budgetSubline(b, mine) + '</p>' + usageKv(us) + '</div>' +
        '<div class="usage-strip">' + usageBar(us) + '</div>' +
        '<div class="card-foot">' +
        '<a class="btn" href="#/budget/' + b.id + '">รายละเอียด</a>' +
        (u.role === 'finance' ? '<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไข</a>' : '') +
        (mine && b.ownerId === u.id ? '<a class="btn primary" href="#/request/new/' + b.id + '">ขอเบิกใช้งบ</a>' : '') +
        '</div></article>';
    }).join('') + '</div>' +
      '<div class="card empty" id="noMatch" hidden>ไม่พบงบที่ตรงกับเงื่อนไขที่เลือก</div>';
    return html;
  }

  function bindBudgetFilters() {
    const grid = document.getElementById('budgetGrid');
    const q = document.getElementById('fSearch');
    if (!q) return;
    const dept = document.getElementById('fDept');
    const year = document.getElementById('fYear');
    const apply = () => {
      budgetFilter.q = q.value;
      budgetFilter.dept = dept.value;
      budgetFilter.year = year.value;
      if (!grid) return;
      const term = q.value.trim().toLowerCase();
      let shown = 0;
      grid.querySelectorAll('.budget-card').forEach((card) => {
        const ok = (!term || card.dataset.search.includes(term)) &&
          (!dept.value || card.dataset.dept === dept.value) &&
          (!year.value || card.dataset.year === year.value);
        card.hidden = !ok;
        if (ok) shown += 1;
      });
      document.getElementById('noMatch').hidden = shown > 0;
    };
    q.addEventListener('input', apply);
    dept.addEventListener('change', apply);
    year.addEventListener('change', apply);
    apply();
  }

  // ---------------------------------------------------------------- budget form (finance)

  const usedItemIds = () => new Set(db.requests.map((r) => r.itemId));

  function capexRow(it, locked) {
    return '<tr data-item-id="' + esc(it.id || '') + '">' +
      '<td><input name="itCode" value="' + esc(it.code) + '" placeholder="2026-01-XX001" aria-label="รหัสรายการย่อย"></td>' +
      '<td><input name="itName" value="' + esc(it.name) + '" aria-label="ชื่อรายการ"></td>' +
      '<td><div class="select-wrap"><select name="itAsset" aria-label="ประเภทสินทรัพย์">' +
      ASSET_TYPES.map((t) => opt(t, t, it.assetType || ASSET_TYPES[0])).join('') + '</select></div></td>' +
      '<td><div class="select-wrap"><select name="itDoa" aria-label="หมวด DOA">' + opt('2.4', '2.4 สินทรัพย์ลงทุน', it.doa) +
      opt('2.5', '2.5 ดำเนินงานทั่วไป', it.doa || '2.5') + '</select></div></td>' +
      '<td><input name="itAmount" type="number" min="0" step="0.01" class="right" value="' + esc(it.amount) + '" aria-label="วงเงิน"></td>' +
      '<td>' + (locked ? '<span class="muted" title="มีการเบิกใช้แล้ว ลบไม่ได้">🔒</span>' : '<button type="button" class="btn small bad" data-remove-item title="ลบ">×</button>') + '</td></tr>';
  }

  function cbsRow(it, locked) {
    return '<tr data-item-id="' + esc(it.id || '') + '">' +
      '<td><input name="itCode" value="' + esc(it.code) + '" placeholder="1.1" aria-label="รหัส"></td>' +
      '<td><input name="itName" value="' + esc(it.name) + '" aria-label="รายการ"></td>' +
      '<td><input name="itQty" type="number" min="0" step="any" value="' + esc(it.qty) + '" aria-label="จำนวน"></td>' +
      '<td><input name="itUnit" value="' + esc(it.unit) + '" aria-label="หน่วย"></td>' +
      '<td><input name="itAmount" type="number" min="0" step="0.01" class="right" value="' + esc(it.amount || '') + '" aria-label="ก่อน VAT"></td>' +
      '<td class="center"><input name="itVat" type="checkbox"' + (Number(it.vat) > 0 ? ' checked' : '') + ' aria-label="VAT 7%"></td>' +
      '<td><input name="itGl" value="' + esc(it.glCode) + '" aria-label="GL Code"></td>' +
      '<td><input name="itGlName" value="' + esc(it.glName) + '" aria-label="GL Name"></td>' +
      '<td>' + (locked ? '<span class="muted" title="มีการเบิกใช้แล้ว ลบไม่ได้">🔒</span>' : '<button type="button" class="btn small bad" data-remove-item title="ลบ">×</button>') + '</td></tr>';
  }

  const CBS_TEMPLATE = [
    { code: '1', name: 'ต้นทุนวัตถุดิบ' }, { code: '1.1', name: '' },
    { code: '2', name: 'ต้นทุนค่าแรง' }, { code: '2.1', name: '' },
    { code: '3', name: 'ต้นทุนค่าเช่า' }, { code: '3.1', name: '' },
    { code: '4', name: 'รายการส่วนเพิ่มอื่นๆ' }, { code: '4.1', name: '' }
  ];

  function viewBudgetForm(id) {
    const u = me();
    if (u.role !== 'finance') return '<div class="alert error">เฉพาะการเงินเท่านั้นที่บันทึก/แก้ไขงบได้</div>';
    const b = id ? budgetById(id) : null;
    if (id && !b) return notFound();
    const hasRequests = b && db.requests.some((r) => r.budgetId === b.id);
    const year = new Date().getFullYear();
    const v = b || {
      type: 'CAPEX', company: 'PSL', fiscalYear: year, group: '01', code: '', parentCode: '', name: '', department: '',
      ownerId: 'req1', note: '', status: 'Plan', startDate: '', endDate: '', production: {}, items: []
    };
    const prod = v.production || {};
    const used = usedItemIds();
    const requesters = USERS.filter((x) => x.role === 'requester');
    const capexItems = v.type === 'CAPEX' && v.items.length ? v.items : [{ code: '', name: '', amount: '' }];
    const cbsItems = v.type === 'CBS' && v.items.length ? sortedItems(v) : CBS_TEMPLATE;
    const field = (label, inner, extra) => '<label class="field"' + (extra || '') + '><span>' + label + '</span>' + inner + '</label>';
    const select = (name, inner, attrs) => '<div class="select-wrap"><select name="' + name + '"' + (attrs || '') + '>' + inner + '</select></div>';

    return '<div class="page-head"><h1>' + (b ? 'แก้ไขงบ ' + esc(b.code) : 'บันทึกงบที่ได้รับอนุมัติ') + '</h1></div>' +
      '<div id="formError"></div>' +
      '<form id="budgetForm" class="card" data-id="' + esc(id || '') + '">' +
      '<div class="row">' +
      field('ประเภทงบ', select('type', ['CAPEX', 'CBS'].map((t) => opt(t, TYPE_LABEL[t], v.type)).join(''), hasRequests ? ' disabled' : '')) +
      field('บริษัท', select('company', Object.keys(COMPANIES).map((c) => opt(c, c + ' — ' + COMPANIES[c], v.company)).join(''))) +
      field('ปีงบประมาณ', '<input name="fiscalYear" type="number" required value="' + esc(v.fiscalYear) + '">') +
      field('กลุ่มงบประมาณ', '<input name="group" value="' + esc(v.group || '') + '" placeholder="เช่น 01">', ' data-for="CAPEX"') +
      '</div>' +
      '<div class="row">' +
      field('<span data-code-label>' + (v.type === 'CBS' ? 'Job No.' : 'รหัสโครงการ (Project No.)') + '</span>',
        '<input name="code" required value="' + esc(v.code) + '">') +
      field('รหัสโครงการหลัก (ถ้ามี)', '<input name="parentCode" value="' + esc(v.parentCode || '') + '" placeholder="เช่น PJ0001">', ' data-for="CBS"') +
      field('ชื่อโครงการ / ชื่องบ', '<input name="name" required value="' + esc(v.name) + '">') +
      '</div>' +
      '<div class="row">' +
      field('หน่วยงาน', '<input name="department" required value="' + esc(v.department) + '">') +
      field('ผู้ขอใช้งบ (เจ้าของงบ)', select('ownerId', requesters.map((x) => opt(x.id, x.name + ' — ' + x.title, v.ownerId)).join(''))) +
      field('สถานะโครงการ', select('status', CBS_STATUS.map((s) => opt(s, s, v.status)).join('')), ' data-for="CBS"') +
      '</div>' +
      '<div class="row" data-for="CBS">' +
      field('วันที่เริ่ม', '<input name="startDate" type="date" value="' + esc(v.startDate || '') + '">') +
      field('วันที่สิ้นสุด', '<input name="endDate" type="date" value="' + esc(v.endDate || '') + '">') +
      field('สถานที่ / แปลง', '<input name="site" value="' + esc(prod.site || '') + '">') +
      '</div>' +
      '<div class="row" data-for="CBS">' +
      field('ผลผลิต', '<input name="product" value="' + esc(prod.product || '') + '" placeholder="เช่น กล้าไม้">') +
      field('จำนวนผลผลิต', '<input name="prodQty" type="number" min="0" step="any" value="' + esc(prod.qty || '') + '">') +
      field('หน่วยผลผลิต', '<input name="prodUnit" value="' + esc(prod.unit || '') + '" placeholder="เช่น กล้า">') +
      '</div>' +

      '<fieldset data-for="CAPEX"><legend>รายการย่อย (Item No.)</legend>' +
      '<div class="table-wrap"><table class="edit-table"><thead><tr><th style="width:13rem">รหัสรายการย่อย</th><th>ชื่อรายการ</th>' +
      '<th style="width:11rem">ประเภทสินทรัพย์</th><th style="width:11rem">หมวด DOA</th><th class="num" style="width:10rem">วงเงิน (รวม VAT)</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="capexRows">' + capexItems.map((it) => capexRow(it, used.has(it.id))).join('') + '</tbody></table></div>' +
      '<div class="actions table-actions"><button type="button" class="btn small" data-add-row="capex">+ เพิ่มรายการย่อย</button>' +
      '<span class="muted">รวม <strong data-total="capex">0.00</strong> บาท</span></div></fieldset>' +

      '<fieldset data-for="CBS"><legend>Cost Breakdown Structure (CBS)</legend>' +
      '<p class="muted small-note">ใช้รหัสแบบ 1 → 1.1 → 1.1.1 รายการที่มีรายการลูกจะรวมยอดจากรายการลูกให้อัตโนมัติ และเบิกได้เฉพาะรายการล่างสุด</p>' +
      '<div class="table-wrap"><table class="edit-table"><thead><tr><th style="width:5.5rem">รหัส</th><th>รายการ</th><th style="width:6rem">จำนวน</th>' +
      '<th style="width:5.5rem">หน่วย</th><th class="num" style="width:9rem">ก่อน VAT</th><th style="width:4rem">VAT 7%</th>' +
      '<th style="width:7rem">GL Code</th><th style="width:10rem">GL Name</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="cbsRows">' + cbsItems.map((it) => cbsRow(it, used.has(it.id))).join('') + '</tbody></table></div>' +
      '<div class="actions table-actions"><button type="button" class="btn small" data-add-row="cbs">+ เพิ่มรายการ</button>' +
      '<span class="muted">รวม (รวม VAT) <strong data-total="cbs">0.00</strong> บาท</span></div></fieldset>' +

      field('หมายเหตุ / เลขที่เอกสารอนุมัติงบ', '<textarea name="note">' + esc(v.note) + '</textarea>') +
      (b ? field('เหตุผลการปรับงบ (จำเป็นเมื่อเปลี่ยนวงเงินหรือรายการ — จะบันทึกเป็นประวัติการปรับงบ)',
        '<textarea name="revisionNote" placeholder="เช่น ปรับเพิ่มตามใบเสนอราคาจริง / Revise CBS ครั้งที่ ' + ((b.revisions || []).length) + '"></textarea>') : '') +
      '<div class="actions"><button class="btn primary" type="submit">บันทึก</button>' +
      '<a class="btn" href="' + (b ? '#/budget/' + b.id : '#/budgets') + '">ยกเลิก</a>' +
      (b && !hasRequests ? '<button type="button" class="btn bad" id="deleteBudget">ลบงบนี้</button>' : '') +
      '</div></form>';
  }

  function bindBudgetForm() {
    const form = document.getElementById('budgetForm');
    if (!form) return;
    const typeSel = form.elements.type;
    const curType = () => typeSel.value;

    const recalc = () => {
      // CAPEX
      let capex = 0;
      form.querySelectorAll('#capexRows input[name="itAmount"]').forEach((el) => { capex += Number(el.value || 0); });
      form.querySelector('[data-total="capex"]').textContent = money(capex);
      // CBS: รายการที่มีรายการลูก = รายการแม่ (ปิดช่องเงิน แสดงยอดรวมของลูก)
      const rows = Array.from(form.querySelectorAll('#cbsRows tr'));
      const codes = rows.map((tr) => tr.querySelector('[name="itCode"]').value.trim());
      const totals = rows.map((tr) => {
        const amt = Number(tr.querySelector('[name="itAmount"]').value || 0);
        return amt + (tr.querySelector('[name="itVat"]').checked ? round2(amt * VAT_RATE) : 0);
      });
      let cbs = 0;
      rows.forEach((tr, i) => {
        const code = codes[i];
        const isParent = !!code && codes.some((c, j) => j !== i && c.startsWith(code + '.'));
        tr.classList.toggle('parent-row', isParent);
        ['itAmount', 'itVat', 'itQty'].forEach((n) => { tr.querySelector('[name="' + n + '"]').disabled = isParent; });
        const amountEl = tr.querySelector('[name="itAmount"]');
        if (isParent) {
          const sum = rows.reduce((s, _x, j) => {
            const leaf = !codes.some((c, k) => k !== j && c.startsWith(codes[j] + '.'));
            return s + (codes[j].startsWith(code + '.') && leaf ? totals[j] : 0);
          }, 0);
          amountEl.placeholder = money(sum);
        } else {
          amountEl.placeholder = '';
          cbs += totals[i];
        }
      });
      form.querySelector('[data-total="cbs"]').textContent = money(cbs);
    };
    const sync = () => {
      const t = curType();
      form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== t; });
      form.querySelector('[data-code-label]').textContent = t === 'CBS' ? 'Job No.' : 'รหัสโครงการ (Project No.)';
      recalc();
    };
    typeSel.addEventListener('change', sync);
    form.addEventListener('input', recalc);
    form.addEventListener('change', recalc);
    form.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-item]')) {
        const tbody = e.target.closest('tbody');
        if (tbody.rows.length > 1) e.target.closest('tr').remove();
        recalc();
      }
      const add = e.target.closest('[data-add-row]');
      if (add) {
        const kind = add.dataset.addRow;
        const tbody = document.getElementById(kind + 'Rows');
        let code = '';
        if (kind === 'cbs' && tbody.rows.length) {
          // เสนอรหัสถัดไปจากแถวสุดท้าย เช่น 4.1 → 4.2
          const last = tbody.rows[tbody.rows.length - 1].querySelector('[name="itCode"]').value.trim().split('.');
          const n = Number(last[last.length - 1]);
          if (!isNaN(n)) { last[last.length - 1] = String(n + 1); code = last.join('.'); }
        }
        tbody.insertAdjacentHTML('beforeend', kind === 'cbs'
          ? cbsRow({ code, name: '', amount: '' }, false)
          : capexRow({ code: '', name: '', amount: '' }, false));
        recalc();
      }
    });
    sync();

    const del = document.getElementById('deleteBudget');
    if (del) {
      del.addEventListener('click', () => {
        if (!confirm('ยืนยันการลบงบนี้?')) return;
        db.budgets = db.budgets.filter((b) => b.id !== form.dataset.id);
        save();
        setFlash('success', 'ลบงบเรียบร้อยแล้ว');
        go('#/budgets');
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      const id = form.dataset.id;
      const existing = id ? budgetById(id) : null;
      const type = existing && f.type.disabled ? existing.type : curType();
      const errors = [];
      const code = f.code.value.trim();
      if (db.budgets.some((b) => b.code === code && b.id !== id)) errors.push('รหัส "' + code + '" มีอยู่แล้ว');

      const rows = Array.from(form.querySelectorAll('#' + (type === 'CBS' ? 'cbs' : 'capex') + 'Rows tr'));
      const val = (tr, n) => tr.querySelector('[name="' + n + '"]');
      const items = rows.map((tr) => {
        const it = {
          id: tr.dataset.itemId || '',
          code: val(tr, 'itCode').value.trim(),
          name: val(tr, 'itName').value.trim(),
          amount: round2(val(tr, 'itAmount').value)
        };
        if (type === 'CAPEX') {
          it.assetType = val(tr, 'itAsset').value;
          it.doa = val(tr, 'itDoa').value;
        } else {
          it.qty = val(tr, 'itQty').value === '' ? '' : Number(val(tr, 'itQty').value);
          it.unit = val(tr, 'itUnit').value.trim();
          it.vat = val(tr, 'itVat').checked ? round2(it.amount * VAT_RATE) : 0;
          it.glCode = val(tr, 'itGl').value.trim();
          it.glName = val(tr, 'itGlName').value.trim();
        }
        return it;
      }).filter((it) => it.code || it.name || it.amount);

      if (!items.length) errors.push('ต้องมีรายการอย่างน้อย 1 รายการ');
      if (items.some((it) => !it.code || !it.name)) errors.push('กรุณากรอกรหัสและชื่อรายการให้ครบทุกแถว');
      const dup = items.map((it) => it.code).filter((c, i, arr) => c && arr.indexOf(c) !== i);
      if (dup.length) errors.push('รหัสรายการซ้ำ: ' + uniq(dup).join(', '));
      const draft = { type, items };
      // รายการแม่ไม่มีวงเงินของตัวเอง
      items.forEach((it) => { if (!isLeaf(draft, it)) { it.amount = 0; it.vat = 0; it.qty = ''; } });
      if (type === 'CAPEX' && items.some((it) => !(it.amount > 0))) errors.push('วงเงินของแต่ละรายการย่อยต้องมากกว่า 0');
      if (!(budgetTotal(draft) > 0)) errors.push('วงเงินรวมต้องมากกว่า 0');

      if (existing) {
        const used = usedItemIds();
        existing.items.filter((it) => used.has(it.id)).forEach((old) => {
          const now = items.find((it) => it.id === old.id);
          if (!now) { errors.push('รายการ ' + old.code + ' มีการเบิกใช้แล้ว ลบไม่ได้'); return; }
          if (!isLeaf(draft, now)) errors.push('รายการ ' + now.code + ' มีการเบิกใช้แล้ว เพิ่มรายการลูกใต้รายการนี้ไม่ได้');
          if (type === 'CAPEX') {
            const us = usage(existing, old.id);
            if (itemTotal(now) < us.used + us.reserved) {
              errors.push('รายการ ' + now.code + ' ต้องมีวงเงินไม่น้อยกว่ายอดที่ใช้/จองแล้ว (' + money(us.used + us.reserved) + ' บาท)');
            }
          }
        });
      }

      items.forEach((it) => { if (!it.id) it.id = nextId('i'); });
      const snapshot = snapshotItems(draft);
      const revisionNote = f.revisionNote ? f.revisionNote.value.trim() : '';
      let changed = false;
      if (existing) {
        const last = existing.revisions[existing.revisions.length - 1];
        changed = JSON.stringify(last.items.map((x) => [x.code, x.total])) !== JSON.stringify(snapshot.map((x) => [x.code, x.total]));
        if (changed && !revisionNote) errors.push('มีการเปลี่ยนวงเงินหรือรายการ กรุณาระบุเหตุผลการปรับงบ');
      }

      if (errors.length) { showErrors(errors); return; }

      const data = {
        type, code, items,
        company: f.company.value,
        fiscalYear: Number(f.fiscalYear.value),
        name: f.name.value.trim(),
        department: f.department.value.trim(),
        ownerId: f.ownerId.value,
        note: f.note.value.trim()
      };
      if (type === 'CAPEX') {
        data.group = f.group.value.trim();
      } else {
        Object.assign(data, {
          parentCode: f.parentCode.value.trim(),
          status: f.status.value,
          startDate: f.startDate.value,
          endDate: f.endDate.value,
          production: { site: f.site.value.trim(), product: f.product.value.trim(), qty: f.prodQty.value === '' ? '' : Number(f.prodQty.value), unit: f.prodUnit.value.trim() }
        });
      }
      const at = new Date().toISOString();
      if (existing) {
        Object.assign(existing, data, { updatedAt: at, updatedBy: me().id });
        if (changed) {
          existing.revisions.push({ no: existing.revisions.length, at, by: me().id, note: revisionNote, total: budgetTotal(existing), items: snapshot });
        }
      } else {
        const b = Object.assign({ id: nextId('b'), createdAt: at, createdBy: me().id }, data);
        b.revisions = [{ no: 0, at, by: me().id, note: 'บันทึกงบที่ได้รับอนุมัติ', total: budgetTotal(b), items: snapshot }];
        db.budgets.push(b);
      }
      save();
      setFlash('success', 'บันทึกงบ ' + code + ' เรียบร้อยแล้ว' + (changed ? ' (บันทึกเป็นการปรับงบครั้งที่ ' + (existing.revisions.length - 1) + ')' : ''));
      go(existing ? '#/budget/' + existing.id : '#/budgets');
    });
  }

  // ---------------------------------------------------------------- budget detail

  function viewBudgetDetail(id) {
    const b = budgetById(id);
    if (!b) return notFound();
    const u = me();
    const us = usage(b);
    const reqs = db.requests.filter((r) => r.budgetId === b.id);
    const canRequest = u.role === 'requester' && b.ownerId === u.id;
    const prod = b.production || {};
    const kv = (k, v) => (v || v === 0 ? '<dt>' + k + '</dt><dd>' + v + '</dd>' : '');
    const first = (b.revisions && b.revisions[0]) ? b.revisions[0].items : [];

    let html = takeFlash() + '<div class="page-head"><h1>' + esc(b.name) + ' ' + badge(b.type + ' lg', b.type) + '</h1><div class="actions" style="margin:0">' +
      (canRequest ? '<a class="btn primary" href="#/request/new/' + b.id + '">ขอเบิกใช้งบ</a>' : '') +
      (u.role === 'finance' ? '<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไข / ปรับงบ</a>' : '') +
      '</div></div>' +
      '<div class="grid"><div class="card"><dl class="kv">' +
      kv('ประเภท', TYPE_LABEL[b.type]) +
      kv('บริษัท', esc(b.company + ' — ' + (COMPANIES[b.company] || ''))) +
      kv(b.type === 'CBS' ? 'Job No.' : 'รหัสโครงการ', esc(b.code)) +
      (b.type === 'CBS' ? kv('โครงการหลัก', esc(b.parentCode)) + kv('สถานะ', esc(b.status)) +
        kv('ระยะเวลา', b.startDate ? fmtDay(b.startDate) + ' – ' + fmtDay(b.endDate) : '') +
        kv('สถานที่ / แปลง', esc(prod.site)) +
        kv('ผลผลิต', prod.product ? esc(prod.product + ' ' + (prod.qty ? Number(prod.qty).toLocaleString('th-TH') + ' ' + (prod.unit || '') : '')) : '')
        : kv('กลุ่มงบประมาณ', esc(b.group))) +
      kv('ปีงบประมาณ', esc(b.fiscalYear)) +
      kv('หน่วยงาน', esc(b.department)) +
      kv('ผู้ขอใช้งบ', esc(userName(b.ownerId))) +
      kv(b.type === 'CBS' ? 'Revise CBS' : 'ปรับงบ', (b.revisions.length - 1) + ' ครั้ง') +
      kv('หมายเหตุ', esc(b.note)) +
      '</dl></div><div class="card">' + usageKv(us) + '<div style="margin-top:.9rem">' + usageBar(us) + '</div></div></div>';

    if (b.type === 'CAPEX') {
      html += '<h2>รายการย่อย (Item No.)</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>รหัสรายการย่อย</th><th>รายการ</th><th>ประเภทสินทรัพย์</th><th>DOA</th><th class="num">งบครั้งแรก</th><th class="num">งบปัจจุบัน</th>' +
        '<th class="num">ใช้แล้ว</th><th class="num">รอตรวจสอบ</th><th class="num">คงเหลือ</th>' + (canRequest ? '<th></th>' : '') + '</tr></thead><tbody>' +
        b.items.map((i) => {
          const iu = usage(b, i.id);
          const orig = first.find((x) => x.code === i.code);
          return '<tr><td class="nowrap">' + esc(i.code) + '</td><td>' + esc(i.name) + '</td><td>' + esc(i.assetType) + '</td><td>' + esc(i.doa) + '</td>' +
            '<td class="num">' + (orig ? money(orig.total) : '<span class="muted">เพิ่มภายหลัง</span>') + '</td>' +
            '<td class="num">' + money(iu.approved) + '</td><td class="num">' + money(iu.used) + '</td><td class="num">' + money(iu.reserved) +
            '</td><td class="num"><strong>' + moneyCell(iu.remaining) + '</strong></td>' +
            (canRequest ? '<td><a class="btn small" href="#/request/new/' + b.id + '?item=' + i.id + '">ขอเบิก</a></td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      html += '<h2>Cost Breakdown Structure</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>รหัส</th><th>รายการ</th><th>จำนวน</th><th>GL</th><th class="num">งบ (รวม VAT)</th><th class="num">ใช้ไปสะสม</th><th class="num">คงเหลือ</th>' +
        (canRequest ? '<th></th>' : '') + '</tr></thead><tbody>' +
        sortedItems(b).map((i) => {
          const iu = usage(b, i.id);
          const leaf = isLeaf(b, i);
          return '<tr class="' + (leaf ? '' : 'parent-row') + '"><td class="nowrap">' + esc(i.code) + '</td>' +
            '<td style="padding-left:' + (0.75 + depth(i) * 1.1) + 'rem">' + esc(i.name) + '</td>' +
            '<td class="nowrap">' + (leaf && (i.qty || i.unit) ? esc((i.qty ? Number(i.qty).toLocaleString('th-TH') : '') + ' ' + (i.unit || '')) : '') + '</td>' +
            '<td>' + (leaf && i.glCode ? esc(i.glCode) + '<div class="muted">' + esc(i.glName) + '</div>' : '') + '</td>' +
            '<td class="num">' + money(iu.approved) + '</td><td class="num">' + money(iu.used) + '</td>' +
            '<td class="num">' + moneyCell(iu.remaining) + (iu.remaining < 0 ? ' <span class="badge rejected">เกินงบ</span>' : '') + '</td>' +
            (canRequest ? '<td>' + (leaf ? '<a class="btn small" href="#/request/new/' + b.id + '?item=' + i.id + '">ขอเบิก</a>' : '') + '</td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }

    html += '<h2>ประวัติการปรับงบ' + (b.type === 'CBS' ? ' (Revise CBS)' : '') + '</h2><div class="table-wrap"><table><thead><tr>' +
      '<th>ครั้งที่</th><th>วันที่</th><th>โดย</th><th class="num">ยอดรวม</th><th>เหตุผล / หมายเหตุ</th></tr></thead><tbody>' +
      b.revisions.slice().reverse().map((rv, idx, arr) => {
        const prevRv = arr[idx + 1];
        const diff = prevRv ? rv.total - prevRv.total : 0;
        return '<tr><td>' + (rv.no === 0 ? 'อนุมัติครั้งแรก' : 'ครั้งที่ ' + rv.no) + '</td><td class="nowrap">' + fmtDate(rv.at) + '</td><td>' + esc(userName(rv.by)) + '</td>' +
          '<td class="num">' + money(rv.total) + (diff ? '<div class="muted">' + (diff > 0 ? '+' : '') + money(diff) + '</div>' : '') + '</td><td>' + esc(rv.note) + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<h2>ประวัติการขอเบิกใช้งบ</h2>' + requestTable(reqs, false);
    return html;
  }

  // ---------------------------------------------------------------- request form

  function viewRequestForm(budgetId, requestId, params) {
    const existing = requestId ? requestById(requestId) : null;
    if (requestId && !existing) return notFound();
    const b = budgetById(existing ? existing.budgetId : budgetId);
    if (!b) return notFound();
    const u = me();
    if (b.ownerId !== u.id) return '<div class="alert error">คุณไม่ใช่ผู้ขอใช้งบของงบนี้</div>';
    if (existing && existing.status !== 'rejected') return '<div class="alert error">แก้ไขได้เฉพาะคำขอที่ไม่ได้รับอนุมัติเท่านั้น</div>';
    const v = existing || {
      itemId: params.get('item') || '',
      expenseDate: today()
    };
    const val = (k) => ' value="' + esc(v[k] == null ? '' : v[k]) + '"';
    const noPo = existing ? existing.poNo === 'N/A' : true;
    const hasVat = existing ? Number(existing.vat) > 0 : b.type === 'CAPEX';
    const leafItems = sortedItems(b).filter((i) => isLeaf(b, i));
    const field = (label, inner, extra) => '<label class="field"' + (extra || '') + '><span>' + label + '</span>' + inner + '</label>';
    const lastReject = existing ? existing.steps.find((s) => s.status === 'rejected') : null;
    const isCapex = b.type === 'CAPEX';

    const itemSelect = '<div class="select-wrap"><select name="itemId" required>' +
      '<option value="">— เลือก' + (isCapex ? 'รายการย่อย' : 'รายการต้นทุน') + ' —</option>' +
      leafItems.map((i) => {
        const iu = usage(b, i.id);
        const remaining = iu.remaining + (existing && existing.itemId === i.id && existing.status === 'pending' ? existing.amount : 0);
        return '<option value="' + i.id + '" data-remaining="' + remaining + '"' + (i.id === v.itemId ? ' selected' : '') +
          (isCapex && remaining <= 0 ? ' disabled' : '') + '>' +
          esc(i.code + ' ' + i.name) + ' — คงเหลือ ' + money(remaining) + ' บาท</option>';
      }).join('') + '</select></div>';

    return '<div class="page-head"><h1>' + (existing ? 'แก้ไขคำขอ ' + esc(existing.no) : 'จัดทำเอกสารขอเบิกใช้งบ') + '</h1></div>' +
      (lastReject ? '<div class="alert error">เหตุผลที่ไม่อนุมัติ: ' + esc(lastReject.comment) + '</div>' : '') +
      '<div class="alert info">' + badge(b.type, b.type) + ' ' + esc(b.code + ' ' + b.name) +
      ' · งบคงเหลือทั้งโครงการ <strong>' + moneyCell(usage(b).remaining) + '</strong> บาท<br>' +
      (isCapex
        ? 'เอกสารจะถูกส่งให้ฝ่ายการเงินตรวจสอบ เมื่ออนุมัติแล้วจึงได้ใบเบิกงบประมาณ'
        : 'งบโครงการไม่ต้องผ่านฝ่ายการเงิน — ได้เอกสารการเบิกขอใช้งบประมาณทันทีเมื่อบันทึก') + '</div>' +
      '<div id="formError"></div>' +
      '<form id="requestForm" class="card" data-budget="' + b.id + '" data-request="' + esc(requestId || '') + '">' +
      field(isCapex ? 'รหัสรายการย่อย (Item No.)' : 'รายการต้นทุน (CBS)', itemSelect) +
      '<div id="itemHint" class="muted small-note"></div>' +
      (isCapex
        ? field('รายการเบิกใช้งบประมาณ', '<input name="description" required' + val('description') + ' placeholder="เช่น งวดที่ 1 40% เครื่องตัดชิ้นงาน">') +
          field('วัตถุประสงค์ในการเบิกใช้', '<textarea name="purpose" required>' + esc(v.purpose || '') + '</textarea>') +
          '<div class="row">' +
          field('ชื่อ Supplier (ผู้รับเงิน)', '<input name="payee" required' + val('payee') + '>') +
          field('งวดที่ / เงื่อนไขการจ่าย (ถ้ามี)', '<input name="installment"' + val('installment') + ' placeholder="เช่น งวดที่ 1 40%">') +
          '</div>'
        : '<div class="row">' +
          field('วันที่เบิก', '<input name="expenseDate" type="date" required' + val('expenseDate') + '>') +
          field('ชื่อเจ้าหนี้ / ผู้รับเงิน', '<input name="payee" required' + val('payee') + '>') +
          '</div>' +
          field('รายละเอียด (ถ้ามีจำนวน โปรดระบุให้ชัดเจน)', '<textarea name="description" required placeholder="เช่น ค่าแรงดูแลกล้า 10-12/01 จำนวน 3 วัน @349">' + esc(v.description || '') + '</textarea>')) +
      '<div class="row">' +
      field('เลขที่ PO', '<input name="poNo"' + (noPo ? ' value="" disabled' : val('poNo')) + '>') +
      '<label class="field check-field"><span>&nbsp;</span><span class="check"><input type="checkbox" name="noPo"' + (noPo ? ' checked' : '') + '> ' +
      (isCapex ? 'ไม่มี PO (N/A)' : 'ไม่ออก PO') + '</span></label>' +
      '</div>' +
      '<fieldset><legend>จำนวนเงิน</legend><div class="row">' +
      field('จำนวนเงินก่อน VAT (บาท)', '<input name="amountBeforeVat" type="number" min="0.01" step="0.01" required' + val('amountBeforeVat') + '>') +
      '<label class="field check-field"><span>&nbsp;</span><span class="check"><input type="checkbox" name="hasVat"' + (hasVat ? ' checked' : '') + '> มี VAT 7%</span></label>' +
      '<div class="field"><span>VAT 7%</span><output id="vatOut" class="out">0.00</output></div>' +
      '<div class="field"><span>รวมจำนวนเงิน</span><output id="totalOut" class="out strong">0.00</output></div>' +
      '</div></fieldset>' +
      '<div id="overBudget" hidden>' +
      (isCapex ? '<div class="alert error" id="overText"></div>'
        : '<div class="alert warn" id="overText"></div>' +
          field('เหตุผลที่ใช้เกินงบ (จำเป็น)', '<textarea name="overBudgetReason">' + esc(v.overBudgetReason || '') + '</textarea>')) +
      '</div>' +
      '<div class="actions"><button class="btn primary" type="submit">' +
      (isCapex ? (existing ? 'ส่งเอกสารให้ฝ่ายการเงินอีกครั้ง' : 'ส่งเอกสารให้ฝ่ายการเงิน') : 'จัดทำเอกสาร') + '</button>' +
      '<a class="btn" href="' + (existing ? '#/request/' + existing.id : '#/budget/' + b.id) + '">ยกเลิก</a></div></form>';
  }

  function readAmounts(form) {
    const before = round2(form.elements.amountBeforeVat.value);
    const vat = form.elements.hasVat.checked ? round2(before * VAT_RATE) : 0;
    return { before, vat, total: round2(before + vat) };
  }

  function bindRequestForm() {
    const form = document.getElementById('requestForm');
    if (!form) return;
    const f = form.elements;
    const b = budgetById(form.dataset.budget);
    const isCapex = b.type === 'CAPEX';
    const existing = form.dataset.request ? requestById(form.dataset.request) : null;
    const remainingOf = () => {
      const o = f.itemId.selectedOptions[0];
      return o && o.value ? Number(o.dataset.remaining) : null;
    };
    const update = () => {
      const a = readAmounts(form);
      document.getElementById('vatOut').textContent = money(a.vat);
      document.getElementById('totalOut').textContent = money(a.total);
      f.poNo.disabled = f.noPo.checked;
      if (f.noPo.checked) f.poNo.value = '';
      const rem = remainingOf();
      const it = itemById(b, f.itemId.value);
      document.getElementById('itemHint').textContent = it
        ? (isCapex ? 'ประเภทสินทรัพย์: ' + it.assetType + ' · หมวด DOA ' + it.doa : (it.glCode ? 'GL ' + it.glCode + ' ' + it.glName : '')) +
          ' · คงเหลือ ' + money(rem) + ' บาท'
        : '';
      const over = rem !== null && a.total > rem;
      document.getElementById('overBudget').hidden = !over;
      if (over) {
        document.getElementById('overText').textContent = isCapex
          ? 'จำนวนเงินเกินงบคงเหลือของรายการย่อยนี้ (คงเหลือ ' + money(rem) + ' บาท) — ต้องขอให้การเงินปรับงบก่อน'
          : 'จำนวนเงินเกินงบคงเหลือของรายการนี้ ' + money(a.total - rem) + ' บาท (คงเหลือ ' + money(rem) + ' บาท) — บันทึกได้แต่ต้องระบุเหตุผล';
      }
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const a = readAmounts(form);
      const rem = remainingOf();
      const errors = [];
      if (!f.itemId.value) errors.push(isCapex ? 'กรุณาเลือกรายการย่อย' : 'กรุณาเลือกรายการต้นทุน');
      if (!(a.before > 0)) errors.push('จำนวนเงินต้องมากกว่า 0');
      if (!f.noPo.checked && !f.poNo.value.trim()) errors.push('กรุณาระบุเลขที่ PO หรือเลือก "' + (isCapex ? 'ไม่มี PO' : 'ไม่ออก PO') + '"');
      const over = rem !== null && a.total > rem;
      if (over && isCapex) errors.push('จำนวนเงินเกินงบคงเหลือของรายการย่อยนี้ (คงเหลือ ' + money(rem) + ' บาท)');
      if (over && !isCapex && !f.overBudgetReason.value.trim()) errors.push('กรุณาระบุเหตุผลที่ใช้เกินงบ');
      if (errors.length) { showErrors(errors); return; }

      const now = new Date().toISOString();
      const fields = {
        itemId: f.itemId.value,
        description: f.description.value.trim(),
        payee: f.payee.value.trim(),
        poNo: f.noPo.checked ? 'N/A' : f.poNo.value.trim(),
        amountBeforeVat: a.before,
        vat: a.vat,
        amount: a.total
      };
      if (isCapex) {
        fields.purpose = f.purpose.value.trim();
        fields.installment = f.installment.value.trim();
      } else {
        fields.expenseDate = f.expenseDate.value;
        fields.overBudget = over;
        fields.overBudgetReason = over ? f.overBudgetReason.value.trim() : '';
      }

      let r;
      if (existing) {
        // แก้ไขแล้วส่งใหม่: เก็บผลตรวจสอบรอบก่อนไว้เป็นประวัติ
        r = existing;
        r.history = (r.history || []).concat(r.steps);
        Object.assign(r, fields, { status: 'pending', steps: stepsFor(b), resubmittedAt: now });
      } else {
        r = Object.assign({
          id: nextId('r'), no: nextReqNo(), budgetId: b.id, type: b.type,
          requesterId: me().id, createdAt: now, status: 'pending', steps: stepsFor(b), history: []
        }, fields);
        db.requests.push(r);
      }

      if (!r.steps.length) {
        issueDocument(r, b, now);
        setFlash('success', 'จัดทำเอกสารเรียบร้อย เลขที่ ' + r.docNo + (over ? ' (ใช้เกินงบ — บันทึกเหตุผลแล้ว)' : ''));
      } else {
        setFlash('success', (existing ? 'ส่งคำขอ ' + r.no + ' อีกครั้ง' : 'ส่งคำขอ ' + r.no) + ' เรียบร้อยแล้ว รอฝ่ายการเงินตรวจสอบ');
      }
      save();
      go('#/request/' + r.id);
    });
  }

  function issueDocument(r, b, at) {
    r.status = 'approved';
    r.approvedAt = at;
    r.docNo = nextDocNo(r, b, at);
    if (r.type === 'CBS') {
      const it = itemById(b, r.itemId) || {};
      r.accounting = { glCode: it.glCode || '', glName: it.glName || '', paymentStatus: 'รอจ่าย' };
    }
  }

  // ---------------------------------------------------------------- request lists

  function requestTable(list, showBudget) {
    if (!list.length) return '<div class="card empty">ยังไม่มีคำขอเบิกใช้งบ</div>';
    list = list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return '<div class="table-wrap"><table><thead><tr><th>เลขที่คำขอ</th>' +
      (showBudget ? '<th>งบ</th>' : '') +
      '<th>รายการ</th><th>รายการเบิก</th><th>ผู้ขอ</th><th class="num">จำนวนเงิน</th><th>สถานะ</th><th>เอกสาร</th></tr></thead><tbody>' +
      list.map((r) => {
        const b = budgetById(r.budgetId);
        const it = itemById(b, r.itemId);
        const step = currentStep(r);
        return '<tr><td class="nowrap"><a href="#/request/' + r.id + '">' + esc(r.no) + '</a><div class="muted">' + fmtDate(r.createdAt) + '</div></td>' +
          (showBudget ? '<td>' + badge(r.type, r.type) + ' ' + esc(b ? b.code : '-') + '</td>' : '') +
          '<td>' + (it ? esc(it.code) + '<div class="muted">' + esc(it.name) + '</div>' : '-') + '</td>' +
          '<td>' + esc(r.description) + (r.overBudget ? ' <span class="badge rejected">เกินงบ</span>' : '') + '</td>' +
          '<td>' + esc(userName(r.requesterId)) + '</td>' +
          '<td class="num">' + money(r.amount) + '</td>' +
          '<td>' + badge(r.status, STATUS_LABEL[r.status]) +
          (step ? '<div class="muted">รอ: ' + esc(stepAssigneeText(step)) + '</div>' : '') + '</td>' +
          '<td>' + (!r.docNo ? '-' : r.status === 'cancelled' ? '<s>' + esc(r.docNo) + '</s> <span class="muted">(ยกเลิก)</span>'
            : '<a href="#/doc/' + r.id + '">' + esc(r.docNo) + '</a>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function viewRequests() {
    const u = me();
    const list = u.role === 'requester' ? db.requests.filter((r) => r.requesterId === u.id) : db.requests;
    return '<div class="page-head"><h1>' + (u.role === 'requester' ? 'คำขอของฉัน' : 'คำขอใช้งบทั้งหมด') + '</h1></div>' + takeFlash() + requestTable(list, true);
  }

  function viewApprovals() {
    return '<div class="page-head"><h1>เอกสาร CAPEX รอตรวจสอบ</h1></div>' + takeFlash() + requestTable(inbox(me()), true);
  }

  function viewAccounting() {
    if (me().role !== 'accounting') return '<div class="alert error">เฉพาะฝ่ายบัญชี</div>';
    return '<div class="page-head"><h1>รอบันทึกข้อมูลบัญชี</h1></div>' + takeFlash() +
      '<p class="muted">เอกสารที่ออกแล้ว แต่ยังไม่ได้บันทึกข้อมูลบัญชี (CAPEX: แยก Asset / Expense · CBS: ยืนยัน GL Code และสถานะจ่าย)</p>' +
      requestTable(db.requests.filter(needsAccounting), true);
  }

  // ---------------------------------------------------------------- request detail

  function viewRequestDetail(id) {
    const r = requestById(id);
    if (!r) return notFound();
    const b = budgetById(r.budgetId);
    const u = me();
    const step = currentStep(r);
    const item = itemById(b, r.itemId);
    const isCapex = r.type === 'CAPEX';
    const kv = (k, v) => (v || v === 0 ? '<dt>' + k + '</dt><dd>' + v + '</dd>' : '');

    let html = takeFlash() + '<div class="page-head"><h1>คำขอเบิกใช้งบ ' + esc(r.no) + ' ' + badge(r.status, STATUS_LABEL[r.status]) + '</h1>' +
      (r.docNo && r.status === 'approved' ? '<a class="btn primary" href="#/doc/' + r.id + '">เปิดเอกสารเลขที่ ' + esc(r.docNo) + '</a>' : '') + '</div>';
    if (r.status === 'cancelled') {
      html += '<div class="alert error">ยกเลิกโดย ' + esc(userName(r.cancelledBy || r.requesterId)) + ' เมื่อ ' + fmtDate(r.cancelledAt) +
        (r.docNo ? ' · เอกสารเลขที่ ' + esc(r.docNo) + ' ใช้ไม่ได้แล้ว และคืนยอดเข้างบเรียบร้อย' : '') +
        (r.cancelReason ? '<br>เหตุผล: ' + esc(r.cancelReason) : '') + '</div>';
    }
    if (r.overBudget) html += '<div class="alert warn">ใช้เกินงบของรายการนี้ · เหตุผล: ' + esc(r.overBudgetReason) + '</div>';

    html += '<div class="grid"><div class="card"><dl class="kv">' +
      kv('งบ', badge(b.type, b.type) + ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a>') +
      kv('ชื่อโครงการ', esc(b.name)) +
      kv(isCapex ? 'รายการย่อย' : 'รายการต้นทุน', item ? esc(item.code + ' ' + item.name) : '-') +
      kv('ผู้ขอ', esc(userName(r.requesterId))) +
      kv('วันที่ขอ', fmtDate(r.createdAt)) +
      (isCapex ? '' : kv('วันที่เบิก', fmtDay(r.expenseDate))) +
      kv(isCapex ? 'รายการเบิกใช้งบ' : 'รายละเอียด', esc(r.description)) +
      (isCapex ? kv('วัตถุประสงค์', esc(r.purpose)) + kv('งวด', esc(r.installment)) : '') +
      kv(isCapex ? 'Supplier (ผู้รับเงิน)' : 'ผู้รับเงิน', esc(r.payee)) +
      kv('PO No.', esc(r.poNo)) +
      kv('ก่อน VAT', money(r.amountBeforeVat)) +
      kv('VAT 7%', money(r.vat)) +
      '<dt>รวมจำนวนเงิน</dt><dd class="big">' + money(r.amount) + ' บาท</dd>' +
      '</dl></div>';

    const stepItem = (s, idx) => {
      const cls = s.status === 'waiting' ? (s === step ? 'current' : '') : s.status;
      return '<li class="' + cls + '"><span class="dot">' + (s.status === 'approved' ? '✓' : s.status === 'rejected' ? '✕' : idx + 1) + '</span><div>' +
        '<div><strong>' + esc(s.label) + '</strong></div>' +
        '<div class="muted">' + esc(s.by ? userName(s.by) : stepAssigneeText(s)) +
        (s.at ? ' · ' + fmtDate(s.at) : s === step ? ' · กำลังรอ' : '') + '</div>' +
        (s.comment ? '<div>“' + esc(s.comment) + '”</div>' : '') + '</div></li>';
    };
    html += '<div class="card"><h2 style="margin-top:0">การตรวจสอบเอกสาร</h2>';
    if (!r.steps.length) {
      html += '<p class="muted">งบโครงการ (CBS) ไม่ต้องผ่านฝ่ายการเงิน — ออกเอกสารทันทีเมื่อ ' + fmtDate(r.approvedAt) + '</p>';
    }
    if (r.history && r.history.length) {
      html += '<div class="muted">รอบก่อนหน้า</div><ol class="steps">' + r.history.map(stepItem).join('') + '</ol>' +
        '<div class="muted">รอบปัจจุบัน (ส่งใหม่ ' + fmtDate(r.resubmittedAt) + ')</div>';
    }
    html += '<ol class="steps">' + r.steps.map(stepItem).join('') + '</ol>';

    if (canAct(u, step)) {
      html += '<form id="decisionForm" data-id="' + r.id + '">' +
        '<div class="row">' +
        '<label class="field"><span>วันที่ส่งมอบ / วางบิล</span><input name="deliveryDate" type="date"></label>' +
        '<label class="field"><span>วันที่กำหนดจ่ายเงิน</span><input name="paymentDueDate" type="date"></label>' +
        '</div>' +
        '<label class="field"><span>เหตุผล (จำเป็นเมื่อไม่อนุมัติ เช่น ควรใช้งบตัวไหนแทน)</span><textarea name="comment"></textarea></label>' +
        '<div class="actions"><button class="btn ok" type="submit" data-decision="approved">อนุมัติเอกสาร</button>' +
        '<button class="btn bad" type="submit" data-decision="rejected">ไม่อนุมัติ</button></div></form>';
    }
    if ((r.status === 'pending' || r.status === 'rejected') && r.requesterId === u.id) {
      html += '<div class="actions">' +
        (r.status === 'rejected' ? '<a class="btn primary" href="#/request/' + r.id + '/edit">แก้ไขและส่งใหม่</a>' : '') +
        '<button class="btn bad" id="cancelRequest" data-id="' + r.id + '">ยกเลิกคำขอ</button></div>';
    }
    // CBS ไม่ผ่านการเงิน ผู้ขอจึงยกเลิกเอกสารที่ออกแล้วเองได้ (เช่น เลือกตัวงบหรือยอดผิด)
    if (r.type === 'CBS' && r.status === 'approved' && r.requesterId === u.id) {
      html += '<div class="actions"><button class="btn bad" id="cancelRequest" data-id="' + r.id + '">ยกเลิกเอกสาร ' + esc(r.docNo) + '</button></div>' +
        '<p class="muted">ยกเลิกแล้วยอดจะคืนเข้างบ และเอกสารเลขที่นี้จะนำไปแนบขอซื้อไม่ได้อีก</p>';
    }
    html += '</div></div>';

    if (r.status === 'approved') html += financePanel(r, u);
    return html;
  }

  /** ข้อมูลการเงิน/บัญชีของเอกสารที่ออกแล้ว: การเงินแก้วันที่, บัญชีแก้ข้อมูลบัญชี, คนอื่นดูอย่างเดียว */
  function financePanel(r, u) {
    const fin = r.finance || {};
    const acc = r.accounting || {};
    const isCapex = r.type === 'CAPEX';
    const canFin = u.role === 'finance' && isCapex;
    const canAcc = u.role === 'accounting';
    const input = (name, value, type, editable, extra) => editable
      ? '<input name="' + name + '" type="' + (type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '>'
      : '<div class="out">' + (value === '' || value == null ? '-' : esc(type === 'date' ? fmtDay(value) : type === 'number' ? money(value) : value)) + '</div>';
    const field = (label, inner) => '<label class="field"><span>' + label + '</span>' + inner + '</label>';

    let html = '<h2>ข้อมูลการเงิน / บัญชี' + (needsAccounting(r) ? ' <span class="badge pending">รอบัญชีบันทึก</span>' : '') + '</h2>' +
      '<form id="acctForm" class="card" data-id="' + r.id + '">';
    if (isCapex) {
      html += '<div class="row">' +
        field('วันที่ส่งมอบ / วางบิล (การเงิน)', input('deliveryDate', fin.deliveryDate, 'date', canFin)) +
        field('วันที่กำหนดจ่ายเงิน (การเงิน)', input('paymentDueDate', fin.paymentDueDate, 'date', canFin)) +
        field('มูลค่า Asset ก่อน VAT (บัญชี)', input('assetAmount', acc.assetAmount, 'number', canAcc, ' min="0" step="0.01"')) +
        field('มูลค่า Expenses ก่อน VAT (บัญชี)', input('expenseAmount', acc.expenseAmount, 'number', canAcc, ' min="0" step="0.01"')) +
        '</div>';
    } else {
      html += '<div class="row">' +
        field('GL Code (บัญชี)', input('glCode', acc.glCode, 'text', canAcc)) +
        field('GL Name (บัญชี)', input('glName', acc.glName, 'text', canAcc)) +
        field('สถานะการจ่ายเงิน (บัญชี)', canAcc
          ? '<div class="select-wrap"><select name="paymentStatus">' + ['รอจ่าย', 'จ่ายแล้ว'].map((s) => opt(s, s, acc.paymentStatus || 'รอจ่าย')).join('') + '</select></div>'
          : input('paymentStatus', acc.paymentStatus, 'text', false)) +
        '</div>';
    }
    if (acc.updatedAt) html += '<p class="muted small-note">บัญชีบันทึกล่าสุดโดย ' + esc(userName(acc.updatedBy)) + ' เมื่อ ' + fmtDate(acc.updatedAt) + '</p>';
    if (canFin || canAcc) html += '<div class="actions" style="margin-top:0"><button class="btn primary" type="submit">บันทึกข้อมูล' + (canAcc ? 'บัญชี' : 'การเงิน') + '</button></div>';
    return html + '</form>';
  }

  function bindRequestDetail() {
    const form = document.getElementById('decisionForm');
    if (form) {
      let decision = 'approved';
      form.querySelectorAll('[data-decision]').forEach((btn) =>
        btn.addEventListener('click', () => { decision = btn.dataset.decision; }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = requestById(form.dataset.id);
        const b = budgetById(r.budgetId);
        const step = currentStep(r);
        const u = me();
        if (!canAct(u, step)) return;
        const comment = form.elements.comment.value.trim();
        if (decision === 'rejected' && !comment) {
          alert('กรุณาแจ้งเหตุผลที่ไม่อนุมัติ');
          return;
        }
        if (decision === 'approved') {
          // ตรวจซ้ำว่ายอดยังไม่เกินงบ (คำขอนี้ถูกจองไว้แล้ว จึงคิดเฉพาะยอดที่ออกเอกสารไปแล้ว)
          const us = usage(b, r.itemId);
          if (us.used + r.amount > us.approved) {
            alert('งบไม่เพียงพอ กรุณาตรวจสอบวงเงินงบอีกครั้ง');
            return;
          }
        }
        Object.assign(step, { status: decision, by: u.id, at: new Date().toISOString(), comment });
        if (decision === 'rejected') {
          r.status = 'rejected';
          setFlash('info', 'ไม่อนุมัติคำขอ ' + r.no + ' แล้ว แจ้งเหตุผลให้ผู้ขอแก้ไขหรือยกเลิก งบที่จองไว้ถูกคืนเรียบร้อย');
        } else {
          r.finance = { deliveryDate: form.elements.deliveryDate.value, paymentDueDate: form.elements.paymentDueDate.value };
          issueDocument(r, b, step.at);
          setFlash('success', 'อนุมัติเอกสารแล้ว ออกใบเบิกงบประมาณเลขที่ ' + r.docNo);
        }
        save();
        go('#/request/' + r.id);
      });
    }

    const acct = document.getElementById('acctForm');
    if (acct) {
      acct.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = requestById(acct.dataset.id);
        const f = acct.elements;
        const u = me();
        const now = new Date().toISOString();
        if (u.role === 'finance' && f.deliveryDate) {
          r.finance = { deliveryDate: f.deliveryDate.value, paymentDueDate: f.paymentDueDate.value };
          setFlash('success', 'บันทึกข้อมูลการเงินแล้ว');
        } else if (u.role === 'accounting') {
          if (r.type === 'CAPEX') {
            const asset = round2(f.assetAmount.value);
            const expense = round2(f.expenseAmount.value);
            if (asset + expense > r.amount) {
              alert('Asset + Expenses (' + money(asset + expense) + ') ต้องไม่เกินจำนวนเงินรวม ' + money(r.amount) + ' บาท');
              return;
            }
            if (!(asset + expense > 0)) {
              alert('กรุณาระบุมูลค่า Asset และ/หรือ Expenses');
              return;
            }
            r.accounting = { assetAmount: asset, expenseAmount: expense, updatedAt: now, updatedBy: u.id };
          } else {
            r.accounting = { glCode: f.glCode.value.trim(), glName: f.glName.value.trim(), paymentStatus: f.paymentStatus.value, updatedAt: now, updatedBy: u.id };
          }
          setFlash('success', 'บันทึกข้อมูลบัญชีของ ' + r.docNo + ' แล้ว');
        }
        save();
        go('#/request/' + r.id);
      });
    }

    const cancel = document.getElementById('cancelRequest');
    if (cancel) {
      cancel.addEventListener('click', () => {
        const r = requestById(cancel.dataset.id);
        let reason = '';
        if (r.status === 'approved') {
          // เอกสารที่ออกไปแล้วต้องระบุเหตุผลการยกเลิกไว้ตรวจสอบย้อนหลัง
          reason = (prompt('ระบุเหตุผลที่ยกเลิกเอกสาร ' + r.docNo + ' (เช่น เลือกตัวงบผิด / ยอดผิด)') || '').trim();
          if (!reason) return;
        } else if (!confirm('ยืนยันการยกเลิกคำขอนี้?')) {
          return;
        }
        const wasIssued = r.status === 'approved';
        r.status = 'cancelled';
        r.cancelledAt = new Date().toISOString();
        r.cancelledBy = me().id;
        r.cancelReason = reason;
        save();
        setFlash('info', wasIssued
          ? 'ยกเลิกเอกสาร ' + r.docNo + ' แล้ว คืนยอด ' + money(r.amount) + ' บาทเข้างบเรียบร้อย'
          : 'ยกเลิกคำขอ ' + r.no + ' แล้ว');
        go('#/request/' + r.id);
      });
    }
  }

  // ---------------------------------------------------------------- documents

  /** ยอดก่อนหน้าเอกสารนี้: เอกสารที่ออกก่อนหน้าในขอบเขตเดียวกัน (ทั้งโครงการ หรือรายการ) */
  function balanceAt(r, b, itemId) {
    const ids = itemId ? leafIdsUnder(b, itemById(b, itemId)) : null;
    const approved = itemId ? usage(b, itemId).approved : budgetTotal(b);
    const before = round2(db.requests
      .filter((x) => x.budgetId === b.id && x.id !== r.id && x.status === 'approved' && x.approvedAt <= r.approvedAt && (!ids || ids.includes(x.itemId)))
      .reduce((s, x) => s + x.amount, 0));
    return { approved, before, after: round2(approved - before - r.amount) };
  }

  function doaTable(cat, amount) {
    const t = DOA[cat] || DOA['2.5'];
    const m = amount / 1e6;
    const hit = t.rows.findIndex((row) => row.match(m));
    return '<div class="section"><h2>อำนาจอนุมัติ อ้างอิงตามตารางอำนาจอนุมัติ (DOA)</h2>' +
      '<p class="doa-title">' + esc(t.title) + '</p><table><thead><tr><th style="width:2rem"></th><th>เงื่อนไข</th><th>ผู้อนุมัติ</th>' +
      '<th style="width:28%">ลงชื่อผู้อนุมัติ</th><th style="width:16%">วันที่อนุมัติ</th></tr></thead><tbody>' +
      t.rows.map((row, i) => '<tr' + (i === hit ? ' class="doa-hit"' : '') + '><td class="center">' + (i === hit ? '☑' : '☐') + '</td>' +
        '<td>' + esc(row.code + ' ' + row.label) + '</td><td>' + esc(row.approver) + '</td><td></td><td></td></tr>').join('') +
      '</tbody></table>' +
      (hit < 0 ? '<p class="note">ยอดเงินเกินวงเงินในตาราง DOA — ต้องเสนอคณะกรรมการตามระเบียบ</p>'
        : '<p class="note">ระบบเลือกระดับผู้อนุมัติตามจำนวนเงินที่ขอเบิกครั้งนี้ (' + money(amount) + ' บาท)</p>') + '</div>';
  }

  function viewDocument(id) {
    const r = requestById(id);
    if (!r) return notFound();
    if (r.status === 'cancelled' && r.docNo) return '<div class="alert error">เอกสารเลขที่ ' + esc(r.docNo) + ' ถูกยกเลิกแล้ว ใช้แนบขอซื้อไม่ได้</div>';
    if (r.status !== 'approved') return '<div class="alert error">คำขอนี้ยังไม่ได้รับอนุมัติจากฝ่ายการเงิน จึงยังไม่มีเอกสาร</div>';
    const b = budgetById(r.budgetId);
    const item = itemById(b, r.itemId) || {};
    const isCapex = r.type === 'CAPEX';
    const proj = balanceAt(r, b, null);
    const line = balanceAt(r, b, r.itemId);
    const tr = (k, v) => '<tr><th style="width:34%">' + k + '</th><td>' + v + '</td></tr>';
    const balanceTable = (title, bal) => '<table><thead><tr><th colspan="2">' + title + '</th></tr></thead><tbody>' +
      tr('จำนวนเงินงบประมาณ (รวม VAT)', '<span class="num-cell">' + money(bal.approved) + ' บาท</span>') +
      tr('ใช้งบประมาณไปแล้วก่อนการขอเบิก', '<span class="num-cell">' + money(bal.before) + ' บาท</span>') +
      tr('จำนวนงบประมาณที่ขอเบิกครั้งนี้ (รวม VAT)', '<span class="num-cell"><strong>' + money(r.amount) + ' บาท</strong></span>') +
      tr('งบประมาณคงเหลือ (หลังเบิกครั้งนี้)', '<span class="num-cell">' + moneyCell(bal.after) + ' บาท</span>') + '</tbody></table>';

    const head = '<header><div><h1>' + esc(COMPANIES[b.company] || b.company) + '</h1><div class="doc-sub">' +
      (isCapex ? 'ใบเบิกงบประมาณ (งบลงทุน CAPEX)' : 'เอกสารการเบิกขอใช้งบประมาณ (งบโครงการ CBS)') + '</div></div>' +
      '<div class="docno">ใบเบิกเลขที่ <strong>' + esc(r.docNo) + '</strong><br>วันที่ออกเอกสาร ' + fmtDay(r.approvedAt) +
      (isCapex ? '<br><span class="stamp">การเงินตรวจสอบแล้ว</span>' : '') + '</div></header>';

    const info = '<div class="section"><table><tbody>' +
      tr(isCapex ? 'รหัสโครงการ (Project No.)' : 'Job No.', esc(b.code + ' ' + b.name)) +
      (isCapex ? tr('รหัสรายการย่อย (Item No.)', esc(item.code + ' ' + item.name)) :
        tr('รายการต้นทุน (CBS)', esc(item.code + ' ' + item.name)) + tr('GL Code', esc(((r.accounting || {}).glCode || item.glCode || '-') + ' ' + ((r.accounting || {}).glName || item.glName || '')))) +
      tr('วันที่ขอเบิก', fmtDay(isCapex ? r.createdAt : r.expenseDate)) +
      tr('ชื่อผู้ขอเบิกงบประมาณ', esc(userName(r.requesterId) + ' · ' + b.department)) +
      '</tbody></table></div>';

    const detail = '<div class="section"><h2>รายละเอียดการเบิกงบประมาณ</h2><div class="doc-two">' +
      balanceTable('ระดับโครงการ: ' + esc(b.code), proj) +
      balanceTable((isCapex ? 'ระดับรายการย่อย: ' : 'ระดับรายการต้นทุน: ') + esc(item.code), line) + '</div></div>';

    const thisTime = '<div class="section"><h2>ข้อมูลการเบิกใช้งบประมาณครั้งนี้</h2><table><tbody>' +
      tr(isCapex ? 'รายการงบประมาณ' : 'รายละเอียด', esc(r.description)) +
      (isCapex ? tr('วัตถุประสงค์ในการเบิกใช้', esc(r.purpose)) + (r.installment ? tr('งวด / เงื่อนไขการจ่าย', esc(r.installment)) : '') : '') +
      tr(isCapex ? 'Supplier (ผู้รับเงิน)' : 'ผู้รับเงิน', esc(r.payee)) +
      tr('PO No.', esc(r.poNo)) +
      tr('จำนวนเงินก่อน VAT', money(r.amountBeforeVat) + ' บาท') +
      tr('VAT 7%', money(r.vat) + ' บาท') +
      tr('รวมจำนวนเงิน', '<strong>' + money(r.amount) + ' บาท</strong>') +
      (r.overBudget ? tr('หมายเหตุ: ใช้เกินงบ', esc(r.overBudgetReason)) : '') +
      '</tbody></table></div>';

    const signs = '<div class="signs"><div><div class="line"></div>ผู้ขอเบิกงบประมาณ<br>' + esc(userName(r.requesterId)) + '</div>' +
      r.steps.map((s) => '<div><div class="line"></div>' + esc((user(s.by) || {}).title || '') + '<br>' + esc(userName(s.by)) + '<br><small>' + fmtDay(s.at) + '</small></div>').join('') +
      '</div>';

    return '<div class="actions no-print" style="margin:0 0 1rem">' +
      '<button class="btn primary" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button>' +
      '<a class="btn" href="#/request/' + r.id + '">กลับไปที่คำขอ</a></div>' +
      '<article class="doc">' + head + info + detail + thisTime +
      (isCapex ? doaTable(item.doa, r.amount) : '') + signs +
      '<p class="note">โปรดแนบเอกสารฉบับนี้ และระบุเลขที่ ' + esc(r.docNo) +
      ' ในใบขอซื้อ (PR) ที่เกี่ยวข้อง · ยอดขอซื้อรวมต้องไม่เกิน ' + money(r.amount) + ' บาท</p>' +
      '</article>';
  }

  function notFound() {
    return '<div class="card empty">ไม่พบข้อมูลที่ต้องการ</div>';
  }

  // ---------------------------------------------------------------- router

  function render() {
    const hash = location.hash || homeFor(me());
    const [path, query] = hash.slice(1).split('?');
    const params = new URLSearchParams(query || '');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) { location.replace(homeFor(me())); return; }
    const app = document.getElementById('app');
    let html;

    if (parts[0] === 'budgets' || parts[0] === 'my-budgets') html = viewBudgets(params);
    else if (parts[0] === 'budget' && parts[1] === 'new') html = viewBudgetForm(null);
    else if (parts[0] === 'budget' && parts[2] === 'edit') html = viewBudgetForm(parts[1]);
    else if (parts[0] === 'budget') html = viewBudgetDetail(parts[1]);
    else if (parts[0] === 'request' && parts[1] === 'new') html = viewRequestForm(parts[2], null, params);
    else if (parts[0] === 'request' && parts[2] === 'edit') html = viewRequestForm(null, parts[1], params);
    else if (parts[0] === 'request') html = viewRequestDetail(parts[1]);
    else if (parts[0] === 'requests') html = viewRequests();
    else if (parts[0] === 'approvals') html = viewApprovals();
    else if (parts[0] === 'accounting') html = viewAccounting();
    else if (parts[0] === 'doc') html = viewDocument(parts[1]);
    else html = notFound();

    renderNav('#/' + path);
    app.innerHTML = html;
    bindBudgetForm();
    bindRequestForm();
    bindRequestDetail();
    bindBudgetFilters();
    document.body.classList.remove('nav-open');
    window.scrollTo(0, 0);
  }

  /**
   * GitHub Pages ให้เบราว์เซอร์เก็บ cache หน้าเว็บได้ราว 10 นาที จึงเช็กเลขเวอร์ชันจากเซิร์ฟเวอร์โดยตรง
   * ถ้าเลขใน index.html บนเซิร์ฟเวอร์ใหม่กว่าหน้าที่เปิดอยู่ จะโหลดหน้าใหม่ให้เอง (ข้อมูลใน localStorage ไม่หาย)
   */
  function checkForUpdate() {
    const meta = document.querySelector('meta[name="app-version"]');
    if (!meta || !window.fetch || location.protocol === 'file:') return;
    fetch('index.html?check=' + Date.now(), { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : ''))
      .then((html) => {
        const m = html.match(/<meta name="app-version" content="([^"]+)"/);
        const url = new URL(location.href);
        // กันโหลดวนซ้ำ: ถ้าเคยพาไปที่ ?v=เวอร์ชันนี้แล้ว ไม่ต้องโหลดอีก
        if (!m || m[1] === meta.content || url.searchParams.get('v') === m[1]) return;
        url.searchParams.set('v', m[1]);
        location.replace(url.toString());
      })
      .catch(() => { /* ออฟไลน์หรือเช็กไม่ได้ ใช้หน้าเดิมต่อ */ });
  }

  function renderUserButton() {
    document.getElementById('userName').textContent = me().name;
    document.getElementById('userPos').textContent = me().title;
  }

  /** เมนูผู้ใช้มุมขวาบน: สลับผู้ใช้ตัวอย่าง (ต้นแบบยังไม่มีล็อกอิน) และรีเซ็ตข้อมูล */
  function initUserMenu() {
    const btn = document.getElementById('userBtn');
    const menu = document.getElementById('userMenu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const fill = () => {
      menu.innerHTML = '<div class="menu-label">เข้าใช้งานในฐานะ (ทดสอบ)</div>' +
        USERS.map((x) => '<button type="button" role="menuitemradio" data-user="' + x.id + '" aria-checked="' + (x.id === me().id) + '">' +
          esc(x.name) + '<small>' + esc(x.title + ' · ' + ROLE_LABEL[x.role]) + '</small></button>').join('') +
        '<hr><button type="button" role="menuitem" class="danger" data-reset>รีเซ็ตข้อมูลตัวอย่าง</button>';
    };
    renderUserButton();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!menu.hidden) { close(); return; }
      fill();
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('button');
      if (!item) return;
      e.stopPropagation();
      close();
      if (item.hasAttribute('data-reset')) {
        if (!confirm('ล้างข้อมูลทั้งหมดและกลับไปใช้ข้อมูลตัวอย่าง?')) return;
        db = seed();
        save();
      } else {
        currentUserId = item.dataset.user;
        try { localStorage.setItem(DB_KEY + '.user', currentUserId); } catch (err) { /* ignore */ }
        renderUserButton();
      }
      go(homeFor(me()));
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function init() {
    db = load();
    checkForUpdate();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    initUserMenu();
    const toggle = document.getElementById('menuToggle');
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop no-print';
    document.body.appendChild(backdrop);
    const setNav = (open) => {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
    backdrop.addEventListener('click', () => setNav(false));
    window.addEventListener('hashchange', render);
    render();
  }

  init();
})();
