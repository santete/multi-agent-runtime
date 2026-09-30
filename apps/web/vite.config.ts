import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// API paths proxied to the control plane during `pnpm dev`.
const API = ["/me", "/projects", "/tasks", "/approvals", "/runners", "/executions", "/events", "/stream", "/health"];
const target = process.env.MAR_API ?? "http://127.0.0.1:7700";

export default defineConfig({
  // The control plane serves the built UI under /ui/.
  base: "/ui/",
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(API.map((p) => [p, { target, changeOrigin: true }])),
  },
});
