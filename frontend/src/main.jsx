import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("KasKu render error:", error, info);
    try {
      const alreadyReset = window.sessionStorage.getItem("kasku-render-error-reset");
      if (!alreadyReset) {
        window.sessionStorage.setItem("kasku-render-error-reset", "1");
        window.localStorage.removeItem("kasku-superadmin-session");
        window.setTimeout(() => window.location.reload(), 200);
      }
    } catch {
      // ignore storage errors
    }
  }

  render() {
    if (this.state.error) {
      return (
        <main className="login-shell app-error-shell">
          <section className="login-card app-error-card">
            <div className="app-error-brand">
              <div className="logo-icon app-error-logo">
                <i className="fas fa-wallet" />
              </div>
              <div>
                <div className="logo-text">Kas<span>Ku</span></div>
                <div className="app-error-badge">Aplikasi perlu dimuat ulang</div>
              </div>
            </div>
            <h1 className="login-title app-error-title">Terjadi gangguan saat memuat halaman.</h1>
            <p className="login-copy app-error-copy">
              Data Anda tetap aman. Silakan muat ulang aplikasi atau reset sesi login untuk melanjutkan.
            </p>
            <div className="app-error-actions">
              <button
                className="btn btn-primary app-error-button"
                type="button"
                onClick={() => {
                  window.sessionStorage.removeItem("kasku-render-error-reset");
                  window.location.reload();
                }}
              >
                Muat Ulang
              </button>
              <button
                className="btn btn-secondary app-error-button"
                type="button"
                onClick={() => {
                  window.sessionStorage.removeItem("kasku-render-error-reset");
                  window.localStorage.removeItem("kasku-superadmin-session");
                  window.location.reload();
                }}
              >
                Reset Sesi Login
              </button>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
