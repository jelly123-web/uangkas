import crypto from "crypto";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { getDatabaseInfo, initializeDatabase, pool } from "./db.js";
import { emailConfigured, initializeEmailReminders, startEmailReminders } from "./email-reminders.js";

const app = express();
const passwordSalt = "kas-superadmin-salt";

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

function hashPassword(password) {
  return crypto.scryptSync(password, passwordSalt, 64).toString("hex");
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isValidFullName(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return /^[\p{L}\s.'-]+$/u.test(normalized) && /\p{L}/u.test(normalized);
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value ?? "").trim());
}

function validateAccountInput({ fullName, email, password, requirePassword = true }) {
  const normalizedName = String(fullName ?? "").trim().replace(/\s+/g, " ");
  const normalizedEmail = String(email ?? "").trim();
  const normalizedPassword = String(password ?? "").trim();

  if (!normalizedName) {
    return "Nama wajib diisi.";
  }

  if (!isValidFullName(normalizedName)) {
    return "Nama hanya boleh huruf, spasi, titik, petik, atau strip.";
  }

  if (!normalizedEmail) {
    return "Email wajib diisi.";
  }

  if (!isValidEmailAddress(normalizedEmail)) {
    return "Email harus benar, contoh: nama@gmail.com.";
  }

  if (requirePassword && !normalizedPassword) {
    return "Password wajib diisi.";
  }

  if (normalizedPassword && normalizedPassword.length < 6) {
    return "Password minimal 6 karakter.";
  }

  return "";
}

async function findUserByEmail(email) {
  if (!email) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        u.id,
        u.full_name,
        u.nis,
        u.email,
        u.password_hash,
        u.profile_photo,
        u.profile_photo_original,
        u.role,
        u.class_id,
        c.name AS class_name,
        u.is_active,
        u.created_at
      FROM pengguna u
      LEFT JOIN kelas c
        ON c.id = u.class_id
       AND COALESCE(c."delete", 0) = 0
      WHERE LOWER(u.email) = LOWER($1)
        AND COALESCE(u."delete", 0) = 0
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0] ?? null;
}

async function createAuthenticatedSession(user) {
  const sessionToken = createSessionToken();

  await pool.query(
    `
      INSERT INTO sesi_pengguna (user_id, session_token, is_active, created_at, updated_at, last_seen_at)
      VALUES ($1, $2, TRUE, NOW(), NOW(), NOW())
    `,
    [user.id, sessionToken]
  );

  const preferencesResult = await pool.query(
    `
      INSERT INTO preferensi_pengguna (user_id, last_active_page, updated_at)
      VALUES ($1, 'dashboard', NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING *
    `,
    [user.id]
  );

  return {
    message: "Login berhasil",
    user: mapUser(user),
    auth: {
      role: user.role,
      userId: user.id,
      sessionToken
    },
    preferences: preferencesResult.rows[0]
  };
}

async function verifyGoogleIdToken(idToken) {
  if (!config.googleClientId) {
    throw new Error("GOOGLE_NOT_CONFIGURED");
  }

  const googleResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  if (!googleResponse.ok) {
    throw new Error("GOOGLE_TOKEN_INVALID");
  }

  const payload = await googleResponse.json();

  if (payload.aud !== config.googleClientId) {
    throw new Error("GOOGLE_AUDIENCE_MISMATCH");
  }

  if (!(payload.email_verified === true || payload.email_verified === "true")) {
    throw new Error("GOOGLE_EMAIL_NOT_VERIFIED");
  }

  if (!payload.email) {
    throw new Error("GOOGLE_EMAIL_MISSING");
  }

  return payload;
}

