/*
 * ระบบขอเบิกใช้งบประมาณ (ต้นแบบ)
 *
 * งบได้รับอนุมัติมาแล้ว ระบบนี้ใช้ยืนยันว่าใช้ถูกตัวงบ และติดตามยอดคงเหลือ
 *
 * - การเงิน: บันทึกงบที่อนุมัติแล้ว และปรับงบ (เก็บประวัติทุกครั้ง)
 *     CAPEX = รหัสโครงการ (Project No.) → รายการย่อย (Item No.)
 *     OPEX   = Job No. → รายการต้นทุนหลายชั้น (1 → 1.1 → 1.1.1) พร้อม GL Code
 * - ผู้ขอใช้งบ: ดูยอดคงเหลือ แล้วจัดทำเอกสารขอเบิกโดยระบุตัวงบทุกครั้งที่จะใช้
 *     CAPEX: ส่งให้การเงินตรวจสอบ → อนุมัติ (ออกใบเบิกงบประมาณ) / ไม่อนุมัติ (แก้ไขส่งใหม่หรือยกเลิก)
 *     CBS:   ออกเอกสารทันที ไม่ผ่านการเงิน (ใช้เกินงบได้แต่ต้องระบุเหตุผล) และผู้ขอยกเลิกเองได้
 * - บัญชี: บันทึกข้อมูลบัญชีของเอกสารที่ออกแล้ว (CAPEX แยก Asset/Expense, OPEX GL Code/สถานะจ่าย)
 *
 * ข้อมูลเก็บใน localStorage ของเบราว์เซอร์ (ยังไม่มี backend) — ข้อมูลตัวอย่างทั้งหมดเป็นข้อมูลสมมติ
 */
(function () {
  'use strict';

  const DB_KEY = 'procurement.v5';
  const VAT_RATE = 0.07;

  /** โหมดเชื่อม Supabase (ล็อกอินจริง ข้อมูลกลาง) เมื่อใส่ค่าใน js/config.js — ถ้าไม่ใส่จะเป็นโหมดทดลองในเบราว์เซอร์ */
  // ต้นแบบรอบใหม่ (วงจรงบ + ดำเนินการใช้งบ) ยังไม่ได้เชื่อมฐานข้อมูล Supabase จึงใช้โหมดทดลองเสมอ
  // (เวอร์ชันที่เชื่อม Supabase ได้แล้วเก็บไว้ที่ /v1/)
  const REMOTE = false;

  const DEMO_USERS = [
    { id: 'req1', name: 'สมชาย ใจดี', title: 'วิศวกร ฝ่ายวิศวกรรม', role: 'business' },
    { id: 'req2', name: 'สุดา รักงาน', title: 'เจ้าหน้าที่โครงการ ฝ่ายโครงการ', role: 'business' },
    { id: 'fin1', name: 'มาลี เงินดี', title: 'บัญชีการเงิน', role: 'controller' },
    { id: 'pur1', name: 'ปิติ จัดหา', title: 'เจ้าหน้าที่จัดซื้อ', role: 'purchasing' },
    { id: 'adm1', name: 'อดิศร ดูแลระบบ', title: 'ผู้ดูแลระบบ (IT)', role: 'admin' }
  ];
  let USERS = DEMO_USERS; // โหมด Supabase: แทนที่ด้วยรายชื่อผู้ใช้จากฐานข้อมูล
  let remoteMe = null; // โหมด Supabase: ผู้ใช้ที่ล็อกอินอยู่ (null = ยังไม่ได้ล็อกอิน)

  const ROLE_LABEL = {
    business: 'Business (ผู้ขอใช้งบ)',
    controller: 'ผู้คุมงบ (บัญชีการเงิน)',
    purchasing: 'จัดซื้อ',
    admin: 'ผู้ดูแลระบบ (Admin)',
    // ชื่อบทบาทเดิม (ยังอยู่ในประวัติของเอกสารเก่า)
    requester: 'ผู้ขอใช้งบ',
    finance: 'ผู้คุมงบ',
    accounting: 'ผู้คุมงบ'
  };

  /** สิทธิ์ทั้งหมดของระบบ (ต้นแบบรอบใหม่ — ฐานข้อมูลจะปรับตามเมื่อยืนยันขั้นตอนแล้ว) */
  const PERMISSIONS = [
    { key: 'budget.view_all', group: 'การมองเห็น', label: 'ดูงบและเอกสารของทุกคน', hint: 'ถ้าไม่มี จะเห็นเฉพาะงบที่ตนสร้าง/เป็นเจ้าของ' },
    { key: 'budget.create', group: 'Business', label: 'ขออนุมัติงบใหม่', hint: 'สร้างร่าง แนบมติที่ประชุม ส่งให้ผู้คุมงบเปิดใช้' },
    { key: 'request.create', group: 'Business', label: 'ขอดำเนินการใช้งบ / ขอเพิ่มงบ', hint: 'เฉพาะงบที่ตนเป็นเจ้าของ' },
    { key: 'budget.verify', group: 'ผู้คุมงบ', label: 'ยืนยันเปิดใช้งบ / ยืนยันเพิ่มงบ', hint: 'ตรวจมติแล้วยืนยันหรือส่งกลับ' },
    { key: 'budget.adjust', group: 'ผู้คุมงบ', label: 'โยกงบ / ลดงบ', hint: 'โยกข้ามรายการหรือโครงการได้ ต้องระบุเหตุผล' },
    { key: 'budget.manage', group: 'ผู้คุมงบ', label: 'นำเข้างบที่อนุมัติแล้ว', hint: 'บันทึกงบเดิมและเปิดใช้ทันที (ช่วงเริ่มระบบ)' },
    { key: 'request.decide', group: 'ผู้คุมงบ', label: 'ตรวจสอบ / อนุมัติการดำเนินการใช้งบ', hint: 'ขอเกินงบรายการต้องใส่ Note' },
    { key: 'cut.record', group: 'ผู้คุมงบ', label: 'บันทึกการตัดงบและปิดยอด', hint: 'Advance · สำรองจ่าย · จ่ายตรง Supplier · ปิดยอดคืนส่วนต่าง (CAPEX และ OPEX)' },
    { key: 'po.record', group: 'จัดซื้อ', label: 'บันทึก PR / PO', hint: 'ตัดงบ PR/PO ตามยอด PO' },
    { key: 'master.manage', group: 'ผู้ดูแลระบบ', label: 'จัดการข้อมูลหลัก', hint: 'บริษัท หน่วยงาน กลุ่มงบ ประเภทสินทรัพย์ หมวดค่าใช้จ่าย GL Code' },
    { key: 'data.export', group: 'การเงิน / บัญชี', label: 'ส่งออกข้อมูล (Excel)', hint: 'ดาวน์โหลดข้อมูลงบ คำขอ การตัดงบ ปรับงบ Plan Cashflow เป็นไฟล์ .xlsx' },
    { key: 'log.view', group: 'ผู้ดูแลระบบ', label: 'ดู Log การทำงาน', hint: '' },
    { key: 'user.manage', group: 'ผู้ดูแลระบบ', label: 'จัดการผู้ใช้ บทบาท และสิทธิ์', hint: 'หน้า Admin (โหมดทดลองดูได้อย่างเดียว)' }
  ];
  /** โหมดทดลอง: สิทธิ์ตั้งต้นของแต่ละบทบาท */
  const DEMO_ROLE_PERMS = {
    business: ['budget.create', 'request.create'],
    controller: ['budget.view_all', 'budget.manage', 'budget.verify', 'budget.adjust', 'request.decide', 'cut.record', 'data.export'],
    purchasing: ['budget.view_all', 'po.record'],
    admin: ['budget.view_all', 'master.manage', 'log.view', 'user.manage', 'data.export']
  };

  const COMPANIES = { PBI: 'บริษัท PBI (ตัวอย่าง)', PCC: 'บริษัท PCC (ตัวอย่าง)' };
  /**
   * เกณฑ์ Memo ผู้บริหารเซ็นตอนขอดำเนินการใช้งบ (ตั้งรายบริษัทที่ข้อมูลหลัก)
   * '' = ไม่ต้องใช้ · 'cross' = ต้องทำเมื่อใช้เงินข้ามบริษัทกับบริษัทนี้ (บริษัทอื่นมาใช้งบของบริษัทนี้ หรือบริษัทนี้ออกเงินให้งบของบริษัทอื่น)
   */
  const MEMO_MODES = [['', 'ไม่ต้องใช้'], ['cross', 'ใช้เงินข้ามบริษัทกับบริษัทนี้']];
  /** เกณฑ์ตั้งต้น: งบของ PCC ที่บริษัทอื่นมาใช้ (หรือ PCC ออกเงินให้งบของบริษัทอื่น) ต้องทำ Memo */
  const memoDefaultFor = (code) => (code === 'PCC' ? 'cross' : '');
  /** ผู้ลงนามใน Memo ตั้งต้น (ข้อความตัวอย่างทั่วไป ใส่ชื่อ/ตำแหน่งจริงที่ข้อมูลหลัก > ผู้ลงนาม Memo) */
  const MEMO_PARTY_SAMPLE = {
    PBI: { to: 'ผู้บริหารสูงสุด PBI (ตัวอย่าง)', cc: 'บัญชี / การเงิน PBI (ตัวอย่าง)', reviewer: 'ผู้บริหารฝ่ายการเงิน PBI (ตัวอย่าง)', signer: 'กรรมการผู้จัดการ PBI (ตัวอย่าง)', doa: '' },
    PCC: { to: 'ผู้บริหารสูงสุด PCC (ตัวอย่าง)', cc: 'บัญชี / การเงิน PCC (ตัวอย่าง)', reviewer: 'ผู้บริหารฝ่ายการเงิน PCC (ตัวอย่าง)', signer: 'กรรมการผู้จัดการ PCC (ตัวอย่าง)', doa: '' }
  };
  const TYPE_LABEL = { CAPEX: 'งบลงทุน (CAPEX)', CBS: 'งบดำเนินงาน (OPEX)' };
  /** ชื่อย่อที่แสดง: รหัสภายใน 'CBS' แสดงเป็น OPEX */
  const TYPE_SHORT = { CAPEX: 'CAPEX', CBS: 'OPEX' };
  const STATUS_LABEL = {
    memo: 'รอแนบ Memo ที่เซ็นแล้ว',
    pending: 'รอผู้คุมงบตรวจสอบ',
    approved: 'ออกเอกสารแล้ว',
    closed: 'ปิดยอดแล้ว',
    rejected: 'ส่งกลับแก้ไข',
    cancelled: 'ยกเลิก'
  };
  /** สถานะของตัวงบ: Business ร่าง → แนบมติส่งตรวจ → ผู้คุมงบยืนยันเปิดใช้ / ส่งกลับ */
  const BUDGET_STATE = { draft: 'ร่าง', review: 'รอผู้คุมงบตรวจสอบ', returned: 'ส่งกลับแก้ไข', active: 'เปิดใช้งาน', cancelled: 'ยกเลิก' };
  const BUDGET_STATE_BADGE = { draft: 'draft', review: 'pending', returned: 'rejected', active: 'approved', cancelled: 'cancelled' };
  /** ประเภทการดำเนินการใช้งบ (CAPEX) และจังหวะที่ตัดงบจริง */
  const USE_TYPES = {
    prpo: { label: 'ซื้อโดยเปิด PR / PO', short: 'PR/PO', cut: 'ตัดงบเมื่อจัดซื้อออก PO (ตามยอด PO)', who: 'จัดซื้อ' },
    advance: { label: 'Advance (เงินทดรอง)', short: 'Advance', cut: 'ตัดงบเมื่อเคลียร์เงินทดรองพร้อมใบเสร็จ', who: 'ผู้คุมงบ' },
    reimburse: { label: 'พนักงานสำรองจ่าย', short: 'สำรองจ่าย', cut: 'ตัดงบเมื่อจ่ายคืนพนักงานตามใบเสร็จ', who: 'ผู้คุมงบ' },
    direct: { label: 'จ่ายตรงให้ Supplier', short: 'จ่ายตรง', cut: 'ตัดงบเมื่อจ่ายเงินให้ Supplier', who: 'ผู้คุมงบ', hint: 'ค่างานจ้างเหมา · จ่ายรายวัน · ค่าน้ำมันที่เบิกใช้ · Stock' }
  };
  const DEFAULT_CATEGORIES = [
    { name: 'ค่าแรง', gl: '520101' }, { name: 'ค่าวัสดุ / อุปกรณ์', gl: '510101' }, { name: 'ค่าจ้างเหมา', gl: '520201' },
    { name: 'ค่าเครื่องจักร / สินทรัพย์', gl: '' }, { name: 'ค่าขนส่ง', gl: '540101' }, { name: 'ค่าเช่า', gl: '530101' }, { name: 'อื่นๆ', gl: '' }
  ];
  /** โหมดทดลองเก็บไฟล์แนบในเบราว์เซอร์ จึงจำกัดขนาดไว้เล็ก (ระบบจริงเก็บใน Storage ได้ใหญ่กว่า) */
  const ATTACH_MAX = 400 * 1024;
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

  const DEFAULT_GROUP_NAMES = { '01': 'สายการผลิต', '02': 'สาธารณูปโภค', '04': 'คลังสินค้าและโลจิสติกส์' };

  /**
   * ข้อมูลหลัก (การเงินแก้ได้ที่เมนู "ข้อมูลหลัก"): บริษัท, หน่วยงาน, กลุ่มงบ, ประเภทสินทรัพย์, GL Code
   * เติมค่าตั้งต้นให้ครบ รวมค่าที่งบเดิมใช้อยู่แล้ว จะได้ไม่มีงบที่อ้างถึงค่าที่ไม่มีในรายการ
   */
  function ensureMaster(d) {
    const m = d.master || {};
    const list = (k) => (Array.isArray(m[k]) ? m[k] : []);
    const addBy = (arr, key, item) => { if (item[key] && !arr.some((x) => x[key] === item[key])) arr.push(item); };
    const companies = list('companies').slice();
    if (!REMOTE) Object.keys(COMPANIES).forEach((c) => addBy(companies, 'code', { code: c, name: COMPANIES[c] }));
    const departments = list('departments').slice();
    const groups = list('groups').slice();
    const assetTypes = list('assetTypes').slice();
    ASSET_TYPES.forEach((t) => addBy(assetTypes, 'name', { name: t }));
    const glCodes = list('glCodes').slice();
    const expenseCategories = list('expenseCategories').length ? list('expenseCategories').slice() : DEFAULT_CATEGORIES.map((c) => Object.assign({}, c));
    (d.budgets || []).forEach((b) => {
      addBy(companies, 'code', { code: b.company, name: '' });
      addBy(departments, 'name', { name: b.department });
      addBy(groups, 'code', { code: b.group, name: DEFAULT_GROUP_NAMES[b.group] || '' });
      (b.items || []).forEach((it) => {
        if (b.type === 'CAPEX') addBy(assetTypes, 'name', { name: it.assetType });
        else addBy(glCodes, 'code', { code: it.glCode, name: it.glName || '' });
      });
    });
    // ค่าเดิมแบบติ๊ก (true/false) หรือยังไม่ตั้ง → ใช้เกณฑ์ตั้งต้น "เฉพาะงบที่ไม่มี Item"
    // เกณฑ์ Memo แบบใหม่ (ใช้เงินข้ามบริษัท) — เปลี่ยนจากเกณฑ์เดิมครั้งเดียว แล้วปรับเองได้ที่ข้อมูลหลัก
    if (m.memoRule !== 2) companies.forEach((c) => { c.memo = memoDefaultFor(c.code); });
    companies.forEach((c) => { if (!MEMO_MODES.some(([v]) => v === c.memo)) c.memo = memoDefaultFor(c.code); });
    const memoParties = list('memoParties').slice();
    companies.forEach((c) => {
      if (!memoParties.some((x) => x.code === c.code)) memoParties.push(Object.assign({ code: c.code, to: '', cc: '', reviewer: '', signer: '', doa: '' }, MEMO_PARTY_SAMPLE[c.code] || {}));
    });
    d.master = { companies, departments, groups, assetTypes, glCodes, expenseCategories, memoParties, memoRule: 2 };
    return d;
  }
  const companyMap = () => Object.fromEntries(db.master.companies.map((c) => [c.code, c.name]));
  /** บริษัทที่ลงทุน: Item กำหนดเอง (ค่าตั้งต้น = บริษัทเจ้าของงบ) · งบที่ไม่มี Item เลือกรายบรรทัดตอนขอดำเนินการใช้งบ */
  const itemInvestor = (b, it) => {
    let n = it;
    while (n) { if (n.investor) return n.investor; n = b.type === 'CBS' ? parentOf(b, n) : null; }
    return b.company;
  };
  const lineInvestor = (b, l) => l.investor || (b.structure === 'project' ? b.company : itemInvestor(b, itemById(b, l.itemId)));
  const investorSelect = (name, selected, label) => '<div class="select-wrap"><select name="' + name + '" aria-label="' + (label || 'บริษัทที่ลงทุน') + '">' +
    optList(db.master.companies, 'code', (c) => c.code, selected) + '</select></div>';
  /** หลายคนคั่นด้วย ; หรือขึ้นบรรทัดใหม่ */
  const splitPeople = (v) => String(v || '').split(/\s*;\s*|\n/).map((x) => x.trim()).filter(Boolean);
  /** ผู้รับ/ผู้ลงนามใน Memo ตั้งต้น: ของบริษัทที่ลงทุน (เรียน/สำเนา/ผู้ทบทวน/ผู้พิจารณา) และผู้ลงนามเสนอของบริษัทเจ้าของงบ */
  function defaultMemoParties(b, investor) {
    const list = db.master.memoParties || [];
    const inv = list.find((x) => x.code === investor) || {};
    const own = list.find((x) => x.code === b.company) || {};
    return { to: splitPeople(inv.to), cc: splitPeople(inv.cc), reviewers: splitPeople(inv.reviewer), approvers: splitPeople(inv.to), proposer: String(own.signer || '').trim() };
  }
  const investorCell = (code) => '<span class="nowrap">' + esc(code) + '</span>';
  const memoModeOf = (code) => (db.master.companies.find((c) => c.code === code) || {}).memo || '';
  /**
   * Memo (CAPEX เท่านั้น): ต้องทำเมื่อใช้เงินข้ามบริษัท — มีบรรทัดที่บริษัทที่ลงทุนไม่ใช่บริษัทเจ้าของงบ
   * และบริษัทใดบริษัทหนึ่งตั้งเกณฑ์ "ใช้เงินข้ามบริษัท" ไว้ (ตั้งต้น: PCC) · คืน { owner, investor } หรือ null
   */
  function memoCross(b, lines) {
    if (!b || b.type !== 'CAPEX') return null;
    for (const l of lines || []) {
      const inv = lineInvestor(b, l);
      if (inv && inv !== b.company && (memoModeOf(inv) === 'cross' || memoModeOf(b.company) === 'cross')) return { owner: b.company, investor: inv };
    }
    return null;
  }
  /** งบนี้ต้องแนบ Memo ที่ผู้บริหารเซ็นตอนขอดำเนินการใช้งบหรือไม่ (ตามเกณฑ์ของบริษัท) */
  const memoRequired = (b, lines) => !!memoCross(b, lines);
  const memoReason = (b, lines) => {
    const x = memoCross(b, lines);
    return x ? 'งบของ ' + x.owner + ' มีรายการที่ ' + x.investor + ' เป็นบริษัทที่ลงทุน (ใช้เงินข้ามบริษัท) ต้องทำ Memo ให้ผู้บริหารเซ็นก่อนส่ง' : '';
  };
  const assetTypeList = () => db.master.assetTypes.map((x) => x.name);

  function seed() {
    const now = new Date();
    const iso = (d) => new Date(d).toISOString();
    const nowIso = now.toISOString();
    const year = now.getFullYear();
    const prev = year - 1;
    const yy = String(year).slice(-2);
    const day = (m, d) => year + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const item = (id, code, name, assetType, doa, amount, investor) => Object.assign({ id, code, name, assetType, doa, amount }, investor ? { investor } : {});
    const cbs = (id, code, name, extra) => Object.assign({ id, code, name, qty: '', unit: '', amount: 0, vat: 0, glCode: '', glName: '' }, extra || {});
    const sampleFile = (name) => ({ id: 'f-' + name, slot: 'resolution', name, size: 0, sample: true, at: nowIso, by: 'req1' });
    const budgets = [
      {
        id: 'b1', type: 'CAPEX', company: 'PBI', fiscalYear: year, group: '01', code: 'EN0001', structure: 'items',
        name: 'ปรับปรุงสายการผลิต Phase 1', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: 'งบตัวอย่าง',
        meeting: { date: day(1, 15), no: 'มติที่ 1/' + year, note: 'ประชุมคณะกรรมการบริหาร' },
        items: [
          item('c1', year + '-01-EN001', 'เครื่องตัดชิ้นงาน', 'เครื่องจักร', '2.4', 500000),
          item('c2', year + '-01-EN002', 'เครื่องมือและอุปกรณ์ห้องปฏิบัติการ', 'เครื่องมือและอุปกรณ์', '2.5', 610000, 'PCC'),
          item('c3', year + '-01-EN003', 'ระบบลำเลียงวัตถุดิบ (Conveyor)', 'เครื่องจักร', '2.4', 1500000)
        ]
      },
      {
        id: 'b2', type: 'CAPEX', company: 'PBI', fiscalYear: year, group: '01', code: 'IT0001', structure: 'items',
        name: 'อุปกรณ์ IT สำนักงาน', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: '',
        meeting: { date: day(1, 15), no: 'มติที่ 1/' + year, note: '' },
        items: [item('c4', year + '-01-IT001', 'คอมพิวเตอร์และอุปกรณ์ต่อพ่วง', 'อุปกรณ์สำนักงาน', '2.5', 450000)]
      },
      {
        id: 'b3', type: 'CBS', company: 'PBI', fiscalYear: year, group: '01', code: 'PJ0001-1', structure: 'items',
        name: 'ผลิตกล้าไม้ 10,000 กล้า', department: 'ฝ่ายโครงการ', ownerId: 'req2', note: '',
        meeting: { date: day(1, 3), no: 'อนุมัติผู้บริหาร MD-001/' + year, by: 'กรรมการผู้จัดการ', note: 'OPEX ไม่ต้องเข้าบอร์ด' },
        // Item หลัก (1, 2, 3, 4) มีวงเงินของตัวเอง · Item ย่อย (1.1 ...) เพิ่มทีหลัง จะกำหนดวงเงินหรือไม่ก็ได้ (ตัวอย่าง: 1.3 ไม่กำหนดวงเงิน)
        items: [
          cbs('i1', '1', 'ต้นทุนวัตถุดิบ', { amount: 269500, vat: 315, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i2', '1.1', 'กล้าพันธุ์ (รวมค่าขนส่ง)', { qty: 10000, unit: 'ต้น', amount: 230000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i3', '1.2', 'วัสดุปลูก', { amount: 35000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i4', '1.2.1', 'ดินผสม', { amount: 20000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i5', '1.2.2', 'ถุงเพาะ ขนาด 6x12 นิ้ว', { amount: 15000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }),
          cbs('i6', '1.3', 'วัสดุสิ้นเปลืองอื่น ๆ', { glCode: '510102', glName: 'วัสดุสิ้นเปลือง' }),
          cbs('i7', '2', 'ต้นทุนค่าแรง', { amount: 65000, glCode: '520101', glName: 'ค่าแรงงาน' }),
          cbs('i8', '2.1', 'คนงานประจำ', { qty: 2, unit: 'คน', amount: 20000, glCode: '520101', glName: 'ค่าแรงงาน' }),
          cbs('i9', '2.2', 'คนงานรายวัน', { unit: 'คน', amount: 45000, glCode: '520101', glName: 'ค่าแรงงาน' }),
          cbs('i10', '3', 'ต้นทุนค่าเช่า', { amount: 3000, glCode: '530101', glName: 'ค่าเช่าและสาธารณูปโภค' }),
          cbs('i11', '3.1', 'ค่าระบบน้ำ', { amount: 3000, glCode: '530101', glName: 'ค่าเช่าและสาธารณูปโภค' }),
          cbs('i12', '4', 'รายการส่วนเพิ่มอื่นๆ', { amount: 5000, glCode: '540101', glName: 'ค่าขนส่ง' }),
          cbs('i13', '4.1', 'ค่าขนส่ง', { amount: 5000, glCode: '540101', glName: 'ค่าขนส่ง' })
        ]
      },
      {
        id: 'b4', type: 'CAPEX', company: 'PBI', fiscalYear: prev, group: '02', code: 'EN0002', structure: 'items',
        name: 'ระบบไอน้ำ (ยกมาจากปีก่อน)', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: 'งบปีก่อน ยกมาใช้ต่อ',
        meeting: { date: prev + '-02-10', no: 'มติที่ 2/' + prev, note: '' },
        items: [item('c5', prev + '-02-EN001', 'ชุดหม้อไอน้ำและท่อ', 'เครื่องจักร', '2.4', 800000)]
      },
      {
        id: 'b5', type: 'CAPEX', company: 'PCC', fiscalYear: year, group: '04', code: 'PD0001', structure: 'items',
        name: 'อุปกรณ์คลังสินค้า', department: 'ฝ่ายผลิต', ownerId: 'req2', note: '',
        meeting: { date: day(2, 1), no: 'มติที่ 2/' + year, note: '' },
        items: [
          item('c6', year + '-04-PD001', 'รถยกไฟฟ้า', 'ยานพาหนะ', '2.5', 1200000),
          item('c7', year + '-04-PD002', 'ชั้นวางสินค้า', 'อื่นๆ', '2.5', 300000)
        ]
      },
      {
        id: 'b6', type: 'CAPEX', company: 'PBI', fiscalYear: year, group: '01', code: 'BD0001', structure: 'project',
        name: 'ปรับปรุงอาคารสำนักงาน (งบรวมโครงการ)', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: 'ยังไม่แยกรายการย่อย เพราะรายละเอียดยังไม่ชัดเจน',
        meeting: { date: day(3, 10), no: 'มติที่ 3/' + year, note: '' },
        items: [item('c8', 'BD0001', 'งบรวมทั้งโครงการ', 'อาคารและสิ่งปลูกสร้าง', '2.5', 900000)]
      },
      {
        id: 'b7', type: 'CAPEX', company: 'PBI', fiscalYear: year + 1, group: '01', code: 'EN0003', structure: 'project', state: 'draft',
        name: 'ระบบโซลาร์รูฟท็อป', department: 'ฝ่ายวิศวกรรม', ownerId: 'req1', note: 'เตรียมเข้าที่ประชุมรอบหน้า',
        items: [item('c10', 'EN0003', 'งบรวมทั้งโครงการ', 'เครื่องจักร', '2.4', 2500000)]
      },
      {
        id: 'b8', type: 'CAPEX', company: 'PCC', fiscalYear: year, group: '04', code: 'PD0002', structure: 'items', state: 'review',
        name: 'รถยกไฟฟ้าเพิ่มเติม', department: 'ฝ่ายผลิต', ownerId: 'req2', note: '',
        meeting: { date: day(10, 20), no: 'มติที่ 9/' + year, note: 'อนุมัติเต็มจำนวน' },
        attachments: [sampleFile('มติที่ประชุม-9-' + year + '.pdf')],
        items: [item('c9', year + '-04-PD003', 'รถยกไฟฟ้า 2 ตัน', 'ยานพาหนะ', '2.5', 980000)]
      }
    ];
    budgets.forEach((b) => {
      b.createdAt = iso(day(1, 2));
      b.createdBy = b.ownerId;
      b.state = b.state || 'active';
      b.history = [{ at: b.createdAt, by: b.ownerId, action: 'สร้างร่างคำขออนุมัติงบ' }];
      if (b.state !== 'draft') {
        b.attachments = b.attachments || [sampleFile((b.type === 'CBS' ? 'เอกสารอนุมัติผู้บริหาร-' : 'มติที่ประชุม-') + b.code + '.pdf')];
        b.history.push({ at: iso(b.meeting.date), by: b.ownerId, action: b.type === 'CBS' ? 'แนบเอกสารอนุมัติผู้บริหารและส่งให้ผู้คุมงบตรวจสอบ' : 'แนบมติที่ประชุมและส่งให้ผู้คุมงบตรวจสอบ', note: b.meeting.no });
      }
      b.attachments = b.attachments || [];
      if (b.state === 'active') {
        b.activatedAt = iso(b.meeting.date);
        b.activatedBy = 'fin1';
        b.history.push({ at: b.activatedAt, by: 'fin1', action: 'ยืนยันเปิดใช้งาน' });
        b.revisions = [{ no: 0, at: b.activatedAt, by: 'fin1', note: 'เปิดใช้งานตาม' + b.meeting.no, total: budgetTotal(b), items: snapshotItems(b) }];
      } else {
        b.revisions = [];
      }
    });
    // ตัวอย่างการปรับงบหลังเปิดใช้: เครื่องตัดชิ้นงาน 400,000 → 500,000
    budgets[0].revisions[0].items[0].total = 400000;
    budgets[0].revisions[0].total -= 100000;
    budgets[0].revisions.push({ no: 1, at: iso(day(4, 2)), by: 'fin1', note: 'เพิ่มงบเครื่องตัดชิ้นงานตามมติที่ 4/' + year, total: budgetTotal(budgets[0]), items: snapshotItems(budgets[0]) });

    // ---- ตัวอย่างการดำเนินการใช้งบในสถานะต่าง ๆ
    const line = (itemId, description, before, extra) => Object.assign({ itemId, description, amountBeforeVat: before, vat: round2(before * VAT_RATE), amount: round2(before * (1 + VAT_RATE)) }, extra || {});
    const mk = (o) => {
      const amountBeforeVat = round2(o.lines.reduce((s, l) => s + l.amountBeforeVat, 0));
      const vat = round2(o.lines.reduce((s, l) => s + l.vat, 0));
      const decided = o.status !== 'pending' && o.status !== 'memo';
      const events = [{ at: o.createdAt, by: o.requesterId, action: o.memo ? 'บันทึกคำขอและออก Memo ' + o.memo.no : 'ส่งคำขอดำเนินการใช้งบ', note: '' }];
      if (o.memo && o.memo.at) events.push({ at: o.memo.at, by: o.requesterId, action: 'แนบ Memo ที่เซ็นแล้วและส่งให้ผู้คุมงบตรวจสอบ', note: o.memo.no + ' · ' + o.memo.by });
      if (decided && o.approvedAt) events.push({ at: o.approvedAt, by: 'fin1', action: 'อนุมัติ ออกใบดำเนินการใช้งบ ' + (o.docNo || ''), note: o.approverNote || '' });
      if (o.advance) events.push({ at: o.advance.at, by: o.advance.by, action: 'จ่ายเงินทดรอง', note: money(o.advance.amount) + ' บาท' });
      (o.cuts || []).forEach((c) => events.push({ at: c.at, by: c.by, action: 'บันทึก' + ({ po: 'ใบสั่งซื้อ (PO)', clear: 'เคลียร์เงินทดรอง', reimburse: 'จ่ายคืนพนักงาน', payment: 'จ่ายเงิน Supplier' }[c.kind]), note: money(c.amount) + ' บาท' }));
      if (o.closed) events.push({ at: o.closed.at, by: o.closed.by, action: 'ปิดยอด', note: 'ใช้จริง ' + money(o.closed.actual) + ' บาท' });
      return Object.assign({
        type: 'CAPEX', history: [], payee: 'บริษัทตัวอย่าง จำกัด', poNo: 'N/A', paymentPlan: { mode: 'single', installments: [] }, paymentTerms: 'จ่ายครั้งเดียว',
        payments: [], cuts: [], attachments: [], events, amountBeforeVat, vat, amount: round2(amountBeforeVat + vat),
        steps: [Object.assign({ key: 'ctl', label: 'ผู้คุมงบตรวจสอบ', role: 'controller', status: decided ? 'approved' : 'waiting' },
          decided ? { by: 'fin1', at: o.approvedAt, comment: o.note || '' } : {})]
      }, o);
    };
    const requests = [
      mk({ id: 'r1', no: 'REQ-' + year + '-0001', budgetId: 'b1', itemId: 'c1', useType: 'prpo', requesterId: 'req1', createdAt: iso(day(9, 1)),
        status: 'approved', approvedAt: iso(day(9, 3)), docNo: 'CAPEX-' + year + '-0001', purpose: 'ทดแทนเครื่องเดิมที่เสื่อมสภาพ',
        lines: [line('c1', 'เครื่องตัดชิ้นงาน CNC พร้อมติดตั้ง', 450000)] }),
      mk({ id: 'r2', no: 'REQ-' + year + '-0002', budgetId: 'b1', itemId: 'c2', useType: 'advance', requesterId: 'req1', createdAt: iso(day(9, 20)),
        status: 'approved', approvedAt: iso(day(9, 22)), docNo: 'CAPEX-' + year + '-0002', purpose: 'ซื้ออุปกรณ์ห้องแล็บหน้าร้าน', payee: 'สมชาย ใจดี (เงินทดรอง)',
        advance: { at: iso(day(9, 25)), date: day(9, 25), amount: 32100, by: 'fin1' },
        lines: [line('c2', 'อุปกรณ์วัดและเครื่องมือห้องแล็บ', 30000)] }),
      mk({ id: 'r3', no: 'REQ-' + year + '-0003', budgetId: 'b2', itemId: 'c4', useType: 'reimburse', requesterId: 'req1', createdAt: iso(day(8, 5)),
        status: 'closed', approvedAt: iso(day(8, 6)), docNo: 'CAPEX-' + year + '-0003', purpose: 'ซื้อจอภาพด่วนสำหรับห้องประชุม', payee: 'สมชาย ใจดี (สำรองจ่าย)',
        lines: [line('c4', 'จอภาพ 27 นิ้ว 4 เครื่อง', 20000)],
        cuts: [{ id: 'x1', kind: 'reimburse', date: day(8, 12), amount: 19260, ref: 'ใบเสร็จ INV-5521', note: '', by: 'fin1', at: iso(day(8, 12)), attachments: [] }],
        closed: { at: iso(day(8, 12)), by: 'fin1', actual: 19260, returned: 2140, note: 'ซื้อได้ถูกกว่าที่ขอ' } }),
      mk({ id: 'r4', no: 'REQ-' + year + '-0004', budgetId: 'b6', itemId: 'c8', useType: 'direct', requesterId: 'req1', createdAt: iso(day(10, 28)),
        status: 'pending', purpose: 'งานปรับปรุงพื้นที่ชั้น 2', payee: 'หจก. ก่อสร้างตัวอย่าง',
        memo: { no: 'MEMO-' + year + '-0001', by: 'กรรมการผู้จัดการ', at: iso(day(10, 29)), files: [Object.assign(sampleFile('Memo-ปรับปรุงชั้น2-ลงนามแล้ว.pdf'), { slot: 'memo', by: 'req1' })] },
        lines: [line('c8', 'งานรื้อถอนและปรับพื้นชั้น 2', 150000, { category: 'ค่าจ้างเหมา', investor: 'PBI' }), line('c8', 'กระเบื้องและวัสดุปูพื้น', 40000, { category: 'ค่าวัสดุ / อุปกรณ์', investor: 'PCC' })] }),
      mk({ id: 'r5', no: 'REQ-' + year + '-0005', budgetId: 'b5', itemId: 'c7', useType: 'prpo', requesterId: 'req2', createdAt: iso(day(10, 30)),
        status: 'pending', purpose: 'ขยายพื้นที่จัดเก็บสินค้า', requesterReason: 'ราคาเหล็กปรับขึ้นจากตอนตั้งงบ',
        lines: [line('c7', 'ชั้นวางสินค้าแบบ Heavy duty 12 ชุด', 327000)] }),
      mk({ id: 'r6', no: 'REQ-' + year + '-0006', budgetId: 'b3', type: 'CBS', itemId: 'i4', useType: 'direct', requesterId: 'req2', createdAt: iso(day(9, 10)),
        status: 'approved', approvedAt: iso(day(9, 11)), docNo: 'OPEX-' + year + '-0001', purpose: 'ซื้อดินผสมสำหรับเพาะกล้า', payee: 'ร้านวัสดุเกษตร',
        lines: [{ itemId: 'i4', description: 'ดินผสม 100 กระสอบ', amountBeforeVat: 5000, vat: 0, amount: 5000, glCode: '510101', glName: 'ค่าวัตถุดิบ' }] }),
      mk({ id: 'r8', no: 'REQ-' + year + '-0008', budgetId: 'b6', itemId: 'c8', useType: 'prpo', requesterId: 'req1', createdAt: iso(day(11, 2)),
        status: 'memo', purpose: 'ติดตั้งระบบไฟส่องสว่างชั้น 2', payee: '',
        memo: { no: 'MEMO-' + year + '-0002', by: '', files: [], issuedAt: iso(day(11, 2)) },
        memoParties: { to: ['ผู้บริหารสูงสุด PCC (ตัวอย่าง)', 'ผู้บริหารอาวุโส PCC (ตัวอย่าง)'], cc: ['บัญชี / การเงิน PCC (ตัวอย่าง)'], reviewers: ['ผู้บริหารฝ่ายการเงิน PCC (ตัวอย่าง)'],
          approvers: ['ผู้บริหารสูงสุด PCC (ตัวอย่าง)', 'ผู้บริหารอาวุโส PCC (ตัวอย่าง)'], proposer: 'กรรมการผู้จัดการ PBI (ตัวอย่าง)' },
        lines: [line('c8', 'โคมไฟ LED พร้อมติดตั้ง 40 ชุด', 60000, { category: 'ค่าวัสดุ / อุปกรณ์', investor: 'PCC' })] }),
      mk({ id: 'r7', no: 'REQ-' + year + '-0007', budgetId: 'b3', type: 'CBS', itemId: 'i5', useType: 'prpo', requesterId: 'req2', createdAt: iso(day(10, 31)),
        status: 'pending', purpose: 'วัสดุเพาะกล้ารอบถัดไป', payee: '',
        lines: [{ itemId: 'i5', description: 'ถุงเพาะ 6x12 นิ้ว 5,000 ใบ', amountBeforeVat: 6000, vat: 420, amount: 6420, glCode: '510101', glName: 'ค่าวัตถุดิบ' },
          { itemId: 'i11', description: 'ท่อและหัวจ่ายน้ำ', amountBeforeVat: 1500, vat: 105, amount: 1605, glCode: '530101', glName: 'ค่าเช่าและสาธารณูปโภค' }] })
    ];
    // ตัวอย่างคำขอเพิ่มงบที่รอผู้คุมงบตรวจสอบ
    const changes = [{
      id: 'g1', no: 'INC-' + year + '-0001', budgetId: 'b1', state: 'review', reason: 'ขยายระบบลำเลียงเพิ่มอีก 1 สาย',
      lines: [{ itemId: 'c3', amount: 200000 }], meeting: { date: day(10, 25), no: 'มติที่ 10/' + year, note: '' },
      attachments: [sampleFile('มติที่ประชุม-10-' + year + '.pdf')], createdBy: 'req1', createdAt: iso(day(10, 22)),
      history: [{ at: iso(day(10, 22)), by: 'req1', action: 'สร้างคำขอเพิ่มงบ' }, { at: iso(day(10, 26)), by: 'req1', action: 'แนบมติที่ประชุมและส่งให้ผู้คุมงบตรวจสอบ', note: 'มติที่ 10/' + year }]
    }];
    const log = [];
    budgets.forEach((b) => b.history.forEach((h) => log.push({ at: h.at, by: h.by, action: h.action, ref: 'งบ ' + b.code, detail: h.note || '' })));
    changes.forEach((c) => c.history.forEach((h) => log.push({ at: h.at, by: h.by, action: h.action, ref: c.no, detail: h.note || '' })));
    requests.forEach((r) => {
      log.push({ at: r.createdAt, by: r.requesterId, action: 'ส่งขอดำเนินการใช้งบ', ref: r.no, detail: '' });
      if (r.approvedAt) log.push({ at: r.approvedAt, by: 'fin1', action: 'อนุมัติ ออกใบดำเนินการใช้งบ', ref: r.docNo, detail: '' });
    });
    log.sort((a, b) => a.at.localeCompare(b.at));
    const no = { ['REQ-' + year]: 8, ['INC-' + year]: 1, ['MEMO-' + year]: 2, ['CAPEX-' + year]: 3, ['OPEX-' + year]: 1 };
    return ensureMaster({ seq: { req: 8, id: 200, doc: {}, no }, budgets, requests, changes, log });
  }

  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { /* ใช้ข้อมูลตัวอย่างแทน */ }
    return seed();
  }

  /** คำขอ OPEX แบบเดิม (ออกเอกสารทันที + บัญชีจ่าย) → ขั้นตอนเดียวกับ CAPEX: จ่ายตรง Supplier ตัดงบเมื่อจ่ายแล้ว */
  function upgradeCbsRequest(r) {
    const acc = r.accounting || {};
    const paid = acc.paymentStatus === 'จ่ายแล้ว';
    r.useType = 'direct';
    r.itemId = r.itemId || (r.lines[0] || {}).itemId;
    r.purpose = r.purpose || (r.lines[0] || {}).description || '';
    r.paymentPlan = { mode: 'single', installments: [] };
    r.attachments = r.attachments || [];
    r.events = r.events || [];
    r.cuts = [];
    if (r.status === 'approved') {
      r.steps = [{ key: 'ctl', label: 'ผู้คุมงบตรวจสอบ', role: 'controller', status: 'approved', by: 'fin1', at: r.approvedAt, comment: '' }];
      if (paid) {
        const date = acc.paidAt || (acc.updatedAt || r.approvedAt || '').slice(0, 10);
        r.cuts = [{ id: 'x' + r.id, kind: 'payment', date, amount: r.amount, ref: '', note: '', by: 'fin1', at: acc.updatedAt || r.approvedAt, attachments: [] }];
        r.status = 'closed';
        r.closed = { at: acc.updatedAt || r.approvedAt, by: 'fin1', actual: r.amount, returned: 0, over: 0, note: '' };
      }
    } else if (r.status === 'pending') {
      r.steps = [{ key: 'ctl', label: 'ผู้คุมงบตรวจสอบ', role: 'controller', status: 'waiting' }];
    }
    delete r.accounting;
  }

  /** แปลงคำขอรูปแบบเดิม (1 ใบ = 1 บรรทัด) เป็นแบบหลายบรรทัด + งวดจ่าย โดยไม่ทำให้ข้อมูลหาย */
  /** บริษัทเปลี่ยนรหัส (เช่น PSL → PBI): แก้ข้อมูลที่เก็บไว้ให้ตรง · เลขที่เอกสารที่ออกไปแล้วคงเดิม */
  function renameCompany(d, from, to) {
    const m = d.master || {};
    const comps = m.companies || [];
    if (!comps.some((c) => c.code === from) && !(d.budgets || []).some((b) => b.company === from)) return;
    if (comps.some((c) => c.code === to)) m.companies = comps.filter((c) => c.code !== from);
    else comps.forEach((c) => { if (c.code === from) { c.code = to; c.name = String(c.name || '').split(from).join(to); } });
    const fix = (o, k) => { if (o && o[k] === from) o[k] = to; };
    (m.memoParties || []).forEach((x) => fix(x, 'code'));
    (d.budgets || []).forEach((b) => { fix(b, 'company'); (b.items || []).forEach((it) => fix(it, 'investor')); });
    (d.requests || []).forEach((r) => (r.lines || []).forEach((l) => fix(l, 'investor')));
    (d.changes || []).forEach((c) => (c.lines || []).forEach((l) => fix(l, 'investor')));
  }

  /** OPEX แบบเดิม: Item หลักไม่มีวงเงินของตัวเอง (รวมจากรายการลูก) → ตั้งวงเงิน Item หลัก = ผลรวมของรายการล่างสุดใต้ Item นั้น */
  function rollupCbsMain(b) {
    if (b.type !== 'CBS' || !Array.isArray(b.items) || b.structure === 'project') return;
    b.items.filter((it) => depth(it) === 0 && itemTotal(it) === 0).forEach((it) => {
      const below = b.items.filter((x) => x !== it && x.code.startsWith(it.code + '.') && isLeaf(b, x));
      if (!below.length) return;
      it.amount = round2(below.reduce((sum, x) => sum + Number(x.amount || 0), 0));
      it.vat = round2(below.reduce((sum, x) => sum + Number(x.vat || 0), 0));
    });
  }

  function migrate(d) {
    renameCompany(d, 'PSL', 'PBI');
    ensureMaster(d);
    d.changes = d.changes || [];
    d.log = d.log || [];
    (d.budgets || []).forEach((b) => {
      rollupCbsMain(b);
      b.state = b.state || 'active';
      b.structure = b.structure || 'items';
      b.history = b.history || [];
      b.attachments = b.attachments || [];
      b.revisions = b.revisions || [];
    });
    (d.requests || []).forEach((r) => {
      if (r.lines && r.type === 'CBS' && !r.useType) upgradeCbsRequest(r);
      // OPEX ไม่ใช้ Memo: คำขอที่รอ Memo ไว้ ส่งให้ผู้คุมงบตรวจได้เลย
      if (r.type === 'CBS' && r.status === 'memo') {
        r.status = 'pending';
        delete r.memo;
        delete r.memoParties;
        r.steps = [{ key: 'ctl', label: 'ผู้คุมงบตรวจสอบ', role: 'controller', status: 'waiting' }];
      }
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
    if (REMOTE) { console.error('save() ถูกเรียกในโหมด Supabase — ข้อมูลต้องบันทึกผ่านเซิร์ฟเวอร์'); return; }
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
      return true;
    } catch (e) {
      alert('พื้นที่เก็บข้อมูลในเบราว์เซอร์เต็ม (โหมดทดลองเก็บไฟล์แนบในเบราว์เซอร์) — ลบไฟล์แนบบางไฟล์ หรือรีเซ็ตข้อมูลตัวอย่างที่เมนูมุมขวาบน');
      return false;
    }
  }

  function nextId(prefix) {
    if (REMOTE) {
      // โหมด Supabase: หลายคนสร้างรายการพร้อมกันได้ จึงใช้รหัสสุ่มแทนตัวนับในเครื่อง
      const a = new Uint8Array(6);
      window.crypto.getRandomValues(a);
      return prefix + Array.from(a, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10);
    }
    db.seq.id += 1;
    return prefix + db.seq.id;
  }

  // ---- โหมด Supabase: โหลดข้อมูลจากเซิร์ฟเวอร์ และเรียกฟังก์ชันที่ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์
  let remoteSnapshot = '';
  let adminCounts = { pending: 0 }; // จำนวนผู้ใช้ที่รอกำหนดบทบาท (เห็นเฉพาะผู้ที่มีสิทธิ์จัดการผู้ใช้)

  async function reloadRemote() {
    const d = await window.RemoteApi.load();
    USERS = d.users || [];
    remoteMe = d.me;
    adminCounts = { pending: d.pendingUsers || 0 };
    db = ensureMaster({ seq: { req: 0, id: 0, doc: {} }, master: d.master || {}, budgets: d.budgets || [], requests: d.requests || [] });
    remoteSnapshot = JSON.stringify([USERS, db]);
  }

  /** เรียกเซิร์ฟเวอร์ ถ้าไม่สำเร็จแจ้งผู้ใช้ (หมดเวลา → กลับหน้าล็อกอิน) แล้วคืน null; สำเร็จคืน { value } */
  async function run(fn) {
    document.body.classList.add('busy');
    try {
      return { value: await fn() };
    } catch (e) {
      if (e && e.code === 'AUTH') signedOut('หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่');
      else alert((e && e.message) || 'ทำรายการไม่สำเร็จ');
      return null;
    } finally {
      document.body.classList.remove('busy');
    }
  }

  /** เรียกเซิร์ฟเวอร์แล้วโหลดข้อมูลใหม่ (หลังบันทึก) — คืน { value } หรือ null */
  async function runAndReload(fn) {
    const res = await run(fn);
    if (!res) return null;
    const re = await run(reloadRemote);
    return re ? res : null;
  }

  /**
   * เลขที่เอกสารที่ระบบออกให้: <ตัวย่อเอกสาร>-<ปี ค.ศ.>-<ลำดับ 4 หลัก> เริ่มนับ 0001 ใหม่ทุกปี
   * REQ คำขอดำเนินการใช้งบ · INC คำขอเพิ่มงบ · MEMO บันทึกข้อความ · CAPEX / OPEX ใบดำเนินการใช้งบ · TRF โยกงบ · DEC ลดงบ
   * (เลขที่ฝ่ายอื่นเป็นคนออก เช่น รหัสโครงการ / Item No. / PR / PO / เลขที่มติ / ใบเสร็จ ให้ผู้ใช้กรอกเอง)
   */
  const DOC_PREFIX = { req: 'REQ', inc: 'INC', memo: 'MEMO', CAPEX: 'CAPEX', CBS: 'OPEX', trf: 'TRF', dec: 'DEC' };
  function usedNumbers() {
    const out = [];
    db.requests.forEach((r) => { out.push(r.no, r.docNo, r.memo && r.memo.no); });
    (db.changes || []).forEach((c) => out.push(c.no));
    db.budgets.forEach((b) => (b.history || []).forEach((h) => out.push(h.ref)));
    return out.filter(Boolean);
  }
  function nextNo(prefix, at) {
    const year = new Date(at || Date.now()).getFullYear();
    const head = prefix + '-' + year + '-';
    const key = prefix + '-' + year;
    db.seq.no = db.seq.no || {};
    // กันเลขซ้ำกับเลขที่มีอยู่แล้ว (เช่น ข้อมูลเดิม)
    const used = usedNumbers().filter((n) => String(n).startsWith(head)).map((n) => parseInt(String(n).slice(head.length), 10)).filter((n) => n > 0);
    const n = Math.max(db.seq.no[key] || 0, ...used, 0) + 1;
    db.seq.no[key] = n;
    return head + String(n).padStart(4, '0');
  }
  const nextReqNo = () => nextNo(DOC_PREFIX.req);
  const nextMemoNo = () => nextNo(DOC_PREFIX.memo);
  const nextDocNo = (r, b, at) => nextNo(DOC_PREFIX[r.type] || 'DOC', at);

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
  const me = () => (REMOTE ? remoteMe : (user(currentUserId) || USERS[0]));
  const permsOf = (u) => (u && (u.perms || DEMO_ROLE_PERMS[u.role])) || [];
  const can = (perm) => permsOf(me()).includes(perm);
  /** เห็นงบและคำขอของทุกคน (สิทธิ์ดูทั้งหมด หรือสิทธิ์ที่ต้องทำงานกับเอกสารของคนอื่น) */
  const canViewAll = () => ['budget.view_all', 'budget.manage', 'budget.verify', 'request.decide', 'cut.record', 'po.record'].some(can);
  const roleLabel = (u) => (u && (u.roleName || ROLE_LABEL[u.role] || u.role)) || '';
  const canRequestUser = (x) => (x.canRequest !== undefined ? x.canRequest : permsOf(x).includes('request.create'));
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

  /** รหัสของรายการนี้และรายการย่อยทุกระดับ (CAPEX ไม่มีรายการย่อย = ตัวเอง) */
  function leafIdsUnder(b, it) {
    return b.items.filter((x) => x === it || x.code.startsWith(it.code + '.')).map((x) => x.id);
  }

  // ---- CBS: Item หลัก (1, 2, 3) มีวงเงินของตัวเอง · Item ย่อย (1.1, 2.1) กำหนดวงเงินหรือไม่ก็ได้ (กันส่วนหนึ่งจาก Item หลัก ไม่เกินยอด Item หลัก)
  const parentOf = (b, it) => b.items.filter((x) => x !== it && String(it.code).startsWith(x.code + '.')).sort((x, y) => y.code.length - x.code.length)[0] || null;
  const isMainItem = (b, it) => b.type !== 'CBS' || depth(it) === 0;
  const hasOwnBudget = (b, it) => isMainItem(b, it) || itemTotal(it) > 0;
  const childrenOf = (b, it) => b.items.filter((x) => parentOf(b, x) === it);
  /** รายการที่รวมเป็นยอดงบ: OPEX = Item หลัก · CAPEX = ทุกรายการย่อย */
  const ledgerItems = (b) => (b.type === 'CBS' ? b.items.filter((x) => isMainItem(b, x)) : leaves(b));
  /** Item ที่ถือวงเงินจริงของรายการนี้ (Item ย่อยที่ไม่กำหนดวงเงิน ใช้ของ Item แม่) */
  function budgetNodeOf(b, it) {
    let n = it;
    while (n && b.type === 'CBS' && !hasOwnBudget(b, n)) n = parentOf(b, n) || null;
    return n || it;
  }
  function rootOf(b, it) {
    let n = it;
    while (b.type === 'CBS' && parentOf(b, n)) n = parentOf(b, n);
    return n;
  }
  /** วงเงินที่จัดสรรให้ Item ย่อยแล้ว (Item ย่อยที่ไม่กำหนดวงเงินโปร่งใส: นับของรายการลูก) */
  function allocatedOf(b, it) {
    return round2(childrenOf(b, it).reduce((sum, c) => sum + (hasOwnBudget(b, c) ? itemTotal(c) : allocatedOf(b, c)), 0));
  }
  /** ตรวจว่าวงเงิน Item ย่อยรวมกันไม่เกิน Item แม่: คืนรายการข้อความผิดพลาด */
  function treeErrors(b) {
    const out = [];
    b.items.forEach((it) => {
      if (!hasOwnBudget(b, it)) return;
      const alloc = allocatedOf(b, it);
      if (alloc > itemTotal(it) + 0.005) out.push('วงเงิน Item ย่อยของ ' + it.code + ' รวม ' + money(alloc) + ' เกินวงเงิน Item ' + money(itemTotal(it)) + ' บาท');
    });
    return out;
  }

  function budgetTotal(b) {
    return round2(ledgerItems(b).reduce((s, i) => s + itemTotal(i), 0));
  }

  function snapshotItems(b) {
    return ledgerItems(b).map((i) => ({ code: i.code, name: i.name, total: itemTotal(i) }));
  }

  /**
   * ยอดงบของทั้งงบ หรือของรายการ (รวมรายการลูก)
   * approved = งบที่ได้รับ
   * used = ตัดงบแล้ว (ตามจังหวะตัดงบของแต่ละประเภทการใช้งบ ทั้ง CAPEX และ OPEX)
   * reserved = จองไว้ (รอผู้คุมงบตรวจสอบ หรือออกเอกสารแล้วแต่ยังไม่ตัดงบ) — ยังหักออกจากยอดคงเหลือเพื่อกันใช้ซ้ำ
   */
  function usage(b, itemId) {
    let ids = null;
    let approved;
    if (itemId) {
      const it0 = itemById(b, itemId);
      if (!it0) return { approved: 0, used: 0, reserved: 0, remaining: 0 };
      const it = budgetNodeOf(b, it0);
      ids = leafIdsUnder(b, it);
      approved = itemTotal(it);
    } else {
      approved = budgetTotal(b);
    }
    return usageCalc(b, ids, approved);
  }
  /** ยอดใช้ / จองของ Item และรายการย่อยทั้งหมดใต้ Item นั้น (ใช้แสดง Item ย่อยที่ไม่กำหนดวงเงิน) */
  function usageOwn(b, it) {
    const u = usageCalc(b, leafIdsUnder(b, it), itemTotal(it));
    return { used: u.used, reserved: u.reserved };
  }
  /** คงเหลือจริงของรายการที่เลือก = ต่ำสุดของ Item ที่มีวงเงินในสายเดียวกัน (เช่น Item ย่อยที่กำหนดวงเงิน และ Item หลัก) ไม่นับยอดที่ ownReq จองไว้เอง */
  function remainingFor(b, itemId, ownReq) {
    let it = itemById(b, itemId);
    if (!it) return 0;
    let best = Infinity;
    while (it) {
      if (hasOwnBudget(b, it)) {
        const own = ownReq && isReserving(ownReq) ? linesAmount(ownReq, leafIdsUnder(b, it)) : 0;
        best = Math.min(best, round2(usage(b, it.id).remaining + own));
      }
      it = b.type === 'CBS' ? parentOf(b, it) : null;
    }
    return best === Infinity ? 0 : best;
  }
  function usageCalc(b, ids, approved) {
    let used = 0;
    let reserved = 0;
    db.requests.forEach((r) => {
      if (r.budgetId !== b.id || !['memo', 'pending', 'approved', 'closed'].includes(r.status)) return;
      const amt = linesAmount(r, ids);
      if (!amt) return;
      // ตัดงบตามรายการตัดงบจริงของแต่ละประเภท · ส่วนที่ยังไม่ตัดยังจองไว้ · ปิดยอดแล้วคืนส่วนต่าง
      // ใบที่มีหลายรายการต้นทุน (OPEX) แบ่งยอดที่ตัดตามสัดส่วนยอดของบรรทัดในรายการนั้น
      const cut = r.amount > 0 ? cutTotal(r) * (amt / r.amount) : 0;
      if (isReserving(r)) reserved += amt;
      else {
        used += cut;
        if (r.status === 'approved') reserved += Math.max(amt - cut, 0);
      }
    });
    used = round2(used);
    reserved = round2(reserved);
    return { approved, used, reserved, remaining: round2(approved - used - reserved) };
  }

  /** ทั้ง CAPEX และ OPEX ต้องผ่านผู้คุมงบตรวจสอบก่อนออกใบดำเนินการใช้งบ */
  function stepsFor(budget) {
    return [{ key: 'ctl', label: 'ผู้คุมงบตรวจสอบ', role: 'controller', status: 'waiting' }];
  }

  /** คำขอที่ยังรอ (รอแนบ Memo / รอผู้คุมงบตรวจ) — ยอดทั้งใบยังจองไว้ */
  const isReserving = (r) => r.status === 'pending' || r.status === 'memo';
  const currentStep = (r) => (r.status === 'pending' ? r.steps.find((s) => s.status === 'waiting') : null);
  const canAct = (u, step) => !!step && (step.assignee === u.id || permsOf(u).includes('request.decide'));
  const stepAssigneeText = (step) => (step.assignee ? userName(step.assignee) : ROLE_LABEL[step.role]);
  const inbox = (u) => db.requests.filter((r) => canAct(u, currentStep(r)));

  // ---- คำขอเบิก: 1 ใบมีได้หลายบรรทัด (CAPEX ทุกบรรทัดอยู่ใต้รายการย่อยเดียวกัน, OPEX แต่ละบรรทัดเลือกรายการต้นทุนเองได้)
  const lineTotal = (l) => round2(Number(l.amountBeforeVat || 0) + Number(l.vat || 0));
  /** ยอดของบรรทัดที่อยู่ในรายการ ids (null = ทุกบรรทัด) */
  const linesAmount = (r, ids) => round2(r.lines.filter((l) => !ids || ids.includes(l.itemId)).reduce((s, l) => s + l.amount, 0));
  const reqItemIds = (r) => uniq(r.lines.map((l) => l.itemId));
  const paidTotal = (r) => round2((r.payments || []).reduce((s, p) => s + p.amount, 0));
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
  // ---- การตัดงบตามประเภทการใช้งบ (CAPEX และ OPEX)
  const cutTotal = (r) => round2((r.cuts || []).reduce((s, c) => s + Number(c.amount || 0), 0));
  const hasPO = (r) => (r.cuts || []).some((c) => c.kind === 'po');
  /** จัดซื้อต้องบันทึก PO */
  const needsPO = (r) => r.status === 'approved' && r.useType === 'prpo' && !hasPO(r);
  /** ผู้คุมงบต้องบันทึกการตัดงบหรือปิดยอด */
  const needsCut = (r) => r.status === 'approved' && !needsPO(r);
  /** ข้อความสถานะของเอกสาร */
  function statusText(r) {
    if (r.status === 'approved') return 'ออกใบดำเนินการใช้งบแล้ว';
    return STATUS_LABEL[r.status] || r.status;
  }
  const isActive = (b) => !b.state || b.state === 'active';
  /** หลักฐานการอนุมัติงบ: CAPEX = มติที่ประชุม (เข้าบอร์ด) · OPEX = เอกสารอนุมัติจากผู้บริหาร (ไม่ต้องเข้าบอร์ด) */
  function apprOf(type) {
    return type === 'CBS'
      ? { exec: true, title: 'การอนุมัติจากผู้บริหาร', file: 'ไฟล์เอกสารอนุมัติ', no: 'เลขที่เอกสารอนุมัติ', noEx: 'เช่น อนุมัติ MD-12/' + new Date().getFullYear(),
          date: 'วันที่ผู้บริหารอนุมัติ', note: 'หมายเหตุจากผู้บริหาร (ถ้ามี)', by: 'ผู้บริหารที่อนุมัติ', byEx: 'ชื่อ / ตำแหน่ง เช่น กรรมการผู้จัดการ',
          step: 'ผู้บริหารอนุมัติ / แนบหลักฐาน', route: 'เสนอผู้บริหารอนุมัติ', empty: 'ยังไม่ได้แนบเอกสารอนุมัติ', none: 'ยังไม่มีข้อมูลการอนุมัติ',
          verify: 'ตรวจเอกสารอนุมัติ', short: 'เอกสารอนุมัติผู้บริหาร', form: 'แบบขออนุมัติงบประมาณ (เสนอผู้บริหาร)', result: 'ผลการพิจารณาของผู้บริหาร',
          meet: 'วันที่ผู้บริหารอนุมัติ' }
      : { exec: false, title: 'มติที่ประชุม', file: 'ไฟล์มติที่ประชุม', no: 'เลขที่มติ', noEx: 'เช่น มติที่ 10/' + new Date().getFullYear(),
          date: 'วันที่ประชุม', note: 'หมายเหตุจากที่ประชุม (ถ้ามี)', step: 'เข้าที่ประชุม / แนบมติ', route: 'เข้าที่ประชุม', empty: 'ยังไม่ได้แนบมติ', none: 'ยังไม่มีข้อมูลมติ',
          verify: 'ตรวจมติ', short: 'มติที่ประชุม', form: 'แบบขออนุมัติงบประมาณ (เข้าที่ประชุม)', result: 'ผลการพิจารณาของที่ประชุม', meet: 'ประชุมวันที่' };
  }
  const apprNoOf = (o) => (o && o.meeting && o.meeting.no) || '';
  const apprMetaText = (a, m) => (m && m.date ? ' · ' + (a.exec ? 'อนุมัติวันที่ ' : 'ประชุมวันที่ ') + fmtDay(m.date) : '') + (m && m.by ? ' · ' + esc(m.by) : '');
  const CHANGE_STATE = { draft: 'ร่าง', review: 'รอผู้คุมงบตรวจสอบ', returned: 'ส่งกลับแก้ไข', approved: 'เพิ่มงบแล้ว', cancelled: 'ยกเลิก' };
  const CHANGE_STATE_BADGE = { draft: 'draft', review: 'pending', returned: 'rejected', approved: 'approved', cancelled: 'cancelled' };
  const changeById = (id) => (db.changes || []).find((c) => c.id === id);
  const changeTotal = (c) => round2((c.lines || []).reduce((s, l) => s + Number(l.amount || 0), 0));
  /** เพิ่ม/ลดวงเงินของรายการ (OPEX ที่มี VAT ปรับตามสัดส่วนเดิม) */
  function adjustItem(it, delta) {
    const total = itemTotal(it);
    if (Number(it.vat) > 0 && total > 0) {
      const ratio = Number(it.amount) / total;
      const amount = round2(Number(it.amount) + delta * ratio);
      it.vat = round2(total + delta - amount);
      it.amount = amount;
    } else {
      it.amount = round2(Number(it.amount || 0) + delta);
    }
  }
  function addRevision(b, note) {
    b.revisions = b.revisions || [];
    b.revisions.push({ no: b.revisions.length, at: new Date().toISOString(), by: me().id, note, total: budgetTotal(b), items: snapshotItems(b) });
  }
  const docTitle = () => 'ใบดำเนินการใช้งบ';

  // ---- ประวัติและ Log (เพิ่มได้อย่างเดียว)
  function logAction(action, ref, detail) {
    db.log = db.log || [];
    db.log.push({ at: new Date().toISOString(), by: me().id, action, ref: ref || '', detail: detail || '' });
  }
  /** บันทึกเหตุการณ์ลงประวัติของเรื่อง (งบ / คำขอเพิ่มงบ / ใบดำเนินการ) และลง Log */
  function addHistory(obj, action, note, ref) {
    obj.history = obj.history || [];
    obj.history.push({ at: new Date().toISOString(), by: me().id, action, note: note || '' });
    logAction(action, ref, note);
  }
  function addEvent(r, action, note) {
    r.events = r.events || [];
    r.events.push({ at: new Date().toISOString(), by: me().id, action, note: note || '' });
    logAction(action, r.docNo || r.no, note);
  }

  function badge(cls, text) {
    return '<span class="badge ' + esc(cls) + '">' + esc(text) + '</span>';
  }

  function usageBar(u) {
    const pct = (v) => (u.approved > 0 ? Math.min(100, (v / u.approved) * 100) : 0);
    return '<div class="bar" role="img" aria-label="ตัดงบแล้ว ' + money(u.used) + ' จองไว้ ' + money(u.reserved) + '">' +
      '<div class="used" style="width:' + pct(u.used) + '%"></div>' +
      '<div class="reserved" style="width:' + pct(u.reserved) + '%"></div></div>' +
      '<div class="legend"><span><i class="l-used"></i>ตัดงบแล้ว</span>' +
      '<span><i class="l-reserved"></i>จองไว้ (ยังไม่ตัดงบ)</span>' +
      '<span><i class="l-left"></i>คงเหลือ</span></div>';
  }

  function usageKv(u) {
    return '<dl class="kv">' +
      '<dt>งบที่ได้รับอนุมัติ</dt><dd>' + money(u.approved) + '</dd>' +
      '<dt>ตัดงบแล้ว (บัญชีจ่ายแล้ว)</dt><dd>' + money(u.used) + '</dd>' +
      '<dt>จองไว้ (ยังไม่ตัดงบ)</dt><dd>' + money(u.reserved) + '</dd>' +
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

  /** ตัวเลือกจากข้อมูลหลัก — ถ้าค่าปัจจุบันไม่มีในรายการ (เช่น ถูกลบไปแล้ว) ยังคงแสดงไว้ไม่ให้ข้อมูลเดิมหาย */
  function optList(items, key, labelFn, selected) {
    const known = items.some((x) => String(x[key]) === String(selected));
    return (selected && !known ? opt(selected, selected, selected) : '') +
      items.map((x) => opt(x[key], labelFn(x), selected)).join('');
  }
  const opt = (v, label, sel) => '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(label) + '</option>';

  // ---------------------------------------------------------------- navigation

  function homeFor(u) {
    const has = (p) => permsOf(u).includes(p);
    if (has('user.manage')) return '#/admin';
    if (has('master.manage') || has('log.view')) return '#/master';
    if (has('budget.verify') || has('request.decide') || has('po.record') || has('cut.record')) return '#/tasks';
    if (has('request.create') || has('budget.create')) return '#/my-budgets';
    return '#/dashboard';
  }

  /** ไอคอนเมนู (เส้น 24×24) ให้ตรงกับชื่อเมนู */
  const NAV_ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    tasks: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M8.5 12l2.2 2.2L15.5 9.5"/><path d="M9 17.5h6"/>',
    budgets: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M15.5 14h4.5"/><circle cx="16" cy="14" r=".8" fill="currentColor"/>',
    requests: '<path d="M6 3h9l3 3v15l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3L6 21z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
    master: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6.5c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V5.5"/><path d="M4.5 12v6.5c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V12"/>',
    log: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/>',
    admin: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/>',
    export: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 12l6 6M15 12l-6 6"/>',
    assumptions: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8v.5"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>'
  };
  const navIcon = (k) => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (NAV_ICONS[k] || NAV_ICONS.dashboard) + '</svg>';

  function renderNav(route) {
    const u = me();
    const count = (n) => (n ? '<span class="count">' + n + '</span>' : '');
    const links = [];
    // [ไอคอน, href, ข้อความ, เส้นทางที่ให้ไฮไลต์เมนูนี้]
    links.push(['dashboard', '#/dashboard', 'ภาพรวม', ['#/dashboard']]);
    const tabs = taskTabs(u);
    if (tabs.length) links.push(['tasks', '#/tasks', 'งานทั้งหมด' + count(tabs.reduce((n, t) => n + (t.act ? t.n : 0), 0)), ['#/tasks', '#/approvals', '#/po', '#/cuts', '#/accounting', '#/payments']]);
    if (canViewAll()) links.push(['budgets', '#/budgets', 'งบประมาณ', ['#/budgets', '#/budget/', '#/change/', '#/adjust']]);
    else if (can('request.create') || can('budget.create')) links.push(['budgets', '#/my-budgets', 'งบประมาณ', ['#/my-budgets', '#/budget/', '#/request/new', '#/change/', '#/adjust']]);
    if (canViewAll() || can('request.create')) links.push(['requests', '#/requests', 'รายการดำเนินการใช้งบ', ['#/requests', '#/request/', '#/doc/']]);
    if (isWorker(u)) links.push(['history', '#/history', 'ประวัติการทำรายการ', ['#/history']]);
    if (can('master.manage')) {
      links.push(['master', '#/master', 'ข้อมูลหลัก', ['#/master']]);
      if (route.startsWith('#/master')) {
        const cur = route.split('/')[2] || MASTER_NAV[0][0];
        MASTER_NAV.forEach(([k, t]) => links.push(['sub', '#/master/' + k, t, [], k === cur]));
      }
    }
    if (can('data.export')) links.push(['export', '#/export', 'ส่งออกข้อมูล (Excel)', ['#/export']]);
    if (can('log.view')) links.push(['log', '#/log', 'Log การทำงาน', ['#/log']]);
    if (can('user.manage')) links.push(['admin', '#/admin', 'ผู้ใช้และสิทธิ์' + count(REMOTE ? adminCounts.pending : 0), ['#/admin']]);
    links.push(['assumptions', '#/assumptions', 'สิ่งที่รอยืนยัน', ['#/assumptions']]);
    let activeDone = false;
    document.getElementById('nav').innerHTML = links.map(([icon, href, text, prefixes, subActive]) => {
      if (icon === 'sub') return '<a class="sub' + (subActive ? ' sub-active' : '') + '" href="' + href + '"' + (subActive ? ' aria-current="page"' : '') + '><span>' + text + '</span></a>';
      const active = !activeDone && prefixes.some((p) => route.startsWith(p));
      if (active) activeDone = true;
      return '<a href="' + href + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + navIcon(icon) + '<span>' + text + '</span></a>';
    }).join('');
  }

  // ---------------------------------------------------------------- budget list

  // ตัวกรองหน้ารายการงบ จำค่าไว้ตอนสลับแท็บ
  const budgetFilter = { q: '', dept: '', year: '', state: '' };

  const ICON_SEARCH = '<svg class="lead" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_CAL = '<svg class="trail" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function budgetSubline(b, mine) {
    const parts = [b.company, b.department, 'ปีงบ ' + b.fiscalYear];
    if (!mine) parts.push(userName(b.ownerId));
    return parts.filter(Boolean).map(esc).join(' · ');
  }

  function viewBudgets(params, mineRoute) {
    const u = me();
    const mine = !!mineRoute || !canViewAll();
    const all = db.budgets.filter((b) => !mine || b.ownerId === u.id);
    const count = (t) => (t === 'ALL' ? all.length : all.filter((b) => b.type === t).length);
    const type = TYPE_LABEL[params.get('type')] ? params.get('type') : 'ALL';
    const list = type === 'ALL' ? all : all.filter((b) => b.type === type);
    const base = mine ? '#/my-budgets' : '#/budgets';
    const tab = (t, label) => '<a href="' + base + (t === 'ALL' ? '' : '?type=' + t) + '"' + (type === t ? ' class="active" aria-current="page"' : '') + '>' +
      label + '<span class="tab-count">(' + count(t) + ')</span></a>';
    const depts = uniq(all.map((b) => b.department)).sort();
    const years = uniq(all.map((b) => String(b.fiscalYear))).sort().reverse();
    const title = 'งบประมาณ';
    const states = Object.keys(BUDGET_STATE).filter((s) => all.some((b) => (b.state || 'active') === s));

    let html = '<div class="page-head"><h1>' + title + '</h1>' +
      '<span class="pill">' + esc(u.title) + '</span></div>' + takeFlash() +
      '<nav class="tabs" aria-label="ประเภทงบ">' + tab('ALL', 'ทั้งหมด') + tab('CAPEX', 'งบลงทุน (CAPEX)') + tab('CBS', 'งบดำเนินงาน (OPEX)') + '</nav>' +
      '<div class="filters">' +
      '<label class="input-wrap search">' + ICON_SEARCH +
      '<input id="fSearch" type="search" placeholder="ค้นหาชื่องบ รหัส หรือหน่วยงาน" aria-label="ค้นหา" value="' + esc(budgetFilter.q) + '"></label>' +
      '<label class="input-wrap select-wrap"><select id="fDept" aria-label="หน่วยงาน">' + opt('', 'หน่วยงาน: ทั้งหมด', budgetFilter.dept) +
      depts.map((d) => opt(d, 'หน่วยงาน: ' + d, budgetFilter.dept)).join('') + '</select></label>' +
      '<label class="input-wrap"><select id="fYear" aria-label="ปีงบประมาณ">' + opt('', 'ปี: ทั้งหมด', budgetFilter.year) +
      years.map((y) => opt(y, 'ปี: ' + y, budgetFilter.year)).join('') + '</select>' + ICON_CAL + '</label>' +
      '<label class="input-wrap select-wrap"><select id="fState" aria-label="สถานะงบ">' + opt('', 'สถานะ: ทั้งหมด', budgetFilter.state) +
      states.map((s) => opt(s, 'สถานะ: ' + BUDGET_STATE[s], budgetFilter.state)).join('') + '</select></label>' +
      (can('budget.create') && mine
        ? '<a class="btn primary tall" href="#/budget/new"><span aria-hidden="true">+</span> ขออนุมัติงบใหม่</a>'
        : can('budget.manage') && !mine
          ? '<a class="btn tall" href="#/budget/new"><span aria-hidden="true">+</span> นำเข้างบที่อนุมัติแล้ว</a>'
          : '<span></span>') +
      '</div>';

    if (!list.length) {
      return html + '<div class="card empty">' +
        (mine ? 'ยังไม่มี' + (TYPE_LABEL[type] || 'งบ') + 'ของคุณ — กด "ขออนุมัติงบใหม่" เพื่อเริ่ม' : 'ยังไม่มี' + (TYPE_LABEL[type] || 'งบประมาณ')) + '</div>';
    }

    html += '<div class="grid" id="budgetGrid">' + list.map((b) => {
      const us = usage(b);
      const search = [b.name, b.code, b.parentCode, b.department, b.company, userName(b.ownerId)]
        .concat(b.items.map((i) => i.code + ' ' + i.name)).join(' ').toLowerCase();
      const sub = b.structure === 'project' ? 'งบรวมโครงการ' : b.type === 'CAPEX' ? b.items.length + ' รายการย่อย' : ledgerItems(b).length + ' Item หลัก';
      const state = b.state || 'active';
      const active = state === 'active';
      const own = b.ownerId === u.id;
      return '<article class="card budget-card' + (active ? '' : ' not-active') + '" data-search="' + esc(search) + '" data-dept="' + esc(b.department) +
        '" data-year="' + esc(b.fiscalYear) + '" data-state="' + state + '">' +
        '<div class="card-head"><div><h3>' + esc(b.name) + '</h3><div class="code">' + esc(b.code) + ' · ' + sub + '</div></div>' +
        '<div class="card-badges">' + badge(b.type + ' lg', TYPE_SHORT[b.type]) + (active ? '' : badge(BUDGET_STATE_BADGE[state], BUDGET_STATE[state])) + '</div></div>' +
        '<div class="card-body"><p class="card-sub">' + budgetSubline(b, mine) + '</p>' +
        (active ? usageKv(us) : '<dl class="kv"><dt>วงเงินที่ขออนุมัติ</dt><dd class="big">' + money(budgetTotal(b)) + '</dd>' +
          (b.meeting && b.meeting.no ? '<dt>' + apprOf(b.type).short + '</dt><dd>' + esc(b.meeting.no) + '</dd>' : '') + '</dl>') + '</div>' +
        (active ? '<div class="usage-strip">' + usageBar(us) + '</div>' : '') +
        '<div class="card-foot">' +
        '<a class="btn" href="#/budget/' + b.id + '">รายละเอียด</a>' +
        (own && (state === 'draft' || state === 'returned') ? '<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไขร่าง</a>' : '') +
        (state === 'review' && can('budget.verify') ? '<a class="btn primary" href="#/budget/' + b.id + '">ตรวจสอบ</a>' : '') +
        (active && own && can('request.create') ? '<a class="btn primary" href="#/request/new/' + b.id + '">ขอดำเนินการใช้งบ</a>' : '') +
        (active && can('budget.adjust') ? '<a class="btn" href="#/adjust?budget=' + b.id + '">โยก / ลดงบ</a>' : '') +
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
    const st = document.getElementById('fState');
    const apply = () => {
      budgetFilter.q = q.value;
      budgetFilter.dept = dept.value;
      budgetFilter.year = year.value;
      budgetFilter.state = st.value;
      if (!grid) return;
      const term = q.value.trim().toLowerCase();
      let shown = 0;
      grid.querySelectorAll('.budget-card').forEach((card) => {
        const ok = (!term || card.dataset.search.includes(term)) &&
          (!dept.value || card.dataset.dept === dept.value) &&
          (!year.value || card.dataset.year === year.value) &&
          (!st.value || card.dataset.state === st.value);
        card.hidden = !ok;
        if (ok) shown += 1;
      });
      document.getElementById('noMatch').hidden = shown > 0;
    };
    q.addEventListener('input', apply);
    dept.addEventListener('change', apply);
    year.addEventListener('change', apply);
    st.addEventListener('change', apply);
    apply();
  }

  // ---------------------------------------------------------------- budget form (finance)

  const usedItemIds = () => new Set([].concat(...db.requests.map(reqItemIds)));

  function capexRow(it, locked) {
    return '<tr data-item-id="' + esc(it.id || '') + '">' +
      '<td><input name="itCode" value="' + esc(it.code) + '" placeholder="2026-01-XX001" aria-label="รหัสรายการย่อย"></td>' +
      '<td><input name="itName" value="' + esc(it.name) + '" aria-label="ชื่อรายการ"></td>' +
      '<td><div class="select-wrap"><select name="itAsset" aria-label="ประเภทสินทรัพย์">' +
      optList(db.master.assetTypes, 'name', (t) => t.name, it.assetType || assetTypeList()[0]) + '</select></div></td>' +
      '<td><div class="select-wrap"><select name="itDoa" aria-label="หมวด DOA">' + opt('2.4', '2.4 สินทรัพย์ลงทุน', it.doa) +
      opt('2.5', '2.5 ดำเนินงานทั่วไป', it.doa || '2.5') + '</select></div></td>' +
      '<td>' + investorSelect('itInv', it.investor) + '</td>' +
      '<td><input name="itAmount" type="number" min="0" step="0.01" class="right" value="' + esc(it.amount) + '" aria-label="วงเงิน"></td>' +
      '<td>' + (locked ? '<span class="muted" title="มีการเบิกใช้แล้ว ลบไม่ได้">🔒</span>' : '<button type="button" class="btn small bad" data-remove-item title="ลบ">×</button>') + '</td></tr>';
  }

  function cbsRow(it, locked) {
    return '<tr data-item-id="' + esc(it.id || '') + '">' +
      '<td><input name="itCode" value="' + esc(it.code) + '" placeholder="1.1" aria-label="รหัส"></td>' +
      '<td><input name="itName" value="' + esc(it.name) + '" aria-label="รายการ"></td>' +
      '<td><input name="itAmount" type="number" min="0" step="0.01" class="right" value="' + esc(it.amount || '') + '" aria-label="ก่อน VAT"></td>' +
      '<td class="center"><input name="itVat" type="checkbox"' + (Number(it.vat) > 0 ? ' checked' : '') + ' aria-label="VAT 7%"></td>' +
      '<td><input name="itGl" list="glList" value="' + esc(it.glCode) + '" aria-label="GL Code"></td>' +
      '<td><input name="itGlName" value="' + esc(it.glName) + '" aria-label="GL Name"></td>' +
      '<td>' + investorSelect('itInv', it.investor) + '</td>' +
      '<td>' + (locked ? '<span class="muted" title="มีการเบิกใช้แล้ว ลบไม่ได้">🔒</span>' : '<button type="button" class="btn small bad" data-remove-item title="ลบ">×</button>') + '</td></tr>';
  }

  // Item หลักของ OPEX (Item ย่อย 1.1, 2.1 เพิ่มภายหลังเมื่องบเปิดใช้แล้ว)
  const CBS_TEMPLATE = [
    { code: '1', name: 'ต้นทุนวัตถุดิบ' }, { code: '2', name: 'ต้นทุนค่าแรง' },
    { code: '3', name: 'ต้นทุนค่าเช่า' }, { code: '4', name: 'รายการส่วนเพิ่มอื่นๆ' }
  ];

  /** ใครสร้าง/แก้ฟอร์มงบได้: Business = ร่างของตน (ร่าง/ส่งกลับ) · ผู้คุมงบ = นำเข้างบที่อนุมัติแล้ว (เปิดใช้ทันที) */
  function budgetFormMode(b) {
    const u = me();
    if (b) return (b.state === 'draft' || b.state === 'returned') && b.ownerId === u.id ? 'draft' : null;
    if (can('budget.create')) return 'draft';
    if (can('budget.manage')) return 'import';
    return null;
  }

  function viewBudgetForm(id) {
    const b = id ? budgetById(id) : null;
    if (id && !b) return notFound();
    const mode = budgetFormMode(b);
    if (!mode) {
      return '<div class="alert error">' + (b ? 'แก้ไขได้เฉพาะร่างหรืองบที่ถูกส่งกลับ ของผู้สร้างเท่านั้น — งบที่เปิดใช้แล้วปรับได้ผ่าน "ขอเพิ่มงบ" หรือผู้คุมงบโยก/ลดงบ'
        : 'ไม่มีสิทธิ์สร้างงบ') + '</div>';
    }
    const u = me();
    const year = new Date().getFullYear();
    const v = b || {
      type: 'CAPEX', structure: 'items', company: (db.master.companies[0] || {}).code || '', fiscalYear: year + 1, group: '', code: '', parentCode: '', name: '',
      department: '', ownerId: mode === 'import' ? '' : u.id, note: '', status: 'Plan', startDate: '', endDate: '', production: {}, items: []
    };
    const structure = v.structure || 'items';
    const projItem = structure === 'project' && v.items[0] ? v.items[0] : {};
    const requesters = USERS.filter(canRequestUser);
    const capexItems = v.type === 'CAPEX' && structure === 'items' && v.items.length ? v.items : [{ code: '', name: '', amount: '' }];
    const cbsMain = v.type === 'CBS' ? sortedItems(v).filter((x) => depth(x) === 0) : [];
    const cbsItems = cbsMain.length ? cbsMain : CBS_TEMPLATE;
    const field = (label, inner, extra) => '<label class="field"' + (extra || '') + '><span>' + label + '</span>' + inner + '</label>';
    const select = (name, inner, attrs) => '<div class="select-wrap"><select name="' + name + '"' + (attrs || '') + '>' + inner + '</select></div>';
    const radio = (value, title, sub) => '<label class="choice-opt"><input type="radio" name="structure" value="' + value + '"' + (structure === value ? ' checked' : '') + '>' +
      '<span><strong>' + title + '</strong><small>' + sub + '</small></span></label>';
    const title = b ? 'แก้ไขร่างคำขออนุมัติงบ ' + esc(b.code) : mode === 'import' ? 'นำเข้างบที่อนุมัติแล้ว' : 'ขออนุมัติงบใหม่';
    const introFor = (type) => mode === 'import'
      ? 'สำหรับบันทึกงบที่ผ่านการอนุมัติมาก่อนเริ่มใช้ระบบ — งบจะเปิดใช้งานทันทีเมื่อบันทึก'
      : (type === 'CBS'
        ? 'บันทึกเป็นร่างก่อน → พิมพ์แบบฟอร์มเสนอผู้บริหาร (OPEX ไม่ต้องเข้าบอร์ด) → เมื่อผู้บริหารอนุมัติ แนบเอกสารอนุมัติแล้วส่งให้ผู้คุมงบยืนยันเปิดใช้ (ถ้าผู้บริหารอนุมัติไม่เต็มจำนวน ให้แก้ตัวเลขในร่างก่อนส่ง)'
        : 'บันทึกเป็นร่างก่อน → พิมพ์แบบฟอร์มเข้าที่ประชุม → เมื่อที่ประชุมอนุมัติ แนบมติแล้วส่งให้ผู้คุมงบยืนยันเปิดใช้ (ถ้าที่ประชุมอนุมัติไม่เต็มจำนวน ให้แก้ตัวเลขในร่างก่อนส่ง)');

    const intro = introFor(v.type);
    return '<div class="page-head"><div><h1>' + title + '</h1><div class="page-sub" id="budgetIntro" data-capex="' + esc(introFor('CAPEX')) + '" data-cbs="' + esc(introFor('CBS')) + '">' + intro + '</div></div></div>' +
      '<div id="formError"></div>' +
      '<form id="budgetForm" class="card" data-id="' + esc(id || '') + '" data-mode="' + mode + '">' +
      '<datalist id="glList">' + db.master.glCodes.map((g) => '<option value="' + esc(g.code) + '">' + esc(g.name) + '</option>').join('') + '</datalist>' +
      '<div class="row">' +
      field('ประเภทงบ', select('type', ['CAPEX', 'CBS'].map((t) => opt(t, TYPE_LABEL[t], v.type)).join(''))) +
      field('บริษัท', select('company', optList(db.master.companies, 'code', (c) => c.code + (c.name ? ' — ' + c.name : ''), v.company))) +
      field('ปีงบประมาณ', '<input name="fiscalYear" type="number" required value="' + esc(v.fiscalYear) + '">') +
      field('กลุ่มงบประมาณ', select('group', '<option value="">— เลือก —</option>' +
        optList(db.master.groups, 'code', (g) => g.code + (g.name ? ' — ' + g.name : ''), v.group))) +
      '</div>' +
      '<div class="row">' +
      field('รหัสโครงการ (Project No.)', '<input name="code" required value="' + esc(v.code) + '">') +
      field('ชื่อโครงการ / ชื่องบ', '<input name="name" required value="' + esc(v.name) + '">') +
      '</div>' +
      '<div class="row">' +
      field('หน่วยงาน', select('department', '<option value="">— เลือก —</option>' + optList(db.master.departments, 'name', (d) => d.name, v.department), ' required')) +
      (mode === 'import'
        ? field('Business เจ้าของงบ', select('ownerId', '<option value="">— เลือก —</option>' + requesters.map((x) => opt(x.id, x.name + (x.title ? ' — ' + x.title : ''), v.ownerId)).join(''), ' required'))
        : '<input type="hidden" name="ownerId" value="' + esc(v.ownerId) + '"><div class="field"><span>Business เจ้าของงบ</span><div class="out left">' + esc(userName(v.ownerId)) + '</div></div>') +
      '</div>' +
      (mode === 'import'
        ? '<div class="row">' + field('วันที่อนุมัติ / ประชุม', '<input name="meetingDate" type="date">') +
          field('เลขที่มติ / เอกสารอนุมัติ', '<input name="meetingNo" required placeholder="เช่น มติที่ 1/2569 หรือ เอกสารอนุมัติผู้บริหาร">') +
          field('ผู้บริหารที่อนุมัติ (OPEX)', '<input name="meetingBy" placeholder="ชื่อ / ตำแหน่ง">', ' data-for="CBS"') + '</div>'
        : '') +

      '<fieldset data-for="CAPEX"><legend>โครงสร้างงบ</legend><div class="choice">' +
      radio('items', 'แยกรายการย่อย', 'คุมวงเงินรายรายการ เหมาะกับงบที่รู้รายละเอียดแล้ว') +
      radio('project', 'งบรวมทั้งโครงการ', 'ยังไม่แยกรายการ — ตอนใช้งบเลือกหมวดค่าใช้จ่ายแทน คุมวงเงินที่ระดับโครงการ') + '</div>' +
      '<div class="row" data-structure="project">' +
      field('วงเงินรวมทั้งโครงการ (รวม VAT)', '<input name="projAmount" type="number" min="0" step="0.01" class="right" value="' + esc(projItem.amount || '') + '">') +
      field('หมวด DOA', select('projDoa', opt('2.4', '2.4 สินทรัพย์ลงทุน', projItem.doa) + opt('2.5', '2.5 ดำเนินงานทั่วไป', projItem.doa || '2.5')), ' data-for="CAPEX"') +
      field('ประเภทสินทรัพย์หลัก', select('projAsset', optList(db.master.assetTypes, 'name', (t) => t.name, projItem.assetType || assetTypeList()[0])), ' data-for="CAPEX"') +
      '</div></fieldset>' +

      '<fieldset data-for="CAPEX" data-structure="items"><legend>รายการย่อย (Item No.)</legend>' +
      '<div class="table-wrap"><table class="edit-table"><thead><tr><th style="width:11rem">รหัสรายการย่อย</th><th style="min-width:14rem">ชื่อรายการ</th>' +
      '<th style="width:10rem">ประเภทสินทรัพย์</th><th style="width:10rem">หมวด DOA</th><th style="width:7rem">บริษัทที่ลงทุน</th><th class="num" style="width:10rem">วงเงิน (รวม VAT)</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="capexRows">' + capexItems.map((it) => capexRow(Object.assign({}, it, { investor: it.investor || v.company }), false)).join('') + '</tbody></table></div>' +
      '<div class="actions table-actions"><button type="button" class="btn small" data-add-row="capex">+ เพิ่มรายการย่อย</button>' +
      '<span class="muted">รวม <strong data-total="capex">0.00</strong> บาท</span></div></fieldset>' +

      '<fieldset data-for="CBS" data-structure="items"><legend>Item ของงบ OPEX</legend>' +
      '<p class="muted small-note">งบ OPEX ต้องมี Item — กรอก <strong>Item หลัก</strong> (รหัส 1, 2, 3 …) พร้อมวงเงินของแต่ละ Item (ไม่ต้องกรอกจำนวน/หน่วย) · <strong>Item ย่อย</strong> 2 ระดับ (1.1 และ 1.1.1) พร้อมจำนวน/หน่วย เพิ่มได้เรื่อย ๆ ภายหลังเมื่องบเปิดใช้แล้ว ที่หน้ารายละเอียดงบ (วงเงินรวมไม่เกิน Item หลัก และจะกำหนดวงเงินหรือไม่ก็ได้)</p>' +
      '<div class="table-wrap"><table class="edit-table"><thead><tr><th style="width:5.5rem">รหัส</th><th style="min-width:12rem">รายการ</th>' +
      '<th class="num" style="width:9rem">ก่อน VAT</th><th style="width:4rem">VAT 7%</th>' +
      '<th style="width:7rem">GL Code</th><th style="width:10rem">GL Name</th><th style="width:7rem">บริษัทที่ลงทุน</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="cbsRows">' + cbsItems.map((it) => cbsRow(Object.assign({}, it, { investor: it.investor || v.company }), false)).join('') + '</tbody></table></div>' +
      '<div class="actions table-actions"><button type="button" class="btn small" data-add-row="cbs">+ เพิ่มรายการ</button>' +
      '<span class="muted">รวม (รวม VAT) <strong data-total="cbs">0.00</strong> บาท</span></div></fieldset>' +

      field('หมายเหตุ / ความจำเป็นของโครงการ', '<textarea name="note">' + esc(v.note) + '</textarea>') +
      '<div class="actions"><button class="btn primary" type="submit">' + (mode === 'import' ? 'บันทึกและเปิดใช้งาน' : 'บันทึกร่าง') + '</button>' +
      '<a class="btn" data-back href="' + (b ? '#/budget/' + b.id : '#/my-budgets') + '">ยกเลิก</a>' +
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
      // CBS: ยอดรวมของ Item หลัก (รวม VAT)
      let cbs = 0;
      form.querySelectorAll('#cbsRows tr').forEach((tr) => {
        const amt = Number(tr.querySelector('[name="itAmount"]').value || 0);
        cbs += amt + (tr.querySelector('[name="itVat"]').checked ? round2(amt * VAT_RATE) : 0);
      });
      form.querySelector('[data-total="cbs"]').textContent = money(cbs);
    };
    // งบ OPEX ต้องแยก Item เสมอ (ไม่มีงบรวมทั้งโครงการ)
    const curStructure = () => (curType() === 'CBS' ? 'items' : form.querySelector('[name="structure"]:checked').value);
    const sync = () => {
      const t = curType();
      const st = curStructure();
      form.querySelectorAll('[data-for], [data-structure]').forEach((el) => {
        el.hidden = (el.dataset.for && el.dataset.for !== t) || (el.dataset.structure && el.dataset.structure !== st);
      });
      const introEl = document.getElementById('budgetIntro');
      if (introEl) introEl.textContent = t === 'CBS' ? introEl.dataset.cbs : introEl.dataset.capex;
      recalc();
    };
    typeSel.addEventListener('change', sync);
    // เปลี่ยนบริษัทเจ้าของงบ: แถวที่ยังใช้บริษัทเดิมเป็นผู้ลงทุน เปลี่ยนตามให้
    let prevCompany = form.elements.company.value;
    form.elements.company.addEventListener('change', () => {
      const now = form.elements.company.value;
      form.querySelectorAll('[name="itInv"]').forEach((sel) => { if (sel.value === prevCompany) sel.value = now; });
      prevCompany = now;
    });
    form.querySelectorAll('[name="structure"]').forEach((el) => el.addEventListener('change', sync));
    form.addEventListener('input', recalc);
    form.addEventListener('change', (e) => {
      // เลือก GL Code จากข้อมูลหลักแล้วเติมชื่อ GL ให้ ถ้ายังไม่ได้กรอก
      if (e.target.matches('[name="itGl"]')) {
        const g = db.master.glCodes.find((x) => x.code === e.target.value.trim());
        const nameEl = e.target.closest('tr').querySelector('[name="itGlName"]');
        if (g && nameEl && !nameEl.value.trim()) nameEl.value = g.name;
      }
      recalc();
    });
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
          ? cbsRow({ code, name: '', amount: '', investor: form.elements.company.value }, false)
          : capexRow({ code: '', name: '', amount: '', investor: form.elements.company.value }, false));
        recalc();
      }
    });
    sync();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const id = form.dataset.id;
      const existing = id ? budgetById(id) : null;
      const mode = form.dataset.mode;
      const type = curType();
      const structure = curStructure();
      const errors = [];
      const code = f.code.value.trim();
      if (db.budgets.some((b) => b.code === code && b.id !== id && b.state !== 'cancelled')) errors.push('รหัส "' + code + '" มีอยู่แล้ว');
      if (mode === 'import' && !f.ownerId.value) errors.push('กรุณาเลือก Business เจ้าของงบ');

      const rows = structure === 'project' ? [] : Array.from(form.querySelectorAll('#' + (type === 'CBS' ? 'cbs' : 'capex') + 'Rows tr'));
      const val = (tr, n) => tr.querySelector('[name="' + n + '"]');
      const items = rows.map((tr) => {
        const it = {
          id: tr.dataset.itemId || '',
          code: val(tr, 'itCode').value.trim(),
          name: val(tr, 'itName').value.trim(),
          amount: round2(val(tr, 'itAmount').value),
          investor: val(tr, 'itInv') ? val(tr, 'itInv').value : f.company.value
        };
        if (type === 'CAPEX') {
          it.assetType = val(tr, 'itAsset').value;
          it.doa = val(tr, 'itDoa').value;
        } else {
          // Item หลักไม่มีจำนวน / หน่วย (กรอกที่ Item ย่อย)
          it.qty = '';
          it.unit = '';
          it.vat = val(tr, 'itVat').checked ? round2(it.amount * VAT_RATE) : 0;
          it.glCode = val(tr, 'itGl').value.trim();
          it.glName = val(tr, 'itGlName').value.trim();
        }
        return it;
      }).filter((it) => it.code || it.name || it.amount);
      if (structure === 'project') {
        // งบรวมโครงการ = รายการเดียวที่เป็นตัวโครงการ
        const old = existing && existing.structure === 'project' ? existing.items[0] : null;
        items.push(Object.assign({ id: old ? old.id : '', code: code || '-', name: 'งบรวมทั้งโครงการ', amount: round2(f.projAmount.value), vat: 0,
          qty: '', unit: '', glCode: '', glName: '' }, type === 'CAPEX' ? { assetType: f.projAsset.value, doa: f.projDoa.value } : {}));
      }

      if (!items.length) errors.push('ต้องมีรายการอย่างน้อย 1 รายการ');
      if (items.some((it) => !it.code || !it.name)) errors.push('กรุณากรอกรหัสและชื่อรายการให้ครบทุกแถว');
      const dup = items.map((it) => it.code).filter((c, i, arr) => c && arr.indexOf(c) !== i);
      if (dup.length) errors.push('รหัสรายการซ้ำ: ' + uniq(dup).join(', '));
      const draft = { type, items };
      if (type === 'CBS') {
        if (structure !== 'items') errors.push('งบ OPEX ต้องแยก Item');
        if (items.some((it) => String(it.code).includes('.'))) errors.push('Item หลักใช้รหัสไม่มีจุด (เช่น 1, 2, 3) — Item ย่อย (1.1) เพิ่มได้ภายหลังเมื่องบเปิดใช้แล้ว');
      } else {
        // CAPEX: รายการแม่ (ถ้าใช้รหัสมีจุด) ไม่มีวงเงินของตัวเอง
        items.forEach((it) => { if (!isLeaf(draft, it)) { it.amount = 0; it.vat = 0; it.qty = ''; } });
      }
      if (items.some((it) => !(it.amount > 0)) && structure === 'items') errors.push(type === 'CBS' ? 'วงเงินของ Item หลักแต่ละรายการต้องมากกว่า 0' : 'วงเงินของแต่ละรายการย่อยต้องมากกว่า 0');
      if (!(budgetTotal(draft) > 0)) errors.push('วงเงินรวมต้องมากกว่า 0');

      items.forEach((it) => { if (!it.id) it.id = nextId('i'); });
      const snapshot = snapshotItems(draft);
      if (errors.length) { showErrors(errors); return; }

      if (type === 'CBS' && existing) {
        const mains = new Set(items.map((it) => it.code));
        existing.items.filter((x) => depth(x) > 0 && mains.has(String(x.code).split('.')[0])).forEach((x) => items.push(x));
      }
      const data = {
        type, code, items, structure,
        company: f.company.value,
        fiscalYear: Number(f.fiscalYear.value),
        name: f.name.value.trim(),
        department: f.department.value.trim(),
        ownerId: f.ownerId.value || (existing ? existing.ownerId : me().id),
        note: f.note.value.trim()
      };
      data.group = f.group.value.trim();
      const at = new Date().toISOString();
      let target;
      if (existing) {
        target = existing;
        Object.assign(target, data, { updatedAt: at, updatedBy: me().id });
        addHistory(target, 'แก้ไขร่าง', '', 'งบ ' + code);
      } else {
        target = Object.assign({ id: nextId('b'), createdAt: at, createdBy: me().id, attachments: [], history: [], revisions: [] }, data);
        if (mode === 'import') {
          Object.assign(target, { state: 'active', activatedAt: at, activatedBy: me().id, meeting: { date: f.meetingDate.value, no: f.meetingNo.value.trim(), note: '', by: type === 'CBS' && f.meetingBy ? f.meetingBy.value.trim() : '' } });
          target.revisions = [{ no: 0, at, by: me().id, note: 'นำเข้างบที่อนุมัติแล้ว (' + target.meeting.no + ')', total: budgetTotal(target), items: snapshot }];
          addHistory(target, 'นำเข้างบที่อนุมัติแล้ว และเปิดใช้งาน', target.meeting.no, 'งบ ' + code);
        } else {
          target.state = 'draft';
          addHistory(target, 'สร้างร่างคำขออนุมัติงบ', '', 'งบ ' + code);
        }
        db.budgets.push(target);
      }
      save();
      setFlash('success', mode === 'import' ? 'นำเข้างบ ' + code + ' และเปิดใช้งานแล้ว'
        : 'บันทึกร่าง ' + code + ' แล้ว — พิมพ์แบบฟอร์ม' + (type === 'CBS' ? 'เสนอผู้บริหาร' : 'เข้าที่ประชุม') + 'ได้จากหน้ารายละเอียด เมื่อได้' + (type === 'CBS' ? 'เอกสารอนุมัติ' : 'มติ') + 'แล้วแนบหลักฐานและส่งให้ผู้คุมงบ');
      go('#/budget/' + target.id);
    });
  }

  // ---------------------------------------------------------------- budget detail

  // ---- ไฟล์แนบ (โหมดทดลองเก็บในเบราว์เซอร์ เป็น data URL)
  const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  /** รายการไฟล์แนบ: opts.del = ใส่ปุ่มลบ (data-att-del) */
  function attachList(list, opts) {
    const files = list || [];
    if (!files.length) return '<p class="muted small-note">' + ((opts && opts.empty) || 'ยังไม่มีไฟล์แนบ') + '</p>';
    return '<ul class="files">' + files.map((f) => '<li><span class="file-ico" aria-hidden="true">PDF</span><div>' +
      (f.data ? '<a href="' + f.data + '" download="' + esc(f.name) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a>' : '<span>' + esc(f.name) + '</span>') +
      '<small>' + (f.sample ? 'ไฟล์ตัวอย่าง (ไม่มีเนื้อหา)' : fmtSize(f.size)) + ' · ' + esc(userName(f.by)) + ' · ' + fmtDate(f.at) + '</small></div>' +
      (opts && opts.del ? '<button type="button" class="btn small bad" data-att-del="' + esc(f.id) + '" title="ลบไฟล์">×</button>' : '') + '</li>').join('') + '</ul>';
  }
  /** อ่านไฟล์จาก input — รับ PDF/รูปภาพ ไม่เกิน ATTACH_MAX (โหมดทดลอง) */
  function readFiles(input, slot) {
    const files = Array.from(input.files || []);
    const bad = files.filter((f) => !/pdf|png|jpe?g/i.test(f.type || f.name));
    const big = files.filter((f) => f.size > ATTACH_MAX);
    if (bad.length) { alert('รับเฉพาะไฟล์ PDF หรือรูปภาพ (PNG/JPG)'); return Promise.resolve([]); }
    if (big.length) { alert('โหมดทดลองเก็บไฟล์ในเบราว์เซอร์ได้ไม่เกิน ' + fmtSize(ATTACH_MAX) + ' ต่อไฟล์ (ระบบจริงรับไฟล์ใหญ่กว่านี้ได้)\n' + big.map((f) => f.name + ' = ' + fmtSize(f.size)).join('\n')); return Promise.resolve([]); }
    return Promise.all(files.map((f) => new Promise((resolve) => {
      const rd = new FileReader();
      rd.onload = () => resolve({ id: nextId('f'), slot, name: f.name, size: f.size, type: f.type, data: rd.result, at: new Date().toISOString(), by: me().id });
      rd.readAsDataURL(f);
    })));
  }

  const budgetStateBadge = (b) => badge(BUDGET_STATE_BADGE[b.state || 'active'], BUDGET_STATE[b.state || 'active']);
  const tlItem = (cls, title, sub, note) => '<li class="' + cls + '"><span class="tl-dot"></span><div><strong>' + title + '</strong>' +
    (sub ? '<div class="muted">' + sub + '</div>' : '') + (note ? '<div class="tl-note">' + esc(note) + '</div>' : '') + '</div></li>';
  /** ประวัติการดำเนินการ (ใหม่สุดอยู่บน) */
  function historyCard(list, title) {
    const items = (list || []).slice().reverse();
    return '<div class="card"><h3 class="side-title">' + (title || 'ประวัติการดำเนินการ') + '</h3>' +
      (items.length ? '<ol class="timeline">' + items.map((h) => tlItem('done', esc(h.action), esc(userName(h.by)) + ' · ' + fmtDate(h.at), h.note)).join('') + '</ol>'
        : '<p class="muted">ยังไม่มีประวัติ</p>') + '</div>';
  }
  /** แถบขั้นตอนของวงจรงบ */
  function budgetStepper(b) {
    const st = b.state || 'active';
    const steps = [['draft', 'ร่างคำขอ'], ['meeting', apprOf(b.type).step], ['review', 'ผู้คุมงบตรวจสอบ'], ['active', 'เปิดใช้งาน']];
    const idx = { draft: 0, returned: 0, review: 2, active: 3, cancelled: -1 }[st];
    return '<ol class="stepper">' + steps.map(([k, label], i) => '<li class="' + (i < idx ? 'done' : i === idx ? 'current' : '') + '"><span>' + (i + 1) + '</span>' + label + '</li>').join('') + '</ol>';
  }

  function viewBudgetDetail(id) {
    const b = budgetById(id);
    if (!b) return notFound();
    const u = me();
    const state = b.state || 'active';
    const active = state === 'active';
    const own = b.ownerId === u.id;
    const editable = own && (state === 'draft' || state === 'returned');
    const us = usage(b);
    const reqs = db.requests.filter((r) => r.budgetId === b.id);
    const chgs = (db.changes || []).filter((c) => c.budgetId === b.id);
    const canRequest = active && can('request.create') && own;
    const manageSub = canManageSubItems(b);
    const isCapex = b.type === 'CAPEX';
    const isProject = b.structure === 'project';
    const first = (b.revisions && b.revisions[0]) ? b.revisions[0].items : [];

    // ---- หัวหน้า + ปุ่มคำสั่ง
    const actions = [];
    if (canRequest) {
      actions.push('<a class="btn primary" href="#/request/new/' + b.id + '">ขอดำเนินการใช้งบ</a>');
      actions.push('<a class="btn" href="#/change/new/' + b.id + '">ขอเพิ่มงบ</a>');
    }
    if (editable) actions.push('<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไขร่าง</a>');
    if (own || canViewAll()) actions.push('<a class="btn" href="#/budget/' + b.id + '/form">พิมพ์แบบฟอร์มขออนุมัติ</a>');
    if (manageSub) actions.push('<a class="btn" href="#/budget/' + b.id + '/items">จัดการ Item ย่อย</a>');
    if (canPlanCashflow(b)) actions.push('<a class="btn" href="#/budget/' + b.id + '/cashflow">' + (hasCashflow(b) ? 'แก้ไข Plan Cashflow' : 'วาง Plan Cashflow') + '</a>');
    if (active && can('budget.adjust')) actions.push('<a class="btn" href="#/adjust?budget=' + b.id + '">โยก / ลดงบ</a>');
    if (editable) actions.push('<button type="button" class="btn bad" id="cancelBudget">ยกเลิกคำขอ</button>');
    let html = '<div class="page-head detail-head"><div>' +
      '<div class="eyebrow">' + (isCapex ? 'งบลงทุน' : 'งบดำเนินงาน') + ' · ' + badge(b.type, TYPE_SHORT[b.type]) + ' ' + esc(b.code) +
      ' · ' + budgetStateBadge(b) + '</div>' +
      '<h1>' + esc(b.name) + '</h1></div>' +
      (actions.length ? '<div class="head-actions">' + actions.join('') + '</div>' : '') + '</div>' + takeFlash();

    if (!active) {
      const msg = {
        draft: own ? (isCapex ? 'ร่างนี้ยังไม่ได้ส่ง — พิมพ์แบบฟอร์มเข้าที่ประชุม เมื่อที่ประชุมอนุมัติแล้ว แนบมติและส่งให้ผู้คุมงบด้านล่าง (ร่างค้างไว้ได้ไม่จำกัดเวลา)'
          : 'ร่างนี้ยังไม่ได้ส่ง — พิมพ์แบบฟอร์มเสนอผู้บริหาร (ไม่ต้องเข้าบอร์ด) เมื่อผู้บริหารอนุมัติแล้ว แนบเอกสารอนุมัติและส่งให้ผู้คุมงบด้านล่าง (ร่างค้างไว้ได้ไม่จำกัดเวลา)') : 'ร่างของ Business ยังไม่ได้ส่งตรวจ',
        returned: 'ผู้คุมงบส่งกลับให้แก้ไข: ' + (b.returnReason || ''),
        review: (isCapex ? 'แนบมติแล้ว' : 'แนบเอกสารอนุมัติผู้บริหารแล้ว') + ' รอผู้คุมงบตรวจสอบและยืนยันเปิดใช้งาน',
        cancelled: 'คำขออนุมัติงบนี้ถูกยกเลิกแล้ว'
      }[state];
      html += '<div class="card stepper-card">' + budgetStepper(b) + '<p class="' + (state === 'returned' ? 'neg' : 'muted') + '">' + esc(msg) + '</p></div>';
    }

    // ---- ข้อมูลหลักแบบตาราง
    const fact = (label, value, wide) => (value || value === 0
      ? '<div class="fact' + (wide ? ' wide' : '') + '"><span>' + label + '</span><strong>' + value + '</strong></div>' : '');
    const facts = '<section class="card"><div class="facts">' +
      fact('บริษัท', esc(b.company) + '<small>' + esc(companyMap()[b.company] || '') + '</small>') +
      fact('ปีงบประมาณ', esc(b.fiscalYear)) +
      fact('กลุ่มงบประมาณ', esc(b.group)) +
      fact('หน่วยงาน', esc(b.department)) +
      fact('Business เจ้าของงบ', esc(userName(b.ownerId))) +
      fact('โครงสร้างงบ', isProject ? 'งบรวมทั้งโครงการ' : (isCapex ? b.items.length + ' รายการย่อย' : ledgerItems(b).length + ' Item หลัก')) +
      fact(apprOf(b.type).short, b.meeting && b.meeting.no ? esc(b.meeting.no) + (b.meeting.date || b.meeting.by ? '<small>' + (b.meeting.date ? fmtDay(b.meeting.date) : '') + (b.meeting.by ? ' · ' + esc(b.meeting.by) : '') + '</small>' : '') : '') +
      fact('หมายเหตุ', esc(b.note), true) +
      '</div></section>';

    // ---- ตารางรายการ
    const reqBtn = (i) => (canRequest ? '<td><a class="btn small" href="#/request/new/' + b.id + '?item=' + i.id + '">ขอใช้</a></td>' : '');
    let items;
    if (isProject) {
      const it = b.items[0] || {};
      const cats = {};
      reqs.filter((r) => ['memo', 'pending', 'approved', 'closed'].includes(r.status)).forEach((r) => r.lines.forEach((l) => {
        const k = l.category || 'ไม่ระบุหมวด';
        cats[k] = round2((cats[k] || 0) + l.amount);
      }));
      items = '<h2>งบรวมทั้งโครงการ</h2><div class="table-wrap"><table><thead><tr><th>รายการ</th><th class="num">งบ</th>' +
        (active ? '<th class="num">ตัดงบแล้ว</th><th class="num">จองไว้</th><th class="num">คงเหลือ</th>' : '') + '</tr></thead><tbody>' +
        '<tr><td>' + esc(it.name || 'งบรวมทั้งโครงการ') + (isCapex ? '<div class="muted">' + esc(it.assetType || '') + ' · DOA ' + esc(it.doa || '') + '</div>' : '') + '</td>' +
        '<td class="num">' + money(budgetTotal(b)) + '</td>' +
        (active ? '<td class="num">' + money(us.used) + '</td><td class="num">' + money(us.reserved) + '</td><td class="num"><strong>' + moneyCell(us.remaining) + '</strong></td>' : '') +
        '</tr></tbody></table></div>' +
        (active ? '<h2>สรุปการใช้งบตามหมวดค่าใช้จ่าย</h2>' + (Object.keys(cats).length
          ? '<div class="table-wrap"><table><thead><tr><th>หมวดค่าใช้จ่าย</th><th class="num">ยอดที่ขอใช้ (ไม่รวมที่ยกเลิก/ส่งกลับ)</th></tr></thead><tbody>' +
            Object.keys(cats).sort((x, y) => cats[y] - cats[x]).map((k) => '<tr><td>' + esc(k) + '</td><td class="num">' + money(cats[k]) + '</td></tr>').join('') + '</tbody></table></div>'
          : '<p class="muted">ยังไม่มีการดำเนินการใช้งบ</p>') : '');
    } else if (isCapex) {
      items = '<h2>รายการย่อย (Item No.)</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>รหัสรายการย่อย</th><th>รายการ</th><th class="num">งบ</th>' + (active ? '<th class="num">ตัดงบแล้ว</th><th class="num">จองไว้</th><th class="num">คงเหลือ</th>' : '') +
        (canRequest ? '<th></th>' : '') + '</tr></thead><tbody>' +
        b.items.map((i) => {
          const iu = usage(b, i.id);
          const orig = first.find((x) => x.code === i.code);
          const origNote = !active ? '' : !orig ? '<div class="muted">เพิ่มภายหลัง</div>'
            : orig.total !== iu.approved ? '<div class="muted">เดิม ' + money(orig.total) + '</div>' : '';
          return '<tr><td class="nowrap">' + esc(i.code) + '</td><td>' + esc(i.name) +
            '<div class="muted">' + esc(i.assetType) + ' · DOA ' + esc(i.doa) + ' · ลงทุนโดย ' + esc(itemInvestor(b, i)) + '</div></td>' +
            '<td class="num">' + money(itemTotal(i)) + origNote + '</td>' +
            (active ? '<td class="num">' + money(iu.used) + '</td><td class="num">' + money(iu.reserved) +
              '</td><td class="num nowrap"><strong>' + moneyCell(iu.remaining) + '</strong>' + (iu.remaining < 0 ? ' <span class="badge rejected">เกินงบรายการ</span>' : '') + '</td>' : '') +
            reqBtn(i) + '</tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      items = '<h2>Item ของงบ (Item หลัก / Item ย่อย)</h2>' +
        '<p class="muted small-note">Item หลักกำหนดตอนตั้งงบ (ไม่มีจำนวน/หน่วย) · Item ย่อย 2 ระดับ (1.1 และ 1.1.1) เพิ่มได้เรื่อย ๆ หลังงบเปิดใช้แล้ว วงเงินรวมไม่เกิน Item หลัก และจะกำหนดวงเงินหรือไม่ก็ได้' +
        (manageSub ? ' — <a href="#/budget/' + b.id + '/items">จัดการ Item ย่อย</a>' : '') + '</p>' +
        '<div class="table-wrap"><table><thead><tr>' +
        '<th>รหัส</th><th style="min-width:14rem">รายการ</th><th>GL</th><th class="num">งบ (รวม VAT)</th>' + (active ? '<th class="num">ตัดงบแล้ว</th><th class="num">จองไว้</th><th class="num">คงเหลือ</th>' : '') +
        (canRequest ? '<th></th>' : '') + '</tr></thead><tbody>' +
        sortedItems(b).map((i) => {
          const own = hasOwnBudget(b, i);
          const main = isMainItem(b, i);
          const iu = own ? usage(b, i.id) : usageOwn(b, i);
          const node = budgetNodeOf(b, i);
          const qty = (i.qty || i.unit) ? '<div class="muted">' + esc((i.qty ? Number(i.qty).toLocaleString('th-TH') : '') + ' ' + (i.unit || '')) + '</div>' : '';
          const alloc = childrenOf(b, i).length && own ? '<div class="muted">จัดสรรให้ Item ย่อย ' + money(allocatedOf(b, i)) + ' · ยังไม่จัดสรร ' + money(round2(itemTotal(i) - allocatedOf(b, i))) + '</div>' : '';
          return '<tr class="' + (main ? 'parent-row' : '') + '"><td class="nowrap">' + esc(i.code) + '</td>' +
            '<td style="padding-left:' + (0.75 + depth(i) * 1.1) + 'rem">' + esc(i.name) + qty + '<div class="muted">ลงทุนโดย ' + esc(itemInvestor(b, i)) + '</div>' + alloc + '</td>' +
            '<td>' + (i.glCode ? esc(i.glCode) + '<div class="muted">' + esc(i.glName) + '</div>' : '') + '</td>' +
            '<td class="num">' + (own ? money(itemTotal(i)) : '<span class="muted">ไม่กำหนดวงเงิน</span>') + '</td>' +
            (active ? '<td class="num">' + money(iu.used) + '</td><td class="num">' + money(iu.reserved) + '</td>' +
              '<td class="num nowrap">' + (own ? moneyCell(iu.remaining) + (iu.remaining < 0 ? ' <span class="badge rejected">เกินงบ</span>' : '') : '<span class="muted">ใช้วงเงิน Item ' + esc(node.code) + '</span>') + '</td>' : '') +
            (canRequest ? reqBtn(i) : '') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }

    // ---- Plan Cashflow (CAPEX ที่เปิดใช้แล้ว)
    if (isCapex && active) {
      items += '<h2>Plan Cashflow (ประมาณการใช้เงินรายเดือน)</h2>' + (hasCashflow(b)
        ? '<section class="card">' + cashflowSummary(b) + '</section>'
        : '<div class="alert ' + (canPlanCashflow(b) && b.ownerId === me().id ? 'warn' : 'info') + '">ยังไม่ได้วาง Plan Cashflow' +
          (canPlanCashflow(b) ? ' — <a href="#/budget/' + b.id + '/cashflow">วางแผนว่าแต่ละ Item จะใช้เงินเดือนไหนเท่าไร</a>' : '') + '</div>');
    }

    // ---- หลักฐานการอนุมัติ (CAPEX: มติที่ประชุม · CBS: เอกสารอนุมัติผู้บริหาร)
    const ap = apprOf(b.type);
    let evidence = '<h2>' + ap.title + ' / หลักฐานการอนุมัติ</h2><section class="card evidence-card">';
    if (editable) {
      evidence += '<form id="submitBudget" data-id="' + b.id + '"><div class="form-grid">' +
        '<label class="field"><span>' + ap.date + '</span><input name="meetingDate" type="date" value="' + esc((b.meeting && b.meeting.date) || '') + '"></label>' +
        '<label class="field"><span>' + ap.no + '</span><input name="meetingNo" placeholder="' + ap.noEx + '" value="' + esc((b.meeting && b.meeting.no) || '') + '"></label>' +
        (ap.exec ? '<label class="field full"><span>' + ap.by + '</span><input name="meetingBy" placeholder="' + ap.byEx + '" value="' + esc((b.meeting && b.meeting.by) || '') + '"></label>' : '') +
        '<label class="field full"><span>' + ap.note + '</span><input name="meetingNote" placeholder="เช่น อนุมัติเต็มจำนวน / อนุมัติบางส่วน" value="' + esc((b.meeting && b.meeting.note) || '') + '"></label></div>' +
        '<div class="field"><span>' + ap.file + ' (PDF หรือรูปภาพ)</span>' + attachList(b.attachments, { del: true, empty: ap.empty }) +
        '<label class="btn small file-btn">+ แนบไฟล์<input type="file" id="budgetFiles" accept="application/pdf,image/png,image/jpeg" multiple hidden></label></div>' +
        '<div class="actions"><button class="btn primary" type="submit">ส่งให้ผู้คุมงบตรวจสอบ</button><button class="btn" type="button" id="saveMeeting">บันทึกข้อมูล' + (ap.exec ? 'การอนุมัติ' : 'มติ') + 'ไว้ก่อน</button></div></form>';
    } else {
      evidence += (b.meeting && b.meeting.no
        ? '<p>' + esc(b.meeting.no) + apprMetaText(ap, b.meeting) + (b.meeting.note ? ' · ' + esc(b.meeting.note) : '') + '</p>'
        : '<p class="muted">' + ap.none + '</p>') + attachList(b.attachments, { empty: ap.empty });
    }
    evidence += '</section>';

    const chgList = chgs.length
      ? '<h2>คำขอเพิ่มงบ <span class="muted count-note">(' + chgs.length + ')</span></h2><div class="table-wrap"><table><thead><tr><th>เลขที่</th><th>เหตุผล</th><th class="num">ขอเพิ่ม</th><th>สถานะ</th></tr></thead><tbody>' +
        chgs.map((c) => '<tr><td class="nowrap"><a href="#/change/' + c.id + '">' + esc(c.no) + '</a><div class="muted">' + fmtDay(c.createdAt) + '</div></td><td>' + esc(c.reason) + '</td>' +
          '<td class="num">' + money(changeTotal(c)) + '</td><td>' + badge(CHANGE_STATE_BADGE[c.state], CHANGE_STATE[c.state]) + '</td></tr>').join('') + '</tbody></table></div>'
      : '';
    const main = (active ? '' : evidence) + facts + items + (active ? evidence : '') + chgList +
      (active ? '<h2>ประวัติการดำเนินการใช้งบ <span class="muted count-note">(' + reqs.length + ')</span></h2>' + requestTable(reqs, false) : '');

    // ---- คอลัมน์ขวา
    let side = '';
    if (active) {
      side += '<div class="card total-card"><span class="muted">งบคงเหลือ</span>' +
        '<div class="total-amount' + (us.remaining < 0 ? ' neg' : '') + '">' + money(us.remaining) + ' <small>บาท</small></div>' +
        '<div style="margin:.75rem 0 .9rem">' + usageBar(us) + '</div>' +
        '<dl class="kv compact"><dt>งบที่ได้รับอนุมัติ</dt><dd>' + money(us.approved) + '</dd>' +
        '<dt>ตัดงบแล้ว</dt><dd>' + money(us.used) + '</dd>' +
        '<dt>จองไว้ (ยังไม่ตัดงบ)</dt><dd>' + money(us.reserved) + '</dd></dl></div>';
      const count = (st) => reqs.filter((r) => r.status === st).length;
      const stat = (label, n, cls) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><strong>' + n + '</strong><span>' + label + '</span></div>';
      side += '<div class="card"><h3 class="side-title">ภาพรวมการดำเนินการใช้งบ</h3><div class="stats">' +
        stat('รอผู้คุมงบตรวจสอบ', count('pending'), count('pending') ? 'warn' : '') +
        stat('ออกเอกสารแล้ว (ยังไม่ปิดยอด)', count('approved')) +
        stat('ปิดยอดแล้ว', count('closed')) +
        stat('ส่งกลับ / ยกเลิก', count('rejected') + count('cancelled')) + '</div></div>';
    } else {
      side += '<div class="card total-card"><span class="muted">วงเงินที่ขออนุมัติ</span>' +
        '<div class="total-amount">' + money(budgetTotal(b)) + ' <small>บาท</small></div>' +
        '<p class="muted small-note" style="margin:var(--s-2) 0 0">สถานะ: ' + esc(BUDGET_STATE[state]) + '</p></div>';
    }
    if (state === 'review' && can('budget.verify')) {
      side += '<div class="card decision"><h3 class="side-title">' + ap.verify + 'และเปิดใช้งาน</h3>' +
        '<p class="muted small-note" style="margin:0 0 var(--s-3)">ตรวจว่า' + (ap.exec ? 'เอกสารอนุมัติของผู้บริหาร' : 'มติ') + 'ตรงกับวงเงินและรายการในคำขอ ผู้คุมงบแก้ตัวงบไม่ได้ ถ้าไม่ตรงให้ส่งกลับ</p>' +
        '<form id="verifyBudget" data-id="' + b.id + '"><label class="field"><span>หมายเหตุ (จำเป็นเมื่อส่งกลับ)</span><textarea name="comment" rows="3"></textarea></label>' +
        '<div class="actions"><button class="btn primary" type="submit" data-verify="active">ยืนยันเปิดใช้งาน</button>' +
        '<button class="btn bad" type="submit" data-verify="returned">ส่งกลับให้แก้ไข</button></div></form></div>';
    }
    if (active && b.revisions.length) {
      side += '<div class="card"><h3 class="side-title">ประวัติการปรับงบ' + (isCapex ? '' : ' (Revise OPEX)') + '</h3><ol class="timeline">' +
        b.revisions.slice().reverse().map((rv, idx, arr) => {
          const prevRv = arr[idx + 1];
          const diff = prevRv ? round2(rv.total - prevRv.total) : 0;
          return tlItem(rv.no === 0 ? 'done' : 'approved',
            (rv.no === 0 ? 'เปิดใช้งาน' : 'ปรับครั้งที่ ' + rv.no) + ' · ' + money(rv.total) +
              (diff ? ' <span class="' + (diff > 0 ? 'pos' : 'neg') + '">(' + (diff > 0 ? '+' : '') + money(diff) + ')</span>' : ''),
            esc(userName(rv.by)) + ' · ' + fmtDate(rv.at), rv.note);
        }).join('') + '</ol></div>';
    }
    side += historyCard(b.history);

    return html + '<div class="detail-layout"><div class="detail-main">' + main + '</div><aside class="detail-side">' + side + '</aside></div>';
  }

  function bindBudgetDetail() {
    const sub = document.getElementById('submitBudget');
    const cancel = document.getElementById('cancelBudget');
    const verify = document.getElementById('verifyBudget');
    if (cancel) {
      cancel.addEventListener('click', () => {
        const b = budgetById(location.hash.split('/')[2]);
        if (!b || !confirm('ยกเลิกคำขออนุมัติงบ ' + b.code + ' ?')) return;
        b.state = 'cancelled';
        addHistory(b, 'ยกเลิกคำขออนุมัติงบ', '', 'งบ ' + b.code);
        save();
        setFlash('info', 'ยกเลิกคำขออนุมัติงบ ' + b.code + ' แล้ว');
        go('#/budget/' + b.id);
      });
    }
    if (sub) {
      const b = budgetById(sub.dataset.id);
      const keepMeeting = () => {
        b.meeting = { date: sub.elements.meetingDate.value, no: sub.elements.meetingNo.value.trim(), note: sub.elements.meetingNote.value.trim(),
          by: sub.elements.meetingBy ? sub.elements.meetingBy.value.trim() : '' };
      };
      sub.querySelector('#budgetFiles').addEventListener('change', async (e) => {
        const files = await readFiles(e.target, 'resolution');
        if (!files.length) return;
        keepMeeting();
        b.attachments = (b.attachments || []).concat(files);
        addHistory(b, apprOf(b.type).exec ? 'แนบไฟล์เอกสารอนุมัติ' : 'แนบไฟล์มติ', files.map((f) => f.name).join(', '), 'งบ ' + b.code);
        if (!save()) return;
        go('#/budget/' + b.id);
      });
      sub.addEventListener('click', (e) => {
        const del = e.target.closest('[data-att-del]');
        if (!del) return;
        const f = b.attachments.find((x) => x.id === del.dataset.attDel);
        if (!f || !confirm('ลบไฟล์ ' + f.name + ' ?')) return;
        keepMeeting();
        b.attachments = b.attachments.filter((x) => x !== f);
        addHistory(b, apprOf(b.type).exec ? 'ลบไฟล์เอกสารอนุมัติ' : 'ลบไฟล์มติ', f.name, 'งบ ' + b.code);
        save();
        go('#/budget/' + b.id);
      });
      sub.querySelector('#saveMeeting').addEventListener('click', () => {
        keepMeeting();
        addHistory(b, apprOf(b.type).exec ? 'บันทึกข้อมูลการอนุมัติ' : 'บันทึกข้อมูลมติ', b.meeting.no, 'งบ ' + b.code);
        save();
        setFlash('success', 'บันทึกข้อมูล' + (apprOf(b.type).exec ? 'การอนุมัติ' : 'มติ') + 'ไว้แล้ว (ยังไม่ได้ส่งตรวจ)');
        go('#/budget/' + b.id);
      });
      sub.addEventListener('submit', (e) => {
        e.preventDefault();
        keepMeeting();
        const errors = [];
        const ap = apprOf(b.type);
        if (!b.meeting.no) errors.push('กรุณาระบุ' + ap.no);
        if (ap.exec && !b.meeting.by) errors.push('กรุณาระบุ' + ap.by);
        if (!b.attachments.length) errors.push('กรุณาแนบ' + ap.file);
        if (errors.length) { alert(errors.join('\n')); return; }
        b.state = 'review';
        b.submittedAt = new Date().toISOString();
        addHistory(b, ap.exec ? 'แนบเอกสารอนุมัติผู้บริหารและส่งให้ผู้คุมงบตรวจสอบ' : 'แนบมติที่ประชุมและส่งให้ผู้คุมงบตรวจสอบ', b.meeting.no, 'งบ ' + b.code);
        save();
        setFlash('success', 'ส่งงบ ' + b.code + ' ให้ผู้คุมงบตรวจสอบแล้ว');
        go('#/budget/' + b.id);
      });
    }
    if (verify) {
      let decision = 'active';
      verify.querySelectorAll('[data-verify]').forEach((btn) => btn.addEventListener('click', () => { decision = btn.dataset.verify; }));
      verify.addEventListener('submit', (e) => {
        e.preventDefault();
        const b = budgetById(verify.dataset.id);
        const comment = verify.elements.comment.value.trim();
        if (decision === 'returned' && !comment) { alert('กรุณาระบุเหตุผลที่ส่งกลับ'); return; }
        const at = new Date().toISOString();
        if (decision === 'active') {
          Object.assign(b, { state: 'active', activatedAt: at, activatedBy: me().id, returnReason: '' });
          b.revisions = [{ no: 0, at, by: me().id, note: 'เปิดใช้งานตาม' + ((b.meeting && b.meeting.no) || apprOf(b.type).short) + (comment ? ' — ' + comment : ''), total: budgetTotal(b), items: snapshotItems(b) }];
          addHistory(b, 'ยืนยันเปิดใช้งาน', comment, 'งบ ' + b.code);
          setFlash('success', 'เปิดใช้งานงบ ' + b.code + ' แล้ว — Business ขอดำเนินการใช้งบได้');
        } else {
          Object.assign(b, { state: 'returned', returnReason: comment });
          addHistory(b, 'ส่งกลับให้แก้ไข', comment, 'งบ ' + b.code);
          setFlash('info', 'ส่งงบ ' + b.code + ' กลับให้ Business แก้ไขแล้ว');
        }
        save();
        go('#/budget/' + b.id);
      });
    }
  }

  // ---------------------------------------------------------------- Item ย่อยของ OPEX (เพิ่มทีหลังได้เมื่องบเปิดใช้แล้ว)

  /** เพิ่ม/แก้ Item ย่อยได้: งบ OPEX ที่เปิดใช้แล้ว โดย Business เจ้าของงบ หรือผู้คุมงบ */
  const canManageSubItems = (b) => b.type === 'CBS' && b.structure !== 'project' && isActive(b) && ((b.ownerId === me().id && can('request.create')) || can('budget.manage'));
  /** มีคำขอใช้ Item นี้ (หรือ Item ย่อยใต้ Item นี้) แล้ว: แก้รหัส / ลบไม่ได้ */
  const itemInUse = (b, it) => db.requests.some((r) => r.budgetId === b.id && r.lines.some((l) => leafIdsUnder(b, it).includes(l.itemId)));

  /** แถว Item ย่อย (ระดับ 2 = 1.1, ระดับ 3 = 1.1.1) */
  function subItemRow(b, it, locked) {
    const lv = it.code ? depth(it) : 1;
    return '<tr data-item-id="' + esc(it.id || '') + '" data-level="' + lv + '" class="lv' + lv + '">' +
      '<td><div class="si-code"><input name="siCode" value="' + esc(it.code || '') + '" placeholder="1.1" aria-label="รหัส Item ย่อย"' +
        (locked ? ' readonly class="locked" title="มีการขอใช้แล้ว แก้รหัสไม่ได้"' : '') + '></div></td>' +
      '<td><input name="siName" value="' + esc(it.name || '') + '" aria-label="ชื่อรายการ"></td>' +
      '<td><input name="siQty" type="number" min="0" step="any" value="' + esc(it.qty || '') + '" aria-label="จำนวน"></td>' +
      '<td><input name="siUnit" value="' + esc(it.unit || '') + '" aria-label="หน่วย"></td>' +
      '<td><input name="siAmount" type="number" min="0" step="0.01" class="right" value="' + esc(it.amount || '') + '" placeholder="ไม่กำหนด" aria-label="วงเงินก่อน VAT เว้นว่าง = ไม่กำหนด"></td>' +
      '<td class="center"><input name="siVat" type="checkbox"' + (Number(it.vat) > 0 ? ' checked' : '') + ' aria-label="VAT 7%"></td>' +
      '<td><input name="siGl" list="glList" value="' + esc(it.glCode || '') + '" aria-label="GL Code"></td>' +
      '<td><div class="select-wrap"><select name="siInv" aria-label="บริษัทที่ลงทุน"><option value="">ตาม Item แม่</option>' +
      optList(db.master.companies, 'code', (c) => c.code, it.investor || '') + '</select></div></td>' +
      '<td class="nowrap">' + (lv === 1 ? '<button type="button" class="btn small" data-add-child title="เพิ่ม Item ย่อยระดับถัดไป (เช่น 1.1.1)">+ ย่อย</button> ' : '') +
      (locked ? '<span class="muted" title="มีการขอใช้แล้ว ลบไม่ได้">🔒</span>' : '<button type="button" class="btn small bad" data-remove-sub title="ลบ">×</button>') + '</td></tr>';
  }

  function viewSubItems(id) {
    const b = budgetById(id);
    if (!b) return notFound();
    if (b.type !== 'CBS' || b.structure === 'project') return '<div class="alert error">Item ย่อยใช้กับงบ OPEX ที่แยก Item เท่านั้น</div>';
    if (!canManageSubItems(b)) return '<div class="alert error">เพิ่ม Item ย่อยได้เมื่องบเปิดใช้งานแล้ว โดย Business เจ้าของงบหรือผู้คุมงบ</div>';
    const mains = sortedItems(b).filter((x) => depth(x) === 0);
    const sections = mains.map((m) => {
      const subs = sortedItems(b).filter((x) => depth(x) >= 1 && depth(x) <= 2 && rootOf(b, x) === m);
      return '<section class="card form-section sub-sec" data-main="' + esc(m.id) + '" data-code="' + esc(m.code) + '" data-total="' + itemTotal(m) + '">' +
        '<div class="section-head"><div><h2 class="section-title">' + esc(m.code + ' ' + m.name) + '</h2>' +
        '<div class="muted section-hint">วงเงิน Item หลัก <strong>' + money(itemTotal(m)) + '</strong> บาท · จัดสรรให้ Item ย่อยแล้ว <strong data-alloc>0.00</strong> · ยังไม่จัดสรร <strong data-free>0.00</strong></div></div>' +
        '<button type="button" class="btn" data-add-sub="' + esc(m.id) + '">+ เพิ่ม Item ย่อย</button></div>' +
        '<div class="table-wrap"><table class="edit-table"><thead><tr><th style="width:8.5rem">รหัส</th><th style="min-width:12rem">รายการ</th><th style="width:6rem">จำนวน</th><th style="width:5.5rem">หน่วย</th>' +
        '<th class="num" style="width:9rem">วงเงินก่อน VAT</th><th style="width:4rem">VAT 7%</th><th style="width:7rem">GL Code</th><th style="width:8rem">บริษัทที่ลงทุน</th><th style="width:6.5rem"></th></tr></thead>' +
        '<tbody>' + subs.map((x) => subItemRow(b, x, itemInUse(b, x))).join('') + '</tbody></table></div>' +
        '</section>';
    }).join('');
    return '<div class="page-head"><div><h1>จัดการ Item ย่อย · ' + esc(b.code) + '</h1><div class="page-sub">' + esc(b.name) +
      ' — เพิ่ม Item ย่อยได้ 2 ระดับใต้ Item หลัก (1 → 1.1 → 1.1.1) และเพิ่มได้เรื่อย ๆ · เงื่อนไข: วงเงินรวมของ Item ย่อยต้องไม่เกิน Item หลัก · จะกำหนดวงเงินของ Item ย่อยหรือไม่ก็ได้ (เว้นว่าง = ใช้วงเงินของ Item แม่) · จำนวน / หน่วย กรอกที่ Item ย่อย</div></div></div>' +
      '<div id="formError"></div>' +
      '<datalist id="glList">' + db.master.glCodes.map((g) => '<option value="' + esc(g.code) + '">' + esc(g.name) + '</option>').join('') + '</datalist>' +
      '<form id="subItemsForm" data-id="' + b.id + '"><div class="form-main">' + sections +
      '<div class="actions"><button class="btn primary" type="submit">บันทึก Item ย่อย</button><a class="btn" data-back href="#/budget/' + b.id + '">ยกเลิก</a></div></div>' +
      '<template id="subTpl">' + subItemRow(b, {}, false) + '</template></form>';
  }

  function bindSubItems() {
    const form = document.getElementById('subItemsForm');
    if (!form) return;
    const b = budgetById(form.dataset.id);
    const tpl = document.getElementById('subTpl').innerHTML;
    const sections = () => Array.from(form.querySelectorAll('[data-main]'));
    const mainOf = (sec) => itemById(b, sec.dataset.main);
    const readRows = (sec) => Array.from(sec.querySelectorAll('tbody tr')).map((tr) => {
      const q = (n) => tr.querySelector('[name="' + n + '"]');
      const amount = round2(q('siAmount').value);
      return { tr, id: tr.dataset.itemId || '', code: q('siCode').value.trim(), name: q('siName').value.trim(), qty: q('siQty').value === '' ? '' : Number(q('siQty').value),
        unit: q('siUnit').value.trim(), amount, vat: q('siVat').checked ? round2(amount * VAT_RATE) : 0, glCode: q('siGl').value.trim(), investor: q('siInv').value };
    }).filter((r) => r.code || r.name || r.amount);
    /** งบทั้งหมดหลังแก้: Item หลัก + Item ย่อยทุกระดับจากฟอร์ม */
    const draftItems = () => {
      const out = b.items.filter((x) => depth(x) === 0).map((x) => Object.assign({}, x));
      sections().forEach((sec) => readRows(sec).forEach((r) => out.push({ id: r.id || '(new)' + r.code, code: r.code, name: r.name, amount: r.amount, vat: r.vat })));
      return out;
    };
    const errorsNow = () => {
      const out = [];
      const all = draftItems();
      sections().forEach((sec) => {
        const m = mainOf(sec);
        const rows = readRows(sec);
        const codes = new Set(rows.map((r) => r.code));
        rows.forEach((r) => {
          const parts = r.code.split('.');
          const okFmt = r.code.startsWith(m.code + '.') && /^\d+(\.\d+){1,2}$/.test(r.code) && parts.length <= 3;
          if (!okFmt) out.push('รหัส ' + (r.code || '(ว่าง)') + ' ต้องเป็น ' + m.code + '.1 หรือ ' + m.code + '.1.1 (ไม่เกิน 3 ระดับ)');
          else if (parts.length === 3 && !codes.has(parts.slice(0, 2).join('.'))) out.push('ยังไม่มี Item ' + parts.slice(0, 2).join('.') + ' สำหรับ ' + r.code);
          if (!r.name) out.push('กรุณากรอกชื่อรายการของ ' + (r.code || 'Item ย่อย'));
        });
      });
      const dup = all.map((x) => x.code).filter((c, i, arr) => c && arr.indexOf(c) !== i);
      if (dup.length) out.push('รหัสซ้ำ: ' + uniq(dup).join(', '));
      return uniq(out.concat(treeErrors({ type: 'CBS', items: all })));
    };
    const recalc = () => {
      const tmp = { type: 'CBS', items: draftItems() };
      sections().forEach((sec) => {
        const m = tmp.items.find((x) => x.id === sec.dataset.main);
        const alloc = m ? allocatedOf(tmp, m) : 0;
        const total = Number(sec.dataset.total);
        sec.querySelector('[data-alloc]').textContent = money(alloc);
        const free = sec.querySelector('[data-free]');
        free.textContent = money(round2(total - alloc));
        free.classList.toggle('neg', alloc > total + 0.005);
        // ระดับของแถวตามรหัส (เยื้องให้เห็นลำดับชั้น)
        sec.querySelectorAll('tbody tr').forEach((tr) => {
          const lv = Math.min(2, Math.max(1, tr.querySelector('[name="siCode"]').value.split('.').length - 1));
          tr.className = 'lv' + lv;
          tr.dataset.level = lv;
        });
      });
    };
    const nextChildCode = (sec, parentCode) => {
      const nums = readRows(sec).map((r) => r.code).filter((c) => c.startsWith(parentCode + '.') && c.split('.').length === parentCode.split('.').length + 1)
        .map((c) => Number(c.split('.').pop())).filter((x) => !isNaN(x));
      return parentCode + '.' + ((nums.length ? Math.max.apply(null, nums) : 0) + 1);
    };
    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-sub]');
      if (add) {
        const sec = form.querySelector('[data-main="' + add.dataset.addSub + '"]');
        const tbody = sec.querySelector('tbody');
        tbody.insertAdjacentHTML('beforeend', tpl);
        const row = tbody.lastElementChild;
        row.querySelector('[name="siCode"]').value = nextChildCode(sec, mainOf(sec).code);
        row.querySelector('[name="siName"]').focus();
        recalc();
        return;
      }
      const child = e.target.closest('[data-add-child]');
      if (child) {
        const tr = child.closest('tr');
        const sec = tr.closest('[data-main]');
        const pcode = tr.querySelector('[name="siCode"]').value.trim();
        if (!pcode) return;
        // แทรกต่อจากแถวสุดท้ายที่อยู่ใต้ Item นี้
        let after = tr;
        Array.from(sec.querySelectorAll('tbody tr')).forEach((x) => { if (x.querySelector('[name="siCode"]').value.trim().startsWith(pcode + '.')) after = x; });
        after.insertAdjacentHTML('afterend', tpl);
        const row = after.nextElementSibling;
        row.querySelector('[name="siCode"]').value = nextChildCode(sec, pcode);
        row.querySelector('[name="siName"]').focus();
        recalc();
        return;
      }
      if (e.target.matches('[data-remove-sub]')) {
        const tr = e.target.closest('tr');
        const code = tr.querySelector('[name="siCode"]').value.trim();
        const sec = tr.closest('[data-main]');
        const kids = code ? Array.from(sec.querySelectorAll('tbody tr')).filter((x) => x !== tr && x.querySelector('[name="siCode"]').value.trim().startsWith(code + '.')) : [];
        if (kids.some((x) => x.querySelector('.locked'))) { alert('ลบไม่ได้ — มี Item ย่อยใต้ ' + code + ' ที่มีการขอใช้แล้ว'); return; }
        if (kids.length && !confirm('ลบ ' + code + ' พร้อม Item ย่อยข้างใต้อีก ' + kids.length + ' รายการ?')) return;
        kids.forEach((x) => x.remove());
        tr.remove();
        recalc();
      }
    });
    form.addEventListener('input', recalc);
    form.addEventListener('change', recalc);
    guard(form, [{ btn: 'button[type="submit"]', missing: () => errorsNow() }], '.actions');
    recalc();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const errors = errorsNow();
      if (errors.length) { showErrors(errors); return; }
      let added = 0;
      let edited = 0;
      let removed = 0;
      const keepIds = new Set(b.items.filter((x) => depth(x) === 0).map((x) => x.id));
      const apply = (target, r) => {
        Object.assign(target, { code: r.code, name: r.name, qty: r.qty, unit: r.unit, amount: r.amount, vat: r.vat, glCode: r.glCode });
        const g = db.master.glCodes.find((x) => x.code === r.glCode);
        target.glName = g ? g.name : (target.glName || '');
        if (r.investor) target.investor = r.investor; else delete target.investor;
      };
      sections().forEach((sec) => {
        readRows(sec).forEach((r) => {
          const ex = r.id ? itemById(b, r.id) : null;
          if (ex) { apply(ex, r); edited += 1; keepIds.add(ex.id); } else {
            const it = { id: nextId('i') };
            apply(it, r);
            b.items.push(it);
            keepIds.add(it.id);
            added += 1;
          }
        });
      });
      // ลบ Item ย่อยที่เอาออกจากฟอร์ม (ที่ยังไม่มีการขอใช้)
      const before = b.items.length;
      b.items = b.items.filter((x) => keepIds.has(x.id) || itemInUse(b, x));
      removed = before - b.items.length;
      addHistory(b, 'จัดการ Item ย่อย', 'เพิ่ม ' + added + ' · แก้ไข ' + edited + ' · ลบ ' + removed + ' รายการ (งบรวมไม่เปลี่ยน)', 'งบ ' + b.code);
      save();
      setFlash('success', 'บันทึก Item ย่อยของ ' + b.code + ' แล้ว (เพิ่ม ' + added + ' · แก้ไข ' + edited + ' · ลบ ' + removed + ')');
      go('#/budget/' + b.id);
    });
  }

  // ---------------------------------------------------------------- Plan Cashflow (CAPEX): ประมาณการใช้เงินรายเดือนหลังงบอนุมัติแล้ว

  /** เดือนของปีงบประมาณ: ['2026-01', … '2026-12'] */
  const fyMonths = (b) => Array.from({ length: 12 }, (_, i) => b.fiscalYear + '-' + String(i + 1).padStart(2, '0'));
  /** วาง Plan Cashflow ได้: งบ CAPEX ที่เปิดใช้แล้ว โดย Business เจ้าของงบ หรือผู้คุมงบ */
  const canPlanCashflow = (b) => b.type === 'CAPEX' && isActive(b) && ((b.ownerId === me().id && can('request.create')) || can('budget.manage'));
  const planOf = (b, itemId, ym) => Number(((b.cashflow || {})[itemId] || {})[ym] || 0);
  const planItemTotal = (b, itemId) => round2(Object.values((b.cashflow || {})[itemId] || {}).reduce((s, v) => s + Number(v || 0), 0));
  const hasCashflow = (b) => Object.values(b.cashflow || {}).some((m) => Object.values(m).some((v) => Number(v) > 0));
  /** ยอดตัดงบจริงรายเดือนของงบ (แยก Item ได้): ใบที่มีหลาย Item แบ่งตามสัดส่วนยอดของบรรทัด */
  function actualByMonth(b, itemId) {
    const out = {};
    db.requests.forEach((r) => {
      if (r.budgetId !== b.id || !['approved', 'closed'].includes(r.status) || !(r.amount > 0)) return;
      const share = itemId ? linesAmount(r, leafIdsUnder(b, itemById(b, itemId) || { code: '' })) / r.amount : 1;
      if (!share) return;
      (r.cuts || []).forEach((c) => {
        const ym = String(c.date || c.at || '').slice(0, 7);
        if (ym) out[ym] = round2((out[ym] || 0) + Number(c.amount || 0) * share);
      });
    });
    return out;
  }

  /** ตารางสรุป Plan Cashflow ในหน้ารายละเอียดงบ */
  function cashflowSummary(b) {
    const months = fyMonths(b);
    const items = ledgerItems(b);
    const actual = actualByMonth(b);
    const planM = (ym) => round2(items.reduce((s, it) => s + planOf(b, it.id, ym), 0));
    const totalPlan = round2(items.reduce((s, it) => s + planItemTotal(b, it.id), 0));
    const totalActual = round2(months.reduce((s, ym) => s + (actual[ym] || 0), 0));
    return '<div class="table-wrap"><table class="cf-table"><thead><tr><th>เดือน</th>' + months.map((ym) => '<th class="num">' + monthLabel(ym) + '</th>').join('') + '<th class="num">รวม</th></tr></thead><tbody>' +
      '<tr><td class="nowrap">ประมาณการ (Plan)</td>' + months.map((ym) => '<td class="num">' + (planM(ym) ? money(planM(ym)) : '<span class="muted">-</span>') + '</td>').join('') + '<td class="num"><strong>' + money(totalPlan) + '</strong></td></tr>' +
      '<tr><td class="nowrap">ใช้จริง (ตัดงบ)</td>' + months.map((ym) => '<td class="num">' + (actual[ym] ? money(actual[ym]) : '<span class="muted">-</span>') + '</td>').join('') + '<td class="num"><strong>' + money(totalActual) + '</strong></td></tr>' +
      '</tbody></table></div>' +
      '<p class="muted small-note">วางแผนแล้ว ' + money(totalPlan) + ' จากงบ ' + money(budgetTotal(b)) + ' บาท' +
      (round2(budgetTotal(b) - totalPlan) > 0.005 ? ' · ยังไม่ได้วางแผน ' + money(round2(budgetTotal(b) - totalPlan)) + ' บาท' : '') +
      (b.cashflowAt ? ' · ปรับปรุงล่าสุด ' + fmtDate(b.cashflowAt) + ' โดย ' + esc(userName(b.cashflowBy)) : '') + '</p>';
  }

  function viewCashflow(id) {
    const b = budgetById(id);
    if (!b) return notFound();
    if (b.type !== 'CAPEX') return '<div class="alert error">Plan Cashflow ใช้กับงบ CAPEX</div>';
    if (!canPlanCashflow(b)) return '<div class="alert error">วาง Plan Cashflow ได้เมื่องบได้รับอนุมัติและเปิดใช้งานแล้ว โดย Business เจ้าของงบหรือผู้คุมงบ</div>';
    const months = fyMonths(b);
    const items = ledgerItems(b);
    const rows = items.map((it) => '<tr data-item="' + esc(it.id) + '" data-total="' + itemTotal(it) + '"><td class="cf-item"><strong>' + esc(it.code) + '</strong><div class="muted">' + esc(it.name) + '</div>' +
        '<div class="muted">งบ ' + money(itemTotal(it)) + '</div></td>' +
      months.map((ym) => '<td><input name="cf" data-ym="' + ym + '" type="number" min="0" step="0.01" class="right" value="' + (planOf(b, it.id, ym) || '') + '" aria-label="' + esc(it.code + ' ' + monthLabel(ym)) + '"></td>').join('') +
      '<td class="num" data-row-total>0.00</td><td class="num" data-row-left>0.00</td></tr>').join('');
    return '<div class="page-head"><div><h1>Plan Cashflow · ' + esc(b.code) + '</h1><div class="page-sub">' + esc(b.name) +
      ' — ประมาณการว่าแต่ละ Item จะใช้เงินเดือนไหนเท่าไร (รวม VAT) ในปีงบประมาณ ' + esc(b.fiscalYear) + ' · รวมของแต่ละ Item ต้องไม่เกินวงเงินของ Item</div></div></div>' +
      '<div id="formError"></div>' +
      '<form id="cashflowForm" data-id="' + b.id + '"><section class="card form-section">' +
      '<div class="table-wrap"><table class="edit-table cf-edit"><thead><tr><th style="min-width:12rem">Item</th>' +
      months.map((ym) => '<th class="num">' + monthLabel(ym) + '</th>').join('') + '<th class="num">รวมแผน</th><th class="num">ยังไม่วางแผน</th></tr></thead>' +
      '<tbody>' + rows + '</tbody><tfoot><tr><td><strong>รวมทุก Item</strong></td>' + months.map((ym) => '<td class="num" data-col="' + ym + '">0.00</td>').join('') +
      '<td class="num" data-sum>0.00</td><td class="num" data-left>0.00</td></tr></tfoot></table></div>' +
      '<div class="actions"><button type="button" class="btn small" data-spread title="แบ่งยอดที่ยังไม่วางแผนของแต่ละ Item เท่า ๆ กันในเดือนที่เหลือของปี">เกลี่ยยอดที่เหลือเท่า ๆ กัน</button>' +
      '<button type="button" class="btn small" data-clear>ล้างทั้งหมด</button></div></section>' +
      '<div class="actions"><button class="btn primary" type="submit">บันทึก Plan Cashflow</button><a class="btn" data-back href="#/budget/' + b.id + '">ยกเลิก</a></div></form>';
  }

  function bindCashflow() {
    const form = document.getElementById('cashflowForm');
    if (!form) return;
    const b = budgetById(form.dataset.id);
    const months = fyMonths(b);
    const rows = () => Array.from(form.querySelectorAll('tbody tr'));
    const rowSum = (tr) => round2(Array.from(tr.querySelectorAll('[name="cf"]')).reduce((s, i) => s + Number(i.value || 0), 0));
    const over = () => rows().filter((tr) => rowSum(tr) > Number(tr.dataset.total) + 0.005).map((tr) => tr.querySelector('strong').textContent);
    const recalc = () => {
      let sum = 0;
      let left = 0;
      rows().forEach((tr) => {
        const s = rowSum(tr);
        const l = round2(Number(tr.dataset.total) - s);
        sum += s;
        left += l;
        tr.querySelector('[data-row-total]').textContent = money(s);
        const lc = tr.querySelector('[data-row-left]');
        lc.innerHTML = moneyCell(l);
      });
      months.forEach((ym) => {
        const v = round2(Array.from(form.querySelectorAll('[name="cf"][data-ym="' + ym + '"]')).reduce((s, i) => s + Number(i.value || 0), 0));
        form.querySelector('[data-col="' + ym + '"]').textContent = money(v);
      });
      form.querySelector('[data-sum]').textContent = money(sum);
      form.querySelector('[data-left]').innerHTML = moneyCell(round2(left));
    };
    form.addEventListener('input', recalc);
    form.addEventListener('click', (e) => {
      if (e.target.matches('[data-clear]')) {
        form.querySelectorAll('[name="cf"]').forEach((i) => { i.value = ''; });
        recalc();
      }
      if (e.target.matches('[data-spread]')) {
        // เดือนที่เหลือของปี (ถ้าปีงบผ่านไปแล้ว/ยังไม่ถึง ใช้ทั้ง 12 เดือน)
        const now = new Date().toISOString().slice(0, 7);
        const rest = months.filter((ym) => ym >= now);
        const use = rest.length ? rest : months;
        rows().forEach((tr) => {
          const left = round2(Number(tr.dataset.total) - rowSum(tr));
          if (left <= 0) return;
          const per = Math.floor((left / use.length) * 100) / 100;
          use.forEach((ym, i) => {
            const inp = tr.querySelector('[name="cf"][data-ym="' + ym + '"]');
            const add = i === use.length - 1 ? round2(left - per * (use.length - 1)) : per;
            inp.value = round2(Number(inp.value || 0) + add) || '';
          });
        });
        recalc();
      }
    });
    guard(form, [{ btn: 'button[type="submit"]', missing: () => over().map((c) => 'แผนของ ' + c + ' เกินวงเงิน Item') }]);
    recalc();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const bad = over();
      if (bad.length) { showErrors(bad.map((c) => 'แผนของ ' + c + ' เกินวงเงิน Item')); return; }
      const plan = {};
      rows().forEach((tr) => {
        const m = {};
        tr.querySelectorAll('[name="cf"]').forEach((i) => { const v = round2(i.value); if (v > 0) m[i.dataset.ym] = v; });
        if (Object.keys(m).length) plan[tr.dataset.item] = m;
      });
      const first = !hasCashflow(b);
      b.cashflow = plan;
      b.cashflowAt = new Date().toISOString();
      b.cashflowBy = me().id;
      const total = round2(Object.values(plan).reduce((s, m) => s + Object.values(m).reduce((x, v) => x + v, 0), 0));
      addHistory(b, first ? 'วาง Plan Cashflow' : 'ปรับ Plan Cashflow', 'รวมแผน ' + money(total) + ' จากงบ ' + money(budgetTotal(b)) + ' บาท', 'งบ ' + b.code);
      save();
      setFlash('success', 'บันทึก Plan Cashflow ของ ' + b.code + ' แล้ว');
      go('#/budget/' + b.id);
    });
  }

  // ---------------------------------------------------------------- ส่งออกข้อมูลการเงิน / บัญชี เป็นไฟล์ Excel (.xlsx) — เขียนไฟล์เองในเบราว์เซอร์ ไม่ใช้ไลบรารีภายนอก

  /** สร้างไฟล์ .xlsx จาก [{ name, cols: [{ h, w, num }], rows: [[...]] }] คืน Uint8Array */
  function buildXlsx(sheets) {
    const enc = new TextEncoder();
    const xmlEsc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const colName = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const cell = (ref, v, num, style) => {
      if (v === null || v === undefined || v === '') return '';
      if (num && typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '" s="1"><v>' + v + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
    };
    const sheetXml = (sh) => {
      const last = colName(Math.max(sh.cols.length - 1, 0)) + (sh.rows.length + 1);
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<cols>' + sh.cols.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 14) + '" customWidth="1"/>').join('') + '</cols>' +
        '<sheetData><row r="1">' + sh.cols.map((c, i) => cell(colName(i) + '1', c.h, false, 2)).join('') + '</row>' +
        sh.rows.map((r, ri) => '<row r="' + (ri + 2) + '">' + r.map((v, ci) => cell(colName(ci) + (ri + 2), v, sh.cols[ci] && sh.cols[ci].num)).join('') + '</row>').join('') +
        '</sheetData>' + (sh.rows.length ? '<autoFilter ref="A1:' + last + '"/>' : '') + '</worksheet>';
    };
    const files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name.slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
        (sheets.some((s) => s.rows.length) ? '<definedNames>' + sheets.map((s, i) => s.rows.length ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + xmlEsc(s.name.slice(0, 31)) + '\'!$A$1:$' + colName(s.cols.length - 1) + '$' + (s.rows.length + 1) + '</definedName>' : '').join('') + '</definedNames>' : '') +
        '</workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>']
    ].concat(sheets.map((s, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)]));
    // ZIP แบบไม่บีบอัด (stored)
    const crcTable = buildXlsx.crc || (buildXlsx.crc = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
    const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const parts = [];
    const central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach(([name, text]) => {
      const nameB = enc.encode(name);
      const data = enc.encode(text);
      const crc = crc32(data);
      const head = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0));
      parts.push(new Uint8Array(head), nameB, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length),
        u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), nameB);
      offset += head.length + nameB.length + data.length;
    });
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
    const all = parts.concat(central, [end]);
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    all.forEach((p) => { out.set(p, pos); pos += p.length; });
    return out;
  }

  const EXPORT_SHEETS = [
    ['budgets', 'งบประมาณ', 'สรุปรายงบ: งบอนุมัติ ตัดงบแล้ว จองไว้ คงเหลือ'],
    ['items', 'Item', 'รายการ Item ของแต่ละงบ พร้อม GL / ประเภทสินทรัพย์ / DOA และยอดคงเหลือ'],
    ['requests', 'ดำเนินการใช้งบ', 'คำขอ / ใบดำเนินการใช้งบ: เลขที่ ประเภท สถานะ ยอดเงิน ยอดตัดงบ ปิดยอด'],
    ['lines', 'รายการในใบ', 'บรรทัดในใบดำเนินการใช้งบ: Item / หมวด / GL / บริษัทที่ลงทุน / ยอดเงิน'],
    ['cuts', 'ตัดงบ-จ่ายเงิน', 'การตัดงบ: PO / เคลียร์เงินทดรอง / จ่ายคืนพนักงาน / จ่าย Supplier'],
    ['changes', 'ปรับงบ', 'ขอเพิ่มงบ (INC) โยกงบ (TRF) ลดงบ (DEC)'],
    ['cashflow', 'Plan Cashflow', 'แผนการใช้เงินรายเดือนของ CAPEX เทียบยอดตัดงบจริง']
  ];
  const canExport = () => can('data.export');

  function exportData(f) {
    const inB = (b) => b && (!f.year || String(b.fiscalYear) === f.year) && (!f.company || b.company === f.company) && (!f.type || b.type === f.type);
    const budgets = db.budgets.filter(inB);
    const bIds = new Set(budgets.map((b) => b.id));
    const reqs = db.requests.filter((r) => bIds.has(r.budgetId));
    const day = (v) => (v ? String(v).slice(0, 10) : '');
    const T = (t) => TYPE_SHORT[t] || t;
    const sheets = [];
    const add = (key, cols, rows) => { if (f.sheets.includes(key)) sheets.push({ name: EXPORT_SHEETS.find((x) => x[0] === key)[1], cols, rows }); };
    const N = (h, w) => ({ h, w: w || 15, num: true });
    const S = (h, w) => ({ h, w: w || 14 });

    add('budgets', [S('บริษัท', 8), S('ประเภทงบ', 9), S('ปีงบประมาณ', 10), S('กลุ่มงบ', 8), S('รหัสโครงการ'), S('ชื่อโครงการ', 34), S('หน่วยงาน', 16), S('Business เจ้าของงบ', 18),
      S('สถานะ', 12), S('โครงสร้าง', 14), S('เลขที่มติ / อนุมัติ', 22), S('วันที่อนุมัติ', 12), N('งบอนุมัติ (รวม VAT)', 17), N('ตัดงบแล้ว'), N('จองไว้'), N('คงเหลือ')],
    budgets.map((b) => { const u = usage(b); return [b.company, T(b.type), b.fiscalYear, b.group || '', b.code, b.name, b.department, userName(b.ownerId), BUDGET_STATE[b.state || 'active'] || '',
      b.structure === 'project' ? 'งบรวมทั้งโครงการ' : 'แยก Item', (b.meeting || {}).no || '', day((b.meeting || {}).date), budgetTotal(b), u.used, u.reserved, u.remaining]; }));

    const itemRows = [];
    budgets.forEach((b) => sortedItems(b).forEach((it) => {
      const own = b.type !== 'CBS' || hasOwnBudget(b, it);
      const u = own ? usage(b, it.id) : null;
      itemRows.push([b.company, T(b.type), b.code, it.code, it.name, b.type === 'CBS' ? depth(it) + 1 : 1, itemInvestor(b, it), it.assetType || '', it.doa || '', it.glCode || '', it.glName || '',
        it.qty === '' || it.qty == null ? '' : Number(it.qty), it.unit || '', own ? round2(Number(it.amount || 0)) : '', own ? round2(Number(it.vat || 0)) : '', own ? itemTotal(it) : '',
        u ? u.used : '', u ? u.reserved : '', u ? u.remaining : '', own ? '' : 'ใช้วงเงิน Item ' + (budgetNodeOf(b, it) || {}).code]);
    }));
    add('items', [S('บริษัท', 8), S('ประเภทงบ', 9), S('รหัสโครงการ'), S('รหัส Item', 16), S('ชื่อรายการ', 32), { h: 'ระดับ', w: 7, num: true }, S('บริษัทที่ลงทุน', 12), S('ประเภทสินทรัพย์', 16),
      S('หมวด DOA', 9), S('GL Code', 10), S('GL Name', 20), { h: 'จำนวน', w: 9, num: true }, S('หน่วย', 8), N('ก่อน VAT'), N('VAT'), N('งบ (รวม VAT)'), N('ตัดงบแล้ว'), N('จองไว้'), N('คงเหลือ'), S('หมายเหตุ', 20)], itemRows);

    add('requests', [S('เลขที่คำขอ', 15), S('เลขที่เอกสาร', 16), S('เลขที่ Memo', 16), S('บริษัท', 8), S('ประเภทงบ', 9), S('รหัสโครงการ'), S('ประเภทการใช้งบ', 22), S('สถานะ', 20),
      S('ผู้ขอ', 16), S('วันที่ขอ', 11), S('วันที่อนุมัติ', 11), S('วัตถุประสงค์', 34), S('Supplier / ผู้รับเงิน', 22), S('PO No.', 14), N('ก่อน VAT'), N('VAT'), N('รวม'),
      N('ตัดงบแล้ว'), N('ปิดยอด: ใช้จริง'), N('ปิดยอด: คืนงบ'), S('วันที่ปิดยอด', 11), S('Note ผู้คุมงบ', 24)],
    reqs.map((r) => { const b = budgetById(r.budgetId); return [r.no, r.docNo || '', (r.memo || {}).no || '', b.company, T(r.type), b.code, (USE_TYPES[r.useType] || {}).label || '', STATUS_LABEL[r.status] || r.status,
      userName(r.requesterId), day(r.createdAt), day(r.approvedAt), r.purpose || '', r.payee || '', r.poNo && r.poNo !== 'N/A' ? r.poNo : '', r.amountBeforeVat, r.vat, r.amount,
      cutTotal(r), r.closed ? r.closed.actual : '', r.closed ? r.closed.returned : '', r.closed ? day(r.closed.at) : '', r.approverNote || '']; }));

    const lineRows = [];
    reqs.forEach((r) => { const b = budgetById(r.budgetId); r.lines.forEach((l, i) => { const it = itemById(b, l.itemId) || {};
      lineRows.push([r.no, r.docNo || '', b.code, i + 1, b.structure === 'project' ? '' : it.code || '', b.structure === 'project' ? '' : it.name || '', l.category || '', l.glCode || it.glCode || '', l.glName || it.glName || '',
        lineInvestor(b, l), l.description || '', l.amountBeforeVat, l.vat, l.amount, STATUS_LABEL[r.status] || r.status]); }); });
    add('lines', [S('เลขที่คำขอ', 15), S('เลขที่เอกสาร', 16), S('รหัสโครงการ'), { h: 'บรรทัด', w: 7, num: true }, S('รหัส Item', 16), S('ชื่อ Item', 26), S('หมวดค่าใช้จ่าย', 18), S('GL Code', 10), S('GL Name', 20),
      S('บริษัทที่ลงทุน', 12), S('รายละเอียด', 34), N('ก่อน VAT'), N('VAT'), N('รวม'), S('สถานะ', 20)], lineRows);

    const cutRows = [];
    reqs.forEach((r) => { const b = budgetById(r.budgetId); (r.cuts || []).forEach((c) => cutRows.push([r.docNo || '', r.no, b.company, T(r.type), b.code, CUT_KIND[c.kind] || c.kind, day(c.date || c.at), c.amount,
      c.prNo || '', c.poNo || '', c.ref || '', c.note || '', userName(c.by)])); });
    add('cuts', [S('เลขที่เอกสาร', 16), S('เลขที่คำขอ', 15), S('บริษัท', 8), S('ประเภทงบ', 9), S('รหัสโครงการ'), S('ประเภทการตัดงบ', 18), S('วันที่', 11), N('จำนวนเงิน'), S('PR No.', 12), S('PO No.', 12),
      S('อ้างอิง', 18), S('หมายเหตุ', 24), S('บันทึกโดย', 16)], cutRows);

    const chRows = [];
    (db.changes || []).filter((c) => bIds.has(c.budgetId)).forEach((c) => { const b = budgetById(c.budgetId);
      chRows.push([c.no, 'ขอเพิ่มงบ', b.company, T(b.type), b.code, day(c.createdAt), CHANGE_STATE[c.state] || c.state, changeTotal(c), (c.meeting || {}).no || '', c.reason || '', userName(c.createdBy)]); });
    budgets.forEach((b) => (b.history || []).filter((h) => /^(TRF|DEC)-/.test(h.ref || '') && h.action !== 'รับงบที่โยกเข้า').forEach((h) => {
      const amt = Number(String(h.note || '').replace(/^[A-Z]+-\d+-\d+ · /, '').split(' บาท')[0].replace(/,/g, '')) || '';
      chRows.push([h.ref, h.ref.startsWith('TRF') ? 'โยกงบ' : 'ลดงบ', b.company, T(b.type), b.code, day(h.at), 'บันทึกแล้ว', h.ref.startsWith('DEC') && amt ? -amt : amt, '', h.note || '', userName(h.by)]);
    }));
    add('changes', [S('เลขที่', 15), S('ประเภท', 11), S('บริษัท', 8), S('ประเภทงบ', 9), S('รหัสโครงการ (ต้นทาง)'), S('วันที่', 11), S('สถานะ', 14), N('จำนวนเงิน'), S('เลขที่มติ / อนุมัติ', 20),
      S('เหตุผล / รายละเอียด', 44), S('โดย', 16)], chRows);

    const cfRows = [];
    budgets.filter((b) => b.type === 'CAPEX' && isActive(b)).forEach((b) => ledgerItems(b).forEach((it) => {
      const act = actualByMonth(b, it.id);
      fyMonths(b).forEach((ym) => {
        const plan = planOf(b, it.id, ym);
        const a = act[ym] || 0;
        if (plan || a) cfRows.push([b.company, b.code, it.code, it.name, itemTotal(it), ym, plan, round2(a), round2(plan - a)]);
      });
    }));
    add('cashflow', [S('บริษัท', 8), S('รหัสโครงการ'), S('รหัส Item', 16), S('ชื่อ Item', 28), N('งบ Item'), S('เดือน (ปี-เดือน)', 12), N('แผน (Plan)'), N('ใช้จริง (ตัดงบ)'), N('ผลต่าง')], cfRows);
    return sheets;
  }

  function viewExport() {
    if (!canExport()) return '<div class="alert error">ไม่มีสิทธิ์ส่งออกข้อมูล</div>';
    const years = uniq(db.budgets.map((b) => String(b.fiscalYear))).sort().reverse();
    const sel = (name, label, opts) => '<label class="field"><span>' + label + '</span><div class="select-wrap"><select name="' + name + '">' + opts + '</select></div></label>';
    return '<div class="page-head"><div><h1>ส่งออกข้อมูล (Excel)</h1><div class="page-sub">ข้อมูลการเงินและบัญชีสำหรับทำรายงาน / บันทึกบัญชี — ไฟล์ .xlsx เปิดด้วย Excel ได้ทันที แต่ละหัวข้อเป็นแผ่นงาน (Sheet) แยกกัน</div></div></div>' +
      '<form id="exportForm" class="form-main"><section class="card form-section"><div class="form-grid">' +
      sel('year', 'ปีงบประมาณ', '<option value="">ทุกปี</option>' + years.map((y) => opt(y, y, String(new Date().getFullYear()))).join('')) +
      sel('company', 'บริษัท', '<option value="">ทุกบริษัท</option>' + optList(db.master.companies, 'code', (c) => c.code + (c.name ? ' — ' + c.name : ''), '')) +
      sel('type', 'ประเภทงบ', '<option value="">ทั้ง CAPEX และ OPEX</option>' + opt('CAPEX', TYPE_LABEL.CAPEX, '') + opt('CBS', TYPE_LABEL.CBS, '')) +
      '</div></section><section class="card form-section"><h2 class="section-title">ข้อมูลที่ต้องการ</h2><div class="export-list">' +
      EXPORT_SHEETS.map(([k, t, hint]) => '<label class="export-opt"><input type="checkbox" name="sheet" value="' + k + '" checked><span><strong>' + t + '</strong><small>' + hint + '</small></span><em data-count="' + k + '"></em></label>').join('') +
      '</div></section><div class="actions"><button class="btn primary" type="submit">ดาวน์โหลดไฟล์ Excel</button></div></form>';
  }

  function bindExport() {
    const form = document.getElementById('exportForm');
    if (!form) return;
    const filters = () => ({ year: form.elements.year.value, company: form.elements.company.value, type: form.elements.type.value,
      sheets: Array.from(form.querySelectorAll('[name="sheet"]:checked')).map((x) => x.value) });
    const counts = () => {
      const all = exportData(Object.assign(filters(), { sheets: EXPORT_SHEETS.map((x) => x[0]) }));
      EXPORT_SHEETS.forEach(([k, t]) => { const s = all.find((x) => x.name === t); form.querySelector('[data-count="' + k + '"]').textContent = (s ? s.rows.length : 0).toLocaleString('th-TH') + ' แถว'; });
    };
    form.addEventListener('change', counts);
    counts();
    guard(form, [{ btn: 'button[type="submit"]', missing: (f) => [!f.querySelector('[name="sheet"]:checked') && 'เลือกข้อมูลอย่างน้อย 1 หัวข้อ'] }]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fl = filters();
      if (!fl.sheets.length) return;
      const bytes = buildXlsx(exportData(fl));
      const name = 'budget-export-' + [fl.year || 'all', fl.company, fl.type ? TYPE_SHORT[fl.type] : ''].filter(Boolean).join('-') + '-' + new Date().toISOString().slice(0, 10) + '.xlsx';
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      logAction('ส่งออกข้อมูล (Excel)', '', name + ' · ' + fl.sheets.length + ' หัวข้อ');
      save();
    });
  }

  /** แบบฟอร์มขออนุมัติงบสำหรับเข้าที่ประชุม (ฟอร์มชั่วคราว รอแบบฟอร์มจริงจากทีมผู้ใช้) */
  function viewBudgetRequestForm(id) {
    const b = budgetById(id);
    if (!b) return notFound();
    const isCapex = b.type === 'CAPEX';
    const tr = (k, v) => '<tr><th style="width:30%">' + k + '</th><td>' + v + '</td></tr>';
    const rows = b.structure === 'project'
      ? '<tr><td>1</td><td>งบรวมทั้งโครงการ (ยังไม่แยกรายการย่อย)</td><td class="num">' + money(budgetTotal(b)) + '</td></tr>'
      : ledgerItems(b).map((i, n) => '<tr><td>' + (n + 1) + '</td><td>' + esc(i.code + ' ' + i.name) + (isCapex ? '<br><small>' + esc(i.assetType) + ' · DOA ' + esc(i.doa) + '</small>' : '') +
        '</td><td class="num">' + money(itemTotal(i)) + '</td></tr>').join('');
    return '<div class="actions no-print" style="margin:0 0 1rem"><button class="btn primary" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>' +
      '<div class="alert info no-print">แบบฟอร์มชั่วคราว — จะปรับตามแบบฟอร์มจริงที่ทีมผู้ใช้ส่งมา</div>' +
      '<article class="doc"><header><div><h1>' + esc(companyMap()[b.company] || b.company) + '</h1><div class="doc-sub">' + (isCapex ? 'แบบขออนุมัติงบประมาณ ' : 'แบบขออนุมัติงบประมาณ (เสนอผู้บริหาร) ') +
      (isCapex ? '(งบลงทุน CAPEX)' : '(งบดำเนินงาน OPEX)') + '</div></div><div class="docno">ปีงบประมาณ <strong>' + esc(b.fiscalYear) + '</strong><br>พิมพ์วันที่ ' + fmtDay(new Date().toISOString()) + '</div></header>' +
      '<div class="section"><table><tbody>' + tr('รหัสโครงการ', esc(b.code)) + tr('ชื่อโครงการ', esc(b.name)) + tr('หน่วยงาน', esc(b.department)) +
      tr('ผู้ขออนุมัติ (Business)', esc(userName(b.ownerId))) + (b.group ? tr('กลุ่มงบประมาณ', esc(b.group)) : '') + tr('ความจำเป็น / หมายเหตุ', esc(b.note || '-')) + '</tbody></table></div>' +
      '<div class="section"><h2>รายการที่ขออนุมัติ</h2><table><thead><tr><th style="width:2rem">#</th><th>รายการ</th><th class="num">วงเงิน (รวม VAT)</th></tr></thead><tbody>' + rows +
      '<tr><th colspan="2" class="right">รวมทั้งสิ้น</th><td class="num"><strong>' + money(budgetTotal(b)) + '</strong></td></tr></tbody></table></div>' +
      '<div class="section"><h2>' + apprOf(b.type).result + '</h2><table><tbody>' +
      tr(isCapex ? 'มติ' : 'ผลการพิจารณา', '☐ อนุมัติเต็มจำนวน &nbsp; ☐ อนุมัติบางส่วน จำนวน ........................ บาท &nbsp; ☐ ไม่อนุมัติ') +
      tr(isCapex ? 'ครั้งที่ / วันที่ประชุม' : 'วันที่อนุมัติ', '.......................................') + tr('หมายเหตุ', '<br><br>') + '</tbody></table></div>' +
      '<div class="signs"><div><div class="line"></div>ผู้ขออนุมัติ<br>' + esc(userName(b.ownerId)) + '</div><div><div class="line"></div>ผู้บังคับบัญชา</div><div><div class="line"></div>' + (isCapex ? 'ประธานที่ประชุม' : 'ผู้บริหารผู้อนุมัติ') + '</div></div>' +
      '</article>';
  }

  // ---------------------------------------------------------------- request form

  /** ตัวเลือกรายการ (เฉพาะรายการล่างสุด) พร้อมยอดคงเหลือ ไม่นับยอดที่คำขอนี้จองไว้เอง */
  function itemOptions(b, existing, selected, isCapex) {
    return sortedItems(b).filter((i) => b.type === 'CBS' || isLeaf(b, i)).map((i) => {
      const remaining = remainingFor(b, i.id, existing);
      const node = budgetNodeOf(b, i);
      const note = node !== i ? ' (ใช้วงเงิน Item ' + node.code + ')' : '';
      return '<option value="' + i.id + '" data-remaining="' + remaining + '"' + (i.id === selected ? ' selected' : '') + '>' +
        (b.type === 'CBS' ? '\u00a0\u00a0'.repeat(depth(i)) : '') + esc(i.code + ' ' + i.name) + ' — คงเหลือ ' + money(remaining) + ' บาท' + note + '</option>';
    }).join('');
  }

  /** single = เลือกรายการเดียวทั้งใบ (ไม่มีช่องเลือกรายการต้นทุนในแต่ละบรรทัด) */
  function lineRow(b, line, single, existing) {
    const vat = line.vat === undefined ? b.type === 'CAPEX' : Number(line.vat) > 0;
    const withCat = single && b.structure === 'project';
    return '<tr class="line-row">' +
      '<td class="line-no"></td>' +
      (withCat ? '<td><div class="select-wrap"><select name="lnCat" aria-label="หมวดค่าใช้จ่าย"><option value="">— เลือกหมวด —</option>' +
        optList(db.master.expenseCategories, 'name', (c) => c.name, line.category || '') + '</select></div></td>' +
        '<td>' + investorSelect('lnInv', line.investor || b.company) + '</td>' : '') +
      (single ? '' : '<td><div class="select-wrap"><select name="lnItem" aria-label="' + (b.type === 'CAPEX' ? 'รายการย่อย (Item No.)' : 'รายการต้นทุน') + '"><option value="">— เลือก —</option>' +
        itemOptions(b, existing, line.itemId, false) + '</select></div></td>') +
      '<td><input name="lnDesc" value="' + esc(line.description || '') + '" aria-label="รายการ" placeholder="' +
      (b.type === 'CAPEX' ? 'เช่น เครื่องชั่งดิจิตอล ละเอียด 1 mg' : 'เช่น ค่าแรงดูแลกล้า 3 วัน @349') + '"></td>' +
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
    if (b.ownerId !== u.id || !can('request.create')) return '<div class="alert error">ขอดำเนินการใช้งบได้เฉพาะ Business ผู้สร้างงบนี้</div>';
    if (!isActive(b)) return '<div class="alert error">งบนี้ยังไม่เปิดใช้งาน (สถานะ: ' + esc(BUDGET_STATE[b.state]) + ') — ต้องให้ผู้คุมงบยืนยันเปิดใช้ก่อน</div>';
    if (existing && existing.status !== 'rejected' && existing.status !== 'memo') return '<div class="alert error">แก้ไขได้เฉพาะคำขอที่ถูกส่งกลับเท่านั้น</div>';
    const isProject = b.structure === 'project';
    // งบที่แยก Item (CAPEX / OPEX): เลือก Item ทีละบรรทัด ใบเดียวใช้ได้หลาย Item · งบรวมโครงการ: เลือกหมวดค่าใช้จ่ายแทน
    const perLine = !isProject;
    const single = !perLine;
    const v = existing || { itemId: params.get('item') || (isProject ? b.items[0].id : ''), useType: 'prpo' };
    const lines = existing ? existing.lines : [{ itemId: perLine ? params.get('item') || '' : '' }];
    const val = (k) => ' value="' + esc(v[k] == null ? '' : v[k]) + '"';
    const field = (label, inner, extra) => '<label class="field"' + (extra || '') + '><span>' + label + '</span>' + inner + '</label>';
    const lastReject = existing ? existing.steps.find((s) => s.status === 'rejected') : null;
    const needMemo = memoRequired(b, lines);
    const memoOk = b.type === 'CAPEX'; // OPEX ไม่ใช้ Memo: ขอดำเนินการใช้งบด้วยเอกสารขอดำเนินการใช้งบตามปกติ
    const mv = (existing && existing.memo) || {};
    const mp = (existing && existing.memoParties) || defaultMemoParties(b, b.company);

    const remaining = usage(b).remaining;
    const step = (n, title, extra) => '<div class="section-head"><h2 class="section-title"><span class="step">' + n + '</span>' + title + '</h2>' + (extra || '') + '</div>';
    const typeCard = (k) => '<label class="choice-opt"><input type="radio" name="useType" value="' + k + '"' + (v.useType === k ? ' checked' : '') + '>' +
      '<span><strong>' + USE_TYPES[k].label + '</strong><small>' + USE_TYPES[k].cut + (USE_TYPES[k].hint ? ' · ' + USE_TYPES[k].hint : '') + '</small></span></label>';
    const projOwn = existing && isReserving(existing) ? existing.amount : 0;
    const general = '<section class="card form-section">' + step(1, 'ประเภทการดำเนินการใช้งบ') +
        '<div class="choice choice-4">' + Object.keys(USE_TYPES).map(typeCard).join('') + '</div></section>' +
      '<section class="card form-section">' + step(2, 'ข้อมูลการดำเนินการ') + '<div class="form-grid">' +
      (perLine ? '' : '<div class="full">' +
            '<input type="hidden" name="itemId" value="' + esc(b.items[0].id) + '" data-remaining="' + round2(usage(b).remaining + projOwn) + '">' +
              '<div class="field"><span>งบที่ใช้</span><div class="out left">งบรวมทั้งโครงการ ' + esc(b.code) + ' — คงเหลือ ' + money(round2(usage(b).remaining + projOwn)) + ' บาท</div></div></div>') +
          '<div class="full">' + field('วัตถุประสงค์ในการใช้งบ', '<textarea name="purpose" rows="3" required placeholder="เช่น จัดซื้อเครื่องชั่งสำหรับห้องปฏิบัติการ">' + esc(v.purpose || '') + '</textarea>') + '</div>' +
          field('<span id="payeeLabel">Supplier / ผู้รับเงิน</span>', '<input name="payee" required' + val('payee') + '>') +
          '<div class="field"><span>เอกสารประกอบ (ใบเสนอราคา ฯลฯ — ไม่บังคับ)</span><div id="reqFiles">' + attachList(v.attachments, { del: true, empty: 'ยังไม่มีไฟล์' }) + '</div>' +
          '<label class="btn small file-btn">+ แนบไฟล์<input type="file" id="reqFileInput" accept="application/pdf,image/png,image/jpeg" multiple hidden></label></div>' +
      '</div></section>';

    const linesCard = '<section class="card form-section">' +
      step(3, 'รายการที่ขอใช้', '<button type="button" class="btn" id="addLine">+ เพิ่มบรรทัด</button>') +
      '<div class="table-wrap"><table class="edit-table lines-table"><thead><tr><th style="width:2.5rem">#</th>' +
      (perLine ? '<th style="width:30%">' + (b.type === 'CAPEX' ? 'รายการย่อย (Item No.)' : 'รายการต้นทุน (OPEX)') + '</th>' : isProject ? '<th style="width:20%">หมวดค่าใช้จ่าย</th><th style="width:7rem">บริษัทที่ลงทุน</th>' : '') +
      '<th>' + (b.type === 'CBS' ? 'รายละเอียด (ถ้ามีจำนวน โปรดระบุ)' : 'รายละเอียดสิ่งที่ซื้อ / จ่าย') + '</th>' +
      '<th class="num" style="width:9.5rem">ก่อน VAT</th><th class="center" style="width:4.5rem">VAT 7%</th><th class="num" style="width:9rem">รวม</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="lineRows">' + lines.map((l) => lineRow(b, l, single, existing)).join('') + '</tbody>' +
      '<tfoot><tr><td colspan="' + (isProject ? 4 : 3) + '" class="right muted">รวมทั้งหมด</td>' +
      '<td class="num" id="sumBefore">0.00</td><td class="num" id="sumVat">0.00</td><td class="num"><strong id="sumTotal">0.00</strong></td><td></td></tr></tfoot>' +
      '</table></div>' +
      '<template id="lineTpl">' + lineRow(b, {}, single, existing) + '</template>' +
      '<div id="overBudget" hidden>' +
      '<div class="alert warn" id="overText"></div>' +
          field('เหตุผลที่ต้องใช้เกินงบ (ถ้ามี — ผู้คุมงบใช้ประกอบการพิจารณา)', '<textarea name="requesterReason" rows="2">' + esc(v.requesterReason || '') + '</textarea>') +
      '</div></section>';

    const side = '<div class="card total-card"><span class="muted">ขอใช้ครั้งนี้ (รวม VAT)</span>' +
      '<div class="total-amount"><span id="sideTotal">0.00</span> <small>บาท</small></div>' +
      '<dl class="kv compact"><dt>งบคงเหลือทั้งโครงการ</dt><dd>' + moneyCell(remaining) + '</dd>' +
      '<dt>คงเหลือหลังขอใช้</dt><dd id="sideAfter">' + moneyCell(remaining) + '</dd></dl>' +
      '<div class="actions side-actions">' +
      '<button class="btn primary tall" type="submit" data-action="send"' + (needMemo ? ' hidden' : '') + '>' + (existing && existing.status === 'rejected' ? 'ส่งให้ผู้คุมงบตรวจสอบอีกครั้ง' : 'ส่งให้ผู้คุมงบตรวจสอบ') + '</button>' +
      (memoOk ? '<button class="btn primary tall" type="submit" data-action="memo"' + (needMemo ? '' : ' hidden') + '>' + (existing && existing.status === 'memo' ? 'บันทึกและออก Memo ใหม่' : 'ทำ Memo ให้ผู้บริหารเซ็นก่อนส่ง') + '</button>' : '') +
      '<a class="btn" data-back href="' + (existing ? '#/request/' + existing.id : '#/budget/' + b.id) + '">ยกเลิก</a></div>' +
      (memoOk ? '<p class="muted memo-side-note" id="memoNote"' + (needMemo ? '' : ' hidden') + '><strong id="memoReason">' + esc(memoReason(b, lines)) + '</strong><br>' +
        '<strong>ทำ Memo:</strong> ระบบบันทึกคำขอ ออกเลขที่ Memo และจองงบไว้ → กรอก Memo ตามแบบฟอร์ม แล้วพิมพ์ ไปให้ผู้บริหารเซ็น → กลับมาแนบไฟล์ที่เซ็นแล้วที่หน้าคำขอ จึงส่งให้ผู้คุมงบได้' +
        (existing && existing.memo && existing.memo.no ? '<br>Memo เดิมเลขที่ ' + esc(existing.memo.no) + ' — แก้ไขแล้วต้องให้ผู้บริหารเซ็นใหม่' : '') + '</p></div>' : '</div>') +
      '<div class="card form-tip"><h3 class="side-title">คำแนะนำ</h3><p class="muted">' +
      (perLine ? 'ใบเดียวใช้ได้หลาย Item — ใส่ได้หลายบรรทัด แต่ละบรรทัดเลือก Item เอง (บรรทัดใหม่ใช้ Item เดียวกับบรรทัดก่อนหน้าเป็นค่าเริ่มต้น)'
        : 'งบรวมโครงการ: แต่ละบรรทัดเลือกหมวดค่าใช้จ่ายและพิมพ์รายละเอียด') +
          ' · ขอเกินงบรายการได้ถ้าไม่เกินงบรวมของโครงการ (ผู้คุมงบต้องใส่ Note) · ถ้าเกินงบโครงการ ผู้คุมงบจะพิจารณาโยกงบให้ หรือให้ขอเพิ่มงบ' +
          '</p></div>';

    return '<div class="page-head"><div><h1>' + (existing ? 'แก้ไขคำขอ ' + esc(existing.no) : 'ขอดำเนินการใช้งบ') + '</h1>' +
      '<div class="page-sub">' + badge(b.type, TYPE_SHORT[b.type]) + ' ' + esc(b.code + ' ' + b.name) + '</div></div></div>' +
      (lastReject ? '<div class="alert error">เหตุผลที่ส่งกลับ: ' + esc(lastReject.comment) + '</div>' : '') +
      '<div id="formError"></div>' +
      '<form id="requestForm" class="req-form" data-budget="' + b.id + '" data-request="' + esc(requestId || '') + '" data-remaining="' + remaining + '">' +
      '<div class="detail-layout"><div class="detail-main form-main">' + general + linesCard +
      '<div id="planWrap">' + planFieldset(existing && existing.paymentPlan, 4) + '</div>' +
      '</div><aside class="detail-side">' + side + '</aside></div></form>';
  }

  function planRow(x) {
    return '<tr><td class="line-no"></td>' +
      '<td><input name="planPct" type="number" min="0.01" max="100" step="0.01" class="right" value="' + esc(x.pct || '') + '" aria-label="% ของยอดรวม"></td>' +
      '<td class="num plan-amt">0.00</td>' +
      '<td><input name="planNote" value="' + esc(x.note || '') + '" placeholder="เช่น เมื่อส่งมอบเครื่อง / หลังติดตั้งแล้วเสร็จ" aria-label="เงื่อนไขของงวด"></td>' +
      '<td><button type="button" class="btn small bad" data-remove-plan title="ลบงวด">×</button></td></tr>';
  }

  /** เงื่อนไขการจ่าย (CAPEX): จ่ายครั้งเดียว หรือแบ่งเป็นงวดตาม % */
  function planFieldset(plan, stepNo) {
    const mode = plan && plan.mode === 'installments' ? 'installments' : 'single';
    const rows = mode === 'installments' ? plan.installments : [{}, {}];
    const opt2 = (value, title, sub) => '<label class="choice-opt"><input type="radio" name="payMode" value="' + value + '"' +
      (mode === value ? ' checked' : '') + '><span><strong>' + title + '</strong><small>' + sub + '</small></span></label>';
    return '<section class="card form-section"><div class="section-head"><h2 class="section-title"><span class="step">' + (stepNo || 3) + '</span>เงื่อนไขการจ่าย</h2></div><div class="choice">' +
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
      '<template id="planTpl">' + planRow({}) + '</template></section>';
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
        category: tr.querySelector('[name="lnCat"]') ? tr.querySelector('[name="lnCat"]').value : undefined,
        investor: tr.querySelector('[name="lnInv"]') ? tr.querySelector('[name="lnInv"]').value : undefined,
        description: tr.querySelector('[name="lnDesc"]').value.trim(),
        amountBeforeVat: before, vat, amount: round2(before + vat)
      };
    }).filter((l) => l.description || l.amountBeforeVat);
  }

  /** ยอดที่เกินคงเหลือ แยกตามรายการ: [{ item, remaining, amount }] */
  function overItems(form, b, lines, isCapex) {
    const remainingOf = (id) => {
      const sel = isCapex ? form.elements.itemId : form.querySelector('[name="lnItem"]');
      if (sel && sel.type === 'hidden') return Number(sel.dataset.remaining);
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
    const perLine = b.structure !== 'project'; // เลือก Item ทีละบรรทัด (ใบเดียวหลาย Item)
    const isCapex = !perLine; // ชื่อเดิม: = งบรวมโครงการ (ใช้ f.itemId ที่ซ่อนไว้)
    const existing = form.dataset.request ? requestById(form.dataset.request) : null;
    const tbody = document.getElementById('lineRows');
    let files = existing ? (existing.attachments || []).slice() : [];
    const fileInput = document.getElementById('reqFileInput');
    const showFiles = () => { document.getElementById('reqFiles').innerHTML = attachList(files, { del: true, empty: 'ยังไม่มีไฟล์' }); };
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        files = files.concat(await readFiles(e.target, 'request'));
        e.target.value = '';
        showFiles();
      });
      document.getElementById('reqFiles').addEventListener('click', (e) => {
        const del = e.target.closest('[data-att-del]');
        if (del) { files = files.filter((x) => x.id !== del.dataset.attDel); showFiles(); }
      });
    }
    // ---- ต้องทำ Memo หรือไม่: ดูจากบริษัทที่ลงทุนของทุกบรรทัด (ใช้เงินข้ามบริษัทกับ PCC)
    const rowLines = () => Array.from(form.querySelectorAll('#lineRows tr')).map((tr) => ({
      itemId: tr.querySelector('[name="lnItem"]') ? tr.querySelector('[name="lnItem"]').value : (f.itemId ? f.itemId.value : ''),
      investor: tr.querySelector('[name="lnInv"]') ? tr.querySelector('[name="lnInv"]').value : undefined
    }));
    const needMemo = () => memoRequired(b, rowLines());
    const syncMemo = () => {
      const need = needMemo();
      const send = form.querySelector('[data-action="send"]');
      const memo = form.querySelector('[data-action="memo"]');
      if (send) send.hidden = need;
      if (memo) memo.hidden = !need;
      const note = document.getElementById('memoNote');
      if (note) { note.hidden = !need; document.getElementById('memoReason').textContent = memoReason(b, rowLines()); }
    };
    form.addEventListener('change', syncMemo);
    form.addEventListener('input', syncMemo);
    syncMemo();
    // ---- ผู้รับและผู้ลงนามใน Memo: เปลี่ยนตามบริษัทที่ลงทุนจนกว่าผู้ขอจะพิมพ์แก้เอง
    const PARTY_FIELDS = { to: 'memoTo', cc: 'memoCc', reviewers: 'memoReviewers', approvers: 'memoApprovers' };
    const hasParties = !!f.memoTo;
    const readParties = () => ({ to: splitPeople(f.memoTo.value), cc: splitPeople(f.memoCc.value), reviewers: splitPeople(f.memoReviewers.value),
      approvers: splitPeople(f.memoApprovers.value), proposer: f.memoProposer.value.trim() });
    const touched = new Set(existing && existing.memoParties ? Object.keys(PARTY_FIELDS).concat(['proposer']) : []);
    if (hasParties) {
      Object.entries(PARTY_FIELDS).forEach(([k, n]) => f[n].addEventListener('input', () => touched.add(k)));
      f.memoProposer.addEventListener('input', () => touched.add('proposer'));
    }
    const mainInvestor = () => {
      const weight = {};
      readLines(form, isCapex).forEach((l) => {
        const c = l.investor || itemInvestor(b, itemById(b, l.itemId));
        weight[c] = (weight[c] || 0) + (l.amount || 0);
      });
      const top = Object.keys(weight).sort((x, y) => weight[y] - weight[x])[0];
      return top || (f.itemId && f.itemId.value ? itemInvestor(b, itemById(b, f.itemId.value)) : b.company);
    };
    const syncParties = () => {
      if (!hasParties) return;
      const d = defaultMemoParties(b, mainInvestor());
      Object.entries(PARTY_FIELDS).forEach(([k, n]) => { if (!touched.has(k)) f[n].value = d[k].join('\n'); });
      if (!touched.has('proposer')) f.memoProposer.value = d.proposer;
    };
    form.addEventListener('change', syncParties);
    form.addEventListener('input', syncParties);
    const useType = () => (form.querySelector('[name="useType"]:checked') || {}).value;
    const syncType = () => {
      const t = useType();
      const payee = { prpo: 'Supplier ที่จะสั่งซื้อ (ถ้าทราบ)', advance: 'ผู้รับเงินทดรอง', reimburse: 'พนักงานผู้สำรองจ่าย', direct: 'Supplier ผู้รับเงิน' }[t];
      document.getElementById('payeeLabel').textContent = payee || 'Supplier / ผู้รับเงิน';
      f.payee.required = t !== 'prpo';
      document.getElementById('planWrap').hidden = !(t === 'prpo' || t === 'direct');
    };
    form.querySelectorAll('[name="useType"]').forEach((el) => el.addEventListener('change', syncType));
    syncType();

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
      document.getElementById('sideTotal').textContent = money(sb + sv);
      const after = round2(Number(form.dataset.remaining) - (sb + sv));
      const afterEl = document.getElementById('sideAfter');
      afterEl.innerHTML = moneyCell(after);
      const over = overItems(form, b, readLines(form, isCapex), isCapex);
      const total = round2(sb + sv);
      const overProject = round2(total - Number(form.dataset.remaining));
      const notes = [];
      if (over.length && b.structure !== 'project') {
        over.forEach((x) => notes.push('เกินงบรายการ ' + esc(x.item ? x.item.code : '') + ' อยู่ <strong>' + money(x.amount - x.remaining) + '</strong> บาท' +
          (overProject > 0 ? '' : ' — ยังไม่เกินงบรวมของโครงการ ขอได้ แต่ผู้คุมงบต้องใส่ Note เมื่ออนุมัติ')));
      }
      if (overProject > 0) notes.push('เกินงบคงเหลือของโครงการ <strong>' + money(overProject) + '</strong> บาท — ผู้คุมงบจะพิจารณาโยกงบมาให้ หรือส่งกลับให้ขอเพิ่มงบ');
      document.getElementById('overBudget').hidden = !notes.length;
      document.getElementById('overText').innerHTML = notes.join('<br>');
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
      // บรรทัดใหม่ใช้ Item เดียวกับบรรทัดก่อนหน้าเป็นค่าเริ่มต้น
      if (perLine && tbody.rows.length > 1) {
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

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // ทำ Memo เฉพาะเมื่อเข้าเกณฑ์ (ใช้เงินข้ามบริษัทกับ PCC) — นอกนั้นส่งตรงให้ผู้คุมงบ
      const useMemo = needMemo();
      const lines = readLines(form, isCapex);
      const errors = [];
      if (!useType()) errors.push('กรุณาเลือกประเภทการดำเนินการใช้งบ');
      if (f.payee.required && !f.payee.value.trim()) errors.push('กรุณาระบุผู้รับเงิน');
      if (!lines.length) errors.push('กรุณาใส่รายการที่ขอเบิกอย่างน้อย 1 บรรทัด');
      lines.forEach((l, i) => {
        const no = 'บรรทัดที่ ' + (Array.from(tbody.rows).indexOf(l.tr) + 1) + ': ';
        if (perLine && !l.itemId) errors.push(no + (b.type === 'CAPEX' ? 'กรุณาเลือกรายการย่อย (Item No.)' : 'กรุณาเลือกรายการต้นทุน'));
        if (l.category === '') errors.push(no + 'กรุณาเลือกหมวดค่าใช้จ่าย');
        if (!l.description) errors.push(no + 'กรุณาระบุรายการ');
        if (!(l.amountBeforeVat > 0)) errors.push(no + 'จำนวนเงินต้องมากกว่า 0');
      });
      const plan = useType() === 'prpo' || useType() === 'direct' ? readPlan(form) : { mode: 'single', installments: [] };
      if (plan && plan.mode === 'installments') {
        const sumPct = round2(plan.installments.reduce((s, x) => s + x.pct, 0));
        if (plan.installments.length < 2) errors.push('แบ่งจ่ายเป็นงวดต้องมีอย่างน้อย 2 งวด');
        if (plan.installments.some((x) => !(x.pct > 0))) errors.push('กรุณาระบุ % ของทุกงวด');
        if (sumPct !== 100) errors.push('เปอร์เซ็นต์รวมของทุกงวดต้องเท่ากับ 100% (ตอนนี้ ' + sumPct + '%)');
      }
      if (errors.length) { showErrors(errors); return; }

      const now = new Date().toISOString();
      const clean = lines.map((l) => Object.assign({ itemId: l.itemId, description: l.description, amountBeforeVat: l.amountBeforeVat, vat: l.vat, amount: l.amount },
        l.category !== undefined ? { category: l.category } : {}, l.investor !== undefined ? { investor: l.investor } : {}));
      const fields = {
        itemId: isCapex ? f.itemId.value : (clean[0] || {}).itemId,
        lines: clean,
        payee: f.payee.value.trim(),
        poNo: 'N/A',
        amountBeforeVat: round2(clean.reduce((s, l) => s + l.amountBeforeVat, 0)),
        vat: round2(clean.reduce((s, l) => s + l.vat, 0)),
        amount: round2(clean.reduce((s, l) => s + l.amount, 0))
      };
      fields.purpose = f.purpose.value.trim();
      fields.memoBackground = f.memoBackground ? f.memoBackground.value.trim() : '';
      fields.useType = useType();
      fields.paymentPlan = plan;
      fields.paymentTerms = planText({ paymentPlan: plan });
      fields.payments = [];
      fields.cuts = [];
      fields.attachments = files;
      // ต้องใช้ Memo: บันทึกเป็น "รอแนบ Memo" ออกเลขที่ Memo (ใช้เลขเดิมถ้ามี) — แก้ข้อมูลแล้วต้องเซ็นใหม่ จึงล้างไฟล์ที่แนบไว้
      if (useMemo) {
        fields.memo = { no: (existing && existing.memo && existing.memo.no) || nextMemoNo(b), by: '', files: [], issuedAt: now };
        if (hasParties) fields.memoParties = readParties();
      }
      fields.requesterReason = f.requesterReason ? f.requesterReason.value.trim() : '';

      let r;
      if (existing) {
        // แก้ไขแล้วส่งใหม่: เก็บผลตรวจสอบรอบก่อนไว้เป็นประวัติ
        r = existing;
        if (existing.status === 'rejected') r.history = (r.history || []).concat(r.steps);
        Object.assign(r, fields, { status: useMemo ? 'memo' : 'pending', steps: stepsFor(b), resubmittedAt: now });
        if (!useMemo) { delete r.memo; delete r.memoParties; delete r.memoDoc; } // เลือกส่งตรงโดยไม่ใช้ Memo
      } else {
        r = Object.assign({
          id: nextId('r'), no: nextReqNo(), budgetId: b.id, type: b.type,
          requesterId: me().id, createdAt: now, status: useMemo ? 'memo' : 'pending', steps: stepsFor(b), history: [], events: []
        }, fields);
        db.requests.push(r);
      }
      addEvent(r, useMemo ? (existing ? 'แก้ไขคำขอ และออก Memo ' : 'บันทึกคำขอ (' + USE_TYPES[r.useType].short + ') และออก Memo ') + r.memo.no
        : existing ? 'แก้ไขและส่งใหม่' : 'ส่งขอดำเนินการใช้งบ (' + USE_TYPES[r.useType].short + ')', '');
      if (useMemo) {
        save();
        setFlash('success', 'บันทึกคำขอ ' + r.no + ' และออก Memo เลขที่ ' + r.memo.no + ' แล้ว — พิมพ์ Memo ให้ผู้บริหารเซ็น แล้วกลับมาแนบไฟล์ที่หน้านี้เพื่อส่งให้ผู้คุมงบ');
        go('#/request/' + r.id + '/memo');
        return;
      }

      if (!r.steps.length) {
        issueDocument(r, b, now);
        setFlash('success', 'จัดทำเอกสารเรียบร้อย เลขที่ ' + r.docNo + (r.overBudget ? ' (ใช้เกินงบ — บันทึกเหตุผลแล้ว)' : ''));
      } else {
        setFlash('success', (existing ? 'ส่งคำขอ ' + r.no + ' อีกครั้ง' : 'ส่งคำขอ ' + r.no) + ' เรียบร้อยแล้ว รอผู้คุมงบตรวจสอบ');
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
      // GL ตั้งต้นจากรายการต้นทุน
      r.lines.forEach((l) => {
        const it = itemById(b, l.itemId) || {};
        l.glCode = it.glCode || '';
        l.glName = it.glName || '';
      });
    }
  }

  // ---------------------------------------------------------------- request lists

  /** Item ที่คำขอนี้ใช้ (ใบเดียวใช้ได้หลาย Item ทั้ง CAPEX และ OPEX) */
  const reqItems = (b, r) => reqItemIds(r).map((id) => itemById(b, id)).filter(Boolean);
  /** Item ที่ใช้อ้างอิงหมวด DOA (CAPEX): Item ที่ขอใช้ยอดมากที่สุดในใบ */
  function reqDoaItem(b, r) {
    const items = reqItems(b, r);
    return items.sort((x, y) => linesAmount(r, [y.id]) - linesAmount(r, [x.id]))[0] || null;
  }
  function itemCodesCell(b, r) {
    const items = reqItems(b, r);
    if (!items.length) return '-';
    if (items.length === 1) return '<span class="nowrap">' + esc(items[0].code) + '</span><div class="muted">' + esc(items[0].name) + '</div>';
    return esc(items.map((i) => i.code).join(', ')) + '<div class="muted">' + items.length + ' รายการ</div>';
  }

  function requestTable(list, showBudget) {
    if (!list.length) return '<div class="card empty">ยังไม่มีคำขอดำเนินการใช้งบ</div>';
    list = list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return '<div class="table-wrap"><table><thead><tr><th>เลขที่คำขอ</th>' +
      (showBudget ? '<th>งบ</th>' : '') +
      '<th>รายการ</th><th>รายละเอียด</th><th>ผู้ขอ</th><th class="num">จำนวนเงิน</th><th>สถานะ</th><th>เอกสาร</th></tr></thead><tbody>' +
      list.map((r) => {
        const b = budgetById(r.budgetId);
        const step = currentStep(r);
        return '<tr><td class="nowrap"><a href="#/request/' + r.id + '">' + esc(r.no) + '</a><div class="muted">' + fmtDate(r.createdAt) + '</div></td>' +
          (showBudget ? '<td>' + badge(r.type, TYPE_SHORT[r.type]) + ' ' + esc(b ? b.code : '-') + (r.useType && USE_TYPES[r.useType] ? '<div class="muted">' + esc(USE_TYPES[r.useType].short) + '</div>' : '') + '</td>' : '') +
          '<td>' + itemCodesCell(b, r) + '</td>' +
          '<td>' + esc(reqSummary(r)) + (r.overBudget ? ' <span class="badge rejected">เกินงบ</span>' : '') + '</td>' +
          '<td class="nowrap">' + esc(userName(r.requesterId)) + '</td>' +
          '<td class="num">' + money(r.amount) +
          ((r.status === 'approved' || r.status === 'closed') ? '<div class="muted">ตัดงบ ' + money(cutTotal(r)) + '</div>' : '') + '</td>' +
          '<td>' + badge(r.status, statusText(r)) + (needsPO(r) ? '<div class="muted">รอจัดซื้อออก PO</div>' : '') +
          '</td>' +
          '<td class="nowrap">' + (!r.docNo ? '-' : r.status === 'cancelled' ? '<s>' + esc(r.docNo) + '</s> <span class="muted">(ยกเลิก)</span>'
            : '<a href="#/doc/' + r.id + '">' + esc(r.docNo) + '</a>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function viewRequests() {
    const u = me();
    const list = canViewAll() ? db.requests : db.requests.filter((r) => r.requesterId === u.id);
    return '<div class="page-head"><h1>' + 'รายการดำเนินการใช้งบ' + '</h1></div>' + takeFlash() + requestTable(list, true);
  }


  // ---------------------------------------------------------------- request detail

  function linesTable(b, r, withGl) {
    const isCapex = r.type === 'CAPEX';
    const withCat = r.lines.some((l) => l.category !== undefined);
    const withItem = !withCat && b.structure !== 'project';
    return '<div class="table-wrap"><table><thead><tr><th style="width:2.5rem">#</th>' +
      (withCat ? '<th>หมวดค่าใช้จ่าย</th>' : withItem ? '<th>' + (isCapex ? 'รายการย่อย (Item No.)' : 'รายการต้นทุน') + '</th>' : '') + (withGl ? '<th>GL</th>' : '') +
      '<th>บริษัทที่ลงทุน</th><th>' + (isCapex ? 'รายการที่ซื้อ / จ่าย' : 'รายละเอียด') + '</th><th class="num">ก่อน VAT</th><th class="num">VAT 7%</th><th class="num">รวม</th></tr></thead><tbody>' +
      r.lines.map((l, i) => {
        const it = itemById(b, l.itemId) || {};
        return '<tr><td>' + (i + 1) + '</td>' +
          (withCat ? '<td>' + esc(l.category || '-') + '</td>' : withItem ? '<td>' + esc(it.code) + '<div class="muted">' + esc(it.name) + '</div></td>' : '') +
          (withGl ? '<td>' + esc(l.glCode || '-') + '<div class="muted">' + esc(l.glName || '') + '</div></td>' : '') +
          '<td>' + investorCell(lineInvestor(b, l)) + '</td>' +
          '<td>' + esc(l.description) + '</td><td class="num">' + money(l.amountBeforeVat) + '</td><td class="num">' + money(l.vat) +
          '</td><td class="num">' + money(l.amount) + '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="' + (3 + (withCat || withItem ? 1 : 0) + (withGl ? 1 : 0)) + '" class="right"><strong>รวม</strong></td>' +
      '<td class="num">' + money(r.amountBeforeVat) + '</td><td class="num">' + money(r.vat) + '</td><td class="num"><strong>' + money(r.amount) + '</strong></td></tr></tfoot></table></div>';
  }

  /**
   * ยอดที่เกินงบรายการ / เกินงบคงเหลือของโครงการ (คำขอที่รออยู่ไม่นับตัวเองซ้ำ)
   * items = รายการที่เกิน (ใบ OPEX มีได้หลายรายการต้นทุน) · item = ยอดเกินรวมของรายการเหล่านั้น
   */
  function capexOver(r) {
    const b = budgetById(r.budgetId);
    const own = isReserving(r) ? r.amount : 0;
    const projRem = round2(usage(b).remaining + own);
    const items = [];
    if (b.structure !== 'project') {
      // ตรวจทุก Item ที่มีวงเงินในสายของแต่ละบรรทัด (เช่น Item ย่อยที่กำหนดวงเงิน และ Item หลัก)
      const seen = new Set();
      reqItemIds(r).forEach((id) => {
        let it = itemById(b, id);
        while (it) {
          if (hasOwnBudget(b, it) && !seen.has(it.id)) {
            seen.add(it.id);
            const amt = linesAmount(r, leafIdsUnder(b, it));
            const rem = round2(usage(b, it.id).remaining + (isReserving(r) ? amt : 0));
            if (amt > rem) items.push({ item: it, remaining: rem, over: round2(amt - rem), root: rootOf(b, it) });
          }
          it = b.type === 'CBS' ? parentOf(b, it) : null;
        }
      });
    }
    // ยอดเกินรวม: แต่ละสาย (Item หลัก) นับค่าสูงสุดของสายนั้น แล้วรวมทุกสาย
    const perRoot = {};
    items.forEach((x) => { perRoot[x.root.id] = Math.max(perRoot[x.root.id] || 0, x.over); });
    const itemRem = items.length === 1 ? items[0].remaining : projRem;
    return { itemRem, projRem, items, item: round2(Object.values(perRoot).reduce((x, i) => x + i, 0)), project: Math.max(0, round2(r.amount - projRem)) };
  }

  const CUT_KIND = { po: 'ใบสั่งซื้อ (PO)', clear: 'เคลียร์เงินทดรอง', reimburse: 'จ่ายคืนพนักงาน', payment: 'จ่ายเงิน Supplier' };
  const CUT_FOR_TYPE = { prpo: 'po', advance: 'clear', reimburse: 'reimburse', direct: 'payment' };
  /** ประเภทที่บันทึกครั้งเดียวแล้วปิดยอดทันที (ยอดจริงชัดเจนจากใบเสร็จ) */
  const CUT_CLOSES = { clear: true, reimburse: true };
  const cutPerm = (r) => (r.useType === 'prpo' ? 'po.record' : 'cut.record');

  /** การตัดงบของใบดำเนินการใช้งบ CAPEX ตามประเภท */
  function cutPanel(r) {
    const t = r.useType || 'direct';
    const kind = CUT_FOR_TYPE[t];
    const closed = r.status === 'closed';
    const cut = cutTotal(r);
    const canCut = !closed && can(cutPerm(r)) && (t !== 'advance' || r.advance);
    let html = '<h2>การตัดงบ · ' + esc(USE_TYPES[t].label) + '</h2><section class="card cut-card">' +
      '<p class="muted small-note" style="margin:0 0 var(--s-3)">' + esc(USE_TYPES[t].cut) + ' · ผู้บันทึก: ' + esc(USE_TYPES[t].who) + '</p>' +
      '<div class="cut-summary"><div><span>ขอไว้</span><strong>' + money(r.amount) + '</strong></div>' +
      '<div><span>ตัดงบแล้ว</span><strong>' + money(cut) + '</strong></div>' +
      '<div><span>' + (closed ? 'คืนเข้างบ' : 'ยังจองไว้') + '</span><strong>' + money(closed ? r.closed.returned : Math.max(0, round2(r.amount - cut))) + '</strong></div></div>';
    if (cut > r.amount) html += '<div class="alert warn">ยอดจริงเกินที่ขอ ' + money(round2(cut - r.amount)) + ' บาท</div>';

    if (t === 'advance') {
      if (r.advance) {
        html += '<p class="cut-step done">✓ จ่ายเงินทดรองแล้ว ' + money(r.advance.amount) + ' บาท · ' + fmtDay(r.advance.date) + ' · ' + esc(userName(r.advance.by)) + '</p>';
      } else if (!closed && can('cut.record')) {
        html += '<form id="advForm" class="cut-form" data-id="' + r.id + '"><h3>ขั้นที่ 1: จ่ายเงินทดรอง</h3><div class="row">' +
          '<label class="field"><span>วันที่จ่าย</span><input name="date" type="date" required value="' + today() + '"></label>' +
          '<label class="field"><span>ยอดเงินทดรอง (บาท)</span><input name="amount" type="number" min="0.01" step="0.01" class="right" required value="' + r.amount + '"></label></div>' +
          '<p class="muted small-note">จ่ายเงินทดรองยังไม่ตัดงบ — ตัดงบเมื่อเคลียร์ตามใบเสร็จ</p>' +
          '<div class="actions"><button class="btn primary" type="submit">บันทึกการจ่ายเงินทดรอง</button></div></form>';
      } else {
        html += '<p class="cut-step">รอผู้คุมงบจ่ายเงินทดรอง</p>';
      }
    }

    if ((r.cuts || []).length) {
      html += '<div class="table-wrap"><table><thead><tr><th>วันที่</th><th>รายการ</th><th>เลขที่อ้างอิง</th><th class="num">ยอด (รวม VAT)</th><th>ไฟล์</th><th>ผู้บันทึก</th></tr></thead><tbody>' +
        r.cuts.map((c) => '<tr><td class="nowrap">' + fmtDay(c.date) + '</td><td>' + esc(CUT_KIND[c.kind] || c.kind) +
          (c.asset || c.expense ? '<div class="muted">Asset ' + money(c.asset || 0) + ' · Expense ' + money(c.expense || 0) + '</div>' : '') +
          (c.note ? '<div class="muted">' + esc(c.note) + '</div>' : '') + '</td>' +
          '<td>' + (c.prNo ? 'PR ' + esc(c.prNo) + '<br>' : '') + (c.poNo ? 'PO ' + esc(c.poNo) : esc(c.ref || '-')) + '</td>' +
          '<td class="num">' + money(c.amount) + '</td><td>' + ((c.attachments || []).length ? attachList(c.attachments) : '<span class="muted">-</span>') + '</td>' +
          '<td class="nowrap">' + esc(userName(c.by)) + '</td></tr>').join('') + '</tbody></table></div>';
    } else if (!(t === 'advance' && !r.advance)) {
      html += '<p class="muted">ยังไม่มีการตัดงบ' + (t === 'prpo' ? ' — รอจัดซื้อบันทึก PO' : '') + '</p>';
    }

    if (canCut) {
      const isPo = kind === 'po';
      const left = Math.max(0, round2(r.amount - cut));
      const title = { po: 'บันทึก PR / PO (ตัดงบตามยอด PO)', clear: 'ขั้นที่ 2: เคลียร์เงินทดรอง (ตัดงบตามใบเสร็จและปิดยอด)', reimburse: 'จ่ายคืนพนักงาน (ตัดงบตามใบเสร็จและปิดยอด)', payment: 'บันทึกการจ่ายเงิน Supplier' }[kind];
      html += '<form id="cutForm" class="cut-form" data-id="' + r.id + '" data-kind="' + kind + '"><h3>' + title + '</h3><div class="row">' +
        (isPo ? '<label class="field"><span>เลขที่ PR</span><input name="prNo" required></label><label class="field"><span>เลขที่ PO</span><input name="poNo" required></label>'
          : '<label class="field"><span>เลขที่ใบเสร็จ / ใบแจ้งหนี้</span><input name="ref"></label>') +
        '<label class="field"><span>' + (isPo ? 'วันที่ PO' : 'วันที่จ่าย') + '</span><input name="date" type="date" required value="' + today() + '"></label>' +
        '<label class="field"><span>' + (isPo ? 'ยอด PO (รวม VAT)' : kind === 'clear' ? 'ยอดใช้จริงตามใบเสร็จ' : 'ยอดจ่าย (รวม VAT)') + '</span>' +
        '<input name="amount" type="number" min="0.01" step="0.01" class="right" required value="' + (left || '') + '"></label></div>' +
        (isPo || r.type !== 'CAPEX' ? '' : '<div class="row"><label class="field"><span>Asset (บัญชี — ไม่บังคับ)</span><input name="asset" type="number" min="0" step="0.01" class="right"></label>' +
          '<label class="field"><span>Expenses (บัญชี — ไม่บังคับ)</span><input name="expense" type="number" min="0" step="0.01" class="right"></label></div>') +
        '<label class="field"><span>หมายเหตุ (จำเป็นถ้ายอดรวมเกินที่ขอ)</span><input name="note"></label>' +
        '<div class="field"><span>แนบไฟล์ ' + (isPo ? 'PO' : 'ใบเสร็จ / หลักฐานการจ่าย') + '</span><input type="file" name="files" accept="application/pdf,image/png,image/jpeg" multiple></div>' +
        '<div class="actions"><button class="btn primary" type="submit">' + (CUT_CLOSES[kind] ? 'บันทึกและปิดยอด' : 'บันทึก') + '</button></div></form>';
    }
    if (!closed && cut > 0 && !CUT_CLOSES[kind] && (can(cutPerm(r)) || can('cut.record'))) {
      html += '<form id="closeForm" class="cut-form" data-id="' + r.id + '"><h3>ยืนยันยอดจริงและปิดยอด</h3>' +
        '<p class="muted small-note">ปิดแล้วจะคืนส่วนต่าง ' + money(Math.max(0, round2(r.amount - cut))) + ' บาทเข้างบ และบันทึกการตัดงบเพิ่มไม่ได้อีก</p>' +
        '<label class="field"><span>หมายเหตุ (จำเป็นถ้ายอดจริงเกินที่ขอ)</span><input name="note"></label>' +
        '<div class="actions"><button class="btn ok" type="submit">ปิดยอด</button></div></form>';
    }
    if (closed) {
      html += '<div class="alert ok">ปิดยอดแล้ว · ยอดจริง ' + money(r.closed.actual) + ' บาท' + (r.closed.returned ? ' · คืนเข้างบ ' + money(r.closed.returned) + ' บาท' : '') +
        (r.closed.over ? ' · เกินที่ขอ ' + money(r.closed.over) + ' บาท' : '') + '<br><small>' + esc(userName(r.closed.by)) + ' · ' + fmtDate(r.closed.at) +
        (r.closed.note ? ' · ' + esc(r.closed.note) : '') + '</small>' +
        (t === 'advance' && r.advance ? '<br><small>' + (r.advance.amount > r.closed.actual ? 'พนักงานต้องคืนเงินทดรองส่วนที่เหลือ ' + money(round2(r.advance.amount - r.closed.actual)) + ' บาท'
          : r.advance.amount < r.closed.actual ? 'บริษัทต้องจ่ายเพิ่มให้พนักงาน ' + money(round2(r.closed.actual - r.advance.amount)) + ' บาท' : 'ยอดเคลียร์เท่ากับเงินทดรอง') + '</small>' : '') + '</div>';
    }
    return html + '</section>';
  }

  /** ปิดยอด: ยืนยันยอดจริง คืนส่วนต่างเข้างบ */
  function closeRequest(r, note) {
    const actual = cutTotal(r);
    r.status = 'closed';
    r.closed = { at: new Date().toISOString(), by: me().id, actual, returned: Math.max(0, round2(r.amount - actual)), over: Math.max(0, round2(actual - r.amount)), note: note || '' };
    addEvent(r, 'ปิดยอด (ยืนยันยอดจริง)', 'ยอดจริง ' + money(actual) + (r.closed.returned ? ' · คืนเข้างบ ' + money(r.closed.returned) : '') +
      (r.closed.over ? ' · เกินที่ขอ ' + money(r.closed.over) : '') + (note ? ' · ' + note : ''));
  }

  function bindCuts() {
    const adv = document.getElementById('advForm');
    if (adv) {
      adv.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = requestById(adv.dataset.id);
        const amount = round2(adv.elements.amount.value);
        if (!(amount > 0)) { alert('จำนวนเงินต้องมากกว่า 0'); return; }
        r.advance = { date: adv.elements.date.value, amount, by: me().id, at: new Date().toISOString() };
        addEvent(r, 'จ่ายเงินทดรอง', money(amount) + ' บาท');
        save();
        setFlash('success', 'บันทึกการจ่ายเงินทดรอง ' + money(amount) + ' บาทแล้ว — ตัดงบเมื่อเคลียร์ตามใบเสร็จ');
        go('#/request/' + r.id);
      });
    }
    const cf = document.getElementById('cutForm');
    if (cf) {
      cf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = requestById(cf.dataset.id);
        const f = cf.elements;
        const kind = cf.dataset.kind;
        const amount = round2(f.amount.value);
        const note = f.note.value.trim();
        if (!(amount > 0)) { alert('จำนวนเงินต้องมากกว่า 0'); return; }
        if (round2(cutTotal(r) + amount) > r.amount + 0.005 && !note) { alert('ยอดรวมเกินที่ขอ ' + money(round2(cutTotal(r) + amount - r.amount)) + ' บาท — กรุณาระบุหมายเหตุ'); return; }
        const asset = f.asset && f.asset.value !== '' ? round2(f.asset.value) : 0;
        const expense = f.expense && f.expense.value !== '' ? round2(f.expense.value) : 0;
        if (asset + expense > amount + 0.005) { alert('Asset + Expenses เกินยอดที่บันทึก'); return; }
        const files = await readFiles(f.files, kind);
        if (f.files.files.length && !files.length) return;
        const c = { id: nextId('x'), kind, date: f.date.value, amount, note, by: me().id, at: new Date().toISOString(), attachments: files, asset, expense };
        if (kind === 'po') Object.assign(c, { prNo: f.prNo.value.trim(), poNo: f.poNo.value.trim() });
        else c.ref = f.ref.value.trim();
        r.cuts = (r.cuts || []).concat(c);
        if (kind === 'po') r.poNo = r.cuts.filter((x) => x.kind === 'po').map((x) => x.poNo).join(', ');
        addEvent(r, 'บันทึก' + CUT_KIND[kind], money(amount) + ' บาท' + (c.poNo ? ' · PO ' + c.poNo : c.ref ? ' · ' + c.ref : ''));
        if (CUT_CLOSES[kind]) closeRequest(r, note);
        if (!save()) return;
        setFlash('success', 'บันทึก' + CUT_KIND[kind] + ' ' + money(amount) + ' บาทแล้ว' + (CUT_CLOSES[kind] ? ' และปิดยอดเรียบร้อย' : ''));
        go('#/request/' + r.id);
      });
    }
    const cl = document.getElementById('closeForm');
    if (cl) {
      cl.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = requestById(cl.dataset.id);
        const note = cl.elements.note.value.trim();
        if (cutTotal(r) > r.amount + 0.005 && !note) { alert('ยอดจริงเกินที่ขอ — กรุณาระบุหมายเหตุ'); return; }
        if (!confirm('ยืนยันยอดจริง ' + money(cutTotal(r)) + ' บาท และปิดยอด?')) return;
        closeRequest(r, note);
        save();
        setFlash('success', 'ปิดยอด ' + (r.docNo || r.no) + ' แล้ว' + (r.closed.returned ? ' คืน ' + money(r.closed.returned) + ' บาทเข้างบ' : ''));
        go('#/request/' + r.id);
      });
    }
  }

  function viewRequestDetail(id) {
    const r = requestById(id);
    if (!r) return notFound();
    const b = budgetById(r.budgetId);
    const u = me();
    const step = currentStep(r);
    const isCapex = true; // ชื่อเดิม: OPEX ใช้ขั้นตอนเดียวกับ CAPEX จึงเป็น true เสมอ
    const isOwner = r.requesterId === u.id;

    // ---- ปุ่มคำสั่งของหน้า (อยู่บนหัวหน้า เห็นได้ทันที)
    const actions = [];
    if (r.docNo && (r.status === 'approved' || r.status === 'closed')) actions.push('<a class="btn primary" href="#/doc/' + r.id + '">เปิดเอกสาร ' + esc(r.docNo) + '</a>');
    if (r.status === 'rejected' && isOwner) actions.push('<a class="btn primary" href="#/request/' + r.id + '/edit">แก้ไขและส่งใหม่</a>');
    if (r.status === 'memo' && isOwner) actions.push('<a class="btn" href="#/request/' + r.id + '/edit">แก้ไขคำขอ</a>');
    if (r.memo && r.memo.no) actions.push('<a class="btn' + (r.status === 'memo' ? ' primary' : '') + '" href="#/request/' + r.id + '/memo">พิมพ์ Memo ' + esc(r.memo.no) + '</a>');
    if ((r.status === 'pending' || r.status === 'rejected' || r.status === 'memo') && isOwner) {
      actions.push('<button class="btn bad" id="cancelRequest" data-id="' + r.id + '">ยกเลิกคำขอ</button>');
    }

    let html = '<div class="page-head detail-head"><div>' +
      '<div class="eyebrow">ดำเนินการใช้งบ · ' + esc(USE_TYPES[r.useType || 'direct'].label) + ' · ' + badge(b.type, TYPE_SHORT[b.type]) +
      ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a> ' + esc(b.name) + '</div>' +
      '<h1>' + esc(r.no) + ' ' + badge(r.status, statusText(r)) + '</h1></div>' +
      (actions.length ? '<div class="head-actions">' + actions.join('') + '</div>' : '') + '</div>' + takeFlash();

    if (r.status === 'cancelled') {
      html += '<div class="alert error">ยกเลิกโดย ' + esc(userName(r.cancelledBy || r.requesterId)) + ' เมื่อ ' + fmtDate(r.cancelledAt) +
        (r.docNo ? ' · เอกสารเลขที่ ' + esc(r.docNo) + ' ใช้ไม่ได้แล้ว และคืนยอดเข้างบเรียบร้อย' : '') +
        (r.cancelReason ? '<br>เหตุผล: ' + esc(r.cancelReason) : '') + '</div>';
    }
    if (r.overBudget) html += '<div class="alert warn">ใช้เกินงบของรายการต้นทุน · เหตุผล: ' + esc(r.overBudgetReason) + '</div>';
    if (r.status === 'pending') {
      const ov = capexOver(r);
      if (ov.project > 0) html += '<div class="alert error">เกินงบคงเหลือของโครงการ ' + money(ov.project) + ' บาท (คงเหลือ ' + money(ov.projRem) + ') — ผู้คุมงบต้องโยกงบเข้าก่อนจึงอนุมัติได้ หรือส่งกลับให้ขอเพิ่มงบ</div>';
      else if (ov.item > 0) html += '<div class="alert warn">ขอเกินงบ' + (ov.items.length === 1 && b.type === 'CAPEX' ? 'รายการย่อย' : 'รายการ ') + ov.items.map((x) => (x.item ? esc(x.item.code) + ' ' : '') + 'อยู่ ' + money(x.over) + ' บาท (คงเหลือ ' + money(x.remaining) + ')').join(' · ') + ' แต่ยังไม่เกินงบรวมของโครงการ — ผู้คุมงบต้องใส่ Note เมื่ออนุมัติ</div>';
    }
    if (isCapex && r.approverNote) html += '<div class="alert info">Note ผู้คุมงบ' + (r.overItem ? ' (อนุมัติเกินงบรายการ ' + money(r.overItem) + ' บาท)' : '') + ': ' + esc(r.approverNote) + '</div>';

    // ---- ข้อมูลหลักแบบตาราง (ประหยัดพื้นที่)
    const fact = (label, value, wide) => (value || value === 0
      ? '<div class="fact' + (wide ? ' wide' : '') + '"><span>' + label + '</span><strong>' + value + '</strong></div>' : '');
    const facts = '<section class="card"><div class="facts">' +
      (isCapex ? fact('ประเภท', esc(USE_TYPES[r.useType || 'direct'].label) + '<small>' + esc(USE_TYPES[r.useType || 'direct'].cut) + '</small>') : '') +
      fact(b.structure === 'project' ? 'งบที่ใช้' : b.type === 'CBS' ? 'รายการต้นทุน' : 'รายการย่อย', b.structure === 'project' ? 'งบรวมทั้งโครงการ'
        : itemCodesCell(b, r)) +
      fact('ผู้ขอ', esc(userName(r.requesterId)) + '<small>' + esc(b.department) + '</small>') +
      fact(isCapex ? 'วันที่ขอ' : 'วันที่เบิก', isCapex ? fmtDate(r.createdAt) : fmtDay(r.expenseDate)) +
      fact(isCapex ? (r.useType === 'advance' || r.useType === 'reimburse' ? 'ผู้รับเงิน (พนักงาน)' : 'Supplier (ผู้รับเงิน)') : 'ผู้รับเงิน', esc(r.payee)) +
      fact('PO No.', isCapex && r.useType === 'prpo' ? (hasPO(r) ? esc(r.poNo) : '<span class="muted">' + (r.status === 'approved' ? 'รอจัดซื้อออก PO' : 'ออกหลังผู้คุมงบอนุมัติ') + '</span>')
        : isCapex ? '<span class="muted">ไม่ต้องออก PO</span>' : esc(r.poNo)) +
      (isCapex && (r.useType === 'prpo' || r.useType === 'direct') ? fact('เงื่อนไขการจ่าย', esc(planText(r))) : '') +
      (isCapex ? fact('วัตถุประสงค์', esc(r.purpose), true) : '') +
      (r.memoBackground ? fact('เรื่องสืบเนื่อง / ความเป็นมา (Memo)', esc(r.memoBackground).replace(/\n/g, '<br>'), true) : '') +
      (r.memo ? fact('Memo', esc(r.memo.no) + '<small><a href="#/request/' + r.id + '/memo' + (canEditMemo(r) ? '' : '?view=1') + '">' + (canEditMemo(r) ? 'กรอก / แก้ไข Memo' : 'เปิด Memo') + '</a></small>') : '') +
      (isCapex && r.requesterReason ? fact('เหตุผลที่ขอเกินงบ (ผู้ขอ)', esc(r.requesterReason), true) : '') +
      '</div></section>';

    // ---- คอลัมน์ขวา: ยอดเงิน + สถานะ + ฟอร์มตัดสินใจ
    let side = '<div class="card total-card"><span class="muted">รวมจำนวนเงิน</span>' +
      '<div class="total-amount">' + money(r.amount) + ' <small>บาท</small></div>' +
      '<div class="total-split"><span>ก่อน VAT ' + money(r.amountBeforeVat) + '</span><span>VAT ' + money(r.vat) + '</span><span>' + r.lines.length + ' บรรทัด</span></div>';
    if (isCapex && (r.status === 'approved' || r.status === 'closed')) {
      const cut = cutTotal(r);
      const pct = r.amount > 0 ? Math.min(100, (cut / r.amount) * 100) : 0;
      side += '<div class="paid-bar"><div class="bar"><div class="used" style="width:' + pct + '%"></div></div>' +
        '<div class="muted small-note" style="margin:.4rem 0 0">ตัดงบแล้ว ' + money(cut) + (r.status === 'closed' ? ' · ปิดยอดแล้ว' : ' · ยังจองไว้ ' + money(Math.max(0, round2(r.amount - cut)))) + '</div></div>';
    }
    side += '</div>';

    const tl = (cls, title, sub, note) => '<li class="' + cls + '"><span class="tl-dot"></span><div><strong>' + title + '</strong>' +
      (sub ? '<div class="muted">' + sub + '</div>' : '') + (note ? '<div class="tl-note">“' + esc(note) + '”</div>' : '') + '</div></li>';
    const stepLi = (s) => tl(s.status === 'waiting' ? (s === step ? 'current' : '') : s.status,
      esc(s.label) + (s.status === 'rejected' ? ' — ไม่อนุมัติ' : ''),
      s.by ? esc(userName(s.by)) + ' · ' + fmtDate(s.at) : s === step ? 'กำลังรอ ' + esc(stepAssigneeText(s)) : esc(stepAssigneeText(s)),
      s.comment);
    let timeline = tl('done', r.memo && r.memo.no ? 'บันทึกคำขอ / ออก Memo ' + esc(r.memo.no) : 'ส่งคำขอ', esc(userName(r.requesterId)) + ' · ' + fmtDate(r.createdAt));
    if (r.memo && r.memo.no) {
      timeline += r.status === 'memo'
        ? tl('current', 'รอผู้บริหารเซ็น Memo', 'ผู้ขอพิมพ์ Memo ไปให้ผู้บริหารเซ็น แล้วแนบกลับเข้าระบบ')
        : tl('done', 'แนบ Memo ที่เซ็นแล้ว', (r.memo.by ? 'เซ็นโดย ' + esc(r.memo.by) : '') + (r.memo.at ? ' · ' + fmtDate(r.memo.at) : ''));
    }
    if (r.history && r.history.length) {
      timeline += r.history.map(stepLi).join('') + tl('done', 'แก้ไขและส่งใหม่', fmtDate(r.resubmittedAt));
    }
    timeline += r.steps.map(stepLi).join('');
    if (r.status === 'approved' || r.status === 'closed') timeline += tl('approved', 'ออก' + docTitle(r) + ' ' + esc(r.docNo), fmtDate(r.approvedAt));
    if (r.status === 'closed') timeline += tl('approved', 'ปิดยอดแล้ว', esc(userName(r.closed.by)) + ' · ' + fmtDate(r.closed.at));
    if (r.status === 'cancelled') timeline += tl('rejected', 'ยกเลิก', esc(userName(r.cancelledBy || r.requesterId)) + ' · ' + fmtDate(r.cancelledAt));

    side += '<div class="card"><h3 class="side-title">สถานะ</h3><ol class="timeline">' + timeline + '</ol>';
    if (canAct(u, step)) {
      const ov = isCapex ? capexOver(r) : { item: 0, project: 0 };
      side += '<form id="decisionForm" class="decision" data-id="' + r.id + '">' +
        (ov.project > 0
          ? '<div class="alert error small">เกินงบโครงการ ' + money(ov.project) + ' บาท — โยกงบเข้าก่อน หรือส่งกลับให้ขอเพิ่มงบ</div>' +
            '<a class="btn" style="width:100%;margin-bottom:var(--s-3)" href="#/adjust?to=' + b.id + '&item=' + r.itemId + '&amount=' + ov.project + '">โยกงบเข้าโครงการนี้</a>'
          : '') +
        '<label class="field"><span>' + (ov.item > 0 && ov.project <= 0 ? 'Note เหตุผลที่ให้ผ่าน (จำเป็น — ขอเกินงบรายการ ' + money(ov.item) + ' บาท)' : 'Note / เหตุผล (จำเป็นเมื่อส่งกลับ)') + '</span>' +
        '<textarea name="comment" rows="2" placeholder="เช่น ควรใช้งบตัวไหนแทน"></textarea></label>' +
        '<div class="decision-actions"><button class="btn ok" type="submit" data-decision="approved"' + (ov.project > 0 ? ' disabled title="เกินงบโครงการ"' : '') + '>' +
        (isCapex ? 'อนุมัติ ออกใบดำเนินการใช้งบ' : 'อนุมัติเอกสาร') + '</button>' +
        '<button class="btn bad" type="submit" data-decision="rejected">ส่งกลับให้แก้ไข</button></div></form>';
    }
    side += '</div>';
    if (isCapex) side += historyCard(r.events, 'บันทึกการดำเนินการ');

    let main = facts + '<h2>' + (isCapex ? 'รายการที่ขอใช้' : 'รายการที่ขอเบิก') + '</h2>' + linesTable(b, r, r.type === 'CBS');
    if (r.status === 'memo') {
      main = (isOwner
        ? '<section class="card memo-card"><h2 class="section-title">ขั้นถัดไป: ให้ผู้บริหารเซ็น Memo แล้วแนบกลับเข้าระบบ</h2>' +
          '<ol class="memo-steps"><li class="done">บันทึกคำขอและออก Memo เลขที่ <strong>' + esc(r.memo.no) + '</strong> แล้ว (จองงบไว้ ' + money(r.amount) + ' บาท)</li>' +
          '<li class="current"><a href="#/request/' + r.id + '/memo">กรอก / พิมพ์ Memo</a>' + (r.memoDoc ? ' (กรอกแล้ว)' : '') + ' แล้วนำไปให้ผู้บริหารเซ็น</li>' +
          '<li>แนบไฟล์ Memo ที่เซ็นแล้วด้านล่าง แล้วส่งให้ผู้คุมงบตรวจสอบ</li></ol>' +
          '<form id="memoSubmit" data-id="' + r.id + '"><div class="form-grid">' +
          '<div class="field full"><span>ไฟล์ Memo ที่เซ็นแล้ว (PDF หรือรูปภาพ)</span>' + attachList(r.memo.files, { del: true, empty: 'ยังไม่ได้แนบ Memo' }) +
          '<label class="btn small file-btn">+ แนบไฟล์ Memo<input type="file" id="memoFileInput" accept="application/pdf,image/png,image/jpeg" multiple hidden></label></div></div>' +
          '<div class="actions"><button class="btn primary" type="submit">ส่งให้ผู้คุมงบตรวจสอบ</button></div></form></section>'
        : '<div class="alert info">รอผู้ขอนำ Memo เลขที่ ' + esc(r.memo.no) + ' ไปให้ผู้บริหารเซ็นและแนบกลับเข้าระบบ — ผู้คุมงบจะตรวจสอบได้เมื่อแนบแล้ว</div>') + main;
    } else if (r.memo && (r.memo.files || []).length) {
      main += '<h2>Memo ผู้บริหารเซ็น</h2><section class="card"><p class="memo-meta">เลขที่ <strong>' + esc(r.memo.no) + '</strong>' + (r.memo.by ? ' · เซ็นโดย <strong>' + esc(r.memo.by) + '</strong>' : '') + '</p>' +
        attachList(r.memo.files, { empty: 'ยังไม่ได้แนบ Memo' }) + '</section>';
    } else if (memoRequired(b, r.lines) && (r.status === 'pending' || r.status === 'rejected')) {
      main += '<div class="alert warn">' + esc(memoReason(b, r.lines)) + ' — คำขอนี้ยังไม่มี Memo (ส่งก่อนเปิดใช้เงื่อนไขนี้)</div>';
    }
    if ((r.attachments || []).length) main += '<h2>เอกสารประกอบ</h2><section class="card">' + attachList(r.attachments) + '</section>';
    if (r.status === 'approved' || r.status === 'closed') main += cutPanel(r);

    return html + '<div class="detail-layout"><div class="detail-main">' + main + '</div><aside class="detail-side">' + side + '</aside></div>';
  }

  function bindRequestDetail() {
    const ms = document.getElementById('memoSubmit');
    if (ms) {
      const r = requestById(ms.dataset.id);
      // ผู้บริหารที่เซ็น = ผู้พิจารณาอนุมัติที่กรอกไว้ใน Memo (ไม่ต้องพิมพ์ซ้ำ)
      const keepBy = () => { r.memo.by = memoSigners(r); };
      document.getElementById('memoFileInput').addEventListener('change', async (e) => {
        const files = await readFiles(e.target, 'memo');
        if (!files.length) return;
        keepBy();
        r.memo.files = (r.memo.files || []).concat(files);
        addEvent(r, 'แนบไฟล์ Memo ที่เซ็นแล้ว', files.map((x) => x.name).join(', '));
        if (save()) go('#/request/' + r.id);
      });
      ms.addEventListener('click', (e) => {
        const del = e.target.closest('[data-att-del]');
        if (!del) return;
        keepBy();
        r.memo.files = r.memo.files.filter((x) => x.id !== del.dataset.attDel);
        save();
        go('#/request/' + r.id);
      });
      ms.addEventListener('submit', (e) => {
        e.preventDefault();
        keepBy();
        const errors = [];
        if (!(r.memo.files || []).length) errors.push('กรุณาแนบไฟล์ Memo ที่ผู้บริหารเซ็นแล้ว');
        if (errors.length) { alert(errors.join('\n')); return; }
        r.memo.at = new Date().toISOString();
        r.status = 'pending';
        addEvent(r, 'แนบ Memo ที่เซ็นแล้วและส่งให้ผู้คุมงบตรวจสอบ', r.memo.no + (r.memo.by ? ' · ' + r.memo.by : ''));
        save();
        setFlash('success', 'ส่งคำขอ ' + r.no + ' พร้อม Memo ที่เซ็นแล้วให้ผู้คุมงบตรวจสอบแล้ว');
        go('#/request/' + r.id);
      });
    }
    const form = document.getElementById('decisionForm');
    if (form) {
      let decision = 'approved';
      form.querySelectorAll('[data-decision]').forEach((btn) =>
        btn.addEventListener('click', () => { decision = btn.dataset.decision; }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let r = requestById(form.dataset.id);
        const b = budgetById(r.budgetId);
        const step = currentStep(r);
        const u = me();
        if (!canAct(u, step)) return;
        const comment = form.elements.comment.value.trim();
        if (decision === 'rejected' && !comment) {
          alert('กรุณาแจ้งเหตุผลที่ส่งกลับ');
          return;
        }
        let ov = { item: 0, project: 0 };
        if (decision === 'approved') {
          ov = capexOver(r);
          if (ov.project > 0) { alert('เกินงบคงเหลือของโครงการ ' + money(ov.project) + ' บาท — โยกงบเข้าก่อน หรือส่งกลับให้ขอเพิ่มงบ'); return; }
          if (ov.item > 0 && !comment) { alert('ขอเกินงบรายการ ' + money(ov.item) + ' บาท — กรุณาใส่ Note เหตุผลที่ให้ผ่าน'); return; }
        }
        if (REMOTE) {
          if (!(await runAndReload(() => window.RemoteApi.decide(r.id, decision, comment)))) return;
          r = requestById(r.id);
          setFlash(decision === 'rejected' ? 'info' : 'success', decision === 'rejected'
            ? 'ไม่อนุมัติคำขอ ' + r.no + ' แล้ว แจ้งเหตุผลให้ผู้ขอแก้ไขหรือยกเลิก งบที่จองไว้ถูกคืนเรียบร้อย'
            : 'อนุมัติเอกสารแล้ว ออกใบเบิกงบประมาณเลขที่ ' + r.docNo);
          go('#/request/' + r.id);
          return;
        }
        Object.assign(step, { status: decision, by: u.id, at: new Date().toISOString(), comment });
        if (decision === 'rejected') {
          r.status = 'rejected';
          addEvent(r, 'ส่งกลับให้แก้ไข', comment);
          setFlash('info', 'ส่งคำขอ ' + r.no + ' กลับให้ผู้ขอแก้ไขแล้ว งบที่จองไว้ถูกคืนเรียบร้อย');
        } else {
          Object.assign(r, { approverNote: comment, overItem: ov.item });
          issueDocument(r, b, step.at);
          addEvent(r, 'อนุมัติ ออก' + docTitle(r) + ' ' + r.docNo, comment);
          setFlash('success', 'อนุมัติแล้ว ออก' + docTitle(r) + 'เลขที่ ' + r.docNo + (r.useType === 'prpo' ? ' — รอจัดซื้อบันทึก PO' : ''));
        }
        save();
        go('#/request/' + r.id);
      });
    }

    const cancel = document.getElementById('cancelRequest');
    if (cancel) {
      cancel.addEventListener('click', async () => {
        let r = requestById(cancel.dataset.id);
        let reason = '';
        if (r.status === 'approved') {
          // เอกสารที่ออกไปแล้วต้องระบุเหตุผลการยกเลิกไว้ตรวจสอบย้อนหลัง
          reason = (prompt('ระบุเหตุผลที่ยกเลิกเอกสาร ' + r.docNo + ' (เช่น เลือกตัวงบผิด / ยอดผิด)') || '').trim();
          if (!reason) return;
        } else if (!confirm('ยืนยันการยกเลิกคำขอนี้?')) {
          return;
        }
        const wasIssued = r.status === 'approved';
        if (REMOTE) {
          if (!(await runAndReload(() => window.RemoteApi.cancel(r.id, reason)))) return;
          r = requestById(r.id);
        } else {
          r.status = 'cancelled';
          r.cancelledAt = new Date().toISOString();
          r.cancelledBy = me().id;
          r.cancelReason = reason;
          addEvent(r, 'ยกเลิกคำขอ', reason);
          save();
        }
        setFlash('info', wasIssued
          ? 'ยกเลิกเอกสาร ' + r.docNo + ' แล้ว คืนยอด ' + money(r.amount) + ' บาทเข้างบเรียบร้อย'
          : 'ยกเลิกคำขอ ' + r.no + ' แล้ว');
        go('#/request/' + r.id);
      });
    }
  }

  // ---------------------------------------------------------------- documents

  // ---- ยอดเงินเป็นตัวอักษรไทย เช่น 4,300,000 → สี่ล้านสามแสนบาทถ้วน
  const TH_DIGIT = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const TH_POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  function thaiGroup(str, prefixed) {
    const t = str.replace(/^0+/, '');
    let out = '';
    for (let i = 0; i < t.length; i += 1) {
      const d = Number(t[i]);
      const pos = t.length - 1 - i;
      if (!d) continue;
      if (pos === 0) out += d === 1 && (t.length > 1 || prefixed) ? 'เอ็ด' : TH_DIGIT[d];
      else if (pos === 1) out += (d === 1 ? '' : d === 2 ? 'ยี่' : TH_DIGIT[d]) + 'สิบ';
      else out += TH_DIGIT[d] + TH_POS[pos];
    }
    return out;
  }
  function thaiInt(str) {
    const t = String(str).replace(/^0+/, '');
    if (!t) return 'ศูนย์';
    if (t.length <= 6) return thaiGroup(t, false);
    return thaiInt(t.slice(0, -6)) + 'ล้าน' + thaiGroup(t.slice(-6), true);
  }
  function bahtText(n) {
    const v = Math.round(Math.abs(Number(n) || 0) * 100);
    const baht = Math.floor(v / 100);
    const sat = v % 100;
    if (!baht && sat) return thaiInt(String(sat)) + 'สตางค์';
    return thaiInt(String(baht)) + 'บาท' + (sat ? thaiInt(String(sat)) + 'สตางค์' : 'ถ้วน');
  }

  /** ข้อมูลที่ระบบคำนวณให้ใน Memo (ยอดเงิน ครั้งที่ ฯลฯ) และค่าเริ่มต้นของช่องที่ผู้ขอกรอกเองได้ */
  function memoModel(b, r) {
    const party = (c) => (db.master.memoParties || []).find((x) => x.code === c) || {};
    const cname = (c) => companyMap()[c] || c;
    const t = USE_TYPES[r.useType] || {};
    const perLine = b.structure !== 'project';
    // CAPEX: กรอบวงเงินใน Memo = Item ที่ขอใช้ (ใบเดียวมีได้หลาย Item) · OPEX / งบรวมโครงการ = ทั้งโครงการ
    const capexItems = b.type === 'CAPEX' && perLine ? reqItems(b, r) : [];
    const ids = capexItems.length ? uniq([].concat(...capexItems.map((x) => leafIdsUnder(b, x)))) : null;
    const scopeCodes = capexItems.map((x) => x.code).join(', ');
    const scopeNames = capexItems.map((x) => x.code + ' ' + x.name).join(', ');
    const doaItem = b.type === 'CAPEX' && perLine ? reqDoaItem(b, r) : null;

    // บริษัทที่ลงทุน (ถ้ามีหลายบริษัท ใช้บริษัทที่ลงทุนมากที่สุดเป็นผู้พิจารณา)
    const byInv = {};
    r.lines.forEach((l) => { const c = lineInvestor(b, l); byInv[c] = round2((byInv[c] || 0) + l.amount); });
    const invCodes = Object.keys(byInv).sort((x, y) => byInv[y] - byInv[x]);
    const investor = invCodes[0] || b.company;
    const approver = party(investor);
    const mp = r.memoParties || defaultMemoParties(b, investor);

    // ครั้งที่ และยอดที่เบิกไปแล้วก่อนหน้า
    const live = ['memo', 'pending', 'approved', 'closed'];
    const prior = db.requests.filter((x) => x.budgetId === b.id && x.id !== r.id && live.includes(x.status) && x.createdAt < r.createdAt)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const seq = prior.length + 1;
    const approved = ids ? round2(b.items.filter((x) => ids.includes(x.id)).reduce((s2, x) => s2 + itemTotal(x), 0)) : budgetTotal(b);
    const share = (x) => { const a = linesAmount(x, ids); return x.status === 'closed' && x.amount > 0 ? cutTotal(x) * a / x.amount : a; };
    const priorRows = prior.map((x, i) => ({ label: 'ครั้งที่ ' + (i + 1) + ' (' + (x.docNo || x.no) + ')' + (x.purpose ? ' — ' + x.purpose : ''), amount: round2(share(x)) })).filter((x) => x.amount > 0);
    const priorSum = round2(priorRows.reduce((s2, x) => s2 + x.amount, 0));
    const now = ids ? linesAmount(r, ids) : r.amount;
    const after = round2(approved - priorSum - now);

    // รายการที่ขอใช้ครั้งนี้ จัดกลุ่มตามหมวด / รายการ
    const groups = [];
    r.lines.forEach((l) => {
      const it = itemById(b, l.itemId) || {};
      const key = l.category || (perLine ? ((it.code || '') + ' ' + (it.name || '')).trim() : b.name);
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, amount: 0, descs: [] }; groups.push(g); }
      g.amount = round2(g.amount + l.amount);
      g.descs.push(l.description + (invCodes.length > 1 ? ' [ลงทุนโดย ' + lineInvestor(b, l) + ']' : ''));
    });

    // อ้างอิงหลักฐานการอนุมัติงบ (มติที่ประชุม / เอกสารอนุมัติผู้บริหาร)
    const m = b.meeting || {};
    const ap = apprOf(b.type);
    const refText = m.no
      ? (ap.exec ? 'เอกสารอนุมัติจากผู้บริหาร เลขที่ ' + m.no + (m.by ? ' (ผู้อนุมัติ: ' + m.by + ')' : '') : 'มติที่ประชุม ' + m.no) + (m.date ? ' วันที่ ' + fmtDay(m.date) : '')
      : 'งบ ' + b.code + ' ' + b.name;

    // อำนาจอนุมัติ: ของบริษัทที่ลงทุน (ข้อมูลหลัก) หรือคำนวณจากตาราง DOA (CAPEX แยกรายการ)
    let doaText = approver.doa || '';
    if (!doaText && doaItem && DOA[doaItem.doa]) {
      const tbl = DOA[doaItem.doa];
      const row = tbl.rows.find((x) => x.match(r.amount / 1e6));
      doaText = 'ตาม' + tbl.title + (row ? ' — ' + row.code + ' ' + row.label + ' · ผู้อนุมัติ: ' + row.approver : '');
    }

    const amt = (v) => money(v) + ' บาท (' + bahtText(v) + ')';
    const items = b.structure === 'project' ? [] : leaves(b);
    const background = 'สืบเนื่องจาก' + refText + ' ได้อนุมัติงบ ' + b.code + ' ' + b.name + ' กรอบวงเงิน' +
      (capexItems.length ? 'ของรายการ ' + scopeNames + ' ' : 'รวมทั้งสิ้น ') + amt(approved) +
      (r.memoBackground ? '\n\n' + r.memoBackground : '') +
      (items.length ? '\n\nโดยมีกรอบวงเงินแยกตามรายการ ดังนี้:\n' + items.map((it, i) => '1.' + (i + 1) + ' ' + it.code + ' ' + it.name + ' จำนวน ' +
        money(itemTotal(it)) + ' บาท' + (itemInvestor(b, it) !== b.company ? ' (ลงทุนโดย ' + itemInvestor(b, it) + ')' : '')).join('\n') : '');
    const consider = (r.purpose ? 'เพื่อ' + r.purpose + ' ' : '') + cname(b.company) + ' จึงมีความประสงค์ขอเบิกใช้งบ ครั้งที่ ' + seq + ' (' + (t.label || '') + ')' +
      (r.payee ? ' ผู้รับเงิน / Supplier: ' + r.payee : '') + ' ในหมวด';
    const defaults = {
      to: (mp.to.length ? mp.to : ['ผู้บริหาร']).concat([cname(investor)]).join('\n'),
      date: fmtDay(r.createdAt),
      cc: mp.cc.join(' , '),
      subject: 'ขอเบิกใช้งบ ' + b.name + ' ครั้งที่ ' + seq,
      ref: refText,
      background,
      consider,
      doaRef: doaText,
      signerName: userName(r.requesterId),
      signerTitle: mp.proposer || '',
      reviewers: mp.reviewers.slice(),
      approvers: mp.approvers.slice()
    };
    return { b, r, cname, seq, approved, priorRows, after, groups, invCodes, byInv, scopeCodes, capexItems, amt, defaults };
  }
  const MEMO_DOC_KEYS = ['to', 'date', 'cc', 'subject', 'ref', 'background', 'consider', 'doaRef', 'signerName', 'signerTitle', 'reviewers', 'approvers'];
  /** ค่าที่ใช้ใน Memo: ค่าที่ผู้ขอกรอกไว้ (r.memoDoc) ทับค่าเริ่มต้นจากระบบ */
  function memoDocOf(model) {
    const saved = model.r.memoDoc || {};
    const out = {};
    MEMO_DOC_KEYS.forEach((k) => { out[k] = saved[k] !== undefined ? saved[k] : model.defaults[k]; });
    return out;
  }

  /**
   * Memo ตามโครงแบบฟอร์มจริงของบริษัท — edit = แสดงเป็นช่องกรอกในตำแหน่งเดียวกับเอกสาร
   * ช่องที่กรอกได้: เรียน · วันที่ · สำเนาถึง · เรื่อง · อ้างอิง · 1. เรื่องสืบเนื่อง · 2. เรื่องเพื่อพิจารณาลงนาม · อ้างอิงอำนาจอนุมัติ ·
   * ผู้ลงนามเสนอ · ผู้ทบทวน · ผู้พิจารณาอนุมัติ — ส่วนยอดเงินและตารางสรุประบบคำนวณจากคำขอ (แก้ที่คำขอ)
   */
  function memoHtml(b, r, edit) {
    const M = memoModel(b, r);
    const d = memoDocOf(M);
    const text = (v) => esc(v || '').replace(/\n/g, '<br>');
    const paras = (v) => String(v || '').split(/\n\s*\n/).map((p) => '<p>' + text(p.trim()) + '</p>').join('');
    const inp = (k, ph, cls) => (edit ? '<input class="mf' + (cls ? ' ' + cls : '') + '" name="md_' + k + '" value="' + esc(d[k]) + '" placeholder="' + esc(ph || '') + '" aria-label="' + esc(ph || k) + '">' : text(d[k]));
    const area = (k, rows, ph) => (edit ? '<textarea class="mf" name="md_' + k + '" rows="' + rows + '" placeholder="' + esc(ph || '') + '" aria-label="' + esc(ph || k) + '">' + esc(d[k]) + '</textarea>' : null);
    const cell = (v) => '<td class="num">' + v + '</td>';
    const paren = (v) => '(' + money(v) + ')';
    const signRows = (k) => {
      const list = d[k].length ? d[k] : [''];
      return list.map((x) => '<tr>' + (edit
        ? '<td><div class="mf-row"><input class="mf" name="md_' + k + '" value="' + esc(x) + '" placeholder="ชื่อ / ตำแหน่ง" aria-label="ชื่อ / ตำแหน่ง">' +
          '<button type="button" class="btn small bad no-print" data-mf-del title="ลบแถว">×</button></div></td>'
        : '<td>' + esc(x) + '</td>') + '<td>☐ อนุมัติ &nbsp; ☐ ไม่อนุมัติ</td><td></td><td></td></tr>').join('');
    };
    const signTable = (k, title) => '<h2 class="memo-h">' + title + '</h2>' +
      '<table class="memo-sign"><thead><tr><th>ชื่อ / ตำแหน่ง</th><th style="width:9rem">ผลการพิจารณา</th><th style="width:11rem">ลงนามอนุมัติ</th><th style="width:6rem">วันที่</th></tr></thead>' +
      '<tbody data-mf-list="' + k + '">' + signRows(k) + '</tbody></table>' +
      (edit ? '<button type="button" class="btn small no-print mf-add" data-mf-add="' + k + '">+ เพิ่มผู้ลงนาม</button>' : '');
    const toLines = String(d.to || '').split('\n');
    const g = M.groups;

    return '<article class="doc memo-doc' + (edit ? ' memo-edit' : '') + '">' +
      memoLetterhead(b.company) +
      '<table class="memo-head"><tbody>' +
      '<tr><td><div class="mh-row"><span class="lbl">เรียน</span><div class="mh-val">' +
        (edit ? area('to', 2, 'ชื่อ (ตำแหน่ง) และบริษัท — บรรทัดละรายการ') : toLines.map(esc).join('<br>')) + '</div></div></td>' +
      '<td class="memo-date"><div class="mh-row"><span class="lbl lbl-s">วันที่</span><div class="mh-val">' + inp('date', 'วันที่', 'mf-date') + '</div></div>' +
        '<div class="mh-row"><span class="lbl lbl-s">เลขที่</span><div class="mh-val">' + esc((r.memo || {}).no || '........') + '</div></div>' +
        '<div class="mh-row mh-sub"><span class="lbl lbl-s">คำขอ</span><div class="mh-val">' + esc(r.no) + '</div></div></td></tr>' +
      '<tr><td colspan="2"><div class="mh-row"><span class="lbl">เรื่อง</span><div class="mh-val">' + inp('subject', 'เรื่อง') + '</div></div></td></tr>' +
      '<tr><td colspan="2"><div class="mh-row"><span class="lbl">สำเนาถึง</span><div class="mh-val">' + inp('cc', 'ผู้รับสำเนา (คั่นด้วย ,)') + '</div></div></td></tr>' +
      '<tr><td colspan="2"><div class="mh-row"><span class="lbl">อ้างอิง</span><div class="mh-val">' + (edit ? area('ref', 1, 'มติ / เอกสารอนุมัติที่อ้างอิง') : text(d.ref)) + '</div></div></td></tr>' +
      '</tbody></table>' +

      '<h2 class="memo-h">1. เรื่องสืบเนื่อง</h2>' +
      (edit ? area('background', 9, 'ที่มา เหตุผลความจำเป็น และกรอบวงเงินที่ได้รับอนุมัติ') : '<div class="memo-text">' + paras(d.background) + '</div>') +

      '<h2 class="memo-h">2. เรื่องเพื่อพิจารณาลงนาม</h2>' +
      (edit ? area('consider', 3, 'วัตถุประสงค์และความประสงค์ในการขอเบิกใช้งบครั้งนี้') : '<div class="memo-text">' + paras(d.consider) + '</div>') +
      '<ol class="memo-list">' + g.map((x, i) => '<li>' + (i + 1) + '. ' + esc(x.key) + ' เป็นจำนวนเงิน ' + esc(M.amt(x.amount)) +
        '<br><small>' + x.descs.map(esc).join(' · ') + '</small></li>').join('') +
      '<li class="memo-total">รวมเป็นจำนวนเงินทั้งสิ้น ' + esc(M.amt(r.amount)) + '</li></ol>' +
      (M.invCodes.length > 1 ? '<p class="memo-inv">บริษัทที่ลงทุน: ' + M.invCodes.map((c) => esc(c) + ' ' + money(M.byInv[c]) + ' บาท').join(' · ') + '</p>' : '') +
      (edit ? '<p class="mf-note no-print">ยอดเงินในรายการด้านบนและตารางด้านล่างระบบคำนวณจากคำขอ — ถ้าต้องการเปลี่ยนยอด ให้แก้ที่คำขอ</p>' : '') +

      '<table class="memo-sum"><thead><tr><th style="width:3rem">ลำดับ</th><th>รายการงบประมาณ</th><th class="num" style="width:9rem">จำนวนเงิน (บาท)</th></tr></thead><tbody>' +
      '<tr><td class="center">1</td><td>กรอบวงเงินงบที่ได้รับอนุมัติ' + (M.capexItems.length ? ' (' + esc(M.scopeCodes) + ')' : ' (' + esc(b.code) + ')') + '</td>' + cell(money(M.approved)) + '</tr>' +
      '<tr><td class="center">2</td><td>หัก : เบิกใช้งบไปแล้ว' + (M.priorRows.length ? M.priorRows.map((x) => '<br><small>- ' + esc(x.label) + '</small>').join('') : '<br><small>- ยังไม่มี</small>') + '</td>' +
      cell(M.priorRows.length ? M.priorRows.map((x) => paren(x.amount)).join('<br><br>') : '-') + '</tr>' +
      '<tr><td class="center">3</td><td>ขอเบิกใช้ ครั้งที่ ' + M.seq + ' :' + g.map((x) => '<br><small>- ' + esc(x.key) + '</small>').join('') + '</td>' +
      cell(g.map((x) => money(x.amount)).join('<br>')) + '</tr>' +
      '<tr><td></td><td><strong>งบประมาณคงเหลือหลังการเบิกใช้ ครั้งที่ ' + M.seq + '</strong></td>' + cell('<strong>' + moneyCell(M.after) + '</strong>') + '</tr></tbody></table>' +
      '<p>จึงขอเบิกใช้งบ ครั้งที่ ' + M.seq + ' รวมเป็นเงินทั้งสิ้น ' + esc(M.amt(r.amount)) + '</p>' +
      (edit ? '<div class="memo-doa"><strong><u>อ้างอิงอำนาจอนุมัติ</u></strong>' + area('doaRef', 3, 'อ้างอิง DOA (ฉบับ / ข้อ / ผู้เห็นชอบ / ผู้อนุมัติ)') + '</div>'
        : d.doaRef ? '<p class="memo-doa"><strong><u>อ้างอิงอำนาจอนุมัติ</u></strong> ' + text(d.doaRef) + '</p>' : '') +

      '<p class="memo-close">จึงเรียนมาเพื่อโปรดพิจารณาลงนาม</p>' +
      '<div class="memo-signoff"><div>ขอแสดงความนับถือ</div><div class="memo-sig-line"></div>' +
      '<div>(' + inp('signerName', 'ชื่อผู้ลงนามเสนอ', 'mf-center') + ')</div><div>' + inp('signerTitle', 'ตำแหน่ง', 'mf-center') + '</div></div>' +

      signTable('reviewers', 'ทบทวน และให้ความเห็นชอบ') +
      signTable('approvers', 'ผู้พิจารณาอนุมัติ') +
      (edit ? '' : '<p class="note no-print">เมื่อผู้บริหารลงนามแล้ว ให้สแกน / ถ่ายรูป แนบในคำขอดำเนินการใช้งบ พร้อมชื่อผู้บริหารที่ลงนาม ก่อนส่งให้ผู้คุมงบตรวจสอบ</p>') +
      '</article>';
  }

  const MEMO_LOGO = 'img/logo-precise.png?v=1';
  /** หัวกระดาษ Memo: โลโก้ของบริษัท (ตั้งที่ ข้อมูลหลัก > บริษัท) หรือโลโก้กลุ่มบริษัท และคำว่า Memo ชิดขวา */
  function memoLetterhead(code) {
    const c = db.master.companies.find((x) => x.code === code) || { code };
    // โลโก้ตั้งต้น = โลโก้กลุ่มบริษัท (img/logo-precise.png) · อัปโหลดโลโก้เฉพาะบริษัทได้ที่ข้อมูลหลัก
    const src = c.logo && /^data:image\//.test(c.logo) ? c.logo : MEMO_LOGO;
    const logo = '<img class="lh-img" src="' + esc(src) + '" alt="' + esc(c.name || c.code || 'โลโก้บริษัท') + '">';
    return '<div class="memo-letterhead"><div class="lh-logo">' + logo + '</div><div class="lh-title">Memo</div></div>';
  }
  /** ผู้บริหารที่ลงนามอนุมัติ Memo = รายชื่อผู้พิจารณาอนุมัติใน Memo */
  const memoSigners = (r) => memoDocOf(memoModel(budgetById(r.budgetId), r)).approvers.join(' / ');
  /** ผู้ขอแก้ไข Memo ได้ระหว่างรอแนบ Memo ที่เซ็นแล้ว */
  const canEditMemo = (r) => r.status === 'memo' && r.requesterId === me().id && can('request.create');

  /** หน้า Memo ของคำขอ (#/request/:id/memo) — กรอกตามโครงเอกสาร · ?view=1 = ฉบับพิมพ์ */
  function viewRequestMemo(id, params) {
    const r = requestById(id);
    if (!r) return notFound();
    const b = budgetById(r.budgetId);
    const editable = canEditMemo(r);
    if (editable && !(params && params.get('view'))) {
      return '<div class="page-head no-print"><div><h1>กรอก Memo · ' + esc((r.memo || {}).no || r.no) + '</h1>' +
        '<div class="page-sub">กรอกข้อมูลในช่องตามโครงแบบฟอร์ม Memo ของบริษัท (ค่าเริ่มต้นดึงจากคำขอและข้อมูลหลัก) แล้วกด "บันทึกและดูฉบับพิมพ์"</div></div></div>' +
        takeFlash() +
        '<form id="memoDocForm" data-id="' + r.id + '">' +
        '<div class="actions no-print memo-toolbar"><button class="btn primary" type="submit" data-mf-go="view">บันทึกและดูฉบับพิมพ์</button>' +
        '<button class="btn" type="submit" data-mf-go="stay">บันทึก</button>' +
        (r.memoDoc ? '<button class="btn" type="button" id="memoDocReset">ใช้ค่าเริ่มต้นจากระบบ</button>' : '') +
        '<a class="btn" href="#/request/' + r.id + '">กลับไปที่คำขอ</a></div>' +
        memoHtml(b, r, true) + '</form>';
    }
    return '<div class="actions no-print" style="margin:0 0 1rem"><button class="btn primary" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button>' +
      (editable ? '<a class="btn" href="#/request/' + r.id + '/memo">แก้ไข Memo</a>' : '') +
      '<a class="btn" href="#/request/' + r.id + '">กลับไปที่คำขอ</a></div>' + takeFlash() + memoHtml(b, r, false);
  }

  function bindMemoDoc() {
    const form = document.getElementById('memoDocForm');
    if (!form) return;
    const r = requestById(form.dataset.id);
    let goView = true;
    form.querySelectorAll('[data-mf-go]').forEach((btn) => btn.addEventListener('click', () => { goView = btn.dataset.mfGo === 'view'; }));
    // ช่องข้อความยืดตามเนื้อหา
    const grow = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; };
    form.querySelectorAll('textarea.mf').forEach(grow);
    form.addEventListener('input', (e) => { if (e.target.matches('textarea.mf')) grow(e.target); });
    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-mf-add]');
      if (add) {
        const k = add.dataset.mfAdd;
        const tb = form.querySelector('[data-mf-list="' + k + '"]');
        tb.insertAdjacentHTML('beforeend', '<tr><td><div class="mf-row"><input class="mf" name="md_' + k + '" placeholder="ชื่อ / ตำแหน่ง" aria-label="ชื่อ / ตำแหน่ง">' +
          '<button type="button" class="btn small bad no-print" data-mf-del title="ลบแถว">×</button></div></td><td>☐ อนุมัติ &nbsp; ☐ ไม่อนุมัติ</td><td></td><td></td></tr>');
        tb.lastElementChild.querySelector('input').focus();
      }
      if (e.target.matches('[data-mf-del]')) e.target.closest('tr').remove();
    });
    const reset = document.getElementById('memoDocReset');
    if (reset) reset.addEventListener('click', () => {
      if (!confirm('ล้างข้อความที่กรอกไว้ แล้วใช้ค่าเริ่มต้นจากคำขอและข้อมูลหลัก?')) return;
      delete r.memoDoc;
      save();
      render();
    });
    guard(form, [{ btn: 'button[type="submit"]', missing: (f) => [
      !filled(f.elements.md_to) && 'เรียน',
      !filled(f.elements.md_subject) && 'เรื่อง',
      !filled(f.elements.md_background) && 'เรื่องสืบเนื่อง',
      !Array.from(form.querySelectorAll('[name="md_approvers"]')).some((x) => x.value.trim()) && 'ผู้พิจารณาอนุมัติอย่างน้อย 1 คน'
    ] }], '.memo-toolbar');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = (k) => (form.elements['md_' + k] ? form.elements['md_' + k].value.trim() : '');
      const list = (k) => Array.from(form.querySelectorAll('[name="md_' + k + '"]')).map((x) => x.value.trim()).filter(Boolean);
      r.memoDoc = {};
      MEMO_DOC_KEYS.forEach((k) => { r.memoDoc[k] = k === 'reviewers' || k === 'approvers' ? list(k) : val(k); });
      addEvent(r, 'กรอก / แก้ไข Memo ' + ((r.memo || {}).no || ''), '');
      save();
      setFlash('success', 'บันทึก Memo แล้ว' + (goView ? ' — พิมพ์ให้ผู้บริหารเซ็น แล้วแนบไฟล์ที่เซ็นแล้วในหน้าคำขอ' : ''));
      if (goView) go('#/request/' + r.id + '/memo?view=1'); else render();
    });
  }

  /** ยอด ณ วันที่ออกเอกสาร ของทั้งโครงการ (ids = null) หรือของรายการที่ระบุ: งบ / ใช้ก่อนหน้า / ครั้งนี้ / คงเหลือ */
  function balanceAt(r, b, ids, approvedOverride) {
    const approved = approvedOverride !== undefined ? approvedOverride : ids ? round2(b.items.filter((x) => ids.includes(x.id)).reduce((s, x) => s + itemTotal(x), 0)) : budgetTotal(b);
    const before = round2(db.requests
      .filter((x) => x.budgetId === b.id && x.id !== r.id && (x.status === 'approved' || x.status === 'closed') && x.approvedAt <= r.approvedAt)
      .reduce((s, x) => s + (x.status === 'closed' ? (linesAmount(x, ids) ? cutTotal(x) * linesAmount(x, ids) / x.amount : 0) : linesAmount(x, ids)), 0));
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
        : '<p class="note">ระบบเลือกระดับผู้อนุมัติตามจำนวนเงินที่ขอใช้ครั้งนี้ (' + money(amount) + ' บาท)</p>') + '</div>';
  }

  function viewDocument(id) {
    const r = requestById(id);
    if (!r) return notFound();
    if (r.status === 'cancelled' && r.docNo) return '<div class="alert error">เอกสารเลขที่ ' + esc(r.docNo) + ' ถูกยกเลิกแล้ว ใช้แนบขอซื้อไม่ได้</div>';
    if (r.status !== 'approved' && r.status !== 'closed') return '<div class="alert error">คำขอนี้ยังไม่ผ่านการตรวจสอบของผู้คุมงบ จึงยังไม่มีเอกสาร</div>';
    const b = budgetById(r.budgetId);
    const isCapex = r.type === 'CAPEX';
    const perItem = b.structure !== 'project';
    const doaItem = isCapex && perItem ? reqDoaItem(b, r) || {} : {};
    const proj = balanceAt(r, b, null);
    const tr = (k, v) => '<tr><th style="width:34%">' + k + '</th><td>' + v + '</td></tr>';
    const balanceTable = (title, bal) => '<table><thead><tr><th colspan="2">' + title + '</th></tr></thead><tbody>' +
      tr('จำนวนเงินงบประมาณ (รวม VAT)', '<span class="num-cell">' + money(bal.approved) + ' บาท</span>') +
      tr('ใช้/จองงบประมาณไปแล้วก่อนหน้า', '<span class="num-cell">' + money(bal.before) + ' บาท</span>') +
      tr('จำนวนงบประมาณที่ขอใช้ครั้งนี้ (รวม VAT)', '<span class="num-cell"><strong>' + money(bal.now) + ' บาท</strong></span>') +
      tr('งบประมาณคงเหลือ (หลังใช้ครั้งนี้)', '<span class="num-cell">' + moneyCell(bal.after) + ' บาท</span>') + '</tbody></table>';

    const head = '<header><div><h1>' + esc(companyMap()[b.company] || b.company) + '</h1><div class="doc-sub">' +
      'ใบดำเนินการใช้งบ (' + (isCapex ? 'งบลงทุน CAPEX' : 'งบดำเนินงาน OPEX') + ')</div></div>' +
      '<div class="docno">เลขที่ดำเนินการใช้งบ <strong>' + esc(r.docNo) + '</strong><br>วันที่ออกเอกสาร ' + fmtDay(r.approvedAt) +
      '<br><span class="stamp">ผู้คุมงบตรวจสอบแล้ว</span>' + (r.status === 'closed' ? '<br><span class="stamp">ปิดยอดแล้ว</span>' : '') + '</div></header>';
    const poCuts = (r.cuts || []).filter((c) => c.kind === 'po');
    const poText = r.useType !== 'prpo' ? '- (ไม่ต้องออก PO)' : poCuts.length
      ? poCuts.map((c) => esc((c.prNo ? 'PR ' + c.prNo + ' / ' : '') + 'PO ' + c.poNo) + ' · ' + money(c.amount) + ' บาท').join('<br>') : 'รอจัดซื้อออก PO';

    const info = '<div class="section"><table><tbody>' +
      tr('รหัสโครงการ (Project No.)', esc(b.code + ' ' + b.name)) +
      (isCapex && perItem ? tr('รหัสรายการย่อย (Item No.)', reqItems(b, r).map((x) => esc(x.code + ' ' + x.name)).join('<br>')) : '') +
      tr('ประเภทการใช้งบ', esc((USE_TYPES[r.useType] || {}).label || '-') + '<br><small>' + esc((USE_TYPES[r.useType] || {}).cut || '') + '</small>') +
      tr('วันที่ขอใช้งบ', fmtDay(r.createdAt)) +
      tr('ชื่อผู้ขอใช้งบประมาณ', esc(userName(r.requesterId) + ' · ' + b.department)) +
      tr('วัตถุประสงค์ในการใช้งบ', esc(r.purpose)) +
      tr(r.useType === 'advance' || r.useType === 'reimburse' ? 'ผู้รับเงิน (พนักงาน)' : 'Supplier (ผู้รับเงิน)', esc(r.payee || '-')) +
      tr('PR / PO No.', poText) +
      (r.overItem > 0 ? tr('หมายเหตุ: ใช้เกินงบรายการ', money(r.overItem) + ' บาท (อยู่ในงบรวมของโครงการ)' + (r.requesterReason ? '<br>เหตุผลผู้ขอ: ' + esc(r.requesterReason) : '')) : '') +
      (r.memo ? tr('Memo ผู้บริหาร', 'เลขที่ ' + esc(r.memo.no) + (r.memo.by ? ' · เซ็นโดย ' + esc(r.memo.by) : '')) : '') +
      (r.approverNote ? tr('Note ผู้คุมงบ', esc(r.approverNote)) : '') +
      (r.status === 'closed' && r.closed ? tr('ปิดยอด', 'ใช้จริง ' + money(r.closed.actual) + ' บาท' + (r.closed.returned > 0 ? ' · คืนเข้างบ ' + money(r.closed.returned) + ' บาท' : '') + (r.closed.over > 0 ? ' · เกินที่ขอ ' + money(r.closed.over) + ' บาท' : '')) : '') +
      (planText(r) ? tr('เงื่อนไขการจ่าย', planDetailHtml(r)) : '') +
      '</tbody></table></div>';

    let detail = '<div class="section"><h2>รายละเอียดการใช้งบประมาณ</h2>';
    if (!perItem) {
      detail += balanceTable('ระดับโครงการ: ' + esc(b.code), proj);
    } else {
      detail += balanceTable('ระดับโครงการ: ' + esc(b.code), proj) +
        '<table style="margin-top:.75rem"><thead><tr><th>' + (isCapex ? 'ระดับรายการย่อย (Item No.)' : 'รายการต้นทุน') + '</th><th class="num">งบ</th><th class="num">ใช้ก่อนหน้า</th><th class="num">ครั้งนี้</th><th class="num">คงเหลือ</th></tr></thead><tbody>' +
        uniq(reqItemIds(r).map((iid) => (budgetNodeOf(b, itemById(b, iid) || {}) || {}).id)).map((nid) => {
          const it = itemById(b, nid) || {};
          const bal = balanceAt(r, b, leafIdsUnder(b, it), itemTotal(it));
          return '<tr><td>' + esc(it.code + ' ' + it.name) + '</td><td class="num">' + money(bal.approved) + '</td><td class="num">' + money(bal.before) +
            '</td><td class="num">' + money(bal.now) + '</td><td class="num">' + moneyCell(bal.after) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    detail += '</div>';

    const withCat = isCapex && r.lines.some((l) => l.category);
    const lines = '<div class="section"><h2>รายการที่ขอใช้ครั้งนี้</h2><table><thead><tr><th style="width:2rem">#</th>' +
      (withCat ? '<th>หมวดค่าใช้จ่าย</th>' : isCapex ? (perItem ? '<th>รายการย่อย (Item No.)</th>' : '') : '<th>รายการต้นทุน / GL</th>') + '<th>บริษัทที่ลงทุน</th><th>' + (isCapex ? 'รายการที่ซื้อ / จ่าย' : 'รายละเอียด') + '</th>' +
      '<th class="num">ก่อน VAT</th><th class="num">VAT 7%</th><th class="num">รวม</th></tr></thead><tbody>' +
      r.lines.map((l, i) => {
        const it = itemById(b, l.itemId) || {};
        return '<tr><td>' + (i + 1) + '</td>' +
          (withCat ? '<td>' + esc(l.category || '-') + '</td>' : isCapex ? (perItem ? '<td>' + esc(it.code + ' ' + it.name) + '</td>' : '') : '<td>' + esc(it.code + ' ' + it.name) + (l.glCode ? '<br><small>GL ' + esc(l.glCode + ' ' + (l.glName || '')) + '</small>' : '') + '</td>') +
          '<td>' + esc(lineInvestor(b, l)) + '</td><td>' + esc(l.description) + '</td><td class="num">' + money(l.amountBeforeVat) + '</td><td class="num">' + money(l.vat) + '</td><td class="num">' + money(l.amount) + '</td></tr>';
      }).join('') +
      '<tr><th colspan="' + (isCapex && !withCat && !perItem ? 3 : 4) + '" class="right">รวมทั้งสิ้น</th><td class="num">' + money(r.amountBeforeVat) + '</td><td class="num">' + money(r.vat) +
      '</td><td class="num"><strong>' + money(r.amount) + '</strong></td></tr></tbody></table></div>';

    const signs = '<div class="signs"><div><div class="line"></div>ผู้ขอใช้งบประมาณ<br>' + esc(userName(r.requesterId)) + '</div>' +
      r.steps.map((s) => '<div><div class="line"></div>' + esc((user(s.by) || {}).title || '') + '<br>' + esc(userName(s.by)) + '<br><small>' + fmtDay(s.at) + '</small></div>').join('') +
      '</div>';

    return '<div class="actions no-print" style="margin:0 0 1rem">' +
      '<button class="btn primary" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>' +
      '<article class="doc">' + head + info + detail + lines +
      (isCapex ? doaTable(doaItem.doa, r.amount) : '') + signs +
      '<p class="note">' + (r.useType !== 'prpo'
        ? 'ใช้เลขที่ ' + esc(r.docNo) + ' อ้างอิงในเอกสารการจ่าย / เคลียร์เงิน · ' + esc((USE_TYPES[r.useType] || {}).cut || '')
        : 'โปรดแนบเอกสารฉบับนี้ และระบุเลขที่ ' + esc(r.docNo) + ' ในใบขอซื้อ (PR) ที่เกี่ยวข้อง · ยอดขอซื้อรวมต้องไม่เกิน ' + money(r.amount) + ' บาท') + '</p>' +
      '</article>';
  }


  // ---------------------------------------------------------------- dashboard

  const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const monthLabel = (key) => TH_MONTH[Number(key.slice(5, 7)) - 1] + ' ' + String((Number(key.slice(0, 4)) + 543) % 100);

  /** งบที่ผู้ใช้เห็นได้ (ผู้ขอเห็นเฉพาะงบของตนเอง) */
  const visibleBudgets = () => db.budgets.filter((b) => isActive(b) && (canViewAll() || b.ownerId === me().id));

  /** วันที่และยอดที่ฝ่ายบัญชีจ่ายแล้วของคำขอ — ใช้ทำกราฟรายเดือน */
  function paidEntries(r) {
    return (r.status === 'approved' || r.status === 'closed') ? (r.cuts || []).map((c) => ({ date: c.date, amount: Number(c.amount || 0) })) : [];
  }

  /**
   * สรุปตามบริษัทที่ลงทุน: งบที่ได้รับตาม Item (งบไม่มี Item = บริษัทเจ้าของงบ)
   * ยอดตัดงบ / จองไว้ตามบรรทัดของคำขอ (แบ่งยอดที่ตัดตามสัดส่วนของบรรทัด เหมือน usage())
   */
  function investorGroups(budgets) {
    const groups = {};
    const names = companyMap();
    const g = (code) => groups[code] || (groups[code] = { label: code + (names[code] ? ' — ' + names[code] : ''), ids: new Set(), n: 0, approved: 0, used: 0, reserved: 0, remaining: 0 });
    budgets.forEach((b) => {
      if (b.structure === 'project') {
        const x = g(b.company);
        x.approved = round2(x.approved + budgetTotal(b));
        x.ids.add(b.id);
      } else {
        ledgerItems(b).forEach((it) => {
          const x = g(itemInvestor(b, it));
          x.approved = round2(x.approved + itemTotal(it));
          x.ids.add(b.id);
        });
      }
      db.requests.forEach((r) => {
        if (r.budgetId !== b.id || !['memo', 'pending', 'approved', 'closed'].includes(r.status) || !(r.amount > 0)) return;
        const cut = cutTotal(r);
        r.lines.forEach((l) => {
          const x = g(lineInvestor(b, l));
          x.ids.add(b.id);
          const share = l.amount / r.amount;
          if (isReserving(r)) x.reserved = round2(x.reserved + l.amount);
          else {
            x.used = round2(x.used + cut * share);
            if (r.status === 'approved') x.reserved = round2(x.reserved + Math.max(l.amount - cut * share, 0));
          }
        });
      });
    });
    Object.values(groups).forEach((x) => { x.n = x.ids.size; x.remaining = round2(x.approved - x.used - x.reserved); });
    return groups;
  }

  function dashDimension(by, b) {
    if (by === 'group') {
      const g = db.master.groups.find((x) => x.code === b.group);
      return { key: 'G' + (b.group || '-'), label: 'กลุ่ม ' + (b.group || '-') + (g && g.name ? ' — ' + g.name : '') };
    }
    if (by === 'dept') return { key: b.department || '-', label: b.department || '-' };
    if (by === 'type') return { key: b.type, label: TYPE_LABEL[b.type] };
    return { key: b.company, label: b.company + (companyMap()[b.company] ? ' — ' + companyMap()[b.company] : '') };
  }

  function viewDashboard(params) {
    const u = me();
    const all = visibleBudgets();
    const years = uniq(all.map((b) => String(b.fiscalYear))).sort().reverse();
    const thisYear = String(new Date().getFullYear());
    const year = params.has('year') ? params.get('year') : (years.includes(thisYear) ? thisYear : 'all');
    const company = params.get('company') || 'all';
    const type = TYPE_LABEL[params.get('type')] ? params.get('type') : 'all';
    const by = ['company', 'investor', 'group', 'dept', 'type'].includes(params.get('by')) ? params.get('by') : 'company';
    const list = all.filter((b) => (year === 'all' || String(b.fiscalYear) === year) && (company === 'all' || b.company === company) && (type === 'all' || b.type === type));
    const q = (o) => '#/dashboard?' + Object.entries(Object.assign({ year, company, type, by }, o)).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

    // ---- รวมยอด
    const rows = list.map((b) => ({ b, u: usage(b) }));
    const sum = (k) => round2(rows.reduce((s2, x) => s2 + x.u[k], 0));
    const tot = { approved: sum('approved'), used: sum('used'), reserved: sum('reserved'), remaining: sum('remaining') };
    const pct = (v, of) => (of > 0 ? Math.max(0, Math.min(100, (v / of) * 100)) : 0);
    const pctText = (v, of) => (of > 0 ? (Math.round((v / of) * 1000) / 10).toLocaleString('th-TH') + '%' : '-');
    const kpi = (label, value, sub, cls) => '<div class="card kpi' + (cls ? ' ' + cls : '') + '"><span class="kpi-label">' + label + '</span>' +
      '<strong class="kpi-value">' + value + '</strong><span class="kpi-sub">' + sub + '</span></div>';

    // ---- ตัวกรอง
    const sel = (name, label, options, cur) => '<label class="field"><span>' + label + '</span><div class="select-wrap"><select data-dash="' + name + '">' +
      options.map(([v, t]) => opt(v, t, cur)).join('') + '</select></div></label>';
    const filters = '<div class="dash-filters">' +
      sel('year', 'ปีงบประมาณ', [['all', 'ทุกปี']].concat(years.map((y) => [y, y])), year) +
      sel('company', 'บริษัท', [['all', 'ทุกบริษัท']].concat(uniq(all.map((b) => b.company)).sort().map((c) => [c, c])), company) +
      sel('type', 'ประเภทงบ', [['all', 'ทั้งหมด'], ['CAPEX', 'CAPEX'], ['CBS', 'OPEX']], type) + '</div>';

    // ---- ตารางสรุปตามมิติที่เลือก
    const groups = by === 'investor' ? investorGroups(list) : {};
    if (by !== 'investor') {
      rows.forEach((x) => {
        const d = dashDimension(by, x.b);
        const g = groups[d.key] || (groups[d.key] = { label: d.label, n: 0, approved: 0, used: 0, reserved: 0, remaining: 0 });
        g.n += 1;
        ['approved', 'used', 'reserved', 'remaining'].forEach((k) => { g[k] = round2(g[k] + x.u[k]); });
      });
    }
    const gl = Object.values(groups).sort((a, b) => b.approved - a.approved);
    const seg = [['company', 'บริษัท'], ['investor', 'บริษัทที่ลงทุน'], ['group', 'กลุ่มงบ'], ['dept', 'หน่วยงาน'], ['type', 'ประเภทงบ']]
      .map(([k, t]) => '<a href="' + q({ by: k }) + '"' + (by === k ? ' class="active" aria-current="true"' : '') + '>' + t + '</a>').join('');
    const miniBar = (g) => '<div class="bar mini" role="img" aria-label="ตัดงบแล้ว ' + pctText(g.used, g.approved) + ' จองไว้ ' + pctText(g.reserved, g.approved) + '">' +
      '<div class="used" style="width:' + pct(g.used, g.approved) + '%"></div><div class="reserved" style="width:' + pct(g.reserved, g.approved) + '%"></div></div>';
    const breakdown = '<section class="card"><div class="section-head"><h2 class="section-title">สรุปงบตาม</h2><div class="seg">' + seg + '</div></div>' +
      (gl.length
        ? '<div class="table-wrap"><table><thead><tr><th>' + { company: 'บริษัทเจ้าของงบ', investor: 'บริษัทที่ลงทุน', group: 'กลุ่มงบ', dept: 'หน่วยงาน', type: 'ประเภทงบ' }[by] + '</th><th class="num">งบ</th>' +
          '<th class="num">งบที่ได้รับ</th><th class="num">ตัดงบแล้ว</th><th class="num">จองไว้</th><th class="num">คงเหลือ</th><th style="width:9rem">สัดส่วน</th></tr></thead><tbody>' +
          gl.map((g) => '<tr><td>' + esc(g.label) + '</td><td class="num">' + g.n + '</td><td class="num">' + money(g.approved) + '</td><td class="num">' + money(g.used) +
            '</td><td class="num">' + money(g.reserved) + '</td><td class="num"><strong>' + moneyCell(g.remaining) + '</strong></td><td>' + miniBar(g) + '</td></tr>').join('') +
          '</tbody><tfoot><tr><td>รวม</td><td class="num">' + rows.length + '</td><td class="num">' + money(tot.approved) + '</td><td class="num">' + money(tot.used) + '</td>' +
          '<td class="num">' + money(tot.reserved) + '</td><td class="num"><strong>' + moneyCell(tot.remaining) + '</strong></td><td></td></tr></tfoot></table></div>' +
          (by === 'investor' ? '<p class="muted small-note dash-note">งบที่ได้รับนับตามบริษัทที่ลงทุนของแต่ละ Item · งบที่ไม่มี Item นับเป็นของบริษัทเจ้าของงบ · ' +
            'ยอดตัดงบ / จองไว้นับตามบริษัทที่ลงทุนของแต่ละบรรทัดในคำขอ (ถ้าบรรทัดเลือกบริษัทอื่น คงเหลือของบริษัทนั้นจะติดลบ) · คอลัมน์ "งบ" = จำนวนงบที่บริษัทนั้นลงทุนอยู่</p>' : '')
        : '<p class="muted">ไม่มีงบตามเงื่อนไขที่เลือก</p>') + '</section>';

    // ---- กราฟตัดงบรายเดือน (เฉพาะที่ฝ่ายบัญชีบันทึกจ่ายแล้ว)
    const listIds = new Set(list.map((b) => b.id));
    const months = {};
    db.requests.filter((r) => listIds.has(r.budgetId)).forEach((r) => paidEntries(r).forEach((e) => {
      if (!e.date) return;
      const k = e.date.slice(0, 7);
      months[k] = round2((months[k] || 0) + e.amount);
    }));
    const keys = Object.keys(months).sort();
    let chart;
    if (!keys.length) {
      chart = '<p class="muted">ยังไม่มีรายการที่ตัดงบแล้ว</p>';
    } else {
      const last = keys[keys.length - 1];
      const span = [];
      let [yy, mm] = last.split('-').map(Number);
      for (let i = 0; i < 6; i += 1) {
        span.unshift(yy + '-' + String(mm).padStart(2, '0'));
        mm -= 1;
        if (mm === 0) { mm = 12; yy -= 1; }
      }
      const max = Math.max.apply(null, span.map((k) => months[k] || 0)) || 1;
      chart = '<div class="chart" role="img" aria-label="ยอดตัดงบรายเดือน">' + span.map((k) => '<div class="chart-col"><span class="chart-val">' +
        (months[k] ? money(months[k]) : '') + '</span><div class="chart-bar" style="height:' + Math.round(((months[k] || 0) / max) * 100) + '%"></div>' +
        '<span class="chart-label">' + monthLabel(k) + '</span></div>').join('') + '</div>';
    }
    const monthly = '<section class="card"><div class="section-head"><h2 class="section-title">ตัดงบรายเดือน (6 เดือนล่าสุด)</h2></div>' + chart + '</section>';

    // ---- งานที่ต้องทำ
    const mineReq = db.requests.filter((r) => r.requesterId === u.id);
    const task = (label, n, href, note) => '<li><a href="' + href + '"><span>' + label + (note ? '<small>' + note + '</small>' : '') + '</span><b class="' + (n ? 'has' : '') + '">' + n + '</b></a></li>';
    const tasks = [];
    if (can('budget.verify')) {
      tasks.push(task('งบที่รอยืนยันเปิดใช้', db.budgets.filter((b) => b.state === 'review').length, '#/tasks?tab=budgets'),
        task('คำขอเพิ่มงบรอตรวจสอบ', (db.changes || []).filter((c) => c.state === 'review').length, '#/tasks?tab=changes'));
    }
    if (can('request.decide')) tasks.push(task('คำขอดำเนินการใช้งบรอตรวจสอบ', inbox(u).length, '#/tasks?tab=requests'));
    if (can('po.record')) tasks.push(task('รอออก PO', db.requests.filter(needsPO).length, '#/tasks?tab=po'));
    if (can('cut.record')) {
      const cuts = db.requests.filter(needsCut);
      tasks.push(task('รอตัดงบ / ปิดยอด', cuts.length, '#/tasks?tab=cuts', cuts.length ? 'รวม ' + money(cuts.reduce((s2, r) => s2 + Math.max(r.amount - cutTotal(r), 0), 0)) + ' บาท' : ''));
    }
    if (can('budget.create')) {
      const mineB = db.budgets.filter((b) => b.ownerId === u.id);
      tasks.push(task('งบร่าง', mineB.filter((b) => b.state === 'draft').length, '#/tasks?tab=drafts'),
        task('งบรอผู้คุมงบยืนยัน', mineB.filter((b) => b.state === 'review').length, '#/tasks?tab=waiting'));
    }
    if (can('request.create')) {
      tasks.push(task('รอแนบ Memo ที่ผู้บริหารเซ็น', mineReq.filter((r) => r.status === 'memo').length, '#/tasks?tab=memo'));
      tasks.push(task('คำขอของฉันที่รอผู้คุมงบตรวจสอบ', mineReq.filter((r) => r.status === 'pending').length, '#/tasks?tab=waiting'),
        task('ส่งกลับแก้ไข', mineReq.filter((r) => r.status === 'rejected').length + db.budgets.filter((b) => b.ownerId === u.id && b.state === 'returned').length, '#/tasks?tab=fix'),
        task('ออกใบดำเนินการใช้งบแล้ว รอปิดยอด', mineReq.filter((r) => r.status === 'approved').length, '#/tasks?tab=open'));
    }
    if (REMOTE && can('user.manage')) tasks.push(task('ผู้ใช้ที่รอกำหนดบทบาท', Number(adminCounts.pending || 0), '#/admin'));
    if (!tasks.length) tasks.push('<li><span class="muted">ไม่มีงานที่ต้องทำสำหรับบทบาทนี้</span></li>');
    const tasksCard = '<section class="card"><h2 class="section-title side-title">งานที่ต้องทำ</h2><ul class="task-list">' + tasks.join('') + '</ul></section>';

    // ---- งบที่ต้องจับตา (เกินงบ / เหลือไม่ถึง 10%)
    const watch = rows.map((x) => {
      const over = x.b.type === 'CBS' ? ledgerItems(x.b).filter((i) => usage(x.b, i.id).remaining < 0).length : 0;
      const ratio = x.u.approved > 0 ? x.u.remaining / x.u.approved : 1;
      return { x, over, ratio };
    }).filter((w) => w.over || w.x.u.remaining < 0 || w.ratio <= 0.1).sort((a, b) => a.ratio - b.ratio).slice(0, 6);
    const watchCard = '<section class="card"><h2 class="section-title side-title">งบที่ต้องจับตา</h2>' + (watch.length
      ? '<ul class="task-list">' + watch.map((w) => '<li><a href="#/budget/' + w.x.b.id + '"><span>' + esc(w.x.b.code) + ' ' + esc(w.x.b.name) +
        '<small>คงเหลือ ' + money(w.x.u.remaining) + ' (' + pctText(w.x.u.remaining, w.x.u.approved) + ')</small></span>' +
        (w.x.u.remaining < 0 ? '<span class="badge rejected">เกินงบ</span>' : w.over ? '<span class="badge rejected">เกินงบ ' + w.over + ' รายการ</span>' : '<span class="badge pending">ใกล้หมด</span>') + '</a></li>').join('') + '</ul>'
      : '<p class="muted">ไม่มีงบที่เกินหรือใกล้หมด (เหลือน้อยกว่า 10%)</p>') + '</section>';

    return '<div class="page-head"><div><h1>ภาพรวมงบประมาณ</h1><div class="page-sub">' + (canViewAll() ? 'ทุกงบในระบบ' : 'เฉพาะงบของคุณ') + ' · ' + list.length + ' งบ</div></div>' + filters + '</div>' +
      '<div class="kpis">' +
      kpi('งบที่เปิดใช้แล้ว', money(tot.approved), list.length + ' งบ') +
      kpi('ตัดงบแล้ว', money(tot.used), pctText(tot.used, tot.approved) + ' ของงบ') +
      kpi('จองไว้ (ยังไม่ตัดงบ)', money(tot.reserved), pctText(tot.reserved, tot.approved) + ' ของงบ') +
      kpi('คงเหลือ', moneyCell(tot.remaining), pctText(tot.remaining, tot.approved) + ' ของงบ', tot.remaining < 0 ? 'bad' : '') + '</div>' +
      '<div class="card dash-bar">' + usageBar(Object.assign({}, tot)) + '</div>' +
      '<div class="dash-grid"><div class="dash-main">' + breakdown + monthly + '</div><aside class="dash-side">' + tasksCard + watchCard + '</aside></div>';
  }

  function bindDashboard() {
    document.querySelectorAll('[data-dash]').forEach((el) => el.addEventListener('change', () => {
      const cur = new URLSearchParams(location.hash.split('?')[1] || '');
      document.querySelectorAll('[data-dash]').forEach((x) => cur.set(x.dataset.dash, x.value));
      go('#/dashboard?' + cur.toString());
    }));
  }

  // ---------------------------------------------------------------- master data (finance)

  /** รายการข้อมูลหลัก: cols[0] เป็นรหัส/ชื่อที่ใช้อ้างอิง — รหัส (lock) แก้ไม่ได้หลังสร้าง, ชื่อที่ใช้อ้างอิง (เช่น หน่วยงาน) เปลี่ยนแล้วระบบแก้ให้ทุกงบ */
  const MASTER_SECTIONS = [
    { key: 'companies', title: 'บริษัท', hint: 'ใช้กับงบทุกประเภท · เกณฑ์ Memo (ใช้กับ CAPEX เท่านั้น) = "ใช้เงินข้ามบริษัทกับบริษัทนี้" ต้องให้ผู้บริหารเซ็น Memo ก่อนส่ง เมื่อบริษัทอื่นมาใช้งบของบริษัทนี้ หรือบริษัทนี้ออกเงินให้งบของบริษัทอื่น (ตั้งต้น: PCC)', lock: true,
      cols: [{ k: 'code', label: 'รหัสบริษัท', w: '10rem' }, { k: 'name', label: 'ชื่อบริษัท' }, { k: 'memo', label: 'เกณฑ์ Memo ผู้บริหารเซ็น', type: 'select', options: MEMO_MODES, w: '15rem' },
        { k: 'logo', label: 'โลโก้หัวกระดาษ Memo', type: 'image', w: '14rem' }],
      inUse: (it) => db.budgets.some((b) => b.company === it.code) },
    { key: 'departments', title: 'หน่วยงาน', hint: 'ตัวเลือกหน่วยงานของงบ และตัวกรองในหน้ารายการงบ', lock: false,
      cols: [{ k: 'name', label: 'ชื่อหน่วยงาน' }],
      inUse: (it) => db.budgets.some((b) => b.department === it.name),
      rename: (from, to) => db.budgets.forEach((b) => { if (b.department === from) b.department = to; }) },
    { key: 'groups', title: 'กลุ่มงบประมาณ (CAPEX)', hint: 'กลุ่มงบที่อยู่ในรหัสรายการย่อย เช่น 2026-01-EN001 → กลุ่ม 01', lock: true,
      cols: [{ k: 'code', label: 'รหัสกลุ่ม', w: '10rem' }, { k: 'name', label: 'ชื่อกลุ่มงบ' }],
      inUse: (it) => db.budgets.some((b) => b.group === it.code) },
    { key: 'assetTypes', title: 'ประเภทสินทรัพย์ (CAPEX)', hint: 'ตัวเลือกประเภทสินทรัพย์ของรายการย่อย', lock: false,
      cols: [{ k: 'name', label: 'ประเภทสินทรัพย์' }],
      inUse: (it) => db.budgets.some((b) => b.type === 'CAPEX' && b.items.some((i) => i.assetType === it.name)),
      rename: (from, to) => db.budgets.forEach((b) => b.items.forEach((i) => { if (b.type === 'CAPEX' && i.assetType === from) i.assetType = to; })) },
    { key: 'expenseCategories', title: 'หมวดค่าใช้จ่าย', hint: 'ตัวเลือกหมวดค่าใช้จ่ายของแต่ละบรรทัด เมื่อขอดำเนินการใช้งบของงบที่ไม่มี Item (งบรวมโครงการ)', lock: false,
      cols: [{ k: 'name', label: 'หมวดค่าใช้จ่าย' }, { k: 'gl', label: 'GL Code (ถ้ามี)', w: '12rem' }],
      inUse: (it) => db.requests.some((r) => r.lines.some((l) => l.category === it.name)),
      rename: (from, to) => db.requests.forEach((r) => r.lines.forEach((l) => { if (l.category === from) l.category = to; })) },
    { key: 'memoParties', title: 'ผู้ลงนามและอำนาจอนุมัติใน Memo', lock: true,
      hint: 'ใช้พิมพ์ Memo ขอดำเนินการใช้งบ ตั้งรายบริษัท — "เรียน / สำเนาถึง / ผู้ทบทวน / อ้างอิงอำนาจอนุมัติ" ใช้ของ <strong>บริษัทที่ลงทุน</strong> (ถ้าคำขอมีหลายบริษัทใช้ของบริษัทที่ลงทุนมากที่สุด) · "ผู้ลงนามเสนอ" ใช้ของ <strong>บริษัทเจ้าของงบ</strong> · ใช้เป็น <strong>ค่าเริ่มต้น</strong> ในฟอร์มคำขอ (ผู้ขอแก้ได้ต่อคำขอ) · ข้อมูลในโหมดทดลองเก็บในเบราว์เซอร์นี้เท่านั้น',
      cols: [{ k: 'code', label: 'บริษัท', w: '7rem' }, { k: 'to', label: 'เรียน / ผู้พิจารณาอนุมัติ (หลายคนคั่นด้วย ;)', w: '15rem' }, { k: 'cc', label: 'สำเนาถึง (หลายคนคั่นด้วย ;)', w: '13rem' },
        { k: 'reviewer', label: 'ผู้ทบทวน / ให้ความเห็นชอบ (หลายคนคั่นด้วย ;)', w: '15rem' }, { k: 'signer', label: 'ผู้ลงนามเสนอ (ชื่อ / ตำแหน่ง)', w: '15rem' },
        { k: 'doa', label: 'อ้างอิงอำนาจอนุมัติ (DOA)', w: '16rem' }],
      inUse: () => false },
    { key: 'glCodes', title: 'GL Code (OPEX)', hint: 'เลือก GL Code ในรายการต้นทุน แล้วระบบเติมชื่อ GL ให้', lock: true,
      cols: [{ k: 'code', label: 'GL Code', w: '10rem' }, { k: 'name', label: 'ชื่อ GL' }],
      inUse: (it) => db.budgets.some((b) => b.type === 'CBS' && b.items.some((i) => i.glCode === it.code)) ||
        db.requests.some((r) => r.type === 'CBS' && r.lines.some((l) => l.glCode === it.code)) }
  ];

  /** เมนูย่อยของข้อมูลหลัก: [key, ชื่อเมนู] */
  const MASTER_NAV = [['companies', 'บริษัท'], ['departments', 'หน่วยงาน'], ['groups', 'กลุ่มงบประมาณ'], ['assetTypes', 'ประเภทสินทรัพย์'],
    ['expenseCategories', 'หมวดค่าใช้จ่าย'], ['glCodes', 'GL Code'], ['memoParties', 'ผู้ลงนาม Memo'], ['doa', 'ตารางอำนาจอนุมัติ (DOA)']];

  function masterRow(sec, it, isNew) {
    return '<tr data-orig="' + (isNew ? '' : esc(it[sec.cols[0].k])) + '">' + sec.cols.map((c, i) => (c.type === 'image'
      ? '<td' + (c.w ? ' style="width:' + c.w + '"' : '') + '><div class="logo-cell"><input type="hidden" data-k="' + c.k + '" value="' + esc(isNew ? '' : it[c.k] || '') + '">' +
        '<span class="logo-prev">' + (!isNew && it[c.k] ? '<img src="' + esc(it[c.k]) + '" alt="">' : '<span class="muted">ไม่มี</span>') + '</span>' +
        '<label class="btn small file-btn">เลือกรูป<input type="file" accept="image/png,image/jpeg,image/svg+xml" data-logo-file hidden></label>' +
        '<button type="button" class="btn small" data-logo-clear title="ลบโลโก้">ลบ</button></div></td>'
      : c.type === 'select'
      ? '<td' + (c.w ? ' style="width:' + c.w + '"' : '') + '><div class="select-wrap"><select data-k="' + c.k + '" aria-label="' + esc(c.label) + '">' +
        c.options.map(([v, t]) => opt(v, t, isNew ? '' : it[c.k] || '')).join('') + '</select></div></td>'
      : '<td' + (c.w ? ' style="width:' + c.w + '"' : '') + '><input data-k="' + c.k + '" value="' + esc(it[c.k] || '') + '" aria-label="' + esc(c.label) + '"' +
      (sec.lock && i === 0 && !isNew ? ' readonly class="locked"' : '') + '></td>')).join('') +
      '<td style="width:3rem"><button type="button" class="btn small bad" data-m-remove title="ลบ">×</button></td></tr>';
  }

  function viewMaster(sub) {
    if (!can('master.manage')) return '<div class="alert error">ไม่มีสิทธิ์จัดการข้อมูลหลัก</div>';
    const key = MASTER_NAV.some(([k]) => k === sub) ? sub : MASTER_NAV[0][0];
    const navTitle = MASTER_NAV.find(([k]) => k === key)[1];
    const sections = MASTER_SECTIONS.filter((sec) => sec.key === key).map((sec) => '<section class="card form-section"><div class="section-head"><div><h2 class="section-title">' + sec.title +
      '</h2><div class="muted section-hint">' + sec.hint + '</div></div></div>' +
      '<form class="master-form" data-key="' + sec.key + '"><div class="table-wrap"><table class="edit-table"><thead><tr>' +
      sec.cols.map((c) => '<th>' + c.label + '</th>').join('') + '<th></th></tr></thead><tbody>' +
      db.master[sec.key].map((it) => masterRow(sec, it, false)).join('') + '</tbody></table></div>' +
      '<template>' + masterRow(sec, {}, true) + '</template>' +
      '<div class="actions"><button type="button" class="btn" data-m-add>+ เพิ่ม</button><button class="btn primary" type="submit">บันทึก' + sec.title + '</button></div></form></section>').join('');

    const doa = Object.keys(DOA).map((k) => '<h3 class="side-title">' + esc(DOA[k].short) + '</h3><div class="table-wrap"><table><thead><tr><th>ข้อ</th><th>วงเงิน</th><th>ผู้อนุมัติ</th></tr></thead><tbody>' +
      DOA[k].rows.map((r) => '<tr><td class="nowrap">' + esc(r.code) + '</td><td>' + esc(r.label) + '</td><td>' + esc(r.approver) + '</td></tr>').join('') + '</tbody></table></div>').join('');
    return '<div class="page-head"><div><h1>' + esc(navTitle) + '</h1><div class="page-sub">ข้อมูลหลัก — ค่าที่ใช้เป็นตัวเลือกในฟอร์มและรายงาน</div></div></div>' + takeFlash() +
      '<div id="formError"></div><div class="form-main">' + sections +
      (key === 'doa' ? '<section class="card form-section"><div class="section-head"><div><h2 class="section-title">ตารางอำนาจอนุมัติ (DOA)</h2><div class="muted section-hint">อ่านอย่างเดียว — ใช้ติ๊กระดับผู้อนุมัติบนใบดำเนินการใช้งบ CAPEX ตามยอดเงิน (หน่วย: ล้านบาท)</div></div></div>' + doa + '</section>' : '') +
      '</div>';
  }

  function bindMaster() {
    document.querySelectorAll('.master-form').forEach((form) => {
      const sec = MASTER_SECTIONS.find((x) => x.key === form.dataset.key);
      const tbody = form.querySelector('tbody');
      // โลโก้: อ่านรูปเป็น data URL (ไม่เกิน 300 KB)
      form.addEventListener('change', (e) => {
        if (!e.target.matches('[data-logo-file]')) return;
        const file = e.target.files[0];
        const cell = e.target.closest('.logo-cell');
        e.target.value = '';
        if (!file) return;
        if (file.size > 300 * 1024) { alert('รูปโลโก้ต้องไม่เกิน 300 KB'); return; }
        const rd = new FileReader();
        rd.onload = () => {
          cell.querySelector('input[type="hidden"]').value = rd.result;
          cell.querySelector('.logo-prev').innerHTML = '<img src="' + esc(rd.result) + '" alt="">';
        };
        rd.readAsDataURL(file);
      });
      form.addEventListener('click', (e) => {
        if (e.target.matches('[data-logo-clear]')) {
          const cell = e.target.closest('.logo-cell');
          cell.querySelector('input[type="hidden"]').value = '';
          cell.querySelector('.logo-prev').innerHTML = '<span class="muted">ไม่มี</span>';
          return;
        }
        if (e.target.matches('[data-m-add]')) {
          tbody.insertAdjacentHTML('beforeend', form.querySelector('template').innerHTML);
          tbody.lastElementChild.querySelector('input:not([type="hidden"])').focus();
        } else if (e.target.matches('[data-m-remove]')) {
          const tr = e.target.closest('tr');
          const orig = tr.dataset.orig;
          const item = orig && db.master[sec.key].find((x) => x[sec.cols[0].k] === orig);
          if (item && sec.inUse(item)) { alert('ลบไม่ได้ — "' + orig + '" ถูกใช้อยู่ในงบหรือเอกสารแล้ว'); return; }
          tr.remove();
        }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const keyCol = sec.cols[0].k;
        const rows = Array.from(tbody.rows).map((tr) => {
          const it = { orig: tr.dataset.orig };
          sec.cols.forEach((c) => {
            const el = tr.querySelector('[data-k="' + c.k + '"]');
            it[c.k] = el.tagName === 'SELECT' ? el.value : el.value.trim();
          });
          return it;
        }).filter((it) => it[keyCol] || it.orig);
        const errors = [];
        if (!rows.length) errors.push('ต้องมีอย่างน้อย 1 รายการ');
        rows.forEach((it) => { if (!it[keyCol]) errors.push('กรุณากรอก' + sec.cols[0].label); });
        const keys = rows.map((it) => it[keyCol].toLowerCase());
        if (keys.some((k, i) => k && keys.indexOf(k) !== i)) errors.push(sec.cols[0].label + 'ซ้ำกัน');
        if (errors.length) { showErrors(errors); return; }
        const data = rows.map((it) => { const o = {}; sec.cols.forEach((c) => { o[c.k] = it[c.k]; }); return o; });
        if (REMOTE) {
          const renames = sec.rename ? rows.filter((it) => it.orig && it.orig !== it[keyCol]).map((it) => ({ from: it.orig, to: it[keyCol] })) : [];
          if (!(await runAndReload(() => window.RemoteApi.saveMaster(sec.key, data, renames)))) return;
        } else {
          if (sec.rename) rows.forEach((it) => { if (it.orig && it.orig !== it[keyCol]) sec.rename(it.orig, it[keyCol]); });
          db.master[sec.key] = data;
          save();
        }
        setFlash('success', 'บันทึก' + sec.title + 'แล้ว');
        go('#/master/' + sec.key);
      });
    });
  }


  // ---------------------------------------------------------------- Admin: ผู้ใช้ บทบาท สิทธิ์ (โหมด Supabase)

  function viewAdmin(params) {
    if (!can('user.manage')) return '<div class="alert error">ไม่มีสิทธิ์จัดการผู้ใช้และสิทธิ์</div>';
    if (!REMOTE) return viewAdminDemo();
    const tab = params.get('tab') === 'roles' ? 'roles' : 'users';
    const t = (key, label) => '<a href="#/admin' + (key === 'roles' ? '?tab=roles' : '') + '"' + (tab === key ? ' class="active" aria-current="page"' : '') + '>' + label + '</a>';
    return '<div class="page-head"><div><h1>ผู้ใช้และสิทธิ์</h1><div class="page-sub">จัดการผู้ใช้ บทบาท และสิทธิ์ของแต่ละบทบาท — มีผลทันที ตรวจสอบที่ฝั่งฐานข้อมูล</div></div></div>' + takeFlash() +
      '<nav class="tabs" aria-label="หมวด">' + t('users', 'ผู้ใช้') + t('roles', 'บทบาทและสิทธิ์') + '</nav>' +
      '<div id="adminBox" data-tab="' + tab + '"><p class="muted">กำลังโหลด…</p></div>';
  }

  async function bindAdmin() {
    const box = document.getElementById('adminBox');
    if (!box) return;
    const [ru, rr] = await Promise.all([run(() => window.RemoteApi.listUsers()), run(() => window.RemoteApi.listRoles())]);
    if (!ru || !rr || !document.getElementById('adminBox')) return;
    const users = ru.value;
    const { roles, catalog } = rr.value;
    adminCounts.pending = users.filter((x) => x.active && !x.role).length;
    renderNav(location.hash.split('?')[0]);
    if (box.dataset.tab === 'roles') renderRolesTab(box, users, roles, catalog); else renderUsersTab(box, users, roles);
  }

  function renderUsersTab(box, users, roles) {
    const stat = (label, n, cls) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><strong>' + n + '</strong><span>' + label + '</span></div>';
    const pending = users.filter((x) => x.active && !x.role).length;
    const disabled = users.filter((x) => !x.active).length;
    const roleOpts = (cur) => opt('', '— ยังไม่กำหนดสิทธิ์ —', cur || '') + roles.map((r) => opt(r.key, r.name, cur || '')).join('');
    box.innerHTML =
      '<div class="admin-stats">' + stat('ผู้ใช้ทั้งหมด', users.length) + stat('รอกำหนดบทบาท', pending, pending ? 'warn' : '') + stat('ปิดการใช้งาน', disabled) + '</div>' +
      '<section class="card form-section"><div class="section-head"><div><h2 class="section-title">รายชื่อผู้ใช้</h2>' +
      '<div class="muted section-hint">เพิ่มผู้ใช้ใหม่ที่ Supabase Dashboard → Authentication → Users → Add user (ใส่อีเมลและรหัสผ่าน) ผู้ใช้จะปรากฏที่นี่เองเป็น "รอกำหนดบทบาท" แล้วมากำหนดชื่อและบทบาทให้</div></div></div>' +
      '<div class="admin-filters"><label class="input-wrap search">' + ICON_SEARCH + '<input id="uSearch" type="search" placeholder="ค้นหาชื่อ อีเมล หน่วยงาน" aria-label="ค้นหา"></label>' +
      '<div class="select-wrap"><select id="uRole" aria-label="กรองตามบทบาท">' + opt('', 'บทบาท: ทั้งหมด', '') + opt('none', 'บทบาท: รอกำหนด', '') + roles.map((r) => opt(r.key, 'บทบาท: ' + r.name, '')).join('') + '</select></div>' +
      '<div class="select-wrap"><select id="uStatus" aria-label="กรองตามสถานะ">' + opt('', 'สถานะ: ทั้งหมด', '') + opt('on', 'สถานะ: ใช้งาน', '') + opt('off', 'สถานะ: ปิดการใช้งาน', '') + '</select></div></div>' +
      '<datalist id="deptList">' + db.master.departments.map((d) => '<option value="' + esc(d.name) + '"></option>').join('') + '</datalist>' +
      '<div class="table-wrap"><table class="edit-table users-table"><thead><tr><th>อีเมล</th><th>ชื่อ-นามสกุล</th><th>ตำแหน่ง</th><th>หน่วยงาน</th><th>บทบาท</th><th>ใช้งาน</th><th></th></tr></thead><tbody id="uRows">' +
      users.map((u) => '<tr data-uid="' + esc(u.id) + '" data-search="' + esc((u.email + ' ' + u.name + ' ' + u.department).toLowerCase()) + '" data-role="' + esc(u.role || 'none') + '" data-active="' + (u.active ? 'on' : 'off') + '">' +
        '<td class="nowrap">' + esc(u.email) + (u.id === me().id ? ' <span class="muted">(คุณ)</span>' : '') + (!u.role && u.active ? '<div><span class="badge pending">รอกำหนดบทบาท</span></div>' : '') + '</td>' +
        '<td><input data-u="name" value="' + esc(u.name) + '" aria-label="ชื่อ"></td><td><input data-u="title" value="' + esc(u.title) + '" aria-label="ตำแหน่ง"></td>' +
        '<td><input data-u="department" list="deptList" value="' + esc(u.department) + '" aria-label="หน่วยงาน"></td>' +
        '<td><div class="select-wrap"><select data-u="role" aria-label="บทบาท">' + roleOpts(u.role) + '</select></div></td>' +
        '<td class="center"><input type="checkbox" data-u="active" aria-label="ใช้งาน"' + (u.active ? ' checked' : '') + '></td>' +
        '<td><button type="button" class="btn small primary" data-u-save>บันทึก</button></td></tr>').join('') + '</tbody></table></div>' +
      '<p class="muted small-note" id="uEmpty" hidden>ไม่พบผู้ใช้ตามเงื่อนไข</p></section>';
    const rows = Array.from(box.querySelectorAll('#uRows tr'));
    const apply = () => {
      const q = box.querySelector('#uSearch').value.trim().toLowerCase();
      const r = box.querySelector('#uRole').value;
      const st = box.querySelector('#uStatus').value;
      let shown = 0;
      rows.forEach((tr) => {
        const okRow = (!q || tr.dataset.search.includes(q)) && (!r || tr.dataset.role === r) && (!st || tr.dataset.active === st);
        tr.hidden = !okRow;
        if (okRow) shown += 1;
      });
      box.querySelector('#uEmpty').hidden = shown > 0;
    };
    ['#uSearch', '#uRole', '#uStatus'].forEach((sel) => box.querySelector(sel).addEventListener('input', apply));
    box.querySelector('#uRows').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-u-save]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const val = (k) => tr.querySelector('[data-u="' + k + '"]');
      const next = { id: tr.dataset.uid, name: val('name').value.trim(), title: val('title').value.trim(), department: val('department').value.trim(), role: val('role').value, active: val('active').checked };
      if (next.role && !next.name) { alert('กรุณากรอกชื่อ-นามสกุลก่อนกำหนดบทบาท'); return; }
      if (!(await runAndReload(() => window.RemoteApi.updateUser(next)))) return;
      setFlash('success', 'บันทึกข้อมูลผู้ใช้ ' + (next.name || '') + ' แล้ว');
      go('#/admin');
    });
  }

  function renderRolesTab(box, users, roles, catalog) {
    const groups = [];
    PERMISSIONS.filter((p) => catalog.includes(p.key)).forEach((p) => {
      let g = groups.find((x) => x.name === p.group);
      if (!g) { g = { name: p.group, items: [] }; groups.push(g); }
      g.items.push(p);
    });
    const IMPLIES_VIEW = ['budget.manage', 'request.decide', 'payment.record'];
    const locked = (r, perm) => r.key === 'admin' && perm === 'user.manage';
    const cols = roles.length + 1;
    const matrix = '<div class="table-wrap"><table class="perm-matrix"><thead><tr><th>สิทธิ์</th>' +
      roles.map((r) => '<th class="perm-col"><div class="role-name">' + esc(r.name) + '</div><div class="muted">' + esc(r.key) + ' · ' + r.users + ' คน</div></th>').join('') + '</tr></thead><tbody>' +
      groups.map((g) => '<tr class="perm-group"><td colspan="' + cols + '">' + esc(g.name) + '</td></tr>' + g.items.map((p) =>
        '<tr><td><strong>' + esc(p.label) + '</strong><div class="muted">' + esc(p.hint) + '</div></td>' + roles.map((r) =>
          '<td class="center"><input type="checkbox" data-role="' + esc(r.key) + '" data-perm="' + p.key + '"' + (r.permissions.includes(p.key) || locked(r, p.key) ? ' checked' : '') +
          (locked(r, p.key) ? ' disabled title="Admin ต้องมีสิทธิ์นี้เสมอ"' : '') + ' aria-label="' + esc(r.name + ': ' + p.label) + '"></td>').join('') + '</tr>').join('')).join('') +
      '</tbody></table></div>';
    const details = '<div class="table-wrap"><table class="edit-table"><thead><tr><th>รหัส</th><th>ชื่อบทบาท</th><th>คำอธิบาย</th><th>ผู้ใช้</th><th></th></tr></thead><tbody>' +
      roles.map((r) => '<tr data-rkey="' + esc(r.key) + '"><td class="nowrap">' + esc(r.key) + (r.isSystem ? '<div class="muted">บทบาทตั้งต้น</div>' : '') + '</td>' +
        '<td><input data-r="name" value="' + esc(r.name) + '" aria-label="ชื่อบทบาท"></td><td><input data-r="description" value="' + esc(r.description) + '" aria-label="คำอธิบาย"></td>' +
        '<td class="num">' + r.users + '</td><td>' + (r.isSystem ? '' : '<button type="button" class="btn small bad" data-r-del title="' + (r.users ? 'ลบไม่ได้ — ยังมีผู้ใช้' : 'ลบบทบาท') + '"' + (r.users ? ' disabled' : '') + '>ลบ</button>') + '</td></tr>').join('') + '</tbody></table></div>';
    box.innerHTML = '<section class="card form-section"><div class="section-head"><div><h2 class="section-title">ตารางสิทธิ์ของแต่ละบทบาท</h2>' +
      '<div class="muted section-hint">ติ๊กเพื่อให้บทบาทนั้นทำสิ่งนั้นได้ — มีผลกับผู้ใช้ทุกคนในบทบาททันที สิทธิ์อนุมัติ งวดจ่าย บัญชี และจัดการงบ เห็นงบและคำขอทั้งหมดโดยอัตโนมัติ</div></div></div>' +
      matrix + '<h3 class="side-title" style="margin-top:var(--s-6)">ชื่อและคำอธิบายบทบาท</h3>' + details +
      '<div class="actions"><button type="button" class="btn primary" id="saveRoles">บันทึกการเปลี่ยนแปลง</button></div></section>' +
      '<section class="card form-section"><div class="section-head"><div><h2 class="section-title">สร้างบทบาทใหม่</h2><div class="muted section-hint">เช่น ผู้จัดการฝ่าย, ผู้ตรวจสอบ (ดูอย่างเดียว) หรือ Admin + การเงิน สำหรับทีมเล็กที่คนเดียวทำหลายหน้าที่</div></div></div>' +
      '<form id="newRole" class="form-grid"><label class="field"><span>รหัสบทบาท (อังกฤษพิมพ์เล็ก เช่น manager)</span><input name="key" required pattern="[a-z][a-z0-9_]{1,29}" maxlength="30"></label>' +
      '<label class="field"><span>ชื่อบทบาท</span><input name="name" required></label>' +
      '<label class="field full"><span>คำอธิบาย</span><input name="description"></label>' +
      '<label class="field"><span>คัดลอกสิทธิ์จาก</span><div class="select-wrap"><select name="copy">' + opt('', '— เริ่มจากไม่มีสิทธิ์ —', '') + roles.map((r) => opt(r.key, r.name, '')).join('') + '</select></div></label>' +
      '<div class="field"><span>&nbsp;</span><button class="btn primary" type="submit">สร้างบทบาท</button></div></form></section>';

    // สิทธิ์ที่ต้องเห็นเอกสารของคนอื่น → ช่อง "ดูงบและคำขอของทุกคน" ถูกรวมไว้แล้ว
    const syncImplied = () => roles.forEach((r) => {
      const view = box.querySelector('[data-role="' + r.key + '"][data-perm="budget.view_all"]');
      if (!view) return;
      const implied = IMPLIES_VIEW.some((k) => { const c = box.querySelector('[data-role="' + r.key + '"][data-perm="' + k + '"]'); return c && c.checked; });
      view.title = implied ? 'รวมอยู่แล้วจากสิทธิ์อื่นของบทบาทนี้' : '';
      view.closest('td').classList.toggle('implied', implied);
    });
    box.addEventListener('change', syncImplied);
    syncImplied();

    box.querySelector('#saveRoles').addEventListener('click', async () => {
      const changed = [];
      let invalid = false;
      roles.forEach((r) => {
        const tr = box.querySelector('tr[data-rkey="' + r.key + '"]');
        const name = tr.querySelector('[data-r="name"]').value.trim();
        const description = tr.querySelector('[data-r="description"]').value.trim();
        const permissions = PERMISSIONS.map((p) => p.key).filter((k) => catalog.includes(k) && box.querySelector('[data-role="' + r.key + '"][data-perm="' + k + '"]').checked);
        const same = name === r.name && description === r.description && permissions.length === r.permissions.length && permissions.every((k) => r.permissions.includes(k));
        if (!name) { alert('กรุณากรอกชื่อบทบาท ' + r.key); invalid = true; return; }
        if (!same) changed.push({ key: r.key, name, description, permissions });
      });
      if (invalid) return;
      if (!changed.length) { alert('ยังไม่มีการเปลี่ยนแปลง'); return; }
      for (const c of changed) {
        if (!(await run(() => window.RemoteApi.saveRole(c)))) { await run(reloadRemote); go('#/admin?tab=roles'); return; }
      }
      if (!(await run(reloadRemote))) return;
      setFlash('success', 'บันทึกสิทธิ์ของ ' + changed.length + ' บทบาทแล้ว — มีผลกับผู้ใช้ทันที');
      go('#/admin?tab=roles');
    });
    box.querySelector('table.edit-table tbody').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-r-del]');
      if (!del) return;
      const key = del.closest('tr').dataset.rkey;
      if (!confirm('ลบบทบาท ' + key + ' ?')) return;
      if (!(await runAndReload(() => window.RemoteApi.deleteRole(key)))) return;
      setFlash('info', 'ลบบทบาท ' + key + ' แล้ว');
      go('#/admin?tab=roles');
    });
    box.querySelector('#newRole').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const src = roles.find((r) => r.key === f.copy.value);
      const role = { key: f.key.value.trim(), name: f.name.value.trim(), description: f.description.value.trim(), permissions: src ? src.permissions.filter((k) => k !== 'user.manage') : [] };
      if (!(await runAndReload(() => window.RemoteApi.saveRole(role)))) return;
      setFlash('success', 'สร้างบทบาท ' + role.name + ' แล้ว — ติ๊กสิทธิ์ในตารางด้านบน');
      go('#/admin?tab=roles');
    });
  }

  // ---------------------------------------------------------------- คำขอเพิ่มงบ (Business → ที่ประชุม → ผู้คุมงบยืนยัน)

  function changeLineRow(b, l) {
    const opts = ledgerItems(b).map((i) => opt(i.id, i.code + ' ' + i.name + ' — งบ ' + money(itemTotal(i)), l.itemId || '')).join('');
    const isNew = l.itemId === 'new';
    return '<tr><td><div class="select-wrap"><select name="chItem" aria-label="รายการ">' + opts + opt('new', '+ เพิ่มรายการใหม่', l.itemId || '') + '</select></div>' +
      '<div class="new-item"' + (isNew ? '' : ' hidden') + '>' + investorSelect('chInv', l.investor || b.company) + '<input name="chCode" placeholder="รหัสรายการ" value="' + esc(l.code || '') + '"><input name="chName" placeholder="ชื่อรายการ" value="' + esc(l.name || '') + '"></div></td>' +
      '<td><input name="chAmount" type="number" min="0.01" step="0.01" class="right" value="' + esc(l.amount || '') + '" aria-label="ขอเพิ่ม"></td>' +
      '<td><button type="button" class="btn small bad" data-remove-ch title="ลบ">×</button></td></tr>';
  }

  function viewChangeForm(budgetId, changeId) {
    const c = changeId ? changeById(changeId) : null;
    if (changeId && !c) return notFound();
    const b = budgetById(c ? c.budgetId : budgetId);
    if (!b) return notFound();
    if (b.ownerId !== me().id || !can('request.create')) return '<div class="alert error">ขอเพิ่มงบได้เฉพาะ Business เจ้าของงบนี้</div>';
    if (!isActive(b)) return '<div class="alert error">งบนี้ยังไม่เปิดใช้งาน</div>';
    if (c && !['draft', 'returned'].includes(c.state)) return '<div class="alert error">แก้ไขได้เฉพาะร่างหรือคำขอที่ถูกส่งกลับ</div>';
    const isProject = b.structure === 'project';
    const lines = c ? c.lines : [{ itemId: isProject ? b.items[0].id : (ledgerItems(b)[0] || {}).id }];
    return '<div class="page-head"><div><h1>' + (c ? 'แก้ไขคำขอเพิ่มงบ ' + esc(c.no) : 'ขอเพิ่มงบ') + '</h1><div class="page-sub">' + badge(b.type, TYPE_SHORT[b.type]) + ' ' + esc(b.code + ' ' + b.name) +
      ' — บันทึกเป็นร่าง → ' + (b.type === 'CBS' ? 'เสนอผู้บริหารอนุมัติ → แนบเอกสารอนุมัติ' : 'เข้าที่ประชุม → แนบมติ') + ' → ผู้คุมงบยืนยัน แล้ววงเงินจึงเพิ่ม</div></div></div><div id="formError"></div>' +
      '<form id="changeForm" class="card form-section" data-budget="' + b.id + '" data-id="' + esc(changeId || '') + '">' +
      '<label class="field"><span>เหตุผลที่ขอเพิ่มงบ</span><textarea name="reason" rows="3" required>' + esc(c ? c.reason : '') + '</textarea></label>' +
      (isProject
        ? '<label class="field"><span>ขอเพิ่มวงเงินรวมทั้งโครงการ (รวม VAT)</span><input name="projAdd" type="number" min="0.01" step="0.01" class="right" required value="' + esc(c ? c.lines[0].amount : '') + '"></label>'
        : '<div class="table-wrap"><table class="edit-table"><thead><tr><th>รายการ</th><th class="num" style="width:12rem">ขอเพิ่ม (รวม VAT)</th><th style="width:3rem"></th></tr></thead>' +
          '<tbody id="chRows">' + lines.map((l) => changeLineRow(b, l)).join('') + '</tbody></table></div>' +
          '<template id="chTpl">' + changeLineRow(b, { itemId: (ledgerItems(b)[0] || {}).id }) + '</template>' +
          '<div class="actions table-actions"><button type="button" class="btn small" id="addCh">+ เพิ่มบรรทัด</button><span class="muted">รวมขอเพิ่ม <strong id="chTotal">0.00</strong> บาท</span></div>') +
      '<div class="actions"><button class="btn primary" type="submit">บันทึกร่าง</button><a class="btn" data-back href="#/budget/' + b.id + '">ยกเลิก</a></div></form>';
  }

  function bindChangeForm() {
    const form = document.getElementById('changeForm');
    if (!form) return;
    const b = budgetById(form.dataset.budget);
    const rows = document.getElementById('chRows');
    const recalc = () => {
      if (!rows) return;
      let t = 0;
      Array.from(rows.rows).forEach((tr) => {
        t += Number(tr.querySelector('[name="chAmount"]').value || 0);
        tr.querySelector('.new-item').hidden = tr.querySelector('[name="chItem"]').value !== 'new';
      });
      document.getElementById('chTotal').textContent = money(t);
    };
    if (rows) {
      document.getElementById('addCh').addEventListener('click', () => { rows.insertAdjacentHTML('beforeend', document.getElementById('chTpl').innerHTML); recalc(); });
      rows.addEventListener('click', (e) => { if (e.target.matches('[data-remove-ch]') && rows.rows.length > 1) { e.target.closest('tr').remove(); recalc(); } });
      form.addEventListener('input', recalc);
      form.addEventListener('change', recalc);
      recalc();
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      const errors = [];
      const reason = f.reason.value.trim();
      if (!reason) errors.push('กรุณาระบุเหตุผล');
      let lines;
      if (b.structure === 'project') {
        lines = [{ itemId: b.items[0].id, amount: round2(f.projAdd.value) }];
      } else {
        lines = Array.from(rows.rows).map((tr) => {
          const itemId = tr.querySelector('[name="chItem"]').value;
          const l = { itemId, amount: round2(tr.querySelector('[name="chAmount"]').value) };
          if (itemId === 'new') Object.assign(l, { code: tr.querySelector('[name="chCode"]').value.trim(), name: tr.querySelector('[name="chName"]').value.trim(), investor: tr.querySelector('[name="chInv"]').value });
          return l;
        });
        lines.filter((l) => l.itemId === 'new').forEach((l) => {
          if (!l.code || !l.name) errors.push('กรุณากรอกรหัสและชื่อรายการใหม่');
          else if (b.items.some((i) => i.code === l.code)) errors.push('รหัสรายการ ' + l.code + ' มีอยู่แล้ว');
          else if (b.type === 'CBS' && String(l.code).includes('.')) errors.push('Item หลักใหม่ใช้รหัสไม่มีจุด (เช่น 5) — Item ย่อยเพิ่มที่หน้ารายละเอียดงบ');
        });
      }
      if (lines.some((l) => !(l.amount > 0))) errors.push('จำนวนเงินที่ขอเพิ่มต้องมากกว่า 0');
      if (errors.length) { showErrors(errors); return; }
      let c = form.dataset.id ? changeById(form.dataset.id) : null;
      if (c) {
        Object.assign(c, { reason, lines });
        addHistory(c, 'แก้ไขคำขอเพิ่มงบ', '', c.no);
      } else {
        c = { id: nextId('g'), no: nextNo(DOC_PREFIX.inc), budgetId: b.id, state: 'draft', reason, lines,
          meeting: {}, attachments: [], createdBy: me().id, createdAt: new Date().toISOString(), history: [] };
        db.changes = (db.changes || []).concat(c);
        addHistory(c, 'สร้างคำขอเพิ่มงบ', money(changeTotal(c)) + ' บาท', c.no);
      }
      save();
      setFlash('success', 'บันทึกคำขอเพิ่มงบ ' + c.no + ' แล้ว — เข้าที่ประชุมแล้วแนบมติและส่งให้ผู้คุมงบ');
      go('#/change/' + c.id);
    });
  }

  function viewChangeDetail(id) {
    const c = changeById(id);
    if (!c) return notFound();
    const b = budgetById(c.budgetId);
    const own = c.createdBy === me().id;
    const editable = own && ['draft', 'returned'].includes(c.state);
    const actions = [];
    if (editable) {
      actions.push('<a class="btn" href="#/change/' + c.id + '/edit">แก้ไขร่าง</a>');
      actions.push('<button type="button" class="btn bad" id="cancelChange">ยกเลิกคำขอ</button>');
    }
    let html = '<div class="page-head detail-head"><div><div class="eyebrow">คำขอเพิ่มงบ · ' + badge(b.type, TYPE_SHORT[b.type]) + ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a> ' + esc(b.name) + '</div>' +
      '<h1>' + esc(c.no) + ' ' + badge(CHANGE_STATE_BADGE[c.state], CHANGE_STATE[c.state]) + '</h1></div>' +
      (actions.length ? '<div class="head-actions">' + actions.join('') + '</div>' : '') + '</div>' + takeFlash();
    if (c.state === 'returned') html += '<div class="alert error">ผู้คุมงบส่งกลับ: ' + esc(c.returnReason || '') + '</div>';
    const rows = c.lines.map((l) => {
      const it = l.itemId === 'new' ? null : itemById(b, l.itemId);
      return '<tr><td>' + (it ? esc(it.code + ' ' + it.name) : esc((l.code || '') + ' ' + (l.name || '')) + ' <span class="badge draft">รายการใหม่</span>') + '</td>' +
        '<td class="num">' + (it ? money(itemTotal(it)) : '-') + '</td><td class="num"><strong>+' + money(l.amount) + '</strong></td></tr>';
    }).join('');
    let main = '<section class="card"><p><strong>เหตุผล:</strong> ' + esc(c.reason) + '</p>' +
      '<div class="table-wrap"><table><thead><tr><th>รายการ</th><th class="num">งบปัจจุบัน</th><th class="num">ขอเพิ่ม</th></tr></thead><tbody>' + rows +
      '</tbody><tfoot><tr><td colspan="2" class="right"><strong>รวมขอเพิ่ม</strong></td><td class="num"><strong>+' + money(changeTotal(c)) + '</strong></td></tr></tfoot></table></div></section>';
    const ap = apprOf(b.type);
    main += '<h2>' + ap.title + '</h2><section class="card">';
    if (editable) {
      main += '<form id="submitChange" data-id="' + c.id + '"><div class="form-grid">' +
        '<label class="field"><span>' + ap.date + '</span><input name="meetingDate" type="date" value="' + esc(c.meeting.date || '') + '"></label>' +
        '<label class="field"><span>' + ap.no + '</span><input name="meetingNo" value="' + esc(c.meeting.no || '') + '"></label>' +
        (ap.exec ? '<label class="field full"><span>' + ap.by + '</span><input name="meetingBy" placeholder="' + ap.byEx + '" value="' + esc(c.meeting.by || '') + '"></label>' : '') + '</div>' +
        '<div class="field"><span>' + ap.file + '</span>' + attachList(c.attachments, { del: true, empty: ap.empty }) +
        '<label class="btn small file-btn">+ แนบไฟล์<input type="file" id="changeFiles" accept="application/pdf,image/png,image/jpeg" multiple hidden></label></div>' +
        '<div class="actions"><button class="btn primary" type="submit">ส่งให้ผู้คุมงบตรวจสอบ</button></div></form>';
    } else {
      main += (c.meeting.no ? '<p>' + esc(c.meeting.no) + apprMetaText(ap, c.meeting) + '</p>' : '<p class="muted">' + ap.none + '</p>') +
        attachList(c.attachments, { empty: ap.empty });
    }
    main += '</section>';
    let side = '<div class="card total-card"><span class="muted">ขอเพิ่มงบ</span><div class="total-amount">+' + money(changeTotal(c)) + ' <small>บาท</small></div>' +
      '<dl class="kv compact"><dt>งบปัจจุบันของโครงการ</dt><dd>' + money(budgetTotal(b)) + '</dd><dt>หลังเพิ่ม</dt><dd>' + money(round2(budgetTotal(b) + changeTotal(c))) + '</dd></dl></div>';
    if (c.state === 'review' && can('budget.verify')) {
      side += '<div class="card decision"><h3 class="side-title">' + ap.verify + 'และเพิ่มงบ</h3><form id="verifyChange" data-id="' + c.id + '">' +
        '<label class="field"><span>หมายเหตุ (จำเป็นเมื่อส่งกลับ)</span><textarea name="comment" rows="3"></textarea></label>' +
        '<div class="actions"><button class="btn primary" type="submit" data-verify="approved">ยืนยันเพิ่มงบ</button><button class="btn bad" type="submit" data-verify="returned">ส่งกลับ</button></div></form></div>';
    }
    side += historyCard(c.history);
    return html + '<div class="detail-layout"><div class="detail-main">' + main + '</div><aside class="detail-side">' + side + '</aside></div>';
  }

  function bindChangeDetail() {
    const sub = document.getElementById('submitChange');
    if (sub) {
      const c = changeById(sub.dataset.id);
      const ap = apprOf((budgetById(c.budgetId) || {}).type);
      const keep = () => { c.meeting = { date: sub.elements.meetingDate.value, no: sub.elements.meetingNo.value.trim(), by: sub.elements.meetingBy ? sub.elements.meetingBy.value.trim() : '' }; };
      sub.querySelector('#changeFiles').addEventListener('change', async (e) => {
        const files = await readFiles(e.target, 'resolution');
        if (!files.length) return;
        keep();
        c.attachments = (c.attachments || []).concat(files);
        addHistory(c, ap.exec ? 'แนบไฟล์เอกสารอนุมัติ' : 'แนบไฟล์มติ', files.map((f) => f.name).join(', '), c.no);
        if (save()) go('#/change/' + c.id);
      });
      sub.addEventListener('click', (e) => {
        const del = e.target.closest('[data-att-del]');
        if (!del) return;
        keep();
        c.attachments = c.attachments.filter((x) => x.id !== del.dataset.attDel);
        save();
        go('#/change/' + c.id);
      });
      sub.addEventListener('submit', (e) => {
        e.preventDefault();
        keep();
        if (!c.meeting.no || !c.attachments.length || (ap.exec && !c.meeting.by)) {
          alert('กรุณาระบุ' + ap.no + (ap.exec ? ' ' + ap.by : '') + 'และแนบ' + ap.file); return;
        }
        c.state = 'review';
        addHistory(c, ap.exec ? 'แนบเอกสารอนุมัติผู้บริหารและส่งให้ผู้คุมงบตรวจสอบ' : 'แนบมติที่ประชุมและส่งให้ผู้คุมงบตรวจสอบ', c.meeting.no, c.no);
        save();
        setFlash('success', 'ส่งคำขอเพิ่มงบ ' + c.no + ' ให้ผู้คุมงบแล้ว');
        go('#/change/' + c.id);
      });
    }
    const cancel = document.getElementById('cancelChange');
    if (cancel) {
      cancel.addEventListener('click', () => {
        const c = changeById(location.hash.split('/')[2]);
        if (!confirm('ยกเลิกคำขอเพิ่มงบ ' + c.no + ' ?')) return;
        c.state = 'cancelled';
        addHistory(c, 'ยกเลิกคำขอเพิ่มงบ', '', c.no);
        save();
        go('#/change/' + c.id);
      });
    }
    const ver = document.getElementById('verifyChange');
    if (ver) {
      let decision = 'approved';
      ver.querySelectorAll('[data-verify]').forEach((btn) => btn.addEventListener('click', () => { decision = btn.dataset.verify; }));
      ver.addEventListener('submit', (e) => {
        e.preventDefault();
        const c = changeById(ver.dataset.id);
        const b = budgetById(c.budgetId);
        const comment = ver.elements.comment.value.trim();
        if (decision === 'returned') {
          if (!comment) { alert('กรุณาระบุเหตุผลที่ส่งกลับ'); return; }
          Object.assign(c, { state: 'returned', returnReason: comment });
          addHistory(c, 'ส่งกลับให้แก้ไข', comment, c.no);
        } else {
          c.lines.forEach((l) => {
            if (l.itemId === 'new') {
              const it = { id: nextId('i'), code: l.code, name: l.name, amount: l.amount, vat: 0, qty: '', unit: '', glCode: '', glName: '', investor: l.investor || b.company };
              if (b.type === 'CAPEX') Object.assign(it, { assetType: assetTypeList()[0], doa: '2.5' });
              b.items.push(it);
              l.itemId = it.id;
            } else {
              adjustItem(itemById(b, l.itemId), l.amount);
            }
          });
          addRevision(b, 'เพิ่มงบตามคำขอ ' + c.no + ' (' + (c.meeting.no || '') + ')' + (comment ? ' — ' + comment : ''));
          addHistory(b, 'เพิ่มงบตามคำขอ ' + c.no, '+' + money(changeTotal(c)) + ' บาท', 'งบ ' + b.code);
          Object.assign(c, { state: 'approved', approvedAt: new Date().toISOString(), approvedBy: me().id });
          addHistory(c, 'ยืนยันเพิ่มงบ', comment, c.no);
        }
        save();
        setFlash(decision === 'approved' ? 'success' : 'info', decision === 'approved' ? 'เพิ่มงบ ' + b.code + ' +' + money(changeTotal(c)) + ' บาทแล้ว' : 'ส่งคำขอ ' + c.no + ' กลับแล้ว');
        go('#/change/' + c.id);
      });
    }
  }

  // ---------------------------------------------------------------- ผู้คุมงบ: โยก / ลดงบ

  function itemSelectOptions(selected) {
    return db.budgets.filter(isActive).map((b) => '<optgroup label="' + esc(b.code + ' ' + b.name) + '">' +
      ledgerItems(b).map((i) => {
        const v = b.id + '|' + i.id;
        return opt(v, (b.structure === 'project' ? 'งบรวมทั้งโครงการ' : i.code + ' ' + i.name) + ' — คงเหลือ ' + money(usage(b, i.id).remaining), selected);
      }).join('') + '</optgroup>').join('');
  }

  function viewAdjust(params) {
    if (!can('budget.adjust')) return '<div class="alert error">ไม่มีสิทธิ์โยก/ลดงบ</div>';
    const to = params.get('to') ? params.get('to') + '|' + (params.get('item') || '') : '';
    const from = params.get('budget') ? params.get('budget') + '|' + ((ledgerItems(budgetById(params.get('budget')) || { items: [], type: 'CAPEX' })[0] || {}).id || '') : '';
    const ctx = budgetById(params.get('budget') || params.get('to'));
    const recent = (db.log || []).filter((x) => /^(โยกงบ|ลดงบ)/.test(x.action) && (!ctx || x.ref.split(' → ').includes(ctx.code))).slice(-10).reverse();
    return '<div class="page-head"><div><h1>โยก / ลดงบ' + (ctx ? ' · ' + esc(ctx.code) : '') + '</h1><div class="page-sub">' + (ctx ? esc(ctx.name) + ' — ' : '') +
      'โยกข้ามรายการหรือข้ามโครงการได้ตามดุลพินิจของผู้คุมงบ ทุกครั้งต้องระบุเหตุผลและเก็บเป็นประวัติการปรับงบ</div></div></div>' + takeFlash() +
      '<div id="formError"></div><div class="form-main">' +
      '<section class="card form-section"><div class="section-head"><h2 class="section-title"><span class="step">1</span>โยกงบ</h2></div>' +
      '<form id="moveForm" class="form-grid"><label class="field"><span>โยกจาก</span><div class="select-wrap"><select name="from" required><option value="">— เลือก —</option>' + itemSelectOptions(from) + '</select></div></label>' +
      '<label class="field"><span>ไปยัง</span><div class="select-wrap"><select name="to" required><option value="">— เลือก —</option>' + itemSelectOptions(to) + '</select></div></label>' +
      '<label class="field"><span>จำนวนเงิน (รวม VAT)</span><input name="amount" type="number" min="0.01" step="0.01" class="right" required value="' + esc(params.get('amount') || '') + '"></label>' +
      '<label class="field"><span>เหตุผล</span><input name="reason" required></label>' +
      '<div class="field full"><button class="btn primary" type="submit">โยกงบ</button></div></form></section>' +
      '<section class="card form-section"><div class="section-head"><h2 class="section-title"><span class="step">2</span>ลดงบ</h2></div>' +
      '<p class="muted small-note">เช่น ซื้อได้ถูกกว่างบ โครงการยกเลิก/เลื่อน หรือผู้บริหารสั่งตัดงบ — ลดได้ไม่เกินยอดคงเหลือ (ยอดที่ใช้/จองแล้วลดไม่ได้)</p>' +
      '<form id="cutBudgetForm" class="form-grid"><label class="field"><span>รายการ</span><div class="select-wrap"><select name="target" required><option value="">— เลือก —</option>' + itemSelectOptions(from) + '</select></div></label>' +
      '<label class="field"><span>ลดลง (รวม VAT)</span><input name="amount" type="number" min="0.01" step="0.01" class="right" required></label>' +
      '<label class="field full"><span>เหตุผล</span><input name="reason" required></label>' +
      '<div class="field full"><button class="btn bad" type="submit">ลดงบ</button></div></form></section>' +
      '<section class="card form-section"><div class="section-head"><h2 class="section-title">การโยก / ลดงบล่าสุด' + (ctx ? ' ของงบนี้' : '') + '</h2></div>' +
      (recent.length ? '<div class="table-wrap"><table><thead><tr><th>เมื่อ</th><th>รายการ</th><th>รายละเอียด</th><th>โดย</th></tr></thead><tbody>' +
        recent.map((x) => '<tr><td class="nowrap">' + fmtDate(x.at) + '</td><td>' + esc(x.action) + '</td><td>' + esc(x.detail) + '</td><td class="nowrap">' + esc(userName(x.by)) + '</td></tr>').join('') +
        '</tbody></table></div>' : '<p class="muted">ยังไม่มี</p>') + '</section></div>';
  }

  function bindAdjust() {
    const mv = document.getElementById('moveForm');
    if (!mv) return;
    const pick = (v) => { const [bid, iid] = v.split('|'); const b = budgetById(bid); return { b, it: b && itemById(b, iid) }; };
    const label = (x) => x.b.code + (x.b.structure === 'project' ? '' : ' / ' + x.it.code);
    mv.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = mv.elements;
      const src = pick(f.from.value);
      const dst = pick(f.to.value);
      const amount = round2(f.amount.value);
      const reason = f.reason.value.trim();
      const errors = [];
      if (!src.it || !dst.it) errors.push('กรุณาเลือกรายการต้นทางและปลายทาง');
      else if (src.it === dst.it) errors.push('ต้นทางและปลายทางต้องไม่ใช่รายการเดียวกัน');
      else if (round2(itemTotal(src.it) - amount) < allocatedOf(src.b, src.it) - 0.005) errors.push('โยกออกแล้วต่ำกว่าวงเงินที่จัดสรรให้ Item ย่อย (' + money(allocatedOf(src.b, src.it)) + ' บาท)');
      else if (amount > usage(src.b, src.it.id).remaining + 0.005) errors.push('ต้นทางมีคงเหลือไม่พอ (คงเหลือ ' + money(usage(src.b, src.it.id).remaining) + ' บาท)');
      if (!(amount > 0)) errors.push('จำนวนเงินต้องมากกว่า 0');
      if (!reason) errors.push('กรุณาระบุเหตุผล');
      if (errors.length) { showErrors(errors); return; }
      adjustItem(src.it, -amount);
      adjustItem(dst.it, amount);
      const no = nextNo(DOC_PREFIX.trf);
      const detail = no + ' · ' + money(amount) + ' บาท จาก ' + label(src) + ' ไป ' + label(dst) + ' — ' + reason;
      addRevision(src.b, 'โยกออก ' + money(amount) + ' ไป ' + label(dst) + ' — ' + reason);
      if (dst.b !== src.b) addRevision(dst.b, 'โยกเข้า ' + money(amount) + ' จาก ' + label(src) + ' — ' + reason);
      else src.b.revisions[src.b.revisions.length - 1].note = 'โยกภายในโครงการ ' + detail;
      src.b.history.push({ at: new Date().toISOString(), by: me().id, action: 'โยกงบออก', note: detail, ref: no });
      if (dst.b !== src.b) dst.b.history.push({ at: new Date().toISOString(), by: me().id, action: 'รับงบที่โยกเข้า', note: detail, ref: no });
      logAction('โยกงบ', 'งบ ' + src.b.code, detail + (dst.b !== src.b ? ' (เข้างบ ' + dst.b.code + ')' : ''));
      save();
      setFlash('success', 'โยกงบ ' + detail);
      go('#/budget/' + (location.hash.indexOf('to=') >= 0 ? dst.b.id : src.b.id));
    });
    const cb = document.getElementById('cutBudgetForm');
    cb.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = cb.elements;
      const t = pick(f.target.value);
      const amount = round2(f.amount.value);
      const reason = f.reason.value.trim();
      const errors = [];
      if (!t.it) errors.push('กรุณาเลือกรายการ');
      else if (round2(itemTotal(t.it) - amount) < allocatedOf(t.b, t.it) - 0.005) errors.push('ลดแล้วต่ำกว่าวงเงินที่จัดสรรให้ Item ย่อย (' + money(allocatedOf(t.b, t.it)) + ' บาท)');
      else if (amount > usage(t.b, t.it.id).remaining + 0.005) errors.push('ลดได้ไม่เกินยอดคงเหลือ ' + money(usage(t.b, t.it.id).remaining) + ' บาท');
      if (!(amount > 0)) errors.push('จำนวนเงินต้องมากกว่า 0');
      if (!reason) errors.push('กรุณาระบุเหตุผล');
      if (errors.length) { showErrors(errors); return; }
      adjustItem(t.it, -amount);
      const no = nextNo(DOC_PREFIX.dec);
      const detail = no + ' · ' + money(amount) + ' บาท ที่ ' + label(t) + ' — ' + reason;
      addRevision(t.b, 'ลดงบ ' + detail);
      t.b.history.push({ at: new Date().toISOString(), by: me().id, action: 'ลดงบ', note: detail, ref: no });
      logAction('ลดงบ', 'งบ ' + t.b.code, detail);
      save();
      setFlash('success', 'ลดงบ ' + detail);
      go('#/budget/' + t.b.id);
    });
  }

  // ---------------------------------------------------------------- คิวงาน / Log / สิ่งที่รอยืนยัน

  function budgetQueueTable(list) {
    if (!list.length) return '<div class="card empty">ไม่มีรายการ</div>';
    return '<div class="table-wrap"><table><thead><tr><th>งบ</th><th>Business</th><th>มติ / เอกสารอนุมัติ</th><th class="num">วงเงิน</th><th>ส่งเมื่อ</th></tr></thead><tbody>' +
      list.map((b) => '<tr><td>' + badge(b.type, TYPE_SHORT[b.type]) + ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a><div class="muted">' + esc(b.name) + '</div></td>' +
        '<td class="nowrap">' + esc(userName(b.ownerId)) + '</td><td>' + esc((b.meeting && b.meeting.no) || '-') + '<div class="muted">' + (b.attachments || []).length + ' ไฟล์</div></td>' +
        '<td class="num">' + money(budgetTotal(b)) + '</td><td class="nowrap">' + fmtDay(b.submittedAt || (b.history.slice(-1)[0] || {}).at) + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function changeQueueTable(list) {
    if (!list.length) return '<div class="card empty">ไม่มีรายการ</div>';
    return '<div class="table-wrap"><table><thead><tr><th>เลขที่</th><th>งบ</th><th>เหตุผล</th><th class="num">ขอเพิ่ม</th><th>สถานะ</th></tr></thead><tbody>' +
      list.map((c) => { const b = budgetById(c.budgetId); return '<tr><td class="nowrap"><a href="#/change/' + c.id + '">' + esc(c.no) + '</a></td><td>' + esc(b.code) + '<div class="muted">' + esc(b.name) + '</div></td>' +
        '<td>' + esc(c.reason) + '</td><td class="num">+' + money(changeTotal(c)) + '</td><td>' + badge(CHANGE_STATE_BADGE[c.state], CHANGE_STATE[c.state]) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  function nextCutStep(r) {
    if (r.useType === 'prpo') return 'ยืนยันยอด PO และปิดยอด';
    if (r.useType === 'advance') return r.advance ? 'เคลียร์เงินทดรอง' : 'จ่ายเงินทดรอง';
    if (r.useType === 'reimburse') return 'จ่ายคืนพนักงาน';
    return cutTotal(r) > 0 ? 'บันทึกจ่ายงวดถัดไป / ปิดยอด' : 'บันทึกการจ่ายเงิน';
  }
  function cutQueueTable(list, withStep) {
    if (!list.length) return '<div class="card empty">ไม่มีรายการค้าง</div>';
    return '<div class="table-wrap"><table><thead><tr><th>เลขที่</th><th>งบ</th><th>ประเภท</th><th>ผู้ขอ</th><th class="num">ขอไว้</th><th class="num">ตัดงบแล้ว</th>' + (withStep ? '<th>ขั้นถัดไป</th>' : '') + '</tr></thead><tbody>' +
      list.map((r) => { const b = budgetById(r.budgetId); return '<tr><td class="nowrap"><a href="#/request/' + r.id + '">' + esc(r.docNo) + '</a><div class="muted">' + fmtDay(r.approvedAt) + '</div></td>' +
        '<td>' + esc(b.code) + '<div class="muted">' + esc(reqSummary(r)) + '</div></td><td class="nowrap">' + esc(USE_TYPES[r.useType].short) + '</td><td class="nowrap">' + esc(userName(r.requesterId)) + '</td>' +
        '<td class="num">' + money(r.amount) + '</td><td class="num">' + money(cutTotal(r)) + '</td>' + (withStep ? '<td>' + esc(nextCutStep(r)) + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  // ---------------------------------------------------------------- งานทั้งหมด (รวมทุกคิวงานในหน้าเดียว แยกเป็นแท็บ)

  /** ผู้ใช้ที่ทำรายการในระบบ (Business / ผู้คุมงบ / จัดซื้อ) — Admin อย่างเดียวไม่มีงานและประวัติการทำรายการ */
  const WORK_PERMS = ['budget.create', 'request.create', 'budget.verify', 'budget.adjust', 'budget.manage', 'request.decide', 'cut.record', 'po.record'];
  const isWorker = (u) => permsOf(u).some((p) => WORK_PERMS.includes(p));

  function myBudgetTable(list) {
    if (!list.length) return '<div class="card empty">ไม่มีรายการ</div>';
    return '<div class="table-wrap"><table><thead><tr><th>งบ</th><th>สถานะ</th><th class="num">วงเงิน</th><th>อัปเดตล่าสุด</th></tr></thead><tbody>' +
      list.map((b) => {
        const last = b.history.slice(-1)[0] || {};
        return '<tr><td>' + badge(b.type, TYPE_SHORT[b.type]) + ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a><div class="muted">' + esc(b.name) + '</div></td>' +
          '<td>' + badge(BUDGET_STATE_BADGE[b.state], BUDGET_STATE[b.state]) + (b.state === 'returned' && b.returnReason ? '<div class="muted">' + esc(b.returnReason) + '</div>' : '') + '</td>' +
          '<td class="num">' + money(budgetTotal(b)) + '</td><td class="nowrap">' + fmtDay(last.at) + '<div class="muted">' + esc(last.action || '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /**
   * แท็บของหน้า "งานทั้งหมด" ตามสิทธิ์
   * act = งานที่ผู้ใช้ต้องลงมือ (นับรวมเป็นตัวเลขที่เมนู) · ไม่ act = รายการติดตามสถานะ
   */
  function taskTabs(u) {
    const has = (p) => permsOf(u).includes(p);
    const tabs = [];
    const add = (key, label, act, hint, sections) => tabs.push({ key, label, act, hint, sections, n: sections.reduce((n, x) => n + x.list.length, 0) });
    const sec = (title, list, table) => ({ title, list, table });

    if (has('budget.verify')) {
      add('budgets', 'งบรอเปิดใช้', true, 'ตรวจมติที่ประชุม (CAPEX) / เอกสารอนุมัติผู้บริหาร (OPEX) ว่าตรงกับวงเงินและรายการ แล้วยืนยันเปิดใช้ หรือส่งกลับให้ Business แก้ไข',
        [sec('', db.budgets.filter((b) => b.state === 'review'), budgetQueueTable)]);
      add('changes', 'คำขอเพิ่มงบ', true, 'ตรวจมติ / เอกสารอนุมัติผู้บริหารแล้วยืนยันเพิ่มงบ หรือส่งกลับ',
        [sec('', (db.changes || []).filter((c) => c.state === 'review'), changeQueueTable)]);
    }
    if (has('request.decide')) {
      add('requests', 'คำขอดำเนินการใช้งบ', true, 'ตรวจคำขอแล้วอนุมัติออกใบดำเนินการใช้งบ หรือส่งกลับ — ขอเกินงบรายการต้องใส่ Note',
        [sec('', inbox(u), (l) => requestTable(l, true))]);
    }
    if (has('po.record')) {
      add('po', 'รอออก PO', true, 'ใบดำเนินการใช้งบประเภท PR/PO ที่ผู้คุมงบอนุมัติแล้ว — บันทึกเลข PR/PO และยอด PO เพื่อตัดงบ',
        [sec('', db.requests.filter(needsPO), (l) => cutQueueTable(l, false))]);
      add('po-done', 'บันทึก PO แล้ว', false, 'ผู้คุมงบยืนยันยอดและปิดยอดเมื่อรับของ / จ่ายครบ',
        [sec('', db.requests.filter((r) => r.useType === 'prpo' && hasPO(r) && r.status === 'approved'), (l) => cutQueueTable(l, false))]);
    }
    if (has('cut.record')) {
      add('cuts', 'รอตัดงบ / ปิดยอด', true, 'ใบดำเนินการใช้งบที่ออกแล้วแต่ยังไม่ปิดยอด (ไม่รวม PR/PO ที่รอจัดซื้อออก PO)',
        [sec('', db.requests.filter(needsCut), (l) => cutQueueTable(l, true))]);
    }
    if (has('budget.create') || has('request.create')) {
      const mineB = db.budgets.filter((b) => b.ownerId === u.id);
      const mineR = db.requests.filter((r) => r.requesterId === u.id);
      const mineC = (db.changes || []).filter((c) => c.createdBy === u.id);
      add('fix', 'ส่งกลับแก้ไข', true, 'ผู้คุมงบส่งกลับพร้อมเหตุผล — แก้ไขแล้วส่งใหม่ หรือยกเลิก', [
        sec('งบ', mineB.filter((b) => b.state === 'returned'), myBudgetTable),
        sec('คำขอดำเนินการใช้งบ', mineR.filter((r) => r.status === 'rejected'), (l) => requestTable(l, true)),
        sec('คำขอเพิ่มงบ', mineC.filter((c) => c.state === 'returned'), changeQueueTable)]);
      add('memo', 'รอแนบ Memo', true, 'พิมพ์ Memo ให้ผู้บริหารเซ็น แล้วแนบไฟล์ที่เซ็นแล้วในหน้าคำขอ เพื่อส่งให้ผู้คุมงบตรวจสอบ',
        [sec('', mineR.filter((r) => r.status === 'memo'), (l) => requestTable(l, true))]);
      add('drafts', 'ร่าง', false, 'ร่างที่ยังไม่ได้ส่ง — แนบมติที่ประชุม (CAPEX) หรือเอกสารอนุมัติผู้บริหาร (OPEX) แล้วส่งให้ผู้คุมงบ (ร่างค้างไว้ได้ไม่จำกัดเวลา)', [
        sec('งบ', mineB.filter((b) => b.state === 'draft'), myBudgetTable),
        sec('คำขอเพิ่มงบ', mineC.filter((c) => c.state === 'draft'), changeQueueTable)]);
      add('waiting', 'รอผู้คุมงบ', false, 'ส่งแล้ว รอผู้คุมงบตรวจสอบ', [
        sec('งบ', mineB.filter((b) => b.state === 'review'), myBudgetTable),
        sec('คำขอดำเนินการใช้งบ', mineR.filter((r) => r.status === 'pending'), (l) => requestTable(l, true)),
        sec('คำขอเพิ่มงบ', mineC.filter((c) => c.state === 'review'), changeQueueTable)]);
      add('open', 'รอปิดยอด', false, 'ออกใบดำเนินการใช้งบแล้ว รอออก PO / จ่ายเงิน / เคลียร์ และปิดยอด',
        [sec('', mineR.filter((r) => r.status === 'approved'), (l) => requestTable(l, true))]);
    }
    return tabs;
  }

  /** เส้นทางเดิม (#/approvals, #/po ฯลฯ) → แท็บในหน้างานทั้งหมด */
  const OLD_TASK_ROUTES = { approvals: 'requests', po: 'po', cuts: 'cuts', payments: 'cuts', accounting: 'cuts' };

  function viewTasks(params, oldRoute) {
    const tabs = taskTabs(me());
    if (!tabs.length) return '<div class="alert info">บทบาทนี้ไม่มีงานที่ต้องทำ</div>';
    let key = params.get('tab') || OLD_TASK_ROUTES[oldRoute];
    if (oldRoute === 'approvals' && !tabs.some((t) => t.key === 'requests' && t.n)) key = (tabs.find((t) => t.n) || tabs[0]).key;
    const tab = tabs.find((t) => t.key === key) || tabs.find((t) => t.act && t.n) || tabs.find((t) => t.n) || tabs[0];
    const nav = '<nav class="tabs task-tabs" aria-label="ประเภทงาน">' + tabs.map((t) => '<a href="#/tasks?tab=' + t.key + '"' + (t === tab ? ' class="active" aria-current="page"' : '') + '>' +
      esc(t.label) + '<span class="tab-badge' + (t.act && t.n ? ' act' : '') + '">' + t.n + '</span></a>').join('') + '</nav>';
    const multi = tab.sections.length > 1;
    const body = tab.sections.map((x) => (multi ? '<h2>' + x.title + ' <span class="muted count-note">(' + x.list.length + ')</span></h2>' : '') + x.table(x.list)).join('');
    return '<div class="page-head"><div><h1>งานทั้งหมด</h1><div class="page-sub">' + esc(roleLabel(me())) + '</div></div></div>' + takeFlash() + nav +
      '<p class="muted tab-hint">' + esc(tab.hint) + '</p>' + body;
  }

  // ---------------------------------------------------------------- ประวัติการทำรายการ (ผู้ใช้ทั่วไป)

  /** ลิงก์ไปยังเรื่องของรายการใน Log (ref = "งบ CODE" / เลขที่คำขอ / เลขที่เอกสาร / INC-…) */
  function refLink(ref) {
    if (!ref) return { href: '', mine: false };
    const u = me();
    if (ref.startsWith('งบ ')) {
      const b = db.budgets.find((x) => x.code === ref.slice(3));
      return { href: b ? '#/budget/' + b.id : '', owner: b && b.ownerId };
    }
    const r = db.requests.find((x) => x.no === ref || x.docNo === ref);
    if (r) return { href: '#/request/' + r.id, owner: r.requesterId };
    const c = (db.changes || []).find((x) => x.no === ref);
    if (c) return { href: '#/change/' + c.id, owner: c.createdBy };
    const codes = ref.split(' → ').map((code) => db.budgets.find((x) => x.code === code)).filter(Boolean);
    if (codes.length) return { href: '#/budget/' + codes[0].id, owner: codes.some((b) => b.ownerId === u.id) ? u.id : codes[0].ownerId };
    return { href: '', owner: null };
  }

  function viewHistory(params) {
    const u = me();
    if (!isWorker(u)) return '<div class="alert error">หน้านี้สำหรับผู้ใช้ที่ทำรายการในระบบ</div>';
    const scope = params.get('scope') === 'mine' ? 'mine' : 'all';
    const q = (params.get('q') || '').toLowerCase();
    const rows = (db.log || []).map((x) => Object.assign({ link: refLink(x.ref) }, x))
      .filter((x) => x.by === u.id || x.link.owner === u.id);
    const list = rows.filter((x) => (scope === 'all' || x.by === u.id) && (!q || (x.action + ' ' + x.ref + ' ' + x.detail).toLowerCase().includes(q))).reverse();
    const t = (key, label, n) => '<a href="#/history' + (key === 'mine' ? '?scope=mine' : '') + '"' + (scope === key ? ' class="active" aria-current="page"' : '') + '>' + label + '<span class="tab-badge">' + n + '</span></a>';
    return '<div class="page-head"><div><h1>ประวัติการทำรายการ</h1><div class="page-sub">รายการที่คุณทำ และสิ่งที่ผู้อื่นทำกับงบ / เอกสารของคุณ</div></div></div>' +
      '<nav class="tabs task-tabs" aria-label="ขอบเขต">' + t('all', 'ทั้งหมด', rows.length) + t('mine', 'ที่ฉันทำ', rows.filter((x) => x.by === u.id).length) + '</nav>' +
      '<form id="historyFilter" class="admin-filters" data-scope="' + scope + '"><label class="input-wrap search">' + ICON_SEARCH +
      '<input name="q" type="search" placeholder="ค้นหาการกระทำ เลขที่ รายละเอียด" value="' + esc(params.get('q') || '') + '"></label><button class="btn" type="submit">ค้นหา</button></form>' +
      '<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เรื่อง</th><th>รายละเอียด</th></tr></thead><tbody>' +
      (list.length ? list.slice(0, 300).map((x) => '<tr><td class="nowrap">' + fmtDate(x.at) + '</td><td class="nowrap">' + (x.by === u.id ? '<strong>คุณ</strong>' : esc(userName(x.by))) + '</td>' +
        '<td>' + esc(x.action) + '</td><td class="nowrap">' + (x.link.href ? '<a href="' + x.link.href + '">' + esc(x.ref) + '</a>' : esc(x.ref)) + '</td><td>' + esc(x.detail) + '</td></tr>').join('')
        : '<tr><td colspan="5" class="muted">ไม่พบรายการ</td></tr>') + '</tbody></table></div>';
  }
  function bindHistory() {
    const f = document.getElementById('historyFilter');
    if (!f) return;
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      go('#/history?' + (f.dataset.scope === 'mine' ? 'scope=mine&' : '') + 'q=' + encodeURIComponent(f.elements.q.value.trim()));
    });
  }

  // ---------------------------------------------------------------- ผู้ใช้และสิทธิ์ (โหมดทดลอง: ดูอย่างเดียว)

  function viewAdminDemo() {
    const roles = Object.keys(DEMO_ROLE_PERMS);
    const users = '<div class="table-wrap"><table><thead><tr><th>ชื่อ</th><th>ตำแหน่ง</th><th>บทบาท</th></tr></thead><tbody>' +
      USERS.map((x) => '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.title) + '</td><td>' + esc(roleLabel(x)) + '</td></tr>').join('') + '</tbody></table></div>';
    let group = '';
    const matrix = '<div class="table-wrap"><table class="perm-matrix"><thead><tr><th>สิทธิ์</th>' + roles.map((r) => '<th class="center">' + esc(ROLE_LABEL[r]) + '</th>').join('') + '</tr></thead><tbody>' +
      PERMISSIONS.map((pm) => {
        const head = pm.group !== group ? '<tr class="perm-group"><td colspan="' + (roles.length + 1) + '">' + esc(pm.group) + '</td></tr>' : '';
        group = pm.group;
        return head + '<tr><td>' + esc(pm.label) + (pm.hint ? '<div class="muted">' + esc(pm.hint) + '</div>' : '') + '</td>' +
          roles.map((r) => '<td class="center">' + (DEMO_ROLE_PERMS[r].includes(pm.key) ? '<span class="pos" aria-label="มีสิทธิ์">✓</span>' : '<span class="muted" aria-label="ไม่มีสิทธิ์">–</span>') + '</td>').join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    return '<div class="page-head"><div><h1>ผู้ใช้และสิทธิ์</h1><div class="page-sub">โหมดทดลองดูได้อย่างเดียว — ระบบจริง Admin เพิ่มผู้ใช้ กำหนดบทบาท และแก้สิทธิ์ของแต่ละบทบาทได้</div></div></div>' +
      '<section class="card form-section"><div class="section-head"><h2 class="section-title">ผู้ใช้</h2></div>' + users + '</section>' +
      '<section class="card form-section"><div class="section-head"><h2 class="section-title">บทบาทและสิทธิ์</h2></div>' + matrix + '</section>';
  }

  function viewLog(params) {
    if (!can('log.view')) return '<div class="alert error">ไม่มีสิทธิ์ดู Log</div>';
    const q = (params.get('q') || '').toLowerCase();
    const who = params.get('by') || '';
    const list = (db.log || []).slice().reverse().filter((x) => (!who || x.by === who) &&
      (!q || (x.action + ' ' + x.ref + ' ' + x.detail).toLowerCase().includes(q)));
    return '<div class="page-head"><div><h1>Log การทำงาน</h1><div class="page-sub">บันทึกทุกการกระทำในระบบ เพิ่มได้อย่างเดียว แก้หรือลบไม่ได้</div></div></div>' +
      '<form id="logFilter" class="admin-filters"><label class="input-wrap search">' + ICON_SEARCH + '<input name="q" type="search" placeholder="ค้นหาการกระทำ เลขที่ รายละเอียด" value="' + esc(params.get('q') || '') + '"></label>' +
      '<div class="select-wrap"><select name="by">' + opt('', 'ผู้ใช้: ทั้งหมด', who) + USERS.map((x) => opt(x.id, 'ผู้ใช้: ' + x.name, who)).join('') + '</select></div><button class="btn" type="submit">กรอง</button></form>' +
      '<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>การกระทำ</th><th>เรื่อง</th><th>รายละเอียด</th></tr></thead><tbody>' +
      (list.length ? list.slice(0, 300).map((x) => '<tr><td class="nowrap">' + fmtDate(x.at) + '</td><td class="nowrap">' + esc(userName(x.by)) + '</td><td>' + esc(x.action) + '</td><td class="nowrap">' + esc(x.ref) + '</td><td>' + esc(x.detail) + '</td></tr>').join('')
        : '<tr><td colspan="5" class="muted">ไม่พบรายการ</td></tr>') + '</tbody></table></div>';
  }
  function bindLog() {
    const f = document.getElementById('logFilter');
    if (!f) return;
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      go('#/log?q=' + encodeURIComponent(f.elements.q.value.trim()) + '&by=' + encodeURIComponent(f.elements.by.value));
    });
  }

  /** สมมติฐานที่ใช้ในต้นแบบรอบนี้ — รอทีมผู้ใช้ยืนยัน */
  function viewAssumptions() {
    const rows = [
      ['ระบบ', 'Admin ทำอะไรได้', 'ดูแลข้อมูลหลัก ดู Log ทั้งระบบ และจัดการผู้ใช้/สิทธิ์ · ดูงบได้ทั้งหมดแต่ไม่ทำรายการ'],
      ['ระบบ', 'ผู้ใช้ทั่วไปเห็นประวัติแค่ไหน', 'เห็น "ประวัติการทำรายการ" ที่ตนทำ และที่ผู้อื่นทำกับงบ/เอกสารของตน (ไม่เห็น Log ทั้งระบบ)'],
      ['ตั้งงบ', 'ใครกำหนดรหัสโครงการ/รหัสรายการย่อย', 'Business กรอกเองตอนร่าง'],
      ['ตั้งงบ', 'แบบฟอร์มขออนุมัติงบเข้าที่ประชุม', 'ใช้แบบฟอร์มชั่วคราว (รอแบบฟอร์มจริง)'],
      ['ตั้งงบ', 'หลักฐานที่ต้องแนบ', 'ไฟล์มติที่ประชุมอย่างน้อย 1 ไฟล์ + เลขที่มติ'],
      ['ปรับงบ', 'ผู้คุมงบลดงบได้ไหม', 'ได้ ต้องใส่เหตุผล ลดไม่ได้เกินยอดคงเหลือ'],
      ['ปรับงบ', 'ผู้บริหารสั่งตัดงบต้องแนบเอกสารไหม', 'ยังไม่บังคับแนบ (ใส่เหตุผลอย่างเดียว)'],
      ['ปรับงบ', 'ปิดปีงบ: งบเหลือหมดสิทธิ์หรือยกไป', 'ยังไม่ได้ทำ — งบปีก่อนยังใช้ต่อได้เหมือนเดิม'],
      ['ปรับงบ', 'มีงบกลาง/งบสำรองไหม', 'ไม่มี — โยกตรงจากรายการ/โครงการหนึ่งไปอีกที่'],
      ['ปรับงบ', 'โยก/ลดงบแล้วแจ้งเจ้าของงบไหม', 'บันทึกในประวัติของงบทั้งสองฝั่ง (ยังไม่มีแจ้งเตือน)'],
      ['ระบบ', 'ส่งออกข้อมูล (Excel)', 'เมนู "ส่งออกข้อมูล (Excel)" สำหรับผู้คุมงบและ Admin (สิทธิ์ data.export) · กรองปีงบ / บริษัท / ประเภทงบ · แผ่นงาน: งบประมาณ, Item, ดำเนินการใช้งบ, รายการในใบ, ตัดงบ-จ่ายเงิน, ปรับงบ (INC/TRF/DEC), Plan Cashflow · ตัวเลขเป็นตัวเลขจริงใน Excel (รวม/กรองได้) · รอยืนยันกับฝ่ายบัญชีว่าต้องการคอลัมน์ / รูปแบบเพิ่มเติม (เช่น รูปแบบนำเข้าระบบบัญชี)'],
      ['CAPEX', 'Plan Cashflow', 'หลังงบอนุมัติ (เปิดใช้แล้ว) Business เจ้าของงบหรือผู้คุมงบ ประมาณการว่าแต่ละ Item จะใช้เงินเดือนไหนเท่าไร (รวม VAT) ตามเดือนของปีงบประมาณ · รวมของแต่ละ Item ต้องไม่เกินวงเงิน Item · ไม่บังคับก่อนขอใช้งบ (แจ้งเตือนในหน้างบ) · แสดงเทียบกับยอดตัดงบจริงรายเดือน · แก้ได้ตลอด เก็บประวัติ'],
      ['ใช้งบ', 'ใบดำเนินการใช้งบ 1 ใบใช้ได้หลาย Item ไหม', 'ได้ ทั้ง CAPEX และ OPEX — เลือก Item ทีละบรรทัด · ตรวจเกินงบทีละ Item และทั้งโครงการ · ตัดงบแบ่งตามสัดส่วนยอดของแต่ละ Item · DOA ของ CAPEX อ้างอิงหมวดของ Item ที่ขอใช้ยอดมากที่สุดในใบ'],
      ['ใช้งบ', 'ขอเกินงบรายการย่อยแต่ไม่เกินงบโครงการ', 'ขอได้ ระบบเตือน ผู้คุมงบต้องใส่ Note'],
      ['ใช้งบ', 'ขอเกินงบโครงการ', 'อนุมัติไม่ได้จนกว่าผู้คุมงบโยกงบเข้า หรือส่งกลับให้ขอเพิ่มงบ'],
      ['ใช้งบ', 'ผู้ขอต้องใส่เหตุผลที่ขอเกินไหม', 'ไม่บังคับ (มีช่องให้ใส่)'],
      ['ใช้งบ', 'Note ผู้อนุมัติแสดงบนใบที่พิมพ์ไหม', 'แสดง'],
      ['ใช้งบ', 'ยอดจริงมากกว่าที่ขอได้ไหม', 'ได้ ต้องใส่หมายเหตุ (ยังไม่ต้องอนุมัติซ้ำ)'],
      ['ใช้งบ', 'คืนส่วนต่างเมื่อไร', 'เมื่อปิดยอด (Advance/สำรองจ่ายปิดอัตโนมัติเมื่อบันทึกใบเสร็จ)'],
      ['ใช้งบ', 'ผู้ขอยกเลิกใบ CAPEX ที่ออกแล้วได้ไหม', 'ไม่ได้ (ยกเลิกได้เฉพาะตอนรอตรวจ/ถูกส่งกลับ)'],
      ['ใช้งบ', 'จ่ายหลายงวด', 'ใช้ได้กับ PR/PO และจ่ายตรง — บันทึกจ่ายหลายครั้งแล้วปิดยอด'],
      ['ใช้งบ', 'เงื่อนไขการทำ Memo', 'ทำ Memo เฉพาะงบ CAPEX ที่ใช้เงินข้ามบริษัทกับ PCC: งบของ PCC ที่มีบรรทัดซึ่งบริษัทอื่นเป็นบริษัทที่ลงทุน หรืองบของบริษัทอื่นที่มีบรรทัดซึ่ง PCC เป็นบริษัทที่ลงทุน · นอกนั้นไม่ต้องทำ Memo (ส่งตรงให้ผู้คุมงบ) · OPEX ไม่ใช้ Memo · ปุ่มในฟอร์มเปลี่ยนตามบริษัทที่ลงทุนของแต่ละบรรทัด'],
      ['ใช้งบ', 'ตั้งเกณฑ์ Memo รายบริษัท', 'ข้อมูลหลัก > บริษัท > เกณฑ์ Memo: "ใช้เงินข้ามบริษัทกับบริษัทนี้" (ตั้งต้นเฉพาะ PCC) หรือ "ไม่ต้องใช้" · ต้องแนบไฟล์ Memo ที่เซ็นแล้วก่อนส่ง · ทุกประเภทการใช้งบและทุกยอดเงิน · ผู้บริหารเซ็นนอกระบบ'],
      ['ใช้งบ', 'แบบฟอร์ม Memo', 'ออกตามแบบฟอร์ม Memo จริงของบริษัท: เรียน/สำเนาถึง/เรื่อง/อ้างอิง → 1. เรื่องสืบเนื่อง → 2. เรื่องเพื่อพิจารณาลงนาม (ยอดเงินเป็นตัวอักษร) → ตารางสรุปงบ (กรอบงบ − เบิกไปแล้ว − ขอครั้งนี้ = คงเหลือ) → อ้างอิงอำนาจอนุมัติ → ตารางทบทวน/ผู้พิจารณาอนุมัติ · หัวกระดาษ: โลโก้ของบริษัท (ตั้งต้นใช้โลโก้กลุ่มบริษัท · อัปโหลดโลโก้เฉพาะบริษัทได้ที่ ข้อมูลหลัก > บริษัท) และคำว่า Memo ชิดขวา · ตารางหัว (เรียน/วันที่-เลขที่, เรื่อง, สำเนาถึง, อ้างอิง) กว้างกว่าเนื้อความ มีแต่เส้นแนวนอน · ยังไม่ทำเลขหน้าและแถบสีท้ายกระดาษ'],
      ['ใช้งบ', 'กรอก Memo อย่างไร', 'กด "ทำ Memo" ในฟอร์มคำขอ → ระบบออกเลขที่ Memo แล้วเปิดหน้า Memo ที่เป็นโครงแบบฟอร์มจริง มีช่องกรอกในตำแหน่งเดียวกับเอกสาร: เรียน · วันที่ · สำเนาถึง · เรื่อง · อ้างอิง · 1. เรื่องสืบเนื่อง · 2. เรื่องเพื่อพิจารณาลงนาม · อ้างอิงอำนาจอนุมัติ · ผู้ลงนามเสนอ (ชื่อ/ตำแหน่ง) · ผู้ทบทวน · ผู้พิจารณาอนุมัติ (เพิ่ม/ลบแถวได้) · ค่าเริ่มต้นดึงจากคำขอและ ข้อมูลหลัก > ผู้ลงนาม Memo ของบริษัทที่ลงทุน · ยอดเงิน รายการ และตารางสรุปงบ ระบบคำนวณจากคำขอ (แก้ที่คำขอ) · แก้ Memo ได้จนกว่าจะแนบฉบับที่เซ็นแล้วและส่งให้ผู้คุมงบ'],
      ['ใช้งบ', 'ค่าเริ่มต้นของเรื่องสืบเนื่อง / อ้างอิง', 'เรื่องสืบเนื่อง = ข้อความอ้างอิงงบและกรอบวงเงิน (ผู้ขอแก้/เพิ่มย่อหน้าเองได้) · อ้างอิง = มติที่ประชุม (CAPEX) / เอกสารอนุมัติผู้บริหาร (OPEX) ของงบ · "ครั้งที่" นับจากคำขอก่อนหน้าของงบเดียวกัน'],
      ['ใช้งบ', 'ใครเลือกว่าทำ Memo', 'ผู้ขอเลือกเองด้วยปุ่ม "ทำ Memo" ข้างปุ่มส่ง · ถ้าเกณฑ์ของบริษัทบังคับ (ตั้งต้น: งบที่ไม่มี Item) จะมีแค่ปุ่มทำ Memo'],
      ['ใช้งบ', 'ขั้นตอน Memo', 'บันทึกคำขอ → ระบบออกเลขที่ Memo (MEMO-บริษัทปี-ลำดับ) และจองงบไว้ → ผู้ขอพิมพ์ไปให้ผู้บริหารเซ็น → แนบไฟล์ที่เซ็นแล้ว + ชื่อผู้บริหาร → ส่งให้ผู้คุมงบ · แก้ไขคำขอระหว่างรอได้ (ต้องเซ็นใหม่ ใช้เลขที่เดิม)'],
      ['ใช้งบ', 'บริษัทที่ลงทุน', 'งบที่มี Item: กำหนดที่ Item ตอนตั้งงบ (ค่าตั้งต้น = บริษัทเจ้าของงบ) ตอนขอใช้ไม่ต้องเลือก · งบที่ไม่มี Item: เลือกรายบรรทัดตอนขอดำเนินการใช้งบ (ค่าตั้งต้น = บริษัทเจ้าของงบ) · แสดงในใบดำเนินการใช้งบและ Memo'],
      ['ใช้งบ', 'หมวดค่าใช้จ่าย', 'ใช้กับงบรวมโครงการ · แก้รายการหมวดได้ที่ข้อมูลหลัก'],
      ['OPEX', 'Item ของงบ OPEX', 'ต้องมี Item เสมอ (ไม่มีงบรวมทั้งโครงการ) · Item หลัก (1, 2, 3) กำหนดตอนตั้งงบพร้อมวงเงิน ไม่มีจำนวน/หน่วย · Item ย่อยได้ 3 ระดับ (1 → 1.1 → 1.1.1) เพิ่มได้เรื่อย ๆ หลังงบเปิดใช้แล้ว · รหัสโครงการและรหัส Item ผู้สร้างงบตั้งเอง โดย Business เจ้าของงบหรือผู้คุมงบ (ไม่ต้องอนุมัติซ้ำ ยอดงบรวมไม่เปลี่ยน)'],
      ['OPEX', 'วงเงินของ Item ย่อย', 'เงื่อนไขเดียว: รวมกันต้องไม่เกินวงเงิน Item หลัก (ถ้า 1.1 กำหนดวงเงินไว้ 1.1.x ต้องรวมไม่เกิน 1.1 ด้วย เพื่อให้ยอดคงเหลือสอดคล้องกัน) · จะกำหนดหรือไม่กำหนดวงเงินของ Item ย่อยก็ได้ (ไม่กำหนด = ใช้วงเงินของ Item แม่) · จำนวน/หน่วย กรอกที่ Item ย่อย · Item ย่อยที่กำหนดวงเงินถูกตรวจทั้งวงเงินตัวเองและวงเงิน Item หลัก · Item ย่อยที่มีการขอใช้แล้ว แก้รหัส/ลบไม่ได้'],
      ['OPEX', 'ขั้นตอนการใช้งบ OPEX', 'เหมือน CAPEX ทุกขั้น: ขอดำเนินการใช้งบ (4 ประเภท) → ผู้คุมงบตรวจสอบ → ตัดงบตามประเภท → ปิดยอดคืนส่วนต่าง · ขอเกินงบรายการต้องมี Note · ไม่ใช้ Memo'],
      ['OPEX', 'การอนุมัติงบ OPEX (ตั้งงบ / เพิ่มงบ)', 'ไม่เข้าบอร์ด — ให้ผู้บริหารอนุมัติ: แนบเอกสารอนุมัติ + เลขที่เอกสาร + ชื่อผู้บริหารที่อนุมัติ แล้วผู้คุมงบตรวจสอบและยืนยัน (ต้นแบบนี้ผู้บริหารอนุมัตินอกระบบ แล้วแนบหลักฐาน)'],
      ['OPEX', 'ผู้บริหารที่อนุมัติ ต้องเป็นผู้ใช้ในระบบไหม', 'ไม่ — พิมพ์ชื่อ/ตำแหน่งและแนบหลักฐาน (ถ้าต้องการให้ผู้บริหารกดอนุมัติในระบบ จะเพิ่มบทบาท "ผู้บริหาร" ภายหลัง)'],
      ['OPEX', 'ใบ OPEX ที่ใช้หลายรายการต้นทุน ตัดงบอย่างไร', 'แบ่งยอดที่ตัดตามสัดส่วนยอดของแต่ละรายการต้นทุนในใบ'],
      ['OPEX', 'Asset / Expenses และขั้นตอนบัญชีแยกของ OPEX', 'ไม่มี — ใช้ GL Code ที่ติดมากับรายการต้นทุน (ขั้นตอนบัญชี OPEX เดิมถูกแทนด้วยการตัดงบแบบเดียวกับ CAPEX)'],
      ['ระบบ', 'เลขที่เอกสารที่ระบบออกให้', 'รูปแบบ ตัวย่อเอกสาร-ปี ค.ศ.-ลำดับ 4 หลัก เริ่มนับใหม่ทุกปี: REQ คำขอดำเนินการใช้งบ · CAPEX / OPEX ใบดำเนินการใช้งบ · MEMO บันทึกข้อความ · INC คำขอเพิ่มงบ · TRF โยกงบ · DEC ลดงบ (เช่น CAPEX-2026-0001) · เอกสารที่ออกไปแล้วคงเลขเดิม · เลขที่ฝ่ายอื่นเป็นคนออก (รหัสโครงการ / Item No. / PR / PO / เลขที่มติ / เลขที่ใบเสร็จ) ผู้ใช้กรอกเอง'],
      ['ไฟล์แนบ', 'จุดแนบและชนิดเอกสาร', 'มติ (ตั้งงบ/เพิ่มงบ) · เอกสารประกอบคำขอ · PO · ใบเสร็จ/หลักฐานจ่าย — โหมดทดลองจำกัด 400 KB ต่อไฟล์'],
      ['ระบบ', 'ฐานข้อมูล Supabase', 'ต้นแบบนี้ยังไม่เชื่อม — จะปรับฐานข้อมูลเมื่อยืนยันขั้นตอนแล้ว (เวอร์ชันเดิมอยู่ที่ /v1/)']
    ];
    return '<div class="page-head"><div><h1>สิ่งที่รอยืนยัน</h1><div class="page-sub">ต้นแบบรอบนี้ใช้ค่าตั้งต้นด้านล่างแทนข้อที่ยังไม่ได้ตอบ — ถ้าไม่ตรงกับงานจริง แจ้งได้เลย</div></div></div>' +
      '<div class="table-wrap"><table><thead><tr><th>หมวด</th><th>คำถาม</th><th>ต้นแบบนี้ใช้</th></tr></thead><tbody>' +
      rows.map((x) => '<tr><td class="nowrap">' + esc(x[0]) + '</td><td>' + esc(x[1]) + '</td><td>' + esc(x[2]) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  // ---------------------------------------------------------------- ช่องที่ต้องกรอก (*) และปิดปุ่มจนกว่าเงื่อนไขครบ

  /** ใส่ * สีแดงให้ช่องที่ต้องกรอก (ตามชื่อช่อง) — ช่องที่มี required อยู่แล้วได้ * จาก CSS อัตโนมัติ */
  function markReq(form, names) {
    names.forEach((n) => form.querySelectorAll('[name="' + n + '"]').forEach((el) => {
      const fld = el.closest('.field');
      if (fld) fld.classList.add('req');
    }));
  }
  /** ใส่ * ที่หัวตาราง / หัวข้อ ตามข้อความ */
  function markReqText(root, selector, re) {
    root.querySelectorAll(selector).forEach((el) => { if (re.test(el.textContent)) el.classList.add('req'); });
  }

  /**
   * ปิดปุ่มจนกว่าจะกรอกครบ และบอกใต้ปุ่มว่ายังขาดอะไร
   * rules = [{ btn: ตัวเลือกปุ่ม, label?: ชื่อสั้นของปุ่ม (เมื่อมีหลายปุ่ม), missing: (form) => ['สิ่งที่ยังขาด', ...] }]
   */
  function guard(form, rules, anchorSel) {
    if (!form) return;
    let hint = form.querySelector('.guard-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'guard-hint';
      const anchor = form.querySelector(anchorSel || '.side-actions, .decision-actions, .actions');
      if (anchor) anchor.insertAdjacentElement('afterend', hint); else form.appendChild(hint);
    }
    const run = () => {
      const notes = [];
      const per = new Map(); // ปุ่มหนึ่งอาจถูกหลายกฎตรวจ: ขาดอะไรก็ได้ = กดไม่ได้
      let active = 0;
      rules.forEach((rule) => {
        const btns = Array.from(form.querySelectorAll(rule.btn));
        if (!btns.length) return;
        active += 1;
        const miss = rule.missing(form).filter(Boolean);
        btns.forEach((btn) => per.set(btn, (per.get(btn) || []).concat(miss)));
        if (miss.length) notes.push({ label: rule.label, text: miss.join(' · ') });
      });
      per.forEach((miss, btn) => {
        btn.disabled = miss.length > 0;
        btn.title = miss.length ? 'ยังขาด: ' + miss.join(', ') : '';
      });
      hint.textContent = notes.length ? 'กรอกให้ครบก่อน: ' + notes.map((n) => (active > 1 && n.label ? n.label + ': ' : '') + n.text).join(' | ') : '';
      hint.hidden = !notes.length;
    };
    form.addEventListener('input', run);
    form.addEventListener('change', run);
    form.addEventListener('click', () => setTimeout(run, 0)); // เพิ่ม/ลบแถว
    run();
  }
  const filled = (el) => !!(el && String(el.value || '').trim());
  const fileCount = (form) => form.querySelectorAll('.files li').length;

  function bindGuards() {
    // ---- ฟอร์มตั้งงบ / นำเข้างบ
    const bf = document.getElementById('budgetForm');
    if (bf) {
      markReq(bf, ['type', 'company', 'fiscalYear', 'code', 'name', 'department', 'ownerId', 'meetingNo', 'projAmount']);
      markReqText(bf, 'thead th', /^(รหัส|รหัสรายการย่อย|ชื่อรายการ|รายการ|วงเงิน \(รวม VAT\)|ก่อน VAT)$/);
      guard(bf, [{ btn: 'button[type="submit"]', missing: (f) => {
        const e = f.elements;
        const m = [];
        if (!filled(e.code)) m.push('รหัสโครงการ');
        if (!filled(e.name)) m.push('ชื่อโครงการ');
        if (!filled(e.department)) m.push('หน่วยงาน');
        if (!filled(e.fiscalYear)) m.push('ปีงบประมาณ');
        if (f.dataset.mode === 'import') {
          if (!filled(e.ownerId)) m.push('Business เจ้าของงบ');
          if (!filled(e.meetingNo)) m.push('เลขที่มติ / เอกสารอนุมัติ');
        }
        const type = e.type.value;
        const structure = type === 'CBS' ? 'items' : (f.querySelector('[name="structure"]:checked') || {}).value;
        if (structure === 'project') {
          if (!(Number(e.projAmount.value) > 0)) m.push('วงเงินรวมทั้งโครงการ');
        } else {
          const rows = Array.from(f.querySelectorAll('#' + (type === 'CBS' ? 'cbs' : 'capex') + 'Rows tr')).map((tr) => ({
            code: filled(tr.querySelector('[name="itCode"]')), dotted: String(tr.querySelector('[name="itCode"]').value).includes('.'), name: filled(tr.querySelector('[name="itName"]')),
            amount: Number((tr.querySelector('[name="itAmount"]') || {}).value || 0), parent: (tr.querySelector('[name="itAmount"]') || {}).disabled
          })).filter((r) => r.code || r.name || r.amount);
          if (!rows.length) m.push('รายการอย่างน้อย 1 รายการ');
          else {
            if (rows.some((r) => !r.code || !r.name)) m.push('รหัสและชื่อรายการทุกแถว');
            if (type === 'CAPEX' && rows.some((r) => !(r.amount > 0))) m.push('วงเงินของทุกรายการย่อย');
            if (type === 'CBS' && rows.some((r) => r.dotted)) m.push('รหัส Item หลักต้องไม่มีจุด (Item ย่อยเพิ่มภายหลัง)');
            if (type === 'CBS' && rows.some((r) => !(r.amount > 0))) m.push('วงเงินของ Item หลักทุกแถว');
          }
        }
        return m;
      } }]);
    }

    // ---- แนบมติ / เอกสารอนุมัติแล้วส่งตรวจ (งบ และคำขอเพิ่มงบ)
    ['submitBudget', 'submitChange'].forEach((id) => {
      const f = document.getElementById(id);
      if (!f) return;
      markReq(f, ['meetingNo', 'meetingBy']);
      f.querySelectorAll('input[type="file"]').forEach((el) => { const fld = el.closest('.field'); if (fld) fld.classList.add('req'); });
      guard(f, [{ btn: 'button[type="submit"]', missing: (form) => [
        !filled(form.elements.meetingNo) && (form.elements.meetingBy ? 'เลขที่เอกสารอนุมัติ' : 'เลขที่มติ'),
        form.elements.meetingBy && !filled(form.elements.meetingBy) && 'ผู้บริหารที่อนุมัติ',
        !fileCount(form) && 'ไฟล์' + (form.elements.meetingBy ? 'เอกสารอนุมัติ' : 'มติ')
      ] }]);
    });

    // ---- ผู้คุมงบ: ส่งกลับต้องมีเหตุผล
    ['verifyBudget', 'verifyChange'].forEach((id) => {
      const f = document.getElementById(id);
      if (!f) return;
      guard(f, [{ btn: '[data-verify="returned"]', label: 'ส่งกลับ', missing: (form) => [!filled(form.elements.comment) && 'หมายเหตุ / เหตุผลที่ส่งกลับ'] }]);
    });

    // ---- ขอดำเนินการใช้งบ
    const rf = document.getElementById('requestForm');
    if (rf) {
      markReq(rf, ['itemId', 'purpose']);
      markReqText(rf, '.section-title', /ประเภทการดำเนินการใช้งบ/);
      markReqText(rf, '.lines-table thead th', /^(รายการต้นทุน \(OPEX\)|รายการย่อย \(Item No\.\)|หมวดค่าใช้จ่าย|รายละเอียด|ก่อน VAT)/);
      markReq(rf, ['memoTo', 'memoApprovers']);
      guard(rf, [{ btn: 'button[type="submit"]', missing: (f) => {
        const e = f.elements;
        const m = [];
        if (!f.querySelector('[name="useType"]:checked')) m.push('ประเภทการดำเนินการใช้งบ');

        if (!filled(e.purpose)) m.push('วัตถุประสงค์');
        if (e.payee && e.payee.required && !filled(e.payee)) m.push('ผู้รับเงิน');
        const rows = Array.from(f.querySelectorAll('#lineRows tr')).map((tr) => ({
          desc: filled(tr.querySelector('[name="lnDesc"]')), amt: Number(tr.querySelector('[name="lnAmount"]').value || 0),
          item: tr.querySelector('[name="lnItem"]'), cat: tr.querySelector('[name="lnCat"]')
        }));
        const used = rows.filter((r) => r.desc || r.amt);
        if (!used.length) m.push('รายการที่ขอใช้อย่างน้อย 1 บรรทัด');
        if (used.some((r) => !r.desc)) m.push('รายละเอียดทุกบรรทัด');
        if (used.some((r) => !(r.amt > 0))) m.push('จำนวนเงินทุกบรรทัด');
        const rb = budgetById(f.dataset.budget) || {};
        if ((used.length ? used : rows).some((r) => r.item && !r.item.value)) m.push(rb.type === 'CAPEX' ? 'รายการย่อย (Item No.) ทุกบรรทัด' : 'รายการต้นทุนทุกบรรทัด');
        if (used.some((r) => r.cat && !r.cat.value)) m.push('หมวดค่าใช้จ่ายทุกบรรทัด');
        const wrap = document.getElementById('planWrap');
        const mode = f.querySelector('[name="payMode"]:checked');
        if (wrap && !wrap.hidden && mode && mode.value === 'installments') {
          const pcts = Array.from(f.querySelectorAll('#planRows [name="planPct"]')).map((x) => Number(x.value || 0)).filter((x) => x);
          if (pcts.length < 2 || round2(pcts.reduce((s, x) => s + x, 0)) !== 100) m.push('งวดจ่ายอย่างน้อย 2 งวด รวม 100%');
        }
        return m;
      } }]);
    }

    // ---- ผู้คุมงบตรวจคำขอ
    const df = document.getElementById('decisionForm');
    if (df) {
      const r = requestById(df.dataset.id);
      const ov = capexOver(r);
      guard(df, [
        { btn: '[data-decision="approved"]', label: 'อนุมัติ', missing: (form) => [
          ov.project > 0 && 'เกินงบโครงการ ' + money(ov.project) + ' บาท — โยกงบเข้าก่อน',
          ov.project <= 0 && ov.item > 0 && !filled(form.elements.comment) && 'Note เหตุผลที่ให้ผ่าน (ขอเกินงบรายการ)'] },
        { btn: '[data-decision="rejected"]', label: 'ส่งกลับ', missing: (form) => [!filled(form.elements.comment) && 'เหตุผลที่ส่งกลับ'] }
      ]);
    }

    // ---- แนบ Memo ที่เซ็นแล้ว
    const ms = document.getElementById('memoSubmit');
    if (ms) {
      const fi = ms.querySelector('input[type="file"]');
      if (fi && fi.closest('.field')) fi.closest('.field').classList.add('req');
      guard(ms, [{ btn: 'button[type="submit"]', missing: (form) => [
        !fileCount(form) && 'ไฟล์ Memo ที่เซ็นแล้ว'] }]);
    }

    // ---- การตัดงบ
    const af = document.getElementById('advForm');
    if (af) guard(af, [{ btn: 'button[type="submit"]', missing: (f) => [!filled(f.elements.date) && 'วันที่จ่าย', !(Number(f.elements.amount.value) > 0) && 'ยอดเงินทดรอง'] }]);
    const cf = document.getElementById('cutForm');
    if (cf) {
      const r = requestById(cf.dataset.id);
      guard(cf, [{ btn: 'button[type="submit"]', missing: (f) => {
        const e = f.elements;
        const amt = Number(e.amount.value || 0);
        return [e.prNo && !filled(e.prNo) && 'เลขที่ PR', e.poNo && !filled(e.poNo) && 'เลขที่ PO', !filled(e.date) && 'วันที่',
          !(amt > 0) && 'ยอดเงิน', amt > 0 && round2(cutTotal(r) + amt) > r.amount + 0.005 && !filled(e.note) && 'หมายเหตุ (ยอดรวมเกินที่ขอ)'];
      } }]);
    }
    const clf = document.getElementById('closeForm');
    if (clf) {
      const r = requestById(clf.dataset.id);
      guard(clf, [{ btn: 'button[type="submit"]', missing: (f) => [cutTotal(r) > r.amount + 0.005 && !filled(f.elements.note) && 'หมายเหตุ (ยอดจริงเกินที่ขอ)'] }]);
    }

    // ---- คำขอเพิ่มงบ
    const chf = document.getElementById('changeForm');
    if (chf) {
      markReq(chf, ['reason', 'projAdd']);
      guard(chf, [{ btn: 'button[type="submit"]', missing: (f) => {
        const m = [];
        if (!filled(f.elements.reason)) m.push('เหตุผลที่ขอเพิ่มงบ');
        if (f.elements.projAdd) { if (!(Number(f.elements.projAdd.value) > 0)) m.push('วงเงินที่ขอเพิ่ม'); return m; }
        const rows = Array.from(f.querySelectorAll('#chRows tr'));
        if (!rows.length) m.push('รายการที่ขอเพิ่ม');
        if (rows.some((tr) => !(Number(tr.querySelector('[name="chAmount"]').value) > 0))) m.push('จำนวนเงินที่ขอเพิ่มทุกแถว');
        if (rows.some((tr) => tr.querySelector('[name="chItem"]').value === 'new' && (!filled(tr.querySelector('[name="chCode"]')) || !filled(tr.querySelector('[name="chName"]'))))) m.push('รหัสและชื่อรายการใหม่');
        return m;
      } }]);
    }

    // ---- โยก / ลดงบ
    const pick = (v) => { const [bid, iid] = String(v || '').split('|'); const b = budgetById(bid); const it = b && itemById(b, iid); return { b, it }; };
    const remainOf = (x) => (x.it ? usage(x.b, x.it.id).remaining : 0);
    const mv = document.getElementById('moveForm');
    if (mv) guard(mv, [{ btn: 'button[type="submit"]', missing: (f) => {
      const e = f.elements;
      const src = pick(e.from.value);
      const amt = Number(e.amount.value || 0);
      return [!e.from.value && 'โยกจาก', !e.to.value && 'ไปยัง', e.from.value && e.from.value === e.to.value && 'ต้นทางและปลายทางต้องต่างกัน',
        !(amt > 0) && 'จำนวนเงิน', amt > 0 && src.it && amt > remainOf(src) + 0.005 && 'ต้นทางคงเหลือไม่พอ (' + money(remainOf(src)) + ')',
        amt > 0 && src.it && round2(itemTotal(src.it) - amt) < allocatedOf(src.b, src.it) - 0.005 && 'โยกออกแล้วต่ำกว่าวงเงินที่จัดสรรให้ Item ย่อย (' + money(allocatedOf(src.b, src.it)) + ')', !filled(e.reason) && 'เหตุผล'];
    } }]);
    const cb = document.getElementById('cutBudgetForm');
    if (cb) guard(cb, [{ btn: 'button[type="submit"]', missing: (f) => {
      const e = f.elements;
      const t = pick(e.target.value);
      const amt = Number(e.amount.value || 0);
      return [!e.target.value && 'รายการ', !(amt > 0) && 'จำนวนที่ลด', amt > 0 && t.it && amt > remainOf(t) + 0.005 && 'ลดได้ไม่เกินคงเหลือ ' + money(remainOf(t)),
        amt > 0 && t.it && round2(itemTotal(t.it) - amt) < allocatedOf(t.b, t.it) - 0.005 && 'ลดแล้วต่ำกว่าวงเงินที่จัดสรรให้ Item ย่อย (' + money(allocatedOf(t.b, t.it)) + ')', !filled(e.reason) && 'เหตุผล'];
    } }]);
  }

  function notFound() {
    return '<div class="card empty">ไม่พบข้อมูลที่ต้องการ</div>';
  }

  // ---------------------------------------------------------------- router

  // ---- ปุ่มย้อนกลับ: กลับไปหน้าก่อนหน้าที่ผู้ใช้เปิดมาจริง ๆ (ใช้ stack ของตัวเอง แทน history ของเบราว์เซอร์
  //      เพราะหลังส่งฟอร์ม history จะพากลับไปหน้าฟอร์มเดิม) ถ้าไม่มีหน้าก่อนหน้า (เปิดลิงก์ตรง) จะกลับไปหน้า "ต้นทาง" ตามชนิดหน้า
  const NAV_KEY = DB_KEY + '.nav';
  const NAV_MAX = 40;
  let navStack = [];
  try { navStack = JSON.parse(sessionStorage.getItem(NAV_KEY) || '[]'); } catch (err) { navStack = []; }
  if (!Array.isArray(navStack)) navStack = [];

  const navPath = (hash) => hash.split('?')[0];
  /** หน้าฟอร์ม (สร้าง/แก้ไข) ไม่ใช่ที่ที่ควรย้อนกลับมา — หลังส่งหรือยกเลิกแล้วจะถูกตัดออกจาก stack */
  function isFormHash(hash) {
    const p = navPath(hash).slice(2).split('/');
    return (p[0] === 'budget' && (p[1] === 'new' || p[2] === 'edit' || p[2] === 'items' || p[2] === 'cashflow')) || (p[0] === 'request' && (p[1] === 'new' || p[2] === 'edit')) ||
      (p[0] === 'change' && (p[1] === 'new' || p[2] === 'edit')) || p[0] === 'adjust';
  }
  /** หน้าที่อ้างถึงข้อมูลที่ถูกลบไปแล้วไม่ใช้เป็นปลายทางย้อนกลับ */
  function navValid(hash) {
    const p = navPath(hash).slice(2).split('/');
    if (p[0] === 'budget' && p[1] !== 'new') return !!budgetById(p[1]);
    if (p[0] === 'request' && p[1] !== 'new') return !!requestById(p[1]);
    if (p[0] === 'doc') return !!requestById(p[1]);
    if (p[0] === 'change' && p[1] !== 'new') return !!changeById(p[1]);
    return true;
  }
  function trackNav(here) {
    navStack = navStack.filter(navValid);
    const top = navStack[navStack.length - 1];
    if (top !== here) {
      if (navStack.length > 1 && navStack[navStack.length - 2] === here) {
        navStack.pop(); // ย้อนกลับ (ปุ่มย้อนกลับหรือปุ่มย้อนของเบราว์เซอร์)
      } else {
        if (top && isFormHash(top)) navStack.pop();
        const prevTop = navStack[navStack.length - 1];
        if (prevTop && navPath(prevTop) === navPath(here)) navStack.pop(); // หน้าเดิมแต่เปลี่ยนแท็บ/ตัวกรอง
        navStack.push(here);
      }
      if (navStack.length > NAV_MAX) navStack = navStack.slice(-NAV_MAX);
    }
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify(navStack)); } catch (err) { /* ignore */ }
  }
  const previousPage = () => (navStack.length > 1 ? navStack[navStack.length - 2] : null);

  const LIST_PAGES = ['export', 'dashboard', 'master', 'admin', 'adjust', 'tasks', 'history', 'po', 'cuts', 'log', 'assumptions', 'budgets', 'my-budgets', 'requests', 'approvals', 'accounting', 'payments'];
  let lastBudgetList = null; // หน้ารายการงบล่าสุด (จำแท็บ/ตัวกรอง)
  let lastRequestParent = null; // หน้าที่เปิดคำขอมาล่าสุด: รายการคำขอ / รอตรวจสอบ / งวดจ่าย / หน้ารายละเอียดงบ

  function backLabel(hash) {
    const p = hash.slice(2).split('?')[0].split('/');
    if (p[0] === 'budget') {
      const b = budgetById(p[1]);
      return b ? b.code + ' ' + b.name : 'งบประมาณ';
    }
    if (p[0] === 'request') {
      if (p[1] === 'new') return 'ขอเบิกใช้งบ';
      const r = requestById(p[1]);
      return r ? 'คำขอ ' + r.no : 'คำขอ';
    }
    if (p[0] === 'doc') {
      const r = requestById(p[1]);
      return r && r.docNo ? 'เอกสาร ' + r.docNo : 'เอกสาร';
    }
    const titles = {
      dashboard: 'ภาพรวมงบประมาณ', master: 'ข้อมูลหลัก',
      admin: 'ผู้ใช้และสิทธิ์',
      budgets: can('budget.manage') ? 'จัดการงบประมาณ' : 'งบประมาณ', 'my-budgets': 'งบประมาณ',
      requests: 'รายการดำเนินการใช้งบ',
      tasks: 'งานทั้งหมด', approvals: 'งานทั้งหมด', accounting: 'งานทั้งหมด', payments: 'งานทั้งหมด', po: 'งานทั้งหมด', cuts: 'งานทั้งหมด',
      history: 'ประวัติการทำรายการ', adjust: 'โยก / ลดงบ', log: 'Log การทำงาน', assumptions: 'สิ่งที่รอยืนยัน'
    };
    if (p[0] === 'change') {
      const c = changeById(p[1]);
      return c ? 'คำขอเพิ่มงบ ' + c.no : 'คำขอเพิ่มงบ';
    }
    return titles[p[0]] || 'กลับ';
  }

  /** ปลายทางของปุ่มย้อนกลับ ตามชนิดหน้า (null = หน้ารายการ ไม่ต้องมีปุ่ม) */
  function backTarget(parts) {
    const budgetList = lastBudgetList || (canViewAll() ? '#/budgets' : '#/my-budgets');
    if (parts[0] === 'budget' && parts[1] === 'new') return budgetList;
    if (parts[0] === 'budget' && (parts[2] === 'edit' || parts[2] === 'form' || parts[2] === 'items' || parts[2] === 'cashflow')) return '#/budget/' + parts[1];
    if (parts[0] === 'budget') return budgetList;
    if (parts[0] === 'request' && parts[1] === 'new') return '#/budget/' + parts[2];
    if (parts[0] === 'request' && (parts[2] === 'edit' || parts[2] === 'memo')) return '#/request/' + parts[1];
    if (parts[0] === 'request') return lastRequestParent || '#/requests';
    if (parts[0] === 'doc') return '#/request/' + parts[1];
    if (parts[0] === 'adjust') {
      const q = new URLSearchParams(location.hash.split('?')[1] || '');
      const bid = q.get('budget') || q.get('to');
      return bid && budgetById(bid) ? '#/budget/' + bid : budgetList;
    }
    if (parts[0] === 'change' && parts[1] === 'new') return '#/budget/' + parts[2];
    if (parts[0] === 'change' && parts[2] === 'edit') return '#/change/' + parts[1];
    if (parts[0] === 'change') { const c = changeById(parts[1]); return c ? '#/budget/' + c.budgetId : budgetList; }
    return null;
  }

  function render() {
    if (REMOTE && !remoteMe) return; // ยังไม่ได้ล็อกอิน
    const hash = location.hash || homeFor(me());
    const [path, query] = hash.slice(1).split('?');
    const params = new URLSearchParams(query || '');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) { location.replace(homeFor(me())); return; }
    const app = document.getElementById('app');
    let html;

    if (parts[0] === 'dashboard') html = viewDashboard(params);
    else if (parts[0] === 'master') html = viewMaster(parts[1]);
    else if (parts[0] === 'admin') html = viewAdmin(params);
    else if (parts[0] === 'budgets' || parts[0] === 'my-budgets') html = viewBudgets(params, parts[0] === 'my-budgets');
    else if (parts[0] === 'budget' && parts[1] === 'new') html = viewBudgetForm(null);
    else if (parts[0] === 'budget' && parts[2] === 'edit') html = viewBudgetForm(parts[1]);
    else if (parts[0] === 'budget' && parts[2] === 'form') html = viewBudgetRequestForm(parts[1]);
    else if (parts[0] === 'budget' && parts[2] === 'items') html = viewSubItems(parts[1]);
    else if (parts[0] === 'budget' && parts[2] === 'cashflow') html = viewCashflow(parts[1]);
    else if (parts[0] === 'budget') html = viewBudgetDetail(parts[1]);
    else if (parts[0] === 'request' && parts[1] === 'new') html = viewRequestForm(parts[2], null, params);
    else if (parts[0] === 'request' && parts[2] === 'edit') html = viewRequestForm(null, parts[1], params);
    else if (parts[0] === 'request' && parts[2] === 'memo') html = viewRequestMemo(parts[1], params);
    else if (parts[0] === 'request') html = viewRequestDetail(parts[1]);
    else if (parts[0] === 'requests') html = viewRequests();
    else if (parts[0] === 'change' && parts[1] === 'new') html = viewChangeForm(parts[2], null);
    else if (parts[0] === 'change' && parts[2] === 'edit') html = viewChangeForm(null, parts[1]);
    else if (parts[0] === 'change') html = viewChangeDetail(parts[1]);
    else if (parts[0] === 'adjust') html = viewAdjust(params);
    else if (parts[0] === 'tasks') html = viewTasks(params);
    else if (OLD_TASK_ROUTES[parts[0]]) html = viewTasks(params, parts[0]);
    else if (parts[0] === 'history') html = viewHistory(params);
    else if (parts[0] === 'log') html = viewLog(params);
    else if (parts[0] === 'assumptions') html = viewAssumptions();
    else if (parts[0] === 'export') html = viewExport();
    else if (parts[0] === 'doc') html = viewDocument(parts[1]);
    else html = notFound();

    const here = '#' + path + (query ? '?' + query : '');
    trackNav(here);
    const fallback = backTarget(parts);
    const back = fallback && (previousPage() || fallback);
    if (back) html = '<div class="back-bar no-print"><a class="back-link" href="' + esc(back) + '">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      esc(backLabel(back)) + '</a></div>' + html;
    if (parts[0] === 'budgets' || parts[0] === 'my-budgets') lastBudgetList = here;
    if (LIST_PAGES.includes(parts[0]) || (parts[0] === 'budget' && parts.length === 2 && parts[1] !== 'new')) lastRequestParent = here;

    renderNav('#' + path);
    app.innerHTML = html;
    // ปุ่ม "ยกเลิก" ในฟอร์มกลับไปหน้าก่อนหน้าเช่นเดียวกับปุ่มย้อนกลับ
    if (back) app.querySelectorAll('[data-back]').forEach((a) => { a.setAttribute('href', back); });
    bindBudgetForm();
    bindBudgetDetail();
    bindChangeForm();
    bindSubItems();
    bindMemoDoc();
    bindCashflow();
    bindExport();
    bindChangeDetail();
    bindAdjust();
    bindLog();
    bindHistory();
    bindGuards();
    bindDashboard();
    bindMaster();
    bindAdmin();
    bindRequestForm();
    bindCuts();
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
    if (userMenuReady) { renderUserButton(); return; }
    userMenuReady = true;
    const btn = document.getElementById('userBtn');
    const menu = document.getElementById('userMenu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const fill = () => {
      if (REMOTE) {
        menu.innerHTML = '<div class="menu-label">เข้าสู่ระบบในฐานะ</div><div class="menu-user"><strong>' + esc(me().name) + '</strong><small>' +
          esc((me().title ? me().title + ' · ' : '') + roleLabel(me())) + '</small></div><hr>' +
          '<button type="button" role="menuitem" data-logout>ออกจากระบบ</button>';
        return;
      }
      menu.innerHTML = '<div class="menu-label">เข้าใช้งานในฐานะ (ทดสอบ)</div>' +
        USERS.map((x) => '<button type="button" role="menuitemradio" data-user="' + x.id + '" aria-checked="' + (x.id === me().id) + '">' +
          esc(x.name) + '<small>' + esc(x.title + ' · ' + roleLabel(x)) + '</small></button>').join('') +
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
      if (item.hasAttribute('data-logout')) { logout(); return; }
      if (item.hasAttribute('data-reset')) {
        if (!confirm('ล้างข้อมูลทั้งหมดและกลับไปใช้ข้อมูลตัวอย่าง?')) return;
        db = seed();
        navStack = [];
        save();
      } else {
        currentUserId = item.dataset.user;
        lastBudgetList = null;
        lastRequestParent = null;
        navStack = [];
        try { localStorage.setItem(DB_KEY + '.user', currentUserId); } catch (err) { /* ignore */ }
        renderUserButton();
      }
      go(homeFor(me()));
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  // ---------------------------------------------------------------- เข้าสู่ระบบ (โหมด Supabase)

  function authShell(inner) {
    document.body.classList.add('auth-screen');
    document.getElementById('app').innerHTML = '<div class="auth-wrap">' + inner + '</div>';
  }

  function showLogin(message) {
    remoteMe = null;
    db = null;
    navStack = [];
    authShell('<div class="card auth-card"><h1>เข้าสู่ระบบ</h1><p class="muted">ระบบขอเบิกใช้งบประมาณ</p>' +
      '<div id="loginError">' + (message ? '<div class="alert error">' + esc(message) + '</div>' : '') + '</div>' +
      '<form id="loginForm"><label class="field"><span>อีเมล</span><input name="email" type="email" autocomplete="username" required></label>' +
      '<label class="field"><span>รหัสผ่าน</span><input name="password" type="password" autocomplete="current-password" required></label>' +
      '<button class="btn primary tall" type="submit">เข้าสู่ระบบ</button></form>' +
      '<p class="muted small-note">บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบ หากเข้าสู่ระบบไม่ได้กรุณาติดต่อฝ่ายการเงิน</p></div>');
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await window.RemoteApi.signIn(form.elements.email.value.trim(), form.elements.password.value);
      } catch (err) {
        document.getElementById('loginError').innerHTML = '<div class="alert error">' + esc(err.message) + '</div>';
        btn.disabled = false;
        return;
      }
      await enterApp();
    });
    form.elements.email.focus();
  }

  function showPending(meRow) {
    const inactive = meRow && meRow.active === false;
    authShell('<div class="card auth-card"><h1>' + (inactive ? 'บัญชีถูกปิดการใช้งาน' : 'รอผู้ดูแลกำหนดสิทธิ์') + '</h1>' +
      '<p class="muted">' + (inactive
        ? 'บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อฝ่ายการเงิน'
        : 'เข้าสู่ระบบสำเร็จ แต่ยังไม่ได้รับสิทธิ์ใช้งาน กรุณาแจ้งฝ่ายการเงินให้กำหนดชื่อและบทบาทให้บัญชีนี้') + '</p>' +
      '<p><strong>' + esc((meRow && meRow.email) || (window.RemoteApi.sessionUser() || {}).email || '') + '</strong></p>' +
      '<div class="actions"><button class="btn primary" id="recheck">ตรวจสอบอีกครั้ง</button><button class="btn" id="pendingLogout">ออกจากระบบ</button></div></div>');
    document.getElementById('recheck').addEventListener('click', enterApp);
    document.getElementById('pendingLogout').addEventListener('click', logout);
  }

  function showFatal(message) {
    authShell('<div class="card auth-card"><h1>เปิดระบบไม่สำเร็จ</h1><div class="alert error">' + esc(message) + '</div>' +
      '<div class="actions"><button class="btn primary" id="retry">ลองใหม่</button><button class="btn" id="fatalLogout">ออกจากระบบ</button></div></div>');
    document.getElementById('retry').addEventListener('click', enterApp);
    document.getElementById('fatalLogout').addEventListener('click', logout);
  }

  /** ออกจากระบบเมื่อหมดเวลาเข้าใช้งาน (session หมดอายุ) */
  function signedOut(message) {
    window.RemoteApi.signOut();
    showLogin(message);
  }

  async function logout() {
    await window.RemoteApi.signOut();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    showLogin();
  }

  async function enterApp() {
    authShell('<div class="card auth-card"><p class="muted">กำลังเข้าสู่ระบบ…</p></div>');
    let meRow;
    try {
      meRow = await window.RemoteApi.me();
      if (meRow && meRow.active && meRow.role) await reloadRemote();
    } catch (e) {
      if (e && e.code === 'AUTH') showLogin(e.message); else showFatal((e && e.message) || 'เกิดข้อผิดพลาด');
      return;
    }
    if (!meRow || !meRow.active || !meRow.role) { showPending(meRow); return; }
    document.body.classList.remove('auth-screen');
    renderUserButton();
    initUserMenu();
    startPolling();
    render();
  }

  // โหลดข้อมูลใหม่เป็นระยะ (และเมื่อกลับมาที่แท็บ) เพื่อให้เห็นงานที่คนอื่นทำ — ข้ามเมื่อกำลังกรอกฟอร์ม
  let pollTimer = null;
  async function silentRefresh() {
    if (!REMOTE || !remoteMe || document.visibilityState !== 'visible' || isFormHash(location.hash || '')) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && document.getElementById('app').contains(ae)) return;
    const before = remoteSnapshot;
    try {
      await reloadRemote();
    } catch (e) {
      if (e && e.code === 'AUTH') signedOut('หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบใหม่');
      return;
    }
    if (remoteSnapshot !== before) {
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    }
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(silentRefresh, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') silentRefresh(); });
  }

  let userMenuReady = false;

  function init() {
    if (!REMOTE) db = load();
    checkForUpdate();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    if (REMOTE) {
      document.body.classList.add('remote');
      const note = document.querySelector('.sidebar-note');
      if (note) note.textContent = 'ข้อมูลเก็บบนเซิร์ฟเวอร์ — ทุกคนในองค์กรเห็นข้อมูลเดียวกันตามสิทธิ์ของบทบาท';
    } else {
      initUserMenu();
    }
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
    if (REMOTE) {
      document.body.classList.add('auth-screen');
      if (window.RemoteApi.hasSession()) enterApp(); else showLogin();
    } else {
      render();
    }
  }

  init();
})();
