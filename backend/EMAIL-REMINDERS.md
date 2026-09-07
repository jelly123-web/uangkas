# Pengingat kas melalui email

Pengingat berjalan sesuai menu Pengaturan Kas > Jadwal Notifikasi. Defaultnya Senin pukul 08.00 WIB (Asia/Jakarta), diperiksa setiap menit selama backend hidup. Restart pada hari/jam notifikasi setelah waktunya lewat akan memeriksa pengiriman yang belum diproses. Tidak mengejar jadwal yang terlewat pada hari lain.

Isi SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS dan SMTP_FROM. Untuk backend lokal, simpan dalam backend/.env.local lalu jalankan npm run dev:local. Untuk Docker Compose, simpan pada .env di root proyek lalu jalankan docker compose up -d --build backend. Jangan commit kredensial.

Contoh nilai non-rahasia: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER=alamat-pengirim, SMTP_FROM=alamat-pengirim. SMTP_PASS harus menggunakan kredensial SMTP yang diizinkan penyedia, bukan dikirim lewat chat.

Aktifkan Notifikasi Belum Bayar dalam Pengaturan Kas. UI menunjukkan jika SMTP belum dikonfigurasi; indikator siap hanya memeriksa kelengkapan konfigurasi, bukan menjamin email masuk inbox. Backend harus hidup pada hari dan jam notifikasi, termasuk Docker/laptop jika belum dihosting.

Email penerima diambil dari data user siswa pada menu Kelola User. SMTP hanya akun pengirim. Hanya siswa aktif di kelas/tahun ajaran aktif yang memiliki email dan sisa kewajiban kas yang menerima pengingat. Denda tidak dihitung sebagai pembayaran kas. Alokasi mengikuti mekanisme aplikasi: empat slot per bulan, catatan bulan/minggu dan pembayaran di muka. Untuk siklus bulanan, nominal adalah kewajiban satu bulan. Kewajiban dihitung sejak bulan pendaftaran siswa dalam tahun ajaran berjalan, memakai nominal kelas saat ini.

Tabel pengingat_email menyimpan status sending, sent, failed dengan satu klaim per siswa per tanggal notifikasi. Lock database mencegah proses paralel. Status sent berarti server SMTP menerima pesan, bukan bukti masuk inbox. Status failed/sending tidak diulang otomatis agar kegagalan jaringan ambigu tidak menyebabkan email ganda; periksa log penyedia sebelum tindakan manual. Tidak ada email sungguhan yang dikirim oleh pengujian.

Uji: node --test backend/tests/email-reminders.test.js (dari root proyek).

Referensi konfigurasi SMTP: https://nodemailer.com/smtp