function isAllowedFrontendOrigin(origin) {
  if (!origin || typeof origin !== "string") {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function encodeGoogleState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeGoogleState(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function authenticateGoogleCredential(credential) {
  if (!credential || typeof credential !== "string") {
    const error = new Error("GOOGLE_CREDENTIAL_INVALID");
    error.statusCode = 400;
    error.publicMessage = "Credential Google tidak valid.";
    throw error;
  }

  const googleUser = await verifyGoogleIdToken(credential);
  const user = await findUserByEmail(googleUser.email);

  if (!user) {
    const error = new Error("GOOGLE_ACCOUNT_NOT_REGISTERED");
    error.statusCode = 403;
    error.publicMessage = "Email Google ini belum terdaftar di KasKu. Hubungi admin untuk dibuatkan akun.";
    throw error;
  }

  if (!user.is_active) {
    const error = new Error("GOOGLE_ACCOUNT_INACTIVE");
    error.statusCode = 403;
    error.publicMessage = "Akun tidak aktif.";
    throw error;
  }

  return createAuthenticatedSession(user);
}

function mapGoogleAuthError(error) {
  const statusCode =
    error.statusCode ??
    (error.message === "GOOGLE_NOT_CONFIGURED"
      ? 503
      : error.message === "GOOGLE_TOKEN_INVALID" || error.message === "GOOGLE_AUDIENCE_MISMATCH"
        ? 401
        : error.message === "GOOGLE_EMAIL_NOT_VERIFIED" || error.message === "GOOGLE_EMAIL_MISSING"
          ? 400
          : 500);

  const message =
    error.publicMessage ??
    (error.message === "GOOGLE_NOT_CONFIGURED"
      ? "Login Google belum dikonfigurasi di server."
      : error.message === "GOOGLE_TOKEN_INVALID"
        ? "Token Google tidak valid atau sudah kedaluwarsa."
        : error.message === "GOOGLE_AUDIENCE_MISMATCH"
          ? "Client Google tidak cocok dengan konfigurasi aplikasi."
          : error.message === "GOOGLE_EMAIL_NOT_VERIFIED"
            ? "Email akun Google belum terverifikasi."
            : error.message === "GOOGLE_EMAIL_MISSING"
              ? "Google tidak mengirim email akun."
              : error.message === "GOOGLE_CREDENTIAL_INVALID"
                ? "Credential Google tidak valid."
                : "Login Google gagal.");

  return { statusCode, message };
}

function sendGooglePopupResult(response, targetOrigin, payload) {
  const safeOrigin = isAllowedFrontendOrigin(targetOrigin) ? targetOrigin : "http://127.0.0.1:3001";
  const serialized = JSON.stringify({
    source: "kasku-google-auth",
    ...payload
  }).replace(/</g, "\\u003c");

  response.set("Content-Type", "text/html; charset=utf-8");
  response.send(`<!DOCTYPE html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Login Google KasKu</title>
    <style>
      body{margin:0;font-family:Nunito,Arial,sans-serif;background:#f8fafc;color:#1f2937;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
      .box{width:min(100%,360px);background:#fff;border:1px solid #e5e7eb;border-radius:24px;box-shadow:0 20px 60px rgba(15,23,42,.12);padding:28px 24px;text-align:center}
      .icon{width:56px;height:56px;border-radius:18px;background:linear-gradient(135deg,#34d399,#14b8a6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;margin:0 auto 16px}
      h1{margin:0 0 8px;font-size:22px}
      p{margin:0;font-size:14px;line-height:1.6;color:#64748b}
    </style>
  </head>
  <body>
    <div class="box">
      <div class="icon">G</div>
      <h1>Login Google selesai</h1>
      <p>Jendela ini akan menutup otomatis.</p>
    </div>
    <script>
      (function () {
        const payload = ${serialized};
        try {
          if (window.opener) {
            window.opener.postMessage(payload, ${JSON.stringify(safeOrigin)});
          }
        } finally {
          window.setTimeout(function () { window.close(); }, 300);
        }
      })();
    </script>
  </body>
</html>`);
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return request.socket?.remoteAddress ?? request.ip ?? "-";
}

function mapUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    nis: row.nis,
    email: row.email,
    profilePhoto: row.profile_photo,
    profilePhotoOriginal: row.profile_photo_original ?? row.profile_photo,
    role: row.role,
    classId: row.class_id,
    className: row.class_name,
    isActive: row.is_active,
    createdAt: row.created_at
  };
}

async function getRequestUser(request) {
  const sessionToken = request.headers["x-session-token"];

  if (sessionToken) {
    const sessionResult = await pool.query(
      `
        SELECT
          u.id,
          u.full_name,
          u.nis,
          u.email,
          u.profile_photo,
          u.profile_photo_original,
          u.role,
          u.class_id,
          c.name AS class_name,
          u.is_active,
          u.created_at
        FROM sesi_pengguna sp
        JOIN pengguna u
          ON u.id = sp.user_id
        LEFT JOIN kelas c
          ON c.id = u.class_id
         AND COALESCE(c."delete", 0) = 0
        WHERE sp.session_token = $1
          AND sp.is_active = TRUE
          AND COALESCE(sp."delete", 0) = 0
          AND COALESCE(u."delete", 0) = 0
        LIMIT 1
      `,
      [sessionToken]
    );

    if (sessionResult.rowCount) {
      await pool.query(
        `
          UPDATE sesi_pengguna
          SET last_seen_at = NOW()
          WHERE session_token = $1
        `,
        [sessionToken]
      );
      return mapUser(sessionResult.rows[0]);
    }
  }

  const userId = Number(request.headers["x-user-id"]);
  if (!userId) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        u.id,
        u.full_name,
        u.nis,
        u.email,
        u.profile_photo,
        u.profile_photo_original,
        u.role,
        u.class_id,
        c.name AS class_name,
        u.is_active,
        u.created_at
      FROM pengguna u
      LEFT JOIN kelas c
        ON c.id = u.class_id
       AND COALESCE(c."delete", 0) = 0
      WHERE u.id = $1
        AND COALESCE(u."delete", 0) = 0
      LIMIT 1
    `,
    [userId]
  );

  return result.rowCount ? mapUser(result.rows[0]) : null;
}

function requireRole(role, message) {
  return async (request, response, next) => {
    try {
      const user = await getRequestUser(request);

      if (!user) {
        response.status(401).json({ message: "Sesi login tidak valid." });
        return;
      }

      if (!user.isActive) {
        response.status(403).json({ message: "Akun tidak aktif." });
        return;
      }

      if (user.role !== role) {
        response.status(403).json({ message });
        return;
      }

      request.currentUser = user;
      next();
    } catch (error) {
      response.status(500).json({
        message: "Gagal memverifikasi sesi pengguna.",
        error: error.message
      });
    }
  };
}

const requireAuthenticated = async (request, response, next) => {
  try {
    const user = await getRequestUser(request);

    if (!user) {
      response.status(401).json({ message: "Sesi login tidak valid." });
      return;
    }

    if (!user.isActive) {
      response.status(403).json({ message: "Akun tidak aktif." });
      return;
    }

    request.currentUser = user;
    next();
  } catch (error) {
    response.status(500).json({
      message: "Gagal memverifikasi sesi pengguna.",
      error: error.message
    });
  }
};

const requireSuperadmin = requireRole("superadmin", "Akses hanya untuk superadmin.");
const requireTreasurer = requireRole("bendahara", "Akses hanya untuk bendahara.");
const requireHomeroomTeacher = requireRole("walikelas", "Akses hanya untuk wali kelas.");
const requireStudent = requireRole("siswa", "Akses hanya untuk siswa.");

async function requireTreasurerOrHomeroomTeacher(request, response, next) {
  try {
    const user = await getRequestUser(request);

    if (!user) {
      response.status(401).json({ message: "Sesi login tidak valid." });
      return;
    }

    if (!user.isActive) {
      response.status(403).json({ message: "Akun tidak aktif." });
      return;
    }

    if (!["bendahara", "walikelas"].includes(user.role)) {
      response.status(403).json({ message: "Akses hanya untuk bendahara atau wali kelas." });
      return;
    }

    request.currentUser = user;
    next();
  } catch (error) {
    response.status(500).json({
      message: "Gagal memverifikasi sesi pengguna.",
      error: error.message
    });
  }
}

function toNumber(value) {
  return Number(value ?? 0);
}

function getFineConfig(settings) {
  return {
    enabled: false,
    amount: 0
  };
}

function computeStudentFinancials({ settings, paidCash = 0, paidFine = 0 }) {
  const nominal = Math.max(toNumber(settings?.nominal_kas ?? settings?.nominal), 0);
  const fine = getFineConfig(settings);
  const totalPaidCash = Math.max(toNumber(paidCash), 0);
  const totalPaidFine = Math.max(toNumber(paidFine), 0);
  const outstandingCash = Math.max(nominal - totalPaidCash, 0);
  const expectedFine = fine.enabled && outstandingCash > 0 ? fine.amount : 0;
  const outstandingFine = Math.max(expectedFine - totalPaidFine, 0);
  const outstanding = outstandingCash + outstandingFine;

  return {
    nominal,
    fineEnabled: fine.enabled,
    fineAmount: fine.amount,
    paidCash: totalPaidCash,
    paidFine: totalPaidFine,
    totalPaid: totalPaidCash + totalPaidFine,
    expectedFine,
    outstandingCash,
    outstandingFine,
    outstanding,
    status: outstanding <= 0 ? "lunas" : "belum"
  };
}

function createBackupFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `backup-kasku-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildTransactionBackupKey(row) {
  if (row?.backup_key) {
    return row.backup_key;
  }

  return `tx-${crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        row?.id ?? null,
        row?.title ?? "",
        row?.type ?? "",
        row?.amount ?? 0,
        row?.category ?? "",
        row?.note ?? "",
        row?.created_at ?? "",
        row?.class_id ?? null,
        row?.student_id ?? null,
        row?.academic_year_id ?? null
      ])
    )
    .digest("hex")}`;
}

async function collectSystemBackup() {
  const [
    academicYears,
    classes,
    users,
    treasurers,
    fineTypes,
    cashSettings,
    appSettings,
    preferences,
    transactions
  ] = await Promise.all([
    pool.query(`SELECT * FROM tahun_ajaran ORDER BY id ASC`),
    pool.query(`SELECT * FROM kelas ORDER BY id ASC`),
    pool.query(`SELECT * FROM pengguna ORDER BY id ASC`),
    pool.query(`SELECT * FROM bendahara_kelas ORDER BY class_id ASC`),
    pool.query(`SELECT * FROM jenis_denda ORDER BY class_id ASC, id ASC`),
    pool.query(`SELECT * FROM pengaturan_kas ORDER BY id ASC`),
    pool.query(`SELECT * FROM pengaturan_aplikasi ORDER BY id ASC`),
    pool.query(`SELECT * FROM preferensi_pengguna ORDER BY user_id ASC`),
    pool.query(`SELECT * FROM transaksi_kas ORDER BY id ASC`)
  ]);

  return {
    meta: {
      app: "KasKu",
      exported_at: new Date().toISOString(),
      restore_mode: "merge-update",
      version: 1
    },
    data: {
      academic_years: academicYears.rows,
      classes: classes.rows,
      users: users.rows,
      class_treasurers: treasurers.rows,
      fine_types: fineTypes.rows,
      cash_settings: cashSettings.rows,
      app_settings: appSettings.rows,
      user_preferences: preferences.rows,
      cash_transactions: transactions.rows.map((row) => ({
        ...row,
        backup_key: buildTransactionBackupKey(row)
      }))
    }
  };
}

async function mergeSystemBackup(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.data !== "object" || !payload.data) {
    throw new Error("Format file backup tidak valid.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const yearIdMap = new Map();
    const classIdMap = new Map();
    const userIdMap = new Map();
    const summary = {
      academicYears: 0,
      classes: 0,
      users: 0,
      classTreasurers: 0,
      fineTypes: 0,
      cashSettings: 0,
      appSettings: 0,
      userPreferences: 0,
      cashTransactions: 0
    };

    for (const item of safeArray(payload.data.academic_years)) {
      if (!item?.name) {
        continue;
      }

      const result = await client.query(
        `
          INSERT INTO tahun_ajaran (
            name,
            is_active,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, COALESCE($3::timestamp, NOW()), COALESCE($4::timestamp, NOW()), $5, $6, $7, $8, $9, $10)
          ON CONFLICT (name) DO UPDATE
          SET
            is_active = EXCLUDED.is_active,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
          RETURNING id
        `,
        [
          item.name,
          Boolean(item.is_active),
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );

      yearIdMap.set(String(item.id), result.rows[0].id);
      summary.academicYears += 1;
    }

    for (const item of safeArray(payload.data.classes)) {
      if (!item?.name) {
        continue;
      }

      const academicYearId = item.academic_year_id ? yearIdMap.get(String(item.academic_year_id)) ?? null : null;
      const result = await client.query(
        `
          INSERT INTO kelas (
            name,
            nominal_kas,
            academic_year_id,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, $3, COALESCE($4::timestamp, NOW()), COALESCE($5::timestamp, NOW()), $6, $7, $8, $9, $10, $11)
          ON CONFLICT (name) DO UPDATE
          SET
            nominal_kas = EXCLUDED.nominal_kas,
            academic_year_id = EXCLUDED.academic_year_id,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
          RETURNING id
        `,
        [
          item.name,
          Number(item.nominal_kas ?? 0),
          academicYearId,
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );

      classIdMap.set(String(item.id), result.rows[0].id);
      summary.classes += 1;
    }

    for (const item of safeArray(payload.data.users)) {
      if (!item?.email || !item?.full_name || !item?.role) {
        continue;
      }

      const classId = item.class_id ? classIdMap.get(String(item.class_id)) ?? null : null;
      const result = await client.query(
        `
          INSERT INTO pengguna (
            full_name,
            nis,
            email,
            password_hash,
            profile_photo,
            profile_photo_original,
            role,
            class_id,
            is_active,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamp, NOW()), COALESCE($11::timestamp, NOW()), $12, $13, $14, $15, $16, $17)
          ON CONFLICT (email) DO UPDATE
          SET
            full_name = EXCLUDED.full_name,
            nis = EXCLUDED.nis,
            password_hash = EXCLUDED.password_hash,
            profile_photo = EXCLUDED.profile_photo,
            profile_photo_original = EXCLUDED.profile_photo_original,
            role = EXCLUDED.role,
            class_id = EXCLUDED.class_id,
            is_active = EXCLUDED.is_active,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
          RETURNING id
        `,
        [
          item.full_name,
          item.nis ?? null,
          item.email,
          item.password_hash,
          item.profile_photo ?? null,
          item.profile_photo_original ?? item.profile_photo ?? null,
          item.role,
          classId,
          Boolean(item.is_active),
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );

      userIdMap.set(String(item.id), result.rows[0].id);
      summary.users += 1;
    }

    for (const item of safeArray(payload.data.class_treasurers)) {
      const classId = item.class_id ? classIdMap.get(String(item.class_id)) ?? null : null;
      const userId = item.user_id ? userIdMap.get(String(item.user_id)) ?? null : null;

      if (!classId || !userId) {
        continue;
      }

      await client.query(`DELETE FROM bendahara_kelas WHERE user_id = $1 AND class_id <> $2`, [userId, classId]);
      await client.query(
        `
          INSERT INTO bendahara_kelas (
            class_id,
            user_id,
            assigned_at,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, COALESCE($3::timestamp, NOW()), COALESCE($4::timestamp, NOW()), COALESCE($5::timestamp, NOW()), $6, $7, $8, $9, $10, $11)
          ON CONFLICT (class_id) DO UPDATE
          SET
            user_id = EXCLUDED.user_id,
            assigned_at = EXCLUDED.assigned_at,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
        `,
        [
          classId,
          userId,
          item.assigned_at ?? null,
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );
      summary.classTreasurers += 1;
    }

    for (const item of safeArray(payload.data.fine_types)) {
      if (!item?.title) {
        continue;
      }

      const classId = item.class_id ? classIdMap.get(String(item.class_id)) ?? null : null;
      if (!classId) {
        continue;
      }

      await client.query(
        `
          INSERT INTO jenis_denda (
            class_id,
            title,
            amount,
            created_by_user_id,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW()), COALESCE($6::timestamp, NOW()), $7, $8, $9, $10, $11, $12)
          ON CONFLICT (class_id, LOWER(title)) WHERE COALESCE("delete", 0) = 0 DO UPDATE
          SET
            amount = EXCLUDED.amount,
            created_by_user_id = EXCLUDED.created_by_user_id,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
        `,
        [
          classId,
          item.title,
          Number(item.amount ?? 0),
          item.created_by_user_id ?? null,
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );

      summary.fineTypes += 1;
    }

    for (const item of safeArray(payload.data.cash_settings)) {
      await client.query(
        `
          INSERT INTO pengaturan_kas (
            id,
            payment_cycle,
            nominal,
            payment_day,
            notification_day,
            notification_hour,
            notify_unpaid,
            allow_late_payment,
            auto_report,
            fine_enabled,
            fine_amount,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamp, NOW()), COALESCE($13::timestamp, NOW()), $14, $15, $16, $17, $18, $19)
          ON CONFLICT (id) DO UPDATE
          SET
            payment_cycle = EXCLUDED.payment_cycle,
            nominal = EXCLUDED.nominal,
            payment_day = EXCLUDED.payment_day,
            notification_day = EXCLUDED.notification_day,
            notification_hour = EXCLUDED.notification_hour,
            notify_unpaid = EXCLUDED.notify_unpaid,
            allow_late_payment = EXCLUDED.allow_late_payment,
            auto_report = EXCLUDED.auto_report,
            fine_enabled = EXCLUDED.fine_enabled,
            fine_amount = EXCLUDED.fine_amount,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
        `,
        [
          Number(item.id ?? 1),
          item.payment_cycle ?? "mingguan",
          Number(item.nominal ?? 0),
          item.payment_day ?? "Senin",
          item.notification_day ?? item.payment_day ?? "Senin",
          Math.min(23, Math.max(0, Number.parseInt(item.notification_hour ?? 8, 10) || 8)),
          Boolean(item.notify_unpaid),
          Boolean(item.allow_late_payment),
          Boolean(item.auto_report),
          Boolean(item.fine_enabled),
          Number(item.fine_amount ?? 0),
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );
      summary.cashSettings += 1;
    }

    for (const item of safeArray(payload.data.app_settings)) {
      await client.query(
        `
          INSERT INTO pengaturan_aplikasi (
            id,
            app_name,
            logo_image,
            logo_original_image,
            sidebar_color,
            background_mode,
            background_color,
            background_image,
            background_original_image,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamp, NOW()), COALESCE($11::timestamp, NOW()), $12, $13, $14, $15, $16, $17)
          ON CONFLICT (id) DO UPDATE
          SET
            app_name = EXCLUDED.app_name,
            logo_image = EXCLUDED.logo_image,
            logo_original_image = EXCLUDED.logo_original_image,
            sidebar_color = EXCLUDED.sidebar_color,
            background_mode = EXCLUDED.background_mode,
            background_color = EXCLUDED.background_color,
            background_image = EXCLUDED.background_image,
            background_original_image = EXCLUDED.background_original_image,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
        `,
        [
          Number(item.id ?? 1),
          item.app_name ?? "KasKu",
          item.logo_image ?? null,
          item.logo_original_image ?? item.logo_image ?? null,
          item.sidebar_color ?? "#fbfcfd",
          item.background_mode ?? "solid",
          item.background_color ?? "#fcfdfd",
          item.background_image ?? null,
          item.background_original_image ?? item.background_image ?? null,
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );
      summary.appSettings += 1;
    }

    for (const item of safeArray(payload.data.user_preferences)) {
      const userId = item.user_id ? userIdMap.get(String(item.user_id)) ?? null : null;

      if (!userId) {
        continue;
      }

      await client.query(
        `
          INSERT INTO preferensi_pengguna (user_id, last_active_page, created_at, updated_at)
          VALUES ($1, $2, COALESCE($3::timestamp, NOW()), COALESCE($4::timestamp, NOW()))
          ON CONFLICT (user_id) DO UPDATE
          SET
            last_active_page = EXCLUDED.last_active_page,
            updated_at = NOW()
        `,
        [userId, item.last_active_page ?? "dashboard", item.created_at ?? null, item.updated_at ?? null]
      );
      summary.userPreferences += 1;
    }

    for (const item of safeArray(payload.data.cash_transactions)) {
      if (!item?.title || !item?.type) {
        continue;
      }

      const classId = item.class_id ? classIdMap.get(String(item.class_id)) ?? null : null;
      const studentId = item.student_id ? userIdMap.get(String(item.student_id)) ?? null : null;
      const academicYearId = item.academic_year_id ? yearIdMap.get(String(item.academic_year_id)) ?? null : null;
      const backupKey = buildTransactionBackupKey(item);

      await client.query(
        `
          INSERT INTO transaksi_kas (
            title,
            type,
            amount,
            category,
            note,
            class_id,
            student_id,
            academic_year_id,
            backup_key,
            created_at,
            updated_at,
            "delete",
            deleted_at,
            deleted_day,
            deleted_by_user_id,
            deleted_by_name,
            deleted_by_ip
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamp, NOW()), COALESCE($11::timestamp, NOW()), $12, $13, $14, $15, $16, $17)
          ON CONFLICT (backup_key) DO UPDATE
          SET
            title = EXCLUDED.title,
            type = EXCLUDED.type,
            amount = EXCLUDED.amount,
            category = EXCLUDED.category,
            note = EXCLUDED.note,
            class_id = EXCLUDED.class_id,
            student_id = EXCLUDED.student_id,
            academic_year_id = EXCLUDED.academic_year_id,
            updated_at = NOW(),
            "delete" = EXCLUDED."delete",
            deleted_at = EXCLUDED.deleted_at,
            deleted_day = EXCLUDED.deleted_day,
            deleted_by_user_id = EXCLUDED.deleted_by_user_id,
            deleted_by_name = EXCLUDED.deleted_by_name,
            deleted_by_ip = EXCLUDED.deleted_by_ip
        `,
        [
          item.title,
          item.type,
          Number(item.amount ?? 0),
          item.category ?? null,
          item.note ?? null,
          classId,
          studentId,
          academicYearId,
          backupKey,
          item.created_at ?? null,
          item.updated_at ?? null,
          Number(item.delete ?? 0),
          item.deleted_at ?? null,
          item.deleted_day ?? null,
          item.deleted_by_user_id ?? null,
          item.deleted_by_name ?? null,
          item.deleted_by_ip ?? null
        ]
      );
      summary.cashTransactions += 1;
    }

    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function buildClassFinancePayload(classId) {
  const [overviewResult, classResult, settingsResult, studentsResult, transactionsResult, fineTypesResult] =
    await Promise.all([
      pool.query(
        `
          SELECT
            (
              SELECT COUNT(*)::int
              FROM pengguna
              WHERE role IN ('siswa', 'bendahara')
                AND class_id = $1
                AND COALESCE("delete", 0) = 0
            ) AS total_students,
            COALESCE(SUM(CASE WHEN ct.type = 'income' THEN ct.amount ELSE 0 END), 0)::int AS total_income,
            COALESCE(SUM(CASE WHEN ct.type = 'income' AND LOWER(COALESCE(ct.category, '')) = 'denda' THEN ct.amount ELSE 0 END), 0)::int AS total_fine_income,
            COALESCE(SUM(CASE WHEN ct.type = 'expense' THEN ct.amount ELSE 0 END), 0)::int AS total_expense,
            COALESCE(SUM(CASE WHEN ct.type = 'income' THEN ct.amount ELSE -ct.amount END), 0)::int AS balance,
            COUNT(ct.id)::int AS total_transactions
          FROM kelas k
          LEFT JOIN transaksi_kas ct
            ON ct.class_id = k.id
           AND COALESCE(ct."delete", 0) = 0
          WHERE k.id = $1
            AND COALESCE(k."delete", 0) = 0
        `,
        [classId]
      ),
      pool.query(
        `
          SELECT
            k.id,
            k.name,
            k.nominal_kas,
            COALESCE(
              a.name,
              (
                SELECT ta_active.name
                FROM tahun_ajaran ta_active
                WHERE ta_active.is_active = TRUE
                  AND COALESCE(ta_active."delete", 0) = 0
                ORDER BY ta_active.id DESC
                LIMIT 1
              )
            ) AS academic_year_name
          FROM kelas k
          LEFT JOIN tahun_ajaran a
            ON a.id = k.academic_year_id
           AND COALESCE(a."delete", 0) = 0
          WHERE k.id = $1
            AND COALESCE(k."delete", 0) = 0
          LIMIT 1
        `,
        [classId]
      ),
      pool.query(`SELECT * FROM pengaturan_kas WHERE id = 1 AND COALESCE("delete", 0) = 0 LIMIT 1`),
      pool.query(
        `
          SELECT
            u.id,
            u.full_name,
            u.nis,
            u.email,
            u.role,
            u.profile_photo,
            u.profile_photo_original,
            u.is_active,
            k.nominal_kas,
            COALESCE(SUM(CASE WHEN ct.type = 'income' AND LOWER(COALESCE(ct.category, '')) <> 'denda' THEN ct.amount ELSE 0 END), 0)::int AS paid_cash,
            COALESCE(SUM(CASE WHEN ct.type = 'income' AND LOWER(COALESCE(ct.category, '')) = 'denda' THEN ct.amount ELSE 0 END), 0)::int AS paid_fine
          FROM pengguna u
          JOIN kelas k
            ON k.id = u.class_id
           AND COALESCE(k."delete", 0) = 0
          LEFT JOIN transaksi_kas ct
            ON ct.student_id = u.id
           AND ct.class_id = u.class_id
           AND COALESCE(ct."delete", 0) = 0
          WHERE u.role IN ('siswa', 'bendahara')
            AND u.class_id = $1
            AND COALESCE(u."delete", 0) = 0
          GROUP BY u.id, k.nominal_kas
          ORDER BY
            CASE WHEN u.role = 'siswa' THEN 0 ELSE 1 END,
            u.full_name ASC
        `,
        [classId]
      ),
      pool.query(
        `
          SELECT
            ct.id,
            ct.student_id,
            ct.title,
            ct.type,
            ct.amount,
            ct.category,
            ct.note,
            ct.created_at,
            c.name AS class_name,
            u.full_name AS student_name,
            u.nis AS student_nis,
            a.name AS academic_year_name
          FROM transaksi_kas ct
          LEFT JOIN kelas c
            ON c.id = ct.class_id
           AND COALESCE(c."delete", 0) = 0
          LEFT JOIN pengguna u
            ON u.id = ct.student_id
           AND COALESCE(u."delete", 0) = 0
          LEFT JOIN tahun_ajaran a
            ON a.id = ct.academic_year_id
           AND COALESCE(a."delete", 0) = 0
          WHERE ct.class_id = $1
            AND COALESCE(ct."delete", 0) = 0
          ORDER BY ct.created_at DESC, ct.id DESC
        `,
        [classId]
      ),
      pool.query(
        `
          SELECT
            id,
            class_id,
            title,
            amount,
            created_by_user_id,
            created_at,
            updated_at
          FROM jenis_denda
          WHERE class_id = $1
            AND COALESCE("delete", 0) = 0
          ORDER BY created_at DESC, id DESC
        `,
        [classId]
      )
    ]);

  const settings = settingsResult.rows[0] ?? null;
  const students = studentsResult.rows.map((row) => {
    const financials = computeStudentFinancials({
      settings: row,
      paidCash: row.paid_cash,
      paidFine: row.paid_fine
    });
    const isCountedStudent = row.role === "siswa" || row.role === "bendahara";

    const nominalKas = Number(row.nominal_kas ?? 0);
    const outstandingPeriods = nominalKas > 0 ? Math.ceil(financials.outstandingCash / nominalKas) : 0;

    return {
      id: row.id,
      fullName: row.full_name,
      nis: row.nis,
      email: row.email,
      role: row.role,
      profilePhoto: row.profile_photo,
      profilePhotoOriginal: row.profile_photo_original ?? row.profile_photo,
      isActive: row.is_active,
      nominalKas,
      paidCash: isCountedStudent ? financials.paidCash : 0,
      paidFine: isCountedStudent ? financials.paidFine : 0,
      paidAmount: isCountedStudent ? financials.totalPaid : 0,
      outstandingCash: isCountedStudent ? financials.outstandingCash : 0,
      outstandingFine: isCountedStudent ? financials.outstandingFine : 0,
      outstanding: isCountedStudent ? financials.outstanding : 0,
      outstandingPeriods: isCountedStudent ? outstandingPeriods : 0,
      status: isCountedStudent ? financials.status : "akun"
    };
  });
  const studentOnlyRows = students.filter((item) => item.role === "siswa" || item.role === "bendahara");

  return {
    overview: {
      ...(overviewResult.rows[0] ?? {
        total_students: 0,
        total_income: 0,
        total_fine_income: 0,
        total_expense: 0,
        balance: 0,
        total_transactions: 0
      }),
      paid_students: studentOnlyRows.filter((item) => item.status === "lunas").length,
      unpaid_students: studentOnlyRows.filter((item) => item.status !== "lunas").length,
      total_outstanding_fine: studentOnlyRows.reduce((sum, item) => sum + item.outstandingFine, 0)
    },
    classInfo: classResult.rows[0] ?? null,
    settings,
    students,
    transactions: transactionsResult.rows,
    fineTypes: fineTypesResult.rows
  };
}

function handleApiError(error, _request, response, next) {
  if (error?.type === "entity.too.large") {
    response.status(413).json({
      message: "Ukuran gambar terlalu besar. Coba gunakan gambar yang lebih kecil.",
      error: error.message
    });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({
      message: "Format data request tidak valid.",
      error: error.message
    });
    return;
  }

  next(error);
}

app.get("/api/health", async (_request, response) => {
  try {
    const database = await getDatabaseInfo();

    response.json({
      message: "Backend Express aktif",
      database: database.name,
      time: new Date().toISOString()
    });
  } catch (error) {
    response.status(500).json({
      message: "Koneksi database gagal",
      error: error.message
    });
  }
});

app.get("/api/app-settings", async (_request, response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM pengaturan_aplikasi WHERE id = 1 AND COALESCE("delete", 0) = 0 LIMIT 1`
    );

    response.json(
      result.rows[0] ?? {
        id: 1,
        app_name: "KasKu",
        logo_image: null,
        logo_original_image: null,
        sidebar_color: "#fbfcfd",
        background_mode: "solid",
        background_color: "#fcfdfd",
        background_image: null,
        background_original_image: null
      }
    );
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil pengaturan aplikasi.",
      error: error.message
    });
  }
});

app.post("/api/auth/login", async (request, response) => {
  try {
    const { email, password } = request.body;
    const user = await findUserByEmail(email);

    if (!user) {
      response.status(401).json({ message: "Email atau password salah." });
      return;
    }

    if (!user.is_active) {
      response.status(403).json({ message: "Akun tidak aktif." });
      return;
    }

    if (user.password_hash !== hashPassword(password)) {
      response.status(401).json({ message: "Email atau password salah." });
      return;
    }

    response.json(await createAuthenticatedSession(user));
  } catch (error) {
    response.status(500).json({
      message: "Login gagal",
      error: error.message
    });
  }
});

app.post("/api/auth/google", async (request, response) => {
  try {
    const { credential } = request.body ?? {};
    response.json(await authenticateGoogleCredential(credential));
  } catch (error) {
    const mapped = mapGoogleAuthError(error);
    response.status(mapped.statusCode).json({
      message: mapped.message,
      error: error.message
    });
  }
});

app.get("/api/auth/google/start", (request, response) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    response.status(503).send("Login Google belum dikonfigurasi di server.");
    return;
  }

  const frontendOrigin = typeof request.query.origin === "string" ? request.query.origin : "";
  if (!isAllowedFrontendOrigin(frontendOrigin)) {
    response.status(400).send("Origin frontend tidak valid.");
    return;
  }

  const backendBaseUrl = `${request.protocol}://${request.get("host")}`;
  const redirectUri = `${backendBaseUrl}/api/auth/google/callback`;
  const state = encodeGoogleState({
    origin: frontendOrigin,
    nonce: crypto.randomBytes(16).toString("hex"),
    createdAt: Date.now()
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.googleClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("state", state);

  response.redirect(authUrl.toString());
});

app.get("/api/auth/google/callback", async (request, response) => {
  const rawState = typeof request.query.state === "string" ? request.query.state : "";
  let frontendOrigin = "http://127.0.0.1:3001";

  try {
    const parsedState = decodeGoogleState(rawState);
    if (isAllowedFrontendOrigin(parsedState?.origin)) {
      frontendOrigin = parsedState.origin;
    }
  } catch {
    // fallback
  }

  const authError = typeof request.query.error === "string" ? request.query.error : "";
  if (authError) {
    sendGooglePopupResult(response, frontendOrigin, {
      type: "error",
      message: authError === "access_denied" ? "Login Google dibatalkan." : "Login Google gagal."
    });
    return;
  }

  const code = typeof request.query.code === "string" ? request.query.code : "";
  if (!code) {
    sendGooglePopupResult(response, frontendOrigin, {
      type: "error",
      message: "Google tidak mengirim kode login."
    });
    return;
  }

  try {
    const backendBaseUrl = `${request.protocol}://${request.get("host")}`;
    const redirectUri = `${backendBaseUrl}/api/auth/google/callback`;

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });

    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenResult.id_token) {
      throw new Error(tokenResult.error_description || "GOOGLE_TOKEN_INVALID");
    }

    const session = await authenticateGoogleCredential(tokenResult.id_token);

    sendGooglePopupResult(response, frontendOrigin, {
      type: "success",
      session
    });
  } catch (error) {
    const mapped = mapGoogleAuthError(error);
    sendGooglePopupResult(response, frontendOrigin, {
      type: "error",
      message: mapped.message
    });
  }
});

app.get("/api/auth/session", requireAuthenticated, async (request, response) => {
  try {
    const preferencesResult = await pool.query(
      `
        INSERT INTO preferensi_pengguna (user_id, last_active_page, updated_at)
        VALUES ($1, 'dashboard', NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET updated_at = preferensi_pengguna.updated_at
        RETURNING *
      `,
      [request.currentUser.id]
    );

    response.json({
      user: request.currentUser,
      auth: {
        role: request.currentUser.role,
        userId: request.currentUser.id,
        sessionToken: request.headers["x-session-token"] ?? null
      },
      preferences: preferencesResult.rows[0]
    });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil sesi login.",
      error: error.message
    });
  }
});

app.post("/api/auth/logout", requireAuthenticated, async (request, response) => {
  try {
    const sessionToken = request.headers["x-session-token"];

    if (sessionToken) {
      await pool.query(
        `
          UPDATE sesi_pengguna
          SET is_active = FALSE,
              closed_at = NOW(),
              last_seen_at = NOW()
          WHERE session_token = $1
        `,
        [sessionToken]
      );
    }

    response.json({ message: "Logout berhasil." });
  } catch (error) {
    response.status(500).json({
      message: "Gagal logout.",
      error: error.message
    });
  }
});

app.get("/api/student/overview", requireStudent, async (request, response) => {
  try {
    const studentId = request.currentUser.id;

    const [studentResult, settingsResult, announcementResult] = await Promise.all([
      pool.query(
        `
          SELECT
            u.id,
            u.full_name,
            u.email,
            u.profile_photo,
            u.profile_photo_original,
            u.role,
            u.class_id,
            u.is_active,
            c.name AS class_name,
            c.nominal_kas,
            COALESCE(
              ta.name,
              (
                SELECT ta_active.name
                FROM tahun_ajaran ta_active
                WHERE ta_active.is_active = TRUE
                  AND COALESCE(ta_active."delete", 0) = 0
                ORDER BY ta_active.id DESC
                LIMIT 1
              )
            ) AS academic_year_name
          FROM pengguna u
          LEFT JOIN kelas c
            ON c.id = u.class_id
           AND COALESCE(c."delete", 0) = 0
          LEFT JOIN tahun_ajaran ta
            ON ta.id = c.academic_year_id
           AND COALESCE(ta."delete", 0) = 0
          WHERE u.id = $1
            AND COALESCE(u."delete", 0) = 0
          LIMIT 1
        `,
        [studentId]
      ),
      pool.query(`SELECT * FROM pengaturan_kas WHERE id = 1 AND COALESCE("delete", 0) = 0 LIMIT 1`),
      pool.query(
        `
          SELECT id, title, type, amount, category, note, created_at
          FROM transaksi_kas
          WHERE COALESCE("delete", 0) = 0
            AND class_id = $1
          ORDER BY created_at DESC
          LIMIT 6
        `,
        [request.currentUser.classId ?? null]
      )
    ]);

    const transactionResult = await pool.query(
      `
        SELECT
          id,
          student_id,
          title,
          type,
          amount,
          category,
          note,
          created_at
        FROM transaksi_kas
        WHERE student_id = $1
          AND type = 'income'
          AND COALESCE("delete", 0) = 0
        ORDER BY created_at DESC
      `,
      [studentId]
    );

    const student = studentResult.rows[0];
    const settings = settingsResult.rows[0] ?? null;
    const transactions = transactionResult.rows;
    const paidCash = transactions
      .filter((item) => (item.category ?? "").toLowerCase() !== "denda")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const paidFine = transactions
      .filter((item) => (item.category ?? "").toLowerCase() === "denda")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const financials = computeStudentFinancials({
      settings: {
        ...settings,
        nominal_kas: student?.nominal_kas ?? settings?.nominal_kas ?? settings?.nominal
      },
      paidCash,
      paidFine
    });

    const studentPaymentAnnouncements = transactions
      .filter((item) => (item.category ?? "").toLowerCase() !== "denda")
      .slice(0, 4)
      .map((item) => {
        const paidDate = new Date(item.created_at);
        const paidMonth = new Intl.DateTimeFormat("id-ID", {
          month: "long",
          year: "numeric"
        }).format(paidDate);
        const paidDay = new Intl.DateTimeFormat("id-ID", {
          day: "2-digit",
          month: "long",
          year: "numeric"
        }).format(paidDate);

        return {
          id: `student-payment-${item.id}`,
          title: "Info pembayaran saya",
          body: `Sudah bayar uang kas bulan ${paidMonth} pada tanggal ${paidDay} sebesar ${new Intl.NumberFormat("id-ID", {
            style: "currency",
            currency: "IDR",
            maximumFractionDigits: 0
          }).format(Number(item.amount ?? 0))}`
        };
      });

    const announcements = [
      {
        id: "info-nominal",
        title: "Nominal kas aktif",
        body: `Nominal kas ${settings?.payment_cycle ?? "bulanan"} saat ini ${new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
          maximumFractionDigits: 0
        }).format(financials.nominal)} dan hari pembayaran ${settings?.payment_day ?? "-"}`
      },
      ...(financials.fineEnabled
        ? [
            {
              id: "info-denda",
              title: "Info denda aktif",
              body: `Denda keterlambatan aktif sebesar ${new Intl.NumberFormat("id-ID", {
                style: "currency",
                currency: "IDR",
                maximumFractionDigits: 0
              }).format(financials.fineAmount)}`
            }
          ]
        : []),
      ...studentPaymentAnnouncements,
      ...announcementResult.rows.slice(0, 4).map((item) => ({
        id: `trx-${item.id}`,
        title: item.type === "expense" ? "Info pengeluaran kelas" : "Info pembayaran kelas",
        body: item.note || item.title
      }))
    ];

    response.json({
      student: mapUser({
        ...student,
        class_name: student?.class_name ?? null
      }),
      classInfo: {
        id: student?.class_id ?? null,
        name: student?.class_name ?? null,
        nominal_kas: student?.nominal_kas ?? 0,
        academic_year_name: student?.academic_year_name ?? null
      },
      settings,
      overview: {
        nominal: financials.nominal,
        fine_enabled: financials.fineEnabled,
        fine_amount: financials.fineAmount,
        paid_cash: financials.paidCash,
        paid_fine: financials.paidFine,
        total_paid: financials.totalPaid,
        expected_fine: financials.expectedFine,
        outstanding_cash: financials.outstandingCash,
        outstanding_fine: financials.outstandingFine,
        outstanding: financials.outstanding,
        status: financials.status,
        payment_count: transactions.length
      },
      transactions,
      announcements
    });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil data siswa.",
      error: error.message
    });
  }
});

app.get("/api/cash-summary", async (_request, response) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)::int AS total_income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)::int AS total_expense
      FROM transaksi_kas
      WHERE COALESCE("delete", 0) = 0
    `);

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil ringkasan kas",
      error: error.message
    });
  }
});

app.get("/api/superadmin/overview", requireSuperadmin, async (_request, response) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM pengguna WHERE is_active = TRUE AND COALESCE("delete", 0) = 0) AS total_users,
        (SELECT COUNT(*)::int FROM kelas WHERE COALESCE("delete", 0) = 0) AS total_classes,
        (SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0)::int FROM transaksi_kas WHERE COALESCE("delete", 0) = 0) AS total_cash,
        (SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)::int FROM transaksi_kas WHERE COALESCE("delete", 0) = 0) AS total_income,
        (SELECT COALESCE(SUM(CASE WHEN type = 'income' AND LOWER(COALESCE(category, '')) = 'denda' THEN amount ELSE 0 END), 0)::int FROM transaksi_kas WHERE COALESCE("delete", 0) = 0) AS total_fine,
        (SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)::int FROM transaksi_kas WHERE COALESCE("delete", 0) = 0) AS total_expense,
        (SELECT COUNT(*)::int FROM tahun_ajaran WHERE is_active = TRUE AND COALESCE("delete", 0) = 0) AS active_years
    `);

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil overview dashboard",
      error: error.message
    });
  }
});

