import { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:5000";
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const sessionStorageKey = "kasku-superadmin-session";
const appSettingsStorageKey = "kasku-app-settings";
const defaultAppName = "Aplikasi Kas";
let googleIdentityScriptPromise;

function loadGoogleIdentityScript() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Google Sign-In hanya tersedia di browser."));
  }

  if (window.google?.accounts?.id) {
    return Promise.resolve(window.google);
  }

  if (googleIdentityScriptPromise) {
    return googleIdentityScriptPromise;
  }

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-google-identity="true"]');

    const handleLoad = () => {
      if (window.google?.accounts?.id) {
        resolve(window.google);
        return;
      }

      reject(new Error("Google Sign-In gagal dimuat."));
    };

    const handleError = () => {
      reject(new Error("Script Google Sign-In gagal dimuat."));
    };

    if (existingScript) {
      existingScript.addEventListener("load", handleLoad, { once: true });
      existingScript.addEventListener("error", handleError, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    document.head.appendChild(script);
  });

  return googleIdentityScriptPromise;
}

const defaultCredentials = {
  email: "superadmin@kas.com",
  password: "superadmin123"
};
const defaultAppSettings = {
  appName: defaultAppName,
  logoImage: "",
  logoOriginalImage: "",
  sidebarColor: "#fbfcfd",
  backgroundMode: "solid",
  backgroundColor: "#fcfdfd",
  backgroundImage: "",
  backgroundOriginalImage: ""
};

const validSessionRoles = new Set(["superadmin", "bendahara", "walikelas", "siswa"]);

function createGeneratedAvatar(name = "Pengguna") {
  const initials = getInitials(name) || "U";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="avatarGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#34d399" />
          <stop offset="100%" stop-color="#60a5fa" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="128" fill="url(#avatarGradient)" />
      <text
        x="50%"
        y="50%"
        dominant-baseline="middle"
        text-anchor="middle"
        fill="#ffffff"
        font-family="Arial, Helvetica, sans-serif"
        font-size="92"
        font-weight="700"
      >${initials}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function normalizeUserRecord(user, fallbackRole = "") {
  if (!user || typeof user !== "object") {
    return null;
  }

  const fullName = user.fullName ?? user.full_name ?? "Pengguna";
  const profilePhoto = user.profilePhoto ?? user.profile_photo ?? "";
  const profilePhotoOriginal = user.profilePhotoOriginal ?? user.profile_photo_original ?? profilePhoto;

  return {
    ...user,
    fullName,
    email: user.email ?? "",
    role: user.role ?? fallbackRole,
    classId: user.classId ?? user.class_id ?? null,
    className: user.className ?? user.class_name ?? null,
    profilePhoto: profilePhoto || createGeneratedAvatar(fullName),
    profilePhotoOriginal
  };
}

function normalizeStoredSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const auth = value.auth && typeof value.auth === "object" ? value.auth : null;
  const user = value.user && typeof value.user === "object" ? value.user : null;
  const role = auth?.role;

  if (!auth || !user || !validSessionRoles.has(role) || !auth.userId || !auth.sessionToken) {
    return null;
  }

  return {
    ...value,
    auth: {
      ...auth,
      role,
      userId: auth.userId,
      sessionToken: auth.sessionToken
    },
    user: normalizeUserRecord(user, role),
    preferences: value.preferences && typeof value.preferences === "object" ? value.preferences : {}
  };
}

const pageGroups = [
  {
    label: "Ringkasan",
    items: [{ id: "dashboard", title: "Dashboard", subtitle: "Ringkasan keseluruhan sistem kas", icon: "fa-chart-pie" }]
  },
  {
    label: "Manajemen",
    items: [
      { id: "users", title: "Kelola User", subtitle: "Tambah akun bendahara, wali kelas, dan siswa", icon: "fa-user-group" },
      { id: "classes", title: "Kategori Kelas", subtitle: "Master kelas untuk uang kas, denda, dan saldo", icon: "fa-school" },
      { id: "restore", title: "Restore Data", subtitle: "Kembalikan data yang dihapus oleh super admin", icon: "fa-trash-arrow-up" },
      { id: "system-backup", title: "Backup & Restore DB", subtitle: "Backup sistem dan restore database mode update", icon: "fa-database" },
      { id: "settings", title: "Pengaturan Kas", subtitle: "Nominal, periode, dan konfigurasi sistem", icon: "fa-sliders" }
    ]
  },
  {
    label: "Keuangan",
    items: [
      { id: "income", title: "Seluruh Pemasukan", subtitle: "Data pemasukan kas semua kelas", icon: "fa-arrow-trend-down" },
      { id: "fines", title: "Data Denda", subtitle: "Alasan denda siswa dan nominal denda", icon: "fa-file-circle-exclamation" },
      { id: "expense", title: "Seluruh Pengeluaran", subtitle: "Data pengeluaran kas semua kelas", icon: "fa-arrow-trend-up" },
      { id: "balance", title: "Saldo Kas", subtitle: "Saldo keseluruhan dan per kelas", icon: "fa-piggy-bank" }
    ]
  },
  {
    label: "Laporan",
    items: [{ id: "reports", title: "Laporan Kas", subtitle: "Buat, cetak, dan export laporan", icon: "fa-file-invoice" }]
  }
];

const treasurerPageGroups = [
  {
    label: "Ringkasan",
    items: [{ id: "dashboard", title: "Dashboard", subtitle: "Ringkasan kelas bendahara", icon: "fa-chart-pie" }]
  },
  {
    label: "Siswa",
    items: [
      { id: "students", title: "Daftar Siswa", subtitle: "Melihat status bayar siswa", icon: "fa-user-group" }
    ]
  },
  {
    label: "Keuangan",
    items: [
      { id: "payments", title: "Pembayaran Kas", subtitle: "Catat pemasukan kas siswa", icon: "fa-arrow-trend-down" },
      { id: "expenses", title: "Pengeluaran", subtitle: "Catat pengeluaran kelas", icon: "fa-arrow-trend-up" },
      { id: "balance", title: "Saldo", subtitle: "Lihat saldo kas kelas", icon: "fa-piggy-bank" },
      { id: "history", title: "Riwayat", subtitle: "Riwayat seluruh transaksi kelas", icon: "fa-clock-rotate-left" }
    ]
  },
  {
    label: "Laporan",
    items: [{ id: "reports", title: "Laporan", subtitle: "Buat dan cetak laporan kelas", icon: "fa-file-invoice" }]
  }
];

const homeroomPageGroups = [
  {
    label: "Ringkasan",
    items: [{ id: "dashboard", title: "Dashboard", subtitle: "Ringkasan kas kelas wali kelas", icon: "fa-chart-pie" }]
  },
  {
    label: "Siswa",
    items: [
      { id: "students", title: "Data Akun", subtitle: "Nama, role, NIS, status aktif, dan status pembayaran", icon: "fa-user-group" }
    ]
  },
  {
    label: "Keuangan",
    items: [
      { id: "payments", title: "Pembayaran Kas", subtitle: "Siapa yang sudah dan belum bayar", icon: "fa-arrow-trend-down" },
      { id: "expenses", title: "Pengeluaran Kas", subtitle: "Lihat pengeluaran kas kelas", icon: "fa-arrow-trend-up" },
      { id: "balance", title: "Saldo", subtitle: "Lihat saldo kas kelas", icon: "fa-piggy-bank" },
      { id: "history", title: "Riwayat Transaksi", subtitle: "Seluruh uang masuk dan keluar", icon: "fa-clock-rotate-left" }
    ]
  },
  {
    label: "Laporan",
    items: [{ id: "reports", title: "Laporan", subtitle: "Rekap pembayaran dan keuangan kelas", icon: "fa-file-invoice" }]
  }
];

const studentPageGroups = [
  {
    label: "Ringkasan",
    items: [{ id: "dashboard", title: "Dashboard", subtitle: "Ringkasan kas pribadi", icon: "fa-chart-pie" }]
  },
  {
    label: "Kas Saya",
    items: [
      { id: "payment-status", title: "Status Pembayaran", subtitle: "Lihat status pembayaran sendiri", icon: "fa-circle-check" },
      { id: "history", title: "Riwayat Pembayaran", subtitle: "Riwayat pembayaran kas sendiri", icon: "fa-clock-rotate-left" },
      { id: "announcements", title: "Informasi Kas", subtitle: "Pengumuman dan informasi kas", icon: "fa-bullhorn" }
    ]
  }
];

const pageIdsByRole = {
  superadmin: pageGroups.flatMap((group) => group.items.map((item) => item.id)),
  bendahara: treasurerPageGroups.flatMap((group) => group.items.map((item) => item.id)),
  walikelas: homeroomPageGroups.flatMap((group) => group.items.map((item) => item.id)),
  siswa: studentPageGroups.flatMap((group) => group.items.map((item) => item.id))
};

function getPageIdsForRole(role) {
  return pageIdsByRole[role] ?? ["dashboard"];
}

function getRouteInfo(pathname, role = null) {
  const segments = `${pathname ?? "/"}`
    .split("/")
    .filter(Boolean)
    .map((item) => item.trim().toLowerCase());

  if (segments.length === 0 || segments[0] === "login") {
    return { role: null, page: "login", found: true };
  }

  const routeRole = segments[0];
  if (!Object.prototype.hasOwnProperty.call(pageIdsByRole, routeRole)) {
    return { role: routeRole, page: null, found: false };
  }

  const currentRole = role ?? routeRole;
  const validPages = getPageIdsForRole(currentRole);
  const routePage = segments[1] || "dashboard";

  if (routeRole !== currentRole) {
    return { role: routeRole, page: null, found: false };
  }

  return {
    role: routeRole,
    page: validPages.includes(routePage) ? routePage : null,
    found: validPages.includes(routePage)
  };
}

function buildAppPath(role, page) {
  if (!role) {
    return "/login";
  }

  const validPages = getPageIdsForRole(role);
  const safePage = validPages.includes(page) ? page : "dashboard";
  return `/${role}/${safePage}`;
}

function NotFoundView({ appName, pathName, role, onGoHome, onGoLogin }) {
  const safeAppName = appName || defaultAppName;
  const segments = `${pathName || "/"}`
    .split("/")
    .filter(Boolean);
  const invalidLeaf = segments.at(-1) || "unknown";
  const particles = [
    { left: "8%", top: "22%", size: 8, color: "rgba(59,181,160,0.18)", shadow: "rgba(59,181,160,0.12)", dur: "4.6s", delay: "-1.4s", dy: "-14px", op: "0.22" },
    { left: "24%", top: "68%", size: 10, color: "rgba(255,181,167,0.2)", shadow: "rgba(255,181,167,0.12)", dur: "5.5s", delay: "-2.1s", dy: "-18px", op: "0.24" },
    { left: "46%", top: "16%", size: 6, color: "rgba(255,209,102,0.2)", shadow: "rgba(255,209,102,0.12)", dur: "4.2s", delay: "-0.8s", dy: "-12px", op: "0.2" },
    { left: "62%", top: "72%", size: 9, color: "rgba(195,174,255,0.2)", shadow: "rgba(195,174,255,0.12)", dur: "5.8s", delay: "-3.2s", dy: "-16px", op: "0.22" },
    { left: "84%", top: "34%", size: 7, color: "rgba(255,159,178,0.22)", shadow: "rgba(255,159,178,0.12)", dur: "4.9s", delay: "-1.9s", dy: "-13px", op: "0.24" }
  ];

  return (
    <div className="app404-layout">
      <div className="app404-main">
        <main className="app404-content">
          <div className="app404-error-container">
            <div className="app404-mini-particles" aria-hidden="true">
              {particles.map((item, index) => (
                <span
                  key={`app404-p-${index}`}
                  className="app404-mini-p"
                  style={{
                    left: item.left,
                    top: item.top,
                    width: `${item.size}px`,
                    height: `${item.size}px`,
                    background: item.color,
                    boxShadow: `0 0 ${item.size}px ${item.shadow}`,
                    "--dur": item.dur,
                    "--delay": item.delay,
                    "--dy": item.dy,
                    "--op": item.op
                  }}
                />
              ))}
            </div>

            <div className="app404-error-number">
              <div className="app404-orbit-ring app404-orbit-ring-2">
                <span className="app404-orbit-dot" />
                <span className="app404-orbit-dot" />
              </div>
              <div className="app404-orbit-ring app404-orbit-ring-1">
                <span className="app404-orbit-dot" />
                <span className="app404-orbit-dot" />
                <span className="app404-orbit-dot" />
              </div>
              <div className="app404-error-number-text">404</div>
              <div className="app404-error-icon-float">
                <i className="fas fa-face-sad-tear" />
              </div>
            </div>

            <h1 className="app404-error-title">Halaman tidak ditemukan</h1>
            <p className="app404-error-desc">
              Maaf, halaman yang kamu cari <strong>tidak ada</strong> atau sudah dipindahkan.
              Mungkin URL yang dimasukkan salah atau halaman sudah dihapus.
            </p>

            <div className="app404-error-path">
              <i className="fas fa-circle-exclamation" />
              <span>{pathName || "/"}</span>
            </div>

            <div className="app404-error-actions">
              <button type="button" className="app404-btn-action app404-btn-primary" onClick={onGoHome}>
                <i className="fas fa-house" />
                Ke Dashboard
              </button>
              <button type="button" className="app404-btn-action app404-btn-secondary" onClick={onGoLogin}>
                <i className="fas fa-right-to-bracket" />
                Ke Login
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

const months = [
  { value: "01", label: "Januari" },
  { value: "02", label: "Februari" },
  { value: "03", label: "Maret" },
  { value: "04", label: "April" },
  { value: "05", label: "Mei" },
  { value: "06", label: "Juni" },
  { value: "07", label: "Juli" },
  { value: "08", label: "Agustus" },
  { value: "09", label: "September" },
  { value: "10", label: "Oktober" },
  { value: "11", label: "November" },
  { value: "12", label: "Desember" }
];

const notificationDays = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
const notificationHours = Array.from({ length: 24 }, (_, hour) => hour);

const expenseCategories = ["Semua", "Kebersihan", "Konsumsi", "Perlengkapan", "Kegiatan", "Sosial", "Lainnya"];
const loginSparkles = [
  { left: "8%", top: "14%", size: 12, delay: "-1.2s", duration: "6s", color: "rgba(59,181,160,0.72)" },
  { left: "20%", top: "78%", size: 10, delay: "-2.4s", duration: "5.5s", color: "rgba(255,181,167,0.7)" },
  { left: "34%", top: "20%", size: 14, delay: "-3.1s", duration: "6.8s", color: "rgba(255,209,102,0.75)" },
  { left: "48%", top: "72%", size: 12, delay: "-1.8s", duration: "5.9s", color: "rgba(195,174,255,0.72)" },
  { left: "62%", top: "18%", size: 16, delay: "-4.3s", duration: "7s", color: "rgba(255,159,178,0.72)" },
  { left: "74%", top: "68%", size: 10, delay: "-2.1s", duration: "5.7s", color: "rgba(59,181,160,0.68)" },
  { left: "86%", top: "28%", size: 14, delay: "-3.6s", duration: "6.3s", color: "rgba(195,174,255,0.72)" }
];
const loginBokeh = [
  { left: "10%", top: "18%", size: 90, color: "rgba(59,181,160,0.12)", duration: "14s", delay: "-2s" },
  { left: "76%", top: "16%", size: 120, color: "rgba(195,174,255,0.12)", duration: "18s", delay: "-5s" },
  { left: "68%", top: "70%", size: 86, color: "rgba(255,181,167,0.12)", duration: "16s", delay: "-1s" },
  { left: "18%", top: "76%", size: 132, color: "rgba(255,209,102,0.1)", duration: "20s", delay: "-7s" }
];
const loginRings = [
  { left: "14%", top: "28%", size: 58, color: "rgba(59,181,160,0.22)", duration: "18s", delay: "-3s" },
  { left: "82%", top: "32%", size: 76, color: "rgba(255,181,167,0.2)", duration: "20s", delay: "-6s" },
  { left: "28%", top: "82%", size: 48, color: "rgba(195,174,255,0.24)", duration: "16s", delay: "-2s" },
  { left: "72%", top: "84%", size: 62, color: "rgba(255,209,102,0.22)", duration: "17s", delay: "-4s" }
];

function formatCurrency(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(value ?? 0);
}

function formatShortCurrency(value) {
  const amount = Number(value ?? 0);
  if (amount >= 1_000_000) {
    return `Rp ${Math.round(amount / 100_000) / 10}jt`;
  }
  if (amount >= 1_000) {
    return `Rp ${Math.round(amount / 1000)}rb`;
  }
  return formatCurrency(amount);
}

function getInitials(name) {
  return (name ?? "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function renderUserAvatar(user) {
  if (user?.profilePhoto) {
    return <img className="user-photo" src={user.profilePhoto} alt={user.fullName} />;
  }

  return getInitials(user?.fullName);
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Gagal membaca file gambar."));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gagal memuat gambar."));
    image.src = source;
  });
}

