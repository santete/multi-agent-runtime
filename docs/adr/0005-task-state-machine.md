# ADR-0005: Chuẩn hóa task state machine

- Status: Accepted
- Date: 2026-09-29

## Context

State machine ở spec §12 có hai trạng thái `FAILED`, `WAITING` trùng với `WAITING_FOR_*`, thiếu nhánh review bị reject, và thiếu nhánh merge bị conflict.

## Decision

Triển khai tại `packages/core/src/task-state.ts` dưới dạng bảng transition kèm test:

```text
CREATED → READY (deps xong) → ASSIGNED → RUNNING
RUNNING → WAITING_FOR_HUMAN | WAITING_FOR_AGENT → RUNNING
RUNNING → VALIDATING → REVIEW → APPROVED → MERGING → COMPLETED
VALIDATING ✗ / REVIEW ✗ / MERGING ✗ (conflict) → REWORK → RUNNING
RUNNING ✗ (crash/timeout) → RETRYING → RUNNING | READY (reassign)
REWORK / RETRYING vượt giới hạn → BLOCKED → READY (unblock)
mọi trạng thái chưa kết thúc → CANCELLED
```

- `WAITING_FOR_DEPENDENCY` được suy ra từ DAG, không lưu thành state.
- Không có đường nào đi từ `RUNNING` thẳng tới `REVIEW` hay `MERGING`: agent tự báo "done" không đủ để coi task là xong (§63).

## Consequences

Mọi thay đổi state đi qua `transition()` và sinh event `TaskStateChanged` (M1).