app.get("/api/users", requireSuperadmin, async (_request, response) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.nis,
        u.email,
        u.profile_photo,
        u.profile_photo_original,
        u.role,
        u.class_id,
        c.name AS class_name,
        u.is_active,
        u.created_at
      FROM pengguna u
      LEFT JOIN kelas c
        ON c.id = u.class_id
       AND COALESCE(c."delete", 0) = 0
      WHERE COALESCE(u."delete", 0) = 0
      ORDER BY u.id ASC
    `);

    response.json(result.rows.map(mapUser));
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil data user",
      error: error.message
    });
  }
});

app.post("/api/users", requireSuperadmin, async (request, response) => {
  try {
    const {
      fullName,
      nis = null,
      email,
      password,
      role,
      profilePhoto = null,
      profilePhotoOriginal = profilePhoto,
      classId = null,
      isActive = true
    } = request.body;
    const validationMessage = validateAccountInput({ fullName, email, password, requirePassword: true });

    if (validationMessage) {
      response.status(400).json({ message: validationMessage });
      return;
    }

    if (!["bendahara", "walikelas", "siswa", "superadmin"].includes(role)) {
      response.status(400).json({ message: "Role tidak valid." });
      return;
    }

    if (role === "superadmin") {
      const existingSuperadmin = await pool.query(
        `
          SELECT id
          FROM pengguna
          WHERE role = 'superadmin'
            AND COALESCE("delete", 0) = 0
          LIMIT 1
        `
      );

      if (existingSuperadmin.rowCount > 0) {
        response.status(409).json({ message: "Superadmin hanya boleh 1 akun." });
        return;
      }
    }

    const result = await pool.query(
      `
        INSERT INTO pengguna (full_name, nis, email, password_hash, profile_photo, profile_photo_original, role, class_id, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, full_name, nis, email, profile_photo, profile_photo_original, role, class_id, is_active, created_at
      `,
      [
        fullName.trim().replace(/\s+/g, " "),
        nis?.trim() || null,
        email.trim(),
        hashPassword(password.trim()),
        profilePhoto,
        profilePhotoOriginal ?? profilePhoto,
        role,
        classId || null,
        isActive
      ]
    );

    const className = classId
      ? await pool.query("SELECT name FROM kelas WHERE id = $1", [classId])
      : { rowCount: 0, rows: [] };

    response.status(201).json(
      mapUser({
        ...result.rows[0],
        class_name: className.rowCount ? className.rows[0].name : null
      })
    );
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({
        message: "Email sudah dipakai akun lain.",
        error: error.message
      });
      return;
    }

    if (error.code === "23514") {
      response.status(400).json({
        message: "Data akun tidak valid untuk aturan database saat ini.",
        error: error.message
      });
      return;
    }

    response.status(500).json({
      message: "Gagal menambah user",
      error: error.message
    });
  }
});

app.patch("/api/users/:id", requireSuperadmin, async (request, response) => {
  try {
    const { id } = request.params;
    const { fullName, nis, email, password, role, classId = null, isActive, profilePhoto, profilePhotoOriginal = profilePhoto } = request.body;
    const validationMessage = validateAccountInput({ fullName, email, password, requirePassword: false });

    if (validationMessage) {
      response.status(400).json({ message: validationMessage });
      return;
    }

    if (role && !["bendahara", "walikelas", "siswa", "superadmin"].includes(role)) {
      response.status(400).json({ message: "Role tidak valid." });
      return;
    }

    const currentResult = await pool.query(
      `
        SELECT id, full_name, nis, email, password_hash, profile_photo, profile_photo_original, role, class_id, is_active
        FROM pengguna
        WHERE id = $1
          AND COALESCE("delete", 0) = 0
        LIMIT 1
      `,
      [id]
    );

    if (currentResult.rowCount === 0) {
      response.status(404).json({ message: "User tidak ditemukan." });
      return;
    }

    const currentUser = currentResult.rows[0];
    const nextRole = role ?? currentUser.role;

    if (nextRole === "superadmin") {
      const existingSuperadmin = await pool.query(
        `
          SELECT id
          FROM pengguna
          WHERE role = 'superadmin'
            AND id <> $1
            AND COALESCE("delete", 0) = 0
          LIMIT 1
        `,
        [id]
      );

      if (existingSuperadmin.rowCount > 0) {
        response.status(409).json({ message: "Superadmin hanya boleh 1 akun." });
        return;
      }
    }

    const nextPasswordHash = password?.trim()
      ? hashPassword(password.trim())
      : currentUser.password_hash;

    const result = await pool.query(
      `
        UPDATE pengguna
        SET
          full_name = COALESCE($1, full_name),
          nis = COALESCE($2, nis),
          email = COALESCE($3, email),
          password_hash = $4,
          role = COALESCE($5, role),
          class_id = $6,
          is_active = COALESCE($7, is_active),
          profile_photo = COALESCE($8, profile_photo),
          profile_photo_original = COALESCE($9, profile_photo_original, $8, profile_photo),
          updated_at = NOW()
        WHERE id = $10
          AND COALESCE("delete", 0) = 0
        RETURNING id, full_name, nis, email, profile_photo, profile_photo_original, role, class_id, is_active, created_at
      `,
      [
        fullName?.trim().replace(/\s+/g, " ") ?? null,
        nis?.trim() || null,
        email?.trim() ?? null,
        nextPasswordHash,
        role ?? null,
        classId,
        isActive ?? null,
        profilePhoto ?? null,
        profilePhotoOriginal ?? null,
        id
      ]
    );

    const row = result.rows[0];
    const className = row.class_id
      ? await pool.query("SELECT name FROM kelas WHERE id = $1", [row.class_id])
      : { rowCount: 0, rows: [] };

    response.json(
      mapUser({
        ...row,
        class_name: className.rowCount ? className.rows[0].name : null
      })
    );
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({
        message: "Email sudah dipakai akun lain.",
        error: error.message
      });
      return;
    }

    response.status(500).json({
      message: "Gagal mengubah user",
      error: error.message
    });
  }
});

app.delete("/api/users/:id", requireSuperadmin, async (request, response) => {
  try {
    const { id } = request.params;

    if (Number(id) === Number(request.currentUser.id)) {
      response.status(400).json({ message: "Akun yang sedang dipakai tidak bisa dihapus." });
      return;
    }

    const clientIp = getClientIp(request);
    const result = await pool.query(
      `
        UPDATE pengguna
        SET
          "delete" = 1,
          is_active = FALSE,
          updated_at = NOW(),
          deleted_at = NOW(),
          deleted_day = TO_CHAR(NOW(), 'Day'),
          deleted_by_user_id = $2,
          deleted_by_name = $3,
          deleted_by_ip = $4
        WHERE id = $1
          AND COALESCE("delete", 0) = 0
        RETURNING id
      `,
      [id, request.currentUser.id, request.currentUser.fullName, clientIp]
    );

    if (result.rowCount === 0) {
      response.status(404).json({ message: "User tidak ditemukan." });
      return;
    }

    await pool.query(
      `
        UPDATE sesi_pengguna
        SET
          is_active = FALSE,
          closed_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND COALESCE("delete", 0) = 0
      `,
      [id]
    );

    response.json({ message: "User berhasil dihapus." });
  } catch (error) {
    response.status(500).json({
      message: "Gagal menghapus user",
      error: error.message
    });
  }
});

app.patch("/api/profile", requireAuthenticated, async (request, response) => {
  try {
    const userId = request.currentUser.id;
    const { fullName, email, password, profilePhoto, profilePhotoOriginal = profilePhoto } = request.body;

    if (!userId) {
      response.status(400).json({ message: "User tidak valid." });
      return;
    }

    const currentResult = await pool.query(
      `
        SELECT id, full_name, nis, email, profile_photo, profile_photo_original, password_hash, role, class_id, is_active, created_at
        FROM pengguna
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (currentResult.rowCount === 0) {
      response.status(404).json({ message: "Profil tidak ditemukan." });
      return;
    }

    const currentUser = currentResult.rows[0];
    const nextPasswordHash = password?.trim()
      ? hashPassword(password.trim())
      : currentUser.password_hash;

    const result = await pool.query(
      `
        UPDATE pengguna
        SET
          full_name = COALESCE($1, full_name),
          email = COALESCE($2, email),
          password_hash = $3,
          profile_photo = $4,
          profile_photo_original = $5
        WHERE id = $6
        RETURNING id, full_name, nis, email, profile_photo, profile_photo_original, role, class_id, is_active, created_at
      `,
      [
        fullName ?? currentUser.full_name,
        email ?? currentUser.email,
        nextPasswordHash,
        profilePhoto ?? currentUser.profile_photo ?? null,
        profilePhotoOriginal ?? currentUser.profile_photo_original ?? profilePhoto ?? currentUser.profile_photo ?? null,
        userId
      ]
    );

    response.json({
      message: "Profil berhasil disimpan.",
      user: mapUser(result.rows[0])
    });
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({
        message: "Email sudah dipakai akun lain.",
        error: error.message
      });
      return;
    }

    response.status(500).json({
      message: "Gagal mengubah profil",
      error: error.message
    });
  }
});

