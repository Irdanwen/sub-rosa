// First, before any component module evaluates: see i18n-boot.
import "./lib/i18n-boot";
import React from "react";
import ReactDOM from "react-dom/client";
import { ChatBar } from "./components/chat-bar/ChatBar";
import { subscribeBrand } from "./lib/brand";
import { installNativeContextMenuGuard } from "./lib/native-context-menu";
import { initTheme } from "./lib/theme";
import "./styles/app.css";
import "./styles/chat-bar.css";

initTheme();
subscribeBrand();
installNativeContextMenuGuard({ allowEditableFields: true });

const root = document.getElementById("chat-bar-root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ChatBar />
    </React.StrictMode>,
  );
}
