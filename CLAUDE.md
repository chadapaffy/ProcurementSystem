# คำแนะนำสำหรับ Claude ในรีโปนี้

## สไตล์ (ใช้เป็นหลักจนกว่าเจ้าของระบบจะสั่งเปลี่ยน)

- หน้าตา UI ทั้งหมดต้องเป็นไปตาม [`docs/STYLE.md`](docs/STYLE.md) (ฟอนต์ Sarabun / Kanit / IBM Plex Mono, token สีใน `:root` ของ `css/style.css`, component กลาง)
- reuse class ที่มีอยู่ ห้ามสร้าง variant ต่อหน้า · ห้ามใช้ hex ตรงๆ ถ้ามี token · ต้องการสีใหม่ให้ถามผู้ใช้ก่อน
- เจ้าของระบบจะบอกเองเมื่อต้องการเปลี่ยนบางอย่างของสไตล์ — ให้แก้เฉพาะจุดนั้นแล้วอัปเดต `docs/STYLE.md`

## ขั้นตอนขึ้นเว็บ

- พัฒนาที่ branch `claude/adoring-bardeen-2zqnm7` (รีเซ็ตจาก `origin/main` ทุกงาน) → push → สร้าง draft PR → ตั้งเป็น ready → squash merge → ตรวจ GitHub Pages deploy
- เปลี่ยนเลขเวอร์ชันใน `index.html` (5 จุด: meta `app-version` และ `?v=` ของ css / js) ทุกครั้งที่ขึ้นเว็บ
- ห้ามนำข้อมูลบริษัทจริงขึ้นเว็บสาธารณะ · ห้ามใส่ service_role key / รหัสผ่านฐานข้อมูล
- ตอบผู้ใช้เป็นภาษาไทย
