import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const base = env.VITE_SITE_BASE || "/";
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))
    throw new Error("VITE_SITE_BASE must be an absolute path with a trailing slash.");
  if (env.VITE_ACCOUNT_ORIGIN) {
    const origin = new URL(env.VITE_ACCOUNT_ORIGIN);
    if (origin.protocol !== "https:" || origin.origin !== env.VITE_ACCOUNT_ORIGIN)
      throw new Error("VITE_ACCOUNT_ORIGIN must be an HTTPS origin without a path.");
  }
  return {
    base,
    plugins: [react()],
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:8088", changeOrigin: false },
        "/auth": { target: "http://127.0.0.1:8088", changeOrigin: false },
      },
    },
    build: { target: "es2022", sourcemap: false },
  };
});
