# ADR-0017: OpenTelemetry — mỗi execution là một trace

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §41 yêu cầu quan sát được hệ thống qua logs, metrics và traces. Event log (ADR-0005) đã ghi lại *cái gì* xảy ra với task. Event log chưa cho thấy thời gian của một execution đi đâu: chuẩn bị worktree, agent chạy, từng bước validation, push và mở PR, các lần gọi GitHub, các lần agent bị policy kiểm tra. Nó cũng không xuất ra được các công cụ quan sát mà team đang dùng (Jaeger, Tempo, Honeycomb, Datadog…).

## Decision

Package `@mar/telemetry` bọc OpenTelemetry SDK:
- **Opt-in:** chỉ bật khi có `OTEL_EXPORTER_OTLP_ENDPOINT` (hoặc biến `…_TRACES_ENDPOINT`). Khi không có, mọi API đều là no-op.
- Exporter OTLP/HTTP dùng các biến `OTEL_*` chuẩn (headers, `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`).
- Service name là `mar-control-plane` và `mar-runner`.

**Một trace cho mỗi execution (lần thử của task).** Runner mở root span `execution <KEY>`, kèm các attribute task, project, attempt, agent, rework và kết quả. Các span con:
- `workspace.prepare`;
- `agent.run`: agent, adapter, resume, kết quả, `gen_ai.usage.input_tokens` / `output_tokens`, chi phí;
- `validation`, với một span `validation.step <name>` cho mỗi bước;
- `delivery`.

Trace không kéo dài theo cả vòng đời task, vì một task có thể chờ người hàng giờ. Các execution của cùng một task được nối với nhau qua attribute `mar.task.id`.

**Lan truyền context:**
- Runner gửi `traceparent` trong mọi lời gọi API. Control plane tạo span SERVER `METHOD /route` làm con của trace đó, và handler chạy trong context của span, nên các span bên trong nằm dưới span request.
- Runner đặt `TRACEPARENT` vào môi trường của agent. Policy hook gửi lại giá trị này, nên mỗi `POST /executions/:id/tool-check` (mỗi tool call của agent) xuất hiện trong trace dưới `agent.run`.
- Lời gọi GitHub là span CLIENT `github METHOD /path`.
- Merge queue tạo một root span `merge_queue <KEY>` cho mỗi lần xử lý task, kèm kết quả: `merged`, `base_changed`, `waiting_for_ci`, `ci_failed`…

**Metrics:**
- `mar.executions`: theo agent và kết quả;
- `mar.execution.duration` (giây);
- `mar.agent.tokens`: input và output;
- `mar.agent.cost` (USD);
- `mar.task.transitions`: from, to, trigger.

Metrics được xuất 15 giây một lần.

## Consequences

- Không cần thêm hạ tầng nếu không dùng. Muốn dùng thì trỏ endpoint vào một OpenTelemetry Collector, Jaeger hay Tempo bất kỳ.
- Lời gọi `claim` diễn ra trước khi execution tồn tại, nên nó là một trace riêng.
- `/stream`, `/health` và file tĩnh của UI không được tạo span.
- Span của agent chỉ có ở mức tool check. Telemetry riêng của từng CLI (ví dụ OTel của Claude Code) không được nối vào trace này.