app.get("/api/treasurer/overview", requireTreasurer, async (request, response) => {
  try {
    const classId = request.currentUser.classId;

    if (!classId) {
      response.status(400).json({ message: "Akun bendahara belum terhubung ke kelas." });
      return;
    }

    response.json(await buildClassFinancePayload(classId));
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil dashboard bendahara.",
      error: error.message
    });
  }
});

app.get("/api/homeroom/overview", requireHomeroomTeacher, async (request, response) => {
  try {
    const classId = request.currentUser.classId;

    if (!classId) {
      response.status(400).json({ message: "Akun wali kelas belum terhubung ke kelas." });
      return;
    }

    response.json(await buildClassFinancePayload(classId));
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil dashboard wali kelas.",
      error: error.message
    });
  }
});

app.get("/api/class-fine-types", requireTreasurerOrHomeroomTeacher, async (request, response) => {
  try {
    const classId = request.currentUser.classId;

    if (!classId) {
      response.status(400).json({ message: "Akun belum terhubung ke kelas." });
      return;
    }

    const result = await pool.query(
      `
        SELECT
          id,
          class_id,
          title,
          amount,
          created_by_user_id,
          created_at,
          updated_at
        FROM jenis_denda
        WHERE class_id = $1
          AND COALESCE("delete", 0) = 0
        ORDER BY created_at DESC, id DESC
      `,
      [classId]
    );

    response.json(result.rows);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil daftar jenis denda.",
      error: error.message
    });
  }
});

