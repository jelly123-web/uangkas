CREATE TABLE IF NOT EXISTS cash_transactions (
  id SERIAL PRIMARY KEY,
  title VARCHAR(150) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('income', 'expense')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO cash_transactions (title, type, amount, note)
VALUES
  ('Saldo awal', 'income', 1500000, 'Data contoh awal'),
  ('Beli alat tulis', 'expense', 50000, 'Pengeluaran operasional')
ON CONFLICT DO NOTHING;
