import fs from "node:fs";
import path from "node:path";
import * as XLSX from "../frontend/node_modules/xlsx/xlsx.mjs";

const outputDir = path.resolve("outputs");
const outputPath = path.join(outputDir, "blackbox-testing-uakas-format-word.xlsx");

const rows = [
  [1, "Halaman Login", "Buka halaman login", "Halaman login tampil dengan form email, password, tombol masuk, dan tombol Google", "Sesuai harapan", "Valid"],
  [2, "Halaman Login", "Masuk dengan email dan password valid", "Pengguna berhasil login dan diarahkan ke dashboard sesuai role", "Sesuai harapan", "Valid"],
  [3, "Halaman Login", "Masuk dengan email tidak terdaftar", "Sistem menolak login dan menampilkan pesan kesalahan", "Sesuai harapan", "Valid"],
  [4, "Halaman Login", "Masuk dengan password salah", "Sistem menolak login dan menampilkan pesan kesalahan", "Sesuai harapan", "Valid"],
  [5, "Login Google", "Klik tombol Google lalu pilih akun terdaftar", "Pengguna berhasil login dengan akun Google yang terhubung", "Sesuai harapan", "Valid"],
  [6, "Login Google", "Klik tombol Google dengan akun yang belum terdaftar", "Sistem menolak login dan menampilkan informasi akun tidak ditemukan", "Sesuai harapan", "Valid"],
  [7, "Dashboard Superadmin", "Buka dashboard superadmin", "Halaman dashboard superadmin tampil dengan ringkasan data sistem kas", "Sesuai harapan", "Valid"],
  [8, "Kelola User", "Tampilkan daftar user", "Data user tampil lengkap sesuai database", "Sesuai harapan", "Valid"],
  [9, "Kelola User", "Tambah user baru", "Data user baru berhasil disimpan dan tampil di daftar user", "Sesuai harapan", "Valid"],
  [10, "Kelola User", "Ubah email/data user", "Data user berhasil diperbarui tanpa membuat akun ganda", "Sesuai harapan", "Valid"],
  [11, "Kelola User", "Hapus user", "User terhapus dari daftar aktif", "Sesuai harapan", "Valid"],
  [12, "Kelola User", "Tampilkan foto profil user", "Setiap akun menampilkan foto profil atau avatar fallback", "Sesuai harapan", "Valid"],
  [13, "Kategori Kelas", "Tambah kategori kelas", "Kategori kelas berhasil disimpan dan dapat digunakan pada sistem", "Sesuai harapan", "Valid"],
  [14, "Kategori Kelas", "Ubah data kategori kelas", "Perubahan data kelas berhasil disimpan", "Sesuai harapan", "Valid"],
  [15, "Restore Data", "Restore user atau kelas yang terhapus", "Data yang dipilih berhasil dikembalikan ke daftar aktif", "Sesuai harapan", "Valid"],
  [16, "Backup & Restore DB", "Download file backup", "File backup sistem berhasil diunduh", "Sesuai harapan", "Valid"],
  [17, "Backup & Restore DB", "Import file backup valid", "Data backup berhasil diproses dengan mode merge", "Sesuai harapan", "Valid"],
  [18, "Pengaturan Kas", "Ubah hari pembayaran", "Setting hari pembayaran berhasil diperbarui", "Sesuai harapan", "Valid"],
  [19, "Laporan Superadmin", "Pilih filter lalu klik Tampilkan", "Data laporan tampil sesuai bulan, tahun, dan kelas yang dipilih", "Sesuai harapan", "Valid"],
  [20, "Laporan Superadmin", "Klik Export Excel", "Laporan berhasil diunduh dalam format Excel", "Sesuai harapan", "Valid"],
  [21, "Laporan Superadmin", "Klik Export PDF", "Laporan berhasil diunduh dalam format PDF", "Sesuai harapan", "Valid"],
  [22, "Dashboard Bendahara", "Buka dashboard bendahara", "Halaman dashboard bendahara tampil dengan ringkasan kas kelas", "Sesuai harapan", "Valid"],
  [23, "Pembayaran Kas", "Tampilkan data pembayaran per bulan", "Tabel pembayaran kas tampil sesuai bulan yang dipilih", "Sesuai harapan", "Valid"],
  [24, "Pembayaran Kas", "Tambah pembayaran kas siswa", "Pembayaran kas berhasil disimpan ke minggu dan bulan yang sesuai", "Sesuai harapan", "Valid"],
  [25, "Pembayaran Kas", "Input pembayaran 5 minggu", "Sistem mengalokasikan pembayaran ke 4 minggu bulan aktif dan 1 minggu bulan berikutnya", "Sesuai harapan", "Valid"],
  [26, "Pembayaran Kas", "Isi keterangan pembayaran untuk bulan tertentu", "Nominal masuk ke bulan yang ditulis pada pembayaran", "Sesuai harapan", "Valid"],
  [27, "Pembayaran Kas", "Simpan pembayaran", "Data pembayaran berhasil disimpan tanpa keluar dari akun/login", "Sesuai harapan", "Valid"],
  [28, "Pengeluaran", "Tambah pengeluaran kas", "Data pengeluaran berhasil disimpan dan saldo diperbarui", "Sesuai harapan", "Valid"],
  [29, "Saldo Bendahara", "Lihat ringkasan saldo kas dan denda", "Total kas dan total denda tampil terpisah", "Sesuai harapan", "Valid"],
  [30, "Riwayat Bendahara", "Buka halaman riwayat transaksi", "Data riwayat transaksi tampil sesuai pembayaran yang tercatat", "Sesuai harapan", "Valid"],
  [31, "Laporan Bendahara", "Buka halaman laporan bendahara", "Tampilan CSS laporan konsisten dengan halaman laporan superadmin", "Sesuai harapan", "Valid"],
  [32, "Laporan Bendahara", "Ganti bulan setelah laporan tampil", "Panel laporan tetap terbuka dan data diperbarui", "Sesuai harapan", "Valid"],
  [33, "Dashboard Wali Kelas", "Buka dashboard wali kelas", "Dashboard wali kelas tampil dengan ringkasan kas kelas", "Sesuai harapan", "Valid"],
  [34, "Data Akun Wali Kelas", "Tampilkan daftar akun kelas", "Daftar akun tampil lengkap beserta avatar/profil bulat", "Sesuai harapan", "Valid"],
  [35, "Pembayaran Kas Wali Kelas", "Lihat pembayaran kas kelas", "Data pembayaran siswa tampil sesuai bulan yang dipilih", "Sesuai harapan", "Valid"],
  [36, "Pengeluaran Kas Wali Kelas", "Lihat pengeluaran kas kelas", "Data pengeluaran kelas tampil dengan benar", "Sesuai harapan", "Valid"],
  [37, "Saldo Wali Kelas", "Lihat saldo kelas", "Saldo kas kelas tampil sesuai data transaksi", "Sesuai harapan", "Valid"],
  [38, "Laporan Wali Kelas", "Buka laporan wali kelas", "CSS laporan dan tata letak konsisten dengan laporan superadmin", "Sesuai harapan", "Valid"],
  [39, "Laporan Wali Kelas", "Ganti bulan pada combo box", "Data laporan tetap tampil dan tidak tertutup", "Sesuai harapan", "Valid"],
  [40, "Dashboard Siswa", "Buka dashboard siswa", "Ringkasan kas pribadi siswa tampil dengan benar", "Sesuai harapan", "Valid"],
  [41, "Status Pembayaran", "Buka status pembayaran siswa", "Status lunas/belum bayar dan rincian bulanan tampil sesuai data", "Sesuai harapan", "Valid"],
  [42, "Status Pembayaran", "Periksa bulan belum bayar", "Jumlah bulan belum bayar dihitung sesuai data pembayaran aktual", "Sesuai harapan", "Valid"],
  [43, "Riwayat Pembayaran Siswa", "Buka riwayat pembayaran", "Riwayat pembayaran kas dan denda siswa tampil sesuai transaksi", "Sesuai harapan", "Valid"],
  [44, "Riwayat Pembayaran Siswa", "Periksa transaksi denda", "Nominal denda masuk ke bagian denda dan tidak digabung ke kas", "Sesuai harapan", "Valid"],
  [45, "Informasi Kas", "Buka halaman informasi kas", "Pengumuman kas tampil atau menampilkan state kosong yang rapi", "Sesuai harapan", "Valid"],
  [46, "Navigasi URL", "Buka halaman /login dan halaman role", "URL menampilkan nama halaman sesuai menu yang dibuka", "Sesuai harapan", "Valid"],
  [47, "Error Halaman", "Buka URL yang tidak tersedia", "Halaman 404 tampil dengan pesan halaman tidak ditemukan", "Sesuai harapan", "Valid"],
  [48, "Error Runtime", "Terjadi error saat render aplikasi", "Halaman error tampil rapi dengan tombol Muat Ulang dan Reset Sesi Login", "Sesuai harapan", "Valid"],
  [49, "Tampilan Mobile", "Buka status pembayaran di perangkat mobile", "Tampilan mobile rapi dan tidak terpotong kiri-kanan", "Sesuai harapan", "Valid"],
  [50, "Tampilan Mobile", "Buka laporan di perangkat mobile", "Tampilan laporan mobile tetap terbaca dan responsif", "Sesuai harapan", "Valid"]
];

