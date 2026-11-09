import { initializeLocale } from "../shared/locale";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
window.desktop
  .locale()
  .then((locale) => {
    initializeLocale(locale);
    document.documentElement.lang = locale;
    createRoot(document.getElementById("root")!).render(<App />);
  })
  .catch((error) =>
    window.desktop.log("error", "locale.failure", { message: String(error) }),
  );
