/*
 * การเชื่อมต่อ Supabase (ดูวิธีตั้งค่าที่ supabase/SETUP.md)
 *   supabaseUrl     = Project URL เช่น https://xxxx.supabase.co
 *   supabaseAnonKey = anon public key  (ค่านี้เปิดเผยในหน้าเว็บได้ — ห้ามใส่ service_role key)
 * ถ้าเว้นว่างไว้ ระบบจะทำงานแบบทดลอง (ข้อมูลเก็บในเบราว์เซอร์ สลับผู้ใช้ตัวอย่างได้ ไม่มีการล็อกอิน)
 */
window.PROCUREMENT_CONFIG = Object.assign({
  supabaseUrl: 'https://mtvltrgszaybfwyzzkuh.supabase.co',
  supabaseAnonKey: ''
}, window.PROCUREMENT_CONFIG || {});