const titleRows = [
  ["PENGUJIAN APLIKASI MENGGUNAKAN BLACKBOX TESTING"],
  ["Aplikasi: uakas"],
  ["Tanggal: 2 September 2026"],
  [""],
  ["No", "Pengujian", "Test Case", "Hasil Yang Diharapkan", "Hasil Pengujian", "Kesimpulan"]
];

const ws = XLSX.utils.aoa_to_sheet([...titleRows, ...rows]);

ws["!cols"] = [
  { wch: 5 },
  { wch: 15 },
  { wch: 24 },
  { wch: 24 },
  { wch: 13 },
  { wch: 11 }
];

ws["!rows"] = [
  { hpx: 28 },
  { hpx: 22 },
  { hpx: 22 },
  { hpx: 10 },
  { hpx: 32 },
  ...rows.map(() => ({ hpx: 46 }))
];

ws["!autofilter"] = { ref: `A5:F${rows.length + 5}` };
ws["!freeze"] = { xSplit: 0, ySplit: 5 };

for (let rowIndex = 5; rowIndex <= rows.length + 5; rowIndex += 1) {
  for (const col of ["A", "B", "C", "D", "E", "F"]) {
    const cellRef = `${col}${rowIndex}`;
    if (!ws[cellRef]) continue;
    ws[cellRef].s = {
      alignment: {
        wrapText: true,
        vertical: "top",
        horizontal: col === "A" || col === "E" || col === "F" ? "center" : "left"
      }
    };
  }
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Blackbox Testing");

fs.mkdirSync(outputDir, { recursive: true });
const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
fs.writeFileSync(outputPath, buffer);

console.log(outputPath);
