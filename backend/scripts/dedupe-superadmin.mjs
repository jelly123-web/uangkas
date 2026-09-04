import { pool } from "../src/db.js";

const sql = `
  WITH ranked_superadmin AS (
    SELECT
      id,
      email,
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
  )
  RETURNING id, email
`;

try {
  const result = await pool.query(sql);
  console.log(JSON.stringify({ removed: result.rowCount, rows: result.rows }, null, 2));
} finally {
  await pool.end();
}
