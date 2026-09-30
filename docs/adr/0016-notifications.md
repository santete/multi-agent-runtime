# ADR-0016: Thông báo qua webhook tương thích Slack

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §31 xác định người là bên có quyền quyết định cuối cùng, và D5 (development plan) đã để việc duyệt qua Slack/Telegram sang Phase 2. Trước ADR này, muốn biết khi nào cần mình (approval HIGH, review, plan chờ duyệt, task bị chặn) thì người dùng phải mở dashboard.

## Decision

Control plane có một **Notifier** đọc event log theo cursor:
- Cursor được lưu trong bảng `event_cursors`, nên khi restart không gửi lặp mà cũng không bỏ sót. Lần chạy đầu tiên bắt đầu từ cuối log, không phát lại lịch sử.
- Sự kiện cần báo được POST `{"text": ...}` (Slack mrkdwn, có link về dashboard) tới từng webhook.

**Các loại thông báo** (`MAR_NOTIFY_EVENTS`, mặc định là 4 loại đầu):

| Loại | Sự kiện |
|---|---|
| `approval` | `ApprovalRequested`: agent muốn chạy lệnh rủi ro HIGH |
| `review` | work task vào `REVIEW` (kèm link PR) |
| `plan` | `PlanProposed`: plan chờ duyệt |
| `blocked` | task vào `BLOCKED` hoặc `WAITING_FOR_HUMAN` |
| `ci` | `CiFailed` (agent đang tự sửa, chỉ để biết) |
| `merged` | `TaskMerged` |

**Cấu hình:**
- `MAR_NOTIFY_WEBHOOKS`: danh sách URL, cách nhau bởi dấu phẩy. Để trống nghĩa là tắt thông báo.
- `MAR_PUBLIC_URL`: base URL dùng trong link. Mặc định là địa chỉ listen.
- `MAR_NOTIFY_INTERVAL_MS`: chu kỳ đọc log, mặc định 3 giây.

**Gửi:**
- Lỗi mạng, 429 hoặc 5xx được retry (1 giây rồi 5 giây). Các 4xx khác không retry.
- Hết lượt retry thì ghi log (chỉ ghi host của webhook, vì URL là secret) rồi đi tiếp. Một webhook hỏng không làm kẹt thông báo cho các webhook khác, cũng không làm kẹt các event sau.

**Vì sao chọn "tương thích Slack":** payload `{text}` được Slack, Mattermost, Rocket.Chat và endpoint `/slack` của Discord chấp nhận. Một webhook là đủ, không cần app, OAuth hay bot token.

## Consequences

- Thông báo chỉ để đọc: muốn approve hay review thì bấm link sang dashboard, nơi có kiểm tra role. Nút bấm ngay trong Slack (interactive message) cần một Slack app có endpoint public và xác thực chữ ký, nên để lại cho sau.
- Thông báo được gửi at-least-once theo từng event. Nếu control plane crash giữa lúc gửi và lúc ghi cursor, event đó có thể được gửi lại một lần.
- Đã kiểm chứng thật bằng một webhook giả lập Slack chạy local (không có workspace Slack thật trong môi trường này):
  - Lượt chạy thật của Claude sinh ra đúng 3 thông báo: approval HIGH cho `curl`, task chờ người, và plan chờ duyệt.
  - Link dashboard đúng, và URL webhook không xuất hiện trong log.
