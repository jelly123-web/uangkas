import nodemailer from 'nodemailer';
import { allocateCashPaymentsByAcademicMonths } from './payment-allocation.js';

const notificationDays = new Map([
  ['Minggu', 0],
  ['Senin', 1],
  ['Selasa', 2],
  ['Rabu', 3],
  ['Kamis', 4],
  ['Jumat', 5],
  ['Sabtu', 6]
]);

export function reminderDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const dayIndex = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, hour: Number(parts.hour), dayIndex, monday: dayIndex === 1 };
}

function isReminderDue(schedule, settings) {
  const dayName = settings?.notification_day || 'Senin';
  const targetDay = notificationDays.has(dayName) ? notificationDays.get(dayName) : 1;
  const targetHour = Math.min(23, Math.max(0, Number(settings?.notification_hour ?? 8) || 8));
  return schedule.dayIndex === targetDay && schedule.hour >= targetHour;
}

export function outstandingForReminder(student, transactions, date, cycle) {
  const nominal = Number(student.nominal_kas);
  if (!(nominal > 0)) return 0;
  const today = new Date(`${date}T12:00:00`);
  const weeklyNominal = cycle === 'bulanan' ? nominal / 4 : nominal;
  const { monthSequence, studentSlots } = allocateCashPaymentsByAcademicMonths(
    [{ id: student.id, nominalKas: weeklyNominal }], transactions, student.academic_year_name, today
  );
  const monthIndex = monthSequence.findIndex((m) => m.key === date.slice(0, 7));
  if (monthIndex < 0) return 0;
  const week = Math.min(3, Math.floor((today.getDate() - 1) / 7));
  const slots = studentSlots.get(student.id);
  const end = monthIndex * 4 + (cycle === 'bulanan' ? 3 : week);
  const joined = new Date(student.created_at);
  const joinedMonth = monthSequence.findIndex((m) => m.year === joined.getFullYear() && Number(m.value) === joined.getMonth() + 1);
  const start = Math.max(0, joinedMonth) * 4;
  return Math.round(slots.slice(start, end + 1).reduce((sum, paid) => sum + Math.max(0, weeklyNominal - paid), 0));
}

export function emailConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

function smtpPassword(env = process.env) {
  return String(env.SMTP_PASS ?? '').replace(/\s+/g, '');
}

export async function initializeEmailReminders(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS pengingat_email (
    id BIGSERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL,
    reminder_date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    UNIQUE(student_id, reminder_date)
  )`);
}

export function createReminderRunner(pool, { env = process.env, transport } = {}) {
  let running = false;
  return async function run(now = new Date()) {
    const schedule = reminderDate(now);
    if (running || !emailConfigured(env)) return { skipped: true };
    running = true;
    let client;
    let locked = false;
    let sent = 0;
    try {
      client = await pool.connect();
      locked = (await client.query('SELECT pg_try_advisory_lock(724901) AS locked')).rows[0].locked;
      if (!locked) return { skipped: true };
      const settings = (await client.query('SELECT * FROM pengaturan_kas WHERE id = 1 AND COALESCE("delete", 0) = 0')).rows[0];
      if (!settings?.notify_unpaid || !isReminderDue(schedule, settings)) return { skipped: true };
      const students = (await client.query(`SELECT u.id, u.full_name, u.email, u.created_at, k.name AS class_name,
        k.nominal_kas, COALESCE(a.name, '') AS academic_year_name
        FROM pengguna u JOIN kelas k ON k.id = u.class_id
        LEFT JOIN tahun_ajaran a ON a.id = k.academic_year_id AND COALESCE(a."delete",0) = 0
        WHERE u.role = 'siswa' AND u.is_active = TRUE AND COALESCE(u."delete",0) = 0
          AND COALESCE(k."delete",0) = 0`)).rows;
      const mail = transport ?? nodemailer.createTransport({
        host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: Number(env.SMTP_PORT || 587) === 465,
        requireTLS: true, auth: { user: env.SMTP_USER, pass: smtpPassword(env) },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        disableFileAccess: true, disableUrlAccess: true
      });
      for (const student of students) {
        if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(student.email || '')) continue;
        // Recheck the switch and payments immediately before sending each student's email.
        const enabled = (await client.query('SELECT notify_unpaid FROM pengaturan_kas WHERE id=1 AND COALESCE("delete",0)=0')).rows[0]?.notify_unpaid;
        if (!enabled) break;
        const transactions = (await client.query(`SELECT id, student_id, title, note, amount, category, type, created_at
          FROM transaksi_kas WHERE student_id=$1 AND type='income' AND COALESCE("delete",0)=0
          ORDER BY created_at, id`, [student.id])).rows;
        const outstanding = outstandingForReminder(student, transactions, schedule.date, settings.payment_cycle);
        if (outstanding <= 0) continue;
        const claim = await client.query(`INSERT INTO pengingat_email(student_id, reminder_date, status)
          VALUES($1,$2,'sending')
          ON CONFLICT(student_id, reminder_date)
          DO UPDATE SET status='sending', created_at=NOW(), sent_at=NULL
          WHERE pengingat_email.status = 'failed'
          RETURNING id`, [student.id, schedule.date]);
        if (!claim.rowCount) continue;
        try {
          const amount = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(outstanding);
          const result = await mail.sendMail({
            from: env.SMTP_FROM, to: { name: student.full_name, address: student.email },
            subject: `Pengingat pembayaran uang kas - ${settings.notification_day || 'Senin'}`,
            text: `Halo ${student.full_name},\n\nIni pengingat pembayaran uang kas kelas ${student.class_name}.\nBerdasarkan catatan pembayaran saat email ini dibuat, kas yang belum dibayar sampai periode saat ini adalah ${amount}.\n\nSilakan melakukan pembayaran kepada bendahara kelas. Jika sudah membayar tetapi belum tercatat, silakan konfirmasi kepada bendahara.\n\nTerima kasih.\nPengurus Kas Kelas`
          });
          if (!result.accepted?.length) throw new Error('Email rejected');
          await client.query("UPDATE pengingat_email SET status='sent', sent_at=NOW() WHERE id=$1", [claim.rows[0].id]);
          sent++;
        } catch (error) {
          // Do not automatically retry ambiguous SMTP deliveries and risk duplicate reminders.
          await client.query("UPDATE pengingat_email SET status='failed' WHERE id=$1", [claim.rows[0].id]);
          console.error('Pengingat email gagal; periksa konfigurasi SMTP dan catatan pengiriman.', {
            code: error?.code,
            command: error?.command,
            message: error?.message
          });
        }
      }
      return { sent };
    } finally {
      if (client) {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(724901)'); }
        finally { client.release(); }
      }
      running = false;
    }
  };
}

export function startEmailReminders(pool) {
  const run = createReminderRunner(pool);
  const tick = () => run().catch(() => console.error('Pemeriksaan pengingat email gagal.'));
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return timer;
}
