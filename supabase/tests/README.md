# ทดสอบฐานข้อมูล

ทดสอบ `../schema.sql` กับ Postgres จริงในเครื่อง (จำลอง `auth.users` / `auth.uid()` ของ Supabase ด้วย `shim.sql`)
ครอบคลุมสิทธิ์ตามบทบาท, ขั้นตอนการขอเบิก/อนุมัติ/งวดจ่าย/บัญชี, การตรวจยอดงบฝั่งเซิร์ฟเวอร์, การจัดการผู้ใช้

```bash
createdb sp
psql -d sp -f shim.sql
psql -d sp -f ../schema.sql
npm install
PGDATABASE=sp node run.js      # ตั้ง PGHOST / PGPORT / PGUSER ตามเครื่อง
```

อย่ารัน `shim.sql` กับโปรเจกต์ Supabase จริง (ใช้เฉพาะตอนทดสอบในเครื่อง)
