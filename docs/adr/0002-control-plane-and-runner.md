# ADR-0002: Control Plane tập trung + Runner daemon

- Status: Accepted
- Date: 2026-09-29

## Context

Coding agent thường chạy bằng subscription hoặc đăng nhập cá nhân (Claude OAuth, Google account) trên máy dev, còn control plane cần một nơi tập trung. Spec chưa nói agent chạy ở đâu.

## Decision

- **Control Plane** (`apps/control-plane`) quản lý project, task DAG, scheduler, policy, approval, tích hợp GitHub và event store. Nguồn sự thật là PostgreSQL.
- **Runner** (`apps/runner`) cài trên máy hoặc VM có sẵn CLI agent. Runner tự đăng ký các agent nó có, kéo job về (long-poll hoặc WebSocket), tạo git worktree, chạy adapter, stream event lên, và chạy validation cục bộ.
- Git provider cho MVP là **GitHub** (qua interface `GitProvider`). Chỉ control plane giữ token để push và mở PR. **Agent không có credential push.**
- MVP chưa dùng Redis. State, events và outbox đều nằm trong Postgres.

## Consequences

- Một control plane quản lý được nhiều máy và nhiều loại agent.
- Runner phải chịu được mất kết nối: buffer event cục bộ và resume theo session id.
