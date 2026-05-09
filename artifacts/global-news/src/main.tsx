import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const log = (event: string, detail?: unknown) => {
  try {
    console.info("[intel-pwa]", event, detail ?? "");
  } catch {
  }
};

window.addEventListener("error", (event) => {
  log("window-error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  log("unhandledrejection", event.reason);
});

log("boot", {
  baseUrl: import.meta.env.BASE_URL,
  pathname: window.location.pathname,
  standalone: window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true,
  userAgent: window.navigator.userAgent,
});

// Register service worker for PWA push notifications
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(() => {
      log("service-worker-registered");
    }).catch((error) => {
      log("service-worker-registration-failed", error);
    });
  });
}

const root = document.getElementById("root");

if (!root) {
  log("root-missing");
} else {
  createRoot(root).render(<App />);
}