app.post("/api/class-fine-types", requireTreasurerOrHomeroomTeacher, async (request, response) => {
  try {
    const classId = request.currentUser.classId;
    const { title, amount } = request.body;

    if (!classId) {
      response.status(400).json({ message: "Akun belum terhubung ke kelas." });
      return;
    }

    if (!title?.trim()) {
      response.status(400).json({ message: "Nama denda wajib diisi." });
      return;
    }

    const parsedAmount = Math.max(Number(amount) || 0, 0);
    if (parsedAmount <= 0) {
      response.status(400).json({ message: "Nominal denda harus lebih dari 0." });
      return;
    }

    const result = await pool.query(
      `
        INSERT INTO jenis_denda (
          class_id,
          title,
          amount,
          created_by_user_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (class_id, LOWER(title)) WHERE COALESCE("delete", 0) = 0 DO UPDATE
        SET
          amount = EXCLUDED.amount,
          created_by_user_id = EXCLUDED.created_by_user_id,
          updated_at = NOW(),
          "delete" = 0,
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL
        RETURNING id, class_id, title, amount, created_by_user_id, created_at, updated_at
      `,
      [classId, title.trim(), parsedAmount, request.currentUser.id]
    );

    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal menyimpan jenis denda.",
      error: error.message
    });
  }
});

app.post("/api/treasurer/students", requireTreasurer, async (request, response) => {
  try {
    const classId = request.currentUser.classId;
    const {
      fullName,
      email,
      password,
      role = "siswa",
      profilePhoto = null,
      profilePhotoOriginal = profilePhoto,
      isActive = true
    } = request.body;
    const validationMessage = validateAccountInput({ fullName, email, password, requirePassword: true });

    if (validationMessage) {
      response.status(400).json({ message: validationMessage });
      return;
    }

    if (!classId) {
      response.status(400).json({ message: "Akun bendahara belum terhubung ke kelas." });
      return;
    }

    if (!fullName?.trim() || !email?.trim() || !password?.trim()) {
      response.status(400).json({ message: "Nama, email, dan password wajib diisi." });
      return;
    }

    if (!["siswa", "bendahara"].includes(role)) {
      response.status(400).json({ message: "Role hanya boleh siswa atau bendahara." });
      return;
    }

    const result = await pool.query(
      `
        INSERT INTO pengguna (full_name, nis, email, password_hash, profile_photo, profile_photo_original, role, class_id, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, full_name, nis, email, profile_photo, profile_photo_original, role, class_id, is_active, created_at
      `,
      [
        fullName.trim(),
        role === "siswa" ? request.body.nis?.trim() || null : null,
        email.trim(),
        hashPassword(password.trim()),
        profilePhoto,
        profilePhotoOriginal ?? profilePhoto,
        role,
        classId,
        isActive
      ]
    );

    const classNameResult = await pool.query(
      `SELECT name FROM kelas WHERE id = $1 LIMIT 1`,
      [classId]
    );

    response.status(201).json(
      mapUser({
        ...result.rows[0],
        class_name: classNameResult.rowCount ? classNameResult.rows[0].name : null
      })
    );
  } catch (error) {
    response.status(500).json({
      message: "Gagal menambah akun.",
      error: error.message
    });
  }
});

