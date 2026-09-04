import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function getDatabaseInfo() {
  const result = await pool.query("SELECT current_database() AS name");
  return result.rows[0];
}

const superadminPasswordHash =
  "a5f4944a2d60591f59d3c1f7bdca5ad03b66a12945d7769e5a426e121b0f333ae23009e63729e0bdc422950d3619901dcd7412ea172621a2f6b5117f9d26fc43";

export async function initializeDatabase() {
  await pool.query(`
    ALTER TABLE IF EXISTS class_treasurers RENAME TO bendahara_kelas;
    ALTER TABLE IF EXISTS cash_transactions RENAME TO transaksi_kas;
    ALTER TABLE IF EXISTS cash_settings RENAME TO pengaturan_kas;
    ALTER TABLE IF EXISTS users RENAME TO pengguna;
    ALTER TABLE IF EXISTS classes RENAME TO kelas;
    ALTER TABLE IF EXISTS academic_years RENAME TO tahun_ajaran;

    CREATE TABLE IF NOT EXISTS tahun_ajaran (
      id SERIAL PRIMARY KEY,
      name VARCHAR(20) NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kelas (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      nominal_kas INTEGER NOT NULL DEFAULT 0,
      academic_year_id INTEGER REFERENCES tahun_ajaran (id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS nominal_kas INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS pengguna (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(150) NOT NULL,
      nis VARCHAR(50),
      email VARCHAR(150) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      profile_photo TEXT,
      role VARCHAR(20) NOT NULL CHECK (role IN ('superadmin', 'bendahara', 'walikelas', 'siswa')),
      class_id INTEGER REFERENCES kelas (id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS nis VARCHAR(50);

    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS profile_photo TEXT;

    ALTER TABLE pengguna
    DROP CONSTRAINT IF EXISTS users_role_check;

    ALTER TABLE pengguna
    DROP CONSTRAINT IF EXISTS pengguna_role_check;

    ALTER TABLE pengguna
    ADD CONSTRAINT pengguna_role_check
    CHECK (role IN ('superadmin', 'bendahara', 'walikelas', 'siswa'));

    WITH ranked_superadmin AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          ORDER BY
            CASE
              WHEN LOWER(COALESCE(email, '')) = 'superadmin@kas.com' THEN 1
              ELSE 0
            END,
            id ASC
        ) AS rn
      FROM pengguna
      WHERE role = 'superadmin'
        AND COALESCE("delete", 0) = 0
    )
    UPDATE pengguna
    SET
      "delete" = 1,
      is_active = FALSE,
      updated_at = NOW(),
      deleted_at = NOW(),
      deleted_day = TO_CHAR(NOW(), 'Day'),
      deleted_by_name = 'system-auto-dedupe',
      deleted_by_ip = '127.0.0.1'
    WHERE id IN (
      SELECT id
      FROM ranked_superadmin
      WHERE rn > 1
    );

    CREATE UNIQUE INDEX IF NOT EXISTS pengguna_single_superadmin_idx
      ON pengguna (role)
      WHERE role = 'superadmin' AND COALESCE("delete", 0) = 0;

    CREATE TABLE IF NOT EXISTS jenis_denda (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES kelas (id) ON DELETE CASCADE,
      title VARCHAR(150) NOT NULL,
      amount INTEGER NOT NULL CHECK (amount >= 0),
      created_by_user_id INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES kelas (id) ON DELETE CASCADE;

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS title VARCHAR(150);

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS amount INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    CREATE UNIQUE INDEX IF NOT EXISTS jenis_denda_class_title_unique
      ON jenis_denda (class_id, LOWER(title))
      WHERE COALESCE("delete", 0) = 0;

    CREATE TABLE IF NOT EXISTS pengaturan_kas (
      id INTEGER PRIMARY KEY,
      payment_cycle VARCHAR(20) NOT NULL CHECK (payment_cycle IN ('mingguan', 'bulanan')),
      nominal INTEGER NOT NULL CHECK (nominal >= 0),
      payment_day VARCHAR(20) NOT NULL DEFAULT 'Senin',
      notify_unpaid BOOLEAN NOT NULL DEFAULT TRUE,
      allow_late_payment BOOLEAN NOT NULL DEFAULT TRUE,
      auto_report BOOLEAN NOT NULL DEFAULT TRUE,
      fine_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      fine_amount INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS payment_day VARCHAR(20) NOT NULL DEFAULT 'Senin';

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS notify_unpaid BOOLEAN NOT NULL DEFAULT TRUE;

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS allow_late_payment BOOLEAN NOT NULL DEFAULT TRUE;

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS auto_report BOOLEAN NOT NULL DEFAULT TRUE;

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS fine_enabled BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS fine_amount INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS transaksi_kas (
      id SERIAL PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('income', 'expense')),
      amount INTEGER NOT NULL CHECK (amount >= 0),
      category VARCHAR(100),
      note TEXT,
      class_id INTEGER REFERENCES kelas (id) ON DELETE SET NULL,
      student_id INTEGER REFERENCES pengguna (id) ON DELETE SET NULL,
      academic_year_id INTEGER REFERENCES tahun_ajaran (id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES kelas (id) ON DELETE SET NULL;

    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS student_id INTEGER REFERENCES pengguna (id) ON DELETE SET NULL;

    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS academic_year_id INTEGER REFERENCES tahun_ajaran (id) ON DELETE SET NULL;

    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS category VARCHAR(100);

    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS backup_key TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS transaksi_kas_backup_key_unique
      ON transaksi_kas (backup_key)
      WHERE backup_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bendahara_kelas (
      class_id INTEGER PRIMARY KEY REFERENCES kelas (id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL UNIQUE REFERENCES pengguna (id) ON DELETE CASCADE,
      assigned_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pengaturan_aplikasi (
      id INTEGER PRIMARY KEY,
      app_name VARCHAR(150) NOT NULL DEFAULT 'KasKu',
      logo_image TEXT,
      sidebar_color VARCHAR(30) NOT NULL DEFAULT '#fbfcfd',
      background_mode VARCHAR(20) NOT NULL DEFAULT 'solid',
      background_color VARCHAR(30) NOT NULL DEFAULT '#fcfdfd',
      background_image TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS preferensi_pengguna (
      user_id INTEGER PRIMARY KEY REFERENCES pengguna (id) ON DELETE CASCADE,
      last_active_page VARCHAR(100) NOT NULL DEFAULT 'dashboard',
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sesi_pengguna (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES pengguna (id) ON DELETE CASCADE,
      session_token TEXT NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMP
    );

    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE tahun_ajaran
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE kelas
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE pengguna
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE pengaturan_kas
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE transaksi_kas
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE jenis_denda
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE bendahara_kelas
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE pengaturan_aplikasi
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    ALTER TABLE preferensi_pengguna
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS "delete" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS deleted_day VARCHAR(20);
    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;
    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS deleted_by_name VARCHAR(150);
    ALTER TABLE sesi_pengguna
    ADD COLUMN IF NOT EXISTS deleted_by_ip VARCHAR(100);

    INSERT INTO pengguna (full_name, email, password_hash, role, class_id, is_active)
    SELECT
      'Super Admin',
      'superadmin@kas.com',
      '${superadminPasswordHash}',
      'superadmin',
      NULL,
      TRUE
    WHERE NOT EXISTS (
      SELECT 1
      FROM pengguna
      WHERE role = 'superadmin'
        AND COALESCE("delete", 0) = 0
    );

    INSERT INTO tahun_ajaran (name, is_active)
    VALUES ('2026/2027', TRUE)
    ON CONFLICT (name) DO UPDATE
    SET is_active = EXCLUDED.is_active;

    INSERT INTO pengaturan_kas (
      id,
      payment_cycle,
      nominal,
      payment_day,
      notify_unpaid,
      allow_late_payment,
      auto_report,
      fine_enabled,
      fine_amount,
      updated_at
    )
    VALUES (1, 'bulanan', 50000, 'Senin', TRUE, TRUE, TRUE, FALSE, 0, NOW())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO pengaturan_aplikasi (
      id,
      app_name,
      logo_image,
      sidebar_color,
      background_mode,
      background_color,
      background_image,
      updated_at
    )
    VALUES (1, 'KasKu', NULL, '#fbfcfd', 'solid', '#fcfdfd', NULL, NOW())
    ON CONFLICT (id) DO NOTHING;

    UPDATE kelas
    SET nominal_kas = COALESCE(NULLIF(nominal_kas, 0), (SELECT nominal FROM pengaturan_kas WHERE id = 1), 0);
  `);
}
