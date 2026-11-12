# คู่มือสไตล์ของระบบ (Theme & UI)

สไตล์หลักของเว็บนี้อ้างอิงคู่มือที่เจ้าของระบบกำหนด — **ใช้เป็นหลักจนกว่าเจ้าของระบบจะสั่งเปลี่ยนบางอย่าง**
ค่าจริงอยู่ที่ `css/style.css` (token ที่ `:root` บนสุด และ "Theme layer" ท้ายไฟล์) ไฟล์นี้เป็นแผนที่ ไม่ใช่ต้นฉบับ

## หลักการ

- Component ชนิดเดียวกันต้องหน้าตาเหมือนกันทุกหน้า — ก่อนทำปุ่ม / dropdown / แท็บ / หัวหน้า / สวิตช์ / modal ใหม่ ให้หา class ที่มีอยู่แล้วแล้ว reuse ตรงๆ ห้ามสร้าง variant ต่อหน้า
- ถ้าต้องต่างจริง (ตำแหน่ง / ระยะ) เติม modifier ที่แตะแค่ layout เท่านั้น ห้ามแตะขนาด / ฟอนต์ / สี
- ธีมสว่างอย่างเดียว (`<html data-theme="light">`) ไม่มี build step (HTML / CSS / JS ล้วน, stylesheet เดียว)
- ห้ามใช้ hex ตรงๆ ใน component ใหม่ถ้ามี token — ต้องการสีใหม่ให้ถามผู้ใช้ก่อน
- ข้อความที่ไม่มีข้อมูล ขึ้น "ไม่มีข้อมูล" / "–" ห้ามแต่งตัวเลข
- เอกสารที่พิมพ์ (ใบเบิกใช้งบ, Memo, แบบฟอร์มขออนุมัติ) เป็นขาวดำตามแบบฟอร์ม ไม่ใช้เงา / สีของธีม

## ฟอนต์ (Google Fonts ใน `<head>`)

| ใช้กับ | ฟอนต์ |
|---|---|
| เนื้อความ / ฟอร์ม / ตาราง / เมนู | Sarabun (fallback Noto Sans Thai) |
| หัวข้อ h1–h3, ตัวเลขเด่น (`.kpi-value`, `.total-amount`) | Kanit |
| รหัส / โค้ด (`.mono`, `code`) | IBM Plex Mono |

ขนาด: ชื่อหน้า 22px (ทุกหน้า รวมมือถือ) · หัวข้อย่อย 18px · หัวแผง 16.5px · เนื้อหา / ตาราง / เมนู 13px · ป้ายเล็ก 11–12.5px · ตัวเลขใน stat tile 28px (Kanit 700)

## สี (token ใน `:root`)

| Token | ค่า | ใช้กับ |
|---|---|---|
| `--paper` | `#F4F7FB` | พื้นหลังหน้า |
| `--surface` / `--surface-2` | `#FFFFFF` / `#EDF2F8` | การ์ด แผง หัว เมนู / hover พื้นรอง ปุ่ม disabled |
| `--ink` / `--ink-soft` | `#16233A` / `#5B6A80` | ตัวอักษรหลัก / รอง |
| `--line` / `--line-strong` | `#DDE4EE` / `#BFCAD9` | เส้นขอบทั่วไป / ปุ่มและช่องกรอก |
| `--brand` / `--brand-soft` | `#1B4F8A` / `#E8EFF7` | ปุ่มหลัก แท็บที่เลือก สวิตช์ |
| `--decision` / `--decision-soft` | `#8E6B1C` / `#F6EFDC` | กล่องคำเตือนโทนเหลือง |
| `--app-accent` / `-soft` / `--app-brand-text` | `#2563EB` / `#EAF1FE` / `#1A9AD6` | เมนูซ้ายที่เลือก ไอคอนผู้ใช้ ปุ่มกลับ / ชื่อระบบ |
| `--rd` `--prod` `--main-dept` | `#1B4F8A` `#0E6E7F` `#6B4FA0` | สีประจำสาย (แท็ก) — CAPEX = `--main-dept`, OPEX = `--prod` |
| `--ok` `--warn` `--bad` (+ `-bg`) | `#15803D` `#B45309` `#C53030` | ป้ายสถานะ ok / wip / fail |
| `--shadow` | `0 1px 2px rgba(22,35,58,.06), 0 4px 14px rgba(22,35,58,.06)` | เงาการ์ด |

