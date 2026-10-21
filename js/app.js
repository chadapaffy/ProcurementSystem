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
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { /* ใช้ข้อมูลตัวอย่างแทน */ }
    return seed();
  }

  /** แปลงคำขอรูปแบบเดิม (1 ใบ = 1 บรรทัด) เป็นแบบหลายบรรทัด + งวดจ่าย โดยไม่ทำให้ข้อมูลหาย */
  function migrate(d) {
    (d.requests || []).forEach((r) => {
      if (r.lines) return;
      const acc = r.accounting || {};
      r.lines = [{
        itemId: r.itemId, description: r.description || '', amountBeforeVat: r.amountBeforeVat, vat: r.vat, amount: r.amount,
        glCode: r.type === 'CBS' ? acc.glCode || '' : undefined, glName: r.type === 'CBS' ? acc.glName || '' : undefined
      }];
      if (r.type === 'CAPEX') {
        const fin = r.finance || {};
        r.paymentTerms = r.installment || '';
        r.payments = [];
        if (r.status === 'approved' && (fin.deliveryDate || fin.paymentDueDate || acc.updatedAt)) {
          r.payments.push({
            id: 'p' + r.id, no: 1, label: r.installment || 'งวดที่ 1', deliveryDate: fin.deliveryDate || '', dueDate: fin.paymentDueDate || '',
            amountBeforeVat: r.amountBeforeVat, vat: r.vat, amount: r.amount, at: r.approvedAt, by: 'fin1',
            asset: acc.assetAmount, expense: acc.expenseAmount, acctAt: acc.updatedAt, acctBy: acc.updatedBy
          });
        }
      }
      delete r.description; delete r.installment; delete r.finance;
      if (r.type === 'CAPEX') delete r.accounting;
    });
    return d;
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
      if (r.budgetId !== b.id || (r.status !== 'approved' && r.status !== 'pending')) return;
      const amt = linesAmount(r, ids);
      if (r.status === 'approved') used += amt;
      else reserved += amt;
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

  // ---- คำขอเบิก: 1 ใบมีได้หลายบรรทัด (CAPEX ทุกบรรทัดอยู่ใต้รายการย่อยเดียวกัน, CBS แต่ละบรรทัดเลือกรายการต้นทุนเองได้)
  const lineTotal = (l) => round2(Number(l.amountBeforeVat || 0) + Number(l.vat || 0));
  /** ยอดของบรรทัดที่อยู่ในรายการ ids (null = ทุกบรรทัด) */
  const linesAmount = (r, ids) => round2(r.lines.filter((l) => !ids || ids.includes(l.itemId)).reduce((s, l) => s + l.amount, 0));
  const reqItemIds = (r) => uniq(r.lines.map((l) => l.itemId));
  const paidTotal = (r) => round2((r.payments || []).reduce((s, p) => s + p.amount, 0));
  const outstanding = (r) => round2(r.amount - paidTotal(r));

  /** แผนการจ่าย (CAPEX): { mode: 'single' | 'installments', installments: [{ pct, note }] } — คำขอเก่าใช้ข้อความ paymentTerms */
  const isInstallments = (r) => !!(r.paymentPlan && r.paymentPlan.mode === 'installments');
  function planText(r) {
    if (!r.paymentPlan) return r.paymentTerms || '';
    if (!isInstallments(r)) return 'จ่ายครั้งเดียว';
    return r.paymentPlan.installments.length + ' งวด: ' + r.paymentPlan.installments.map((x) => x.pct + '%').join(' / ');
  }
  /** ยอดของแต่ละงวดตามแผน (งวดสุดท้ายรับเศษให้รวมได้ยอดเต็มพอดี) */
  function planAmounts(total, pcts) {
    const out = pcts.map((p) => round2(total * Number(p || 0) / 100));
    const sumPct = round2(pcts.reduce((s, p) => s + Number(p || 0), 0));
    if (out.length && sumPct === 100) out[out.length - 1] = round2(total - out.slice(0, -1).reduce((s, x) => s + x, 0));
    return out;
  }
  function planDetailHtml(r) {
    if (!isInstallments(r)) return esc(planText(r));
    const amts = planAmounts(r.amount, r.paymentPlan.installments.map((x) => x.pct));
    return r.paymentPlan.installments.map((x, i) => 'งวดที่ ' + (i + 1) + ' · ' + x.pct + '% · ' + money(amts[i]) + ' บาท' +
      (x.note ? ' — ' + esc(x.note) : '')).join('<br>');
  }
  function reqSummary(r) {
    const first = r.lines[0] ? r.lines[0].description : '';
    return r.lines.length > 1 ? first + ' และอีก ' + (r.lines.length - 1) + ' รายการ' : first;
  }
  /** CAPEX: บัญชีต้องแยก Asset/Expense ทุกงวดที่การเงินบันทึก · CBS: บัญชียืนยัน GL และสถานะจ่ายของทั้งใบ */
  function needsAccounting(r) {
    if (r.status !== 'approved') return false;
    if (r.type === 'CAPEX') return (r.payments || []).some((p) => !p.acctAt);
    return !(r.accounting && r.accounting.updatedAt);
  }
  const needsPayment = (r) => r.type === 'CAPEX' && r.status === 'approved' && outstanding(r) > 0;

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
    if (u.role === 'finance') {
      links.push(['#/approvals', 'รอตรวจสอบ' + count(inbox(u).length), ['#/approvals']]);
      links.push(['#/payments', 'งวดจ่ายค้าง' + count(db.requests.filter(needsPayment).length), ['#/payments']]);
    }
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

  const usedItemIds = () => new Set([].concat(...db.requests.map(reqItemIds)));

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
    const isCapex = b.type === 'CAPEX';
    const prod = b.production || {};
    const first = (b.revisions && b.revisions[0]) ? b.revisions[0].items : [];

    // ---- หัวหน้า + ปุ่มคำสั่ง
    const actions = [];
    if (canRequest) actions.push('<a class="btn primary" href="#/request/new/' + b.id + '">ขอเบิกใช้งบ</a>');
    if (u.role === 'finance') actions.push('<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไข / ' + (isCapex ? 'ปรับงบ' : 'Revise CBS') + '</a>');
    let html = '<div class="page-head detail-head"><div>' +
      '<div class="eyebrow">' + (isCapex ? 'งบลงทุน' : 'งบโครงการ') + ' · ' + badge(b.type, b.type) + ' ' + esc(b.code) +
      (b.parentCode ? ' <span class="muted">(โครงการหลัก ' + esc(b.parentCode) + ')</span>' : '') + '</div>' +
      '<h1>' + esc(b.name) + (isCapex ? '' : ' ' + badge(b.status === 'แล้วเสร็จ' ? 'approved' : 'pending', b.status)) + '</h1></div>' +
      (actions.length ? '<div class="head-actions">' + actions.join('') + '</div>' : '') + '</div>' + takeFlash();

    // ---- ข้อมูลหลักแบบตาราง
    const fact = (label, value, wide) => (value || value === 0
      ? '<div class="fact' + (wide ? ' wide' : '') + '"><span>' + label + '</span><strong>' + value + '</strong></div>' : '');
    const facts = '<section class="card"><div class="facts">' +
      fact('บริษัท', esc(b.company) + '<small>' + esc(COMPANIES[b.company] || '') + '</small>') +
      fact('ปีงบประมาณ', esc(b.fiscalYear)) +
      (isCapex ? fact('กลุ่มงบประมาณ', esc(b.group)) : fact('ระยะเวลา', b.startDate ? fmtDay(b.startDate) + '<small>ถึง ' + fmtDay(b.endDate) + '</small>' : '')) +
      fact('หน่วยงาน', esc(b.department)) +
      fact('ผู้ขอใช้งบ', esc(userName(b.ownerId))) +
      (isCapex ? fact('รายการย่อย', b.items.length + ' รายการ')
        : fact('สถานที่ / แปลง', esc(prod.site)) +
          fact('ผลผลิต', prod.product ? esc(prod.product) + (prod.qty ? '<small>' + Number(prod.qty).toLocaleString('th-TH') + ' ' + esc(prod.unit || '') + '</small>' : '') : '') +
          fact('รายการต้นทุน', leaves(b).length + ' รายการ')) +
      fact('หมายเหตุ', esc(b.note), true) +
      '</div></section>';

    // ---- ตารางรายการ (ลดคอลัมน์ให้พอดีกับพื้นที่)
    const reqBtn = (i) => (canRequest ? '<td><a class="btn small" href="#/request/new/' + b.id + '?item=' + i.id + '">ขอเบิก</a></td>' : '');
    let items;
    if (isCapex) {
      items = '<h2>รายการย่อย (Item No.)</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>รหัสรายการย่อย</th><th>รายการ</th><th class="num">งบ</th><th class="num">ใช้แล้ว</th><th class="num">รอตรวจสอบ</th><th class="num">คงเหลือ</th>' +
        (canRequest ? '<th></th>' : '') + '</tr></thead><tbody>' +
        b.items.map((i) => {
          const iu = usage(b, i.id);
          const orig = first.find((x) => x.code === i.code);
          const origNote = !orig ? '<div class="muted">เพิ่มภายหลัง</div>'
            : orig.total !== iu.approved ? '<div class="muted">เดิม ' + money(orig.total) + '</div>' : '';
          return '<tr><td class="nowrap">' + esc(i.code) + '</td><td>' + esc(i.name) +
            '<div class="muted">' + esc(i.assetType) + ' · DOA ' + esc(i.doa) + '</div></td>' +
            '<td class="num">' + money(iu.approved) + origNote + '</td><td class="num">' + money(iu.used) + '</td><td class="num">' + money(iu.reserved) +
            '</td><td class="num"><strong>' + moneyCell(iu.remaining) + '</strong></td>' + reqBtn(i) + '</tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      items = '<h2>Cost Breakdown Structure</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>รหัส</th><th>รายการ</th><th>GL</th><th class="num">งบ (รวม VAT)</th><th class="num">ใช้ไปสะสม</th><th class="num">คงเหลือ</th>' +
        (canRequest ? '<th></th>' : '') + '</tr></thead><tbody>' +
        sortedItems(b).map((i) => {
          const iu = usage(b, i.id);
          const leaf = isLeaf(b, i);
          const qty = leaf && (i.qty || i.unit) ? '<div class="muted">' + esc((i.qty ? Number(i.qty).toLocaleString('th-TH') : '') + ' ' + (i.unit || '')) + '</div>' : '';
          return '<tr class="' + (leaf ? '' : 'parent-row') + '"><td class="nowrap">' + esc(i.code) + '</td>' +
            '<td style="padding-left:' + (0.75 + depth(i) * 1.1) + 'rem">' + esc(i.name) + qty + '</td>' +
            '<td>' + (leaf && i.glCode ? esc(i.glCode) + '<div class="muted">' + esc(i.glName) + '</div>' : '') + '</td>' +
            '<td class="num">' + money(iu.approved) + '</td><td class="num">' + money(iu.used) + '</td>' +
            '<td class="num nowrap">' + moneyCell(iu.remaining) + (iu.remaining < 0 ? ' <span class="badge rejected">เกินงบ</span>' : '') + '</td>' +
            (canRequest ? (leaf ? reqBtn(i) : '<td></td>') : '') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }
    const main = facts + items + '<h2>ประวัติการขอเบิกใช้งบ <span class="muted count-note">(' + reqs.length + ')</span></h2>' + requestTable(reqs, false);

    // ---- คอลัมน์ขวา: ยอดคงเหลือ + ภาพรวมคำขอ + ประวัติการปรับงบ
    let side = '<div class="card total-card"><span class="muted">งบคงเหลือ</span>' +
      '<div class="total-amount' + (us.remaining < 0 ? ' neg' : '') + '">' + money(us.remaining) + ' <small>บาท</small></div>' +
      '<div style="margin:.75rem 0 .9rem">' + usageBar(us) + '</div>' +
      '<dl class="kv compact"><dt>งบที่ได้รับอนุมัติ</dt><dd>' + money(us.approved) + '</dd>' +
      '<dt>ใช้แล้ว (ออกเอกสาร)</dt><dd>' + money(us.used) + '</dd>' +
      '<dt>รอตรวจสอบ (จองไว้)</dt><dd>' + money(us.reserved) + '</dd></dl></div>';

    const count = (st) => reqs.filter((r) => r.status === st).length;
    const overItems = isCapex ? [] : leaves(b).filter((i) => usage(b, i.id).remaining < 0);
    const stat = (label, n, cls) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><strong>' + n + '</strong><span>' + label + '</span></div>';
    side += '<div class="card"><h3 class="side-title">ภาพรวมการขอเบิก</h3><div class="stats">' +
      stat('ออกเอกสารแล้ว', count('approved')) +
      (isCapex ? stat('รอการเงินตรวจสอบ', count('pending'), count('pending') ? 'warn' : '') : '') +
      stat('ไม่อนุมัติ / ยกเลิก', count('rejected') + count('cancelled')) +
      (isCapex
        ? stat('ค้างบันทึกงวดจ่าย', money(reqs.filter(needsPayment).reduce((s, r) => s + outstanding(r), 0)))
        : stat('รายการที่เกินงบ', overItems.length, overItems.length ? 'bad' : '')) +
      '</div></div>';

    const tl = (cls, title, sub, note) => '<li class="' + cls + '"><span class="tl-dot"></span><div><strong>' + title + '</strong>' +
      (sub ? '<div class="muted">' + sub + '</div>' : '') + (note ? '<div class="tl-note">' + esc(note) + '</div>' : '') + '</div></li>';
    side += '<div class="card"><h3 class="side-title">ประวัติการปรับงบ' + (isCapex ? '' : ' (Revise CBS)') + '</h3><ol class="timeline">' +
      b.revisions.slice().reverse().map((rv, idx, arr) => {
        const prevRv = arr[idx + 1];
        const diff = prevRv ? round2(rv.total - prevRv.total) : 0;
        return tl(rv.no === 0 ? 'done' : 'approved',
          (rv.no === 0 ? 'อนุมัติครั้งแรก' : 'ปรับครั้งที่ ' + rv.no) + ' · ' + money(rv.total) +
            (diff ? ' <span class="' + (diff > 0 ? 'pos' : 'neg') + '">(' + (diff > 0 ? '+' : '') + money(diff) + ')</span>' : ''),
          esc(userName(rv.by)) + ' · ' + fmtDate(rv.at), rv.note);
      }).join('') + '</ol></div>';

    return html + '<div class="detail-layout"><div class="detail-main">' + main + '</div><aside class="detail-side">' + side + '</aside></div>';
  }

  // ---------------------------------------------------------------- request form

  /** ตัวเลือกรายการ (เฉพาะรายการล่างสุด) พร้อมยอดคงเหลือ ไม่นับยอดที่คำขอนี้จองไว้เอง */
  function itemOptions(b, existing, selected, isCapex) {
    return sortedItems(b).filter((i) => isLeaf(b, i)).map((i) => {
      const own = existing && existing.status === 'pending' ? linesAmount(existing, [i.id]) : 0;
      const remaining = round2(usage(b, i.id).remaining + own);
      return '<option value="' + i.id + '" data-remaining="' + remaining + '"' + (i.id === selected ? ' selected' : '') +
        (isCapex && remaining <= 0 ? ' disabled' : '') + '>' +
        esc(i.code + ' ' + i.name) + ' — คงเหลือ ' + money(remaining) + ' บาท</option>';
    }).join('');
  }

  function lineRow(b, line, isCapex, existing) {
    const vat = line.vat === undefined ? isCapex : Number(line.vat) > 0;
    return '<tr class="line-row">' +
      '<td class="line-no"></td>' +
      (isCapex ? '' : '<td><div class="select-wrap"><select name="lnItem" aria-label="รายการต้นทุน"><option value="">— เลือก —</option>' +
        itemOptions(b, existing, line.itemId, false) + '</select></div></td>') +
      '<td><input name="lnDesc" value="' + esc(line.description || '') + '" aria-label="รายการ" placeholder="' +
      (isCapex ? 'เช่น เครื่องชั่งดิจิตอล ละเอียด 1 mg' : 'เช่น ค่าแรงดูแลกล้า 3 วัน @349') + '"></td>' +
      '<td><input name="lnAmount" type="number" min="0" step="0.01" class="right" value="' + esc(line.amountBeforeVat || '') + '" aria-label="ก่อน VAT"></td>' +
      '<td class="center"><input name="lnVat" type="checkbox"' + (vat ? ' checked' : '') + ' aria-label="VAT 7%"></td>' +
      '<td class="num ln-total">0.00</td>' +
      '<td><button type="button" class="btn small bad" data-remove-line title="ลบบรรทัด">×</button></td></tr>';
  }

  function viewRequestForm(budgetId, requestId, params) {
    const existing = requestId ? requestById(requestId) : null;
    if (requestId && !existing) return notFound();
    const b = budgetById(existing ? existing.budgetId : budgetId);
    if (!b) return notFound();
    const u = me();
    if (b.ownerId !== u.id) return '<div class="alert error">คุณไม่ใช่ผู้ขอใช้งบของงบนี้</div>';
    if (existing && existing.status !== 'rejected') return '<div class="alert error">แก้ไขได้เฉพาะคำขอที่ไม่ได้รับอนุมัติเท่านั้น</div>';
    const isCapex = b.type === 'CAPEX';
    const v = existing || { itemId: params.get('item') || '', expenseDate: today() };
    const lines = existing ? existing.lines : [{ itemId: isCapex ? '' : params.get('item') || '' }];
    const val = (k) => ' value="' + esc(v[k] == null ? '' : v[k]) + '"';
    const noPo = existing ? existing.poNo === 'N/A' : true;
    const field = (label, inner, extra) => '<label class="field"' + (extra || '') + '><span>' + label + '</span>' + inner + '</label>';
    const lastReject = existing ? existing.steps.find((s) => s.status === 'rejected') : null;

    return '<div class="page-head"><h1>' + (existing ? 'แก้ไขคำขอ ' + esc(existing.no) : 'จัดทำเอกสารขอเบิกใช้งบ') + '</h1></div>' +
      (lastReject ? '<div class="alert error">เหตุผลที่ไม่อนุมัติ: ' + esc(lastReject.comment) + '</div>' : '') +
      '<div class="alert info">' + badge(b.type, b.type) + ' ' + esc(b.code + ' ' + b.name) +
      ' · งบคงเหลือทั้งโครงการ <strong>' + moneyCell(usage(b).remaining) + '</strong> บาท<br>' +
      (isCapex
        ? 'ใบเบิก 1 ใบ ใช้กับรายการย่อยเดียว ใส่ได้หลายบรรทัด · ถ้าจ่ายเป็นงวด ให้ขอเบิกยอดเต็มครั้งเดียว แล้วการเงินจะบันทึกงวดจ่ายภายหลัง'
        : 'ใส่ได้หลายบรรทัด แต่ละบรรทัดเลือกรายการต้นทุนเองได้ · งบโครงการไม่ต้องผ่านฝ่ายการเงิน ได้เอกสารทันทีเมื่อบันทึก') + '</div>' +
      '<div id="formError"></div>' +
      '<form id="requestForm" class="card" data-budget="' + b.id + '" data-request="' + esc(requestId || '') + '">' +
      (isCapex
        ? field('รหัสรายการย่อย (Item No.)', '<div class="select-wrap"><select name="itemId" required><option value="">— เลือกรายการย่อย —</option>' +
            itemOptions(b, existing, v.itemId, true) + '</select></div>') +
          '<div id="itemHint" class="muted small-note"></div>' +
          field('วัตถุประสงค์ในการเบิกใช้', '<textarea name="purpose" required>' + esc(v.purpose || '') + '</textarea>') +
          field('ชื่อ Supplier (ผู้รับเงิน)', '<input name="payee" required' + val('payee') + '>')
        : '<div class="row">' +
          field('วันที่เบิก', '<input name="expenseDate" type="date" required' + val('expenseDate') + '>') +
          field('ชื่อเจ้าหนี้ / ผู้รับเงิน', '<input name="payee" required' + val('payee') + '>') +
          '</div>') +
      '<div class="row">' +
      field('เลขที่ PO', '<input name="poNo"' + (noPo ? ' value="" disabled' : val('poNo')) + '>') +
      '<label class="field check-field"><span>&nbsp;</span><span class="check"><input type="checkbox" name="noPo"' + (noPo ? ' checked' : '') + '> ' +
      (isCapex ? 'ไม่มี PO (N/A)' : 'ไม่ออก PO') + '</span></label>' +
      '</div>' +
      '<fieldset><legend>รายการที่ขอเบิก</legend>' +
      '<div class="table-wrap"><table class="edit-table lines-table"><thead><tr><th style="width:2.5rem">#</th>' +
      (isCapex ? '' : '<th style="width:30%">รายการต้นทุน (CBS)</th>') +
      '<th>' + (isCapex ? 'รายการที่ซื้อ / จ่าย' : 'รายละเอียด (ถ้ามีจำนวน โปรดระบุ)') + '</th>' +
      '<th class="num" style="width:9.5rem">ก่อน VAT</th><th style="width:4.5rem">VAT 7%</th><th class="num" style="width:9rem">รวม</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="lineRows">' + lines.map((l) => lineRow(b, l, isCapex, existing)).join('') + '</tbody>' +
      '<tfoot><tr><td colspan="' + (isCapex ? 2 : 3) + '" class="right"><button type="button" class="btn small" id="addLine">+ เพิ่มบรรทัด</button></td>' +
      '<td class="num" id="sumBefore">0.00</td><td class="num" id="sumVat">0.00</td><td class="num"><strong id="sumTotal">0.00</strong></td><td></td></tr></tfoot>' +
      '</table></div></fieldset>' +
      '<template id="lineTpl">' + lineRow(b, {}, isCapex, existing) + '</template>' +
      (isCapex ? planFieldset(existing && existing.paymentPlan) : '') +
      '<div id="overBudget" hidden>' +
      (isCapex ? '<div class="alert error" id="overText"></div>'
        : '<div class="alert warn" id="overText"></div>' +
          field('เหตุผลที่ใช้เกินงบ (จำเป็น)', '<textarea name="overBudgetReason">' + esc(v.overBudgetReason || '') + '</textarea>')) +
      '</div>' +
      '<div class="actions"><button class="btn primary" type="submit">' +
      (isCapex ? (existing ? 'ส่งเอกสารให้ฝ่ายการเงินอีกครั้ง' : 'ส่งเอกสารให้ฝ่ายการเงิน') : 'จัดทำเอกสาร') + '</button>' +
      '<a class="btn" href="' + (existing ? '#/request/' + existing.id : '#/budget/' + b.id) + '">ยกเลิก</a></div></form>';
  }

  function planRow(x) {
    return '<tr><td class="line-no"></td>' +
      '<td><input name="planPct" type="number" min="0.01" max="100" step="0.01" class="right" value="' + esc(x.pct || '') + '" aria-label="% ของยอดรวม"></td>' +
      '<td class="num plan-amt">0.00</td>' +
      '<td><input name="planNote" value="' + esc(x.note || '') + '" placeholder="เช่น เมื่อส่งมอบเครื่อง / หลังติดตั้งแล้วเสร็จ" aria-label="เงื่อนไขของงวด"></td>' +
      '<td><button type="button" class="btn small bad" data-remove-plan title="ลบงวด">×</button></td></tr>';
  }

  /** เงื่อนไขการจ่าย (CAPEX): จ่ายครั้งเดียว หรือแบ่งเป็นงวดตาม % */
  function planFieldset(plan) {
    const mode = plan && plan.mode === 'installments' ? 'installments' : 'single';
    const rows = mode === 'installments' ? plan.installments : [{}, {}];
    const opt2 = (value, title, sub) => '<label class="choice-opt"><input type="radio" name="payMode" value="' + value + '"' +
      (mode === value ? ' checked' : '') + '><span><strong>' + title + '</strong><small>' + sub + '</small></span></label>';
    return '<fieldset><legend>เงื่อนไขการจ่าย</legend><div class="choice">' +
      opt2('single', 'จ่ายครั้งเดียว', 'จ่ายเต็มจำนวนในงวดเดียว') +
      opt2('installments', 'แบ่งจ่ายเป็นงวด', 'กำหนด % ของแต่ละงวด รวมต้องได้ 100%') + '</div>' +
      '<div id="planBox"' + (mode === 'installments' ? '' : ' hidden') + '>' +
      '<div class="table-wrap"><table class="edit-table lines-table plan-table"><thead><tr><th style="width:3.5rem">งวด</th>' +
      '<th class="num" style="width:9rem">% ของยอดรวม</th><th class="num" style="width:10rem">ยอดโดยประมาณ</th><th>เงื่อนไขของงวด</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="planRows">' + rows.map(planRow).join('') + '</tbody>' +
      '<tfoot><tr><td class="right"><strong>รวม</strong></td><td class="num" id="planPctSum">0%</td><td class="num" id="planAmtSum">0.00</td>' +
      '<td><div class="plan-tools"><button type="button" class="btn small" id="addPlan">+ เพิ่มงวด</button><span class="muted">แบบสำเร็จรูป:</span>' +
      ['50,50', '40,60', '30,70', '30,40,30'].map((p) => '<button type="button" class="btn small" data-preset="' + p + '">' + p.replace(/,/g, '/') + '</button>').join('') +
      '</div></td><td></td></tr></tfoot></table></div></div>' +
      '<template id="planTpl">' + planRow({}) + '</template></fieldset>';
  }

  function readPlan(form) {
    if (!form.querySelector('[name="payMode"]')) return null;
    const mode = form.querySelector('[name="payMode"]:checked').value;
    if (mode !== 'installments') return { mode: 'single', installments: [] };
    return {
      mode,
      installments: Array.from(form.querySelectorAll('#planRows tr')).map((tr) => ({
        pct: round2(tr.querySelector('[name="planPct"]').value),
        note: tr.querySelector('[name="planNote"]').value.trim()
      })).filter((x) => x.pct || x.note)
    };
  }

  /** อ่านบรรทัดจากตาราง (ข้ามบรรทัดว่าง) */
  function readLines(form, isCapex) {
    return Array.from(form.querySelectorAll('#lineRows tr')).map((tr) => {
      const before = round2(tr.querySelector('[name="lnAmount"]').value);
      const vat = tr.querySelector('[name="lnVat"]').checked ? round2(before * VAT_RATE) : 0;
      return {
        tr,
        itemId: isCapex ? form.elements.itemId.value : tr.querySelector('[name="lnItem"]').value,
        description: tr.querySelector('[name="lnDesc"]').value.trim(),
        amountBeforeVat: before, vat, amount: round2(before + vat)
      };
    }).filter((l) => l.description || l.amountBeforeVat);
  }

  /** ยอดที่เกินคงเหลือ แยกตามรายการ: [{ item, remaining, amount }] */
  function overItems(form, b, lines, isCapex) {
    const remainingOf = (id) => {
      const sel = isCapex ? form.elements.itemId : form.querySelector('[name="lnItem"]');
      const o = sel && Array.from(sel.options).find((x) => x.value === id);
      return o ? Number(o.dataset.remaining) : 0;
    };
    const byItem = {};
    lines.forEach((l) => { if (l.itemId) byItem[l.itemId] = round2((byItem[l.itemId] || 0) + l.amount); });
    return Object.keys(byItem).map((id) => ({ item: itemById(b, id), remaining: remainingOf(id), amount: byItem[id] }))
      .filter((x) => x.amount > x.remaining);
  }

  function bindRequestForm() {
    const form = document.getElementById('requestForm');
    if (!form) return;
    const f = form.elements;
    const b = budgetById(form.dataset.budget);
    const isCapex = b.type === 'CAPEX';
    const existing = form.dataset.request ? requestById(form.dataset.request) : null;
    const tbody = document.getElementById('lineRows');

    const update = () => {
      let sb = 0;
      let sv = 0;
      Array.from(tbody.rows).forEach((tr, i) => {
        tr.querySelector('.line-no').textContent = i + 1;
        const before = round2(tr.querySelector('[name="lnAmount"]').value);
        const vat = tr.querySelector('[name="lnVat"]').checked ? round2(before * VAT_RATE) : 0;
        tr.querySelector('.ln-total').textContent = money(before + vat);
        sb += before;
        sv += vat;
      });
      document.getElementById('sumBefore').textContent = money(sb);
      document.getElementById('sumVat').textContent = money(sv);
      document.getElementById('sumTotal').textContent = money(sb + sv);
      f.poNo.disabled = f.noPo.checked;
      if (f.noPo.checked) f.poNo.value = '';
      if (isCapex) {
        const it = itemById(b, f.itemId.value);
        const o = f.itemId.selectedOptions[0];
        document.getElementById('itemHint').textContent = it
          ? 'ประเภทสินทรัพย์: ' + it.assetType + ' · หมวด DOA ' + it.doa + ' · คงเหลือ ' + money(o.dataset.remaining) + ' บาท' : '';
      }
      const over = overItems(form, b, readLines(form, isCapex), isCapex);
      document.getElementById('overBudget').hidden = !over.length;
      document.getElementById('overText').innerHTML = over.map((x) => esc(
        (x.item ? x.item.code + ' ' + x.item.name : '') + ': ขอเบิก ' + money(x.amount) + ' เกินคงเหลือ ' + money(x.remaining) +
        ' อยู่ ' + money(x.amount - x.remaining) + ' บาท')).join('<br>') +
        (isCapex ? '<br>ต้องขอให้การเงินปรับงบก่อน' : '<br>บันทึกได้ แต่ต้องระบุเหตุผล');
    };
    const planRows = document.getElementById('planRows');
    const updatePlan = () => {
      if (!planRows) return;
      const mode = form.querySelector('[name="payMode"]:checked').value;
      document.getElementById('planBox').hidden = mode !== 'installments';
      const total = round2(readLines(form, isCapex).reduce((s, l) => s + l.amount, 0));
      const pcts = Array.from(planRows.rows).map((tr) => tr.querySelector('[name="planPct"]').value);
      const amts = planAmounts(total, pcts);
      Array.from(planRows.rows).forEach((tr, i) => {
        tr.querySelector('.line-no').textContent = i + 1;
        tr.querySelector('.plan-amt').textContent = money(amts[i]);
      });
      const sumPct = round2(pcts.reduce((s, p) => s + Number(p || 0), 0));
      const sumEl = document.getElementById('planPctSum');
      sumEl.textContent = sumPct + '%';
      sumEl.className = 'num ' + (sumPct === 100 ? 'pos' : 'neg');
      document.getElementById('planAmtSum').textContent = money(amts.reduce((s, x) => s + x, 0));
    };
    if (planRows) {
      document.getElementById('addPlan').addEventListener('click', () => {
        planRows.insertAdjacentHTML('beforeend', document.getElementById('planTpl').innerHTML);
        updatePlan();
      });
      form.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
        const pcts = btn.dataset.preset.split(',');
        const notes = Array.from(planRows.rows).map((tr) => tr.querySelector('[name="planNote"]').value);
        planRows.innerHTML = pcts.map((p, i) => planRow({ pct: p, note: notes[i] || '' })).join('');
        updatePlan();
      }));
      planRows.addEventListener('click', (e) => {
        if (e.target.matches('[data-remove-plan]') && planRows.rows.length > 1) {
          e.target.closest('tr').remove();
          updatePlan();
        }
      });
    }
    form.addEventListener('input', () => { update(); updatePlan(); });
    form.addEventListener('change', () => { update(); updatePlan(); });
    updatePlan();
    document.getElementById('addLine').addEventListener('click', () => {
      tbody.insertAdjacentHTML('beforeend', document.getElementById('lineTpl').innerHTML);
      // บรรทัดใหม่ของ CBS ใช้รายการต้นทุนเดียวกับบรรทัดก่อนหน้าเป็นค่าเริ่มต้น
      if (!isCapex && tbody.rows.length > 1) {
        tbody.rows[tbody.rows.length - 1].querySelector('[name="lnItem"]').value = tbody.rows[tbody.rows.length - 2].querySelector('[name="lnItem"]').value;
      }
      tbody.rows[tbody.rows.length - 1].querySelector('[name="lnDesc"]').focus();
      update();
    });
    tbody.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-line]') && tbody.rows.length > 1) {
        e.target.closest('tr').remove();
        update();
      }
    });
    update();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const lines = readLines(form, isCapex);
      const errors = [];
      if (isCapex && !f.itemId.value) errors.push('กรุณาเลือกรายการย่อย');
      if (!lines.length) errors.push('กรุณาใส่รายการที่ขอเบิกอย่างน้อย 1 บรรทัด');
      lines.forEach((l, i) => {
        const no = 'บรรทัดที่ ' + (Array.from(tbody.rows).indexOf(l.tr) + 1) + ': ';
        if (!isCapex && !l.itemId) errors.push(no + 'กรุณาเลือกรายการต้นทุน');
        if (!l.description) errors.push(no + 'กรุณาระบุรายการ');
        if (!(l.amountBeforeVat > 0)) errors.push(no + 'จำนวนเงินต้องมากกว่า 0');
      });
      if (!f.noPo.checked && !f.poNo.value.trim()) errors.push('กรุณาระบุเลขที่ PO หรือเลือก "' + (isCapex ? 'ไม่มี PO' : 'ไม่ออก PO') + '"');
      const plan = readPlan(form);
      if (plan && plan.mode === 'installments') {
        const sumPct = round2(plan.installments.reduce((s, x) => s + x.pct, 0));
        if (plan.installments.length < 2) errors.push('แบ่งจ่ายเป็นงวดต้องมีอย่างน้อย 2 งวด');
        if (plan.installments.some((x) => !(x.pct > 0))) errors.push('กรุณาระบุ % ของทุกงวด');
        if (sumPct !== 100) errors.push('เปอร์เซ็นต์รวมของทุกงวดต้องเท่ากับ 100% (ตอนนี้ ' + sumPct + '%)');
      }
      const over = overItems(form, b, lines, isCapex);
      if (over.length && isCapex) errors.push('จำนวนเงินรวมเกินงบคงเหลือของรายการย่อยนี้ (คงเหลือ ' + money(over[0].remaining) + ' บาท)');
      if (over.length && !isCapex && !f.overBudgetReason.value.trim()) errors.push('กรุณาระบุเหตุผลที่ใช้เกินงบ');
      if (errors.length) { showErrors(errors); return; }

      const now = new Date().toISOString();
      const clean = lines.map((l) => ({ itemId: l.itemId, description: l.description, amountBeforeVat: l.amountBeforeVat, vat: l.vat, amount: l.amount }));
      const fields = {
        itemId: isCapex ? f.itemId.value : null,
        lines: clean,
        payee: f.payee.value.trim(),
        poNo: f.noPo.checked ? 'N/A' : f.poNo.value.trim(),
        amountBeforeVat: round2(clean.reduce((s, l) => s + l.amountBeforeVat, 0)),
        vat: round2(clean.reduce((s, l) => s + l.vat, 0)),
        amount: round2(clean.reduce((s, l) => s + l.amount, 0))
      };
      if (isCapex) {
        fields.purpose = f.purpose.value.trim();
        fields.paymentPlan = plan;
        fields.paymentTerms = planText({ paymentPlan: plan });
        fields.payments = [];
      } else {
        fields.expenseDate = f.expenseDate.value;
        fields.overBudget = over.length > 0;
        fields.overBudgetReason = over.length ? f.overBudgetReason.value.trim() : '';
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
        setFlash('success', 'จัดทำเอกสารเรียบร้อย เลขที่ ' + r.docNo + (r.overBudget ? ' (ใช้เกินงบ — บันทึกเหตุผลแล้ว)' : ''));
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
      // GL ตั้งต้นจากรายการต้นทุน บัญชีแก้ไขได้ภายหลัง
      r.lines.forEach((l) => {
        const it = itemById(b, l.itemId) || {};
        l.glCode = it.glCode || '';
        l.glName = it.glName || '';
      });
      r.accounting = { paymentStatus: 'รอจ่าย' };
    }
  }

  // ---------------------------------------------------------------- request lists

  function itemCodesCell(b, r) {
    const items = reqItemIds(r).map((id) => itemById(b, id)).filter(Boolean);
    if (!items.length) return '-';
    if (items.length === 1) return '<span class="nowrap">' + esc(items[0].code) + '</span><div class="muted">' + esc(items[0].name) + '</div>';
    return esc(items.map((i) => i.code).join(', ')) + '<div class="muted">' + items.length + ' รายการต้นทุน</div>';
  }

  function requestTable(list, showBudget) {
    if (!list.length) return '<div class="card empty">ยังไม่มีคำขอเบิกใช้งบ</div>';
    list = list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return '<div class="table-wrap"><table><thead><tr><th>เลขที่คำขอ</th>' +
      (showBudget ? '<th>งบ</th>' : '') +
      '<th>รายการ</th><th>รายการเบิก</th><th>ผู้ขอ</th><th class="num">จำนวนเงิน</th><th>สถานะ</th><th>เอกสาร</th></tr></thead><tbody>' +
      list.map((r) => {
        const b = budgetById(r.budgetId);
        const step = currentStep(r);
        return '<tr><td class="nowrap"><a href="#/request/' + r.id + '">' + esc(r.no) + '</a><div class="muted">' + fmtDate(r.createdAt) + '</div></td>' +
          (showBudget ? '<td>' + badge(r.type, r.type) + ' ' + esc(b ? b.code : '-') + '</td>' : '') +
          '<td>' + itemCodesCell(b, r) + '</td>' +
          '<td>' + esc(reqSummary(r)) + (r.overBudget ? ' <span class="badge rejected">เกินงบ</span>' : '') + '</td>' +
          '<td class="nowrap">' + esc(userName(r.requesterId)) + '</td>' +
          '<td class="num">' + money(r.amount) +
          (r.type === 'CAPEX' && r.status === 'approved' ? '<div class="muted">บันทึกจ่าย ' + money(paidTotal(r)) + '</div>' : '') + '</td>' +
          '<td>' + badge(r.status, STATUS_LABEL[r.status]) +
          (step ? '<div class="muted">รอ: ' + esc(stepAssigneeText(step)) + '</div>' : '') + '</td>' +
          '<td class="nowrap">' + (!r.docNo ? '-' : r.status === 'cancelled' ? '<s>' + esc(r.docNo) + '</s> <span class="muted">(ยกเลิก)</span>'
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
      '<p class="muted">CAPEX: งวดจ่ายที่การเงินบันทึกแล้วแต่ยังไม่ได้แยก Asset / Expenses · CBS: เอกสารที่ยังไม่ได้ยืนยัน GL Code และสถานะจ่าย</p>' +
      requestTable(db.requests.filter(needsAccounting), true);
  }

  function viewPayments() {
    if (me().role !== 'finance') return '<div class="alert error">เฉพาะฝ่ายการเงิน</div>';
    const list = db.requests.filter(needsPayment).sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
    let html = '<div class="page-head"><h1>งวดจ่ายค้าง (CAPEX)</h1></div>' + takeFlash() +
      '<p class="muted">ใบเบิกที่อนุมัติแล้ว แต่ยังบันทึกงวดจ่ายไม่ครบยอด — เปิดใบเบิกเพื่อบันทึกงวดเมื่อได้รับบิล</p>';
    if (!list.length) return html + '<div class="card empty">ไม่มีงวดจ่ายค้าง</div>';
    return html + '<div class="table-wrap"><table><thead><tr><th>ใบเบิก</th><th>งบ / รายการย่อย</th><th>Supplier</th><th>เงื่อนไขการจ่าย</th>' +
      '<th class="num">ยอดเบิก</th><th class="num">บันทึกจ่ายแล้ว</th><th class="num">ค้างจ่าย</th></tr></thead><tbody>' +
      list.map((r) => {
        const b = budgetById(r.budgetId);
        return '<tr><td class="nowrap"><a href="#/request/' + r.id + '">' + esc(r.docNo) + '</a><div class="muted">' + fmtDay(r.approvedAt) + '</div></td>' +
          '<td>' + esc(b.code) + '<div class="muted">' + itemCodesCell(b, r) + '</div></td><td>' + esc(r.payee) + '</td><td>' + esc(planText(r) || '-') + '</td>' +
          '<td class="num">' + money(r.amount) + '</td><td class="num">' + money(paidTotal(r)) + '</td><td class="num"><strong>' + money(outstanding(r)) + '</strong></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ---------------------------------------------------------------- request detail

  function linesTable(b, r, withGl) {
    const isCapex = r.type === 'CAPEX';
    return '<div class="table-wrap"><table><thead><tr><th style="width:2.5rem">#</th>' +
      (isCapex ? '' : '<th>รายการต้นทุน</th>') + (withGl ? '<th>GL</th>' : '') +
      '<th>' + (isCapex ? 'รายการที่ซื้อ / จ่าย' : 'รายละเอียด') + '</th><th class="num">ก่อน VAT</th><th class="num">VAT 7%</th><th class="num">รวม</th></tr></thead><tbody>' +
      r.lines.map((l, i) => {
        const it = itemById(b, l.itemId) || {};
        return '<tr><td>' + (i + 1) + '</td>' +
          (isCapex ? '' : '<td>' + esc(it.code) + '<div class="muted">' + esc(it.name) + '</div></td>') +
          (withGl ? '<td>' + esc(l.glCode || '-') + '<div class="muted">' + esc(l.glName || '') + '</div></td>' : '') +
          '<td>' + esc(l.description) + '</td><td class="num">' + money(l.amountBeforeVat) + '</td><td class="num">' + money(l.vat) +
          '</td><td class="num">' + money(l.amount) + '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="' + (2 + (isCapex ? 0 : 1) + (withGl ? 1 : 0)) + '" class="right"><strong>รวม</strong></td>' +
      '<td class="num">' + money(r.amountBeforeVat) + '</td><td class="num">' + money(r.vat) + '</td><td class="num"><strong>' + money(r.amount) + '</strong></td></tr></tfoot></table></div>';
  }

  function viewRequestDetail(id) {
    const r = requestById(id);
    if (!r) return notFound();
    const b = budgetById(r.budgetId);
    const u = me();
    const step = currentStep(r);
    const isCapex = r.type === 'CAPEX';
    const item = isCapex ? itemById(b, r.itemId) : null;
    const isOwner = r.requesterId === u.id;

    // ---- ปุ่มคำสั่งของหน้า (อยู่บนหัวหน้า เห็นได้ทันที)
    const actions = [];
    if (r.docNo && r.status === 'approved') actions.push('<a class="btn primary" href="#/doc/' + r.id + '">เปิดเอกสาร ' + esc(r.docNo) + '</a>');
    if (r.status === 'rejected' && isOwner) actions.push('<a class="btn primary" href="#/request/' + r.id + '/edit">แก้ไขและส่งใหม่</a>');
    if ((r.status === 'pending' || r.status === 'rejected') && isOwner) {
      actions.push('<button class="btn bad" id="cancelRequest" data-id="' + r.id + '">ยกเลิกคำขอ</button>');
    }
    // CBS ไม่ผ่านการเงิน ผู้ขอจึงยกเลิกเอกสารที่ออกแล้วเองได้ (เช่น เลือกตัวงบหรือยอดผิด)
    if (r.type === 'CBS' && r.status === 'approved' && isOwner) {
      actions.push('<button class="btn bad" id="cancelRequest" data-id="' + r.id + '" title="ยกเลิกแล้วยอดจะคืนเข้างบ และเลขที่เอกสารนี้ใช้แนบขอซื้อไม่ได้อีก">ยกเลิกเอกสาร</button>');
    }

    let html = '<div class="page-head detail-head"><div>' +
      '<div class="eyebrow">คำขอเบิกใช้งบ · ' + badge(b.type, b.type) + ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a> ' + esc(b.name) + '</div>' +
      '<h1>' + esc(r.no) + ' ' + badge(r.status, STATUS_LABEL[r.status]) + '</h1></div>' +
      (actions.length ? '<div class="head-actions">' + actions.join('') + '</div>' : '') + '</div>' + takeFlash();

    if (r.status === 'cancelled') {
      html += '<div class="alert error">ยกเลิกโดย ' + esc(userName(r.cancelledBy || r.requesterId)) + ' เมื่อ ' + fmtDate(r.cancelledAt) +
        (r.docNo ? ' · เอกสารเลขที่ ' + esc(r.docNo) + ' ใช้ไม่ได้แล้ว และคืนยอดเข้างบเรียบร้อย' : '') +
        (r.cancelReason ? '<br>เหตุผล: ' + esc(r.cancelReason) : '') + '</div>';
    }
    if (r.overBudget) html += '<div class="alert warn">ใช้เกินงบของรายการต้นทุน · เหตุผล: ' + esc(r.overBudgetReason) + '</div>';

    // ---- ข้อมูลหลักแบบตาราง (ประหยัดพื้นที่)
    const fact = (label, value, wide) => (value || value === 0
      ? '<div class="fact' + (wide ? ' wide' : '') + '"><span>' + label + '</span><strong>' + value + '</strong></div>' : '');
    const facts = '<section class="card"><div class="facts">' +
      (isCapex ? fact('รายการย่อย', item ? esc(item.code) + '<small>' + esc(item.name) + '</small>' : '-') : '') +
      fact('ผู้ขอ', esc(userName(r.requesterId)) + '<small>' + esc(b.department) + '</small>') +
      fact(isCapex ? 'วันที่ขอ' : 'วันที่เบิก', isCapex ? fmtDate(r.createdAt) : fmtDay(r.expenseDate)) +
      fact(isCapex ? 'Supplier (ผู้รับเงิน)' : 'ผู้รับเงิน', esc(r.payee)) +
      fact('PO No.', esc(r.poNo)) +
      (isCapex ? fact('เงื่อนไขการจ่าย', esc(planText(r))) : '') +
      (isCapex ? fact('วัตถุประสงค์', esc(r.purpose), true) : '') +
      '</div></section>';

    // ---- คอลัมน์ขวา: ยอดเงิน + สถานะ + ฟอร์มตัดสินใจ
    let side = '<div class="card total-card"><span class="muted">รวมจำนวนเงิน</span>' +
      '<div class="total-amount">' + money(r.amount) + ' <small>บาท</small></div>' +
      '<div class="total-split"><span>ก่อน VAT ' + money(r.amountBeforeVat) + '</span><span>VAT ' + money(r.vat) + '</span><span>' + r.lines.length + ' บรรทัด</span></div>';
    if (isCapex && r.status === 'approved') {
      const paid = paidTotal(r);
      const pct = r.amount > 0 ? Math.min(100, (paid / r.amount) * 100) : 0;
      side += '<div class="paid-bar"><div class="bar"><div class="used" style="width:' + pct + '%;background:var(--ok)"></div></div>' +
        '<div class="muted small-note" style="margin:.4rem 0 0">บันทึกงวดจ่ายแล้ว ' + money(paid) + ' · ค้าง ' + money(outstanding(r)) + '</div></div>';
    }
    side += '</div>';

    const tl = (cls, title, sub, note) => '<li class="' + cls + '"><span class="tl-dot"></span><div><strong>' + title + '</strong>' +
      (sub ? '<div class="muted">' + sub + '</div>' : '') + (note ? '<div class="tl-note">“' + esc(note) + '”</div>' : '') + '</div></li>';
    const stepLi = (s) => tl(s.status === 'waiting' ? (s === step ? 'current' : '') : s.status,
      esc(s.label) + (s.status === 'rejected' ? ' — ไม่อนุมัติ' : ''),
      s.by ? esc(userName(s.by)) + ' · ' + fmtDate(s.at) : s === step ? 'กำลังรอ ' + esc(stepAssigneeText(s)) : esc(stepAssigneeText(s)),
      s.comment);
    let timeline = tl('done', 'ส่งคำขอ', esc(userName(r.requesterId)) + ' · ' + fmtDate(r.createdAt));
    if (r.history && r.history.length) {
      timeline += r.history.map(stepLi).join('') + tl('done', 'แก้ไขและส่งใหม่', fmtDate(r.resubmittedAt));
    }
    timeline += r.steps.map(stepLi).join('');
    if (!r.steps.length && r.approvedAt) timeline += tl('approved', 'ออกเอกสารทันที (CBS ไม่ผ่านการเงิน)', fmtDate(r.approvedAt));
    else if (r.status === 'approved') timeline += tl('approved', 'ออกเอกสาร ' + esc(r.docNo), fmtDate(r.approvedAt));
    if (r.status === 'cancelled') timeline += tl('rejected', 'ยกเลิก', esc(userName(r.cancelledBy || r.requesterId)) + ' · ' + fmtDate(r.cancelledAt));

    side += '<div class="card"><h3 class="side-title">สถานะ</h3><ol class="timeline">' + timeline + '</ol>';
    if (canAct(u, step)) {
      side += '<form id="decisionForm" class="decision" data-id="' + r.id + '">' +
        '<label class="field"><span>เหตุผล (จำเป็นเมื่อไม่อนุมัติ)</span><textarea name="comment" rows="2" placeholder="เช่น ควรใช้งบตัวไหนแทน"></textarea></label>' +
        '<div class="decision-actions"><button class="btn ok" type="submit" data-decision="approved">อนุมัติเอกสาร</button>' +
        '<button class="btn bad" type="submit" data-decision="rejected">ไม่อนุมัติ</button></div></form>';
    }
    side += '</div>';

    let main = facts + '<h2>รายการที่ขอเบิก</h2>' + linesTable(b, r, false);
    if (r.status === 'approved') main += isCapex ? paymentsPanel(r, u) : cbsAccountingPanel(b, r, u);

    return html + '<div class="detail-layout"><div class="detail-main">' + main + '</div><aside class="detail-side">' + side + '</aside></div>';
  }

  /** งวดจ่ายของใบเบิก CAPEX: การเงินบันทึกงวด (วันวางบิล/กำหนดจ่าย/ยอด) และบัญชีแยก Asset/Expenses รายงวด */
  function paymentsPanel(r, u) {
    const pays = r.payments || [];
    const canFin = u.role === 'finance';
    const canAcc = u.role === 'accounting';
    const left = outstanding(r);
    let html = '<h2>งวดการจ่ายเงิน' + (needsAccounting(r) ? ' <span class="badge pending">รอบัญชีแยก Asset/Expenses</span>' : '') + '</h2>' +
      '<div class="card">';
    const plan = isInstallments(r) ? r.paymentPlan.installments : null;
    const planAmts = plan ? planAmounts(r.amount, plan.map((x) => x.pct)) : [];
    if (plan) {
      html += '<div class="plan-list"><div class="muted small-note" style="margin:0 0 .5rem">แผนการจ่ายตามใบเบิก</div><ol>' +
        plan.map((x, i) => {
          const st = i < pays.length ? '<span class="badge approved">บันทึกแล้ว</span>' : i === pays.length ? '<span class="badge pending">งวดถัดไป</span>' : '';
          return '<li><strong>งวดที่ ' + (i + 1) + ' · ' + x.pct + '%</strong><span class="num-cell">' + money(planAmts[i]) + '</span>' +
            '<span class="muted">' + esc(x.note || '') + '</span>' + st + '</li>';
        }).join('') + '</ol></div>';
    } else if (r.paymentPlan) {
      html += '<p class="muted small-note" style="margin:0 0 .75rem">แผนการจ่าย: จ่ายครั้งเดียว ' + money(r.amount) + ' บาท</p>';
    }

    if (pays.length) {
      html += '<form id="acctForm" data-id="' + r.id + '"><div class="table-wrap"><table class="edit-table pay-table"><thead><tr><th>งวด</th><th>วางบิล</th><th>กำหนดจ่าย</th>' +
        '<th class="num">ก่อน VAT</th><th class="num">VAT</th><th class="num">รวม</th><th class="num" style="width:9rem">Asset (บัญชี)</th><th class="num" style="width:9rem">Expenses (บัญชี)</th>' +
        (canFin ? '<th></th>' : '') + '</tr></thead><tbody>' +
        pays.map((p) => {
          const accCell = (name, v) => canAcc
            ? '<input name="' + name + '-' + p.id + '" type="number" min="0" step="0.01" class="right" value="' + esc(v == null ? '' : v) + '">'
            : (v == null ? '<span class="muted">-</span>' : money(v));
          return '<tr><td title="บันทึกโดย ' + esc(userName(p.by)) + '">' + esc(p.label) + '</td><td>' + fmtDay(p.deliveryDate) + '</td><td>' + fmtDay(p.dueDate) + '</td>' +
            '<td class="num">' + money(p.amountBeforeVat) + '</td><td class="num">' + money(p.vat) + '</td><td class="num">' + money(p.amount) + '</td>' +
            '<td class="num">' + accCell('asset', p.asset) + '</td><td class="num">' + accCell('expense', p.expense) + '</td>' +
            (canFin ? '<td>' + (p.acctAt ? '' : '<button type="button" class="btn small bad" data-del-pay="' + p.id + '" title="ลบงวด">×</button>') + '</td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div>' +
        (canAcc ? '<div class="actions"><button class="btn primary" type="submit">บันทึกข้อมูลบัญชี</button></div>' : '') + '</form>';
    } else {
      html += '<p class="muted">ยังไม่มีการบันทึกงวดจ่าย</p>';
    }

    if (canFin && left > 0) {
      const nextNo = pays.length + 1;
      // เติมชื่องวดและยอดตามแผนให้ล่วงหน้า (งวดสุดท้าย / จ่ายครั้งเดียว ใช้ยอดค้างทั้งหมดเพื่อไม่ให้คลาดจากการปัดเศษ)
      const next = plan ? plan[pays.length] : null;
      let label = 'งวดที่ ' + nextNo;
      let prefill = '';
      let rest = false;
      if (next) {
        label = 'งวดที่ ' + nextNo + ' (' + next.pct + '%)' + (next.note ? ' ' + next.note : '');
        rest = pays.length === plan.length - 1;
        prefill = rest ? '' : round2(r.amountBeforeVat * next.pct / 100);
      } else if (r.paymentPlan && !plan) {
        label = 'จ่ายครั้งเดียว';
        rest = true;
      }
      html += '<form id="payForm" class="pay-form" data-id="' + r.id + '"' + (rest ? ' data-rest="1"' : '') + '><h3>บันทึกงวดจ่าย</h3><div class="row">' +
        '<label class="field"><span>งวด</span><input name="label" value="' + esc(label) + '"></label>' +
        '<label class="field"><span>วันที่ส่งมอบ / วางบิล</span><input name="deliveryDate" type="date"></label>' +
        '<label class="field"><span>วันที่กำหนดจ่ายเงิน</span><input name="dueDate" type="date" required></label>' +
        '</div><div class="row">' +
        '<label class="field"><span>ก่อน VAT (บาท)</span><input name="amountBeforeVat" type="number" min="0.01" step="0.01" required value="' + prefill + '"></label>' +
        '<label class="field check-field"><span>&nbsp;</span><span class="check"><input type="checkbox" name="hasVat"' + (r.vat > 0 ? ' checked' : '') + '> มี VAT 7%</span></label>' +
        '<div class="field"><span>รวมงวดนี้</span><output id="payTotal" class="out strong">0.00</output></div>' +
        '<div class="field"><span>ค้างบันทึก</span><output class="out">' + money(left) + '</output></div>' +
        '</div><div class="actions" style="margin-top:0"><button class="btn primary" type="submit">+ บันทึกงวด</button>' +
        '<button type="button" class="btn" id="payRest">ใส่ยอดที่เหลือทั้งหมด</button></div></form>';
    }
    return html + '</div>';
  }

  /** CBS: บัญชียืนยัน GL รายบรรทัด และสถานะจ่ายของทั้งใบ */
  function cbsAccountingPanel(b, r, u) {
    const canAcc = u.role === 'accounting';
    const acc = r.accounting || {};
    if (!canAcc) {
      return '<h2>ข้อมูลบัญชี' + (needsAccounting(r) ? ' <span class="badge pending">รอบัญชีบันทึก</span>' : '') + '</h2>' +
        linesTable(b, r, true) + '<p class="muted small-note" style="margin-top:.6rem">สถานะการจ่ายเงิน: <strong>' + esc(acc.paymentStatus || 'รอจ่าย') + '</strong>' +
        (acc.updatedAt ? ' · บัญชีบันทึกล่าสุดโดย ' + esc(userName(acc.updatedBy)) + ' เมื่อ ' + fmtDate(acc.updatedAt) : '') + '</p>';
    }
    return '<h2>ข้อมูลบัญชี</h2><form id="acctForm" class="card" data-id="' + r.id + '">' +
      '<div class="table-wrap"><table class="edit-table"><thead><tr><th>#</th><th>รายการต้นทุน</th><th>รายละเอียด</th><th class="num">รวม</th>' +
      '<th style="width:9rem">GL Code</th><th style="width:13rem">GL Name</th></tr></thead><tbody>' +
      r.lines.map((l, i) => {
        const it = itemById(b, l.itemId) || {};
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(it.code + ' ' + it.name) + '</td><td>' + esc(l.description) + '</td><td class="num">' + money(l.amount) + '</td>' +
          '<td><input name="gl-' + i + '" value="' + esc(l.glCode || '') + '"></td><td><input name="gln-' + i + '" value="' + esc(l.glName || '') + '"></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="row" style="margin-top:1rem"><label class="field"><span>สถานะการจ่ายเงิน</span><div class="select-wrap"><select name="paymentStatus">' +
      ['รอจ่าย', 'จ่ายแล้ว'].map((s) => opt(s, s, acc.paymentStatus || 'รอจ่าย')).join('') + '</select></div></label></div>' +
      (acc.updatedAt ? '<p class="muted small-note">บันทึกล่าสุดโดย ' + esc(userName(acc.updatedBy)) + ' เมื่อ ' + fmtDate(acc.updatedAt) + '</p>' : '') +
      '<div class="actions" style="margin-top:0"><button class="btn primary" type="submit">บันทึกข้อมูลบัญชี</button></div></form>';
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
          issueDocument(r, b, step.at);
          setFlash('success', 'อนุมัติเอกสารแล้ว ออกใบเบิกงบประมาณเลขที่ ' + r.docNo);
        }
        save();
        go('#/request/' + r.id);
      });
    }

    const pay = document.getElementById('payForm');
    if (pay) {
      const r = requestById(pay.dataset.id);
      const f = pay.elements;
      // restMode: กด "ใส่ยอดที่เหลือทั้งหมด" แล้ว ให้ VAT = ยอดค้าง - ก่อน VAT เพื่อให้ยอดรวมตรงกับยอดค้างพอดี (ไม่คลาดจากการปัดเศษ)
      let restMode = false;
      const calc = () => {
        const before = round2(f.amountBeforeVat.value);
        let vat = f.hasVat.checked ? round2(before * VAT_RATE) : 0;
        if (restMode && f.hasVat.checked) vat = round2(outstanding(r) - before);
        document.getElementById('payTotal').textContent = money(before + vat);
        return { before, vat, total: round2(before + vat) };
      };
      // แก้ยอดหรือ VAT เองเมื่อไร ค่อยเลิกใช้ยอดค้างทั้งหมด (กรอกวันที่ไม่กระทบ)
      const onEdit = (e) => {
        if (e.target.name === 'amountBeforeVat' || e.target.name === 'hasVat') restMode = false;
        calc();
      };
      pay.addEventListener('input', onEdit);
      pay.addEventListener('change', onEdit);
      const fillRest = () => {
        const left = outstanding(r);
        f.amountBeforeVat.value = f.hasVat.checked ? round2(left / (1 + VAT_RATE)) : left;
        restMode = true;
        calc();
      };
      document.getElementById('payRest').addEventListener('click', fillRest);
      if (pay.dataset.rest === '1') fillRest();
      else calc();
      pay.addEventListener('submit', (e) => {
        e.preventDefault();
        const c = calc();
        const left = outstanding(r);
        if (!(c.before > 0)) { alert('จำนวนเงินต้องมากกว่า 0'); return; }
        if (c.total > left + 0.005) { alert('ยอดงวดนี้ (' + money(c.total) + ') เกินยอดค้างบันทึก ' + money(left) + ' บาท'); return; }
        if (!f.dueDate.value) { alert('กรุณาระบุวันที่กำหนดจ่ายเงิน'); return; }
        r.payments = r.payments || [];
        r.payments.push({
          id: nextId('p'), no: r.payments.length + 1, label: f.label.value.trim() || 'งวดที่ ' + (r.payments.length + 1),
          deliveryDate: f.deliveryDate.value, dueDate: f.dueDate.value,
          amountBeforeVat: c.before, vat: c.vat, amount: c.total, at: new Date().toISOString(), by: me().id
        });
        save();
        setFlash('success', 'บันทึก' + r.payments[r.payments.length - 1].label + ' ' + money(c.total) + ' บาทแล้ว · ค้างบันทึก ' + money(outstanding(r)) + ' บาท');
        go('#/request/' + r.id);
      });
    }

    const acct = document.getElementById('acctForm');
    if (acct) {
      acct.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del-pay]');
        if (!del) return;
        const r = requestById(acct.dataset.id);
        if (!confirm('ลบงวดนี้?')) return;
        r.payments = r.payments.filter((p) => p.id !== del.dataset.delPay);
        save();
        setFlash('info', 'ลบงวดจ่ายแล้ว');
        go('#/request/' + r.id);
      });
      acct.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = requestById(acct.dataset.id);
        const f = acct.elements;
        const u = me();
        if (u.role !== 'accounting') return;
        const now = new Date().toISOString();
        if (r.type === 'CAPEX') {
          const errors = [];
          const updates = [];
          r.payments.forEach((p) => {
            const a = f['asset-' + p.id].value;
            const x = f['expense-' + p.id].value;
            if (a === '' && x === '') return;
            const asset = round2(a);
            const expense = round2(x);
            if (asset + expense > p.amount + 0.005) errors.push(p.label + ': Asset + Expenses (' + money(asset + expense) + ') เกินยอดงวด ' + money(p.amount));
            else if (!(asset + expense > 0)) errors.push(p.label + ': กรุณาระบุมูลค่า Asset และ/หรือ Expenses');
            else updates.push([p, asset, expense]);
          });
          if (errors.length) { alert(errors.join('\n')); return; }
          if (!updates.length) { alert('ยังไม่ได้กรอกข้อมูล Asset / Expenses'); return; }
          updates.forEach(([p, asset, expense]) => Object.assign(p, { asset, expense, acctAt: now, acctBy: u.id }));
          setFlash('success', 'บันทึกข้อมูลบัญชีของ ' + r.docNo + ' แล้ว (' + updates.length + ' งวด)');
        } else {
          r.lines.forEach((l, i) => {
            l.glCode = f['gl-' + i].value.trim();
            l.glName = f['gln-' + i].value.trim();
          });
          r.accounting = { paymentStatus: f.paymentStatus.value, updatedAt: now, updatedBy: u.id };
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

  /** ยอด ณ วันที่ออกเอกสาร ของทั้งโครงการ (ids = null) หรือของรายการที่ระบุ: งบ / ใช้ก่อนหน้า / ครั้งนี้ / คงเหลือ */
  function balanceAt(r, b, ids) {
    const approved = ids ? round2(b.items.filter((x) => ids.includes(x.id)).reduce((s, x) => s + itemTotal(x), 0)) : budgetTotal(b);
    const before = round2(db.requests
      .filter((x) => x.budgetId === b.id && x.id !== r.id && x.status === 'approved' && x.approvedAt <= r.approvedAt)
      .reduce((s, x) => s + linesAmount(x, ids), 0));
    const now = linesAmount(r, ids);
    return { approved, before, now, after: round2(approved - before - now) };
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
    const isCapex = r.type === 'CAPEX';
    const item = isCapex ? itemById(b, r.itemId) || {} : null;
    const proj = balanceAt(r, b, null);
    const tr = (k, v) => '<tr><th style="width:34%">' + k + '</th><td>' + v + '</td></tr>';
    const balanceTable = (title, bal) => '<table><thead><tr><th colspan="2">' + title + '</th></tr></thead><tbody>' +
      tr('จำนวนเงินงบประมาณ (รวม VAT)', '<span class="num-cell">' + money(bal.approved) + ' บาท</span>') +
      tr('ใช้งบประมาณไปแล้วก่อนการขอเบิก', '<span class="num-cell">' + money(bal.before) + ' บาท</span>') +
      tr('จำนวนงบประมาณที่ขอเบิกครั้งนี้ (รวม VAT)', '<span class="num-cell"><strong>' + money(bal.now) + ' บาท</strong></span>') +
      tr('งบประมาณคงเหลือ (หลังเบิกครั้งนี้)', '<span class="num-cell">' + moneyCell(bal.after) + ' บาท</span>') + '</tbody></table>';

    const head = '<header><div><h1>' + esc(COMPANIES[b.company] || b.company) + '</h1><div class="doc-sub">' +
      (isCapex ? 'ใบเบิกงบประมาณ (งบลงทุน CAPEX)' : 'เอกสารการเบิกขอใช้งบประมาณ (งบโครงการ CBS)') + '</div></div>' +
      '<div class="docno">ใบเบิกเลขที่ <strong>' + esc(r.docNo) + '</strong><br>วันที่ออกเอกสาร ' + fmtDay(r.approvedAt) +
      (isCapex ? '<br><span class="stamp">การเงินตรวจสอบแล้ว</span>' : '') + '</div></header>';

    const info = '<div class="section"><table><tbody>' +
      tr(isCapex ? 'รหัสโครงการ (Project No.)' : 'Job No.', esc(b.code + ' ' + b.name)) +
      (isCapex ? tr('รหัสรายการย่อย (Item No.)', esc(item.code + ' ' + item.name)) : '') +
      tr('วันที่ขอเบิก', fmtDay(isCapex ? r.createdAt : r.expenseDate)) +
      tr('ชื่อผู้ขอเบิกงบประมาณ', esc(userName(r.requesterId) + ' · ' + b.department)) +
      (isCapex ? tr('วัตถุประสงค์ในการเบิกใช้', esc(r.purpose)) : '') +
      tr(isCapex ? 'Supplier (ผู้รับเงิน)' : 'ผู้รับเงิน', esc(r.payee)) +
      tr('PO No.', esc(r.poNo)) +
      (isCapex && planText(r) ? tr('เงื่อนไขการจ่าย', planDetailHtml(r)) : '') +
      (r.overBudget ? tr('หมายเหตุ: ใช้เกินงบ', esc(r.overBudgetReason)) : '') +
      '</tbody></table></div>';

    let detail = '<div class="section"><h2>รายละเอียดการเบิกงบประมาณ</h2>';
    if (isCapex) {
      detail += '<div class="doc-two">' + balanceTable('ระดับโครงการ: ' + esc(b.code), proj) +
        balanceTable('ระดับรายการย่อย: ' + esc(item.code), balanceAt(r, b, leafIdsUnder(b, item))) + '</div>';
    } else {
      detail += balanceTable('ระดับโครงการ: ' + esc(b.code), proj) +
        '<table style="margin-top:.75rem"><thead><tr><th>รายการต้นทุน</th><th class="num">งบ</th><th class="num">ใช้ก่อนหน้า</th><th class="num">ครั้งนี้</th><th class="num">คงเหลือ</th></tr></thead><tbody>' +
        reqItemIds(r).map((iid) => {
          const it = itemById(b, iid) || {};
          const bal = balanceAt(r, b, [iid]);
          return '<tr><td>' + esc(it.code + ' ' + it.name) + '</td><td class="num">' + money(bal.approved) + '</td><td class="num">' + money(bal.before) +
            '</td><td class="num">' + money(bal.now) + '</td><td class="num">' + moneyCell(bal.after) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    detail += '</div>';

    const lines = '<div class="section"><h2>รายการที่ขอเบิกครั้งนี้</h2><table><thead><tr><th style="width:2rem">#</th>' +
      (isCapex ? '' : '<th>รายการต้นทุน / GL</th>') + '<th>' + (isCapex ? 'รายการงบประมาณ' : 'รายละเอียด') + '</th>' +
      '<th class="num">ก่อน VAT</th><th class="num">VAT 7%</th><th class="num">รวม</th></tr></thead><tbody>' +
      r.lines.map((l, i) => {
        const it = itemById(b, l.itemId) || {};
        return '<tr><td>' + (i + 1) + '</td>' +
          (isCapex ? '' : '<td>' + esc(it.code + ' ' + it.name) + (l.glCode ? '<br><small>GL ' + esc(l.glCode + ' ' + (l.glName || '')) + '</small>' : '') + '</td>') +
          '<td>' + esc(l.description) + '</td><td class="num">' + money(l.amountBeforeVat) + '</td><td class="num">' + money(l.vat) + '</td><td class="num">' + money(l.amount) + '</td></tr>';
      }).join('') +
      '<tr><th colspan="' + (isCapex ? 2 : 3) + '" class="right">รวมทั้งสิ้น</th><td class="num">' + money(r.amountBeforeVat) + '</td><td class="num">' + money(r.vat) +
      '</td><td class="num"><strong>' + money(r.amount) + '</strong></td></tr></tbody></table></div>';

    const signs = '<div class="signs"><div><div class="line"></div>ผู้ขอเบิกงบประมาณ<br>' + esc(userName(r.requesterId)) + '</div>' +
      r.steps.map((s) => '<div><div class="line"></div>' + esc((user(s.by) || {}).title || '') + '<br>' + esc(userName(s.by)) + '<br><small>' + fmtDay(s.at) + '</small></div>').join('') +
      '</div>';

    return '<div class="actions no-print" style="margin:0 0 1rem">' +
      '<button class="btn primary" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>' +
      '<article class="doc">' + head + info + detail + lines +
      (isCapex ? doaTable(item.doa, r.amount) : '') + signs +
      '<p class="note">โปรดแนบเอกสารฉบับนี้ และระบุเลขที่ ' + esc(r.docNo) +
      ' ในใบขอซื้อ (PR) ที่เกี่ยวข้อง · ยอดขอซื้อรวมต้องไม่เกิน ' + money(r.amount) + ' บาท</p>' +
      '</article>';
  }

  function notFound() {
    return '<div class="card empty">ไม่พบข้อมูลที่ต้องการ</div>';
  }

  // ---------------------------------------------------------------- router

  // ---- ปุ่มย้อนกลับ: กลับไปหน้าที่เป็น "ต้นทาง" ของหน้านี้ (ไม่ใช้ history เพราะหลังส่งฟอร์ม history จะพากลับไปหน้าฟอร์มเดิม)
  const LIST_PAGES = ['budgets', 'my-budgets', 'requests', 'approvals', 'accounting', 'payments'];
  let lastBudgetList = null; // หน้ารายการงบล่าสุด (จำแท็บ/ตัวกรอง)
  let lastRequestParent = null; // หน้าที่เปิดคำขอมาล่าสุด: รายการคำขอ / รอตรวจสอบ / งวดจ่าย / หน้ารายละเอียดงบ

  function backLabel(hash) {
    const p = hash.slice(2).split('?')[0].split('/');
    if (p[0] === 'budget') {
      const b = budgetById(p[1]);
      return b ? b.code + ' ' + b.name : 'งบประมาณ';
    }
    if (p[0] === 'request') {
      const r = requestById(p[1]);
      return r ? 'คำขอ ' + r.no : 'คำขอ';
    }
    const titles = {
      budgets: me().role === 'finance' ? 'จัดการงบประมาณ' : 'งบประมาณ', 'my-budgets': 'งบของฉัน',
      requests: me().role === 'requester' ? 'คำขอของฉัน' : 'คำขอใช้งบทั้งหมด',
      approvals: 'รอตรวจสอบ', accounting: 'รอบันทึกบัญชี', payments: 'งวดจ่ายค้าง'
    };
    return titles[p[0]] || 'กลับ';
  }

  /** ปลายทางของปุ่มย้อนกลับ ตามชนิดหน้า (null = หน้ารายการ ไม่ต้องมีปุ่ม) */
  function backTarget(parts) {
    const budgetList = lastBudgetList || (me().role === 'requester' ? '#/my-budgets' : '#/budgets');
    if (parts[0] === 'budget' && parts[1] === 'new') return budgetList;
    if (parts[0] === 'budget' && parts[2] === 'edit') return '#/budget/' + parts[1];
    if (parts[0] === 'budget') return budgetList;
    if (parts[0] === 'request' && parts[1] === 'new') return '#/budget/' + parts[2];
    if (parts[0] === 'request' && parts[2] === 'edit') return '#/request/' + parts[1];
    if (parts[0] === 'request') return lastRequestParent || '#/requests';
    if (parts[0] === 'doc') return '#/request/' + parts[1];
    return null;
  }

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
    else if (parts[0] === 'payments') html = viewPayments();
    else if (parts[0] === 'doc') html = viewDocument(parts[1]);
    else html = notFound();

    const here = '#' + path + (query ? '?' + query : '');
    const back = backTarget(parts);
    if (back) html = '<div class="back-bar no-print"><a class="back-link" href="' + esc(back) + '">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      esc(backLabel(back)) + '</a></div>' + html;
    if (parts[0] === 'budgets' || parts[0] === 'my-budgets') lastBudgetList = here;
    if (LIST_PAGES.includes(parts[0]) || (parts[0] === 'budget' && parts.length === 2 && parts[1] !== 'new')) lastRequestParent = here;

    renderNav('#' + path);
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
        lastBudgetList = null;
        lastRequestParent = null;
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
