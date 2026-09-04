# Kas App Stack

Folder ini sekarang punya scaffold aplikasi baru yang terpisah dari struktur Laravel lama:

- `frontend/` untuk React + Vite
- `backend/` untuk Express.js
- `docker-compose.yml` untuk menjalankan React, Express, PostgreSQL, dan Adminer
- `docker/postgres/init.sql` untuk inisialisasi database `kas`

## Service

- Frontend React: `http://localhost:3000`
- Backend Express: `http://localhost:5000/api/health`
- Database browser Adminer: `http://localhost:8082`
- PostgreSQL:
  - Host: `kas-postgres`
  - Port: `5432`
  - Database: `kas`
  - Username: `postgres`
  - Password: `postgres`

## Jalankan dengan Docker

```bash
docker compose up --build
```

Setelah container hidup:

1. Buka `http://localhost:3000`
2. Cek backend di `http://localhost:5000/api/health`
3. Buka database browser di `http://localhost:8082`

## Jalankan Lokal dengan npm

Jika Docker frontend/backend masih hidup, `npm start` lokal akan memakai port berbeda agar tidak bentrok:

- Frontend lokal: `http://localhost:3001`
- Backend lokal: `http://localhost:5001`

Perintah:

```bash
npm start
```

Mode lokal membaca:

- [frontend/.env.local](/abs/path/C:/Users/HP/Downloads/laravel/hosting/uang kas/kas/frontend/.env.local)
- [backend/.env.local](/abs/path/C:/Users/HP/Downloads/laravel/hosting/uang kas/kas/backend/.env.local)

Koneksi database untuk mode lokal Windows memakai host port `55432` agar tidak bentrok dengan PostgreSQL lokal lain di mesin ini.

## Login Adminer

- System: `PostgreSQL`
- Server: `kas-postgres`
- Username: `postgres`
- Password: `postgres`
- Database: `kas`

## Struktur API awal

- `GET /api/health`
- `GET /api/cash-summary`
- `POST /api/auth/login`
- `GET /api/superadmin/overview`
- `GET/POST/PATCH /api/users`
- `GET/POST/PATCH/DELETE /api/classes`
- `GET/POST /api/academic-years`
- `PATCH /api/academic-years/:id/activate`
- `GET/PUT /api/cash-settings`
- `GET /api/monitoring`
- `GET /api/reports/summary`

## Akun Superadmin Awal

- Email: `superadmin@kas.local`
- Password: `superadmin123`

## Catatan

Database `kas` dibuat otomatis oleh container PostgreSQL melalui environment `POSTGRES_DB=kas`, jadi Anda tidak perlu membuat database manual lagi dari browser.

Port `5432` dan `8081` tidak saya pakai karena di mesin ini sudah dipakai container Docker lain.

Jika backend dijalankan di dalam Docker Compose, gunakan host database `kas-postgres`.
Jika backend dijalankan langsung dari terminal Windows tanpa Docker network, biasanya host perlu diganti ke `localhost` dan port ke port host yang diexpose container.
