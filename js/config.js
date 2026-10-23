/*
 * การเชื่อมต่อ Supabase (ดูวิธีตั้งค่าที่ supabase/SETUP.md)
 *   supabaseUrl     = Project URL เช่น https://xxxx.supabase.co
 *   supabaseAnonKey = anon public key  (ค่านี้เปิดเผยในหน้าเว็บได้ — ห้ามใส่ service_role key)
 * ถ้าเว้นว่างไว้ ระบบจะทำงานแบบทดลอง (ข้อมูลเก็บในเบราว์เซอร์ สลับผู้ใช้ตัวอย่างได้ ไม่มีการล็อกอิน)
 */
window.PROCUREMENT_CONFIG = Object.assign({
  supabaseUrl: 'https://mtvltrgszaybfwyzzkuh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10dmx0cmdzemF5YmZ3eXp6a3VoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU4OTIsImV4cCI6MjEwODIzMTg5Mn0.NU0eLjXZr9s0UutyevRk1aV4WU0wTvuPKWYaPwYAE8k'
}, window.PROCUREMENT_CONFIG || {});
