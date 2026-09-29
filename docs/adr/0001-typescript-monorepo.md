# ADR-0001: Backend bằng TypeScript (Node 22), pnpm monorepo

- Status: Accepted
- Date: 2026-09-29

## Context

Spec §67 đề xuất ".NET 8 / Python". .NET 8 hết hỗ trợ LTS vào 11/2026. Phần lõi của platform là quản lý subprocess, stream NDJSON, hook callback và UI realtime. Các hệ sinh thái cần tích hợp (Claude Agent SDK, MCP SDK, Gemini/Antigravity tooling) đều có SDK TypeScript chính chủ.

## Decision

- Toàn bộ backend (control plane, runner, adapters) và frontend dùng **TypeScript trên Node 22 LTS**.
- Dùng **pnpm workspace monorepo**: `packages/*` là thư viện, `apps/*` là các process chạy được.
- Test bằng `vitest`. Typecheck ở chế độ `strict` + `exactOptionalPropertyTypes`.

## Consequences

- Dùng chung type (domain, event, adapter contract) giữa control plane, runner và UI.
- Nếu team cần viết adapter bằng ngôn ngữ khác thì dùng `GenericCliAdapter` hoặc giao thức runner qua HTTP.
