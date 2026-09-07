import test from 'node:test';
import assert from 'node:assert/strict';
import { reminderDate, outstandingForReminder, createReminderRunner } from '../src/email-reminders.js';

const student = { id: 1, full_name: 'Siswa', email: 'siswa@example.test', class_name: 'XII RPL', nominal_kas: 5000, academic_year_name: '2026/2027', created_at: '2026-09-01T00:00:00' };
const payment = (amount, category = 'Kas') => ({ id: 1, student_id: 1, amount, category, type: 'income', created_at: '2026-09-01T12:00:00', title: 'Kas September' });
test('schedule uses Monday at 08:00 Jakarta, including UTC day boundary', () => {
  assert.deepEqual(reminderDate(new Date('2026-09-07T01:00:00Z')), { date: '2026-09-07', hour: 8, dayIndex: 1, monday: true });
  assert.equal(reminderDate(new Date('2026-09-06T18:00:00Z')).monday, true);
  assert.equal(reminderDate(new Date('2026-09-08T01:00:00Z')).monday, false);
});
test('current unpaid week, partial payment, advance payment and fines', () => {
  assert.equal(outstandingForReminder(student, [], '2026-09-07', 'mingguan'), 5000);
  assert.equal(outstandingForReminder(student, [payment(2000)], '2026-09-07', 'mingguan'), 3000);
  assert.equal(outstandingForReminder(student, [payment(20000)], '2026-09-14', 'mingguan'), 0);
  assert.equal(outstandingForReminder(student, [payment(5000, 'Denda')], '2026-09-07', 'mingguan'), 5000);
  assert.equal(outstandingForReminder(student, [payment(5000)], '2026-09-14', 'mingguan'), 5000);
  assert.equal(outstandingForReminder(student, [payment(5000)], '2026-09-28', 'bulanan'), 0);
});
test('students without academic year still use current calendar year', () => {
  const noYearStudent = { ...student, academic_year_name: '' };
  assert.equal(outstandingForReminder(noYearStudent, [], '2026-09-07', 'mingguan'), 5000);
});

function fakeDatabase({ enabled = true, paid = false, notificationDay = 'Senin', notificationHour = 8 } = {}) {
  const claims = new Map();
  const statuses = [];
  let lastKey = '';
  const client = { release() {}, async query(sql, params) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (sql.includes('FROM pengaturan_kas')) return { rows: [{ notify_unpaid: enabled, payment_cycle: 'mingguan', notification_day: notificationDay, notification_hour: notificationHour }] };
    if (sql.includes('FROM pengguna')) return { rows: [student] };
    if (sql.includes('FROM transaksi_kas')) return { rows: paid ? [payment(20000)] : [] };
    if (sql.includes('INSERT INTO pengingat_email')) {
      const key = params.join(':');
      if (claims.has(key) && claims.get(key) !== 'failed') return { rowCount: 0, rows: [] };
      claims.set(key, 'sending'); lastKey = key; return { rowCount: 1, rows: [{ id: 1 }] };
    }
    if (sql.includes('UPDATE pengingat_email')) {
      statuses.push(sql);
      if (lastKey) claims.set(lastKey, sql.includes("status='sent'") ? 'sent' : 'failed');
      return { rows: [] };
    }
    throw new Error('Unexpected query');
  } };
  return { connect: async () => client, statuses };
}
const env = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'kas@example.test' };
const monday = new Date('2026-09-07T01:00:00Z');
test('one reminder per student per Monday, with real calculated amount', async () => {
  const messages = [];
  const run = createReminderRunner(fakeDatabase(), { env, transport: { sendMail: async (message) => { messages.push(message); return { accepted: [student.email] }; } } });
  await run(monday); await run(monday);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to.address, student.email);
  assert.match(messages[0].text, /5\.000/);
});
test('uses notification day and hour from settings', async () => {
  const messages = [];
  const run = createReminderRunner(fakeDatabase({ notificationDay: 'Selasa', notificationHour: 9 }), {
    env,
    transport: { sendMail: async (message) => { messages.push(message); return { accepted: [student.email] }; } }
  });
  await run(new Date('2026-09-07T03:00:00Z'));
  await run(new Date('2026-09-08T01:00:00Z'));
  await run(new Date('2026-09-08T02:00:00Z'));
  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /Selasa/);
});
test('no email when disabled, paid, not Monday, before 08:00, or SMTP missing', async () => {
  for (const options of [ { enabled: false }, { paid: true }, {} ]) {
    const run = createReminderRunner(fakeDatabase(options), { env: Object.keys(options).length ? env : {}, transport: { sendMail: async () => assert.fail('Unexpected email') } });
    await run(monday);
  }
  const run = createReminderRunner(fakeDatabase(), { env, transport: { sendMail: async () => assert.fail('Unexpected email') } });
  await run(new Date('2026-09-08T01:00:00Z'));
  await run(new Date('2026-09-07T00:00:00Z'));
});
test('failed delivery can retry, sent reminders do not duplicate', async () => {
  const db = fakeDatabase(); let attempts = 0;
  const run = createReminderRunner(db, { env, transport: { sendMail: async () => {
    attempts++;
    if (attempts === 1) throw new Error('SMTP unavailable');
    return { accepted: [student.email] };
  } } });
  await run(monday); await run(monday); await run(monday);
  assert.equal(attempts, 2);
  assert.match(db.statuses[0], /failed/);
  assert.match(db.statuses[1], /sent/);
});