app.post("/api/homeroom/students", requireHomeroomTeacher, async (request, response) => {
  try {
    const classId = request.currentUser.classId;
    const {
      fullName,
      email,
      password,
      role = "siswa",
      profilePhoto = null,
      profilePhotoOriginal = profilePhoto,
      isActive = true
    } = request.body;
    const validationMessage = validateAccountInput({ fullName, email, password, requirePassword: true });

    if (validationMessage) {
      response.status(400).json({ message: validationMessage });
      return;
    }

    if (!classId) {
      response.status(400).json({ message: "Akun wali kelas belum terhubung ke kelas." });
      return;
    }

    if (!fullName?.trim() || !email?.trim() || !password?.trim()) {
      response.status(400).json({ message: "Nama, email, dan password wajib diisi." });
      return;
    }

    if (!["siswa", "bendahara"].includes(role)) {
      response.status(400).json({ message: "Role hanya boleh siswa atau bendahara." });
      return;
    }

    const result = await pool.query(
      `
        INSERT INTO pengguna (full_name, nis, email, password_hash, profile_photo, profile_photo_original, role, class_id, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, full_name, nis, email, profile_photo, profile_photo_original, role, class_id, is_active, created_at
      `,
      [
        fullName.trim(),
        role === "siswa" ? request.body.nis?.trim() || null : null,
        email.trim(),
        hashPassword(password.trim()),
        profilePhoto,
        profilePhotoOriginal ?? profilePhoto,
        role,
        classId,
        isActive
      ]
    );

    const classNameResult = await pool.query(
      `SELECT name FROM kelas WHERE id = $1 LIMIT 1`,
      [classId]
    );

    response.status(201).json(
      mapUser({
        ...result.rows[0],
        class_name: classNameResult.rowCount ? classNameResult.rows[0].name : null
      })
    );
  } catch (error) {
    response.status(500).json({
      message: "Gagal menambah akun.",
      error: error.message
    });
  }
});

app.patch("/api/class-accounts/:id", requireTreasurerOrHomeroomTeacher, async (request, response) => {
  try {
    const classId = request.currentUser.classId;
    const { id } = request.params;
    const { fullName, nis, email, password, role = "siswa", profilePhoto, profilePhotoOriginal = profilePhoto, isActive } = request.body;
    const validationMessage = validateAccountInput({ fullName, email, password, requirePassword: false });

    if (validationMessage) {
      response.status(400).json({ message: validationMessage });
      return;
    }

    if (!classId) {
      response.status(400).json({ message: "Akun belum terhubung ke kelas." });
      return;
    }

    if (!["siswa", "bendahara"].includes(role)) {
      response.status(400).json({ message: "Role hanya boleh siswa atau bendahara." });
      return;
    }

    if (!fullName?.trim() || !email?.trim()) {
      response.status(400).json({ message: "Nama dan email wajib diisi." });
      return;
    }

    const currentResult = await pool.query(
      `
        SELECT id, password_hash, profile_photo, profile_photo_original
        FROM pengguna
        WHERE id = $1
          AND class_id = $2
          AND role IN ('siswa', 'bendahara')
          AND COALESCE("delete", 0) = 0
        LIMIT 1
      `,
      [id, classId]
    );

    if (currentResult.rowCount === 0) {
      response.status(404).json({ message: "Akun tidak ditemukan di kelas ini." });
      return;
    }

    const nextPasswordHash = password?.trim()
      ? hashPassword(password.trim())
      : currentResult.rows[0].password_hash;

    const result = await pool.query(
      `
        UPDATE pengguna
        SET
          full_name = $1,
          nis = $2,
          email = $3,
          password_hash = $4,
          role = $5,
          profile_photo = COALESCE($6, profile_photo),
          profile_photo_original = COALESCE($7, profile_photo_original, $6, profile_photo),
          is_active = COALESCE($8, is_active),
          updated_at = NOW()
        WHERE id = $9
          AND class_id = $10
          AND role IN ('siswa', 'bendahara')
          AND COALESCE("delete", 0) = 0
        RETURNING id, full_name, nis, email, profile_photo, profile_photo_original, role, class_id, is_active, created_at
      `,
      [
        fullName.trim(),
        role === "siswa" ? nis?.trim() || null : null,
        email.trim(),
        nextPasswordHash,
        role,
        profilePhoto ?? null,
        profilePhotoOriginal ?? null,
        isActive ?? null,
        id,
        classId
      ]
    );

    const classNameResult = await pool.query(`SELECT name FROM kelas WHERE id = $1 LIMIT 1`, [classId]);

    response.json(
      mapUser({
        ...result.rows[0],
        class_name: classNameResult.rowCount ? classNameResult.rows[0].name : null
      })
    );
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({
        message: "Email sudah dipakai akun lain.",
        error: error.message
      });
      return;
    }

    response.status(500).json({
      message: "Gagal mengubah akun.",
      error: error.message
    });
  }
});

app.delete("/api/class-accounts/:id", requireTreasurerOrHomeroomTeacher, async (request, response) => {
  response.status(403).json({ message: "Wali kelas dan bendahara tidak bisa menghapus akun siswa." });
});

app.post("/api/treasurer/payments", requireTreasurer, async (request, response) => {
  try {
    const classId = request.currentUser.classId;
    const { studentId, amount, fineAmount = 0, fineReason = "", title, note = "" } = request.body;

    if (!classId) {
      response.status(400).json({ message: "Akun bendahara belum terhubung ke kelas." });
      return;
    }

    const studentResult = await pool.query(
      `
        SELECT id, full_name
        FROM pengguna
        WHERE id = $1
          AND class_id = $2
          AND role IN ('siswa', 'bendahara')
        LIMIT 1
      `,
      [studentId, classId]
    );

    if (studentResult.rowCount === 0) {
      response.status(404).json({ message: "Akun siswa/bendahara tidak ditemukan di kelas ini." });
      return;
    }

    const activeYearResult = await pool.query(
      `SELECT id FROM tahun_ajaran WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
    );

    const student = studentResult.rows[0];
    const paymentAmount = Math.max(Number(amount) || 0, 0);
    const finePaymentAmount = Math.max(Number(fineAmount) || 0, 0);

    if (paymentAmount <= 0 && finePaymentAmount <= 0) {
      response.status(400).json({ message: "Jumlah pembayaran atau denda harus diisi." });
      return;
    }

    const paymentTitle = title?.trim() || `Pembayaran kas ${student.full_name}`;
    const academicYearId = activeYearResult.rowCount ? activeYearResult.rows[0].id : null;
    const insertedRows = [];

    if (paymentAmount > 0) {
      const paymentResult = await pool.query(
        `
          INSERT INTO transaksi_kas (
            title,
            type,
            amount,
            category,
            note,
            class_id,
            student_id,
            academic_year_id
          )
          VALUES ($1, 'income', $2, 'Pembayaran Kas', $3, $4, $5, $6)
          RETURNING *
        `,
        [paymentTitle, paymentAmount, note, classId, studentId, academicYearId]
      );
      insertedRows.push(paymentResult.rows[0]);
    }

    if (finePaymentAmount > 0) {
      const fineResult = await pool.query(
        `
          INSERT INTO transaksi_kas (
            title,
            type,
            amount,
            category,
            note,
            class_id,
            student_id,
            academic_year_id
          )
          VALUES ($1, 'income', $2, 'Denda', $3, $4, $5, $6)
          RETURNING *
        `,
        [
          `Pembayaran denda ${student.full_name}`,
          finePaymentAmount,
          fineReason?.trim() || note || "Pembayaran denda keterlambatan",
          classId,
          studentId,
          academicYearId
        ]
      );
      insertedRows.push(fineResult.rows[0]);
    }

    response.status(201).json({
      message: "Pembayaran berhasil dicatat.",
      rows: insertedRows
    });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mencatat pembayaran kas.",
      error: error.message
    });
  }
});

app.post("/api/treasurer/expenses", requireTreasurer, async (request, response) => {
  try {
    const classId = request.currentUser.classId;
    const { title, amount, category = "Lainnya", note = "" } = request.body;

    if (!classId) {
      response.status(400).json({ message: "Akun bendahara belum terhubung ke kelas." });
      return;
    }

    const activeYearResult = await pool.query(
      `SELECT id FROM tahun_ajaran WHERE is_active = TRUE ORDER BY id DESC LIMIT 1`
    );

    const result = await pool.query(
      `
        INSERT INTO transaksi_kas (
          title,
          type,
          amount,
          category,
          note,
          class_id,
          student_id,
          academic_year_id
        )
        VALUES ($1, 'expense', $2, $3, $4, $5, NULL, $6)
        RETURNING *
      `,
      [
        title,
        Number(amount),
        category,
        note,
        classId,
        activeYearResult.rowCount ? activeYearResult.rows[0].id : null
      ]
    );

    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mencatat pengeluaran.",
      error: error.message
    });
  }
});

app.get("/api/classes", requireSuperadmin, async (_request, response) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.nominal_kas,
        c.academic_year_id,
        a.name AS academic_year_name,
        (
          SELECT COUNT(*)::int
          FROM pengguna u
          WHERE u.class_id = c.id
            AND u.role IN ('siswa', 'bendahara')
            AND COALESCE(u."delete", 0) = 0
        ) AS total_students,
        COALESCE(linked_treasurer.full_name, fallback_treasurer.full_name) AS treasurer_name,
        COALESCE(linked_treasurer.id, fallback_treasurer.id) AS treasurer_id
      FROM kelas c
      LEFT JOIN tahun_ajaran a
        ON a.id = c.academic_year_id
       AND COALESCE(a."delete", 0) = 0
      LEFT JOIN LATERAL (
        SELECT p.id, p.full_name
        FROM bendahara_kelas ct
        INNER JOIN pengguna p
          ON p.id = ct.user_id
         AND COALESCE(p."delete", 0) = 0
        WHERE ct.class_id = c.id
          AND COALESCE(ct."delete", 0) = 0
        ORDER BY ct.assigned_at DESC NULLS LAST, ct.created_at DESC NULLS LAST
        LIMIT 1
      ) linked_treasurer ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.id, p.full_name
        FROM pengguna p
        WHERE p.class_id = c.id
          AND p.role = 'bendahara'
          AND COALESCE(p."delete", 0) = 0
        ORDER BY p.id ASC
        LIMIT 1
      ) fallback_treasurer ON TRUE
      WHERE COALESCE(c."delete", 0) = 0
      ORDER BY c.id ASC
    `);

    response.json(result.rows);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil data kelas",
      error: error.message
    });
  }
});

