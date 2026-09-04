import { initializeDatabase, pool } from "../src/db.js";

await initializeDatabase();

const result = await pool.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
);

console.log(JSON.stringify(result.rows, null, 2));

await pool.end();