async function cropImageToSquare(file, outputSize = 512) {
  const source = await readImageFile(file);
  const image = await loadImage(source);
  const cropSide = Math.min(image.width, image.height);
  const cropX = Math.max(0, (image.width - cropSide) / 2);
  const cropY = Math.max(0, (image.height - cropSide) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");

  context.drawImage(image, cropX, cropY, cropSide, cropSide, 0, 0, outputSize, outputSize);
  return canvas.toDataURL("image/png");
}

function getCropperDimensions(aspect) {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const isMobileViewport = viewportWidth <= 640;

  if (aspect === "landscape") {
    const baseWidth = isMobileViewport ? Math.min(320, Math.max(260, viewportWidth - 72)) : 420;
    return {
      viewportWidth: baseWidth,
      viewportHeight: Math.round(baseWidth * 0.5625),
      outputWidth: 1200,
      outputHeight: 675
    };
  }

  const squareSize = isMobileViewport ? Math.min(280, Math.max(220, viewportWidth - 112)) : 280;
  return {
    viewportWidth: squareSize,
    viewportHeight: squareSize,
    outputWidth: 512,
    outputHeight: 512
  };
}

function clampCropState(state) {
  const renderedWidth = state.imageWidth * state.zoom;
  const renderedHeight = state.imageHeight * state.zoom;
  const maxPanX = Math.max(0, (renderedWidth - state.viewportWidth) / 2);
  const maxPanY = Math.max(0, (renderedHeight - state.viewportHeight) / 2);

  return {
    ...state,
    panX: Math.min(maxPanX, Math.max(-maxPanX, state.panX)),
    panY: Math.min(maxPanY, Math.max(-maxPanY, state.panY))
  };
}

function avatarGradient(index) {
  const palette = [
    ["#60A5FA", "#3B82F6"],
    ["#6EE7B7", "#10B981"],
    ["#F9A8D4", "#EC4899"],
    ["#C4B5FD", "#8B5CF6"],
    ["#FCD34D", "#F59E0B"],
    ["#67E8F9", "#06B6D4"]
  ];
  const [from, to] = palette[index % palette.length];
  return { background: `linear-gradient(135deg, ${from}, ${to})` };
}

function formatDateLabel(dateString) {
  if (!dateString) {
    return "-";
  }

  return new Date(dateString).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function formatAcademicYearLabel(value, fallback = null) {
  return value ?? fallback ?? "Belum diatur";
}

function buildAcademicMonthStatuses(students = [], transactions = [], academicYearName = "", now = new Date()) {
  const orderedMonths = buildAcademicMonthSequence(academicYearName, now);
  const { studentSlots } = allocateCashPaymentsByAcademicMonths(students, transactions, academicYearName, now);
  const primaryStudentId = students?.[0]?.id;
  const studentWeeks = primaryStudentId ? studentSlots.get(primaryStudentId) ?? [] : [];
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  return orderedMonths.map((item, monthIndex) => {
    const key = item.key;
    const monthStart = new Date(item.year, Number(item.value) - 1, 1);
    const monthWeeks = studentWeeks.slice(monthIndex * 4, monthIndex * 4 + 4);
    const total = monthWeeks.reduce((sum, value) => sum + Number(value ?? 0), 0);
    const count = monthWeeks.filter((value) => Number(value ?? 0) > 0).length;
    const isFutureOrCurrent = monthStart >= currentMonthStart;
    const status = total > 0 ? "paid" : isFutureOrCurrent ? "upcoming" : "unpaid";

    return {
      ...item,
      key,
      total,
      count,
      latestDate: null,
      status,
      statusLabel: total > 0 ? "Sudah bayar" : isFutureOrCurrent ? "Belum waktunya" : "Belum bayar"
    };
  });
}

function buildWeeklyPaymentMatrix(students, transactions) {
  const studentMap = new Map(
    (students ?? []).map((student) => [
      student.id,
      {
        student,
        weeks: [],
        paidWeeks: 0
      }
    ])
  );

  const cashTransactions = (transactions ?? [])
    .filter(
      (item) =>
        item.type === "income" &&
        String(item.category ?? "").toLowerCase() !== "denda" &&
        item.student_id
    )
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || Number(a.id) - Number(b.id)
    );

  for (const item of cashTransactions) {
    const entry = studentMap.get(item.student_id);

    if (!entry) {
      continue;
    }

    const weeklyNominal = Math.max(Number(entry.student.nominalKas ?? 0), 0);
    const amount = Math.max(Number(item.amount ?? 0), 0);

    if (weeklyNominal <= 0 || amount <= 0) {
      continue;
    }

    let remaining = amount;

    while (remaining > 0) {
      const allocated = Math.min(weeklyNominal, remaining);
      entry.weeks.push(allocated);
      remaining -= allocated;
    }

    entry.paidWeeks = entry.weeks.length;
  }

  const rows = Array.from(studentMap.values()).map(({ student, weeks, paidWeeks }) => {
    const totalWeeks = Math.max(
      paidWeeks + Math.max(Number(student.outstandingPeriods ?? 0), 0),
      1
    );

    return {
      student,
      paidWeeks,
      totalWeeks,
      displayWeeks: Array.from({ length: totalWeeks }, (_, index) => ({
        weekNumber: index + 1,
        amount: weeks[index] ?? 0,
        isPaid: index < paidWeeks
      }))
    };
  });

  const maxWeeks = rows.reduce((max, row) => Math.max(max, row.totalWeeks), 1);

  return {
    maxWeeks,
    rows: rows.map((row) => ({
      ...row,
      displayWeeks: Array.from({ length: maxWeeks }, (_, index) => ({
        weekNumber: index + 1,
        amount: row.displayWeeks[index]?.amount ?? 0,
        isPaid: row.displayWeeks[index]?.isPaid ?? false
      }))
    }))
  };
}

function parseWeekNumberFromText(value) {
  const text = String(value ?? "");
  const match = text.match(/minggu\s*(?:ke)?\s*(\d+)/i);
  const weekNumber = Number(match?.[1] ?? 0);
  return weekNumber >= 1 && weekNumber <= 4 ? weekNumber : null;
}

function parseMonthValueFromText(value) {
  const text = String(value ?? "").toLowerCase();

  if (!text) {
    return null;
  }

  const monthAliases = [
    ["01", ["januari", "january", "jan"]],
    ["02", ["februari", "february", "feb"]],
    ["03", ["maret", "march", "mar"]],
    ["04", ["april", "apr"]],
    ["05", ["mei", "may"]],
    ["06", ["juni", "june", "jun"]],
    ["07", ["juli", "july", "jul"]],
    ["08", ["agustus", "august", "agu", "aug"]],
    ["09", ["september", "sep"]],
    ["10", ["oktober", "october", "okt", "oct"]],
    ["11", ["november", "nov"]],
    ["12", ["desember", "december", "des", "dec"]]
  ];

  for (const [monthValue, aliases] of monthAliases) {
    if (aliases.some((alias) => text.includes(alias))) {
      return monthValue;
    }
  }

  return null;
}

function buildAcademicMonthSequence(academicYearName = "", fallbackDate = new Date()) {
  const match = String(academicYearName ?? "").match(/(\d{4})\s*\/\s*(\d{4})/);

  if (!match) {
    const currentYear = fallbackDate.getFullYear();
    return months.map((item) => ({
      ...item,
      year: currentYear,
      key: `${currentYear}-${item.value}`
    }));
  }

  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  return [
    ...months.filter((item) => Number(item.value) >= 7).map((item) => ({
      ...item,
      year: startYear,
      key: `${startYear}-${item.value}`
    })),
    ...months.filter((item) => Number(item.value) <= 6).map((item) => ({
      ...item,
      year: endYear,
      key: `${endYear}-${item.value}`
    }))
  ];
}

function getAcademicYearForMonth(monthValue, academicYearName = "", fallbackDate = new Date()) {
  const monthNumber = Number(monthValue);
  const monthSequence = buildAcademicMonthSequence(academicYearName, fallbackDate);
  const matchedMonth = monthSequence.find((item) => Number(item.value) === monthNumber);
  return matchedMonth?.year ?? fallbackDate.getFullYear();
}

function allocateCashPaymentsByAcademicMonths(students = [], transactions = [], academicYearName = "", fallbackDate = new Date()) {
  const monthSequence = buildAcademicMonthSequence(academicYearName, fallbackDate);
  const monthIndexMap = new Map(monthSequence.map((item, index) => [item.key, index]));
  const totalSlots = monthSequence.length * 4;
  const studentSlots = new Map(
    (students ?? []).map((student) => [student.id, Array.from({ length: totalSlots }, () => 0)])
  );

  const cashTransactions = (transactions ?? [])
    .filter(
      (item) =>
        item.type === "income" &&
        String(item.category ?? "").toLowerCase() !== "denda" &&
        item.student_id &&
        monthIndexMap.has(
          `${new Date(item.created_at).getFullYear()}-${String(new Date(item.created_at).getMonth() + 1).padStart(2, "0")}`
        )
    )
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || Number(a.id) - Number(b.id)
    );

  for (const item of cashTransactions) {
    const slots = studentSlots.get(item.student_id);
    const student = (students ?? []).find((entry) => Number(entry.id) === Number(item.student_id));

    if (!slots || !student) {
      continue;
    }

    const createdAt = new Date(item.created_at);
    const requestedMonthValue = parseMonthValueFromText(`${item.title ?? ""} ${item.note ?? ""}`);
    const requestedMonthYear =
      requestedMonthValue && Number(requestedMonthValue) >= 7
        ? monthSequence.find((entry) => entry.value === requestedMonthValue)?.year
        : monthSequence.find((entry) => entry.value === requestedMonthValue)?.year;
    const monthKey = requestedMonthValue && requestedMonthYear
      ? `${requestedMonthYear}-${requestedMonthValue}`
      : `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
    const monthIndex = monthIndexMap.get(monthKey);

    if (monthIndex === undefined) {
      continue;
    }

    const weeklyNominal = Math.max(Number(student.nominalKas ?? 0), 0);
    let remaining = Math.max(Number(item.amount ?? 0), 0);

    if (remaining <= 0) {
      continue;
    }

    const explicitWeek = parseWeekNumberFromText(item.title || item.note);
    let slotIndex = explicitWeek
      ? monthIndex * 4 + (explicitWeek - 1)
      : slots.findIndex((value, index) => index >= monthIndex * 4 && value < weeklyNominal);

    if (slotIndex < 0) {
      slotIndex = monthIndex * 4;
    }

    while (remaining > 0 && slotIndex < slots.length) {
      if (weeklyNominal <= 0) {
        slots[slotIndex] += remaining;
        remaining = 0;
        break;
      }

      const slotRemaining = Math.max(weeklyNominal - slots[slotIndex], 0);

      if (slotRemaining <= 0) {
        slotIndex += 1;
        continue;
      }

      const allocation = Math.min(slotRemaining, remaining);
      slots[slotIndex] += allocation;
      remaining -= allocation;

      if (slots[slotIndex] >= weeklyNominal) {
        slotIndex += 1;
      }
    }
  }

  return { monthSequence, studentSlots };
}

function buildMonthlyWeeklyPaymentTable(students, transactions, monthValue, academicYearName = "") {
  const monthNumber = Number(monthValue);
  const selectedYear = getAcademicYearForMonth(monthValue, academicYearName, new Date());
  const { monthSequence, studentSlots } = allocateCashPaymentsByAcademicMonths(
    students,
    transactions,
    academicYearName,
    new Date()
  );
  const selectedMonthIndex = monthSequence.findIndex(
    (item) => item.year === selectedYear && Number(item.value) === monthNumber
  );

  const tableRows = (students ?? []).map((student) => {
    const slots = studentSlots.get(student.id) ?? [];
    const startIndex = selectedMonthIndex >= 0 ? selectedMonthIndex * 4 : 0;
    const monthWeeks = slots.slice(startIndex, startIndex + 4);

    return {
      student,
      weeks: monthWeeks,
      total: monthWeeks.reduce((sum, value) => sum + value, 0)
    };
  });

  const totals = [0, 0, 0, 0];

  tableRows.forEach((row) => {
    row.weeks.forEach((amount, index) => {
      totals[index] += amount;
    });
  });

  return {
    rows: tableRows,
    totals,
    grandTotal: totals.reduce((sum, value) => sum + value, 0)
  };
}

function slugifyFilePart(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "laporan";
}

function isValidFullName(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return /^[\p{L}\s.'-]+$/u.test(normalized) && /\p{L}/u.test(normalized);
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value ?? "").trim());
}

function validateUserAccountForm(form, { editing = false } = {}) {
  const errors = {};
  const fullName = String(form.fullName ?? "").trim();
  const email = String(form.email ?? "").trim();
  const password = String(form.password ?? "");

  if (!fullName) {
    errors.fullName = "Nama wajib diisi.";
  } else if (!isValidFullName(fullName)) {
    errors.fullName = "Nama hanya boleh huruf, spasi, titik, petik, atau strip.";
  }

  if (!email) {
    errors.email = "Email wajib diisi.";
  } else if (!isValidEmailAddress(email)) {
    errors.email = "Email harus benar, contoh: nama@gmail.com.";
  }

  if (!editing && !password.trim()) {
    errors.password = "Password wajib diisi.";
  } else if (password.trim() && password.trim().length < 6) {
    errors.password = "Password minimal 6 karakter.";
  }

  return errors;
}

function PasswordField({
  value,
  onChange,
  placeholder = "",
  required = false,
  className = "form-input",
  autoComplete = "current-password"
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-input-wrap">
      <input
        className={className}
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="password-toggle-btn"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "Sembunyikan password" : "Lihat password"}
        title={visible ? "Sembunyikan password" : "Lihat password"}
      >
        <i className={`fas ${visible ? "fa-eye-slash" : "fa-eye"}`} />
      </button>
    </div>
  );
}

function createReportRows(transactions) {
  const grouped = new Map();

  for (const item of transactions) {
    const key = item.class_name ?? "Tanpa Kelas";
    if (!grouped.has(key)) {
      grouped.set(key, {
        className: key,
        regularIncome: 0,
        fine: 0,
        expense: 0
      });
    }

    const row = grouped.get(key);
    if (item.type === "income" && String(item.category ?? "").toLowerCase() === "denda") {
      row.fine += Number(item.amount ?? 0);
    } else if (item.type === "income") {
      row.regularIncome += Number(item.amount ?? 0);
    } else {
      row.expense += Number(item.amount ?? 0);
    }
  }

  return [...grouped.values()].map((item) => ({
    ...item,
    income: item.regularIncome + item.fine,
    balance: item.regularIncome + item.fine - item.expense
  }));
}

function filterTransactionsByPeriod(transactions, period) {
  if (!transactions.length) {
    return [];
  }

  const latestDate = transactions.reduce((latest, item) => {
    const itemDate = new Date(item.created_at);
    return itemDate.getTime() > latest.getTime() ? itemDate : latest;
  }, new Date(transactions[0].created_at));

  const latestMonth = latestDate.getMonth();
  const latestYear = latestDate.getFullYear();
  const latestWeek = getWeekNumber(latestDate);

  return transactions.filter((item) => {
    const itemDate = new Date(item.created_at);

    if (period === "week") {
      return (
        itemDate.getFullYear() === latestYear &&
        itemDate.getMonth() === latestMonth &&
        getWeekNumber(itemDate) === latestWeek
      );
    }

    if (period === "month") {
      return itemDate.getFullYear() === latestYear && itemDate.getMonth() === latestMonth;
    }

    return itemDate.getFullYear() === latestYear;
  });
}

function getWeekNumber(date) {
  const currentDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = currentDate.getUTCDay() || 7;
  currentDate.setUTCDate(currentDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(currentDate.getUTCFullYear(), 0, 1));
  return Math.ceil(((currentDate - yearStart) / 86400000 + 1) / 7);
}

function buildFineChartRows(transactions, period) {
  if (!transactions.length) {
    return {
      periodLabels: [],
      classRows: []
    };
  }

  const latestDate = transactions.reduce((latest, item) => {
    const itemDate = new Date(item.created_at);
    return itemDate.getTime() > latest.getTime() ? itemDate : latest;
  }, new Date(transactions[0].created_at));

  const latestMonth = latestDate.getMonth();
  const latestYear = latestDate.getFullYear();
  const years = Array.from(new Set(transactions.map((item) => new Date(item.created_at).getFullYear())))
    .sort((a, b) => a - b)
    .slice(-5);

  const periodLabels =
    period === "week"
      ? Array.from({ length: 5 }, (_, index) => `Minggu ${index + 1}`)
      : period === "month"
        ? months.map((item) => item.label.slice(0, 3))
        : years.map((year) => `${year}`);

  const classMap = new Map();

  transactions.forEach((item) => {
    const itemDate = new Date(item.created_at);
    let periodIndex = -1;

    if (period === "week") {
      if (itemDate.getFullYear() !== latestYear || itemDate.getMonth() !== latestMonth) {
        return;
      }
      periodIndex = Math.min(5, Math.floor((itemDate.getDate() - 1) / 7) + 1) - 1;
    } else if (period === "month") {
      if (itemDate.getFullYear() !== latestYear) {
        return;
      }
      periodIndex = itemDate.getMonth();
    } else {
      periodIndex = years.indexOf(itemDate.getFullYear());
    }

    if (periodIndex < 0 || periodIndex >= periodLabels.length) {
      return;
    }

    const className = item.class_name ?? "Tanpa Kelas";
    if (!classMap.has(className)) {
      classMap.set(className, {
        key: className,
        label: className,
        values: Array(periodLabels.length).fill(0),
        totalAmount: 0
      });
    }

    const row = classMap.get(className);
    const amount = Number(item.amount ?? 0);
    row.values[periodIndex] += amount;
    row.totalAmount += amount;
  });

  return {
    periodLabels,
    classRows: [...classMap.values()].sort((a, b) => a.label.localeCompare(b.label))
  };
}

function buildFinanceChartRows(transactions, period) {
  transactions = transactions.filter((item) => Number.isFinite(new Date(item.created_at).getTime()));
  const latestDate = transactions.length
    ? transactions.reduce((latest, item) => {
        const itemDate = new Date(item.created_at);
        return itemDate.getTime() > latest.getTime() ? itemDate : latest;
      }, new Date(transactions[0].created_at))
    : new Date();
  const latestMonth = latestDate.getMonth();
  const latestYear = latestDate.getFullYear();
  const years = Array.from(
    new Set([...transactions.map((item) => new Date(item.created_at).getFullYear()), latestYear])
  )
    .sort((a, b) => a - b)
    .slice(-5);
  const labels =
    period === "week"
      ? Array.from({ length: Math.ceil(new Date(latestYear, latestMonth + 1, 0).getDate() / 7) }, (_, index) => `Minggu ${index + 1}`)
      : period === "month"
        ? months.map((item) => item.label.slice(0, 3))
        : years.map((year) => `${year}`);
  const rows = labels.map((label) => ({
    label,
    regularIncome: 0,
    fine: 0,
    expense: 0
  }));

  transactions.forEach((item) => {
    const itemDate = new Date(item.created_at);
    let periodIndex = -1;

    if (period === "week") {
      if (itemDate.getFullYear() !== latestYear || itemDate.getMonth() !== latestMonth) {
        return;
      }
      periodIndex = Math.floor((itemDate.getDate() - 1) / 7);
    } else if (period === "month") {
      if (itemDate.getFullYear() !== latestYear) {
        return;
      }
      periodIndex = itemDate.getMonth();
    } else {
      periodIndex = years.indexOf(itemDate.getFullYear());
    }

    if (periodIndex < 0 || periodIndex >= rows.length) {
      return;
    }

    const amount = Number(item.amount ?? 0);
    if (!Number.isFinite(amount)) return;
    if (item.type === "income" && String(item.category ?? "").trim().toLowerCase() === "denda") {
      rows[periodIndex].fine += amount;
    } else if (item.type === "income") {
      rows[periodIndex].regularIncome += amount;
    } else if (item.type === "expense") {
      rows[periodIndex].expense += amount;
    }
  });

  return rows;
}

function getLatestTransactionPeriod(transactions) {
  if (!transactions.length) {
    const now = new Date();
    return {
      month: String(now.getMonth() + 1).padStart(2, "0"),
      year: String(now.getFullYear())
    };
  }

  const latest = transactions.reduce((current, item) => {
    const currentTime = new Date(current.created_at ?? 0).getTime();
    const nextTime = new Date(item.created_at ?? 0).getTime();
    return nextTime > currentTime ? item : current;
  }, transactions[0]);

  const latestDate = new Date(latest.created_at);
  return {
    month: String(latestDate.getMonth() + 1).padStart(2, "0"),
    year: String(latestDate.getFullYear())
  };
}

function paginateItems(items, page, pageSize = 10) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    page: safePage,
    totalPages,
    rows: items.slice(start, start + pageSize)
  };
}

function PaginationControls({ page, totalPages, onChange }) {
  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="pagination-bar">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        <i className="fas fa-chevron-left" /> Sebelumnya
      </button>
      <span className="pagination-info">
        Halaman {page} dari {totalPages}
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        Berikutnya <i className="fas fa-chevron-right" />
      </button>
    </div>
  );
}

export default function App() {
  const initialStoredSession = (() => {
    try {
      const stored = window.localStorage.getItem(sessionStorageKey);
      return stored ? normalizeStoredSession(JSON.parse(stored)) : null;
    } catch {
      return null;
    }
  })();
  const initialStoredAppSettings = (() => {
    try {
      const stored = window.localStorage.getItem(appSettingsStorageKey);
      return stored ? { ...defaultAppSettings, ...JSON.parse(stored) } : defaultAppSettings;
    } catch {
      return defaultAppSettings;
    }
  })();
  const initialRouteInfo = (() => {
    try {
      return getRouteInfo(window.location.pathname, initialStoredSession?.auth?.role ?? null);
    } catch {
      return { role: null, page: "login" };
    }
  })();
  const googleSigninRef = useRef(null);
  const [health, setHealth] = useState({ loading: true, error: "", data: null });
  const [session, setSession] = useState(initialStoredSession);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState(
    initialRouteInfo.page && initialRouteInfo.page !== "login"
      ? initialRouteInfo.page
      : initialStoredSession?.preferences?.last_active_page || "dashboard"
  );
  const [sessionRestored, setSessionRestored] = useState(false);
  const [loginForm, setLoginForm] = useState(defaultCredentials);
  const [loginState, setLoginState] = useState({ loading: false, error: "", mode: "" });
  const [loginUi, setLoginUi] = useState({ remember: true, showPassword: false });
  const [dashboard, setDashboard] = useState({
    loading: false,
    error: "",
    overview: null,
    users: [],
    classes: [],
    restore: { users: [], classes: [] },
    years: [],
    settings: null,
    monitoring: { transactions: [], arrears: [] }
  });
  const [userFilters, setUserFilters] = useState({ role: "semua", className: "semua" });
  const [userSearch, setUserSearch] = useState("");
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [classModalOpen, setClassModalOpen] = useState(false);
  const [editingClass, setEditingClass] = useState(null);
  const [userForm, setUserForm] = useState({
    fullName: "",
    nis: "",
    email: "",
    password: "",
    profilePhoto: "",
    profilePhotoOriginal: "",
    role: "siswa",
    classId: "",
    isActive: true
  });
  const [userFormErrors, setUserFormErrors] = useState({});
  const [classForm, setClassForm] = useState({
    name: "",
    nominalKas: "",
    academicYearId: "",
    treasurerUserId: ""
  });
  const [classYearFilter, setClassYearFilter] = useState("semua");
  const [cashForm, setCashForm] = useState({
    paymentCycle: "mingguan",
    paymentDay: "Senin",
    notificationDay: "Senin",
    notificationHour: 8
  });
  const [settingToggles, setSettingToggles] = useState({
    notif: true,
    late: true,
    autoReport: true
  });
  const [incomeFilter, setIncomeFilter] = useState("Semua");
  const [fineFilter, setFineFilter] = useState("Semua");
  const [fineChartPeriod, setFineChartPeriod] = useState("month");
  const [fineChartType, setFineChartType] = useState("line");
  const [fineChartClassFilter, setFineChartClassFilter] = useState("all");
  const [dashboardChartPeriod, setDashboardChartPeriod] = useState("week");
  const [expenseFilter, setExpenseFilter] = useState("Semua");
  const [balanceFilter, setBalanceFilter] = useState("Semua");
  const [reportFilters, setReportFilters] = useState({
    className: "semua",
    month: String(new Date().getMonth() + 1).padStart(2, "0"),
    year: String(new Date().getFullYear())
  });
  const [userPage, setUserPage] = useState(1);
  const [classPage, setClassPage] = useState(1);
  const [restoreType, setRestoreType] = useState("all");
  const [restorePage, setRestorePage] = useState(1);
  const [reportGenerated, setReportGenerated] = useState(false);
  const [toast, setToast] = useState(null);
  const [backupImportFile, setBackupImportFile] = useState(null);
  const [backupBusy, setBackupBusy] = useState({ download: false, restore: false });
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [routeNotFound, setRouteNotFound] = useState(initialRouteInfo.found === false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [cropperOpen, setCropperOpen] = useState(false);
  const [cropperState, setCropperState] = useState({
    target: null,
    title: "",
    source: "",
    aspect: "square",
    viewportWidth: 320,
    viewportHeight: 320,
    outputWidth: 512,
    outputHeight: 512,
    imageWidth: 0,
    imageHeight: 0,
    zoom: 1,
    minZoom: 1,
    panX: 0,
    panY: 0,
    originalSource: ""
  });
  const [cropDragging, setCropDragging] = useState(false);
  const cropDragRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0
  });
  const [profileForm, setProfileForm] = useState({
    fullName: "",
    email: "",
    password: "",
    profilePhoto: "",
    profilePhotoOriginal: "",
    isActive: true
  });
  const [appSettings, setAppSettings] = useState(initialStoredAppSettings);
  const backupFileInputRef = useRef(null);
  const reportFilterAutoInitRef = useRef(false);
  const cashFormDirtyRef = useRef(false);

  function showToast(message, type = "success") {
    setToast({ message, type, id: Date.now() });
    window.setTimeout(() => setToast(null), 2600);
  }

  function updateUserFormField(field, value) {
    setUserForm((current) => ({ ...current, [field]: value }));
    setUserFormErrors((current) => {
      if (!current[field]) {
        return current;
      }

      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function openTreasurerCropper({ target, title, source, aspect = "square" }) {
    try {
      const image = await loadImage(source);
      const dimensions = getCropperDimensions(aspect);
      const minZoom = Math.max(
        dimensions.viewportWidth / image.width,
        dimensions.viewportHeight / image.height
      );

      setCropperState({
        target,
        title,
        source,
        aspect,
        viewportWidth: dimensions.viewportWidth,
        viewportHeight: dimensions.viewportHeight,
        outputWidth: dimensions.outputWidth,
        outputHeight: dimensions.outputHeight,
        imageWidth: image.width,
        imageHeight: image.height,
        zoom: minZoom,
        minZoom,
        panX: 0,
        panY: 0
      });
      setCropperOpen(true);
    } catch (error) {
      showToast(error.message || "Gagal membuka crop gambar.", "error");
    }
  }

  async function openTreasurerCropperFromFile({ target, title, file, aspect = "square" }) {
    try {
      const source = await readImageFile(file);
      await openTreasurerCropper({ target, title, source, aspect });
    } catch (error) {
      showToast(error.message || "Gagal membaca gambar.", "error");
    }
  }

  function handleCropPointerDown(event) {
    if (!cropperOpen) {
      return;
    }

    event.preventDefault();
    cropDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: cropperState.panX,
      startPanY: cropperState.panY
    };
    setCropDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleCropPointerMove(event) {
    if (!cropDragging || cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - cropDragRef.current.startX;
    const deltaY = event.clientY - cropDragRef.current.startY;

    setCropperState((current) =>
      clampCropState({
        ...current,
        panX: cropDragRef.current.startPanX + deltaX,
        panY: cropDragRef.current.startPanY + deltaY
      })
    );
  }

  function handleCropPointerUp(event) {
    if (cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    setCropDragging(false);
    cropDragRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      startPanX: 0,
      startPanY: 0
    };
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  async function openCropper({ target, title, source, aspect = "square", fit = "cover", originalSource = "" }) {
    try {
      const image = await loadImage(source);
      const dimensions = getCropperDimensions(aspect);
      const coverZoom = Math.max(
        dimensions.viewportWidth / image.width,
        dimensions.viewportHeight / image.height
      );
      const containZoom = Math.min(
        dimensions.viewportWidth / image.width,
        dimensions.viewportHeight / image.height
      );
      const minZoom = fit === "contain" ? containZoom : coverZoom;

      setCropperState({
        target,
        title,
        source,
        aspect,
        viewportWidth: dimensions.viewportWidth,
        viewportHeight: dimensions.viewportHeight,
        outputWidth: dimensions.outputWidth,
        outputHeight: dimensions.outputHeight,
        imageWidth: image.width,
        imageHeight: image.height,
        zoom: minZoom,
        minZoom,
        panX: 0,
        panY: 0,
        originalSource: originalSource || source
      });
      setCropperOpen(true);
    } catch (error) {
      showToast(error.message || "Gagal membuka crop gambar.", "error");
    }
  }

  async function openCropperFromFile({ target, title, file, aspect = "square", fit = "cover", originalSource = false }) {
    try {
      const source = await readImageFile(file);
      await openCropper({ target, title, source, aspect, fit, originalSource: originalSource ? source : "" });
    } catch (error) {
      showToast(error.message || "Gagal membaca gambar.", "error");
    }
  }

  function handleCropPointerDown(event) {
    if (!cropperOpen) {
      return;
    }

    event.preventDefault();
    cropDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: cropperState.panX,
      startPanY: cropperState.panY
    };
    setCropDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleCropPointerMove(event) {
    if (!cropDragging || cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const deltaX = event.clientX - cropDragRef.current.startX;
    const deltaY = event.clientY - cropDragRef.current.startY;

    setCropperState((current) =>
      clampCropState({
        ...current,
        panX: cropDragRef.current.startPanX + deltaX,
        panY: cropDragRef.current.startPanY + deltaY
      })
    );
  }

  function handleCropPointerUp(event) {
    if (cropDragRef.current.pointerId !== null && cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    cropDragRef.current.pointerId = null;
    setCropDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  useEffect(() => {
    async function loadHealth() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`);
        if (!response.ok) {
          throw new Error("Gagal mengambil status backend.");
        }
        const data = await response.json();
        setHealth({ loading: false, error: "", data });
      } catch (error) {
        setHealth({ loading: false, error: error.message, data: null });
      }
    }

    loadHealth();
  }, []);

  useEffect(() => {
    if (session || !googleClientId || !googleSigninRef.current) {
      return undefined;
    }

    let cancelled = false;

    async function initGoogleSignin() {
      try {
        await loadGoogleIdentityScript();

        if (cancelled || !googleSigninRef.current || !window.google?.accounts?.id) {
          return;
        }

        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (googleResponse) => {
            if (!googleResponse?.credential) {
              setLoginState({
                loading: false,
                error: "Google tidak mengirim data login.",
                mode: ""
              });
              return;
            }

            setLoginState({
              loading: true,
              error: "",
              mode: "google"
            });

            try {
              const data = await apiFetch("/api/auth/google", {
                method: "POST",
                body: JSON.stringify({ credential: googleResponse.credential })
              });

              setSession(data);
              setActivePage(data.preferences?.last_active_page || "dashboard");
              setLoginState({ loading: false, error: "", mode: "" });
            } catch (error) {
              setLoginState({
                loading: false,
                error: error.message || "Login Google gagal.",
                mode: ""
              });
            }
          },
          auto_select: false,
          cancel_on_tap_outside: true,
          context: "signin"
        });

        googleSigninRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(googleSigninRef.current, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
          width: googleSigninRef.current.offsetWidth || 320,
          logo_alignment: "left"
        });
      } catch (error) {
        setLoginState({
          loading: false,
          error: error.message || "Google Sign-In gagal dimuat.",
          mode: ""
        });
      }
    }

    initGoogleSignin();

    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    async function restoreSession() {
      if (!session?.auth?.sessionToken) {
        setSessionRestored(true);
        return;
      }

      try {
        const response = await fetch(`${apiBaseUrl}/api/auth/session`, {
          headers: {
            "Content-Type": "application/json",
            "x-session-token": session.auth.sessionToken
          }
        });

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error("SESSION_INVALID");
          }

          throw new Error("SESSION_RETRY");
        }

        const result = await response.json();
        setSession(result);
        setActivePage(result.preferences?.last_active_page || "dashboard");
      } catch (error) {
        if (error.message === "SESSION_INVALID") {
          setSession(null);
          setActivePage("dashboard");
        }
      } finally {
        setSessionRestored(true);
      }
    }

    restoreSession();
  }, []);

  useEffect(() => {
    async function loadAppSettings() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/app-settings`);
        if (!response.ok) {
          throw new Error("Gagal mengambil pengaturan aplikasi.");
        }

        const result = await response.json();
        setAppSettings({
          appName: result.app_name ?? defaultAppSettings.appName,
          logoImage: result.logo_image ?? "",
          logoOriginalImage: result.logo_original_image ?? result.logo_image ?? "",
          sidebarColor: result.sidebar_color ?? defaultAppSettings.sidebarColor,
          backgroundMode: result.background_mode ?? defaultAppSettings.backgroundMode,
          backgroundColor: result.background_color ?? defaultAppSettings.backgroundColor,
          backgroundImage: result.background_image ?? "",
          backgroundOriginalImage: result.background_original_image ?? result.background_image ?? ""
        });
      } catch {
        setAppSettings(defaultAppSettings);
      }
    }

    loadAppSettings();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(appSettingsStorageKey, JSON.stringify(appSettings));
    } catch {
      // ignore storage errors
    }
  }, [appSettings]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const currentAppName = `${appSettings?.appName ?? ""}`.trim() || defaultAppName;
    document.title = currentAppName;
  }, [appSettings]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (routeNotFound) {
      return;
    }

    if (!session?.auth?.role) {
      const loginPath = "/login";
      if (window.location.pathname !== loginPath) {
        window.history.replaceState({}, "", loginPath);
      }
      return;
    }

    const targetPath = buildAppPath(session.auth.role, activePage);
    if (window.location.pathname !== targetPath) {
      window.history.replaceState({}, "", targetPath);
    }
  }, [activePage, routeNotFound, session?.auth?.role]);

  useEffect(() => {
    const routeInfo = getRouteInfo(window.location.pathname, session?.auth?.role ?? null);

    if (!routeInfo.found) {
      setRouteNotFound(true);
      return;
    }

    setRouteNotFound(false);

    if (session?.auth?.role && routeInfo.page && routeInfo.page !== "login" && routeInfo.page !== activePage) {
      setActivePage(routeInfo.page);
    }
  }, [activePage, session?.auth?.role]);

  function goToHomePage() {
    if (session?.auth?.role) {
      setRouteNotFound(false);
      setActivePage("dashboard");
      window.history.replaceState({}, "", buildAppPath(session.auth.role, "dashboard"));
      return;
    }

    setRouteNotFound(false);
    window.history.replaceState({}, "", "/login");
  }

  function goToLoginPage() {
    setRouteNotFound(false);
    setSession(null);
    setActivePage("dashboard");
    window.history.replaceState({}, "", "/login");
  }

  if (routeNotFound) {
    return (
      <NotFoundView
        appName={appSettings.appName}
        pathName={typeof window !== "undefined" ? window.location.pathname : "/"}
        role={session?.auth?.role ?? null}
        onGoHome={goToHomePage}
        onGoLogin={goToLoginPage}
      />
    );
  }

  useEffect(() => {
    if (session?.auth?.role === "superadmin") {
      loadDashboard();
    }
  }, [session]);

  useEffect(() => {
    if (session?.auth?.role !== "superadmin") {
      return undefined;
    }

    const refreshDashboard = () => {
      if (document.visibilityState === "visible") {
        loadDashboard();
      }
    };

    const intervalId = window.setInterval(refreshDashboard, 3000);
    window.addEventListener("focus", refreshDashboard);
    document.addEventListener("visibilitychange", refreshDashboard);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshDashboard);
      document.removeEventListener("visibilitychange", refreshDashboard);
    };
  }, [session?.auth?.role]);

  useEffect(() => {
    try {
      if (session) {
        window.localStorage.setItem(sessionStorageKey, JSON.stringify(session));
      } else {
        window.localStorage.removeItem(sessionStorageKey);
      }
    } catch {
      // ignore storage errors
    }
  }, [session]);

  useEffect(() => {
    if (session?.user) {
      setProfileForm({
        fullName: session.user.fullName ?? "",
        email: session.user.email ?? "",
        password: "",
        profilePhoto: session.user.profilePhoto ?? "",
        profilePhotoOriginal: session.user.profilePhotoOriginal ?? session.user.profilePhoto ?? ""
      });
    }
  }, [session]);

  async function apiFetch(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(session
        ? {
            "x-user-role": session.auth.role,
            "x-user-id": String(session.auth.userId),
            "x-session-token": session.auth.sessionToken ?? ""
          }
        : {}),
      ...(options.headers ?? {})
    };

    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Permintaan gagal.");
    }

    return data;
  }

  async function loadDashboard() {
    setDashboard((current) => ({ ...current, loading: true, error: "" }));

    try {
      const [overview, users, classes, restore, years, settings, monitoring] = await Promise.all([
        apiFetch("/api/superadmin/overview"),
        apiFetch("/api/users"),
        apiFetch("/api/classes"),
        apiFetch("/api/restore/summary"),
        apiFetch("/api/academic-years"),
        apiFetch("/api/cash-settings"),
        apiFetch("/api/monitoring")
      ]);

      setDashboard({
        loading: false,
        error: "",
        overview,
        users: (users ?? []).map((item) => normalizeUserRecord(item)).filter(Boolean),
        classes,
        restore,
        years,
        settings,
        monitoring
      });

      if (!cashFormDirtyRef.current) {
        setCashForm({
          paymentCycle: settings?.payment_cycle ?? "mingguan",
          paymentDay: settings?.payment_day ?? "Senin",
          notificationDay: settings?.notification_day ?? settings?.payment_day ?? "Senin",
          notificationHour: Number(settings?.notification_hour ?? 8)
        });
      }
      setSettingToggles({
        notif: settings?.notify_unpaid ?? true,
        late: settings?.allow_late_payment ?? true,
        autoReport: settings?.auto_report ?? true
      });
    } catch (error) {
      setDashboard((current) => ({
        ...current,
        loading: false,
        error: error.message
      }));
    }
  }

  async function handleDownloadSystemBackup() {
    setBackupBusy((current) => ({ ...current, download: true }));

    try {
      const response = await fetch(`${apiBaseUrl}/api/system/backup`, {
        headers: session
          ? {
              "x-user-role": session.auth.role,
              "x-user-id": String(session.auth.userId),
              "x-session-token": session.auth.sessionToken ?? ""
            }
          : {}
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Gagal membuat backup sistem.");
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const disposition = response.headers.get("content-disposition") || "";
      const matchedFileName = disposition.match(/filename="([^\"]+)"/i)?.[1];

      anchor.href = downloadUrl;
      anchor.download = matchedFileName || `backup-kasku-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);
      showToast("Backup sistem berhasil diunduh.");
    } catch (error) {
      showToast(error.message || "Gagal mengunduh backup sistem.", "error");
    } finally {
      setBackupBusy((current) => ({ ...current, download: false }));
    }
  }

  async function handleRestoreMergeSystem() {
    if (!backupImportFile) {
      showToast("Pilih file backup JSON terlebih dahulu.", "error");
      return;
    }

    setBackupBusy((current) => ({ ...current, restore: true }));

    try {
      const fileContent = await backupImportFile.text();
      const parsedPayload = JSON.parse(fileContent);
      const result = await apiFetch("/api/system/restore-merge", {
        method: "POST",
        body: JSON.stringify(parsedPayload)
      });

      setBackupImportFile(null);
      if (backupFileInputRef.current) {
        backupFileInputRef.current.value = "";
      }

      await loadDashboard();
      showToast(
        `${result.message} Diproses: ${Object.values(result.summary ?? {}).reduce((total, value) => total + Number(value || 0), 0)} item.`
      );
    } catch (error) {
      showToast(error.message || "Gagal restore database.", "error");
    } finally {
      setBackupBusy((current) => ({ ...current, restore: false }));
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginState({ loading: true, error: "", mode: "password" });

    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(loginForm)
      });
      setSession(data);
      setActivePage(data.preferences?.last_active_page || "dashboard");
      setLoginState({ loading: false, error: "", mode: "" });
    } catch (error) {
      setLoginState({ loading: false, error: error.message, mode: "" });
    }
  }

  async function handleLogout() {
    try {
      if (session?.auth?.sessionToken) {
        await fetch(`${apiBaseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-session-token": session.auth.sessionToken
          }
        });
      }
    } catch {
      // abaikan error logout
    } finally {
      setSession(null);
      setActivePage("dashboard");
    }
  }

  useEffect(() => {
    async function saveActivePage() {
      if (!sessionRestored || !session?.auth?.sessionToken || !session?.auth?.userId) {
        return;
      }

      try {
        await fetch(`${apiBaseUrl}/api/preferences`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-session-token": session.auth.sessionToken
          },
          body: JSON.stringify({
            lastActivePage: activePage
          })
        });
      } catch {
        // abaikan error preferensi
      }
    }

    saveActivePage();
  }, [activePage, sessionRestored, session?.auth?.sessionToken, session?.auth?.userId]);

  async function handleAddUser(event) {
    event.preventDefault();

    try {
      const errors = validateUserAccountForm(userForm, { editing: Boolean(editingUser) });
      setUserFormErrors(errors);

      if (Object.keys(errors).length > 0) {
        showToast("Periksa lagi data akun yang wajib diisi.", "error");
        return;
      }

      const payload = {
        ...userForm,
        fullName: userForm.fullName.trim().replace(/\s+/g, " "),
        email: userForm.email.trim(),
        password: userForm.password.trim(),
        nis: userForm.nis.trim(),
        classId: userForm.classId ? Number(userForm.classId) : null
      };

      if (editingUser) {
        await apiFetch(`/api/users/${editingUser.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload)
        });
      } else {
        await apiFetch("/api/users", {
          method: "POST",
          body: JSON.stringify(payload)
        });
      }

      setUserForm({
        fullName: "",
        nis: "",
        email: "",
        password: "",
        profilePhoto: "",
        profilePhotoOriginal: "",
        role: "siswa",
        classId: "",
        isActive: true
      });
      setUserFormErrors({});
      setEditingUser(null);
      setUserModalOpen(false);
      await loadDashboard();
      showToast(editingUser ? "Akun berhasil diperbarui." : "Akun berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan akun.", "error");
    }
  }

  function handleOpenAddUser() {
    setEditingUser(null);
    setUserFormErrors({});
    setUserForm({
      fullName: "",
      nis: "",
      email: "",
      password: "",
      profilePhoto: "",
      profilePhotoOriginal: "",
      role: "siswa",
      classId: "",
      isActive: true
    });
    setUserModalOpen(true);
  }

  function handleOpenEditUser(user) {
    setEditingUser(user);
    setUserFormErrors({});
    setUserForm({
      fullName: user.fullName ?? "",
      nis: user.nis ?? "",
      email: user.email ?? "",
      password: "",
      profilePhoto: user.profilePhoto ?? "",
      profilePhotoOriginal: user.profilePhotoOriginal ?? user.profilePhoto ?? "",
      role: user.role ?? "siswa",
      classId: user.classId ? String(user.classId) : "",
      isActive: user.isActive ?? true
    });
    setUserModalOpen(true);
  }

  function resetClassForm() {
    setClassForm({
      name: "",
      nominalKas: "",
      academicYearId: "",
      treasurerUserId: ""
    });
  }

  function handleOpenAddClass() {
    setEditingClass(null);
    resetClassForm();
    setClassModalOpen(true);
  }

  function handleOpenEditClass(item) {
    setEditingClass(item);
    setClassForm({
      name: item.name ?? "",
      nominalKas: String(item.nominal_kas ?? ""),
      academicYearId: item.academic_year_id ? String(item.academic_year_id) : "",
      treasurerUserId: item.treasurer_id ? String(item.treasurer_id) : ""
    });
    setClassModalOpen(true);
  }

  async function handleAddClass(event) {
    event.preventDefault();

    try {
      await apiFetch(editingClass ? `/api/classes/${editingClass.id}` : "/api/classes", {
        method: editingClass ? "PATCH" : "POST",
        body: JSON.stringify({
          ...classForm,
          nominalKas: Number(classForm.nominalKas) || 0,
          academicYearId: classForm.academicYearId ? Number(classForm.academicYearId) : null,
          treasurerUserId: classForm.treasurerUserId ? Number(classForm.treasurerUserId) : null
        })
      });

      resetClassForm();
      setEditingClass(null);
      setClassModalOpen(false);
      await loadDashboard();
      showToast(editingClass ? "Data kelas berhasil diperbarui." : "Kelas berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan kelas.", "error");
    }
  }

  async function handleToggleUser(user) {
    try {
      await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: user.fullName,
          role: user.role,
          classId: user.classId,
          isActive: !user.isActive
        })
      });
      await loadDashboard();
      showToast("Status akun berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan status akun.", "error");
    }
  }

  async function handlePromoteRole(user, role) {
    try {
      await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: user.fullName,
          role,
          classId: user.classId,
          isActive: user.isActive
        })
      });
      await loadDashboard();
      showToast("Role akun berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan role akun.", "error");
    }
  }

  async function handleDeleteUser(user) {
    const confirmed = window.confirm(`Hapus akun "${user.fullName}"?`);
    if (!confirmed) {
      return;
    }

    try {
      await apiFetch(`/api/users/${user.id}`, { method: "DELETE" });
      await loadDashboard();
      showToast("Akun berhasil dihapus.");
    } catch (error) {
      showToast(error.message || "Gagal menghapus akun.", "error");
    }
  }

  async function handleDeleteClass(classId) {
    try {
      await apiFetch(`/api/classes/${classId}`, { method: "DELETE" });
      await loadDashboard();
      showToast("Kelas berhasil dihapus.");
    } catch (error) {
      showToast(error.message || "Gagal menghapus kelas.", "error");
    }
  }

  async function handleRestoreItem(type, id) {
    try {
      await apiFetch(`/api/restore/${type}/${id}`, { method: "POST" });
      await loadDashboard();
      showToast(`${type === "users" ? "User" : "Kelas"} berhasil dikembalikan.`);
    } catch (error) {
      showToast(error.message || "Gagal mengembalikan data.", "error");
    }
  }

  async function handlePermanentDeleteRestoreItem(type, id, name) {
    const label = type === "users" ? "user" : "kelas";
    const confirmed = window.confirm(`Hapus permanen ${label} "${name}"? Data tidak bisa dikembalikan lagi.`);

    if (!confirmed) {
      return;
    }

    try {
      await apiFetch(`/api/restore/${type}/${id}`, { method: "DELETE" });
      await loadDashboard();
      showToast(`${type === "users" ? "User" : "Kelas"} berhasil dihapus permanen.`);
    } catch (error) {
      showToast(error.message || "Gagal menghapus permanen data.", "error");
    }
  }

  async function saveCashSettings(message, togglesOverride = settingToggles) {
    try {
      const savedSettings = await apiFetch("/api/cash-settings", {
        method: "PUT",
        body: JSON.stringify({
          paymentCycle: cashForm.paymentCycle,
          paymentDay: cashForm.paymentDay,
          notificationDay: cashForm.notificationDay,
          notificationHour: cashForm.notificationHour,
          notifyUnpaid: togglesOverride.notif,
          allowLatePayment: togglesOverride.late,
          autoReport: togglesOverride.autoReport
        })
      });
      cashFormDirtyRef.current = false;
      setCashForm({
        paymentCycle: savedSettings?.payment_cycle ?? "mingguan",
        paymentDay: savedSettings?.payment_day ?? "Senin",
        notificationDay: savedSettings?.notification_day ?? savedSettings?.payment_day ?? "Senin",
        notificationHour: Number(savedSettings?.notification_hour ?? 8)
      });
      await loadDashboard();
      showToast(message);
    } catch (error) {
      showToast(error.message || "Gagal menyimpan pengaturan.", "error");
    }
  }

  async function handleSaveCashSettings(event) {
    event.preventDefault();
    await saveCashSettings("Pengaturan kas berhasil disimpan.");
  }

  async function handleSavePeriod(event) {
    event.preventDefault();
    await saveCashSettings("Jadwal notifikasi berhasil disimpan.");
  }

  async function handleAppLogoChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await openCropperFromFile({
        target: "appLogo",
        title: "Crop Logo Aplikasi",
        file,
        aspect: "square",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses logo.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleAppBackgroundChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await openCropperFromFile({
        target: "appBackground",
        title: "Crop Background Aplikasi",
        file,
        aspect: "landscape",
        fit: "contain",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses background.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleProfilePhotoChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await openCropperFromFile({
        target: "profilePhoto",
        title: "Crop Foto Profil",
        file,
        aspect: "square",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses foto.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleUserProfilePhotoChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await openCropperFromFile({
        target: "userFormProfilePhoto",
        title: "Crop Foto Akun",
        file,
        aspect: "square",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses foto akun.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleSaveAppSettings(event) {
    event.preventDefault();
    try {
      const result = await apiFetch("/api/app-settings", {
        method: "PUT",
        body: JSON.stringify({
          appName: appSettings.appName,
          logoImage: appSettings.logoImage || null,
          logoOriginalImage: appSettings.logoOriginalImage || appSettings.logoImage || null,
          sidebarColor: appSettings.sidebarColor,
          backgroundMode: appSettings.backgroundMode,
          backgroundColor: appSettings.backgroundColor,
          backgroundImage: appSettings.backgroundImage || null,
          backgroundOriginalImage: appSettings.backgroundOriginalImage || appSettings.backgroundImage || null
        })
      });

      setAppSettings({
        appName: result.app_name ?? defaultAppSettings.appName,
        logoImage: result.logo_image ?? "",
        logoOriginalImage: result.logo_original_image ?? result.logo_image ?? "",
        sidebarColor: result.sidebar_color ?? defaultAppSettings.sidebarColor,
        backgroundMode: result.background_mode ?? defaultAppSettings.backgroundMode,
        backgroundColor: result.background_color ?? defaultAppSettings.backgroundColor,
        backgroundImage: result.background_image ?? "",
        backgroundOriginalImage: result.background_original_image ?? result.background_image ?? ""
      });
      setAppSettingsOpen(false);
      showToast("Pengaturan aplikasi berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan pengaturan aplikasi.", "error");
    }
  }

  async function handleApplyCrop() {
    try {
      const image = await loadImage(cropperState.source);
      const canvas = document.createElement("canvas");
      canvas.width = cropperState.outputWidth;
      canvas.height = cropperState.outputHeight;
      const context = canvas.getContext("2d");
      const resultState = clampCropState(cropperState);

      if (cropperState.target === "appBackground" && cropperState.zoom <= cropperState.minZoom + 0.0001) {
        const scale = Math.min(resultState.outputWidth / image.width, resultState.outputHeight / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, resultState.outputWidth, resultState.outputHeight);
        context.drawImage(image, (resultState.outputWidth - width) / 2, (resultState.outputHeight - height) / 2, width, height);
      } else {
        const renderedWidth = image.width * cropperState.zoom;
        const renderedHeight = image.height * cropperState.zoom;
        const left = (cropperState.viewportWidth - renderedWidth) / 2 + cropperState.panX;
        const top = (cropperState.viewportHeight - renderedHeight) / 2 + cropperState.panY;
        const srcX = Math.max(0, (0 - left) / cropperState.zoom);
        const srcY = Math.max(0, (0 - top) / cropperState.zoom);
        const srcWidth = Math.min(image.width, cropperState.viewportWidth / cropperState.zoom);
        const srcHeight = Math.min(image.height, cropperState.viewportHeight / cropperState.zoom);

        context.drawImage(
          image,
          srcX,
          srcY,
          srcWidth,
          srcHeight,
          0,
          0,
          resultState.outputWidth,
          resultState.outputHeight
        );
      }

      const result = canvas.toDataURL("image/png");

      if (cropperState.target === "appLogo") {
        setAppSettings((current) => ({
          ...current,
          logoImage: result,
          logoOriginalImage: cropperState.originalSource || current.logoOriginalImage || cropperState.source
        }));
      } else if (cropperState.target === "appBackground") {
        setAppSettings((current) => ({
          ...current,
          backgroundImage: result,
          backgroundOriginalImage: cropperState.originalSource || current.backgroundOriginalImage || cropperState.source,
          backgroundMode: "image"
        }));
      } else if (cropperState.target === "profilePhoto") {
        setProfileForm((current) => ({
          ...current,
          profilePhoto: result,
          profilePhotoOriginal: cropperState.originalSource || current.profilePhotoOriginal || cropperState.source
        }));
      } else if (cropperState.target === "userFormProfilePhoto") {
        setUserForm((current) => ({
          ...current,
          profilePhoto: result,
          profilePhotoOriginal: cropperState.originalSource || current.profilePhotoOriginal || cropperState.source
        }));
      }

      setCropperOpen(false);
      showToast("Crop gambar berhasil diterapkan.");
    } catch (error) {
      showToast(error.message || "Gagal menerapkan crop gambar.", "error");
    }
  }

  async function handleSaveProfile(event) {
    event.preventDefault();

    try {
      const data = await apiFetch("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: profileForm.fullName,
          email: profileForm.email,
          password: profileForm.password,
          profilePhoto: profileForm.profilePhoto,
          profilePhotoOriginal: profileForm.profilePhotoOriginal || profileForm.profilePhoto
        })
      });

      setSession((current) =>
        current
          ? {
              ...current,
              user: {
                ...current.user,
                ...data.user
              }
            }
          : current
      );
      setProfileForm((current) => ({ ...current, password: "" }));
      setProfileModalOpen(false);
      await loadDashboard();
      showToast("Profil berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan profil.", "error");
    }
  }

  const allPages = pageGroups.flatMap((group) => group.items);
  const currentPage = allPages.find((item) => item.id === activePage) ?? allPages[0];
  const appShellStyle =
    appSettings.backgroundMode === "image" && appSettings.backgroundImage
        ? {
          backgroundImage: `linear-gradient(rgba(252, 253, 253, 0.9), rgba(252, 253, 253, 0.92)), url(${appSettings.backgroundImage})`,
          backgroundSize: "100% auto",
          backgroundPosition: "top center",
          backgroundRepeat: "no-repeat",
          backgroundAttachment: "fixed"
        }
      : {
          background: appSettings.backgroundColor
        };
  const activeYear = dashboard.years.find((item) => item.is_active) ?? null;
  const transactions = dashboard.monitoring.transactions ?? [];
  const incomes = transactions.filter((item) => item.type === "income");
  const fineTransactions = incomes.filter(
    (item) => String(item.category ?? "").toLowerCase() === "denda"
  );
  const regularIncomeTransactions = incomes.filter(
    (item) => String(item.category ?? "").toLowerCase() !== "denda"
  );
  const expenses = transactions.filter((item) => item.type === "expense");
  const reportRowsAll = createReportRows(transactions);
  const dashboardPeriodTransactions = filterTransactionsByPeriod(transactions, dashboardChartPeriod);
  const dashboardChartRows = createReportRows(dashboardPeriodTransactions);
  const totalStudents = dashboard.users.filter((item) => item.role === "siswa" || item.role === "bendahara").length;
  const totalTreasurers = dashboard.users.filter(
    (item) => item.role === "bendahara" && item.isActive
  ).length;
  const classCategories = [...new Set([
    ...dashboard.classes.map((item) => item.name).filter(Boolean),
    ...transactions.map((item) => item.class_name).filter(Boolean)
  ])].sort((a, b) => a.localeCompare(b));
  const classNames = [
    ...classCategories,
    ...(!transactions.some((item) => !(item.class_name ?? "").trim()) ? [] : ["Tanpa Kelas"])
  ];
  const yearOptions = [...new Set(dashboard.years.map((item) => item.name))];
  const reportYearOptions = [...new Set(transactions.map((item) => new Date(item.created_at).getFullYear().toString()))];
  const incomeMonthlyTotal = incomes
    .filter((item) => {
      const date = new Date(item.created_at);
      const now = new Date();
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const fineMonthlyTotal = fineTransactions
    .filter((item) => {
      const date = new Date(item.created_at);
      const now = new Date();
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  const expenseMonthlyTotal = expenses
    .filter((item) => {
      const date = new Date(item.created_at);
      const now = new Date();
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);

  const filteredUsers = dashboard.users.filter((item) => {
    const search = userSearch.trim().toLowerCase();
    const searchMatch =
      search === "" ||
      item.fullName.toLowerCase().includes(search) ||
      item.email.toLowerCase().includes(search) ||
      item.role.toLowerCase().includes(search);
    const roleMatch = userFilters.role === "semua" || item.role === userFilters.role;
    const classMatch =
      userFilters.className === "semua" || (item.className ?? "Tanpa kelas") === userFilters.className;
    return searchMatch && roleMatch && classMatch;
  });

  const filteredClasses = dashboard.classes.filter((item) => {
    return classYearFilter === "semua" || item.academic_year_name === classYearFilter;
  });
  const classAccountSummary = dashboard.users.reduce((result, user) => {
    if (!user.classId) {
      return result;
    }

    if (!result[user.classId]) {
      result[user.classId] = {
        total: 0,
        walikelas: 0,
        bendahara: 0,
        siswa: 0
      };
    }

    result[user.classId].total += 1;

    if (user.role === "walikelas") {
      result[user.classId].walikelas += 1;
    } else if (user.role === "bendahara") {
      result[user.classId].bendahara += 1;
      result[user.classId].siswa += 1;
    } else if (user.role === "siswa") {
      result[user.classId].siswa += 1;
    }

    return result;
  }, {});

  const filteredIncomeRows = incomes.filter((item) => {
    return incomeFilter === "Semua" || item.class_name === incomeFilter;
  });

  const filteredFineRows = fineTransactions.filter((item) => {
    return fineFilter === "Semua" || (item.class_name ?? "Tanpa Kelas") === fineFilter;
  });

  const filteredExpenseRows = expenses.filter((item) => {
    return expenseFilter === "Semua" || item.class_name === expenseFilter;
  });

  const filteredBalanceRows = reportRowsAll.filter((item) => {
    return balanceFilter === "Semua" || item.className === balanceFilter;
  });

  const restoreUsers = (dashboard.restore?.users ?? []).map((item) => ({ ...item, restore_kind: "users" }));
  const restoreClasses = (dashboard.restore?.classes ?? []).map((item) => ({ ...item, restore_kind: "classes" }));
  const restoreRows =
    restoreType === "users"
      ? restoreUsers
      : restoreType === "classes"
        ? restoreClasses
        : [...restoreUsers, ...restoreClasses].sort((a, b) => {
            const aTime = a.deleted_at ? new Date(a.deleted_at).getTime() : 0;
            const bTime = b.deleted_at ? new Date(b.deleted_at).getTime() : 0;
            return bTime - aTime;
          });
  const userPagination = paginateItems(filteredUsers, userPage);
  const classPagination = paginateItems(filteredClasses, classPage);
  const restorePagination = paginateItems(restoreRows, restorePage);

  const recentActivity = useMemo(() => transactions.slice(0, 5), [transactions]);
  const fineChartData = useMemo(
    () => buildFineChartRows(fineTransactions, fineChartPeriod),
    [fineTransactions, fineChartPeriod]
  );
  const fineChartRows = fineChartData.classRows;
  const fineChartPeriods = fineChartData.periodLabels;

  useEffect(() => {
    if (fineChartClassFilter === "all") {
      return;
    }

    if (!fineChartRows.some((item) => item.key === fineChartClassFilter)) {
      setFineChartClassFilter("all");
    }
  }, [fineChartClassFilter, fineChartRows]);

  const chartMax = Math.max(
    ...dashboardChartRows.map((item) => Math.max(item.regularIncome, item.fine, item.expense)),
    1
  );

  const computedReport = useMemo(() => {
    const filtered = transactions.filter((item) => {
      const date = new Date(item.created_at);
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = String(date.getFullYear());
      const className = item.class_name ?? "Tanpa Kelas";

      const classMatch =
        reportFilters.className === "semua" || className === reportFilters.className;
      const monthMatch = reportFilters.month === "semua" || month === reportFilters.month;
      const yearMatch = reportFilters.year === "semua" || year === reportFilters.year;

      return classMatch && monthMatch && yearMatch;
    });

    const income = filtered
      .filter((item) => item.type === "income" && String(item.category ?? "").toLowerCase() !== "denda")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const fine = filtered
      .filter((item) => item.type === "income" && String(item.category ?? "").toLowerCase() === "denda")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const expense = filtered
      .filter((item) => item.type === "expense")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const rows = createReportRows(filtered);
    const classUserCount =
      reportFilters.className === "semua"
        ? dashboard.users.filter((item) => item.role === "siswa" || item.role === "bendahara").length
        : dashboard.users.filter(
            (item) =>
              (item.role === "siswa" || item.role === "bendahara") &&
              item.className === reportFilters.className
          ).length;
    const paidUsers = new Set(
      filtered
        .filter((item) => item.type === "income" && item.student_name)
        .map((item) => item.student_name)
    ).size;

    return {
      income,
      fine,
      expense,
      balance: income + fine - expense,
      studentSummary: `${paidUsers}/${classUserCount}`,
      rows
    };
  }, [reportFilters, transactions, dashboard.users]);

  const generatedReport = reportGenerated ? computedReport : null;

  const reportPeriodLabel =
    reportFilters.month === "semua"
      ? `Semua Bulan${reportFilters.year === "semua" ? "" : ` ${reportFilters.year}`}`
      : `${months.find((item) => item.value === reportFilters.month)?.label ?? "-"} ${
          reportFilters.year === "semua" ? "" : reportFilters.year
        }`.trim();

  useEffect(() => {
    if (reportFilterAutoInitRef.current || transactions.length === 0) {
      return;
    }

    const latestPeriod = getLatestTransactionPeriod(transactions);
    setReportFilters((current) => ({
      ...current,
      month: latestPeriod.month,
      year: latestPeriod.year
    }));
    reportFilterAutoInitRef.current = true;
  }, [transactions]);

  function handlePrintSuperadminReport() {
    const reportData = computedReport;

    const tableRows = reportData.rows.length
      ? reportData.rows
          .map(
            (item) => `
              <tr>
                <td>${item.className}</td>
                <td class="plus">+${formatCurrency(item.regularIncome)}</td>
                <td class="warn">+${formatCurrency(item.fine)}</td>
                <td class="minus">-${formatCurrency(item.expense)}</td>
                <td><b>${formatCurrency(item.balance)}</b></td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="5">Tidak ada data sesuai filter laporan.</td></tr>`;

    const printMarkup = `
      <html>
        <head>
          <title>Laporan Kas Super Admin</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 28px; color: #1f2937; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #e5e7eb; padding: 10px 12px; text-align: left; font-size: 14px; }
            th { background: #f9fafb; text-transform: uppercase; font-size: 12px; letter-spacing: .06em; color: #6b7280; }
            .plus { color: #059669; font-weight: 700; }
            .warn { color: #d97706; font-weight: 700; }
            .minus { color: #dc2626; font-weight: 700; }
          </style>
        </head>
        <body>
          <table>
            <thead>
              <tr>
                <th>Kelas</th>
                <th>Kas</th>
                <th>Denda</th>
                <th>Keluar</th>
                <th>Saldo</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </body>
      </html>
    `;

    const printFrame = document.createElement("iframe");
    printFrame.setAttribute("aria-hidden", "true");
    printFrame.style.position = "fixed";
    printFrame.style.right = "0";
    printFrame.style.bottom = "0";
    printFrame.style.width = "0";
    printFrame.style.height = "0";
    printFrame.style.border = "0";
    printFrame.style.opacity = "0";
    printFrame.style.pointerEvents = "none";

    const cleanupPrintFrame = () => {
      window.removeEventListener("afterprint", cleanupPrintFrame);
      if (printFrame.parentNode) {
        printFrame.parentNode.removeChild(printFrame);
      }
    };

    window.addEventListener("afterprint", cleanupPrintFrame, { once: true });
    document.body.appendChild(printFrame);

    const frameDocument = printFrame.contentWindow?.document;

    if (!frameDocument || !printFrame.contentWindow) {
      cleanupPrintFrame();
      showToast("Gagal menyiapkan halaman cetak.", "error");
      return;
    }

    frameDocument.open();
    frameDocument.write(printMarkup);
    frameDocument.close();

    const triggerPrint = () => {
      try {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
      } catch {
        cleanupPrintFrame();
        showToast("Gagal membuka dialog cetak.", "error");
        return;
      }

      window.setTimeout(cleanupPrintFrame, 1000);
    };

    if (printFrame.contentWindow.document.readyState === "complete") {
      window.setTimeout(triggerPrint, 150);
    } else {
      printFrame.onload = () => window.setTimeout(triggerPrint, 150);
    }
  }

  function handleExportSuperadminExcel() {
    const reportData = computedReport;

    const detailRows = reportData.rows.map((item) => ({
      Kelas: item.className,
      Kas: item.regularIncome,
      Denda: item.fine,
      Keluar: item.expense,
      Saldo: item.balance
    }));

    const workbook = XLSX.utils.book_new();
    const detailSheet = XLSX.utils.json_to_sheet(detailRows.length ? detailRows : [{ Kelas: "-", Kas: 0, Denda: 0, Keluar: 0, Saldo: 0 }]);
    XLSX.utils.book_append_sheet(workbook, detailSheet, "Tabel");
    XLSX.writeFile(
      workbook,
      `laporan-superadmin-${slugifyFilePart(reportFilters.className === "semua" ? "semua-kelas" : reportFilters.className)}-${slugifyFilePart(reportFilters.year)}-${slugifyFilePart(reportFilters.month)}.xlsx`
    );
    showToast("Laporan Excel berhasil diunduh.");
  }

  function handleExportSuperadminPdf() {
    const reportData = computedReport;

    const document = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4"
    });

    autoTable(document, {
      startY: 40,
      theme: "grid",
      head: [["Kelas", "Kas", "Denda", "Keluar", "Saldo"]],
      body: reportData.rows.length
        ? reportData.rows.map((item) => [
            item.className,
            formatCurrency(item.regularIncome),
            formatCurrency(item.fine),
            formatCurrency(item.expense),
            formatCurrency(item.balance)
          ])
        : [["-", formatCurrency(0), formatCurrency(0), formatCurrency(0), formatCurrency(0)]],
      styles: { fontSize: 10, cellPadding: 8 },
      headStyles: { fillColor: [59, 130, 246] }
    });

    document.save(
      `laporan-superadmin-${slugifyFilePart(reportFilters.className === "semua" ? "semua-kelas" : reportFilters.className)}-${slugifyFilePart(reportFilters.year)}-${slugifyFilePart(reportFilters.month)}.pdf`
    );
    showToast("Laporan PDF berhasil diunduh.");
  }

  useEffect(() => {
    setUserPage(1);
  }, [userSearch, userFilters]);

  useEffect(() => {
    setClassPage(1);
  }, [classYearFilter, dashboard.classes.length]);

  useEffect(() => {
    setRestorePage(1);
  }, [restoreType, restoreUsers.length, restoreClasses.length]);

  if (!session) {
    return (
      <main className="login-shell">
        <div className="login-bg-mesh" aria-hidden="true" />
        <div className="login-sparkle-layer" aria-hidden="true">
          {loginSparkles.map((item, index) => (
            <span
              key={`login-sparkle-${index}`}
              className="login-sparkle"
              style={{
                left: item.left,
                top: item.top,
                "--sparkle-size": `${item.size}px`,
                "--sparkle-delay": item.delay,
                "--sparkle-duration": item.duration,
                "--sparkle-color": item.color
              }}
            />
          ))}
        </div>
        <div className="login-bokeh-layer" aria-hidden="true">
          {loginBokeh.map((item, index) => (
            <span
              key={`login-bokeh-${index}`}
              className="login-bokeh"
              style={{
                left: item.left,
                top: item.top,
                width: `${item.size}px`,
                height: `${item.size}px`,
                background: `radial-gradient(circle, ${item.color} 0%, rgba(255,255,255,0) 72%)`,
                "--bokeh-duration": item.duration,
                "--bokeh-delay": item.delay
              }}
            />
          ))}
        </div>
        <div className="login-ring-layer" aria-hidden="true">
          {loginRings.map((item, index) => (
            <span
              key={`login-ring-${index}`}
              className="login-float-ring"
              style={{
                left: item.left,
                top: item.top,
                width: `${item.size}px`,
                height: `${item.size}px`,
                borderColor: item.color,
                "--ring-duration": item.duration,
                "--ring-delay": item.delay
              }}
            />
          ))}
        </div>

        <section className="login-card login-card-fancy" role="dialog" aria-label="Form Login KasKu">
          <div className="login-card-badge">
            <i className="fas fa-coins" />
            {appSettings.appName || "KasKu"}
          </div>

          <div className="login-avatar-section">
            <div className="login-avatar-ring">
              <div className="login-avatar-inner">
                {appSettings.logoImage ? (
                  <img className="logo-image" src={appSettings.logoImage} alt={appSettings.appName} />
                ) : (
                  <div className="login-wallet-icon">
                    <i className="fas fa-wallet" />
                  </div>
                )}
              </div>
            </div>
            <h1 className="login-avatar-title">Halo, Selamat Datang</h1>
            <p className="login-avatar-sub">Masuk untuk mengelola kas kamu</p>
          </div>

          <form className="login-form login-form-fancy" onSubmit={handleLogin}>
            <div className="form-group login-form-group">
              <label className="form-label login-form-label">Email atau Username</label>
              <div className="login-input-wrap">
                <input
                  className={`form-input login-form-input ${loginState.error ? "login-input-error" : ""}`}
                  value={loginForm.email}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, email: event.target.value }))
                  }
                  placeholder="contoh@email.com"
                  autoComplete="username"
                />
              </div>
            </div>

            <div className="form-group login-form-group">
              <label className="form-label login-form-label">Kata Sandi</label>
              <div className="login-input-wrap">
                <input
                  className={`form-input login-form-input ${loginState.error ? "login-input-error" : ""}`}
                  type={loginUi.showPassword ? "text" : "password"}
                  value={loginForm.password}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, password: event.target.value }))
                  }
                  placeholder="Masukkan kata sandi"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="login-toggle-pw"
                  aria-label={loginUi.showPassword ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
                  onClick={() =>
                    setLoginUi((current) => ({ ...current, showPassword: !current.showPassword }))
                  }
                >
                  <i className={`fas ${loginUi.showPassword ? "fa-eye-slash" : "fa-eye"}`} />
                </button>
              </div>
            </div>

            <div className="login-form-extras">
              <label className="login-check-wrap">
                <input
                  type="checkbox"
                  checked={loginUi.remember}
                  onChange={(event) =>
                    setLoginUi((current) => ({ ...current, remember: event.target.checked }))
                  }
                />
                <span className="login-check-box">
                  <i className="fas fa-check" />
                </span>
                <span className="login-check-label">Ingat saya</span>
              </label>
              <button
                type="button"
                className="login-link-btn"
                onClick={() => showToast("Fitur reset kata sandi akan segera hadir.", "info")}
              >
                Lupa kata sandi?
              </button>
            </div>

            {loginState.error ? <p className="login-error-text">{loginState.error}</p> : null}

            <button
              className={`login-btn ${loginState.loading && loginState.mode === "password" ? "loading" : ""}`}
              type="submit"
              disabled={loginState.loading}
            >
              <span className="login-btn-text">
                {loginState.loading && loginState.mode === "password" ? "Sedang masuk..." : "Masuk Sekarang"}
              </span>
              <i className="fas fa-arrow-right login-btn-arrow" />
              <span className="login-btn-spinner" />
            </button>
          </form>

          <div className="login-divider">
            <span className="login-divider-line" />
            <span>atau masuk dengan</span>
            <span className="login-divider-line" />
          </div>

          <div className="login-social-btns">
            {googleClientId ? (
              <div className="google-signin-shell single">
                <button
                  type="button"
                  className={`login-social-btn google single ${loginState.loading && loginState.mode === "google" ? "is-loading" : ""}`}
                  disabled={loginState.loading}
                >
                  <i className="fab fa-google" />
                  <span>
                    {loginState.loading && loginState.mode === "google" ? "Memproses..." : "Google"}
                  </span>
                </button>
                <div ref={googleSigninRef} className="google-signin-render google-signin-overlay" />
              </div>
            ) : (
              <button type="button" className="login-social-btn google single" disabled>
                <i className="fab fa-google" />
                <span>Google belum aktif</span>
              </button>
            )}
          </div>
        </section>
      </main>
    );
  }

  if (session.auth?.role === "bendahara") {
    return (
      <TreasurerPanel
        session={session}
        setSession={setSession}
        handleLogout={handleLogout}
        activePage={activePage}
        setActivePage={setActivePage}
        appSettings={appSettings}
      />
    );
  }

  if (session.auth?.role === "walikelas") {
    return (
      <TreasurerPanel
        session={session}
        setSession={setSession}
        handleLogout={handleLogout}
        activePage={activePage}
        setActivePage={setActivePage}
        appSettings={appSettings}
      />
    );
  }

  if (session.auth?.role === "siswa") {
    return (
      <StudentPanel
        session={session}
        setSession={setSession}
        handleLogout={handleLogout}
        activePage={activePage}
        setActivePage={setActivePage}
        appSettings={appSettings}
      />
    );
  }

  return (
    <div className="app-shell" style={appShellStyle}>
      <div
        className={`sidebar-overlay ${sidebarOpen ? "show" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={`sidebar ${sidebarOpen ? "open" : ""}`}
        style={{ background: appSettings.sidebarColor }}
      >
        <div className="sidebar-header">
          <div className="sidebar-logo">
            {appSettings.logoImage ? (
              <img className="logo-image" src={appSettings.logoImage} alt={appSettings.appName} />
            ) : (
              <div className="logo-icon">
                <i className="fas fa-wallet" />
              </div>
            )}
            <div className="logo-text">{appSettings.appName}</div>
          </div>
          <div className="sidebar-role">
            <i className="fas fa-crown" /> Super Admin
          </div>
        </div>

        <nav className="sidebar-nav">
          {pageGroups.map((group) => (
            <div key={group.label}>
              <div className="nav-section-label">{group.label}</div>
              {group.items.map((page) => (
                <button
                  key={page.id}
                  className={`nav-item ${activePage === page.id ? "active" : ""}`}
                  onClick={() => {
                    setActivePage(page.id);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="nav-icon">
                    <i className={`fas ${page.icon}`} />
                  </span>
                  {page.title}
                  {page.id === "users" && (
                    <span className="badge badge-blue">{dashboard.users.length}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user" onClick={() => setProfileModalOpen(true)}>
            <div className="user-avatar-sidebar">{renderUserAvatar(session.user)}</div>
            <div className="user-info">
              <div className="user-name">{session.user.fullName}</div>
              <div className="user-role-text">{session.user.email}</div>
            </div>
          </div>
          <button
            className="btn btn-secondary sidebar-logout"
            onClick={handleLogout}
          >
            <i className="fas fa-right-from-bracket" /> Keluar
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="menu-toggle" onClick={() => setSidebarOpen((value) => !value)}>
              <i className="fas fa-bars" />
            </button>
            <div>
              <div className="page-title">{currentPage.title}</div>
              <div className="page-subtitle">{currentPage.subtitle}</div>
            </div>
          </div>
          <div className="topbar-right">
            <button
              className="topbar-btn"
              title="Pengaturan Aplikasi"
              onClick={() => setAppSettingsOpen(true)}
            >
              <i className="fas fa-gear" />
            </button>
          </div>
        </header>

        <div className="page-content">
          {dashboard.error && (
            <div className="panel">
              <div className="panel-body error-text">{dashboard.error}</div>
            </div>
          )}

          <section className={`page-section ${activePage === "dashboard" ? "active" : ""}`}>
            <div className="stats-grid mobile-dashboard-stats">
              <StatCard color="blue" icon="fa-school" value={dashboard.overview?.total_classes ?? 0} label="Total Kelas Aktif" />
              <StatCard color="green" icon="fa-user-group" value={totalStudents} label="Total Siswa Terdaftar" />
              <StatCard color="orange" icon="fa-piggy-bank" value={formatCurrency(dashboard.overview?.total_cash ?? 0)} label="Total Saldo Semua Kelas" />
              <StatCard
                color="purple"
                icon="fa-user-shield"
                value={formatCurrency(dashboard.overview?.total_fine ?? 0)}
                label="Pemasukan Denda"
              />
            </div>

            <div className="grid-2 treasurer-dashboard-grid dashboard-distribution-row">
              <CashDistributionChart rows={buildFinanceChartRows(transactions, dashboardChartPeriod)} />

              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">Aktivitas Terbaru</div>
                </div>
                <div className="panel-body compact-list">
                  {recentActivity.length === 0 ? (
                    <div className="empty-state">
                      <i className="fas fa-clock-rotate-left" />
                      <p>Belum ada aktivitas terbaru.</p>
                    </div>
                  ) : (
                    recentActivity.map((item) => (
                      <div className="transaction-item" key={item.id}>
                        <div className={`transaction-icon ${item.type === "income" ? "income" : "expense"}`}>
                          <i className={`fas ${item.type === "income" ? "fa-arrow-trend-down" : "fa-arrow-trend-up"}`} />
                        </div>
                        <div className="transaction-info">
                          <div className="transaction-desc">{item.title}</div>
                          <div className="transaction-meta">
                            {item.class_name ?? "Tanpa kelas"} • {item.note ?? "-"}
                          </div>
                        </div>
                        <div className={`transaction-amount ${item.type === "income" ? "positive" : "negative"}`}>
                          {item.type === "income" ? "+" : "-"}
                          {formatCurrency(item.amount)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
            <FinanceChart
              title="Diagram Keuangan Semua Kelas"
              rows={buildFinanceChartRows(transactions, dashboardChartPeriod)}
              period={dashboardChartPeriod}
              onPeriodChange={setDashboardChartPeriod}
              showDistribution={false}
            />
          </section>

          <section className={`page-section ${activePage === "users" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header users-panel-header">
                <div className="panel-title">Kelola User</div>
                <div className="panel-actions users-toolbar">
                  <div className="search-bar">
                    <i className="fas fa-search" />
                    <input
                      className="form-input users-search-input"
                      placeholder="Cari nama, email, atau role..."
                      value={userSearch}
                      onChange={(event) => setUserSearch(event.target.value)}
                    />
                  </div>
                  <select
                    className="form-select filter-select"
                    value={userFilters.className}
                    onChange={(event) =>
                      setUserFilters((current) => ({ ...current, className: event.target.value }))
                    }
                  >
                    <option value="semua">Semua kelas</option>
                    <option value="Tanpa kelas">Tanpa kelas</option>
                    {classNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-primary users-add-btn" onClick={handleOpenAddUser}>
                    <i className="fas fa-plus" /> Tambah akun
                  </button>
                </div>
              </div>
              <div className="panel-filter-row">
                <div className="filter-chips role-tabs">
                  {[
                    ["semua", "Semua"],
                    ["bendahara", "Bendahara"],
                    ["walikelas", "Wali Kelas"],
                    ["siswa", "Siswa"],
                    ["superadmin", "Superadmin"]
                  ].map(([role, label]) => (
                    <button
                      key={role}
                      className={`chip ${userFilters.role === role ? "active" : ""}`}
                      onClick={() =>
                        setUserFilters((current) => ({
                          ...current,
                          role
                        }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper mobile-student-table">
                  <table>
                    <thead>
                      <tr>
                        <th>No</th>
                        <th>Nama</th>
                        <th>Role</th>
                        <th>Kelas</th>
                        <th>Status</th>
                        <th>Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.length === 0 ? (
                        <tr>
                          <td colSpan="6">
                            <div className="empty-row">Belum ada user di filter ini.</div>
                          </td>
                        </tr>
                      ) : (
                        userPagination.rows.map((user, index) => (
                          <tr key={user.id}>
                            <td>{(userPagination.page - 1) * 10 + index + 1}</td>
                            <td>
                              <div className="student-cell">
                                <div className="student-avatar" style={avatarGradient(index)}>
                                  {renderUserAvatar(user)}
                                </div>
                                <div>
                                  <div className="student-name">{user.fullName}</div>
                                  <div className="transaction-meta">{user.email}</div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span className="kelas-tag role-tag">{user.role}</span>
                            </td>
                            <td>{user.className ?? "-"}</td>
                            <td>
                              <span className={`status ${user.isActive ? "status-active" : "status-inactive"}`}>
                                <span className="status-dot" />
                                {user.isActive ? "Aktif" : "Nonaktif"}
                              </span>
                            </td>
                            <td>
                              <div className="btn-group compact-actions">
                                <button
                                  className="btn btn-secondary btn-sm btn-icon"
                                  title="Edit akun"
                                  onClick={() => handleOpenEditUser(user)}
                                >
                                  <i className="fas fa-pen" />
                                </button>
                                {user.role !== "superadmin" && (
                                  <button
                                    className="btn btn-danger btn-sm btn-icon"
                                    title="Hapus akun"
                                    onClick={() => handleDeleteUser(user)}
                                  >
                                    <i className="fas fa-trash" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <PaginationControls
                  page={userPagination.page}
                  totalPages={userPagination.totalPages}
                  onChange={setUserPage}
                />
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "classes" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header classes-panel-header">
                <div className="panel-title">Kategori Kelas</div>
                <div className="panel-actions classes-toolbar">
                  <select
                    className="form-select filter-select"
                    value={classYearFilter}
                    onChange={(event) => setClassYearFilter(event.target.value)}
                  >
                    <option value="semua">Semua tahun ajaran</option>
                    {yearOptions.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-primary compact-add-btn" onClick={handleOpenAddClass}>
                    <i className="fas fa-plus" /> Tambah
                  </button>
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Kelas</th>
                        <th>Nominal Kas</th>
                        <th>Tahun ajaran</th>
                        <th>Total Akun</th>
                        <th>Wali Kelas</th>
                        <th>Jumlah Bendahara</th>
                        <th>Jumlah Siswa</th>
                        <th>Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredClasses.length === 0 ? (
                        <tr>
                          <td colSpan="8">
                            <div className="empty-row">Belum ada kategori kelas. Tambahkan dari tombol di atas.</div>
                          </td>
                        </tr>
                      ) : (
                        classPagination.rows.map((item) => (
                          <tr key={item.id}>
                            <td>{item.name}</td>
                            <td>{formatCurrency(item.nominal_kas ?? 0)}</td>
                            <td>{item.academic_year_name ?? "-"}</td>
                            <td>{classAccountSummary[item.id]?.total ?? 0}</td>
                            <td>{classAccountSummary[item.id]?.walikelas ?? 0}</td>
                            <td>{classAccountSummary[item.id]?.bendahara ?? 0}</td>
                            <td>{classAccountSummary[item.id]?.siswa ?? 0}</td>
                            <td>
                              <div className="btn-group compact-actions">
                                <button
                                  className="btn btn-secondary btn-sm btn-icon"
                                  title="Edit kelas"
                                  onClick={() => handleOpenEditClass(item)}
                                >
                                  <i className="fas fa-pen" />
                                </button>
                                <button className="btn btn-danger btn-sm" onClick={() => handleDeleteClass(item.id)}>
                                  <i className="fas fa-trash-can" /> Hapus
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <PaginationControls
                  page={classPagination.page}
                  totalPages={classPagination.totalPages}
                  onChange={setClassPage}
                />
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "restore" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Restore Data</div>
                <div className="panel-actions filter-chips">
                  <button
                    className={`chip ${restoreType === "all" ? "active" : ""}`}
                    onClick={() => setRestoreType("all")}
                  >
                    Semua
                  </button>
                  <button
                    className={`chip ${restoreType === "users" ? "active" : ""}`}
                    onClick={() => setRestoreType("users")}
                  >
                    User
                  </button>
                  <button
                    className={`chip ${restoreType === "classes" ? "active" : ""}`}
                    onClick={() => setRestoreType("classes")}
                  >
                    Kelas
                  </button>
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      {restoreType === "all" ? (
                        <tr>
                          <th>Tipe</th>
                          <th>Nama</th>
                          <th>Detail</th>
                          <th>Dihapus Oleh</th>
                          <th>IP</th>
                          <th>Hari</th>
                          <th>Waktu</th>
                          <th>Aksi</th>
                        </tr>
                      ) : restoreType === "users" ? (
                        <tr>
                          <th>Nama</th>
                          <th>Email</th>
                          <th>Role</th>
                          <th>Dihapus Oleh</th>
                          <th>IP</th>
                          <th>Hari</th>
                          <th>Waktu</th>
                          <th>Aksi</th>
                        </tr>
                      ) : (
                        <tr>
                          <th>Nama Kelas</th>
                          <th>Nominal Kas</th>
                          <th>Dihapus Oleh</th>
                          <th>IP</th>
                          <th>Hari</th>
                          <th>Waktu</th>
                          <th>Aksi</th>
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {restoreRows.length === 0 ? (
                        <tr>
                          <td colSpan={restoreType === "all" ? 8 : restoreType === "users" ? 8 : 7}>
                            <div className="empty-row">
                              {restoreType === "all"
                                ? "Belum ada data yang dihapus."
                                : restoreType === "users"
                                ? "Belum ada user yang dihapus."
                                : "Belum ada kelas yang dihapus."}
                            </div>
                          </td>
                        </tr>
                      ) : restoreType === "all" ? (
                        restorePagination.rows.map((item) => (
                          <tr key={`${item.restore_kind}-${item.id}`}>
                            <td>{item.restore_kind === "users" ? "User" : "Kelas"}</td>
                            <td>{item.name}</td>
                            <td>
                              {item.restore_kind === "users"
                                ? `${item.email} • ${item.role}`
                                : formatCurrency(item.nominal_kas ?? 0)}
                            </td>
                            <td>{item.deleted_by_name ?? "-"}</td>
                            <td>{item.deleted_by_ip ?? "-"}</td>
                            <td>{item.deleted_day?.trim?.() || "-"}</td>
                            <td>{formatDateLabel(item.deleted_at)}</td>
                            <td>
                              <div className="btn-group compact-actions">
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => handleRestoreItem(item.restore_kind, item.id)}
                                >
                                  <i className="fas fa-rotate-left" /> Restore
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={() =>
                                    handlePermanentDeleteRestoreItem(item.restore_kind, item.id, item.name)
                                  }
                                >
                                  <i className="fas fa-trash" /> Hapus
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      ) : restoreType === "users" ? (
                        restorePagination.rows.map((item) => (
                          <tr key={`restore-user-${item.id}`}>
                            <td>{item.name}</td>
                            <td>{item.email}</td>
                            <td>{item.role}</td>
                            <td>{item.deleted_by_name ?? "-"}</td>
                            <td>{item.deleted_by_ip ?? "-"}</td>
                            <td>{item.deleted_day?.trim?.() || "-"}</td>
                            <td>{formatDateLabel(item.deleted_at)}</td>
                            <td>
                              <div className="btn-group compact-actions">
                                <button className="btn btn-primary btn-sm" onClick={() => handleRestoreItem("users", item.id)}>
                                  <i className="fas fa-rotate-left" /> Restore
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={() => handlePermanentDeleteRestoreItem("users", item.id, item.name)}
                                >
                                  <i className="fas fa-trash" /> Hapus
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      ) : (
                        restorePagination.rows.map((item) => (
                          <tr key={`restore-class-${item.id}`}>
                            <td>{item.name}</td>
                            <td>{formatCurrency(item.nominal_kas ?? 0)}</td>
                            <td>{item.deleted_by_name ?? "-"}</td>
                            <td>{item.deleted_by_ip ?? "-"}</td>
                            <td>{item.deleted_day?.trim?.() || "-"}</td>
                            <td>{formatDateLabel(item.deleted_at)}</td>
                            <td>
                              <div className="btn-group compact-actions">
                                <button className="btn btn-primary btn-sm" onClick={() => handleRestoreItem("classes", item.id)}>
                                  <i className="fas fa-rotate-left" /> Restore
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={() => handlePermanentDeleteRestoreItem("classes", item.id, item.name)}
                                >
                                  <i className="fas fa-trash" /> Hapus
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <PaginationControls
                  page={restorePagination.page}
                  totalPages={restorePagination.totalPages}
                  onChange={setRestorePage}
                />
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "system-backup" ? "active" : ""}`}>
            <div className="grid-2">
              <div className="setting-card">
                <div className="setting-card-header">
                  <div className="setting-card-icon blue-box">
                    <i className="fas fa-download" />
                  </div>
                  <div>
                    <div className="setting-card-title">Backup Sistem</div>
                    <div className="setting-card-desc">Unduh seluruh data database ke file JSON</div>
                  </div>
                </div>
                <div className="summary-stack">
                  <div className="summary-row">
                    <span>Total user</span>
                    <strong>{dashboard.users.length}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Total kelas</span>
                    <strong>{dashboard.classes.length}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Data restore</span>
                    <strong>{(dashboard.restore?.users?.length ?? 0) + (dashboard.restore?.classes?.length ?? 0)}</strong>
                  </div>
                  <div className="summary-row">
                    <span>Mode restore</span>
                    <strong>Update / Merge</strong>
                  </div>
                </div>
                <div style={{ marginTop: 18 }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleDownloadSystemBackup}
                    disabled={backupBusy.download}
                  >
                    <i className="fas fa-download" /> {backupBusy.download ? "Menyiapkan backup..." : "Download Backup JSON"}
                  </button>
                </div>
              </div>

              <div className="setting-card">
                <div className="setting-card-header">
                  <div className="setting-card-icon purple-box">
                    <i className="fas fa-database" />
                  </div>
                  <div>
                    <div className="setting-card-title">Restore Database</div>
                    <div className="setting-card-desc">Import backup ke database aktif tanpa replace total</div>
                  </div>
                </div>
                <div className="summary-stack">
                  <div className="summary-row">
                    <span>Metode</span>
                    <strong>Merge berdasarkan data unik</strong>
                  </div>
                  <div className="summary-row">
                    <span>Perilaku</span>
                    <strong>Data lama tetap ada, data sama akan diupdate</strong>
                  </div>
                  <div className="summary-row">
                    <span>File dipilih</span>
                    <strong>{backupImportFile?.name ?? "Belum ada file"}</strong>
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: 18 }}>
                  <label className="form-label">Pilih file backup (.json)</label>
                  <label className="upload-trigger">
                    <i className="fas fa-file-arrow-up" />
                    <span>{backupImportFile ? "Ganti file backup" : "Pilih file backup JSON"}</span>
                    <input
                      ref={backupFileInputRef}
                      type="file"
                      accept="application/json,.json"
                      onChange={(event) => setBackupImportFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  <div className="upload-preview-card wide" style={{ marginTop: 12 }}>
                    <div className="summary-row">
                      <span>Nama file</span>
                      <strong>{backupImportFile?.name ?? "Belum ada file dipilih"}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Ukuran</span>
                      <strong>
                        {backupImportFile
                          ? `${(backupImportFile.size / 1024).toFixed(1)} KB`
                          : "-"}
                      </strong>
                    </div>
                  </div>
                </div>
                <div className="backup-action-row">
                  <button
                    className="btn btn-primary"
                    onClick={handleRestoreMergeSystem}
                    disabled={backupBusy.restore}
                  >
                    <i className="fas fa-upload" /> {backupBusy.restore ? "Memproses restore..." : "Restore Merge"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setBackupImportFile(null);
                      if (backupFileInputRef.current) {
                        backupFileInputRef.current.value = "";
                      }
                    }}
                    disabled={backupBusy.restore}
                  >
                    <i className="fas fa-xmark" /> Reset File
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "settings" ? "active" : ""}`}>
            <div className="grid-2">
              <div>
                <div className="setting-card settings-top-card">
                  <div className="setting-card-header">
                    <div className="setting-card-icon green-box">
                      <i className="fas fa-coins" />
                    </div>
                    <div>
                      <div className="setting-card-title">Nominal Kas per Kelas</div>
                      <div className="setting-card-desc">Nominal kas diatur dari menu Kelola Kelas</div>
                    </div>
                  </div>
                  <div className="summary-stack">
                    <div className="summary-row">
                      <span>Total kelas aktif</span>
                      <strong>{dashboard.classes.length}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Nominal terendah</span>
                      <strong>
                        {dashboard.classes.length
                          ? formatCurrency(
                              Math.min(...dashboard.classes.map((item) => Number(item.nominal_kas ?? 0)))
                            )
                          : formatCurrency(0)}
                      </strong>
                    </div>
                    <div className="summary-row">
                      <span>Nominal tertinggi</span>
                      <strong>
                        {dashboard.classes.length
                          ? formatCurrency(
                              Math.max(...dashboard.classes.map((item) => Number(item.nominal_kas ?? 0)))
                            )
                          : formatCurrency(0)}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="setting-card settings-bottom-card">
                  <div className="setting-card-header">
                    <div className="setting-card-icon orange-box">
                      <i className="fas fa-calendar-days" />
                    </div>
                    <div>
                      <div className="setting-card-title">Jadwal Notifikasi</div>
                      <div className="setting-card-desc">Atur hari dan jam email pengingat</div>
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Hari notifikasi</label>
                    <select
                      className="form-select"
                      value={cashForm.notificationDay}
                      onChange={(event) => {
                        cashFormDirtyRef.current = true;
                        setCashForm((current) => ({
                          ...current,
                          notificationDay: event.target.value
                        }));
                      }}
                    >
                      {notificationDays.map((day) => (
                        <option key={`notification-day-${day}`} value={day}>{day}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Jam notifikasi</label>
                    <select
                      className="form-select"
                      value={cashForm.notificationHour}
                      onChange={(event) => {
                        cashFormDirtyRef.current = true;
                        setCashForm((current) => ({
                          ...current,
                          notificationHour: Number(event.target.value)
                        }));
                      }}
                    >
                      {notificationHours.map((hour) => (
                        <option key={`notification-hour-${hour}`} value={hour}>
                          {String(hour).padStart(2, "0")}.00 WIB
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="btn btn-primary notification-save-btn" onClick={handleSavePeriod}>
                    <i className="fas fa-check" /> Simpan Jadwal
                  </button>
                </div>
              </div>

              <div>
                <div className="setting-card settings-top-card">
                  <div className="setting-card-header">
                    <div className="setting-card-icon blue-box">
                      <i className="fas fa-gear" />
                    </div>
                    <div>
                      <div className="setting-card-title">Pengaturan Sistem</div>
                      <div className="setting-card-desc">Konfigurasi tambahan</div>
                    </div>
                  </div>
                  {[
                    [
                      "notif",
                      "Notifikasi Belum Bayar",
                      dashboard.settings?.email_reminders_ready
                        ? `Email setiap ${cashForm.notificationDay}, pukul ${String(cashForm.notificationHour).padStart(2, "0")}.00 WIB`
                        : "Email belum aktif - konfigurasi pengirim diperlukan"
                    ]
                  ].map(([key, title, desc]) => (
                    <div className="toggle-row" key={key}>
                      <div>
                        <div className="toggle-label-text">{title}</div>
                        <div className="toggle-label-sub">{desc}</div>
                      </div>
                      <button
                        type="button"
                        className={`toggle-switch ${settingToggles[key] ? "active" : ""}`}
                        onClick={() => {
                          const nextToggles = {
                            ...settingToggles,
                            [key]: !settingToggles[key]
                          };
                          setSettingToggles(nextToggles);
                          saveCashSettings("Pengaturan sistem berhasil disimpan.", nextToggles);
                        }}
                      />
                    </div>
                  ))}
                </div>

                <div className="setting-card settings-bottom-card">
                  <div className="setting-card-header">
                    <div className="setting-card-icon purple-box">
                      <i className="fas fa-eye" />
                    </div>
                    <div>
                      <div className="setting-card-title">Pengaturan Aktif</div>
                      <div className="setting-card-desc">Ringkasan konfigurasi</div>
                    </div>
                  </div>
                  <div className="summary-stack">
                    <div className="summary-row">
                      <span>Model nominal</span>
                      <strong>Per kelas</strong>
                    </div>
                    <div className="summary-row">
                      <span>Jadwal notifikasi</span>
                      <strong>{cashForm.notificationDay}, {String(cashForm.notificationHour).padStart(2, "0")}.00 WIB</strong>
                    </div>
                    <div className="summary-row">
                      <span>Tahun ajaran aktif</span>
                      <strong>{activeYear?.name ?? "-"}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Database</span>
                      <strong>{health.data?.database ?? "-"}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "income" ? "active" : ""}`}>
            <div className="stats-grid three">
              <StatCard color="green" icon="fa-arrow-trend-down" value={formatCurrency(regularIncomeTransactions.reduce((sum, item) => sum + Number(item.amount ?? 0), 0))} label="Total Pemasukan Kas" />
              <StatCard color="yellow" icon="fa-file-invoice-dollar" value={formatCurrency(fineTransactions.reduce((sum, item) => sum + Number(item.amount ?? 0), 0))} label="Total Pemasukan Denda" />
              <StatCard color="teal" icon="fa-calendar-check" value={formatCurrency(incomeMonthlyTotal + fineMonthlyTotal)} label="Masuk Bulan Ini" />
            </div>
            <ClassCategoryStrip
              title="Kategori Kelas"
              description="Daftar kelas yang terdaftar untuk pemasukan kas."
              classes={classCategories}
            />
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Daftar Pemasukan</div>
                <div className="panel-actions">
                  <select
                    className="form-select class-filter-select"
                    value={incomeFilter}
                    onChange={(event) => setIncomeFilter(event.target.value)}
                  >
                    {["Semua", ...classNames].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Tanggal</th>
                        <th>Kelas</th>
                        <th>Keterangan</th>
                        <th>Jumlah</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredIncomeRows.length === 0 ? (
                        <tr>
                          <td colSpan="4">
                            <div className="empty-row">Belum ada data pemasukan.</div>
                          </td>
                        </tr>
                      ) : (
                        filteredIncomeRows.map((item) => (
                          <tr key={item.id}>
                            <td>{formatDateLabel(item.created_at)}</td>
                            <td>{item.class_name ?? "-"}</td>
                            <td>{item.title}</td>
                            <td className="money-positive">+{formatCurrency(item.amount)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "fines" ? "active" : ""}`}>
            <div className="stats-grid three">
              <StatCard
                color="yellow"
                icon="fa-file-circle-exclamation"
                value={formatCurrency(filteredFineRows.reduce((sum, item) => sum + Number(item.amount ?? 0), 0))}
                label="Total Denda"
              />
              <StatCard
                color="orange"
                icon="fa-user-clock"
                value={filteredFineRows.length}
                label="Transaksi Denda"
              />
              <StatCard
                color="teal"
                icon="fa-circle-info"
                value={filteredFineRows.filter((item) => String(item.note ?? "").trim()).length}
                label="Denda Dengan Alasan"
              />
            </div>
            <ClassCategoryStrip
              title="Kategori Kelas"
              description="Daftar kelas yang terdaftar untuk data denda."
              classes={classCategories}
            />

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Diagram Denda</div>
                <div className="panel-actions fines-chart-actions">
                  <select
                    className="form-select fine-chart-type-select"
                    value={fineChartType}
                    onChange={(event) => setFineChartType(event.target.value)}
                  >
                    <option value="line">Garis</option>
                    <option value="area">Area</option>
                    <option value="donut">Donat</option>
                  </select>
                  <div className="filter-chips fine-chart-period-chips">
                    {[
                      ["week", "Mingguan"],
                      ["month", "Bulanan"],
                      ["year", "Tahunan"]
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`chip ${fineChartPeriod === value ? "active" : ""}`}
                        onClick={() => setFineChartPeriod(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="panel-body fine-chart-panel-body">
                <FineAmountChart
                  labels={fineChartPeriods}
                  rows={fineChartRows}
                  chartType={fineChartType}
                  selectedKey={fineChartClassFilter}
                  onSelectKey={setFineChartClassFilter}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Daftar Denda Siswa</div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Tanggal</th>
                        <th>Siswa</th>
                        <th>Kelas</th>
                        <th>Alasan Denda</th>
                        <th>Nominal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredFineRows.length === 0 ? (
                        <tr>
                          <td colSpan="5">
                            <div className="empty-row">Belum ada data denda.</div>
                          </td>
                        </tr>
                      ) : (
                        filteredFineRows.map((item) => (
                          <tr key={item.id}>
                            <td>{formatDateLabel(item.created_at)}</td>
                            <td>{item.student_name ?? "-"}</td>
                            <td>{item.class_name ?? "Tanpa Kelas"}</td>
                            <td>{item.note?.trim?.() || item.title || "Alasan belum diisi"}</td>
                            <td className="money-warning">+{formatCurrency(item.amount)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "expense" ? "active" : ""}`}>
            <div className="stats-grid three">
              <StatCard color="red" icon="fa-arrow-trend-up" value={formatCurrency(expenses.reduce((sum, item) => sum + Number(item.amount ?? 0), 0))} label="Total Pengeluaran" />
              <StatCard color="orange" icon="fa-calendar-xmark" value={formatCurrency(expenseMonthlyTotal)} label="Bulan Ini" />
              <StatCard color="yellow" icon="fa-receipt" value={expenses.length} label="Transaksi Keluar" />
            </div>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Daftar Pengeluaran</div>
                <div className="panel-actions">
                  <select
                    className="form-select class-filter-select"
                    value={expenseFilter}
                    onChange={(event) => setExpenseFilter(event.target.value)}
                  >
                    {["Semua", ...classNames].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Tanggal</th>
                        <th>Kelas</th>
                        <th>Kategori</th>
                        <th>Keterangan</th>
                        <th>Jumlah</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredExpenseRows.length === 0 ? (
                        <tr>
                          <td colSpan="5">
                            <div className="empty-row">Belum ada data pengeluaran.</div>
                          </td>
                        </tr>
                      ) : (
                        filteredExpenseRows.map((item) => (
                          <tr key={item.id}>
                            <td>{formatDateLabel(item.created_at)}</td>
                            <td>{item.class_name ?? "-"}</td>
                            <td>{item.category ?? "Lainnya"}</td>
                            <td>{item.title}</td>
                            <td className="money-negative">-{formatCurrency(item.amount)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "balance" ? "active" : ""}`}>
            <div className="saldo-card">
              <div className="saldo-label">Total Saldo Keseluruhan</div>
              <div className="saldo-amount">{formatCurrency(dashboard.overview?.total_cash ?? 0)}</div>
                <div className="saldo-details">
                  <div className="saldo-detail-item">
                  <span className="saldo-detail-label">Total Kas</span>
                  <span className="saldo-detail-value">{formatCurrency((dashboard.overview?.total_income ?? 0) - (dashboard.overview?.total_fine ?? 0))}</span>
                </div>
                <div className="saldo-detail-item">
                  <span className="saldo-detail-label">Total Denda</span>
                  <span className="saldo-detail-value">{formatCurrency(dashboard.overview?.total_fine ?? 0)}</span>
                </div>
                <div className="saldo-detail-item">
                  <span className="saldo-detail-label">Total Pengeluaran</span>
                  <span className="saldo-detail-value">{formatCurrency(dashboard.overview?.total_expense ?? 0)}</span>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Saldo per Kelas</div>
                <div className="panel-actions">
                  <select
                    className="form-select class-filter-select"
                    value={balanceFilter}
                    onChange={(event) => setBalanceFilter(event.target.value)}
                  >
                    {["Semua", ...classNames].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Kelas</th>
                        <th>Kas</th>
                        <th>Denda</th>
                        <th>Keluar</th>
                        <th>Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBalanceRows.length === 0 ? (
                        <tr>
                          <td colSpan="5">
                            <div className="empty-row">Belum ada saldo yang bisa ditampilkan.</div>
                          </td>
                        </tr>
                      ) : (
                        filteredBalanceRows.map((item) => (
                          <tr key={item.className}>
                            <td>{item.className}</td>
                            <td className="money-positive">+{formatCurrency(item.regularIncome)}</td>
                            <td className="money-warning">+{formatCurrency(item.fine)}</td>
                            <td className="money-negative">-{formatCurrency(item.expense)}</td>
                            <td>{formatCurrency(item.balance)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "reports" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Filter Laporan</div>
              </div>
              <div className="panel-body">
                <div className="form-row-3">
                  <div className="form-group">
                    <label className="form-label">Kelas</label>
                    <select
                      className="form-select"
                      value={reportFilters.className}
                      onChange={(event) =>
                        setReportFilters((current) => ({
                          ...current,
                          className: event.target.value
                        }))
                      }
                    >
                      <option value="semua">Semua Kelas</option>
                      <option value="Tanpa Kelas">Tanpa Kelas</option>
                      {classNames.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Bulan</label>
                    <select
                      className="form-select"
                      value={reportFilters.month}
                      onChange={(event) =>
                        setReportFilters((current) => ({
                          ...current,
                          month: event.target.value
                        }))
                      }
                    >
                      <option value="semua">Semua Bulan</option>
                      {months.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Tahun</label>
                    <select
                      className="form-select"
                      value={reportFilters.year}
                      onChange={(event) =>
                        setReportFilters((current) => ({
                          ...current,
                          year: event.target.value
                        }))
                      }
                    >
                      <option value="semua">Semua Tahun</option>
                      {(reportYearOptions.length ? reportYearOptions : ["2024"]).map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="panel-actions report-action-grid">
                  <button className="btn btn-primary" onClick={() => setReportGenerated(true)}>
                    <i className="fas fa-eye" /> Tampilkan
                  </button>
                  <button className="btn btn-secondary" onClick={handlePrintSuperadminReport}>
                    <i className="fas fa-print" /> Cetak
                  </button>
                  <button className="btn btn-outline" onClick={handleExportSuperadminPdf}>
                    <i className="fas fa-download" /> Export PDF
                  </button>
                  <button className="btn btn-secondary" onClick={handleExportSuperadminExcel}>
                    <i className="fas fa-file-excel" /> Export Excel
                  </button>
                </div>
              </div>
            </div>

            {!reportGenerated ? (
              <div className="panel">
                <div className="panel-body">
                  <div className="empty-state large">
                    <i className="fas fa-file-lines" />
                    <p>Pilih filter, lalu klik "Tampilkan"</p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="report-banner panel">
                  <div className="panel-body centered">
                    <h2>LAPORAN KAS KESELURUHAN</h2>
                    <p>TA {activeYear?.name ?? "Belum diatur"}</p>
                    <span>
                      Periode:{" "}
                      {reportFilters.month === "semua"
                        ? "Semua Bulan"
                        : `${months.find((item) => item.value === reportFilters.month)?.label ?? "-"} ${reportFilters.year}`}
                    </span>
                  </div>
                </div>

                <div className="stats-grid four-report mobile-report-stats">
                  <SimpleStat value={formatCurrency(generatedReport?.income ?? 0)} label="Pemasukan" />
                  <SimpleStat value={formatCurrency(generatedReport?.fine ?? 0)} label="Denda" />
                  <SimpleStat value={formatCurrency(generatedReport?.expense ?? 0)} label="Pengeluaran" />
                  <SimpleStat value={formatCurrency(generatedReport?.balance ?? 0)} label="Saldo" highlight />
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <div className="panel-title">per Kelas</div>
                  </div>
                  <div className="panel-body no-padding">
                    <div className="table-wrapper mobile-report-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Kelas</th>
                            <th>Kas</th>
                            <th>Denda</th>
                            <th>Keluar</th>
                            <th>Saldo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {generatedReport?.rows?.length ? (
                            generatedReport.rows.map((item) => (
                              <tr key={item.className}>
                                <td data-label="Kelas">{item.className}</td>
                                <td data-label="Kas" className="money-positive">+{formatCurrency(item.regularIncome)}</td>
                                <td data-label="Denda" className="money-warning">+{formatCurrency(item.fine)}</td>
                                <td data-label="Keluar" className="money-negative">-{formatCurrency(item.expense)}</td>
                                <td data-label="Saldo">{formatCurrency(item.balance)}</td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan="5">
                                <div className="empty-row">Tidak ada data sesuai filter laporan.</div>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      {userModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card">
            <div className="modal-header">
              <h3>{editingUser ? "Edit Akun" : "Tambah Akun Baru"}</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setUserModalOpen(false);
                  setEditingUser(null);
                  setUserFormErrors({});
                }}
              >
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleAddUser}>
              <div className="form-group">
                <label className="form-label">Foto profil</label>
                <div className="profile-photo-editor">
                  <div
                    className="profile-photo-large"
                    role={userForm.profilePhoto ? "button" : undefined}
                    tabIndex={userForm.profilePhoto ? 0 : undefined}
                    onClick={() => {
                      if (!userForm.profilePhoto) {
                        return;
                      }

                      openCropper({
                        target: "userFormProfilePhoto",
                        title: "Crop Foto Akun",
                        source: userForm.profilePhotoOriginal || userForm.profilePhoto,
                        aspect: "square",
                        originalSource: userForm.profilePhotoOriginal || userForm.profilePhoto
                      });
                    }}
                    onKeyDown={(event) => {
                      if (!userForm.profilePhoto || (event.key !== "Enter" && event.key !== " ")) {
                        return;
                      }

                      event.preventDefault();
                      openCropper({
                        target: "userFormProfilePhoto",
                        title: "Crop Foto Akun",
                        source: userForm.profilePhotoOriginal || userForm.profilePhoto,
                        aspect: "square",
                        originalSource: userForm.profilePhotoOriginal || userForm.profilePhoto
                      });
                    }}
                  >
                    {userForm.profilePhoto ? (
                      <img className="user-photo large" src={userForm.profilePhoto} alt={userForm.fullName || "Foto akun"} />
                    ) : (
                      getInitials(userForm.fullName || "Akun Baru")
                    )}
                  </div>
                  <div className="profile-photo-actions">
                    <label className="btn btn-secondary profile-upload-btn">
                      <i className="fas fa-upload" /> Upload Foto
                      <input type="file" accept="image/*" hidden onChange={handleUserProfilePhotoChange} />
                    </label>
                    {userForm.profilePhoto && (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => setUserForm((current) => ({ ...current, profilePhoto: "", profilePhotoOriginal: "" }))}
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Nama Lengkap</label>
                <input
                  className={`form-input ${userFormErrors.fullName ? "is-invalid" : ""}`}
                  placeholder="Masukkan nama lengkap"
                  value={userForm.fullName}
                  onChange={(event) => updateUserFormField("fullName", event.target.value)}
                />
                {userFormErrors.fullName ? <div className="form-error-text">{userFormErrors.fullName}</div> : null}
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input
                    className={`form-input ${userFormErrors.email ? "is-invalid" : ""}`}
                    placeholder="email@contoh.com"
                    value={userForm.email}
                    onChange={(event) => updateUserFormField("email", event.target.value)}
                  />
                  {userFormErrors.email ? <div className="form-error-text">{userFormErrors.email}</div> : null}
                </div>
                <div className="form-group">
                  <label className="form-label">Password</label>
                  <PasswordField
                    placeholder={editingUser ? "Kosongkan jika tidak diubah" : "Minimal 6 karakter"}
                    value={userForm.password}
                    onChange={(event) => updateUserFormField("password", event.target.value)}
                    className={`form-input ${userFormErrors.password ? "is-invalid" : ""}`}
                    autoComplete="new-password"
                  />
                  {userFormErrors.password ? <div className="form-error-text">{userFormErrors.password}</div> : null}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">NIS (opsional)</label>
                <input
                  className="form-input"
                  placeholder="Isi jika akun siswa"
                  value={userForm.nis}
                  onChange={(event) => updateUserFormField("nis", event.target.value)}
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Kategori akun</label>
                  <select
                    className="form-select"
                    value={userForm.role}
                    onChange={(event) =>
                      setUserForm((current) => ({ ...current, role: event.target.value }))
                    }
                  >
                    <option value="bendahara">Bendahara</option>
                    <option value="walikelas">Wali Kelas</option>
                    <option value="siswa">Siswa</option>
                    <option value="superadmin">Superadmin</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Kelas</label>
                  <select
                    className="form-select"
                    value={userForm.classId}
                    onChange={(event) =>
                      setUserForm((current) => ({ ...current, classId: event.target.value }))
                    }
                  >
                    <option value="">Tanpa kelas</option>
                    {dashboard.classes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Status akun</label>
                <select
                  className="form-select"
                  value={userForm.isActive ? "aktif" : "nonaktif"}
                  onChange={(event) =>
                    setUserForm((current) => ({
                      ...current,
                      isActive: event.target.value === "aktif"
                    }))
                  }
                >
                  <option value="aktif">Aktif</option>
                  <option value="nonaktif">Nonaktif</option>
                </select>
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    setUserModalOpen(false);
                    setEditingUser(null);
                    setUserFormErrors({});
                  }}
                >
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> {editingUser ? "Simpan Perubahan" : "Simpan"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {classModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card">
            <div className="modal-header">
              <h3>{editingClass ? "Edit Kategori Kelas" : "Tambah Kategori Kelas"}</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setClassModalOpen(false);
                  setEditingClass(null);
                  resetClassForm();
                }}
              >
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleAddClass}>
              <div className="form-group">
                <label className="form-label">Nama kategori kelas</label>
                <input
                  className="form-input"
                  placeholder="Contoh: XI RPL 1"
                  value={classForm.name}
                  onChange={(event) =>
                    setClassForm((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label">Nominal kas kelas (Rp)</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  placeholder="Contoh: 5000"
                  value={classForm.nominalKas}
                  onChange={(event) =>
                    setClassForm((current) => ({ ...current, nominalKas: event.target.value }))
                  }
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Tahun ajaran</label>
                  <select
                    className="form-select"
                    value={classForm.academicYearId}
                    onChange={(event) =>
                      setClassForm((current) => ({
                        ...current,
                        academicYearId: event.target.value
                      }))
                    }
                  >
                    <option value="">Pilih tahun ajaran</option>
                    {dashboard.years.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Bendahara</label>
                  <select
                    className="form-select"
                    value={classForm.treasurerUserId}
                    onChange={(event) =>
                      setClassForm((current) => ({
                        ...current,
                        treasurerUserId: event.target.value
                      }))
                    }
                  >
                    <option value="">Belum ditentukan</option>
                    {dashboard.users
                      .filter((item) => item.role === "bendahara")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.fullName}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    setClassModalOpen(false);
                    setEditingClass(null);
                    resetClassForm();
                  }}
                >
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> {editingClass ? "Simpan Perubahan" : "Simpan"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-container">
          <div className={`toast ${toast.type}`}>
            <div className="toast-icon">
              <i className={`fas ${toast.type === "error" ? "fa-xmark" : "fa-check"}`} />
            </div>
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {appSettingsOpen && (
        <div className="modal-overlay show">
          <div className="modal-card app-settings-modal">
            <div className="modal-header">
              <h3>Pengaturan Aplikasi</h3>
              <button className="modal-close" onClick={() => setAppSettingsOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveAppSettings}>
              <div className="form-group">
                <label className="form-label">Nama aplikasi</label>
                <input
                  className="form-input"
                  value={appSettings.appName}
                  onChange={(event) =>
                    setAppSettings((current) => ({ ...current, appName: event.target.value }))
                  }
                  placeholder="Nama aplikasi"
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Warna sidebar</label>
                  <input
                    className="form-input color-input"
                    type="color"
                    value={appSettings.sidebarColor}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        sidebarColor: event.target.value
                      }))
                    }
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Warna background polos</label>
                  <input
                    className="form-input color-input"
                    type="color"
                    value={appSettings.backgroundColor}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        backgroundColor: event.target.value
                      }))
                    }
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Upload logo</label>
                  <label className="upload-trigger">
                    <input type="file" accept="image/*" onChange={handleAppLogoChange} />
                    <i className="fas fa-image" /> Pilih logo
                  </label>
                  {appSettings.logoImage && (
                    <div className="upload-preview-card">
                      <button
                        type="button"
                        className="upload-remove-btn"
                        onClick={() =>
                          setAppSettings((current) => ({
                            ...current,
                            logoImage: "",
                            logoOriginalImage: ""
                          }))
                        }
                      >
                        <i className="fas fa-xmark" />
                      </button>
                      <button
                        type="button"
                        className="upload-preview-image-button"
                        onClick={() =>
                          openCropper({
                            target: "appLogo",
                            title: "Crop Logo Aplikasi",
                            source: appSettings.logoOriginalImage || appSettings.logoImage,
                            aspect: "square",
                            originalSource: appSettings.logoOriginalImage || appSettings.logoImage
                          })
                        }
                      >
                        <img src={appSettings.logoImage} alt="Preview logo" className="upload-preview-image square" />
                      </button>
                      <div className="upload-preview-text">Preview logo sebelum disimpan</div>
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">Mode background</label>
                  <select
                    className="form-select"
                    value={appSettings.backgroundMode}
                    onChange={(event) =>
                      setAppSettings((current) => ({
                        ...current,
                        backgroundMode: event.target.value
                      }))
                    }
                  >
                    <option value="solid">Polos</option>
                    <option value="image">Gambar</option>
                  </select>
                </div>
              </div>

              {appSettings.backgroundMode === "image" && (
                <div className="form-group">
                  <label className="form-label">Upload background gambar</label>
                  <label className="upload-trigger">
                    <input type="file" accept="image/*" onChange={handleAppBackgroundChange} />
                    <i className="fas fa-image" /> Pilih background
                  </label>
                  {appSettings.backgroundImage && (
                    <div className="upload-preview-card wide">
                      <button
                        type="button"
                        className="upload-remove-btn"
                        onClick={() =>
                          setAppSettings((current) => ({
                            ...current,
                            backgroundImage: "",
                            backgroundOriginalImage: "",
                            backgroundMode: "solid"
                          }))
                        }
                      >
                        <i className="fas fa-xmark" />
                      </button>
                      <button
                        type="button"
                        className="upload-preview-image-button wide"
                        onClick={() =>
                          openCropper({
                            target: "appBackground",
                            title: "Crop Background Aplikasi",
                            source: appSettings.backgroundOriginalImage || appSettings.backgroundImage,
                            aspect: "landscape",
                            fit: "contain",
                            originalSource: appSettings.backgroundOriginalImage || appSettings.backgroundImage
                          })
                        }
                      >
                        <img
                          src={appSettings.backgroundImage}
                          alt="Preview background"
                          className="upload-preview-image landscape"
                        />
                      </button>
                      <div className="upload-preview-text">Preview background sebelum disimpan</div>
                    </div>
                  )}
                </div>
              )}

              <div className="app-preview">
                <div className="app-preview-sidebar" style={{ background: appSettings.sidebarColor }}>
                  {appSettings.logoImage ? (
                    <img className="logo-image preview-logo" src={appSettings.logoImage} alt={appSettings.appName} />
                  ) : (
                    <div className="logo-icon preview-logo-icon">
                      <i className="fas fa-wallet" />
                    </div>
                  )}
                  <div className="app-preview-name">{appSettings.appName || "Nama aplikasi"}</div>
                </div>
                <div
                  className="app-preview-main"
                  style={
                    appSettings.backgroundMode === "image" && appSettings.backgroundImage
                      ? {
                          backgroundImage: `linear-gradient(rgba(255,255,255,0.82), rgba(255,255,255,0.82)), url(${appSettings.backgroundImage})`,
                          backgroundSize: "100% auto",
                          backgroundPosition: "top center",
                          backgroundRepeat: "no-repeat"
                        }
                      : { background: appSettings.backgroundColor }
                  }
                />
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setAppSettingsOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Pengaturan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {profileModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card">
            <div className="modal-header">
              <h3>Edit Profil</h3>
              <button className="modal-close" onClick={() => setProfileModalOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveProfile}>
              <div className="profile-photo-editor">
                <div className="profile-photo-large">
                  {profileForm.profilePhoto ? (
                    <img className="user-photo large" src={profileForm.profilePhoto} alt={profileForm.fullName} />
                  ) : (
                    getInitials(profileForm.fullName)
                  )}
                </div>
                <div className="profile-photo-actions">
                  <label className="btn btn-secondary profile-upload-btn">
                    <input type="file" accept="image/*" hidden onChange={handleProfilePhotoChange} />
                    <i className="fas fa-image" /> Ganti Foto
                  </label>
                </div>
              </div>
              {profileForm.profilePhoto && (
                <div className="upload-preview-card profile-preview-card">
                  <button
                    type="button"
                    className="upload-remove-btn"
                    onClick={() =>
                      setProfileForm((current) => ({
                        ...current,
                        profilePhoto: "",
                        profilePhotoOriginal: ""
                      }))
                    }
                  >
                    <i className="fas fa-xmark" />
                  </button>
                  <button
                    type="button"
                    className="upload-preview-image-button"
                    onClick={() =>
                      openCropper({
                        target: "profilePhoto",
                        title: "Crop Foto Profil",
                        source: profileForm.profilePhotoOriginal || profileForm.profilePhoto,
                        aspect: "square",
                        originalSource: profileForm.profilePhotoOriginal || profileForm.profilePhoto
                      })
                    }
                  >
                    <img
                      src={profileForm.profilePhoto}
                      alt="Preview foto profil"
                      className="upload-preview-image square"
                    />
                  </button>
                  <div className="upload-preview-text">Preview foto profil sebelum disimpan</div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Nama Lengkap</label>
                <input
                  className="form-input"
                  value={profileForm.fullName}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, fullName: event.target.value }))
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={profileForm.email}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label">Password Baru</label>
                <PasswordField
                  placeholder="Kosongkan jika tidak diganti"
                  value={profileForm.password}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, password: event.target.value }))
                  }
                  autoComplete="new-password"
                />
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setProfileModalOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Profil
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {cropperOpen && (
        <div className="modal-overlay show">
          <div className="modal-card cropper-modal">
            <div className="modal-header">
              <h3>{cropperState.title}</h3>
              <button className="modal-close" onClick={() => setCropperOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div
                className={`cropper-viewport ${cropperState.aspect === "landscape" ? "landscape" : "square"} ${
                  cropDragging ? "dragging" : ""
                }`}
                style={{
                  width: cropperState.viewportWidth,
                  height: cropperState.viewportHeight
                }}
                onPointerDown={handleCropPointerDown}
                onPointerMove={handleCropPointerMove}
                onPointerUp={handleCropPointerUp}
                onPointerCancel={handleCropPointerUp}
                onPointerLeave={handleCropPointerUp}
              >
                <img
                  src={cropperState.source}
                  alt="Crop source"
                  className="cropper-image"
                  style={{
                    width: cropperState.imageWidth * cropperState.zoom,
                    height: cropperState.imageHeight * cropperState.zoom,
                    left:
                      (cropperState.viewportWidth - cropperState.imageWidth * cropperState.zoom) / 2 +
                      cropperState.panX,
                    top:
                      (cropperState.viewportHeight - cropperState.imageHeight * cropperState.zoom) / 2 +
                      cropperState.panY
                  }}
                />
              </div>

              <div className="cropper-controls">
                <div className="form-group">
                  <label className="form-label">Zoom</label>
                  <input
                    className="cropper-range"
                    type="range"
                    min={cropperState.minZoom}
                    max={cropperState.minZoom * 3}
                    step="0.01"
                    value={cropperState.zoom}
                    onChange={(event) =>
                      setCropperState((current) =>
                        clampCropState({
                          ...current,
                          zoom: Number(event.target.value)
                        })
                      )
                    }
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setCropperOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="button" onClick={handleApplyCrop}>
                  <i className="fas fa-crop-simple" /> Pakai Crop
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ color, icon, value, label, trend = "" }) {
  return (
    <div className={`stat-card c-${color}`}>
      <div className="stat-header">
        <div className={`stat-icon ${color}`}>
          <i className={`fas ${icon}`} />
        </div>
        {trend ? (
          <span className="stat-trend up">
            <i className="fas fa-arrow-up" /> {trend}
          </span>
        ) : null}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function SimpleStat({ value, label, highlight = false }) {
  return (
    <div className="simple-stat">
      <div className={`simple-value ${highlight ? "highlight" : ""}`}>{value}</div>
      <div className="simple-label">{label}</div>
    </div>
  );
}

function ClassCategoryStrip({ title = "Kategori Kelas", description = "", classes = [] }) {
  return (
    <div className="class-category-strip">
      <div className="class-category-strip-head">
        <div>
          <div className="class-category-strip-title">{title}</div>
          {description ? <div className="class-category-strip-desc">{description}</div> : null}
        </div>
        <div className="class-category-strip-count">{classes.length} kelas</div>
      </div>
      <div className="class-category-chip-list">
        {classes.length === 0 ? (
          <div className="empty-row compact">Belum ada kategori kelas.</div>
        ) : (
          classes.map((item) => (
            <span key={item} className="class-category-chip">
              <i className="fas fa-school" /> {item}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function createSmoothLinePath(points = []) {
  if (!points.length) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  const commands = [`M ${points[0].x} ${points[0].y}`];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const middleX = (current.x + next.x) / 2;
    const middleY = (current.y + next.y) / 2;

    commands.push(`Q ${current.x} ${current.y}, ${middleX} ${middleY}`);
  }

  const lastPoint = points[points.length - 1];
  commands.push(`T ${lastPoint.x} ${lastPoint.y}`);

  return commands.join(" ");
}

function FineAmountChart({ labels = [], rows = [], chartType = "area", selectedKey = "all", onSelectKey }) {
  const [activeTooltipIndex, setActiveTooltipIndex] = useState(null);
  const isMobileChart = typeof window !== "undefined" && window.innerWidth <= 640;
  const allVisibleRows = rows.filter((row) => row.values.some((value) => Number(value) > 0));
  const visibleRows =
    selectedKey === "all"
      ? allVisibleRows
      : allVisibleRows.filter((row) => row.key === selectedKey);
  const values = visibleRows.flatMap((row) => row.values.map((value) => Number(value) || 0));
  const hasData = values.some((value) => value > 0);
  const maxValue = Math.max(1, ...values);
  const chartWidth = isMobileChart ? 760 : 980;
  const chartHeight = isMobileChart ? 500 : 340;
  const paddingLeft = isMobileChart ? 28 : 54;
  const paddingRight = isMobileChart ? 18 : 38;
  const paddingTop = isMobileChart ? 22 : 30;
  const paddingBottom = isMobileChart ? 62 : 54;
  const innerWidth = chartWidth - paddingLeft - paddingRight;
  const innerHeight = chartHeight - paddingTop - paddingBottom;
  const palette = ["#f6b547", "#2ecf9a", "#5a8dee", "#f66d6d", "#8b5cf6", "#14b8a6"];
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return paddingTop + ratio * innerHeight;
  });
  const donutTotals = allVisibleRows.map((row, rowIndex) => ({
    key: row.key,
    label: row.label,
    total: row.values.reduce((sum, value) => sum + Number(value || 0), 0),
    color: palette[rowIndex % palette.length]
  }));
  const donutRows =
    selectedKey === "all" ? donutTotals : donutTotals.filter((row) => row.key === selectedKey);
  const donutTotalValue = donutRows.reduce((sum, row) => sum + row.total, 0);

  if (!hasData) {
    return (
      <div className="empty-state" style={{ minHeight: 220 }}>
        <i className="fas fa-chart-line" />
        <p>Belum ada data denda untuk diagram.</p>
      </div>
    );
  }

  const series = visibleRows.map((row, rowIndex) => {
    const points = row.values.map((value, index) => {
      const count = Math.max(1, labels.length - 1);
      const x = paddingLeft + (index / count) * innerWidth;
      const y = chartHeight - paddingBottom - ((Number(value) || 0) / maxValue) * innerHeight;
      return { x, y, value: Number(value) || 0 };
    });
    const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    const areaPoints =
      points.length && visibleRows.length === 1
        ? `${paddingLeft},${chartHeight - paddingBottom} ${linePoints} ${chartWidth - paddingRight},${chartHeight - paddingBottom}`
        : "";

    return {
      ...row,
      points,
      linePoints,
      areaPoints,
      color: palette[rowIndex % palette.length]
    };
  });

  let accumulatedRatio = -Math.PI / 2;
  const donutSegments = donutRows.map((item) => {
    const ratio = donutTotalValue > 0 ? item.total / donutTotalValue : 0;
    const startAngle = accumulatedRatio;
    const endAngle = startAngle + ratio * Math.PI * 2;
    accumulatedRatio = endAngle;

    return {
      ...item,
      startAngle,
      endAngle
    };
  });

  function createDonutPath(startAngle, endAngle, outerRadius, innerRadius, centerX, centerY) {
    const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
    const startOuterX = centerX + Math.cos(startAngle) * outerRadius;
    const startOuterY = centerY + Math.sin(startAngle) * outerRadius;
    const endOuterX = centerX + Math.cos(endAngle) * outerRadius;
    const endOuterY = centerY + Math.sin(endAngle) * outerRadius;
    const startInnerX = centerX + Math.cos(endAngle) * innerRadius;
    const startInnerY = centerY + Math.sin(endAngle) * innerRadius;
    const endInnerX = centerX + Math.cos(startAngle) * innerRadius;
    const endInnerY = centerY + Math.sin(startAngle) * innerRadius;

    return [
      `M ${startOuterX} ${startOuterY}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuterX} ${endOuterY}`,
      `L ${startInnerX} ${startInnerY}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${endInnerX} ${endInnerY}`,
      "Z"
    ].join(" ");
  }

  const donutHasSingleFullSegment =
    donutSegments.length === 1 && donutTotalValue > 0 && Math.abs(donutSegments[0].total - donutTotalValue) < 0.0001;
  const tooltipSeries =
    activeTooltipIndex === null
      ? []
      : series.map((item) => ({
          label: item.label,
          color: item.color,
          value: Number(item.points[activeTooltipIndex]?.value ?? 0)
        }));
  const tooltipAnchor =
    activeTooltipIndex === null
      ? null
      : {
          x: series[0]?.points[activeTooltipIndex]?.x ?? paddingLeft,
          y: Math.min(...series.map((item) => item.points[activeTooltipIndex]?.y ?? chartHeight / 2)),
          label: labels[activeTooltipIndex] ?? "-"
        };

  return (
    <div className="fine-chart-card">
      {chartType === "donut" ? (
        <div className="fine-donut-layout">
          <svg className="fine-donut-chart-svg" viewBox="0 0 420 240" role="img" aria-label="Diagram donat denda">
            <circle cx="210" cy="108" r="68" className="fine-donut-base-ring" />
            {donutHasSingleFullSegment ? (
              <circle
                cx="210"
                cy="108"
                r="68"
                className="fine-donut-stroke-ring"
                style={{ stroke: donutSegments[0].color }}
              />
            ) : (
              donutSegments.map((item) => (
                <path
                  key={item.key}
                  d={createDonutPath(item.startAngle, item.endAngle, 86, 50, 210, 108)}
                  style={{ fill: item.color }}
                  className="fine-donut-segment"
                />
              ))
            )}
            <circle cx="210" cy="108" r="38" fill="#ffffff" />
            <text className="fine-donut-total-label" x="210" y="100" textAnchor="middle">
              Total
            </text>
            <text className="fine-donut-total-value" x="210" y="124" textAnchor="middle">
              {formatShortCurrency(donutTotalValue)}
            </text>
          </svg>
        </div>
      ) : (
        <div
          className="fine-chart-stage"
          onClick={() => setActiveTooltipIndex(null)}
        >
          <svg className="fine-chart-svg" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Diagram denda">
            <defs>
              <linearGradient id="fineChartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f6b547" stopOpacity="0.34" />
                <stop offset="100%" stopColor="#f6b547" stopOpacity="0.04" />
              </linearGradient>
            </defs>
            {ticks.map((y) => (
              <line key={y} className="fine-chart-grid-line" x1={paddingLeft} y1={y} x2={chartWidth - paddingRight} y2={y} />
            ))}
            <line className="fine-chart-axis-line" x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={chartHeight - paddingBottom} />
            <line className="fine-chart-axis-line" x1={paddingLeft} y1={chartHeight - paddingBottom} x2={chartWidth - paddingRight} y2={chartHeight - paddingBottom} />

            {chartType === "area" &&
              series.map((item) =>
                item.areaPoints ? (
                  <polygon key={`${item.key}-area`} className="fine-chart-area" points={item.areaPoints} />
                ) : null
              )}
            {series.map((item) => (
              <path
                key={`${item.key}-line`}
                className="fine-chart-line"
                d={createSmoothLinePath(item.points)}
                style={{ stroke: item.color }}
              />
            ))}
            {series.map((item) =>
              item.points.map((point, index) => (
                <circle
                  key={`${item.key}-${index}`}
                  className="fine-chart-dot"
                  cx={point.x}
                  cy={point.y}
                  r="5"
                  style={{ fill: item.color }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveTooltipIndex((current) => (current === index ? null : index));
                  }}
                />
              ))
            )}
            {labels.map((label, index) => {
              const count = Math.max(1, labels.length - 1);
              const x = paddingLeft + (index / count) * innerWidth;
              return (
                <text key={label} className="fine-chart-label" x={x} y={chartHeight - 18} textAnchor="middle">
                  {label}
                </text>
              );
            })}
          </svg>
          {activeTooltipIndex !== null && tooltipAnchor ? (
            <div
              className="fine-chart-tooltip"
              style={{
                left: `clamp(18px, calc(${((tooltipAnchor.x / chartWidth) * 100).toFixed(3)}% - 88px), calc(100% - 182px))`,
                top: `clamp(10px, calc(${((tooltipAnchor.y / chartHeight) * 100).toFixed(3)}% - 86px), calc(100% - 116px))`
              }}
            >
              <div className="fine-chart-tooltip-title">{tooltipAnchor.label}</div>
              {tooltipSeries.map((item) => (
                <div key={item.label} className="fine-chart-tooltip-row">
                  <span className="fine-chart-tooltip-name">
                    <i style={{ background: item.color }} />
                    {item.label}
                  </span>
                  <strong>{formatShortCurrency(item.value)}</strong>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {chartType !== "donut" ? (
        <div className="fine-chart-legend">
          {series.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`fine-chart-legend-item ${selectedKey === item.key ? "active" : ""}`}
              onClick={() => onSelectKey?.(item.key)}
            >
              <i style={{ background: item.color }} />
              {item.label}
            </button>
          ))}
        </div>
      ) : donutRows.length ? (
        <div className="fine-chart-legend fine-chart-legend-donut">
          {donutRows.map((item) => (
            <span key={item.key} className="fine-chart-legend-item active static">
              <i style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ClassFinanceComparisonChart({ rows = [] }) {
  const [activeTooltipIndex, setActiveTooltipIndex] = useState(null);
  const safeRows = rows.map((row) => ({
    label: row.className,
    regularIncome: Math.max(0, Number(row.regularIncome ?? 0)),
    fine: Math.max(0, Number(row.fine ?? 0)),
    expense: Math.max(0, Number(row.expense ?? 0)),
    balance: Number(row.balance ?? 0)
  }));
  const hasData = safeRows.some(
    (row) => row.regularIncome > 0 || row.fine > 0 || row.expense > 0
  );
  const maxValue = Math.max(
    1,
    ...safeRows.flatMap((row) => [row.regularIncome, row.fine, row.expense])
  );
  const chartWidth = 860;
  const chartHeight = 320;
  const paddingLeft = 60;
  const paddingRight = 32;
  const paddingTop = 26;
  const paddingBottom = 52;
  const innerWidth = chartWidth - paddingLeft - paddingRight;
  const innerHeight = chartHeight - paddingTop - paddingBottom;
  const getX = (index) => {
    if (safeRows.length <= 1) {
      return paddingLeft + innerWidth / 2;
    }

    return paddingLeft + (index / (safeRows.length - 1)) * innerWidth;
  };
  const series = [
    { key: "regularIncome", label: "Pemasukan", color: "green" },
    { key: "fine", label: "Denda", color: "yellow" },
    { key: "expense", label: "Pengeluaran", color: "red" }
  ].map((item) => {
    const points = safeRows.map((row, index) => {
      const value = Number(row[item.key] ?? 0);
      const x = getX(index);
      const y = chartHeight - paddingBottom - (value / maxValue) * innerHeight;
      return { x, y, value, label: row.label };
    });

    const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    const areaPoints = points.length
      ? `${points[0].x},${chartHeight - paddingBottom} ${linePoints} ${points[points.length - 1].x},${chartHeight - paddingBottom}`
      : "";

    return {
      ...item,
      points,
      linePoints,
      areaPoints
    };
  });
  const yTicks = Array.from({ length: 5 }, (_, index) => ({
    y: paddingTop + (index / 4) * innerHeight,
    value: maxValue * (1 - index / 4)
  }));
  const tooltipSeries =
    activeTooltipIndex === null
      ? []
      : series.map((item) => ({
          label: item.label,
          color:
            item.color === "green"
              ? "#20c997"
              : item.color === "yellow"
                ? "#ffb84d"
                : item.color === "red"
                  ? "#ff6264"
                  : "#5b9bd5",
          value: Number(item.points[activeTooltipIndex]?.value ?? 0)
        }));
  const tooltipAnchor =
    activeTooltipIndex === null
      ? null
      : {
          x: series[0]?.points[activeTooltipIndex]?.x ?? paddingLeft,
          y: Math.min(...series.map((item) => item.points[activeTooltipIndex]?.y ?? chartHeight / 2)),
          label: safeRows[activeTooltipIndex]?.label ?? "-"
        };

  if (!hasData) {
    return (
      <div className="empty-state">
        <i className="fas fa-chart-line" />
        <p>Belum ada data kas per kelas.</p>
      </div>
    );
  }

  return (
    <div className="class-finance-chart">
      <div
        className="class-finance-chart-stage"
        onClick={() => setActiveTooltipIndex(null)}
      >
        <svg className="class-finance-chart-svg" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Grafik kas per kelas">
          <defs>
            <linearGradient id="classChartGreen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="finance-area-stop-start green" />
              <stop offset="100%" className="finance-area-stop-end green" />
            </linearGradient>
            <linearGradient id="classChartYellow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="finance-area-stop-start yellow" />
              <stop offset="100%" className="finance-area-stop-end yellow" />
            </linearGradient>
            <linearGradient id="classChartRed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="finance-area-stop-start red" />
              <stop offset="100%" className="finance-area-stop-end red" />
            </linearGradient>
          </defs>
          {yTicks.map((tick) => (
            <line
              key={tick.y}
              className="class-finance-grid-line"
              x1={paddingLeft}
              y1={tick.y}
              x2={chartWidth - paddingRight}
              y2={tick.y}
            />
          ))}
          <line className="class-finance-axis-line" x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={chartHeight - paddingBottom} />
          <line className="class-finance-axis-line" x1={paddingLeft} y1={chartHeight - paddingBottom} x2={chartWidth - paddingRight} y2={chartHeight - paddingBottom} />
          {series.map((item) => (
            <path
              key={`${item.key}-line`}
              className={`finance-graph-line ${item.color}`}
              d={createSmoothLinePath(item.points)}
            />
          ))}
          {series.map((item) =>
            item.points.map((point, index) => (
              <circle
                key={`${item.key}-${point.label}`}
                className={`finance-graph-dot ${item.color}`}
                cx={point.x}
                cy={point.y}
                r="5"
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveTooltipIndex((current) => (current === index ? null : index));
                }}
              />
            ))
          )}
          {safeRows.map((row, index) => (
            <g key={row.label}>
              <text className="class-finance-axis-label" x={getX(index)} y={chartHeight - 16} textAnchor="middle">
                {row.label}
              </text>
              <text className="class-finance-balance-label" x={getX(index)} y={paddingTop - 4} textAnchor="middle">
                {formatShortCurrency(row.balance)}
              </text>
            </g>
          ))}
        </svg>
        {activeTooltipIndex !== null && tooltipAnchor ? (
          <div
            className="fine-chart-tooltip"
            style={{
              left: `clamp(18px, calc(${((tooltipAnchor.x / chartWidth) * 100).toFixed(3)}% - 88px), calc(100% - 182px))`,
              top: `clamp(10px, calc(${((tooltipAnchor.y / chartHeight) * 100).toFixed(3)}% - 86px), calc(100% - 116px))`
            }}
          >
            <div className="fine-chart-tooltip-title">{tooltipAnchor.label}</div>
            {tooltipSeries.map((item) => (
              <div key={item.label} className="fine-chart-tooltip-row">
                <span className="fine-chart-tooltip-name">
                  <i style={{ background: item.color }} />
                  {item.label}
                </span>
                <strong>{formatShortCurrency(item.value)}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="chart-legend class-finance-chart-legend">
        <div className="chart-legend-item">
          <div className="chart-legend-dot green" /> Pemasukan
        </div>
        <div className="chart-legend-item">
          <div className="chart-legend-dot yellow" /> Denda
        </div>
        <div className="chart-legend-item">
          <div className="chart-legend-dot red" /> Pengeluaran
        </div>
      </div>
    </div>
  );
}

function CashDistributionChart({ rows }) {
  const [shape, setShape] = useState("donut");
  const segments = [
    { label: "Pemasukan", color: "#10b981", key: "regularIncome" },
    { label: "Denda", color: "#f97316", key: "fine" },
    { label: "Pengeluaran", color: "#ef4444", key: "expense" }
  ].map((item) => ({ ...item, value: rows.reduce((sum, row) => sum + Math.max(0, Number(row[item.key]) || 0), 0) }));
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  const incoming = segments[0].value + segments[1].value;
  let angle = -90;
  const visibleSegments = segments.filter((item) => item.value > 0);
  return (
    <section className="panel cash-distribution-panel" aria-label="Distribusi Kas">
      <div className="cash-chart-header">
        <h3>Distribusi Kas <i className="fas fa-money-bill-wave" aria-hidden="true" /></h3>
        <label className="cash-chart-select">Bentuk diagram
          <select value={shape} onChange={(event) => setShape(event.target.value)}>
            <option value="donut">Donat</option><option value="pie">Lingkaran</option><option value="bar">Batang</option>
          </select>
        </label>
      </div>
      {shape === "bar" ? <div className="cash-distribution-bars">
        {segments.map((item) => <div key={item.key}>
          <span>{item.label}<strong>{formatCurrency(item.value)}</strong></span>
          <div className="cash-distribution-track"><div style={{ width: `${item.value / Math.max(1, ...segments.map((segment) => segment.value)) * 100}%`, background: item.color }} /></div>
        </div>)}
      </div> :
      <div className="cash-distribution-ring">
        <svg viewBox="0 0 260 260" role="img" aria-label={segments.map((item) => `${item.label}: ${formatCurrency(item.value)}`).join(", ")}>
          <circle cx="130" cy="130" r={shape === "pie" ? 56 : 98} fill="none" stroke="#ecfdf5" strokeWidth={shape === "pie" ? 112 : 30} />
          {visibleSegments.map((item) => {
            const sweep = item.value / total * 360;
            const start = angle;
            angle += sweep;
            const gap = Math.min(5, sweep * 0.3);
            const length = 2 * Math.PI * (shape === "pie" ? 56 : 98);
            return <circle key={item.key} cx="130" cy="130" r={shape === "pie" ? 56 : 98} fill="none" stroke={item.color}
              strokeWidth={shape === "pie" ? 112 : 30} strokeLinecap="butt" strokeDasharray={`${length * (sweep - (visibleSegments.length > 1 ? gap : 0)) / 360} ${length}`}
              transform={`rotate(${start + gap / 2} 130 130)`}>
              <title>{item.label}: {formatCurrency(item.value)}</title>
            </circle>;
          })}
        </svg>
        <div className={`cash-distribution-total ${shape === "pie" ? "cash-distribution-total-pie" : ""}`}>
          <strong>{formatShortCurrency(incoming)}</strong><span>Total Kas Masuk</span>
        </div>
      </div>}
      {total === 0 ? <p className="cash-distribution-empty">Belum ada data transaksi.</p> : null}
      <div className="cash-distribution-legend">
        {segments.map((item) => <span key={item.key} title={formatCurrency(item.value)}><i style={{ background: item.color }} />{item.label}<strong>{formatCurrency(item.value)}</strong></span>)}
      </div>
    </section>
  );
}

function FinanceChart({ title = "Diagram Keuangan", rows = [], series = [], period = "week", onPeriodChange, showDistribution = true }) {
  const [activeTooltipIndex, setActiveTooltipIndex] = useState(null);
  const [chartShape, setChartShape] = useState("area");
  const chartStageRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(720);
  useEffect(() => {
    const stage = chartStageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setChartWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [rows]);
  const safeRows = rows.map((row) => {
    const income = Math.max(0, Number(row.regularIncome) || 0);
    const expense = Math.max(0, Number(row.expense ?? 0));

    return {
      ...row,
      income,
      expense
    };
  });
  const chartRows = safeRows.map((row) => {
    return {
      ...row,
      fine: Math.max(0, Number(row.fine) || 0)
    };
  });
  const allValues = chartRows.flatMap((row) => [row.income, row.expense, row.fine]);
  const maxRawValue = Math.max(1, ...allValues);
  const scaleMagnitude = 10 ** Math.floor(Math.log10(maxRawValue / 5));
  const chartStepBase = [1, 2, 5, 10].find((step) => step * scaleMagnitude >= maxRawValue / 5) * scaleMagnitude;
  const maxValue = Math.max(1, Math.ceil(maxRawValue / chartStepBase) * chartStepBase);
  const hasData = allValues.some((value) => value > 0);
  const chartHeight = 340;
  const paddingLeft = 76;
  const paddingRight = 28;
  const paddingTop = 34;
  const paddingBottom = 42;
  const chartInnerWidth = chartWidth - paddingLeft - paddingRight;
  const chartInnerHeight = chartHeight - paddingTop - paddingBottom;
  const legendItems = [
    { key: "income", label: "Pemasukan", color: "green", hex: "#10b981" },
    { key: "fine", label: "Denda", color: "orange", hex: "#f97316" },
    { key: "expense", label: "Pengeluaran", color: "red", hex: "#ef4444" }
  ];
  const getY = (value) => chartHeight - paddingBottom - (Math.max(0, Number(value || 0)) / maxValue) * chartInnerHeight;
  const getX = (index) => {
    if (chartShape !== "bar" && chartShape !== "mixed" && chartRows.length > 1) {
      return paddingLeft + chartInnerWidth * index / (chartRows.length - 1);
    }
    const slotWidth = chartInnerWidth / Math.max(1, chartRows.length);
    return paddingLeft + slotWidth * index + slotWidth / 2;
  };
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return {
      value: maxValue * (1 - ratio),
      y: paddingTop + ratio * (chartHeight - paddingTop - paddingBottom)
    };
  });
  const tooltipSeries =
    activeTooltipIndex === null
      ? []
      : [
          { label: "Pemasukan", color: "#10b981", value: Number(chartRows[activeTooltipIndex]?.income ?? 0) },
          { label: "Denda", color: "#f97316", value: Number(chartRows[activeTooltipIndex]?.fine ?? 0) },
          { label: "Pengeluaran", color: "#ef4444", value: Number(chartRows[activeTooltipIndex]?.expense ?? 0) }
        ];
  const tooltipAnchor =
    activeTooltipIndex === null
      ? null
      : {
          x: getX(activeTooltipIndex),
          y: getY(Math.max(...tooltipSeries.map((item) => item.value))),
          label: chartRows[activeTooltipIndex]?.label ?? "-"
        };

  return (
    <>
    {showDistribution ? <CashDistributionChart rows={rows} /> : null}
    <div className="panel finance-chart-panel">
      <div className="panel-header">
        <div className="finance-chart-title">
          <div className="panel-title">{title} <span aria-hidden="true">📊</span></div>
          <p>Analisa perbandingan pemasukan, pengeluaran, dan denda</p>
        </div>
        <div className="cash-chart-controls">
        <div className="cash-chart-balance"><span>Saldo Periode</span><strong>{formatCurrency(chartRows.reduce((sum, row) => sum + row.income + row.fine - row.expense, 0))}</strong></div>
        <label className="cash-chart-select">Bentuk diagram
          <select value={chartShape} onChange={(event) => { setChartShape(event.target.value); setActiveTooltipIndex(null); }}>
            <option value="area">Area</option><option value="line">Garis</option><option value="bar">Batang</option><option value="mixed">Batang + Garis</option>
          </select>
        </label>
        <div className="filter-chips finance-period-tabs">
          {[
            ["week", "Mingguan"],
            ["month", "Bulanan"]
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`chip ${period === value ? "active" : ""}`}
              onClick={() => onPeriodChange?.(value)}
            >
              {label}
            </button>
          ))}
        </div>
        </div>
      </div>
      <div className="panel-body">
        {!hasData ? (
          <div className="empty-state">
            <i className="fas fa-chart-column" />
            <p>Belum ada data keuangan untuk diagram.</p>
          </div>
        ) : (
          <div className="finance-graph-card finance-graph-card-line">
            <div
              ref={chartStageRef}
              className="finance-chart-stage"
              onClick={() => setActiveTooltipIndex(null)}
            >
              <svg className="finance-line-graph" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={title}>
                <defs>
                  {legendItems.map((item) => <linearGradient key={item.key} id={`financeArea-${item.key}-${period}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={item.hex} stopOpacity="0.28" />
                    <stop offset="100%" stopColor={item.hex} stopOpacity="0.02" />
                  </linearGradient>)}
                </defs>
                {yTicks.map((tick) => (
                  <g key={tick.y}>
                    <line
                      className="finance-grid-line"
                      x1={paddingLeft}
                      y1={tick.y}
                      x2={chartWidth - paddingRight}
                      y2={tick.y}
                    />
                    <text className="finance-graph-y-label" x={paddingLeft - 16} y={tick.y + 4} textAnchor="end">
                      {formatShortCurrency(tick.value)}
                    </text>
                  </g>
                ))}
                <line className="finance-axis-line" x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={chartHeight - paddingBottom} />
                <line className="finance-axis-line" x1={paddingLeft} y1={chartHeight - paddingBottom} x2={chartWidth - paddingRight} y2={chartHeight - paddingBottom} />
                {legendItems.map((item, seriesIndex) => {
                  const points = chartRows.map((row, index) => ({ x: getX(index), y: getY(row[item.key]) }));
                  const linePath = points.map((point, index) => {
                    if (index === 0) return `M ${point.x} ${point.y}`;
                    const previous = points[index - 1];
                    const middleX = (previous.x + point.x) / 2;
                    return `C ${middleX} ${previous.y}, ${middleX} ${point.y}, ${point.x} ${point.y}`;
                  }).join(" ");
                  const bars = chartShape === "bar" || (chartShape === "mixed" && item.key !== "fine");
                  const barWidth = Math.min(26, chartInnerWidth / Math.max(1, chartRows.length) * 0.18);
                  return <g key={item.key}>
                    {chartShape === "area" && points.length > 1 ? <path
                      d={`${linePath} L ${points[points.length - 1].x} ${getY(0)} L ${points[0].x} ${getY(0)} Z`}
                      fill={`url(#financeArea-${item.key}-${period})`} /> : null}
                    {!bars ? <path d={linePath} fill="none" stroke={item.hex} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /> : null}
                    {points.map((point, index) => bars ? <rect key={index}
                      x={point.x + (seriesIndex - 1) * (barWidth + 4) - barWidth / 2} y={point.y}
                      width={barWidth} height={getY(0) - point.y} rx="6" fill={item.hex} fillOpacity="0.75"
                      onMouseEnter={() => setActiveTooltipIndex(index)} onMouseLeave={() => setActiveTooltipIndex(null)}
                      onClick={(event) => { event.stopPropagation(); setActiveTooltipIndex(index); }}>
                      <title>{chartRows[index].label} — {item.label}: {formatCurrency(chartRows[index][item.key])}</title>
                    </rect> : <circle key={index} cx={point.x} cy={point.y} r="5" fill="#fff" stroke={item.hex} strokeWidth="2"
                      tabIndex="0" aria-label={`${chartRows[index].label}, ${item.label}: ${formatCurrency(chartRows[index][item.key])}`}
                      onFocus={() => setActiveTooltipIndex(index)} onBlur={() => setActiveTooltipIndex(null)}
                      onMouseEnter={() => setActiveTooltipIndex(index)} onMouseLeave={() => setActiveTooltipIndex(null)}
                      onClick={(event) => { event.stopPropagation(); setActiveTooltipIndex(index); }} />)}
                  </g>;
                })}
                {chartRows.map((row, index) => {
                  const x = getX(index);
                  return (
                    <text className="finance-graph-axis-label" key={row.label} x={x} y={chartHeight - 12} textAnchor="middle">
                      {row.label}
                    </text>
                  );
                })}
              </svg>
              {activeTooltipIndex !== null && tooltipAnchor ? (
                <div
                  className="fine-chart-tooltip"
                  style={{
                    left: `clamp(18px, calc(${((tooltipAnchor.x / chartWidth) * 100).toFixed(3)}% - 88px), calc(100% - 182px))`,
                    top: `clamp(10px, calc(${((tooltipAnchor.y / chartHeight) * 100).toFixed(3)}% - 86px), calc(100% - 116px))`
                  }}
                >
                  <div className="fine-chart-tooltip-title">{tooltipAnchor.label}</div>
                  {tooltipSeries.map((item) => (
                    <div key={item.label} className="fine-chart-tooltip-row">
                      <span className="fine-chart-tooltip-name">
                        <i style={{ background: item.color }} />
                        {item.label}
                      </span>
                      <strong>{formatShortCurrency(item.value)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="finance-graph-labels">
              {legendItems.map((item) => (
                <div className="finance-graph-label" key={item.label}>
                  <span>
                    <i className={`finance-mini-dot ${chartShape !== "bar" ? "line" : ""}`} style={{ background: item.hex }} />
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

function StudentPanel({ session, setSession, handleLogout, activePage, setActivePage, appSettings }) {
  const [historyPage, setHistoryPage] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [financeChartPeriod, setFinanceChartPeriod] = useState("week");
  const [studentPaymentMonthFilter, setStudentPaymentMonthFilter] = useState(String(new Date().getMonth() + 1).padStart(2, "0"));
  const [cropperOpen, setCropperOpen] = useState(false);
  const [cropperState, setCropperState] = useState({
    target: null,
    title: "",
    source: "",
    aspect: "square",
    viewportWidth: 280,
    viewportHeight: 280,
    outputWidth: 512,
    outputHeight: 512,
    imageWidth: 0,
    imageHeight: 0,
    zoom: 1,
    minZoom: 1,
    panX: 0,
    panY: 0,
    originalSource: ""
  });
  const [cropDragging, setCropDragging] = useState(false);
  const cropDragRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0
  });
  const [data, setData] = useState({
    loading: false,
    error: "",
    student: null,
    classInfo: null,
    settings: null,
    overview: null,
    transactions: [],
    announcements: []
  });
  const [profileForm, setProfileForm] = useState({
    fullName: session.user.fullName ?? "",
    email: session.user.email ?? "",
    password: "",
    profilePhoto: session.user.profilePhoto ?? "",
    profilePhotoOriginal: session.user.profilePhotoOriginal ?? session.user.profilePhoto ?? ""
  });

  const allPages = studentPageGroups.flatMap((group) => group.items);
  const currentPage = allPages.find((item) => item.id === activePage) ?? allPages[0];

  useEffect(() => {
    if (!allPages.some((item) => item.id === activePage)) {
      setActivePage("dashboard");
    }
  }, [activePage, allPages, setActivePage]);

  const appShellStyle =
    appSettings.backgroundMode === "image" && appSettings.backgroundImage
        ? {
          backgroundImage: `linear-gradient(rgba(252, 253, 253, 0.9), rgba(252, 253, 253, 0.92)), url(${appSettings.backgroundImage})`,
          backgroundSize: "100% auto",
          backgroundPosition: "top center",
          backgroundRepeat: "no-repeat",
          backgroundAttachment: "fixed"
        }
      : {
          background: appSettings.backgroundColor
        };

  function showToast(message, type = "success") {
    setToast({ message, type, id: Date.now() });
    window.setTimeout(() => setToast(null), 2600);
  }

  async function openTreasurerCropper({ target, title, source, aspect = "square" }) {
    try {
      const image = await loadImage(source);
      const dimensions = getCropperDimensions(aspect);
      const minZoom = Math.max(
        dimensions.viewportWidth / image.width,
        dimensions.viewportHeight / image.height
      );

      setCropperState({
        target,
        title,
        source,
        aspect,
        ...dimensions,
        imageWidth: image.width,
        imageHeight: image.height,
        zoom: minZoom,
        minZoom,
        panX: 0,
        panY: 0
      });
      setCropperOpen(true);
    } catch {
      showToast("Gagal membuka editor crop gambar.", "error");
    }
  }

  async function openTreasurerCropperFromFile({ target, title, file, aspect = "square" }) {
    const source = await readFileAsDataUrl(file);
    await openTreasurerCropper({ target, title, source, aspect });
  }

  useEffect(() => {
    setProfileForm({
      fullName: session.user.fullName ?? "",
      email: session.user.email ?? "",
      password: "",
      profilePhoto: session.user.profilePhoto ?? "",
      profilePhotoOriginal: session.user.profilePhotoOriginal ?? session.user.profilePhoto ?? ""
    });
  }, [session.user]);

  async function openStudentCropper({ target, title, source, aspect = "square", originalSource = "" }) {
    try {
      const image = await loadImage(source);
      const dimensions = getCropperDimensions(aspect);
      const minZoom = Math.max(
        dimensions.viewportWidth / image.width,
        dimensions.viewportHeight / image.height
      );

      setCropperState({
        target,
        title,
        source,
        aspect,
        viewportWidth: dimensions.viewportWidth,
        viewportHeight: dimensions.viewportHeight,
        outputWidth: dimensions.outputWidth,
        outputHeight: dimensions.outputHeight,
        imageWidth: image.width,
        imageHeight: image.height,
        zoom: minZoom,
        minZoom,
        panX: 0,
        panY: 0,
        originalSource: originalSource || source
      });
      setCropperOpen(true);
    } catch (error) {
      showToast(error.message || "Gagal membuka crop gambar.", "error");
    }
  }

  async function openStudentCropperFromFile({ target, title, file, aspect = "square", originalSource = false }) {
    try {
      const source = await readImageFile(file);
      await openStudentCropper({ target, title, source, aspect, originalSource: originalSource ? source : "" });
    } catch (error) {
      showToast(error.message || "Gagal membaca gambar.", "error");
    }
  }

  function handleCropPointerDown(event) {
    if (!cropperOpen) {
      return;
    }

    event.preventDefault();
    cropDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: cropperState.panX,
      startPanY: cropperState.panY
    };
    setCropDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleCropPointerMove(event) {
    if (!cropDragging || cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - cropDragRef.current.startX;
    const deltaY = event.clientY - cropDragRef.current.startY;

    setCropperState((current) =>
      clampCropState({
        ...current,
        panX: cropDragRef.current.startPanX + deltaX,
        panY: cropDragRef.current.startPanY + deltaY
      })
    );
  }

  function handleCropPointerUp(event) {
    if (cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    setCropDragging(false);
    cropDragRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      startPanX: 0,
      startPanY: 0
    };
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  useEffect(() => {
    if (!allPages.some((item) => item.id === activePage)) {
      setActivePage("dashboard");
    }
  }, [activePage, allPages, setActivePage]);

  async function apiFetchStudent(path, options = {}) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-user-role": session.auth.role,
        "x-user-id": String(session.auth.userId),
        "x-session-token": session.auth.sessionToken ?? "",
        ...(options.headers ?? {})
      }
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Permintaan gagal.");
    }

    return result;
  }

  async function loadStudentData() {
    setData((current) => ({ ...current, loading: true, error: "" }));

    try {
      const result = await apiFetchStudent("/api/student/overview");
      setData({
        loading: false,
        error: "",
        student: result.student,
        classInfo: result.classInfo,
        settings: result.settings,
        overview: result.overview,
        transactions: result.transactions ?? [],
        announcements: result.announcements ?? []
      });
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: error.message }));
    }
  }

  useEffect(() => {
    loadStudentData();
  }, []);

  useEffect(() => {
    const refreshStudentData = () => {
      if (document.visibilityState === "visible") {
        loadStudentData();
      }
    };

    const intervalId = window.setInterval(refreshStudentData, 3000);
    window.addEventListener("focus", refreshStudentData);
    document.addEventListener("visibilitychange", refreshStudentData);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshStudentData);
      document.removeEventListener("visibilitychange", refreshStudentData);
    };
  }, []);

  async function handleStudentProfilePhotoChange(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      await openStudentCropperFromFile({
        target: "studentProfilePhoto",
        title: "Crop Foto Profil Siswa",
        file,
        aspect: "square",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses foto profil.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleApplyCrop() {
    try {
      const image = await loadImage(cropperState.source);
      const canvas = document.createElement("canvas");
      canvas.width = cropperState.outputWidth;
      canvas.height = cropperState.outputHeight;
      const context = canvas.getContext("2d");

      const renderedWidth = image.width * cropperState.zoom;
      const renderedHeight = image.height * cropperState.zoom;
      const left = (cropperState.viewportWidth - renderedWidth) / 2 + cropperState.panX;
      const top = (cropperState.viewportHeight - renderedHeight) / 2 + cropperState.panY;
      const srcX = Math.max(0, (0 - left) / cropperState.zoom);
      const srcY = Math.max(0, (0 - top) / cropperState.zoom);
      const srcWidth = Math.min(image.width, cropperState.viewportWidth / cropperState.zoom);
      const srcHeight = Math.min(image.height, cropperState.viewportHeight / cropperState.zoom);
      const resultState = clampCropState(cropperState);

      context.drawImage(image, srcX, srcY, srcWidth, srcHeight, 0, 0, canvas.width, canvas.height);

      const result = canvas.toDataURL("image/png");

      if (resultState.target === "studentProfilePhoto") {
        setProfileForm((current) => ({
          ...current,
          profilePhoto: result,
          profilePhotoOriginal: cropperState.originalSource || current.profilePhotoOriginal || cropperState.source
        }));
      }

      setCropperOpen(false);
    } catch (error) {
      showToast(error.message || "Gagal menerapkan crop gambar.", "error");
    }
  }

  async function handleSaveStudentProfile(event) {
    event.preventDefault();

    try {
      const response = await apiFetchStudent("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: profileForm.fullName,
          email: profileForm.email,
          password: profileForm.password,
          profilePhoto: profileForm.profilePhoto,
          profilePhotoOriginal: profileForm.profilePhotoOriginal || profileForm.profilePhoto
        })
      });

      setSession((current) => ({
        ...current,
        user: response.user
      }));
      setProfileForm((current) => ({ ...current, password: "" }));
      setProfileModalOpen(false);
      showToast("Profil siswa berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan profil siswa.", "error");
    }
  }

  function handlePrintStudent() {
    const reportWindow = window.open("", "_blank", "width=1000,height=800");

    if (!reportWindow) {
      showToast("Popup browser diblokir. Izinkan popup untuk mencetak.", "error");
      return;
    }

    const transactionRows = transactions.length
      ? transactions
          .map(
            (item) => `
              <tr>
                <td>${formatDateLabel(item.created_at)}</td>
                <td>${item.title}</td>
                <td>${item.note || "-"}</td>
                <td class="plus">+${formatCurrency(item.amount)}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="4">Belum ada riwayat pembayaran.</td></tr>`;

    reportWindow.document.write(`
      <html>
        <head>
          <title>Cetak Kas Siswa - ${session.user.fullName}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #1f2937; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #e5e7eb; padding: 10px 12px; text-align: left; font-size: 14px; }
            th { background: #f9fafb; text-transform: uppercase; font-size: 12px; letter-spacing: .06em; color: #6b7280; }
            .plus { color: #059669; font-weight: 700; }
            @media print { body { padding: 16px; } }
          </style>
        </head>
        <body>
          <table>
            <thead>
              <tr>
                <th>Tanggal</th>
                <th>Judul</th>
                <th>Keterangan</th>
                <th>Jumlah</th>
              </tr>
            </thead>
            <tbody>
              ${transactionRows}
            </tbody>
          </table>
        </body>
      </html>
    `);
    reportWindow.document.close();
    reportWindow.focus();
    reportWindow.print();
  }

  const overview = data.overview ?? {};
  const transactions = data.transactions ?? [];
  const studentNominalKas = data.classInfo?.nominal_kas ?? overview.nominal ?? 0;
  const statusLabel = overview.status === "lunas" ? "Lunas" : "Belum Bayar";
  const statusClass = overview.status === "lunas" ? "status-lunas" : "status-belum";
  const historyPagination = paginateItems(transactions, historyPage, 10);
  const studentFinanceChartRows = buildFinanceChartRows(transactions, financeChartPeriod);
  const studentPaymentRows = useMemo(() => {
    if (!data.student) {
      return [];
    }

    return [
      {
        id: data.student.id,
        fullName: data.student.fullName ?? session.user.fullName,
        nominalKas: studentNominalKas,
        outstandingPeriods: 0
      }
    ];
  }, [data.student, session.user.fullName, studentNominalKas]);
  const monthlyPaymentStatuses = buildAcademicMonthStatuses(
    studentPaymentRows,
    transactions,
    data.classInfo?.academic_year_name,
    new Date()
  );
  const paidMonthsCount = monthlyPaymentStatuses.filter((item) => item.status === "paid").length;
  const unpaidMonthsCount = monthlyPaymentStatuses.filter((item) => item.status === "unpaid").length;
  const studentMonthlyWeeklyTable = useMemo(
    () =>
      buildMonthlyWeeklyPaymentTable(
        studentPaymentRows,
        transactions,
        studentPaymentMonthFilter,
        data.classInfo?.academic_year_name
      ),
    [studentPaymentRows, transactions, studentPaymentMonthFilter, data.classInfo?.academic_year_name]
  );
  const selectedMonthMeta = months.find((item) => item.value === studentPaymentMonthFilter) ?? months[0];
  const selectedMonthStatus = monthlyPaymentStatuses.find((item) => item.value === studentPaymentMonthFilter);
  const selectedMonthTotalPaid = studentMonthlyWeeklyTable.grandTotal;
  const studentFinanceChartSeries = [
    { key: "regularIncome", label: "Kas Dibayar", color: "green" },
    { key: "fine", label: "Denda Dibayar", color: "yellow" },
    { key: "expense", label: "Pengeluaran", color: "red" }
  ];

  return (
    <div className="app-shell" style={appShellStyle}>
      <div
        className={`sidebar-overlay ${sidebarOpen ? "show" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={`sidebar ${sidebarOpen ? "open" : ""}`}
        style={{ background: appSettings.sidebarColor }}
      >
        <div className="sidebar-header">
          <div className="sidebar-logo">
            {appSettings.logoImage ? (
              <img className="logo-image" src={appSettings.logoImage} alt={appSettings.appName} />
            ) : (
              <div className="logo-icon">
                <i className="fas fa-wallet" />
              </div>
            )}
            <div className="logo-text">{appSettings.appName}</div>
          </div>
          <div className="sidebar-role">
            <i className="fas fa-user-graduate" /> Siswa
          </div>
        </div>

        <nav className="sidebar-nav">
          {studentPageGroups.map((group) => (
            <div key={group.label}>
              <div className="nav-section-label">{group.label}</div>
              {group.items.map((page) => (
                <button
                  key={page.id}
                  className={`nav-item ${activePage === page.id ? "active" : ""}`}
                  onClick={() => {
                    setActivePage(page.id);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="nav-icon">
                    <i className={`fas ${page.icon}`} />
                  </span>
                  {page.title}
                  {page.id === "history" && <span className="badge badge-blue">{transactions.length}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user" onClick={() => setProfileModalOpen(true)}>
            <div className="user-avatar-sidebar">{renderUserAvatar(session.user)}</div>
            <div className="user-info">
              <div className="user-name">{session.user.fullName}</div>
              <div className="user-role-text">{data.classInfo?.name ?? session.user.email}</div>
            </div>
          </div>
                  <button className="btn btn-secondary sidebar-logout" onClick={handleLogout}>
                    <i className="fas fa-right-from-bracket" /> Keluar
                  </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="menu-toggle" onClick={() => setSidebarOpen((value) => !value)}>
              <i className="fas fa-bars" />
            </button>
            <div>
              <div className="page-title">{currentPage.title}</div>
              <div className="page-subtitle">
                {currentPage.subtitle}
                {data.classInfo?.name ? ` • ${data.classInfo.name}` : ""}
              </div>
            </div>
          </div>
        </header>

        <div className="page-content">
          {data.error && (
            <div className="panel">
              <div className="panel-body error-text">{data.error}</div>
            </div>
          )}

          <section className={`page-section ${activePage === "dashboard" ? "active" : ""}`}>
            <div className="stats-grid mobile-dashboard-stats">
              <StatCard color="orange" icon="fa-coins" value={formatCurrency(studentNominalKas)} label="Nominal Kas" />
              <StatCard color="yellow" icon="fa-file-invoice-dollar" value={formatCurrency(overview.paid_fine ?? 0)} label="Denda Dibayar" />
              <StatCard color="green" icon="fa-wallet" value={formatCurrency(overview.paid_cash ?? 0)} label="Kas Dibayar" />
              <StatCard color="blue" icon="fa-circle-check" value={statusLabel} label="Status Pembayaran" />
            </div>

            <div className="grid-3-1 treasurer-balance-grid">
              <div className="saldo-card treasurer-balance-card">
                <div className="saldo-label">Ringkasan Kas {data.classInfo?.name ?? "Siswa"}</div>
                <div className="saldo-amount">{formatCurrency(overview.paid_cash ?? 0)}</div>
                <div className="saldo-details">
                  <div className="saldo-detail-item">
                    <span className="saldo-detail-label">Nominal aktif</span>
                    <span className="saldo-detail-value">{formatCurrency(studentNominalKas)}</span>
                  </div>
                  <div className="saldo-detail-item">
                    <span className="saldo-detail-label">Total denda dibayar</span>
                    <span className="saldo-detail-value">{formatCurrency(overview.paid_fine ?? 0)}</span>
                  </div>
                  <div className="saldo-detail-item">
                    <span className="saldo-detail-label">Riwayat bayar</span>
                    <span className="saldo-detail-value">{overview.payment_count ?? 0}</span>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">Informasi Singkat</div>
                </div>
                <div className="panel-body">
                  <div className="treasurer-summary-list">
                    <div className="summary-row">
                      <span>Nama siswa</span>
                      <strong>{session.user.fullName}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Kelas</span>
                      <strong>{data.classInfo?.name ?? "-"}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Tahun ajaran</span>
                      <strong>{formatAcademicYearLabel(data.classInfo?.academic_year_name)}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Status</span>
                      <strong style={{ color: overview.status === "lunas" ? "var(--accent-deep)" : "var(--red)" }}>
                        {statusLabel}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <FinanceChart
              title="Diagram Keuangan Saya"
              rows={studentFinanceChartRows}
              series={studentFinanceChartSeries}
              period={financeChartPeriod}
              onPeriodChange={setFinanceChartPeriod}
            />
          </section>

          <section className={`page-section ${activePage === "payment-status" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Status Pembayaran Saya</div>
                <div className="panel-actions">
                  <select
                    className="form-select"
                    style={{ width: 180 }}
                    value={studentPaymentMonthFilter}
                    onChange={(event) => setStudentPaymentMonthFilter(event.target.value)}
                  >
                    {months.map((month) => (
                      <option key={`student-payment-month-${month.value}`} value={month.value}>
                        {month.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="panel-body">
                <div className="student-payment-status-layout">
                  <div className="student-payment-report-layout">
                    <div className="student-payment-report-heading">
                      <h2>STATUS PEMBAYARAN SAAT INI</h2>
                      <strong>{statusLabel}</strong>
                      <p>TA {formatAcademicYearLabel(data.classInfo?.academic_year_name)} · {data.classInfo?.name ?? "-"}</p>
                    </div>

                    <div className="student-payment-report-stats">
                      <SimpleStat value={formatCurrency(studentNominalKas)} label="Nominal kas" />
                      <SimpleStat value={formatCurrency(selectedMonthTotalPaid)} label="Total dibayar bulan ini" />
                      <SimpleStat value={`${paidMonthsCount} bulan`} label="Bulan lunas" />
                      <SimpleStat value={`${unpaidMonthsCount} bulan`} label="Belum bayar" />
                    </div>
                  </div>

                  <div className="student-payment-months-card">
                    <div className="student-payment-months-head">
                      <div>
                        <div className="student-payment-months-title">Status {selectedMonthMeta.label}</div>
                      </div>
                    </div>

                    <div className="table-wrapper student-payment-monthly-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Nama Siswa</th>
                            <th>Minggu 1</th>
                            <th>Minggu 2</th>
                            <th>Minggu 3</th>
                            <th>Minggu 4</th>
                            <th>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {studentMonthlyWeeklyTable.rows.length === 0 ? (
                            <tr>
                              <td colSpan="6">
                                <div className="empty-row">Belum ada data pembayaran.</div>
                              </td>
                            </tr>
                          ) : (
                            studentMonthlyWeeklyTable.rows.map((row) => (
                              <tr key={`student-monthly-${row.student.id}`}>
                                <td data-label="Nama Siswa">
                                  <div style={{ fontWeight: 800, color: "var(--fg)" }}>{row.student.fullName}</div>
                                  <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                                    {selectedMonthMeta.label} {selectedMonthStatus?.year ?? new Date().getFullYear()}
                                  </div>
                                </td>
                                {row.weeks.map((amount, index) => (
                                  <td data-label={`Minggu ${index + 1}`} key={`student-monthly-week-${index + 1}`}>
                                    {amount > 0 ? (
                                      <span style={{ color: "var(--accent-deep)", fontWeight: 800 }}>
                                        {formatCurrency(amount)}
                                      </span>
                                    ) : (
                                      <span style={{ color: "var(--orange)", fontWeight: 800 }}>Belum bayar</span>
                                    )}
                                  </td>
                                ))}
                                <td data-label="Total" style={{ color: "var(--accent-deep)", fontWeight: 900 }}>
                                  {row.total > 0 ? formatCurrency(row.total) : "Rp0"}
                                </td>
                              </tr>
                            ))
                          )}
                          {studentMonthlyWeeklyTable.rows.length > 0 ? (
                            <tr className="student-payment-summary-row" style={{ background: "var(--bg-subtle)" }}>
                              <td data-label="Ringkasan" style={{ fontWeight: 900 }}>Status bulan</td>
                              {studentMonthlyWeeklyTable.totals.map((amount, index) => (
                                <td data-label={`Minggu ${index + 1}`} key={`student-monthly-total-${index + 1}`} style={{ fontWeight: 900 }}>
                                  {amount > 0 ? (
                                    <span style={{ color: "var(--accent-deep)" }}>Sudah</span>
                                  ) : (
                                    <span style={{ color: "var(--orange)" }}>Belum</span>
                                  )}
                                </td>
                              ))}
                              <td data-label="Total" style={{ fontWeight: 900, color: "var(--fg-primary)" }}>
                                {formatCurrency(studentMonthlyWeeklyTable.grandTotal)}
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "history" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Riwayat Pembayaran Saya</div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Tanggal</th>
                        <th>Judul</th>
                        <th>Keterangan</th>
                        <th>Jumlah</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.length === 0 ? (
                        <tr>
                          <td colSpan="5">
                            <div className="empty-row">Belum ada riwayat pembayaran.</div>
                          </td>
                        </tr>
                      ) : (
                        historyPagination.rows.map((item) => (
                          <tr key={item.id}>
                            <td>{formatDateLabel(item.created_at)}</td>
                            <td>{item.title}</td>
                            <td>{item.category === "Denda" ? `Denda • ${item.note || item.title}` : item.note || "-"}</td>
                            <td style={{ color: "var(--accent-deep)", fontWeight: 800 }}>
                              +{formatCurrency(item.amount)}
                            </td>
                            <td>
                              <span className="status status-lunas">
                                <span className="status-dot" /> Tercatat
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <PaginationControls page={historyPagination.page} totalPages={historyPagination.totalPages} onChange={setHistoryPage} />
            </div>
          </section>

          <section className={`page-section ${activePage === "announcements" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Pengumuman & Informasi Kas</div>
              </div>
              <div className="panel-body compact-list">
                {data.announcements.length === 0 ? (
                  <div className="empty-state">
                    <i className="fas fa-bullhorn" />
                    <p>Belum ada informasi kas.</p>
                  </div>
                ) : (
                  data.announcements.map((item, index) => (
                    <div className="transaction-item" key={item.id ?? index}>
                      <div className="transaction-icon income">
                        <i className="fas fa-bullhorn" />
                      </div>
                      <div className="transaction-info">
                        <div className="transaction-desc">{item.title}</div>
                        <div className="transaction-meta">{item.body}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      </main>

      {profileModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card">
            <div className="modal-header">
              <h3>Edit Profil Siswa</h3>
              <button className="modal-close" onClick={() => setProfileModalOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveStudentProfile}>
              <div className="profile-photo-editor">
                <div className="profile-photo-large">
                  {profileForm.profilePhoto ? (
                    <img className="user-photo large" src={profileForm.profilePhoto} alt={profileForm.fullName} />
                  ) : (
                    getInitials(profileForm.fullName)
                  )}
                </div>
                <div className="profile-photo-actions">
                  <label className="btn btn-secondary profile-upload-btn">
                    <input type="file" accept="image/*" hidden onChange={handleStudentProfilePhotoChange} />
                    <i className="fas fa-image" /> Ganti Foto
                  </label>
                </div>
              </div>

              {profileForm.profilePhoto && (
                <div className="upload-preview-card profile-preview-card">
                  <button
                    type="button"
                    className="upload-remove-btn"
                    onClick={() =>
                      setProfileForm((current) => ({
                        ...current,
                        profilePhoto: "",
                        profilePhotoOriginal: ""
                      }))
                    }
                  >
                    <i className="fas fa-xmark" />
                  </button>
                  <button
                    type="button"
                    className="upload-preview-image-button"
                    onClick={() =>
                      openStudentCropper({
                        target: "studentProfilePhoto",
                        title: "Crop Foto Profil Siswa",
                        source: profileForm.profilePhotoOriginal || profileForm.profilePhoto,
                        aspect: "square",
                        originalSource: profileForm.profilePhotoOriginal || profileForm.profilePhoto
                      })
                    }
                  >
                    <img
                      src={profileForm.profilePhoto}
                      alt="Preview foto profil siswa"
                      className="upload-preview-image square"
                    />
                  </button>
                  <div className="upload-preview-text">Preview foto profil sebelum disimpan</div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Nama Lengkap</label>
                <input
                  className="form-input"
                  value={profileForm.fullName}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, fullName: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={profileForm.email}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, email: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Password Baru</label>
                <PasswordField
                  placeholder="Kosongkan jika tidak diganti"
                  value={profileForm.password}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, password: event.target.value }))
                  }
                  autoComplete="new-password"
                />
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setProfileModalOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Profil
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {cropperOpen && (
        <div className="modal-overlay show">
          <div className="modal-card cropper-modal">
            <div className="modal-header">
              <h3>{cropperState.title}</h3>
              <button className="modal-close" onClick={() => setCropperOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div
                className={`cropper-viewport ${cropperState.aspect === "landscape" ? "landscape" : "square"} ${
                  cropDragging ? "dragging" : ""
                }`}
                style={{
                  width: cropperState.viewportWidth,
                  height: cropperState.viewportHeight
                }}
                onPointerDown={handleCropPointerDown}
                onPointerMove={handleCropPointerMove}
                onPointerUp={handleCropPointerUp}
                onPointerCancel={handleCropPointerUp}
                onPointerLeave={handleCropPointerUp}
              >
                <img
                  src={cropperState.source}
                  alt="Crop source"
                  className="cropper-image"
                  style={{
                    width: cropperState.imageWidth * cropperState.zoom,
                    height: cropperState.imageHeight * cropperState.zoom,
                    left:
                      (cropperState.viewportWidth - cropperState.imageWidth * cropperState.zoom) / 2 +
                      cropperState.panX,
                    top:
                      (cropperState.viewportHeight - cropperState.imageHeight * cropperState.zoom) / 2 +
                      cropperState.panY
                  }}
                />
              </div>

              <div className="cropper-controls">
                <div className="form-group">
                  <label className="form-label">Zoom</label>
                  <input
                    className="cropper-range"
                    type="range"
                    min={cropperState.minZoom}
                    max={cropperState.minZoom * 3}
                    step="0.01"
                    value={cropperState.zoom}
                    onChange={(event) =>
                      setCropperState((current) =>
                        clampCropState({
                          ...current,
                          zoom: Number(event.target.value)
                        })
                      )
                    }
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setCropperOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="button" onClick={handleApplyCrop}>
                  <i className="fas fa-crop-simple" /> Pakai Crop
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-container">
          <div className={`toast ${toast.type}`}>
            <div className="toast-icon">
              <i className={`fas ${toast.type === "error" ? "fa-xmark" : "fa-check"}`} />
            </div>
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TreasurerPanel({ session, setSession, handleLogout, activePage, setActivePage, appSettings }) {
  const [historyPage, setHistoryPage] = useState(1);
  const isHomeroom = session.auth?.role === "walikelas";
  const roleLabel = isHomeroom ? "Wali Kelas" : "Bendahara";
  const pageGroupsForRole = isHomeroom ? homeroomPageGroups : treasurerPageGroups;
  const overviewEndpoint = isHomeroom ? "/api/homeroom/overview" : "/api/treasurer/overview";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [studentModalOpen, setStudentModalOpen] = useState(false);
  const [editingClassAccount, setEditingClassAccount] = useState(null);
  const [cropperOpen, setCropperOpen] = useState(false);
  const [cropperState, setCropperState] = useState({
    target: null,
    title: "",
    source: "",
    aspect: "square",
    viewportWidth: 280,
    viewportHeight: 280,
    outputWidth: 512,
    outputHeight: 512,
    imageWidth: 0,
    imageHeight: 0,
    zoom: 1,
    minZoom: 1,
    panX: 0,
    panY: 0,
    originalSource: ""
  });
  const [cropDragging, setCropDragging] = useState(false);
  const cropDragRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0
  });
  const [data, setData] = useState({
    loading: false,
    error: "",
    overview: null,
    classInfo: null,
    settings: null,
    students: [],
    transactions: [],
    fineTypes: []
  });
  const [studentSearch, setStudentSearch] = useState("");
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [fineTypeModalOpen, setFineTypeModalOpen] = useState(false);
  const [paymentCategoryFilter, setPaymentCategoryFilter] = useState("kas");
  const [fineViewMode, setFineViewMode] = useState("payments");
  const [financeChartPeriod, setFinanceChartPeriod] = useState("week");
  const [paymentMonthFilter, setPaymentMonthFilter] = useState(String(new Date().getMonth() + 1).padStart(2, "0"));
  const [fineTypeForm, setFineTypeForm] = useState({
    title: "",
    amount: ""
  });
  const [profileForm, setProfileForm] = useState({
    fullName: session.user.fullName ?? "",
    email: session.user.email ?? "",
    password: "",
    profilePhoto: session.user.profilePhoto ?? "",
    profilePhotoOriginal: session.user.profilePhotoOriginal ?? session.user.profilePhoto ?? ""
  });
  const [studentForm, setStudentForm] = useState({
    role: "siswa",
    fullName: "",
    nis: "",
    email: "",
    password: "",
    profilePhoto: "",
    profilePhotoOriginal: ""
  });
  const [studentFormErrors, setStudentFormErrors] = useState({});
  const [paymentForm, setPaymentForm] = useState({
    studentId: "",
    amount: "",
    fineAmount: "",
    fineReason: "",
    title: ""
  });
  const [expenseForm, setExpenseForm] = useState({
    title: "",
    amount: "",
    category: "Lainnya",
    note: ""
  });
  const [reportFilters, setReportFilters] = useState({
    month: String(new Date().getMonth() + 1).padStart(2, "0"),
    year: String(new Date().getFullYear())
  });
  const [reportGenerated, setReportGenerated] = useState(false);

  const allPages = pageGroupsForRole.flatMap((group) => group.items);
  const currentPage = allPages.find((item) => item.id === activePage) ?? allPages[0];

  const appShellStyle =
    appSettings.backgroundMode === "image" && appSettings.backgroundImage
        ? {
          backgroundImage: `linear-gradient(rgba(252, 253, 253, 0.9), rgba(252, 253, 253, 0.92)), url(${appSettings.backgroundImage})`,
          backgroundSize: "100% auto",
          backgroundPosition: "top center",
          backgroundRepeat: "no-repeat",
          backgroundAttachment: "fixed"
        }
      : {
          background: appSettings.backgroundColor
        };

  function showToast(message, type = "success") {
    setToast({ message, type, id: Date.now() });
    window.setTimeout(() => setToast(null), 2600);
  }

  function updateStudentFormField(field, value) {
    setStudentForm((current) => ({ ...current, [field]: value }));
    setStudentFormErrors((current) => {
      if (!current[field]) {
        return current;
      }

      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function openTreasurerCropper({ target, title, source, aspect = "square", originalSource = "" }) {
    try {
      const image = await loadImage(source);
      const dimensions = getCropperDimensions(aspect);
      const minZoom = Math.max(
        dimensions.viewportWidth / image.width,
        dimensions.viewportHeight / image.height
      );

      setCropperState({
        target,
        title,
        source,
        aspect,
        viewportWidth: dimensions.viewportWidth,
        viewportHeight: dimensions.viewportHeight,
        outputWidth: dimensions.outputWidth,
        outputHeight: dimensions.outputHeight,
        imageWidth: image.width,
        imageHeight: image.height,
        zoom: minZoom,
        minZoom,
        panX: 0,
        panY: 0,
        originalSource: originalSource || source
      });
      setCropperOpen(true);
    } catch (error) {
      showToast(error.message || "Gagal membuka crop gambar.", "error");
    }
  }

  async function openTreasurerCropperFromFile({ target, title, file, aspect = "square", originalSource = false }) {
    const source = await readImageFile(file);
    await openTreasurerCropper({ target, title, source, aspect, originalSource: originalSource ? source : "" });
  }

  function handleCropPointerDown(event) {
    if (!cropperOpen) {
      return;
    }

    event.preventDefault();
    cropDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: cropperState.panX,
      startPanY: cropperState.panY
    };
    setCropDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleCropPointerMove(event) {
    if (!cropDragging || cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - cropDragRef.current.startX;
    const deltaY = event.clientY - cropDragRef.current.startY;

    setCropperState((current) =>
      clampCropState({
        ...current,
        panX: cropDragRef.current.startPanX + deltaX,
        panY: cropDragRef.current.startPanY + deltaY
      })
    );
  }

  function handleCropPointerUp(event) {
    if (cropDragRef.current.pointerId !== event.pointerId) {
      return;
    }

    setCropDragging(false);
    cropDragRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      startPanX: 0,
      startPanY: 0
    };
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  useEffect(() => {
    setProfileForm({
      fullName: session.user.fullName ?? "",
      email: session.user.email ?? "",
      password: "",
      profilePhoto: session.user.profilePhoto ?? "",
      profilePhotoOriginal: session.user.profilePhotoOriginal ?? session.user.profilePhoto ?? ""
    });
  }, [session.user]);

  useEffect(() => {
    if (!allPages.some((item) => item.id === activePage)) {
      setActivePage("dashboard");
    }
  }, [activePage, allPages, setActivePage]);

  async function apiFetchTreasurer(path, options = {}) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-user-role": session.auth.role,
        "x-user-id": String(session.auth.userId),
        "x-session-token": session.auth.sessionToken ?? "",
        ...(options.headers ?? {})
      }
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Permintaan gagal.");
    }

    return result;
  }

  async function loadTreasurerData() {
    setData((current) => ({ ...current, loading: true, error: "" }));

    try {
      const result = await apiFetchTreasurer(overviewEndpoint);
      setData({
        loading: false,
        error: "",
        overview: result.overview,
        classInfo: result.classInfo,
        settings: result.settings,
        students: result.students,
        transactions: result.transactions,
        fineTypes: result.fineTypes ?? []
      });
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: error.message }));
    }
  }

  useEffect(() => {
    loadTreasurerData();
  }, []);

  useEffect(() => {
    const refreshTreasurerData = () => {
      if (document.visibilityState === "visible") {
        loadTreasurerData();
      }
    };

    const intervalId = window.setInterval(refreshTreasurerData, 3000);
    window.addEventListener("focus", refreshTreasurerData);
    document.addEventListener("visibilitychange", refreshTreasurerData);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshTreasurerData);
      document.removeEventListener("visibilitychange", refreshTreasurerData);
    };
  }, []);

  async function handleSavePayment(event) {
    event.preventDefault();

    try {
      await apiFetchTreasurer("/api/treasurer/payments", {
        method: "POST",
        body: JSON.stringify({
          studentId: Number(paymentForm.studentId),
          amount: Number(paymentForm.amount),
          fineAmount: Number(paymentForm.fineAmount),
          fineReason: paymentForm.fineReason,
          title: paymentForm.title
        })
      });
      setPaymentForm({ studentId: "", amount: "", fineAmount: "", fineReason: "", title: "" });
      setPaymentModalOpen(false);
      await loadTreasurerData();
      showToast("Pembayaran kas berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan pembayaran kas.", "error");
    }
  }

  async function handleSaveFineType(event) {
    event.preventDefault();

    try {
      await apiFetchTreasurer("/api/class-fine-types", {
        method: "POST",
        body: JSON.stringify({
          title: fineTypeForm.title,
          amount: Number(fineTypeForm.amount) || 0
        })
      });

      setFineTypeForm({ title: "", amount: "" });
      setFineTypeModalOpen(false);
      await loadTreasurerData();
      showToast("Jenis denda berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan jenis denda.", "error");
    }
  }

  async function handleSaveExpense(event) {
    event.preventDefault();

    try {
      await apiFetchTreasurer("/api/treasurer/expenses", {
        method: "POST",
        body: JSON.stringify({
          title: expenseForm.title,
          amount: Number(expenseForm.amount),
          category: expenseForm.category,
          note: expenseForm.note
        })
      });
      setExpenseForm({ title: "", amount: "", category: "Lainnya", note: "" });
      setExpenseModalOpen(false);
      await loadTreasurerData();
      showToast("Pengeluaran berhasil disimpan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan pengeluaran.", "error");
    }
  }

  async function handleTreasurerProfilePhotoChange(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      await openTreasurerCropperFromFile({
        target: "treasurerProfilePhoto",
        title: `Crop Foto Profil ${roleLabel}`,
        file,
        aspect: "square",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses foto profil.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleStudentPhotoChange(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      await openTreasurerCropperFromFile({
        target: "treasurerStudentPhoto",
        title: "Crop Foto Siswa",
        file,
        aspect: "square",
        originalSource: true
      });
    } catch (error) {
      showToast(error.message || "Gagal memproses foto siswa.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function handleApplyCrop() {
    try {
      const image = await loadImage(cropperState.source);
      const canvas = document.createElement("canvas");
      canvas.width = cropperState.outputWidth;
      canvas.height = cropperState.outputHeight;
      const context = canvas.getContext("2d");

      const renderedWidth = image.width * cropperState.zoom;
      const renderedHeight = image.height * cropperState.zoom;
      const left = (cropperState.viewportWidth - renderedWidth) / 2 + cropperState.panX;
      const top = (cropperState.viewportHeight - renderedHeight) / 2 + cropperState.panY;
      const srcX = Math.max(0, (0 - left) / cropperState.zoom);
      const srcY = Math.max(0, (0 - top) / cropperState.zoom);
      const srcWidth = Math.min(image.width, cropperState.viewportWidth / cropperState.zoom);
      const srcHeight = Math.min(image.height, cropperState.viewportHeight / cropperState.zoom);
      const resultState = clampCropState(cropperState);

      context.drawImage(
        image,
        srcX,
        srcY,
        srcWidth,
        srcHeight,
        0,
        0,
        canvas.width,
        canvas.height
      );

      const result = canvas.toDataURL("image/png");

      if (resultState.target === "treasurerProfilePhoto") {
        setProfileForm((current) => ({
          ...current,
          profilePhoto: result,
          profilePhotoOriginal: cropperState.originalSource || current.profilePhotoOriginal || cropperState.source
        }));
      } else if (resultState.target === "treasurerStudentPhoto") {
        setStudentForm((current) => ({
          ...current,
          profilePhoto: result,
          profilePhotoOriginal: cropperState.originalSource || current.profilePhotoOriginal || cropperState.source
        }));
      }

      setCropperOpen(false);
    } catch (error) {
      showToast(error.message || "Gagal menerapkan crop gambar.", "error");
    }
  }

  async function handleSaveTreasurerProfile(event) {
    event.preventDefault();

    try {
      const result = await apiFetchTreasurer("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: profileForm.fullName,
          email: profileForm.email,
          password: profileForm.password,
          profilePhoto: profileForm.profilePhoto,
          profilePhotoOriginal: profileForm.profilePhotoOriginal || profileForm.profilePhoto
        })
      });

      setSession((current) => ({
        ...current,
        user: result.user
      }));
      setProfileForm((current) => ({
        ...current,
        password: ""
      }));
      setProfileModalOpen(false);
      showToast(`Profil ${roleLabel.toLowerCase()} berhasil disimpan.`);
    } catch (error) {
      showToast(error.message || `Gagal menyimpan profil ${roleLabel.toLowerCase()}.`, "error");
    }
  }

async function handleSaveStudent(event) {
  event.preventDefault();

  try {
    const errors = validateUserAccountForm(studentForm, { editing: Boolean(editingClassAccount) });
    setStudentFormErrors(errors);

    if (Object.keys(errors).length > 0) {
      showToast("Periksa lagi data akun yang wajib diisi.", "error");
      return;
    }

    const studentCreateEndpoint = isHomeroom ? "/api/homeroom/students" : "/api/treasurer/students";
    const endpoint = editingClassAccount ? `/api/class-accounts/${editingClassAccount.id}` : studentCreateEndpoint;

    await apiFetchTreasurer(endpoint, {
      method: editingClassAccount ? "PATCH" : "POST",
      body: JSON.stringify({
        fullName: studentForm.fullName.trim().replace(/\s+/g, " "),
        role: studentForm.role,
        nis: studentForm.nis.trim(),
        email: studentForm.email.trim(),
        password: studentForm.password.trim(),
        profilePhoto: studentForm.profilePhoto,
        profilePhotoOriginal: studentForm.profilePhotoOriginal || studentForm.profilePhoto,
        isActive: studentForm.isActive
      })
    });

      setStudentForm({
        role: "siswa",
        fullName: "",
        nis: "",
        email: "",
        password: "",
        profilePhoto: "",
        profilePhotoOriginal: "",
        isActive: true
      });
      setStudentFormErrors({});
      setEditingClassAccount(null);
      setStudentModalOpen(false);
      await loadTreasurerData();
      showToast(editingClassAccount ? "Akun berhasil diperbarui." : studentForm.role === "bendahara" ? "Akun bendahara berhasil ditambahkan." : "Siswa berhasil ditambahkan.");
    } catch (error) {
      showToast(error.message || "Gagal menyimpan akun.", "error");
    }
  }

  function handleOpenAddClassAccount() {
    setEditingClassAccount(null);
    setStudentFormErrors({});
    setStudentForm({
      role: "siswa",
      fullName: "",
      nis: "",
      email: "",
      password: "",
      profilePhoto: "",
      profilePhotoOriginal: "",
      isActive: true
    });
    setStudentModalOpen(true);
  }

  function handleOpenEditClassAccount(account) {
    setEditingClassAccount(account);
    setStudentFormErrors({});
    setStudentForm({
      role: account.role ?? "siswa",
      fullName: account.fullName ?? "",
      nis: account.nis ?? "",
      email: account.email ?? "",
      password: "",
      profilePhoto: account.profilePhoto ?? "",
      profilePhotoOriginal: account.profilePhotoOriginal ?? account.profilePhoto ?? "",
      isActive: account.isActive ?? true
    });
    setStudentModalOpen(true);
  }

  const nominalKas = Number(data.classInfo?.nominal_kas ?? 0);
  const students = data.students ?? [];
  const transactions = data.transactions ?? [];
  const fineTypes = data.fineTypes ?? [];
  const incomeRows = transactions.filter(
    (item) => item.type === "income" && String(item.category ?? "").toLowerCase() !== "denda"
  );
  const fineRows = transactions.filter(
    (item) => item.type === "income" && String(item.category ?? "").toLowerCase() === "denda"
  );
  const filteredFineRows = fineRows.filter((item) => {
    const createdAt = new Date(item.created_at);
    return String(createdAt.getMonth() + 1).padStart(2, "0") === paymentMonthFilter;
  });
  const paymentRows = transactions
    .filter((item) => {
      if (item.type !== "income") {
        return false;
      }

      const isFine = String(item.category ?? "").toLowerCase() === "denda";

      if (paymentCategoryFilter === "kas") {
        return !isFine;
      }

      if (paymentCategoryFilter === "denda") {
        return isFine;
      }

      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id - a.id);
  const expenseRows = transactions.filter((item) => item.type === "expense");
  const historyPagination = paginateItems(transactions, historyPage, 10);
  const classFinanceChartRows = buildFinanceChartRows(transactions, financeChartPeriod);
  const classFinanceChartSeries = [
    { key: "regularIncome", label: "Pemasukan Kas", color: "green" },
    { key: "fine", label: "Denda Masuk", color: "yellow" },
    { key: "expense", label: "Pengeluaran", color: "red" }
  ];
  const weeklyPaymentMatrix = useMemo(
    () =>
      buildMonthlyWeeklyPaymentTable(
        students,
        transactions,
        paymentMonthFilter,
        data.classInfo?.academic_year_name
      ),
    [students, transactions, paymentMonthFilter, data.classInfo?.academic_year_name]
  );
  const filteredStudents = students.filter((item) => {
    const search = studentSearch.trim().toLowerCase();
    return (
      search === "" ||
      item.fullName.toLowerCase().includes(search) ||
      item.email.toLowerCase().includes(search) ||
      String(item.nis ?? "").toLowerCase().includes(search) ||
      String(item.role ?? "").toLowerCase().includes(search)
    );
  });
  const getTransactionStudentName = (transaction) => {
    const directName = transaction.student_name ?? transaction.studentName;
    if (directName) {
      return directName;
    }

    const studentId = transaction.student_id ?? transaction.studentId;
    const student = students.find((item) => Number(item.id) === Number(studentId));
    if (student?.fullName) {
      return student.fullName;
    }

    const titleMatch = String(transaction.title ?? "").match(/(?:Pembayaran kas|Pembayaran denda)\s+(.+)/i);
    return titleMatch?.[1]?.trim() || "-";
  };
  const reportYearOptions = [
    ...new Set(
      transactions.map((item) => new Date(item.created_at).getFullYear().toString())
    )
  ];

  const generatedReport = useMemo(() => {
    if (!reportGenerated) {
      return null;
    }

    const filtered = transactions.filter((item) => {
      const date = new Date(item.created_at);
      return (
        String(date.getMonth() + 1).padStart(2, "0") === reportFilters.month &&
        String(date.getFullYear()) === reportFilters.year
      );
    });

    const income = filtered
      .filter((item) => item.type === "income" && String(item.category ?? "").toLowerCase() !== "denda")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const fine = filtered
      .filter((item) => item.type === "income" && String(item.category ?? "").toLowerCase() === "denda")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const expense = filtered
      .filter((item) => item.type === "expense")
      .reduce((sum, item) => sum + Number(item.amount ?? 0), 0);

    return {
      income,
      fine,
      expense,
      balance: income + fine - expense,
      rows: filtered
    };
  }, [reportFilters, reportGenerated, transactions]);

  const getReportStudentName = (item) => {
    if (item.student_name || item.studentName) {
      return item.student_name || item.studentName;
    }

    return item.type === "income" ? "Tanpa nama" : "-";
  };

  function handleExportTreasurerExcel() {
    if (!generatedReport) {
      showToast("Tampilkan laporan dulu sebelum export Excel.", "error");
      return;
    }

    const rows = [
      ["Ringkasan Laporan"],
      ["Pemasukan", Number(generatedReport.income ?? 0)],
      ["Denda", Number(generatedReport.fine ?? 0)],
      ["Pengeluaran", Number(generatedReport.expense ?? 0)],
      ["Saldo", Number(generatedReport.balance ?? 0)],
      [],
      ["Tanggal", "Nama Siswa", "Jenis", "Keterangan", "Jumlah"],
      ...generatedReport.rows.map((item) => [
        formatDateLabel(item.created_at),
        getReportStudentName(item),
        item.type === "income" ? "Pemasukan" : "Pengeluaran",
        item.note || item.title,
        `${item.type === "income" ? "+" : "-"}${Number(item.amount ?? 0)}`
      ])
    ];

    const csv = rows
      .map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `laporan-${isHomeroom ? "wali-kelas" : "bendahara"}-${data.classInfo?.name ?? "kelas"}-${reportFilters.year}-${reportFilters.month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("Laporan Excel berhasil diunduh.");
  }

  function handleExportTreasurerPdf() {
    if (!generatedReport) {
      showToast("Tampilkan laporan dulu sebelum export PDF.", "error");
      return;
    }

    const document = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4"
    });

    autoTable(document, {
      startY: 40,
      theme: "grid",
      head: [["Pemasukan", "Denda", "Pengeluaran", "Saldo"]],
      body: [[
        formatCurrency(generatedReport.income),
        formatCurrency(generatedReport.fine),
        formatCurrency(generatedReport.expense),
        formatCurrency(generatedReport.balance)
      ]],
      styles: { fontSize: 10, cellPadding: 8, halign: "center" },
      headStyles: { fillColor: [16, 185, 129] },
      bodyStyles: { fontStyle: "bold" }
    });

    autoTable(document, {
      startY: document.lastAutoTable.finalY + 18,
      theme: "grid",
      head: [["Tanggal", "Nama Siswa", "Jenis", "Keterangan", "Jumlah"]],
      body: generatedReport.rows.length
        ? generatedReport.rows.map((item) => [
            formatDateLabel(item.created_at),
            getReportStudentName(item),
            item.type === "income" ? "Pemasukan" : "Pengeluaran",
            item.note || item.title,
            `${item.type === "income" ? "+" : "-"}${formatCurrency(item.amount)}`
          ])
        : [["-", "-", "-", "Tidak ada transaksi pada periode ini.", "-"]],
      styles: { fontSize: 10, cellPadding: 8 },
      headStyles: { fillColor: [59, 130, 246] },
      didParseCell: (hook) => {
        if (hook.section !== "body" || hook.column.index !== 4) {
          return;
        }

        const text = String(hook.cell.raw ?? "");
        if (text.startsWith("+")) {
          hook.cell.styles.textColor = [5, 150, 105];
          hook.cell.styles.fontStyle = "bold";
        } else if (text.startsWith("-")) {
          hook.cell.styles.textColor = [220, 38, 38];
          hook.cell.styles.fontStyle = "bold";
        }
      }
    });

    document.save(
      `laporan-${isHomeroom ? "wali-kelas" : "bendahara"}-${slugifyFilePart(data.classInfo?.name ?? "kelas")}-${slugifyFilePart(reportFilters.year)}-${slugifyFilePart(reportFilters.month)}.pdf`
    );
    showToast("Laporan PDF berhasil diunduh.");
  }

  function handlePrintTreasurerReport() {
    if (!generatedReport) {
      showToast("Tampilkan laporan dulu sebelum mencetak.", "error");
      return;
    }

    const reportTitle = `Laporan Kas ${data.classInfo?.name ?? "Kelas"}`;
    const printMarkup = `
      <html>
        <head>
          <title>${reportTitle}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #1f2937; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #e5e7eb; padding: 10px 12px; text-align: left; font-size: 14px; }
            th { background: #f9fafb; text-transform: uppercase; font-size: 12px; letter-spacing: .06em; color: #6b7280; }
            .plus { color: #059669; font-weight: 700; }
            .minus { color: #dc2626; font-weight: 700; }
            .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
            .summary-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; }
            .summary-label { color: #6b7280; font-size: 12px; font-weight: 700; margin-bottom: 6px; }
            .summary-value { font-size: 18px; font-weight: 800; }
          </style>
        </head>
        <body>
          <div class="summary">
            <div class="summary-card">
              <div class="summary-label">Pemasukan</div>
              <div class="summary-value plus">${formatCurrency(generatedReport.income)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Denda</div>
              <div class="summary-value plus">${formatCurrency(generatedReport.fine)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Pengeluaran</div>
              <div class="summary-value minus">${formatCurrency(generatedReport.expense)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">Saldo</div>
              <div class="summary-value plus">${formatCurrency(generatedReport.balance)}</div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Tanggal</th>
                <th>Nama Siswa</th>
                <th>Jenis</th>
                <th>Keterangan</th>
                <th>Jumlah</th>
              </tr>
            </thead>
            <tbody>
              ${
                generatedReport.rows.length
                  ? generatedReport.rows
                      .map(
                        (item) => `
                          <tr>
                            <td>${formatDateLabel(item.created_at)}</td>
                            <td>${getReportStudentName(item)}</td>
                            <td>${item.type === "income" ? "Pemasukan" : "Pengeluaran"}</td>
                            <td>${item.note || item.title}</td>
                            <td class="${item.type === "income" ? "plus" : "minus"}">${item.type === "income" ? "+" : "-"}${formatCurrency(item.amount)}</td>
                          </tr>
                        `
                      )
                      .join("")
                  : `<tr><td colspan="5">Tidak ada transaksi pada periode ini.</td></tr>`
              }
            </tbody>
          </table>
        </body>
      </html>
    `;

    const printFrame = document.createElement("iframe");
    printFrame.setAttribute("aria-hidden", "true");
    printFrame.style.position = "fixed";
    printFrame.style.right = "0";
    printFrame.style.bottom = "0";
    printFrame.style.width = "0";
    printFrame.style.height = "0";
    printFrame.style.border = "0";
    printFrame.style.opacity = "0";
    printFrame.style.pointerEvents = "none";

    const cleanupPrintFrame = () => {
      window.removeEventListener("afterprint", cleanupPrintFrame);
      if (printFrame.parentNode) {
        printFrame.parentNode.removeChild(printFrame);
      }
    };

    window.addEventListener("afterprint", cleanupPrintFrame, { once: true });
    document.body.appendChild(printFrame);

    const frameDocument = printFrame.contentWindow?.document;

    if (!frameDocument || !printFrame.contentWindow) {
      cleanupPrintFrame();
      showToast("Gagal menyiapkan halaman cetak.", "error");
      return;
    }

    frameDocument.open();
    frameDocument.write(printMarkup);
    frameDocument.close();

    const triggerPrint = () => {
      try {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
      } catch {
        cleanupPrintFrame();
        showToast("Gagal membuka dialog cetak.", "error");
        return;
      }

      window.setTimeout(cleanupPrintFrame, 1000);
    };

    if (printFrame.contentWindow.document.readyState === "complete") {
      window.setTimeout(triggerPrint, 150);
    } else {
      printFrame.onload = () => window.setTimeout(triggerPrint, 150);
    }

    showToast("Dialog cetak dibuka.");
  }

  return (
    <div className="app-shell" style={appShellStyle}>
      <div
        className={`sidebar-overlay ${sidebarOpen ? "show" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={`sidebar ${sidebarOpen ? "open" : ""}`}
        style={{ background: appSettings.sidebarColor }}
      >
        <div className="sidebar-header">
          <div className="sidebar-logo">
            {appSettings.logoImage ? (
              <img className="logo-image" src={appSettings.logoImage} alt={appSettings.appName} />
            ) : (
              <div className="logo-icon">
                <i className="fas fa-wallet" />
              </div>
            )}
            <div className="logo-text">{appSettings.appName}</div>
          </div>
          <div className="sidebar-role">
            <i className={`fas ${isHomeroom ? "fa-chalkboard-user" : "fa-user-shield"}`} /> {roleLabel}
          </div>
        </div>

        <nav className="sidebar-nav">
          {pageGroupsForRole.map((group) => (
            <div key={group.label}>
              <div className="nav-section-label">{group.label}</div>
              {group.items.map((page) => (
                <button
                  key={page.id}
                  className={`nav-item ${activePage === page.id ? "active" : ""}`}
                  onClick={() => {
                    setActivePage(page.id);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="nav-icon">
                    <i className={`fas ${page.icon}`} />
                  </span>
                  {page.title}
                  {page.id === "students" && <span className="badge badge-blue">{students.length}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user" onClick={() => setProfileModalOpen(true)}>
            <div className="user-avatar-sidebar">{renderUserAvatar(session.user)}</div>
            <div className="user-info">
              <div className="user-name">{session.user.fullName}</div>
              <div className="user-role-text">{data.classInfo?.name ?? session.user.email}</div>
            </div>
          </div>
          <button className="btn btn-secondary sidebar-logout" onClick={handleLogout}>
            <i className="fas fa-right-from-bracket" /> Keluar
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="menu-toggle" onClick={() => setSidebarOpen((value) => !value)}>
              <i className="fas fa-bars" />
            </button>
            <div>
              <div className="page-title">{currentPage.title}</div>
              <div className="page-subtitle">
                {currentPage.subtitle}
                {data.classInfo?.name ? ` • ${data.classInfo.name}` : ""}
              </div>
            </div>
          </div>
        </header>

        <div className="page-content">
          {data.error && (
            <div className="panel">
              <div className="panel-body error-text">{data.error}</div>
            </div>
          )}

          <section className={`page-section ${activePage === "dashboard" ? "active" : ""}`}>
            <div className="stats-grid mobile-dashboard-stats">
              <StatCard color="blue" icon="fa-user-group" value={data.overview?.total_students ?? 0} label="Jumlah Siswa" />
              <StatCard color="green" icon="fa-arrow-trend-down" value={formatCurrency(data.overview?.total_income ?? 0)} label="Total Pemasukan" />
              <StatCard color="red" icon="fa-arrow-trend-up" value={formatCurrency(data.overview?.total_expense ?? 0)} label="Total Pengeluaran" />
              <StatCard
                color="yellow"
                icon="fa-clock"
                value={formatCurrency(data.overview?.total_fine_income ?? 0)}
                label="Denda Masuk"
              />
            </div>

            <div className="grid-3-1">
              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">Ringkasan Kelas</div>
                </div>
                <div className="panel-body">
                  <div className="grid-2 mobile-summary-stats">
                    <SimpleStat value={data.classInfo?.name ?? "-"} label="Kelas" />
                    <SimpleStat value={formatAcademicYearLabel(data.classInfo?.academic_year_name)} label="Tahun Ajaran" />
                    <SimpleStat value={formatCurrency(nominalKas)} label="Nominal Kas" />
                    <SimpleStat value={formatCurrency(data.overview?.total_fine_income ?? 0)} label="Total Denda Masuk" />
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">Status Kas Kelas</div>
                </div>
                <div className="panel-body">
                  <div className="treasurer-summary-list">
                    <div className="summary-row">
                      <span>Jumlah siswa</span>
                      <strong>{data.overview?.total_students ?? 0}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Siswa lunas</span>
                      <strong style={{ color: "var(--accent-deep)" }}>{data.overview?.paid_students ?? 0}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <FinanceChart
              title={`Diagram Keuangan ${data.classInfo?.name ?? "Kelas"}`}
              rows={classFinanceChartRows}
              series={classFinanceChartSeries}
              period={financeChartPeriod}
              onPeriodChange={setFinanceChartPeriod}
            />
          </section>

          <section className={`page-section ${activePage === "students" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Data Akun</div>
                <div className="panel-actions">
                  <div className="search-bar">
                    <i className="fas fa-search" />
                    <input
                      className="form-input users-search-input"
                      placeholder="Cari nama, NIS, email, atau role akun..."
                      value={studentSearch}
                      onChange={(event) => setStudentSearch(event.target.value)}
                    />
                  </div>
              <button className="btn btn-primary" onClick={handleOpenAddClassAccount}>
                <i className="fas fa-plus" /> Tambah Akun
              </button>
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>No</th>
                        <th>Nama Akun</th>
                        <th>NIS</th>
                        <th>Email</th>
                        <th>Role</th>
                        {!isHomeroom ? <th>Bayar</th> : null}
                        <th>Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStudents.length === 0 ? (
                        <tr>
                          <td colSpan={isHomeroom ? 6 : 7}>
                            <div className="empty-row">Belum ada akun di kelas ini.</div>
                          </td>
                        </tr>
                      ) : (
                        filteredStudents.map((student, index) => (
                          <tr key={student.id}>
                            <td data-label="No">{index + 1}</td>
                            <td data-label="Nama Akun">
                              <div className="student-cell">
                                <div className="student-avatar" style={avatarGradient(index)}>
                                  {student.profilePhoto ? (
                                    <img className="user-photo" src={student.profilePhoto} alt={student.fullName} />
                                  ) : (
                                    getInitials(student.fullName)
                                  )}
                                </div>
                                <div className="student-name">{student.fullName}</div>
                              </div>
                            </td>
                            <td data-label="NIS">{student.nis || "-"}</td>
                            <td data-label="Email">{student.email}</td>
                            <td data-label="Role">
                              <span className={`status ${student.isActive ? "status-active" : "status-inactive"}`}>
                                <span className="status-dot" />
                                {student.role === "bendahara" ? "Bendahara" : "Siswa"}
                              </span>
                            </td>
                            {!isHomeroom ? (
                              <td data-label="Bayar">
                                {student.role === "siswa" || student.role === "bendahara" ? (
                                  <button
                                    className="btn btn-primary btn-sm"
                                    onClick={() => {
                                      setPaymentForm((current) => ({
                                        ...current,
                                        studentId: String(student.id),
                                        amount: student.outstandingCash > 0 ? String(student.outstandingCash) : current.amount,
                                        fineAmount:
                                          student.outstandingFine > 0 ? String(student.outstandingFine) : current.fineAmount
                                      }));
                                      setPaymentModalOpen(true);
                                    }}
                                  >
                                    <i className="fas fa-money-bill-wave" /> Bayar
                                  </button>
                                ) : (
                                  <span className="muted-cell">-</span>
                                )}
                              </td>
                            ) : null}
                            <td data-label="Aksi">
                              <div className="table-actions">
                                <button className="btn btn-secondary btn-sm" onClick={() => handleOpenEditClassAccount(student)}>
                                  <i className="fas fa-pen" /> Edit
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "payments" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Pembayaran Kas</div>
                <div className="panel-actions">
                  {!isHomeroom && (
                    <button className="btn btn-primary" onClick={() => setPaymentModalOpen(true)}>
                      <i className="fas fa-plus" /> Tambah Pembayaran
                    </button>
                  )}
                </div>
              </div>
              <div className="panel-body no-padding">
                <div
                  style={{
                    padding: "28px 22px 16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 16,
                    flexWrap: "wrap"
                  }}
                >
                  {paymentCategoryFilter === "denda" ? (
                    <div className="fine-view-tabs inline">
                      <button
                        className={`chip ${fineViewMode === "payments" ? "active" : ""}`}
                        type="button"
                        onClick={() => setFineViewMode("payments")}
                      >
                        Pembayaran Denda
                      </button>
                      <button
                        className={`chip ${fineViewMode === "types" ? "active" : ""}`}
                        type="button"
                        onClick={() => setFineViewMode("types")}
                      >
                        Jenis-Jenis Denda
                      </button>
                    </div>
                  ) : (
                    <select
                      className="form-select"
                      style={{ width: 220 }}
                      value={paymentMonthFilter}
                      onChange={(event) => setPaymentMonthFilter(event.target.value)}
                    >
                      {months.map((month) => (
                        <option key={`payment-month-${month.value}`} value={month.value}>
                          {month.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div className="filter-chips">
                      <button
                        className={`chip ${paymentCategoryFilter === "kas" ? "active" : ""}`}
                        onClick={() => setPaymentCategoryFilter("kas")}
                      >
                        Kas
                      </button>
                      <button
                        className={`chip ${paymentCategoryFilter === "denda" ? "active" : ""}`}
                        onClick={() => setPaymentCategoryFilter("denda")}
                      >
                        Denda
                      </button>
                    </div>
                  </div>
                </div>
                {paymentCategoryFilter === "denda" && fineViewMode === "payments" && (
                  <div className="denda-month-row">
                    <select
                      className="form-select"
                      style={{ width: 220 }}
                      value={paymentMonthFilter}
                      onChange={(event) => setPaymentMonthFilter(event.target.value)}
                    >
                      {months.map((month) => (
                        <option key={`denda-payment-month-${month.value}`} value={month.value}>
                          {month.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {paymentCategoryFilter === "denda" && fineViewMode === "types" && (
                  <div className="fine-master-summary">
                    <div className="fine-master-info">
                      <div className="fine-master-icon">
                        <i className="fas fa-receipt" />
                      </div>
                      <div>
                        <div className="fine-master-title">Master Jenis Denda</div>
                        <div className="fine-master-subtitle">
                          Tambah pilihan denda dan nominal untuk kelas ini.
                        </div>
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => setFineTypeModalOpen(true)}
                    >
                      <i className="fas fa-plus" /> Tambah Jenis Denda
                    </button>
                  </div>
                )}
                {paymentCategoryFilter === "denda" && fineViewMode === "types" && (
                  <div className="fine-type-list">
                    <div className="fine-type-list-header">
                      <div>
                        <div className="fine-type-list-title">Macam Denda</div>
                        <div className="fine-type-list-subtitle">
                          Daftar aturan denda yang sudah dibuat untuk kelas ini.
                        </div>
                      </div>
                      <span className="fine-type-count">{fineTypes.length} data</span>
                    </div>
                    {fineTypes.length === 0 ? (
                      <div className="fine-type-empty">
                        Belum ada macam denda. Klik Tambah Jenis Denda untuk membuat data baru.
                      </div>
                    ) : (
                      <div className="fine-type-grid">
                        {fineTypes.map((item) => (
                          <div className="fine-type-card" key={`fine-type-card-${item.id}`}>
                            <div className="fine-type-name">{item.title}</div>
                            <div className="fine-type-price">{formatCurrency(item.amount)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {paymentCategoryFilter === "kas" && (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>No</th>
                          <th>Nama Siswa</th>
                          <th>Minggu 1</th>
                          <th>Minggu 2</th>
                          <th>Minggu 3</th>
                          <th>Minggu 4</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {weeklyPaymentMatrix.rows.length === 0 ? (
                          <tr>
                            <td colSpan="7">
                              <div className="empty-row">Belum ada siswa untuk direkap.</div>
                            </td>
                          </tr>
                        ) : (
                          weeklyPaymentMatrix.rows.map((row, index) => (
                            <tr key={`weekly-${row.student.id}`}>
                              <td>{index + 1}</td>
                              <td>
                                <div style={{ fontWeight: 800, color: "var(--fg)" }}>{row.student.fullName}</div>
                                <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{row.student.nis || "-"}</div>
                              </td>
                              {row.weeks.map((amount, weekIndex) => (
                                <td key={`weekly-${row.student.id}-${weekIndex + 1}`}>
                                  {amount > 0 ? (
                                    <span style={{ color: "var(--accent-deep)", fontWeight: 800 }}>
                                      {formatCurrency(amount)}
                                    </span>
                                  ) : (
                                    <span style={{ color: "var(--red)", fontWeight: 800 }}>0</span>
                                  )}
                                </td>
                              ))}
                              <td style={{ color: "var(--accent-deep)", fontWeight: 800 }}>
                                {formatCurrency(row.total)}
                              </td>
                            </tr>
                          ))
                        )}
                        {weeklyPaymentMatrix.rows.length > 0 && (
                          <tr style={{ background: "var(--bg-subtle)" }}>
                            <td colSpan="2" style={{ fontWeight: 900 }}>Total</td>
                            {weeklyPaymentMatrix.totals.map((amount, index) => (
                              <td key={`weekly-total-${index + 1}`} style={{ fontWeight: 900 }}>
                                {amount > 0 ? formatCurrency(amount) : "Rp0"}
                              </td>
                            ))}
                            <td style={{ fontWeight: 900, color: "var(--accent-deep)" }}>
                              {formatCurrency(weeklyPaymentMatrix.grandTotal)}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {paymentCategoryFilter === "denda" && fineViewMode === "payments" && (
                  <div style={{ padding: "0 22px 22px" }}>
                    <div className="table-wrapper">
                      <table>
                        <thead>
                          <tr>
                            <th>No</th>
                            <th>Nama Siswa</th>
                            <th>Alasan Denda</th>
                            <th>Harga</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredFineRows.length === 0 ? (
                            <tr>
                              <td colSpan="4">
                                <div className="empty-row">Belum ada data denda di bulan ini.</div>
                              </td>
                            </tr>
                          ) : (
                            <>
                              {filteredFineRows.map((item, index) => (
                                <tr key={`fine-row-${item.id}`}>
                                  <td>{index + 1}</td>
                                  <td>{getTransactionStudentName(item)}</td>
                                  <td>{item.note || item.title}</td>
                                  <td style={{ color: "var(--orange)", fontWeight: 800 }}>
                                    {formatCurrency(item.amount)}
                                  </td>
                                </tr>
                              ))}
                              <tr style={{ background: "var(--bg-subtle)" }}>
                                <td colSpan="3" style={{ fontWeight: 900 }}>
                                  Total
                                </td>
                                <td style={{ color: "var(--orange)", fontWeight: 900 }}>
                                  {formatCurrency(
                                    filteredFineRows.reduce(
                                      (sum, item) => sum + Number(item.amount ?? 0),
                                      0
                                    )
                                  )}
                                </td>
                              </tr>
                            </>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "expenses" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Pengeluaran Kelas</div>
                <div className="panel-actions">
                  {!isHomeroom && (
                    <button className="btn btn-primary" onClick={() => setExpenseModalOpen(true)}>
                      <i className="fas fa-plus" /> Tambah Pengeluaran
                    </button>
                  )}
                </div>
              </div>
              <div className="panel-body no-padding">
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Tanggal</th>
                        <th>Judul Pengeluaran</th>
                        <th>Keterangan</th>
                        <th>Jumlah</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenseRows.length === 0 ? (
                        <tr>
                          <td colSpan="4">
                            <div className="empty-row">Belum ada pengeluaran kelas.</div>
                          </td>
                        </tr>
                      ) : (
                        expenseRows.map((item) => (
                          <tr key={item.id}>
                            <td>{formatDateLabel(item.created_at)}</td>
                            <td>{item.title}</td>
                            <td>{item.note || item.title}</td>
                            <td style={{ color: "var(--red)", fontWeight: 800 }}>
                              -{formatCurrency(item.amount)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "balance" ? "active" : ""}`}>
            <div className="stats-grid treasurer-balance-stats">
              <StatCard color="green" icon="fa-arrow-trend-down" value={formatCurrency(data.overview?.total_income ?? 0)} label="Total Pemasukan" />
              <StatCard color="yellow" icon="fa-file-invoice-dollar" value={formatCurrency(data.overview?.total_fine_income ?? 0)} label="Total Denda" />
              <StatCard color="red" icon="fa-arrow-trend-up" value={formatCurrency(data.overview?.total_expense ?? 0)} label="Total Pengeluaran" />
            </div>

            <div className="grid-2 treasurer-balance-grid">
              <div className="saldo-card treasurer-balance-card">
                <div className="saldo-label">Saldo Kas {data.classInfo?.name ?? "Kelas"}</div>
                <div className="saldo-amount">{formatCurrency(data.overview?.balance ?? 0)}</div>
                <div className="saldo-details">
                  <div className="saldo-detail-item">
                    <span className="saldo-detail-label">Transaksi</span>
                    <span className="saldo-detail-value">{data.overview?.total_transactions ?? 0}</span>
                  </div>
                  <div className="saldo-detail-item">
                    <span className="saldo-detail-label">Siswa Lunas</span>
                    <span className="saldo-detail-value">{data.overview?.paid_students ?? 0}</span>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">Ringkasan Saldo</div>
                </div>
                <div className="panel-body">
                  <div className="treasurer-summary-list">
                    <div className="summary-row">
                      <span>Kelas aktif</span>
                      <strong>{data.classInfo?.name ?? "-"}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Tahun ajaran</span>
                      <strong>{formatAcademicYearLabel(data.classInfo?.academic_year_name)}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Nominal kas</span>
                      <strong>{formatCurrency(nominalKas)}</strong>
                    </div>
                    <div className="summary-row">
                      <span>Total denda masuk</span>
                      <strong>{formatCurrency(data.overview?.total_fine_income ?? 0)}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className={`page-section ${activePage === "history" ? "active" : ""}`}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Riwayat Transaksi</div>
              </div>
              <div className="panel-body compact-list">
                {transactions.length === 0 ? (
                  <div className="empty-state">
                    <i className="fas fa-clock-rotate-left" />
                    <p>Belum ada riwayat transaksi.</p>
                  </div>
                ) : (
                  historyPagination.rows.map((item) => (
                    <div className="transaction-item" key={item.id}>
                      <div className={`transaction-icon ${item.type === "income" ? "income" : "expense"}`}>
                        <i className={`fas ${item.type === "income" ? "fa-arrow-trend-down" : "fa-arrow-trend-up"}`} />
                      </div>
                      <div className="transaction-info">
                        <div className="transaction-desc">{item.title}</div>
                        <div className="transaction-meta">
                          {formatDateLabel(item.created_at)} • {getTransactionStudentName(item) !== "-" ? getTransactionStudentName(item) : item.category ?? "Transaksi kelas"}
                        </div>
                      </div>
                      <div className={`transaction-amount ${item.type === "income" ? "positive" : "negative"}`}>
                        {item.type === "income" ? "+" : "-"}
                        {formatCurrency(item.amount)}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <PaginationControls page={historyPagination.page} totalPages={historyPagination.totalPages} onChange={setHistoryPage} />
            </div>
          </section>

          <section className={`page-section ${activePage === "reports" ? "active" : ""}`}>
            <div className="panel" style={{ marginBottom: 20 }}>
              <div className="panel-header">
                <div className="panel-title">Filter Laporan Kelas</div>
              </div>
              <div className="panel-body">
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Bulan</label>
                    <select
                      className="form-select"
                      value={reportFilters.month}
                      onChange={(event) =>
                        setReportFilters((current) => ({ ...current, month: event.target.value }))
                      }
                    >
                      {months.map((month) => (
                        <option key={month.value} value={month.value}>
                          {month.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Tahun</label>
                    <select
                      className="form-select"
                      value={reportFilters.year}
                      onChange={(event) =>
                        setReportFilters((current) => ({ ...current, year: event.target.value }))
                      }
                    >
                      {(reportYearOptions.length ? reportYearOptions : [String(new Date().getFullYear())]).map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="report-action-grid">
                  <button className="btn btn-primary" onClick={() => setReportGenerated(true)}>
                    <i className="fas fa-eye" /> Tampilkan
                  </button>
                  <button className="btn btn-outline" onClick={handleExportTreasurerPdf}>
                    <i className="fas fa-file-pdf" /> Export PDF
                  </button>
                  <button className="btn btn-secondary" onClick={handleExportTreasurerExcel}>
                    <i className="fas fa-file-excel" /> Export Excel
                  </button>
                  <button className="btn btn-secondary" onClick={handlePrintTreasurerReport}>
                    <i className="fas fa-print" /> Cetak
                  </button>
                </div>
              </div>
            </div>

            {!generatedReport ? (
              <div className="panel">
                <div className="panel-body">
                  <div className="empty-state">
                    <i className="fas fa-file-invoice" />
                    <p>Pilih filter, lalu klik tampilkan.</p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="report-banner panel">
                  <div className="panel-body centered">
                    <h2>{`LAPORAN KAS ${isHomeroom ? "WALI KELAS" : "BENDAHARA"}`}</h2>
                    <p>TA {formatAcademicYearLabel(data.classInfo?.academic_year_name) || "Belum diatur"}</p>
                    <span>
                      Periode:{" "}
                      {`${months.find((item) => item.value === reportFilters.month)?.label ?? "-"} ${reportFilters.year}`}
                    </span>
                  </div>
                </div>

                <div className="stats-grid four-report mobile-report-stats">
                  <SimpleStat value={formatCurrency(generatedReport.income)} label="Pemasukan" />
                  <SimpleStat value={formatCurrency(generatedReport.fine)} label="Denda" />
                  <SimpleStat value={formatCurrency(generatedReport.expense)} label="Pengeluaran" />
                  <SimpleStat value={formatCurrency(generatedReport.balance)} label="Saldo" highlight />
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <div className="panel-title">Detail Laporan</div>
                  </div>
                  <div className="panel-body no-padding">
                    <div className="table-wrapper mobile-report-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Tanggal</th>
                            <th>Nama Siswa</th>
                            <th>Jenis</th>
                            <th>Keterangan</th>
                            <th>Jumlah</th>
                          </tr>
                        </thead>
                        <tbody>
                          {generatedReport.rows.length === 0 ? (
                            <tr>
                              <td colSpan="5">
                                <div className="empty-row">Tidak ada transaksi pada periode ini.</div>
                              </td>
                            </tr>
                          ) : (
                            generatedReport.rows.map((item) => (
                              <tr key={item.id}>
                                <td data-label="Tanggal">{formatDateLabel(item.created_at)}</td>
                                <td data-label="Nama Siswa">{getReportStudentName(item)}</td>
                                <td data-label="Jenis">{item.type === "income" ? "Pemasukan" : "Pengeluaran"}</td>
                                <td data-label="Keterangan">{item.note || item.title}</td>
                                <td data-label="Jumlah" style={{ color: item.type === "income" ? "var(--accent-deep)" : "var(--red)", fontWeight: 800 }}>
                                  {item.type === "income" ? "+" : "-"}
                                  {formatCurrency(item.amount)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      {fineTypeModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card treasurer-modal">
            <div className="modal-header">
              <h3>Tambah Jenis Denda</h3>
              <button
                className="modal-close"
                type="button"
                onClick={() => setFineTypeModalOpen(false)}
              >
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveFineType}>
              <div className="form-group">
                <label className="form-label">Jenis denda / alasan</label>
                <input
                  className="form-input"
                  value={fineTypeForm.title}
                  onChange={(event) =>
                    setFineTypeForm((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="Contoh: Bermasalah dengan guru"
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Nominal denda</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  value={fineTypeForm.amount}
                  onChange={(event) =>
                    setFineTypeForm((current) => ({ ...current, amount: event.target.value }))
                  }
                  placeholder="Contoh: 50000"
                  required
                />
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setFineTypeModalOpen(false)}
                >
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Denda
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {paymentModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card treasurer-modal">
            <div className="modal-header">
              <h3>Catat Pembayaran Kas</h3>
              <button className="modal-close" onClick={() => setPaymentModalOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSavePayment}>
              <div className="form-group">
                <label className="form-label">Siswa</label>
                <select
                  className="form-select"
                  value={paymentForm.studentId}
                  onChange={(event) =>
                    setPaymentForm((current) => ({ ...current, studentId: event.target.value }))
                  }
                  required
                >
                  <option value="">Pilih siswa</option>
                  {students
                    .filter((student) => student.role === "siswa" || student.role === "bendahara")
                    .map((student) => (
                      <option key={student.id} value={student.id}>
                        {student.fullName}
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Jumlah Pembayaran Kas</label>
                  <input
                    className="form-input"
                    type="number"
                    min="0"
                    value={paymentForm.amount}
                    onChange={(event) =>
                      setPaymentForm((current) => ({ ...current, amount: event.target.value }))
                    }
                    placeholder="0"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Bayar Denda</label>
                  <input
                    className="form-input"
                    type="number"
                    min="0"
                    value={paymentForm.fineAmount}
                    onChange={(event) =>
                      setPaymentForm((current) => ({ ...current, fineAmount: event.target.value }))
                    }
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Keterangan Pembayaran / Bulan Tujuan</label>
                <input
                  className="form-input"
                  value={paymentForm.title}
                  onChange={(event) =>
                    setPaymentForm((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="Contoh: untuk Agustus / Agustus minggu 3 / Senin 25 Agu 2026"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Alasan Denda</label>
                <select
                  className="form-select"
                  value={paymentForm.fineReason}
                  onChange={(event) => {
                    const selectedFineType = fineTypes.find((item) => item.title === event.target.value);
                    const selectedReason = selectedFineType?.title ?? event.target.value;

                    setPaymentForm((current) => ({
                      ...current,
                      fineReason: selectedReason,
                      fineAmount:
                        selectedFineType && (!Number(current.fineAmount) || Number(current.fineAmount) <= 0)
                          ? String(selectedFineType.amount ?? "")
                          : current.fineAmount
                    }));
                  }}
                >
                  <option value="">Pilih alasan denda</option>
                  {fineTypes.map((item) => (
                    <option key={item.id} value={item.title}>
                      {item.title} - {formatCurrency(item.amount)}
                    </option>
                  ))}
                  {fineTypes.length === 0 ? (
                    <option value="Pembayaran denda keterlambatan">Pembayaran denda keterlambatan</option>
                  ) : null}
                </select>
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: -4 }}>
                Sistem akan membaca bulan dari teks yang ditulis. Contoh "untuk Agustus" akan mulai masuk ke Agustus. Jika nominalnya lebih, sisanya otomatis lanjut ke bulan berikutnya per minggu.
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setPaymentModalOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Pembayaran
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {expenseModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card treasurer-modal">
            <div className="modal-header">
              <h3>Catat Pengeluaran</h3>
              <button className="modal-close" onClick={() => setExpenseModalOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveExpense}>
              <div className="form-group">
                <label className="form-label">Judul Pengeluaran</label>
                <input
                  className="form-input"
                  value={expenseForm.title}
                  onChange={(event) =>
                    setExpenseForm((current) => ({ ...current, title: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Jumlah</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  value={expenseForm.amount}
                  onChange={(event) =>
                    setExpenseForm((current) => ({ ...current, amount: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Keterangan Pengeluaran</label>
                <textarea
                  className="form-input form-textarea"
                  value={expenseForm.note}
                  onChange={(event) =>
                    setExpenseForm((current) => ({ ...current, note: event.target.value }))
                  }
                  placeholder="Tuliskan alasan pengeluaran"
                />
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setExpenseModalOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Pengeluaran
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {profileModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card">
            <div className="modal-header">
              <h3>Edit Profil {roleLabel}</h3>
              <button className="modal-close" onClick={() => setProfileModalOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveTreasurerProfile}>
              <div className="profile-photo-editor">
                <div className="profile-photo-large">
                  {profileForm.profilePhoto ? (
                    <img className="user-photo large" src={profileForm.profilePhoto} alt={profileForm.fullName} />
                  ) : (
                    getInitials(profileForm.fullName)
                  )}
                </div>
                <div className="profile-photo-actions">
                  <label className="btn btn-secondary profile-upload-btn">
                    <input type="file" accept="image/*" hidden onChange={handleTreasurerProfilePhotoChange} />
                    <i className="fas fa-image" /> Ganti Foto
                  </label>
                </div>
              </div>

              {profileForm.profilePhoto && (
                <div className="upload-preview-card profile-preview-card">
                  <button
                    type="button"
                    className="upload-remove-btn"
                    onClick={() =>
                      setProfileForm((current) => ({
                        ...current,
                        profilePhoto: "",
                        profilePhotoOriginal: ""
                      }))
                    }
                  >
                    <i className="fas fa-xmark" />
                  </button>
                  <button
                    type="button"
                    className="upload-preview-image-button"
                    onClick={() =>
                      openTreasurerCropper({
                        target: "treasurerProfilePhoto",
                        title: `Crop Foto Profil ${roleLabel}`,
                        source: profileForm.profilePhotoOriginal || profileForm.profilePhoto,
                        aspect: "square",
                        originalSource: profileForm.profilePhotoOriginal || profileForm.profilePhoto
                      })
                    }
                  >
                    <img
                      src={profileForm.profilePhoto}
                      alt={`Preview foto profil ${roleLabel.toLowerCase()}`}
                      className="upload-preview-image square"
                    />
                  </button>
                  <div className="upload-preview-text">Preview foto profil sebelum disimpan</div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Nama Lengkap</label>
                <input
                  className="form-input"
                  value={profileForm.fullName}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, fullName: event.target.value }))
                  }
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={profileForm.email}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, email: event.target.value }))
                  }
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Password Baru</label>
                <PasswordField
                  placeholder="Kosongkan jika tidak diganti"
                  value={profileForm.password}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, password: event.target.value }))
                  }
                  autoComplete="new-password"
                />
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setProfileModalOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> Simpan Profil
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {studentModalOpen && (
        <div className="modal-overlay show">
          <div className="modal-card account-modal">
            <div className="modal-header">
              <h3>{editingClassAccount ? "Edit Akun" : "Tambah Akun"}</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setStudentModalOpen(false);
                  setEditingClassAccount(null);
                }}
              >
                <i className="fas fa-xmark" />
              </button>
            </div>
            <form className="modal-body" onSubmit={handleSaveStudent}>
              <div className="profile-photo-editor">
                <div className="profile-photo-large">
                  {studentForm.profilePhoto ? (
                    <img className="user-photo large" src={studentForm.profilePhoto} alt={studentForm.fullName} />
                  ) : (
                    getInitials(studentForm.fullName || "Akun Baru")
                  )}
                </div>
                <div className="profile-photo-actions">
                  <label className="btn btn-secondary profile-upload-btn">
                    <input type="file" accept="image/*" hidden onChange={handleStudentPhotoChange} />
                    <i className="fas fa-image" /> Upload Foto
                  </label>
                </div>
              </div>

              {studentForm.profilePhoto && (
                <div className="upload-preview-card profile-preview-card">
                  <button
                    type="button"
                    className="upload-remove-btn"
                    onClick={() =>
                      setStudentForm((current) => ({
                        ...current,
                        profilePhoto: "",
                        profilePhotoOriginal: ""
                      }))
                    }
                  >
                    <i className="fas fa-xmark" />
                  </button>
                  <button
                    type="button"
                    className="upload-preview-image-button"
                    onClick={() =>
                      openTreasurerCropper({
                        target: "treasurerStudentPhoto",
                        title: "Crop Foto Akun",
                        source: studentForm.profilePhotoOriginal || studentForm.profilePhoto,
                        aspect: "square",
                        originalSource: studentForm.profilePhotoOriginal || studentForm.profilePhoto
                      })
                    }
                  >
                    <img
                      src={studentForm.profilePhoto}
                      alt="Preview foto akun"
                      className="upload-preview-image square"
                    />
                  </button>
                  <div className="upload-preview-text">Preview foto akun sebelum disimpan</div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Role Akun</label>
                <select
                  className="form-input"
                  value={studentForm.role}
                  onChange={(event) => updateStudentFormField("role", event.target.value)}
                  required
                >
                  <option value="siswa">Siswa</option>
                  <option value="bendahara">Bendahara</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Nama Lengkap</label>
                <input
                  className={`form-input ${studentFormErrors.fullName ? "is-invalid" : ""}`}
                  value={studentForm.fullName}
                  onChange={(event) => updateStudentFormField("fullName", event.target.value)}
                />
                {studentFormErrors.fullName ? <div className="form-error-text">{studentFormErrors.fullName}</div> : null}
              </div>
              <div className="form-group">
                <label className="form-label">NIS</label>
                <input
                  className="form-input"
                  value={studentForm.nis}
                  onChange={(event) => updateStudentFormField("nis", event.target.value)}
                  placeholder={studentForm.role === "bendahara" ? "Opsional untuk bendahara" : "Nomor induk siswa"}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className={`form-input ${studentFormErrors.email ? "is-invalid" : ""}`}
                  type="text"
                  value={studentForm.email}
                  onChange={(event) => updateStudentFormField("email", event.target.value)}
                />
                {studentFormErrors.email ? <div className="form-error-text">{studentFormErrors.email}</div> : null}
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <PasswordField
                  value={studentForm.password}
                  onChange={(event) => updateStudentFormField("password", event.target.value)}
                  placeholder={editingClassAccount ? "Kosongkan jika tidak diganti" : "Minimal 6 karakter"}
                  className={`form-input ${studentFormErrors.password ? "is-invalid" : ""}`}
                  autoComplete="new-password"
                />
                {studentFormErrors.password ? <div className="form-error-text">{studentFormErrors.password}</div> : null}
              </div>
              <div className="form-group">
                <label className="form-label">Status akun</label>
                <select
                  className="form-select"
                  value={studentForm.isActive ? "aktif" : "nonaktif"}
                  onChange={(event) => updateStudentFormField("isActive", event.target.value === "aktif")}
                >
                  <option value="aktif">Aktif</option>
                  <option value="nonaktif">Nonaktif</option>
                </select>
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    setStudentModalOpen(false);
                    setEditingClassAccount(null);
                    setStudentFormErrors({});
                  }}
                >
                  Batal
                </button>
                <button className="btn btn-primary" type="submit">
                  <i className="fas fa-check" /> {editingClassAccount ? "Simpan Perubahan" : "Simpan Akun"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {cropperOpen && (
        <div className="modal-overlay show">
          <div className="modal-card cropper-modal">
            <div className="modal-header">
              <h3>{cropperState.title}</h3>
              <button className="modal-close" onClick={() => setCropperOpen(false)}>
                <i className="fas fa-xmark" />
              </button>
            </div>
            <div className="modal-body">
              <div
                className={`cropper-viewport ${cropperState.aspect === "landscape" ? "landscape" : "square"} ${
                  cropDragging ? "dragging" : ""
                }`}
                style={{
                  width: cropperState.viewportWidth,
                  height: cropperState.viewportHeight
                }}
                onPointerDown={handleCropPointerDown}
                onPointerMove={handleCropPointerMove}
                onPointerUp={handleCropPointerUp}
                onPointerCancel={handleCropPointerUp}
                onPointerLeave={handleCropPointerUp}
              >
                <img
                  src={cropperState.source}
                  alt="Crop source"
                  className="cropper-image"
                  style={{
                    width: cropperState.imageWidth * cropperState.zoom,
                    height: cropperState.imageHeight * cropperState.zoom,
                    left:
                      (cropperState.viewportWidth - cropperState.imageWidth * cropperState.zoom) / 2 +
                      cropperState.panX,
                    top:
                      (cropperState.viewportHeight - cropperState.imageHeight * cropperState.zoom) / 2 +
                      cropperState.panY
                  }}
                />
              </div>

              <div className="cropper-controls">
                <div className="form-group">
                  <label className="form-label">Zoom</label>
                  <input
                    className="cropper-range"
                    type="range"
                    min={cropperState.minZoom}
                    max={cropperState.minZoom * 3}
                    step="0.01"
                    value={cropperState.zoom}
                    onChange={(event) =>
                      setCropperState((current) =>
                        clampCropState({
                          ...current,
                          zoom: Number(event.target.value)
                        })
                      )
                    }
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" type="button" onClick={() => setCropperOpen(false)}>
                  Batal
                </button>
                <button className="btn btn-primary" type="button" onClick={handleApplyCrop}>
                  <i className="fas fa-crop-simple" /> Pakai Crop
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-container">
          <div className="toast">
            <div className={`toast-icon ${toast.type}`}>
              <i
                className={`fas ${
                  toast.type === "error"
                    ? "fa-xmark"
                    : toast.type === "info"
                      ? "fa-info"
                      : "fa-check"
                }`}
              />
            </div>
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
