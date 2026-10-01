# ADR-0030: Các success metric của sản phẩm

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §64 liệt kê 5 nhóm metric: collaboration, engineering, automation, reliability và platform. Trước ADR này, `/agents/stats` (ADR-0020) đã có tỉ lệ thành công, validation, review và rework **theo từng agent**. Các metric còn lại chưa có ở đâu: handoff, context reuse, can thiệp của người, tự xử lý, phục hồi, resume, workspace, latency điều phối.

## Decision

`GET /metrics?projectId&days=30` tính mọi metric từ event log, executions và artifacts. Kết quả theo project, hoặc theo mọi thứ người gọi thấy được trong org của mình. Mỗi tỉ lệ đi kèm `numerator`/`denominator`, và `value: null` khi không đo được gì.

Một task được tính khi nó **kết thúc** trong cửa sổ thời gian, tức là COMPLETED hoặc BLOCKED. Task CANCELLED là quyết định của người nên không tính. Execution và artifact được tính khi chúng được tạo trong cửa sổ.

| Metric | Định nghĩa |
|---|---|
| handoff success | lần chạy agent của task `work` kết thúc có handoff với summary (bỏ qua lần bị ngắt hay bị hủy, và lần revalidation) |
| context reuse | lần claim task `work` có knowledge hoặc handoff của dependency. `ExecutionAssigned` giờ ghi thêm `kind`, `knowledge`, `dependencies`; event cũ không có các trường này nên không được tính |
| agent-to-agent handoff | task có dependency do agent khác làm, được merge |
| task success | merged / (merged + blocked) |
| validation pass | lần validation pass |
| rework | task đã qua REWORK ít nhất một lần |
| review rejection | review (của người hoặc agent) yêu cầu sửa |
| mean completion | thời gian từ lúc tạo đến lúc merge |
| human intervention | task mà người phải làm **nhiều hơn review**: approval, trả lời câu hỏi, task bị BLOCKED, retry tay, instruction, pause, reject review |
| auto-resolution | task từng vào REWORK hoặc RETRYING mà vẫn merge được, không cần người can thiệp |
| autonomous completion | task merge mà không người nào động vào, kể cả review |
| failure recovery | task có agent hoặc runner thất bại (terminal failed, hoặc lost) mà vẫn merge được; validation thất bại thì tính là rework |
| resume success | lần chạy resume session mà không thất bại |
| workspace failure | lần chạy hỏng ở bước chuẩn bị workspace |
| platform | số agent được tích hợp (các id trên runner), runner online, số session hiện tại và đỉnh trong cửa sổ, số project, thời gian chờ trong queue (READY → ASSIGNED), thời gian dispatch (assigned → agent bắt đầu, gồm cả chuẩn bị workspace) |

UI có trang **Metrics**: chọn project và cửa sổ thời gian; mỗi số có tooltip giải thích định nghĩa, và các tỉ lệ xấu được tô màu cảnh báo.

## Consequences

- Metric được tính lúc gọi API, không lưu sẵn. Với khối lượng hiện tại thì đủ nhanh. Khi dữ liệu lớn, có thể chuyển sang tổng hợp theo ngày.
- Tính trên dữ liệu thật của project LP trong 90 ngày, các con số khớp với thực tế:
  - task success 19/19, rework 3/19, validation pass 25/27;
  - human intervention 5/19: các lần chạy có approval, câu hỏi, instruction hoặc pause;
  - autonomous completion 0/19, vì mọi PR đều do người review;
  - resume success 13/16;
  - thời gian hoàn tất trung bình khoảng 13 phút; chờ trong queue khoảng 1 phút, gồm cả thời gian chờ do path ownership và giới hạn concurrency.
