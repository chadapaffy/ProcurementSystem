/*
 * ระบบขอใช้งบประมาณ (ต้นแบบ)
 *
 * - การเงิน: บันทึกงบลงทุน (CAPEX) และงบโครงการ (CBS) ที่ได้รับอนุมัติแล้ว
 * - ผู้ขอใช้งบ: ตรวจสอบงบที่ใช้ได้ แล้วจัดทำเอกสารขอเบิกใช้งบโดยระบุตัวงบทุกครั้งที่จะใช้
 * - CAPEX: ฝ่ายการเงินรับเอกสารและตรวจสอบ → อนุมัติ / ไม่อนุมัติ (แจ้งเหตุผล → ผู้ขอแก้ไขหรือยกเลิก)
 * - CBS: ไม่ต้องผ่านฝ่ายการเงิน ได้เอกสารทันที
 * - ผลลัพธ์คือ "เอกสารการเบิกขอใช้งบประมาณ" สำหรับแนบตอนขอซื้อ (PR)
 *
 * ไม่ใช่การขออนุมัติงบ — งบได้รับอนุมัติมาแล้ว ระบบนี้ใช้ยืนยันตัวงบและติดตามยอดคงเหลือ
 *
 * ข้อมูลเก็บใน localStorage ของเบราว์เซอร์ (ยังไม่มี backend)
 */
