# ADR-0036: Command Code adapter

- Status: Accepted
- Date: 2026-10-05

## Context

Command Code (`command-code`, npm package `command-code`) là agent CLI thứ năm. Spike trên bản 1.5.0, Windows 11 (xem [adapter capability matrix](../spikes/adapter-capability-matrix.md), mục Command Code):

- Headless: `-p --output-format json`, prompt qua stdin. Output là NDJSON gồm các dòng `{"type":"event","event":{…}}` (`run_start`, `message_end`, `tool_queued`, `tool_completed`, `tool_errored`, `tool_hook_blocked`, `tool_denied`, `run_error`, cùng nhiều delta) và một dòng cuối `{"type":"result","subtype":"success"|"error"|"max_turns", sessionId, usage, durationMs, finalText}`.
- PreToolUse hook theo định dạng Claude (`tool_name`, `tool_input` → `hookSpecificOutput.permissionDecision`). Hook được đọc từ `<cwd>/.commandcode/settings.local.json`, `<cwd>/.commandcode/settings.json` và `~/.commandcode/settings.json`. Hook chạy được cả khi project chưa được trust.
- **Env của hook bị lọc:** mọi biến có tên khớp `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `OAUTH`, `CREDENTIAL`, `PRIVATE_KEY`, `AUTH`, `AWS_…` đều bị bỏ. Hook vì vậy mất `MAR_EXECUTION_TOKEN` và từ chối mọi lời gọi (lỗi này lộ ra ở lần chạy thật đầu tiên). Hook cũng mất `MAR_SECRET_NAMES` và giá trị secret của project, nên không còn phát hiện được lời gọi nào chứa secret.
- **Mặc định, hook lỗi thì tool vẫn chạy.** Hook crash hay timeout chỉ chặn tool call khi hook đó có `"failClosed": true`.
- **Ở chế độ `-p`, ghi file và chạy lệnh luôn bị từ chối** ("requires permissions. Use --yolo …"), dù permission mode là `auto-accept` hay hook đã trả `allow`. Chỉ `--yolo` mới mở được. Khi có `--yolo`, hook `deny` vẫn chặn được.
- `--permission-mode plan` chỉ đưa cho agent các tool đọc.
- Không có `--json-schema`, cũng không có cách truyền system prompt khi chạy `-p`.
- Tên tool: `read_file`, `read_multiple_files`, `read_directory`, `write_file`, `edit_file`, `shell_command`, `web_fetch`, `web_search`…
- Usage tính bằng token, không có USD.
- "Taste learning" (học thói quen code từ các phiên chạy) bật theo mặc định. `--config <key=value>` **ghi hẳn vào file settings** chứ không chỉ áp dụng cho một lượt chạy. Project có thể tắt taste learning bằng `tasteLearning: false` trong `settings.local.json`.
- Binary trên Windows: npm shim `command-code.cmd`. Tên lệnh ngắn `cmd` trùng với `cmd.exe`.

## Decision

Package `@mar/adapter-command-code`, `id = "command-code"`, capability `pre-tool-hook`, resume, structured output, `costReporting: false`.

- **Command:** `command-code -p --output-format json --skip-onboarding --no-auto-update` cộng thêm:
  - edit có policy hook: `--yolo`. Hook là lớp quyết định mọi lời gọi, giống Claude. Đây là cách duy nhất để agent sửa code khi chạy headless.
  - edit không có hook (runner tắt `policyHook`): `--permission-mode auto-accept`. Agent chỉ đọc được, mọi lời gọi ghi hay chạy lệnh đều bị báo là bị từ chối. Adapter không bao giờ dùng `--yolo` khi thiếu hook.
  - read-only (review, planner, critic): `--permission-mode plan`, không `--yolo`.
  - `--resume <session>`, `--model`.
- **Workspace file** `.commandcode/settings.local.json` (merge JSON, runner thêm vào `info/exclude`) gồm `tasteLearning: false` và PreToolUse hook dialect `claude` với `failClosed: true`.
- **`MAR_HOOK_CONTEXT`:** adapter đưa các biến bị lọc (execution token, `MAR_SECRET_NAMES`, giá trị secret) vào một biến JSON có tên không bị lọc. Policy hook đọc biến này và chỉ bổ sung những biến còn thiếu. JSON hỏng thì hook từ chối lời gọi. Cách này không làm lộ thêm gì, vì agent vốn đã có đủ các biến đó trong env của nó.
- **Structured output:** schema được nối vào cuối prompt. Parser đọc JSON từ `finalText` bằng `parseJsonAnswer`; không đọc được thì giữ nguyên text.
- **Sửa JSON** (runner, cho các adapter có capability `promptedSchema`, tức Qoder và Command Code): nếu đã yêu cầu structured output mà câu trả lời không phải JSON object hợp lệ, runner resume đúng session đó **một lượt**, kèm lỗi parse, để agent tự sửa. Kết quả sửa xong thay cho câu trả lời cũ; token và chi phí được cộng dồn, lời gọi bị từ chối ở cả hai lượt vẫn được tính. Prompt sửa có kèm đoạn văn bản quanh chỗ lỗi. Ngoài ra `parseJsonAnswer` (core) thử thêm một bản đã cân bằng ngoặc: thêm các dấu `]`/`}` còn thiếu, bỏ qua nội dung trong chuỗi. Khi chạy thật, planner (deepseek) đóng mảng `acceptanceCriteria` bằng `}`, và lặp lại đúng lỗi đó khi được yêu cầu sửa. Cân bằng ngoặc cứu được cả ba câu trả lời hỏng ghi lại được. Bước sửa cũng chạy khi câu trả lời thiếu các trường `required` ở cấp ngoài cùng của schema: có lần planner trả lại chính bản schema.
- **Parser:** `tool_hook_blocked` và `tool_denied` thành `permission_denied`, với lý do lấy từ hook (bỏ đoạn hướng dẫn mà Command Code nối thêm). Riêng lời từ chối do chính Command Code đưa ra (event `tool_denied` của plan mode, hoặc thông báo "requires permissions. Use --yolo" của chế độ `-p`) chỉ là tool call thất bại, không tính là policy từ chối. Nó xảy ra khi planner hay reviewer read-only thử chạy lệnh shell, và agent sẽ tự làm cách khác. Run có lời gọi bị chặn không được tính là success. `subtype: "error"` thành `failed`. `max_turns` thành completed nhưng không success. Thông báo `info` (ví dụ cập nhật phiên bản) bị bỏ qua.
- **Policy** (core): `shell_command` thuộc nhóm shell, `write_file` thuộc nhóm ghi (`edit_file` đã có từ trước). Nhờ vậy các rule về lệnh, mạng, secret và vùng file áp dụng được cho Command Code.

## Consequences

- Chạy thật trên `mar-sandbox`: xem development plan, mục Command Code.
- Hook trong `~/.commandcode/settings.json` của máy runner vẫn được nạp, vì không có flag nào để bỏ setting của user. Muốn cô lập thì phải chạy với `HOME`/`USERPROFILE` riêng, nhưng khi đó đăng nhập (`~/.commandcode/auth.json`) cũng mất, trừ khi dùng `COMMAND_CODE_API_KEY`. Hiện tại máy dev không có settings của user nên chưa làm.
- `--no-auto-update` không ngăn được thông báo "installing in the background", nên CLI có thể tự nâng phiên bản giữa các lượt chạy. Định dạng stream có thể đổi theo phiên bản: fixture ghi lại bản 1.5.0.
- Chi phí chỉ ước tính được từ token qua `pricing` trong runner config.
- **Inbox** (control plane, dùng chung): task `WAITING_FOR_HUMAN` mà không có approval hay câu hỏi nào đang chờ, ví dụ vì một lời gọi bị từ chối hẳn, sẽ hiện ở mục "Stopped, nothing to approve" (`GET /stuck-tasks`) kèm lý do, nút Retry và Cancel. Lần chạy thật đã lộ ra trường hợp này: task chờ người nhưng Inbox trống. Huỷ hoặc retry task thì approval và câu hỏi đang chờ của nó chuyển sang `withdrawn`. Migration 026 dọn những cái còn sót lại từ trước.
- Nếu runner tắt policy hook, Command Code không ghi file hay chạy lệnh được, và các lời gọi đó chỉ hiện thành tool lỗi. Agent kiểu này chỉ có ích khi có hook.