ชื่อเดิมที่โค้ดใช้อยู่ (`--bg`, `--text`, `--muted`, `--border`, `--primary` ฯลฯ) ชี้ไปที่ token ด้านบนแล้ว

## โครงหน้า

- Header: สูง ≥ 72px พื้นขาว เส้นล่าง `--line` sticky — ชื่อระบบ Sarabun 700 21px สี `--app-brand-text` (ไม่มีโลโก้) ขวา = ชิปผู้ใช้
- เมนูซ้าย (`.sidebar` / `#nav`): กว้าง 216px sticky หัวกลุ่ม 11px uppercase รายการ 13px ไอคอน 20px รายการที่เลือก = พื้น `--app-accent-soft` ตัว `--app-accent`
- เนื้อหา (`main`): padding `20px clamp(16px, 4vw, 48px) 56px`
- มือถือ (≤ 900px): เมนูซ้ายซ่อน เปิดด้วยปุ่มแฮมเบอร์เกอร์

## Component (class ที่มีอยู่ — ใช้ตรงๆ)

| Component | Class |
|---|---|
| หัวหน้า | `.page-head` > `h1` (22px/700 Kanit), ปุ่มหลัก / ตัวเลือกวางขวาแถวเดียวกัน (`.head-actions`) |
| Dropdown | `select` (+ `.select-wrap` / `.input-wrap`) — Sarabun 13px สูง ~37px มุม 8px ขอบ `--line` ลูกศร SVG |
| แท็บ | `.tabs` > `a` (13.5px/600, เส้นใต้ `--brand` เมื่อเลือก) |
| สวิตช์พิลล์ | `.seg` > `a.active` (พื้น `--brand` ตัวขาว) |
| ปุ่ม | `.btn` (13px/600 มุม 6px), `.btn.primary` (พื้น `--brand`), `.btn.bad`, `.btn.small`; disabled เป็นเทา |
| การ์ด / แผง | `.card`, `.table-wrap` (มุม 14px ขอบ `--line` เงา `--shadow`) |
| การ์ดตัวเลข | `.stat-tiles` > `.stat-tile` (`.stat-label` / `.stat-value` Kanit 28px / `.stat-sub` / `.stat-tile-link` ปุ่มพิลล์ลิงก์) มุม 12px เงา — (หน้ารายงานยังใช้ `.kpis` > `.kpi` แบบเดิม) |
| แผงตาราง | `.rr-panel` > `.rr-panel-head` (`.rr-panel-title` Kanit 16.5px + `.rr-count` พิลล์จำนวนรายการ + `.rr-panel-filters` ตัวกรองชิดขวา) · `.rr-filter-row` (ค้นหา + dropdown 3 ช่อง) · `.rr-table-scroll` > `.rr-data-table` (หัวตารางพื้น `--surface-2`, หัวคอลัมน์เรียงได้ใช้ `.th-sort` + `.sort-ind` ↕ / ▲ / ▼) · `.rr-panel-foot` (แบ่งหน้า) |
| ตาราง | `table` 13px, `th` พื้น `--surface-2`, ตัวเลข `td.num` (tabular-nums) |
| ป้ายสถานะ | `.badge.approved` (ok) `.pending` (wip) `.rejected` / `.cancelled` (fail) `.draft` / `.closed` (none); ป้ายประเภท `.badge.CAPEX` / `.badge.CBS` เป็นแท็กเส้นขอบสีประจำสาย |
| แบนเนอร์เตือน | `.alert.info` / `.success` / `.error` / `.warn` (warn ใช้ `--decision`) |
| สถานะว่าง | `.empty` |
| Modal / ตัวแสดงไฟล์ | `.viewer` (พื้นมืด `rgba(20,20,15,.45)`), panel มุม 14px |
| ฟอร์ม | `.field` (label + input / select), ช่องจำเป็นมี `*` สีแดง |

## ตรวจก่อนส่งงาน

- เทียบ `getComputedStyle` ของ component ใหม่กับตัวเดิมในหน้าอื่น (font-family / size / height / radius / color)
- ทดสอบที่ ~1440px และ ~390px (หน้าห้ามล้นแนวนอน)
- ถ้าผู้ใช้บอก "ยังไม่เปลี่ยน" ทั้งที่ทดสอบผ่าน → สงสัย cache ก่อน (เลขเวอร์ชันใน `index.html` + hard refresh)
