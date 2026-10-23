import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { StoreProvider } from "./store";
import { api } from "./api";

window.addEventListener("error", (e) => api.log("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => api.log("error", `Unbehandelt: ${String(e.reason)}`));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
