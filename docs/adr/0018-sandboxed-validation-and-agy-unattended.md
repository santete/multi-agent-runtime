# ADR-0018: Validation trong container và agy unattended

- Status: Accepted
- Date: 2026-10-01

## Context

Có hai giới hạn còn lại từ MVP (ADR-0004, ADR-0007):

1. **Validation chạy thẳng trên máy runner.** Lệnh validation đến từ cấu hình project (như CI job), không đến từ agent. Nhưng các lệnh đó lại chạy trên **code do agent viết** (`npm test` chạy test mà agent vừa sửa). Code này có thể đọc file ngoài worktree hoặc gọi mạng.
2. **agy headless không chạy được shell** (upstream #548/#619): `allow` của hook lẫn của settings đều không mở được `run_command`. Vì vậy agy không tự kiểm tra được việc của mình, và mọi lệnh shell đều thành `denied_actions`.

## Decision

### Validation trong container

Mỗi project có thêm `validationSandbox`:
- `image`: ví dụ `node:22-alpine`;
- `network`: mặc định tắt;
- `memory`, `cpus`: tùy chọn.

Cấu hình qua `PUT /projects/:id/validation-sandbox` (role owner) hoặc lúc tạo project. Image phải là một tham chiếu hợp lệ, không chứa ký tự mà shell có thể diễn giải.

Khi `validationSandbox` được đặt, runner chạy **từng bước** validation như sau:

```text
<runtime> run --rm --name mar-validate-… --network none --cap-drop ALL
  --security-opt no-new-privileges [--memory] [--cpus] [--user uid:gid trên POSIX]
  -v <worktree>:/workspace -w /workspace -e CI=true <image> sh -c "<command>"
```

- `runtime` lấy từ `containerRuntime` trong config runner, mặc định `docker` (podman tương thích).
- Hết thời gian hoặc bị cancel: runner `kill` container theo tên, rồi kill tiến trình CLI.
- **Fail closed:** nếu runtime không khởi động được, bước đó thất bại với thông báo "failed to start". Runner không bao giờ lặng lẽ chạy trên host thay vào đó.
- Span của mỗi bước có attribute `mar.validation.image`.

### agy unattended (opt-in theo runner)

`agents.<id>.unattended: true` cho adapter `antigravity` thêm cờ `--sandbox` (hạn chế terminal của agy) và `--dangerously-skip-permissions`:
- **Chỉ áp dụng khi có policy hook.** Nếu runner tắt `policyHook` thì cờ này bị bỏ qua.
- Chỉ áp dụng cho task được sửa code. Task read-only vẫn dùng `--mode plan`.

Hook PreToolUse vẫn quyết định từng tool call. Lệnh rủi ro HIGH vẫn bị chặn và trở thành approval.

## Consequences

- Kiểm chứng thật (agy 1.2.14, Windows, LP-14 trên `mar-sandbox`):
  - Ở chế độ unattended, agy **tự chạy được** `npm test`, `git status`, `git diff`. Trước đây mọi lệnh shell đều bị chặn.
  - Policy hook vẫn chặn `curl` (HIGH, network) → approval → `WAITING_FOR_HUMAN`. Người reject, agy hoàn thành mà không dùng mạng. PR #24 được duyệt.
  - Lần chạy lệnh đầu tiên trong sandbox của agy (Windows AppContainer) lỗi `createAppContainer: ShellExecute failed: The operation was canceled by the user`; agy tự thử lại và thành công.
- Validation trong container: phần tạo tham số và đường fail-closed có test. Test chạy thật với Docker tự bỏ qua khi Docker không khởi động được container. Trong môi trường phát triển hiện tại, Docker Desktop không start được container nào, kể cả `docker run --rm node:22-alpine node --version`, nên phần này chưa được chạy thật. **Cập nhật 2026-10-01:** sau khi Docker được khởi động lại, đã chạy thật (LP-39, PR #39): `npm test` trong `node:22-alpine`, 136 test và 0 skipped, secret validation đi vào qua `-e NAME`. Bộ test Docker giờ không còn bị skip.
- Worktree là git worktree: file `.git` trỏ tới repo trên host, nên lệnh `git` bên trong container không dùng được. Các bước validation không nên cần git.
- Trên Docker Desktop (Windows/macOS), file do container ghi vào worktree mang quyền của user host. Trên Linux, runner chạy container bằng uid:gid của chính nó.