(function () {
  'use strict';

  const DB_KEY = 'procurement.budget.v3';

  const USERS = [
    { id: 'req1', name: 'สมชาย ใจดี', title: 'วิศวกร ฝ่ายวิศวกรรม', role: 'requester' },
    { id: 'req2', name: 'สุดา รักงาน', title: 'เจ้าหน้าที่โครงการ ฝ่ายโครงการ', role: 'requester' },
    { id: 'fin1', name: 'มาลี เงินดี', title: 'เจ้าหน้าที่การเงิน', role: 'finance' }
  ];

  const ROLE_LABEL = {
    requester: 'ผู้ขอใช้งบ',
    finance: 'การเงิน'
  };

  const TYPE_LABEL = { CAPEX: 'งบลงทุน (CAPEX)', CBS: 'งบโครงการ (CBS)' };
  const STATUS_LABEL = {
    pending: 'รอการเงินตรวจสอบ',
    approved: 'ออกเอกสารแล้ว',
    rejected: 'ไม่อนุมัติ — รอแก้ไข',
    cancelled: 'ยกเลิก'
  };

  // ---------------------------------------------------------------- storage

  function seed() {
    const now = new Date().toISOString();
    const year = new Date().getFullYear();
    return {
      seq: { req: 0, CAPEX: 0, CBS: 0, id: 100 },
      budgets: [
        {
          id: 'b1', type: 'CAPEX', code: 'CAPEX-' + year + '-ENG-01',
          name: 'เครื่องจักรสายการผลิตใหม่', fiscalYear: year, department: 'ฝ่ายวิศวกรรม',
          ownerId: 'req1', amount: 2500000, items: [],
          note: 'อนุมัติโดยคณะกรรมการบริษัท', createdAt: now
        },
        {
          id: 'b2', type: 'CAPEX', code: 'CAPEX-' + year + '-ENG-02',
          name: 'คอมพิวเตอร์และอุปกรณ์ IT', fiscalYear: year, department: 'ฝ่ายวิศวกรรม',
          ownerId: 'req1', amount: 450000, items: [],
          note: '', createdAt: now
        },
        {
          id: 'b3', type: 'CBS', code: 'PRJ-' + year + '-017',
          name: 'โครงการก่อสร้างคลังสินค้า บางนา', fiscalYear: year, department: 'ฝ่ายโครงการ',
          ownerId: 'req2', amount: 0, note: 'สัญญาลูกค้าเลขที่ C-2026-044',
          items: [
            { id: 'i1', code: '01', name: 'งานโครงสร้าง', amount: 3200000 },
            { id: 'i2', code: '02', name: 'งานระบบไฟฟ้า', amount: 850000 },
            { id: 'i3', code: '03', name: 'งานระบบสุขาภิบาล', amount: 420000 },
            { id: 'i4', code: '04', name: 'ค่าบริหารโครงการ', amount: 300000 }
          ],
          createdAt: now
        }
      ],
      requests: []
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ใช้ข้อมูลตัวอย่างแทน */ }
    return seed();
  }

  let db = load();
  let currentUserId = 'fin1';
  try { currentUserId = localStorage.getItem(DB_KEY + '.user') || currentUserId; } catch (e) { /* ignore */ }

  function save() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }

  function nextId(prefix) {
    db.seq.id += 1;
    return prefix + db.seq.id;
  }

  function nextNo(kind) {
    db.seq[kind] += 1;
    const prefix = kind === 'req' ? 'REQ' : kind;
    return prefix + '-' + new Date().getFullYear() + '-' + String(db.seq[kind]).padStart(4, '0');
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

  function fmtDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function round2(n) { return Math.round(Number(n) * 100) / 100; }

  const user = (id) => USERS.find((u) => u.id === id);
  const userName = (id) => (user(id) ? user(id).name : '-');
  const me = () => user(currentUserId) || USERS[0];
  const budgetById = (id) => db.budgets.find((b) => b.id === id);
  const requestById = (id) => db.requests.find((r) => r.id === id);

  function budgetTotal(b) {
    return b.type === 'CBS' ? b.items.reduce((s, i) => s + Number(i.amount), 0) : Number(b.amount);
  }

  /** ยอดงบ: approved = งบที่ได้รับ, used = ออกเอกสารแล้ว, reserved = รอการเงินตรวจสอบ */
  function usage(b, itemId) {
    const approved = itemId
      ? Number((b.items.find((i) => i.id === itemId) || {}).amount || 0)
      : budgetTotal(b);
    let used = 0;
    let reserved = 0;
    db.requests.forEach((r) => {
      if (r.budgetId !== b.id) return;
      if (itemId && r.itemId !== itemId) return;
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

  function canAct(u, step) {
    return !!step && (step.assignee === u.id || (step.role && step.role === u.role));
  }

  function stepAssigneeText(step) {
    return step.assignee ? userName(step.assignee) : ROLE_LABEL[step.role];
  }

  function inbox(u) {
    return db.requests.filter((r) => canAct(u, currentStep(r)));
  }

  function badge(cls, text) {
    return '<span class="badge ' + esc(cls) + '">' + esc(text) + '</span>';
  }

  function usageBar(u) {
    const pct = (v) => (u.approved > 0 ? Math.min(100, (v / u.approved) * 100) : 0);
    return '<div class="bar" role="img" aria-label="ใช้แล้ว ' + money(u.used) + ' จอง ' + money(u.reserved) + '">' +
      '<div class="used" style="width:' + pct(u.used) + '%"></div>' +
      '<div class="reserved" style="width:' + pct(u.reserved) + '%"></div></div>' +
      '<div class="legend"><span><i style="background:var(--primary)"></i>ใช้แล้ว</span>' +
      '<span><i style="background:var(--warn)"></i>รอตรวจสอบ</span>' +
      '<span><i style="background:var(--bar-bg)"></i>คงเหลือ</span></div>';
  }

  function usageKv(u) {
    return '<dl class="kv">' +
      '<dt>งบที่ได้รับอนุมัติ</dt><dd>' + money(u.approved) + '</dd>' +
      '<dt>ใช้แล้ว (ออกเอกสาร)</dt><dd>' + money(u.used) + '</dd>' +
      '<dt>รอตรวจสอบ (จองไว้)</dt><dd>' + money(u.reserved) + '</dd>' +
      '<dt>คงเหลือ</dt><dd class="big">' + money(u.remaining) + '</dd></dl>';
  }

  let flash = null;
  function setFlash(type, text) { flash = { type, text }; }
  function takeFlash() {
    if (!flash) return '';
    const html = '<div class="alert ' + flash.type + '">' + esc(flash.text) + '</div>';
    flash = null;
    return html;
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  // ---------------------------------------------------------------- views

  function homeFor(u) {
    if (u.role === 'finance') return '#/budgets';
    return '#/my-budgets';
  }

  function renderNav(route) {
    const u = me();
    const links = [];
    if (u.role === 'finance') links.push(['#/budgets', 'จัดการงบประมาณ']);
    if (u.role === 'requester') links.push(['#/my-budgets', 'งบของฉัน']);
    const n = inbox(u).length;
    if (u.role === 'finance') {
      links.push(['#/approvals', 'รอตรวจสอบ' + (n ? '<span class="count">' + n + '</span>' : '')]);
    }
    links.push(['#/requests', u.role === 'requester' ? 'คำขอของฉัน' : 'คำขอใช้งบทั้งหมด']);
    document.getElementById('nav').innerHTML = links.map(([href, text]) =>
      '<a href="' + href + '"' + (route.startsWith(href) ? ' class="active"' : '') + '>' + text + '</a>'
    ).join('');
  }

  function viewBudgets(params) {
    const u = me();
    const mine = u.role === 'requester';
    const type = params.get('type') || 'ALL';
    let list = db.budgets.filter((b) => !mine || b.ownerId === u.id);
    if (type !== 'ALL') list = list.filter((b) => b.type === type);
    const base = mine ? '#/my-budgets' : '#/budgets';
    const tab = (t, label) => '<a href="' + base + (t === 'ALL' ? '' : '?type=' + t) + '"' +
      (type === t ? ' class="active"' : '') + '>' + label + '</a>';

    let html = '<div class="page-head"><h1>' + (mine ? 'งบของฉัน' : 'จัดการงบประมาณ') + '</h1>' +
      (u.role === 'finance' ? '<a class="btn primary" href="#/budget/new">+ บันทึกงบที่อนุมัติแล้ว</a>' : '') +
      '</div>' + takeFlash() +
      '<div class="tabs">' + tab('ALL', 'ทั้งหมด') + tab('CAPEX', 'งบลงทุน (CAPEX)') + tab('CBS', 'งบโครงการ (CBS)') + '</div>';

    if (!list.length) {
      return html + '<div class="card empty">' +
        (mine ? 'ยังไม่มีงบที่การเงินบันทึกไว้ให้คุณ' : 'ยังไม่มีงบประมาณ') + '</div>';
    }

    html += '<div class="grid">' + list.map((b) => {
      const us = usage(b);
      return '<div class="card budget-card">' +
        badge(b.type, b.type) + ' <span class="muted">' + esc(b.code) + '</span>' +
        '<h3>' + esc(b.name) + '</h3>' +
        '<div class="muted">' + esc(b.department) + ' · ปีงบ ' + esc(b.fiscalYear) +
        (mine ? '' : ' · ผู้ขอใช้งบ: ' + esc(userName(b.ownerId))) + '</div>' +
        usageKv(us) + usageBar(us) +
        '<div class="actions">' +
        '<a class="btn" href="#/budget/' + b.id + '">รายละเอียด</a>' +
        (mine && b.ownerId === u.id ? '<a class="btn primary" href="#/request/new/' + b.id + '">ขอใช้งบ</a>' : '') +
        (u.role === 'finance' ? '<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไข</a>' : '') +
        '</div></div>';
    }).join('') + '</div>';
    return html;
  }

  function viewBudgetForm(id) {
    const u = me();
    if (u.role !== 'finance') return '<div class="alert error">เฉพาะการเงินเท่านั้นที่บันทึก/แก้ไขงบได้</div>';
    const b = id ? budgetById(id) : null;
    if (id && !b) return notFound();
    const hasRequests = b && db.requests.some((r) => r.budgetId === b.id);
    const v = b || {
      type: 'CAPEX', code: '', name: '', fiscalYear: new Date().getFullYear(), department: '',
      ownerId: 'req1', amount: '', items: [{ id: '', code: '01', name: '', amount: '' }], note: ''
    };
    const requesters = USERS.filter((x) => x.role === 'requester');
    const opt = (list, sel) => list.map((x) =>
      '<option value="' + x.id + '"' + (x.id === sel ? ' selected' : '') + '>' + esc(x.name + ' — ' + x.title) + '</option>').join('');
    const items = v.items.length ? v.items : [{ id: '', code: '01', name: '', amount: '' }];

    return '<h1>' + (b ? 'แก้ไขงบ ' + esc(b.code) : 'บันทึกงบที่ได้รับอนุมัติ') + '</h1>' +
      '<div id="formError"></div>' +
      '<form id="budgetForm" class="card" data-id="' + esc(id || '') + '">' +
      '<div class="row">' +
      '<label class="field"><span>ประเภทงบ</span><select name="type"' + (hasRequests ? ' disabled' : '') + '>' +
      ['CAPEX', 'CBS'].map((t) => '<option value="' + t + '"' + (v.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>').join('') +
      '</select></label>' +
      '<label class="field"><span>รหัสงบ / รหัสโครงการ</span><input name="code" required value="' + esc(v.code) + '"></label>' +
      '<label class="field"><span>ปีงบประมาณ</span><input name="fiscalYear" type="number" required value="' + esc(v.fiscalYear) + '"></label>' +
      '</div>' +
      '<label class="field"><span>ชื่องบ / ชื่อโครงการ</span><input name="name" required value="' + esc(v.name) + '"></label>' +
      '<div class="row">' +
      '<label class="field"><span>หน่วยงาน</span><input name="department" required value="' + esc(v.department) + '"></label>' +
      '<label class="field"><span>ผู้ขอใช้งบ (เจ้าของงบ)</span><select name="ownerId">' + opt(requesters, v.ownerId) + '</select></label>' +
      '</div>' +
      '<div data-for="CAPEX"' + (v.type === 'CAPEX' ? '' : ' hidden') + '>' +
      '<label class="field"><span>วงเงินงบลงทุนที่อนุมัติ (บาท)</span><input name="amount" type="number" min="0" step="0.01" value="' + esc(v.amount) + '"></label>' +
      '</div>' +
      '<fieldset data-for="CBS"' + (v.type === 'CBS' ? '' : ' hidden') + '><legend>โครงสร้างต้นทุนโครงการ (Cost Breakdown)</legend>' +
      '<div class="table-wrap"><table><thead><tr><th style="width:6rem">รหัส</th><th>รายการต้นทุน</th><th class="num" style="width:12rem">วงเงิน (บาท)</th><th style="width:3rem"></th></tr></thead>' +
      '<tbody id="itemRows">' + items.map(itemRow).join('') + '</tbody></table></div>' +
      '<div class="actions" style="margin-bottom:1rem"><button type="button" class="btn small" id="addItem">+ เพิ่มรายการ</button>' +
      '<span class="muted">รวม <strong id="itemTotal">' + money(items.reduce((s, i) => s + Number(i.amount || 0), 0)) + '</strong> บาท</span></div>' +
      '</fieldset>' +
      '<label class="field"><span>หมายเหตุ / เลขที่เอกสารอนุมัติงบ</span><textarea name="note">' + esc(v.note) + '</textarea></label>' +
      '<div class="actions"><button class="btn primary" type="submit">บันทึก</button>' +
      '<a class="btn" href="#/budgets">ยกเลิก</a>' +
      (b && !hasRequests ? '<button type="button" class="btn bad" id="deleteBudget">ลบงบนี้</button>' : '') +
      '</div></form>';
  }

  function itemRow(i) {
    const locked = i.id && db.requests.some((r) => r.itemId === i.id);
    return '<tr data-item-id="' + esc(i.id) + '">' +
      '<td><input name="itemCode" value="' + esc(i.code) + '" required></td>' +
      '<td><input name="itemName" value="' + esc(i.name) + '" required></td>' +
      '<td><input name="itemAmount" type="number" min="0" step="0.01" class="right" value="' + esc(i.amount) + '" required></td>' +
      '<td>' + (locked ? '' : '<button type="button" class="btn small bad" data-remove-item title="ลบ">×</button>') + '</td></tr>';
  }

  function bindBudgetForm() {
    const form = document.getElementById('budgetForm');
    if (!form) return;
    const typeSel = form.elements.type;
    const sync = () => {
      const t = typeSel.value;
      form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== t; });
      // ช่องที่ซ่อนอยู่ต้องไม่ถูกบังคับกรอก
      form.querySelectorAll('[data-for="CBS"] input').forEach((el) => { el.required = t === 'CBS'; });
      form.elements.amount.required = t === 'CAPEX';
    };
    const recalc = () => {
      let s = 0;
      form.querySelectorAll('input[name="itemAmount"]').forEach((el) => { s += Number(el.value || 0); });
      document.getElementById('itemTotal').textContent = money(s);
    };
    typeSel.addEventListener('change', sync);
    sync();
    form.addEventListener('input', (e) => { if (e.target.name === 'itemAmount') recalc(); });
    form.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-item]')) {
        const rows = form.querySelectorAll('#itemRows tr');
        if (rows.length > 1) { e.target.closest('tr').remove(); recalc(); }
      }
    });
    document.getElementById('addItem').addEventListener('click', () => {
      const n = form.querySelectorAll('#itemRows tr').length + 1;
      document.getElementById('itemRows').insertAdjacentHTML('beforeend',
        itemRow({ id: '', code: String(n).padStart(2, '0'), name: '', amount: '' }));
      sync();
    });
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
      const type = existing && f.type.disabled ? existing.type : f.type.value;
      const errors = [];
      const code = f.code.value.trim();
      if (db.budgets.some((b) => b.code === code && b.id !== id)) errors.push('รหัสงบ "' + code + '" มีอยู่แล้ว');

      let amount = 0;
      let items = [];
      if (type === 'CAPEX') {
        amount = round2(f.amount.value);
        if (!(amount > 0)) errors.push('กรุณาระบุวงเงินที่มากกว่า 0');
        if (existing) {
          const u = usage(existing);
          if (amount < u.used + u.reserved) {
            errors.push('วงเงินต้องไม่น้อยกว่ายอดที่ใช้/จองไปแล้ว (' + money(u.used + u.reserved) + ' บาท)');
          }
        }
      } else {
        form.querySelectorAll('#itemRows tr').forEach((tr) => {
          const itemId = tr.dataset.itemId || nextId('i');
          const it = {
            id: itemId,
            code: tr.querySelector('[name="itemCode"]').value.trim(),
            name: tr.querySelector('[name="itemName"]').value.trim(),
            amount: round2(tr.querySelector('[name="itemAmount"]').value)
          };
          if (existing && tr.dataset.itemId) {
            const u = usage(existing, itemId);
            if (it.amount < u.used + u.reserved) {
              errors.push('รายการ ' + it.code + ' ต้องมีวงเงินไม่น้อยกว่ายอดที่ใช้/จองแล้ว (' + money(u.used + u.reserved) + ' บาท)');
            }
          }
          items.push(it);
        });
        if (!items.length) errors.push('ต้องมีรายการต้นทุนอย่างน้อย 1 รายการ');
        if (items.some((i) => !(i.amount > 0))) errors.push('วงเงินแต่ละรายการต้องมากกว่า 0');
      }

      if (errors.length) {
        document.getElementById('formError').innerHTML =
          '<div class="alert error">' + errors.map(esc).join('<br>') + '</div>';
        window.scrollTo(0, 0);
        return;
      }

      const data = {
        type, code,
        name: f.name.value.trim(),
        fiscalYear: Number(f.fiscalYear.value),
        department: f.department.value.trim(),
        ownerId: f.ownerId.value,
        amount: type === 'CAPEX' ? amount : 0,
        items: type === 'CBS' ? items : [],
        note: f.note.value.trim()
      };
      if (existing) {
        Object.assign(existing, data, { updatedAt: new Date().toISOString(), updatedBy: me().id });
      } else {
        db.budgets.push(Object.assign({ id: nextId('b'), createdAt: new Date().toISOString(), createdBy: me().id }, data));
      }
      save();
      setFlash('success', 'บันทึกงบ ' + code + ' เรียบร้อยแล้ว');
      go('#/budgets');
    });
  }

  function viewBudgetDetail(id) {
    const b = budgetById(id);
    if (!b) return notFound();
    const u = me();
    const us = usage(b);
    const reqs = db.requests.filter((r) => r.budgetId === b.id);
    let html = '<div class="page-head"><h1>' + badge(b.type, b.type) + ' ' + esc(b.name) + '</h1><div class="actions" style="margin:0">' +
      (u.role === 'requester' && b.ownerId === u.id ? '<a class="btn primary" href="#/request/new/' + b.id + '">ขอใช้งบ</a>' : '') +
      (u.role === 'finance' ? '<a class="btn" href="#/budget/' + b.id + '/edit">แก้ไข</a>' : '') +
      '</div></div>' +
      '<div class="grid"><div class="card"><dl class="kv">' +
      '<dt>ประเภท</dt><dd>' + TYPE_LABEL[b.type] + '</dd>' +
      '<dt>รหัส</dt><dd>' + esc(b.code) + '</dd>' +
      '<dt>ปีงบประมาณ</dt><dd>' + esc(b.fiscalYear) + '</dd>' +
      '<dt>หน่วยงาน</dt><dd>' + esc(b.department) + '</dd>' +
      '<dt>ผู้ขอใช้งบ</dt><dd>' + esc(userName(b.ownerId)) + '</dd>' +
      (b.note ? '<dt>หมายเหตุ</dt><dd>' + esc(b.note) + '</dd>' : '') +
      '</dl></div><div class="card">' + usageKv(us) + usageBar(us) + '</div></div>';

    if (b.type === 'CBS') {
      html += '<h2>โครงสร้างต้นทุนโครงการ</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>รหัส</th><th>รายการ</th><th class="num">งบที่ได้รับ</th><th class="num">ใช้แล้ว</th>' +
        '<th class="num">รอตรวจสอบ</th><th class="num">คงเหลือ</th></tr></thead><tbody>' +
        b.items.map((i) => {
          const iu = usage(b, i.id);
          return '<tr><td>' + esc(i.code) + '</td><td>' + esc(i.name) + '</td><td class="num">' + money(iu.approved) +
            '</td><td class="num">' + money(iu.used) + '</td><td class="num">' + money(iu.reserved) +
            '</td><td class="num"><strong>' + money(iu.remaining) + '</strong></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '<h2>ประวัติการขอใช้งบ</h2>' + requestTable(reqs, false);
    return html;
  }

  function viewRequestForm(budgetId, requestId) {
    const existing = requestId ? requestById(requestId) : null;
    if (requestId && !existing) return notFound();
    const b = budgetById(existing ? existing.budgetId : budgetId);
    if (!b) return notFound();
    const u = me();
    if (b.ownerId !== u.id) return '<div class="alert error">คุณไม่ใช่ผู้ขอใช้งบของงบนี้</div>';
    if (existing && existing.status !== 'rejected') return '<div class="alert error">แก้ไขได้เฉพาะคำขอที่ไม่ได้รับอนุมัติเท่านั้น</div>';
    const us = usage(b);
    const v = existing ? Object.assign({ purpose: existing.purpose, amount: existing.amount }, existing.details) : { qty: 1 };
    const val = (k) => ' value="' + esc(v[k] == null ? '' : v[k]) + '"';

    let typeFields;
    if (b.type === 'CAPEX') {
      typeFields = '<fieldset><legend>รายละเอียดสินทรัพย์ (CAPEX)</legend>' +
        '<label class="field"><span>ชื่อสินทรัพย์ / รายการที่จะลงทุน</span><input name="assetName" required' + val('assetName') + '></label>' +
        '<div class="row">' +
        '<label class="field"><span>จำนวน</span><input name="qty" type="number" min="1" step="1" required' + val('qty') + '></label>' +
        '<label class="field"><span>อายุการใช้งานโดยประมาณ (ปี)</span><input name="usefulLife" type="number" min="1" step="1" required' + val('usefulLife') + '></label>' +
        '<label class="field"><span>เลขที่ใบเสนอราคาอ้างอิง</span><input name="quotationRef" placeholder="ถ้ามี"' + val('quotationRef') + '></label>' +
        '</div>' +
        '<label class="field"><span>เหตุผลความจำเป็น / ประโยชน์ที่คาดว่าจะได้รับ</span><textarea name="justification" required>' +
        esc(v.justification || '') + '</textarea></label>' +
        '</fieldset>';
    } else {
      typeFields = '<fieldset><legend>รายละเอียดการใช้งบโครงการ (CBS)</legend>' +
        '<label class="field"><span>รายการต้นทุน (Cost Breakdown) ที่จะใช้</span><select name="itemId" required>' +
        '<option value="">— เลือกรายการ —</option>' +
        b.items.map((i) => {
          const iu = usage(b, i.id);
          return '<option value="' + i.id + '"' + (iu.remaining <= 0 ? ' disabled' : '') + '>' +
            esc(i.code + ' ' + i.name) + ' — คงเหลือ ' + money(iu.remaining) + ' บาท</option>';
        }).join('') + '</select></label>' +
        '<label class="field"><span>งาน / งวดงานที่เกี่ยวข้อง</span><input name="workPackage" required placeholder="เช่น งวดที่ 2 งานเทฐานราก"></label>' +
        '</fieldset>';
    }

    const lastReject = existing ? existing.steps.find((s) => s.status === 'rejected') : null;
    return '<h1>' + (existing ? 'แก้ไขคำขอ ' + esc(existing.no) : 'จัดทำเอกสารขอเบิกใช้งบ') + ': ' + esc(b.name) + '</h1>' +
      (lastReject ? '<div class="alert error">เหตุผลที่ไม่อนุมัติ: ' + esc(lastReject.comment) + '</div>' : '') +
      '<div class="alert info">' + badge(b.type, b.type) + ' ' + esc(b.code) +
      ' · งบคงเหลือ <strong>' + money(us.remaining) + '</strong> บาท<br>' +
      (b.type === 'CAPEX'
        ? 'เอกสารจะถูกส่งให้ฝ่ายการเงินตรวจสอบ เมื่ออนุมัติแล้วจึงได้เอกสารการเบิกขอใช้งบประมาณ'
        : 'งบโครงการไม่ต้องผ่านฝ่ายการเงิน — ได้เอกสารการเบิกขอใช้งบประมาณทันทีเมื่อบันทึก') + '</div>' +
      '<div id="formError"></div>' +
      '<form id="requestForm" class="card" data-budget="' + b.id + '" data-request="' + esc(requestId || '') + '">' +
      '<label class="field"><span>วัตถุประสงค์การขอใช้งบ</span><input name="purpose" required' + val('purpose') + '></label>' +
      '<label class="field"><span>จำนวนเงินที่ขอใช้ (บาท)</span><input name="amount" type="number" min="0.01" step="0.01" required' + val('amount') + '></label>' +
      typeFields +
      '<div class="actions"><button class="btn primary" type="submit">' +
      (b.type === 'CAPEX' ? (existing ? 'ส่งเอกสารให้ฝ่ายการเงินอีกครั้ง' : 'ส่งเอกสารให้ฝ่ายการเงิน') : 'จัดทำเอกสาร') + '</button>' +
      '<a class="btn" href="' + (existing ? '#/request/' + existing.id : '#/budget/' + b.id) + '">ยกเลิก</a></div></form>';
  }

  function bindRequestForm() {
    const form = document.getElementById('requestForm');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      const b = budgetById(form.dataset.budget);
      const existing = form.dataset.request ? requestById(form.dataset.request) : null;
      const amount = round2(f.amount.value);
      const itemId = b.type === 'CBS' ? f.itemId.value : null;
      const avail = usage(b, itemId).remaining;
      const errors = [];
      if (!(amount > 0)) errors.push('จำนวนเงินต้องมากกว่า 0');
      if (amount > avail) {
        errors.push('จำนวนเงินเกินงบคงเหลือ' + (itemId ? 'ของรายการต้นทุนนี้' : '') + ' (คงเหลือ ' + money(avail) + ' บาท)');
      }
      if (errors.length) {
        document.getElementById('formError').innerHTML = '<div class="alert error">' + errors.map(esc).join('<br>') + '</div>';
        return;
      }
      const now = new Date().toISOString();
      const fields = {
        amount,
        purpose: f.purpose.value.trim(),
        details: b.type === 'CAPEX'
          ? {
            assetName: f.assetName.value.trim(), qty: Number(f.qty.value), usefulLife: Number(f.usefulLife.value),
            quotationRef: f.quotationRef.value.trim(), justification: f.justification.value.trim()
          }
          : { workPackage: f.workPackage.value.trim() }
      };

      let r;
      if (existing) {
        // แก้ไขแล้วส่งใหม่: เก็บผลตรวจสอบรอบก่อนไว้เป็นประวัติ
        r = existing;
        r.history = (r.history || []).concat(r.steps);
        Object.assign(r, fields, { status: 'pending', steps: stepsFor(b), resubmittedAt: now });
      } else {
        r = Object.assign({
          id: nextId('r'),
          no: nextNo('req'),
          budgetId: b.id,
          type: b.type,
          itemId,
          requesterId: me().id,
          createdAt: now,
          status: 'pending',
          steps: stepsFor(b),
          history: []
        }, fields);
        db.requests.push(r);
      }

      if (!r.steps.length) {
        // CBS: ไม่ต้องผ่านการเงิน ออกเอกสารทันที
        issueDocument(r, now);
        setFlash('success', 'จัดทำเอกสารเรียบร้อย เลขที่ ' + r.docNo);
      } else {
        setFlash('success', (existing ? 'ส่งคำขอ ' + r.no + ' อีกครั้ง' : 'ส่งคำขอ ' + r.no) + ' เรียบร้อยแล้ว รอฝ่ายการเงินตรวจสอบ');
      }
      save();
      go('#/request/' + r.id);
    });
  }

  function issueDocument(r, at) {
    r.status = 'approved';
    r.approvedAt = at;
    r.docNo = nextNo(r.type);
  }

  function requestTable(list, showBudget) {
    if (!list.length) return '<div class="card empty">ยังไม่มีคำขอใช้งบ</div>';
    list = list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return '<div class="table-wrap"><table><thead><tr><th>เลขที่คำขอ</th>' +
      (showBudget ? '<th>งบ</th>' : '') +
      '<th>วัตถุประสงค์</th><th>ผู้ขอ</th><th class="num">จำนวนเงิน</th><th>สถานะ</th><th>เอกสาร</th></tr></thead><tbody>' +
      list.map((r) => {
        const b = budgetById(r.budgetId);
        const step = currentStep(r);
        return '<tr><td class="nowrap"><a href="#/request/' + r.id + '">' + esc(r.no) + '</a><div class="muted">' + fmtDate(r.createdAt) + '</div></td>' +
          (showBudget ? '<td>' + badge(r.type, r.type) + ' ' + esc(b ? b.code : '-') + '</td>' : '') +
          '<td>' + esc(r.purpose) + '</td><td>' + esc(userName(r.requesterId)) + '</td>' +
          '<td class="num">' + money(r.amount) + '</td>' +
          '<td>' + badge(r.status, STATUS_LABEL[r.status]) +
          (step ? '<div class="muted">รอ: ' + esc(stepAssigneeText(step)) + '</div>' : '') + '</td>' +
          '<td>' + (r.docNo ? '<a href="#/doc/' + r.id + '">' + esc(r.docNo) + '</a>' : '-') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function viewRequests() {
    const u = me();
    const list = u.role === 'requester' ? db.requests.filter((r) => r.requesterId === u.id) : db.requests;
    return '<h1>' + (u.role === 'requester' ? 'คำขอของฉัน' : 'คำขอใช้งบทั้งหมด') + '</h1>' + takeFlash() + requestTable(list, true);
  }

  function viewApprovals() {
    return '<h1>เอกสาร CAPEX รอตรวจสอบ</h1>' + takeFlash() + requestTable(inbox(me()), true);
  }

  function viewRequestDetail(id) {
    const r = requestById(id);
    if (!r) return notFound();
    const b = budgetById(r.budgetId);
    const u = me();
    const step = currentStep(r);
    const item = r.itemId ? b.items.find((i) => i.id === r.itemId) : null;
    const d = r.details;

    let html = takeFlash() + '<div class="page-head"><h1>คำขอใช้งบ ' + esc(r.no) + ' ' + badge(r.status, STATUS_LABEL[r.status]) + '</h1>' +
      (r.docNo ? '<a class="btn primary" href="#/doc/' + r.id + '">เปิดเอกสารเลขที่ ' + esc(r.docNo) + '</a>' : '') + '</div>';

    html += '<div class="grid"><div class="card"><dl class="kv">' +
      '<dt>งบ</dt><dd>' + badge(b.type, b.type) + ' <a href="#/budget/' + b.id + '">' + esc(b.code) + '</a></dd>' +
      '<dt>ชื่องบ</dt><dd>' + esc(b.name) + '</dd>' +
      (item ? '<dt>รายการต้นทุน</dt><dd>' + esc(item.code + ' ' + item.name) + '</dd>' : '') +
      '<dt>วัตถุประสงค์</dt><dd>' + esc(r.purpose) + '</dd>' +
      '<dt>ผู้ขอ</dt><dd>' + esc(userName(r.requesterId)) + '</dd>' +
      '<dt>วันที่ขอ</dt><dd>' + fmtDate(r.createdAt) + '</dd>' +
      '<dt>จำนวนเงิน</dt><dd class="big">' + money(r.amount) + ' บาท</dd>' +
      (r.type === 'CAPEX'
        ? '<dt>สินทรัพย์</dt><dd>' + esc(d.assetName) + ' × ' + esc(d.qty) + '</dd>' +
          '<dt>อายุการใช้งาน</dt><dd>' + esc(d.usefulLife) + ' ปี</dd>' +
          (d.quotationRef ? '<dt>ใบเสนอราคา</dt><dd>' + esc(d.quotationRef) + '</dd>' : '') +
          '<dt>เหตุผล</dt><dd>' + esc(d.justification) + '</dd>'
        : '<dt>งาน / งวดงาน</dt><dd>' + esc(d.workPackage) + '</dd>') +
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
      html += '<p class="muted">งบโครงการ (CBS) ไม่ต้องผ่านฝ่ายการเงิน — ออกเอกสารทันทีเมื่อ' + fmtDate(r.approvedAt) + '</p>';
    }
    if (r.history && r.history.length) {
      html += '<div class="muted">รอบก่อนหน้า</div><ol class="steps">' + r.history.map(stepItem).join('') + '</ol>' +
        '<div class="muted">รอบปัจจุบัน (ส่งใหม่ ' + fmtDate(r.resubmittedAt) + ')</div>';
    }
    html += '<ol class="steps">' + r.steps.map(stepItem).join('') + '</ol>';

    if (canAct(u, step)) {
      html += '<form id="decisionForm" data-id="' + r.id + '">' +
        '<label class="field"><span>เหตุผล (จำเป็นเมื่อไม่อนุมัติ เช่น ควรใช้งบตัวไหนแทน)</span><textarea name="comment"></textarea></label>' +
        '<div class="actions"><button class="btn ok" type="submit" data-decision="approved">อนุมัติเอกสาร</button>' +
        '<button class="btn bad" type="submit" data-decision="rejected">ไม่อนุมัติ</button></div></form>';
    }
    if ((r.status === 'pending' || r.status === 'rejected') && r.requesterId === u.id) {
      html += '<div class="actions">' +
        (r.status === 'rejected' ? '<a class="btn primary" href="#/request/' + r.id + '/edit">แก้ไขและส่งใหม่</a>' : '') +
        '<button class="btn bad" id="cancelRequest" data-id="' + r.id + '">ยกเลิกคำขอ</button></div>';
    }
    html += '</div></div>';
    return html;
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
        const step = currentStep(r);
        const u = me();
        if (!canAct(u, step)) return;
        const comment = form.elements.comment.value.trim();
        if (decision === 'rejected' && !comment) {
          alert('กรุณาแจ้งเหตุผลที่ไม่อนุมัติ');
          return;
        }
        if (decision === 'approved' && step.key === 'fin') {
          // ตรวจซ้ำว่ายอดยังไม่เกินงบ (คำขอนี้ถูกจองไว้แล้ว จึงคิดเฉพาะยอดที่ออกเอกสารไปแล้ว)
          const b = budgetById(r.budgetId);
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
        } else if (!currentStep(r)) {
          issueDocument(r, step.at);
          setFlash('success', 'อนุมัติเอกสารแล้ว ออกเอกสารการเบิกขอใช้งบประมาณเลขที่ ' + r.docNo);
        } else {
          setFlash('success', 'ตรวจสอบแล้ว ส่งต่อให้ ' + stepAssigneeText(currentStep(r)));
        }
        save();
        go('#/request/' + r.id);
      });
    }
    const cancel = document.getElementById('cancelRequest');
    if (cancel) {
      cancel.addEventListener('click', () => {
        if (!confirm('ยืนยันการยกเลิกคำขอนี้?')) return;
        const r = requestById(cancel.dataset.id);
        r.status = 'cancelled';
        r.cancelledAt = new Date().toISOString();
        save();
        setFlash('info', 'ยกเลิกคำขอ ' + r.no + ' แล้ว');
        go('#/request/' + r.id);
      });
    }
  }

  /** เอกสารการเบิกขอใช้งบประมาณ — สำหรับแนบตอนขอซื้อ */
  function viewDocument(id) {
    const r = requestById(id);
    if (!r) return notFound();
    if (r.status !== 'approved') return '<div class="alert error">คำขอนี้ยังไม่ได้รับอนุมัติจากฝ่ายการเงิน จึงยังไม่มีเอกสาร</div>';
    const b = budgetById(r.budgetId);
    const item = r.itemId ? b.items.find((i) => i.id === r.itemId) : null;
    const d = r.details;

    // ยอดงบ ณ วันที่ออกเอกสาร: นับเอกสารที่ออกก่อนหน้าใบนี้ (รวมใบนี้) ในงบ/รายการเดียวกัน
    const scope = (x) => x.budgetId === b.id && (!r.itemId || x.itemId === r.itemId);
    const approvedTotal = item ? Number(item.amount) : budgetTotal(b);
    const usedBefore = round2(db.requests
      .filter((x) => scope(x) && x.status === 'approved' && x.id !== r.id && x.approvedAt <= r.approvedAt)
      .reduce((s, x) => s + x.amount, 0));
    const remainingAfter = round2(approvedTotal - usedBefore - r.amount);

    const title = r.type === 'CAPEX' ? 'เอกสารการเบิกขอใช้งบลงทุน (CAPEX)' : 'เอกสารการเบิกขอใช้งบโครงการ (CBS)';
    const rows = [
      ['รหัสงบ', esc(b.code)],
      [r.type === 'CAPEX' ? 'ชื่องบลงทุน' : 'ชื่อโครงการ', esc(b.name)],
      ['หน่วยงาน', esc(b.department)],
      ['ปีงบประมาณ', esc(b.fiscalYear)]
    ];
    if (item) rows.push(['รายการต้นทุน (CBS)', esc(item.code + ' ' + item.name)]);
    rows.push(['เลขที่คำขอใช้งบ', esc(r.no)], ['ผู้ขอใช้งบ', esc(userName(r.requesterId))], ['วัตถุประสงค์', esc(r.purpose)]);
    if (r.type === 'CAPEX') {
      rows.push(['สินทรัพย์', esc(d.assetName) + ' จำนวน ' + esc(d.qty)], ['อายุการใช้งาน', esc(d.usefulLife) + ' ปี']);
      if (d.quotationRef) rows.push(['ใบเสนอราคาอ้างอิง', esc(d.quotationRef)]);
      rows.push(['เหตุผลความจำเป็น', esc(d.justification)]);
    } else {
      rows.push(['งาน / งวดงาน', esc(d.workPackage)]);
    }

    return '<div class="actions no-print" style="margin:0 0 1rem">' +
      '<button class="btn primary" onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button>' +
      '<a class="btn" href="#/request/' + r.id + '">กลับไปที่คำขอ</a></div>' +
      '<article class="doc">' +
      '<header><div><h1>' + title + '</h1><div>Budget Utilization Document</div></div>' +
      '<div class="docno">เลขที่ <strong>' + esc(r.docNo) + '</strong><br>วันที่ออกเอกสาร ' + fmtDate(r.approvedAt) +
      (r.steps.length ? '<br><span class="stamp">การเงินอนุมัติ</span>' : '') + '</div></header>' +
      '<div class="section"><table><tbody>' +
      rows.map(([k, v]) => '<tr><th style="width:32%">' + k + '</th><td>' + v + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="section"><h2>สรุปงบประมาณ</h2><table><tbody>' +
      '<tr><th style="width:60%">งบที่ได้รับอนุมัติ' + (item ? ' (รายการนี้)' : '') + '</th><td class="num">' + money(approvedTotal) + '</td></tr>' +
      '<tr><th>ใช้ไปก่อนหน้า</th><td class="num">' + money(usedBefore) + '</td></tr>' +
      '<tr><th>ใช้ครั้งนี้</th><td class="num"><strong>' + money(r.amount) + '</strong></td></tr>' +
      '<tr><th>คงเหลือหลังใช้ครั้งนี้</th><td class="num">' + money(remainingAfter) + '</td></tr>' +
      '</tbody></table></div>' +
      (r.steps.length ? '<div class="section"><h2>ผู้ตรวจสอบ</h2><table><thead><tr><th>ขั้นตอน</th><th>ผู้ตรวจสอบ</th><th>วันที่</th><th>ความเห็น</th></tr></thead><tbody>' +
      r.steps.map((s) => '<tr><td>' + esc(s.label) + '</td><td>' + esc(userName(s.by)) + '<br><span class="muted">' +
        esc((user(s.by) || {}).title || '') + '</span></td><td class="nowrap">' + fmtDate(s.at) + '</td><td>' + esc(s.comment || '-') + '</td></tr>').join('') +
      '</tbody></table></div>' : '') +
      '<div class="signs"><div><div class="line"></div>ผู้ขอใช้งบ<br>' + esc(userName(r.requesterId)) + '</div>' +
      r.steps.map((s) => '<div><div class="line"></div>' + esc((user(s.by) || {}).title || '') + '<br>' + esc(userName(s.by)) + '</div>').join('') +
      '</div>' +
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
    const app = document.getElementById('app');
    let html;

    if (parts[0] === 'budgets' || parts[0] === 'my-budgets') html = viewBudgets(params);
    else if (parts[0] === 'budget' && parts[1] === 'new') html = viewBudgetForm(null);
    else if (parts[0] === 'budget' && parts[2] === 'edit') html = viewBudgetForm(parts[1]);
    else if (parts[0] === 'budget') html = viewBudgetDetail(parts[1]);
    else if (parts[0] === 'request' && parts[1] === 'new') html = viewRequestForm(parts[2], null);
    else if (parts[0] === 'request' && parts[2] === 'edit') html = viewRequestForm(null, parts[1]);
    else if (parts[0] === 'request') html = viewRequestDetail(parts[1]);
    else if (parts[0] === 'requests') html = viewRequests();
    else if (parts[0] === 'approvals') html = viewApprovals();
    else if (parts[0] === 'doc') html = viewDocument(parts[1]);
    else html = notFound();

    renderNav('#/' + path);
    app.innerHTML = html;
    bindBudgetForm();
    bindRequestForm();
    bindRequestDetail();
    window.scrollTo(0, 0);
  }

  function init() {
    const sel = document.getElementById('userSelect');
    sel.innerHTML = USERS.map((u) =>
      '<option value="' + u.id + '">' + esc(u.name + ' (' + ROLE_LABEL[u.role] + ')') + '</option>').join('');
    sel.value = me().id;
    sel.addEventListener('change', () => {
      currentUserId = sel.value;
      try { localStorage.setItem(DB_KEY + '.user', currentUserId); } catch (e) { /* ignore */ }
      go(homeFor(me()));
    });
    document.getElementById('resetData').addEventListener('click', () => {
      if (!confirm('ล้างข้อมูลทั้งหมดและกลับไปใช้ข้อมูลตัวอย่าง?')) return;
      db = seed();
      save();
      go(homeFor(me()));
    });
    window.addEventListener('hashchange', render);
    render();
  }

  init();
})();
