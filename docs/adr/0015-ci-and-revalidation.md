# ADR-0015: CI gate và re-validate trên base mới trong merge queue

- Status: Accepted
- Date: 2026-10-01

## Context

Trước ADR này, merge queue (ADR-0008) merge ngay khi task đã được approve. Có hai lỗ hổng:

1. **Base đã đổi.** Task B được validate trên `main` lúc B bắt đầu. Nếu trong lúc đó task A được merge, thứ sẽ được merge (A + B) chưa từng được validate. GitHub chỉ phát hiện conflict về văn bản, không phát hiện được conflict về ngữ nghĩa (spec §27).
2. **CI.** Spec §34 yêu cầu kết quả CI trở thành artifact/event và ảnh hưởng tới state của task. Validation của runner chỉ chạy những bước đã cấu hình trong project, còn CI của repo có thể kiểm tra thêm nhiều thứ khác (lint, nhiều phiên bản Node, e2e…).

## Decision

**`GitProvider.pullRequestStatus`** (tùy chọn) trả về:
- `headSha`;
- `behindBase`: base có commit mà branch chưa có;
- `checks`: gộp check runs và commit statuses thành `none | pending | success | failure`. `neutral` và `skipped` không chặn merge. Với check thất bại, provider lấy thêm annotations, vì GitHub Actions ghi lỗi (`::error::`) vào annotations chứ không vào summary.

GitHub implementation dùng các endpoint `pulls/:n`, `compare/base...head`, `commits/:sha/check-runs`, `commits/:sha/status` và `check-runs/:id/annotations`.

**Merge policy của project** (`PUT /projects/:id/merge-policy`):
- `revalidateOnBaseChange`: mặc định bật;
- `waitForChecks`: mặc định tắt.

**Merge queue:** task ở `MERGING`, trước khi merge:
1. **Base đã đổi** → `base_changed` → `REWORK` (event `BaseChanged`, artifact `merge_result {status: "base_changed"}`). Rework context `base_changed` mang theo `baseBranch`.
2. **Chờ CI** (khi `waitForChecks` bật):
   - `pending`: task vẫn ở `MERGING` và **giữ hàng đợi của project** (đúng nghĩa merge queue). `CiPending` chỉ được ghi một lần cho mỗi head SHA.
   - `failure`: `ci_failed` → `REWORK` (event `CiFailed`, artifact `ci_result`). Rework context `ci` chứa các check thất bại kèm url và summary/annotations.
   - `none` sau thời gian chờ `ciGraceSeconds` (mặc định 120 giây) → merge không có CI, ghi `CiSkipped`.
   - `success` → `CiPassed`, rồi merge.

**Runner, khi nhận rework `base_changed`:**
- merge `origin/<base>` vào branch;
- nếu merge **sạch**: **không chạy agent**. Runner báo `complete { revalidation: true }`, chạy lại validation và push merge commit. Control plane đánh dấu `executions.revalidation`. Sau khi deliver, task đi `REVIEW → APPROVED` với actor `platform`: approval cũ vẫn giữ, không cần review lại và không tạo review agent;
- nếu **conflict**: agent giải quyết như rework `merge_conflict`, và sau đó người phải review lại;
- nếu **validation fail** trên base mới: rework `validation` như bình thường, agent sửa rồi người review lại.

**Rework `ci`:** `REWORK.md` liệt kê các check thất bại cùng thông điệp của chúng, và agent sửa nguyên nhân.

**Attempts:** lượt re-validate không tính vào `maxAttempts`. Trong một repo bận rộn, base có thể đổi nhiều lần mà task đó không có lỗi gì.

## Consequences

- Không còn tình trạng merge thứ chưa được validate. Cái giá là các task song song của cùng một project được merge tuần tự, và mỗi task đi sau phải validate lại một lần.
- Khi CI đang pending, hàng đợi của project đó bị giữ lại. Các project khác không bị ảnh hưởng.
- Webhook từ GitHub chưa được dùng: control plane polling mỗi lần sweep (5 giây). Đủ cho một repo vài PR, và chạy được cả trên máy local không có địa chỉ public.