app.post("/api/classes", requireSuperadmin, async (request, response) => {
  try {
    const { name, nominalKas = 0, academicYearId = null, treasurerUserId = null } = request.body;

    const result = await pool.query(
      `
        INSERT INTO kelas (name, nominal_kas, academic_year_id)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [name, Number(nominalKas) || 0, academicYearId || null]
    );

    if (treasurerUserId) {
      await pool.query(
        `
          INSERT INTO bendahara_kelas (class_id, user_id)
          VALUES ($1, $2)
          ON CONFLICT (class_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_at = NOW()
        `,
        [result.rows[0].id, treasurerUserId]
      );
      await pool.query(
        `UPDATE pengguna SET role = 'bendahara', class_id = $1 WHERE id = $2`,
        [result.rows[0].id, treasurerUserId]
      );
    }

    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal menambah kelas",
      error: error.message
    });
  }
});

app.patch("/api/classes/:id", requireSuperadmin, async (request, response) => {
  try {
    const { id } = request.params;
    const { name, nominalKas = 0, academicYearId = null, treasurerUserId = null } = request.body;

    const result = await pool.query(
      `
        UPDATE kelas
        SET
          name = COALESCE($1, name),
          nominal_kas = $2,
          academic_year_id = $3,
          updated_at = NOW()
        WHERE id = $4
          AND COALESCE("delete", 0) = 0
        RETURNING *
      `,
      [name ?? null, Number(nominalKas) || 0, academicYearId, id]
    );

    if (result.rowCount === 0) {
      response.status(404).json({ message: "Kelas tidak ditemukan." });
      return;
    }

    if (treasurerUserId) {
      await pool.query(
        `
          INSERT INTO bendahara_kelas (class_id, user_id)
          VALUES ($1, $2)
          ON CONFLICT (class_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_at = NOW()
        `,
        [id, treasurerUserId]
      );
      await pool.query(
        `UPDATE pengguna SET role = 'bendahara', class_id = $1 WHERE id = $2`,
        [id, treasurerUserId]
      );
    }

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengubah kelas",
      error: error.message
    });
  }
});

app.delete("/api/classes/:id", requireSuperadmin, async (request, response) => {
  const client = await pool.connect();

  try {
    const { id } = request.params;
    const clientIp = getClientIp(request);

    await client.query("BEGIN");

    const result = await client.query(
      `
        UPDATE kelas
        SET
          "delete" = 1,
          updated_at = NOW(),
          deleted_at = NOW(),
          deleted_day = TO_CHAR(NOW(), 'Day'),
          deleted_by_user_id = $2,
          deleted_by_name = $3,
          deleted_by_ip = $4
        WHERE id = $1
          AND COALESCE("delete", 0) = 0
        RETURNING id
      `,
      [id, request.currentUser.id, request.currentUser.fullName, clientIp]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      response.status(404).json({ message: "Kelas tidak ditemukan." });
      return;
    }

    const deletedUsers = await client.query(
      `
        UPDATE pengguna
        SET
          "delete" = 1,
          is_active = FALSE,
          updated_at = NOW(),
          deleted_at = NOW(),
          deleted_day = TO_CHAR(NOW(), 'Day'),
          deleted_by_user_id = $2,
          deleted_by_name = $3,
          deleted_by_ip = $4
        WHERE class_id = $1
          AND role IN ('siswa', 'bendahara', 'walikelas')
          AND COALESCE("delete", 0) = 0
        RETURNING id
      `,
      [id, request.currentUser.id, request.currentUser.fullName, clientIp]
    );

    await client.query(
      `
        UPDATE transaksi_kas
        SET
          "delete" = 1,
          updated_at = NOW(),
          deleted_at = NOW(),
          deleted_day = TO_CHAR(NOW(), 'Day'),
          deleted_by_user_id = $2,
          deleted_by_name = $3,
          deleted_by_ip = $4
        WHERE (
            class_id = $1
            OR student_id IN (
              SELECT id
              FROM pengguna
              WHERE class_id = $1
            )
          )
          AND COALESCE("delete", 0) = 0
      `,
      [id, request.currentUser.id, request.currentUser.fullName, clientIp]
    );

    await client.query(
      `
        UPDATE bendahara_kelas
        SET
          "delete" = 1,
          updated_at = NOW(),
          deleted_at = NOW(),
          deleted_day = TO_CHAR(NOW(), 'Day'),
          deleted_by_user_id = $2,
          deleted_by_name = $3,
          deleted_by_ip = $4
        WHERE class_id = $1
          AND COALESCE("delete", 0) = 0
      `,
      [id, request.currentUser.id, request.currentUser.fullName, clientIp]
    );

    if (deletedUsers.rowCount > 0) {
      await client.query(
        `
          UPDATE sesi_pengguna
          SET
            is_active = FALSE,
            closed_at = NOW(),
            updated_at = NOW()
          WHERE user_id = ANY($1::int[])
            AND COALESCE("delete", 0) = 0
        `,
        [deletedUsers.rows.map((row) => row.id)]
      );
    }

    await client.query("COMMIT");

    response.json({
      message: "Kelas, akun siswa, dan transaksi terkait berhasil dihapus.",
      deletedUsers: deletedUsers.rowCount
    });
  } catch (error) {
    await client.query("ROLLBACK");
    response.status(500).json({
      message: "Gagal menghapus kelas",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/api/academic-years", requireSuperadmin, async (_request, response) => {
  try {
    const result = await pool.query(`
      SELECT id, name, is_active, created_at
      FROM tahun_ajaran
      WHERE COALESCE("delete", 0) = 0
      ORDER BY id ASC
    `);

    response.json(result.rows);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil tahun ajaran",
      error: error.message
    });
  }
});

app.post("/api/academic-years", requireSuperadmin, async (request, response) => {
  try {
    const { name, isActive = false } = request.body;

    if (isActive) {
      await pool.query('UPDATE tahun_ajaran SET is_active = FALSE, updated_at = NOW() WHERE COALESCE("delete", 0) = 0');
    }

    const result = await pool.query(
      `
        INSERT INTO tahun_ajaran (name, is_active)
        VALUES ($1, $2)
        RETURNING *
      `,
      [name, isActive]
    );

    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal menambah tahun ajaran",
      error: error.message
    });
  }
});

app.patch(
  "/api/academic-years/:id/activate",
  requireSuperadmin,
  async (request, response) => {
    try {
      const { id } = request.params;
      await pool.query('UPDATE tahun_ajaran SET is_active = FALSE, updated_at = NOW() WHERE COALESCE("delete", 0) = 0');
      const result = await pool.query(
        `
          UPDATE tahun_ajaran
          SET is_active = TRUE,
              updated_at = NOW()
          WHERE id = $1
            AND COALESCE("delete", 0) = 0
          RETURNING *
        `,
        [id]
      );

      response.json(result.rows[0]);
    } catch (error) {
      response.status(500).json({
        message: "Gagal mengaktifkan tahun ajaran",
        error: error.message
      });
    }
  }
);

app.get("/api/cash-settings", requireSuperadmin, async (_request, response) => {
  try {
    const result = await pool.query('SELECT * FROM pengaturan_kas WHERE id = 1 AND COALESCE("delete", 0) = 0');
    response.json({ ...result.rows[0], email_reminders_ready: emailConfigured() });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil pengaturan kas",
      error: error.message
    });
  }
});

app.put("/api/cash-settings", requireSuperadmin, async (request, response) => {
  try {
    const {
      paymentCycle,
      nominal = 0,
      paymentDay = "Senin",
      notificationDay = paymentDay,
      notificationHour = 8,
      notifyUnpaid = true,
      allowLatePayment = true,
      autoReport = true
    } = request.body;
    const normalizedNotificationHour = Math.min(23, Math.max(0, Number.parseInt(notificationHour, 10) || 8));
    const result = await pool.query(
      `
        INSERT INTO pengaturan_kas (
          id,
          payment_cycle,
          nominal,
          payment_day,
          notification_day,
          notification_hour,
          notify_unpaid,
          allow_late_payment,
          auto_report,
          fine_enabled,
          fine_amount,
          updated_at
        )
        VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          payment_cycle = EXCLUDED.payment_cycle,
          nominal = EXCLUDED.nominal,
          payment_day = EXCLUDED.payment_day,
          notification_day = EXCLUDED.notification_day,
          notification_hour = EXCLUDED.notification_hour,
          notify_unpaid = EXCLUDED.notify_unpaid,
          allow_late_payment = EXCLUDED.allow_late_payment,
          auto_report = EXCLUDED.auto_report,
          fine_enabled = EXCLUDED.fine_enabled,
          fine_amount = EXCLUDED.fine_amount,
          "delete" = 0,
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL,
          updated_at = NOW()
        RETURNING *
      `,
      [
        paymentCycle,
        nominal,
        paymentDay,
        notificationDay,
        normalizedNotificationHour,
        notifyUnpaid,
        allowLatePayment,
        autoReport,
        false,
        0
      ]
    );

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengubah pengaturan kas",
      error: error.message
    });
  }
});

app.put("/api/app-settings", requireSuperadmin, async (request, response) => {
  try {
    const {
      appName = "KasKu",
      logoImage = null,
      logoOriginalImage = logoImage,
      sidebarColor = "#fbfcfd",
      backgroundMode = "solid",
      backgroundColor = "#fcfdfd",
      backgroundImage = null,
      backgroundOriginalImage = backgroundImage
    } = request.body;

    const result = await pool.query(
      `
        INSERT INTO pengaturan_aplikasi (
          id,
          app_name,
          logo_image,
          logo_original_image,
          sidebar_color,
          background_mode,
          background_color,
          background_image,
          background_original_image,
          updated_at
        )
        VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          app_name = EXCLUDED.app_name,
          logo_image = EXCLUDED.logo_image,
          logo_original_image = EXCLUDED.logo_original_image,
          sidebar_color = EXCLUDED.sidebar_color,
          background_mode = EXCLUDED.background_mode,
          background_color = EXCLUDED.background_color,
          background_image = EXCLUDED.background_image,
          background_original_image = EXCLUDED.background_original_image,
          "delete" = 0,
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL,
          updated_at = NOW()
        RETURNING *
      `,
      [appName, logoImage, logoOriginalImage, sidebarColor, backgroundMode, backgroundColor, backgroundImage, backgroundOriginalImage]
    );

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal menyimpan pengaturan aplikasi.",
      error: error.message
    });
  }
});

app.get("/api/preferences", requireAuthenticated, async (request, response) => {
  try {
    const result = await pool.query(
      `
        INSERT INTO preferensi_pengguna (user_id, last_active_page, updated_at)
        VALUES ($1, 'dashboard', NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET updated_at = preferensi_pengguna.updated_at
        RETURNING *
      `,
      [request.currentUser.id]
    );

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil preferensi pengguna.",
      error: error.message
    });
  }
});

app.put("/api/preferences", requireAuthenticated, async (request, response) => {
  try {
    const { lastActivePage = "dashboard" } = request.body;

    const result = await pool.query(
      `
        INSERT INTO preferensi_pengguna (user_id, last_active_page, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          last_active_page = EXCLUDED.last_active_page,
          updated_at = NOW()
        RETURNING *
      `,
      [request.currentUser.id, lastActivePage]
    );

    response.json(result.rows[0]);
  } catch (error) {
    response.status(500).json({
      message: "Gagal menyimpan preferensi pengguna.",
      error: error.message
    });
  }
});

app.get("/api/monitoring", requireSuperadmin, async (_request, response) => {
  try {
    const transactions = await pool.query(`
      SELECT
        ct.id,
        ct.title,
        ct.type,
        ct.amount,
        ct.category,
        ct.note,
        ct.created_at,
        c.name AS class_name,
        u.full_name AS student_name,
        a.name AS academic_year_name
      FROM transaksi_kas ct
      LEFT JOIN kelas c
        ON c.id = ct.class_id
       AND COALESCE(c."delete", 0) = 0
      LEFT JOIN pengguna u
        ON u.id = ct.student_id
       AND COALESCE(u."delete", 0) = 0
      LEFT JOIN tahun_ajaran a
        ON a.id = ct.academic_year_id
       AND COALESCE(a."delete", 0) = 0
      WHERE COALESCE(ct."delete", 0) = 0
      ORDER BY ct.created_at DESC, ct.id DESC
    `);

    const arrears = await pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        c.name AS class_name,
        c.nominal_kas,
        cs.fine_enabled,
        cs.fine_amount,
        COALESCE(SUM(CASE WHEN ct.type = 'income' AND LOWER(COALESCE(ct.category, '')) <> 'denda' THEN ct.amount ELSE 0 END), 0)::int AS paid_cash,
        COALESCE(SUM(CASE WHEN ct.type = 'income' AND LOWER(COALESCE(ct.category, '')) = 'denda' THEN ct.amount ELSE 0 END), 0)::int AS paid_fine
      FROM pengguna u
      JOIN kelas c
        ON c.id = u.class_id
       AND COALESCE(c."delete", 0) = 0
      CROSS JOIN pengaturan_kas cs
      LEFT JOIN transaksi_kas ct
        ON ct.student_id = u.id
       AND COALESCE(ct."delete", 0) = 0
      WHERE u.role IN ('siswa', 'bendahara')
        AND COALESCE(u."delete", 0) = 0
        AND COALESCE(cs."delete", 0) = 0
      GROUP BY u.id, c.name, c.nominal_kas, cs.fine_enabled, cs.fine_amount
      ORDER BY u.full_name ASC
    `);

    const arrearsRows = arrears.rows
      .map((row) => {
        const financials = computeStudentFinancials({
          settings: row,
          paidCash: row.paid_cash,
          paidFine: row.paid_fine
        });

        return {
          id: row.id,
          full_name: row.full_name,
          email: row.email,
          class_name: row.class_name,
          nominal: financials.nominal,
          fine_enabled: financials.fineEnabled,
          fine_amount: financials.fineAmount,
          paid_amount: financials.totalPaid,
          paid_cash: financials.paidCash,
          paid_fine: financials.paidFine,
          outstanding_cash: financials.outstandingCash,
          outstanding_fine: financials.outstandingFine,
          outstanding: financials.outstanding
        };
      })
      .sort((a, b) => b.outstanding - a.outstanding || a.full_name.localeCompare(b.full_name));

    response.json({
      transactions: transactions.rows,
      arrears: arrearsRows
    });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil monitoring",
      error: error.message
    });
  }
});

app.get("/api/reports/summary", requireSuperadmin, async (_request, response) => {
  try {
    const byClass = await pool.query(`
      SELECT
        COALESCE(c.name, 'Tanpa Kelas') AS class_name,
        COALESCE(SUM(CASE WHEN ct.type = 'income' THEN ct.amount ELSE 0 END), 0)::int AS total_income,
        COALESCE(SUM(CASE WHEN ct.type = 'income' AND LOWER(COALESCE(ct.category, '')) = 'denda' THEN ct.amount ELSE 0 END), 0)::int AS total_fine,
        COALESCE(SUM(CASE WHEN ct.type = 'expense' THEN ct.amount ELSE 0 END), 0)::int AS total_expense
      FROM transaksi_kas ct
      LEFT JOIN kelas c
        ON c.id = ct.class_id
       AND COALESCE(c."delete", 0) = 0
      WHERE COALESCE(ct."delete", 0) = 0
      GROUP BY c.name
      ORDER BY class_name ASC
    `);

    const byMonth = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)::int AS total_income,
        COALESCE(SUM(CASE WHEN type = 'income' AND LOWER(COALESCE(category, '')) = 'denda' THEN amount ELSE 0 END), 0)::int AS total_fine,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)::int AS total_expense
      FROM transaksi_kas
      WHERE COALESCE("delete", 0) = 0
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
    `);

    const byYear = await pool.query(`
      SELECT
        EXTRACT(YEAR FROM created_at)::int AS year,
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)::int AS total_income,
        COALESCE(SUM(CASE WHEN type = 'income' AND LOWER(COALESCE(category, '')) = 'denda' THEN amount ELSE 0 END), 0)::int AS total_fine,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)::int AS total_expense
      FROM transaksi_kas
      WHERE COALESCE("delete", 0) = 0
      GROUP BY EXTRACT(YEAR FROM created_at)
      ORDER BY year DESC
    `);

    response.json({
      byClass: byClass.rows,
      byMonth: byMonth.rows,
      byYear: byYear.rows
    });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil laporan",
      error: error.message
    });
  }
});

app.get("/api/system/backup", requireSuperadmin, async (_request, response) => {
  try {
    const backupPayload = await collectSystemBackup();
    const fileName = createBackupFileName();

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    response.status(200).send(JSON.stringify(backupPayload, null, 2));
  } catch (error) {
    response.status(500).json({
      message: "Gagal membuat file backup sistem.",
      error: error.message
    });
  }
});

app.post("/api/system/restore-merge", requireSuperadmin, async (request, response) => {
  try {
    const summary = await mergeSystemBackup(request.body);

    response.json({
      message: "Restore database selesai. Data diupdate dengan mode merge, bukan replace.",
      summary
    });
  } catch (error) {
    response.status(500).json({
      message: error.message || "Gagal restore database.",
      error: error.message
    });
  }
});

app.get("/api/restore/summary", requireSuperadmin, async (_request, response) => {
  try {
    const [usersResult, classesResult] = await Promise.all([
      pool.query(`
        SELECT
          id,
          full_name AS name,
          email,
          role,
          deleted_at,
          deleted_day,
          deleted_by_user_id,
          deleted_by_name,
          deleted_by_ip
        FROM pengguna
        WHERE COALESCE("delete", 0) = 1
        ORDER BY deleted_at DESC NULLS LAST, id DESC
      `),
      pool.query(`
        SELECT
          id,
          name,
          nominal_kas,
          deleted_at,
          deleted_day,
          deleted_by_user_id,
          deleted_by_name,
          deleted_by_ip
        FROM kelas
        WHERE COALESCE("delete", 0) = 1
        ORDER BY deleted_at DESC NULLS LAST, id DESC
      `)
    ]);

    response.json({
      users: usersResult.rows,
      classes: classesResult.rows
    });
  } catch (error) {
    response.status(500).json({
      message: "Gagal mengambil data restore.",
      error: error.message
    });
  }
});

app.post("/api/restore/users/:id", requireSuperadmin, async (request, response) => {
  try {
    const { id } = request.params;
    const result = await pool.query(
      `
        UPDATE pengguna
        SET
          "delete" = 0,
          updated_at = NOW(),
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL
        WHERE id = $1
          AND COALESCE("delete", 0) = 1
        RETURNING id
      `,
      [id]
    );

    if (result.rowCount === 0) {
      response.status(404).json({ message: "User restore tidak ditemukan." });
      return;
    }

    response.json({ message: "User berhasil dikembalikan." });
  } catch (error) {
    response.status(500).json({
      message: "Gagal restore user.",
      error: error.message
    });
  }
});

app.delete("/api/restore/users/:id", requireSuperadmin, async (request, response) => {
  try {
    const { id } = request.params;
    const result = await pool.query(
      `
        DELETE FROM pengguna
        WHERE id = $1
          AND COALESCE("delete", 0) = 1
        RETURNING id
      `,
      [id]
    );

    if (result.rowCount === 0) {
      response.status(404).json({ message: "User restore tidak ditemukan." });
      return;
    }

    response.json({ message: "User berhasil dihapus permanen." });
  } catch (error) {
    response.status(500).json({
      message: "Gagal menghapus permanen user.",
      error: error.message
    });
  }
});

app.post("/api/restore/classes/:id", requireSuperadmin, async (request, response) => {
  const client = await pool.connect();

  try {
    const { id } = request.params;

    await client.query("BEGIN");

    const classResult = await client.query(
      `
        SELECT id, deleted_at
        FROM kelas
        WHERE id = $1
          AND COALESCE("delete", 0) = 1
        LIMIT 1
      `,
      [id]
    );

    if (classResult.rowCount === 0) {
      await client.query("ROLLBACK");
      response.status(404).json({ message: "Kelas restore tidak ditemukan." });
      return;
    }

    const classDeletedAt = classResult.rows[0].deleted_at;

    const result = await client.query(
      `
        UPDATE kelas
        SET
          "delete" = 0,
          updated_at = NOW(),
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL
        WHERE id = $1
          AND COALESCE("delete", 0) = 1
        RETURNING id
      `,
      [id]
    );

    const restoredUsers = await client.query(
      `
        UPDATE pengguna
        SET
          "delete" = 0,
          is_active = TRUE,
          updated_at = NOW(),
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL
        WHERE class_id = $1
          AND role IN ('siswa', 'bendahara', 'walikelas')
          AND COALESCE("delete", 0) = 1
          AND (
            $2::timestamp IS NULL
            OR deleted_at IS NULL
            OR deleted_at >= ($2::timestamp - INTERVAL '5 seconds')
          )
        RETURNING id
      `,
      [id, classDeletedAt]
    );

    const restoredTransactions = await client.query(
      `
        UPDATE transaksi_kas
        SET
          "delete" = 0,
          updated_at = NOW(),
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL
        WHERE (
            class_id = $1
            OR student_id IN (
              SELECT id
              FROM pengguna
              WHERE class_id = $1
            )
          )
          AND COALESCE("delete", 0) = 1
          AND (
            $2::timestamp IS NULL
            OR deleted_at IS NULL
            OR deleted_at >= ($2::timestamp - INTERVAL '5 seconds')
          )
        RETURNING id
      `,
      [id, classDeletedAt]
    );

    const restoredTreasurers = await client.query(
      `
        UPDATE bendahara_kelas
        SET
          "delete" = 0,
          updated_at = NOW(),
          deleted_at = NULL,
          deleted_day = NULL,
          deleted_by_user_id = NULL,
          deleted_by_name = NULL,
          deleted_by_ip = NULL
        WHERE class_id = $1
          AND COALESCE("delete", 0) = 1
          AND (
            $2::timestamp IS NULL
            OR deleted_at IS NULL
            OR deleted_at >= ($2::timestamp - INTERVAL '5 seconds')
          )
        RETURNING class_id
      `,
      [id, classDeletedAt]
    );

    await client.query("COMMIT");

    response.json({
      message: "Kelas, akun, dan transaksi terkait berhasil dikembalikan.",
      restoredUsers: restoredUsers.rowCount,
      restoredTransactions: restoredTransactions.rowCount,
      restoredTreasurers: restoredTreasurers.rowCount,
      restoredClasses: result.rowCount
    });
  } catch (error) {
    await client.query("ROLLBACK");
    response.status(500).json({
      message: "Gagal restore kelas.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.delete("/api/restore/classes/:id", requireSuperadmin, async (request, response) => {
  try {
    const { id } = request.params;
    const result = await pool.query(
      `
        DELETE FROM kelas
        WHERE id = $1
          AND COALESCE("delete", 0) = 1
        RETURNING id
      `,
      [id]
    );

    if (result.rowCount === 0) {
      response.status(404).json({ message: "Kelas restore tidak ditemukan." });
      return;
    }

    response.json({ message: "Kelas berhasil dihapus permanen." });
  } catch (error) {
    response.status(500).json({
      message: "Gagal menghapus permanen kelas.",
      error: error.message
    });
  }
});

app.use(handleApiError);

async function startServer() {
  await initializeDatabase();
  await initializeEmailReminders(pool);
  startEmailReminders(pool);
  app.listen(config.port, () => {
    console.log(`Kas backend berjalan di port ${config.port}`);
  });
}

startServer().catch((error) => {
  console.error("Gagal menginisialisasi server:", error);
  process.exit(1);
});
