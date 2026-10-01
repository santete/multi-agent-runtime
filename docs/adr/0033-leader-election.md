# ADR-0033: Leader election cho công việc nền của control plane

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0032 ghi nhận một giới hạn: control plane chỉ nên chạy một instance. API thì chạy nhiều instance được: mọi thay đổi nằm trong transaction, runner claim việc bằng `FOR UPDATE SKIP LOCKED`, và đổi state có optimistic lock. Nhưng các vòng lặp nền thì mỗi instance tự chạy một bản:

- `sweep` an toàn vì đã dùng `SKIP LOCKED`.
- `processMergeQueue` không có lock: hai instance cùng gọi merge một PR, cùng ghi event.
- `notifier.poll` đọc chung một con trỏ event, nên **mỗi thông báo bị gửi hai lần**.
- `checkMergedCommits` và `escalateStuck` có thể ghi trùng event. Với self-healing `revert`/`fix`, nó còn có thể mở hai PR revert hoặc tạo hai task sửa.
- `migrate()` cũng chưa có lock: hai instance khởi động cùng lúc trên một DB mới, hoặc khi deploy bản có migration, thì cùng chạy một migration và một bên crash.

Muốn scale ngang hay có dự phòng (HA), cần bảo đảm công việc nền chỉ chạy ở một nơi tại một thời điểm.

## Decision

- **`Db.leaderLock(name)`**:
  - Trên Postgres: một session advisory lock (`pg_try_advisory_lock`, key là hash FNV-1a 64 bit của tên) nằm trên một **kết nối riêng**, không dùng chung pool.
  - Trước mỗi lượt việc nền, `hold()` lấy lock nếu đang trống, hoặc kiểm tra kết nối giữ lock còn sống (`select 1`).
  - Nếu kết nối chết (process crash, mất mạng), Postgres tự nhả lock và instance khác lấy được ở lượt sau. Instance cũ thấy mất kết nối thì chuyển sang standby và không giành lại.
  - Trên PGlite (một process) thì luôn là leader.
- **`Background`** (`background.ts`) gom mọi việc nền: sweep, merge queue, sức khỏe nhánh base, escalation, thông báo.
  - Mỗi lượt chỉ chạy khi giữ được lock `background`. Các lần kiểm tra quyền leader được xếp hàng, nên hai vòng lặp không mở hai kết nối giữ lock.
  - Lúc vừa trở thành leader, nó gia hạn lease cho các execution đang chạy, vì trong khoảng không có leader thì không instance nào sweep.
  - Mọi instance vẫn phục vụ API.
- **`/health`** trả thêm `role: "leader" | "standby"`, để load balancer hoặc monitoring biết instance nào đang chạy việc nền.
- **`migrate()`**: mỗi bước chạy trong transaction có `pg_advisory_xact_lock` và kiểm tra lại `schema_migrations` bên trong transaction, nên mỗi migration chỉ được áp dụng đúng một lần dù nhiều instance khởi động cùng lúc.

## Consequences

- Chạy được nhiều control plane trên một Postgres: mọi instance phục vụ API, một instance chạy việc nền, và failover tự động trong vòng một chu kỳ sweep (mặc định 5 giây).
- Khi chạy nhiều instance, nên đặt `MAR_PUBLIC_URL`, để link trong thông báo trỏ tới địa chỉ chung (load balancer) chứ không trỏ tới instance đang là leader.
- Có một khoảng chồng lấn rất ngắn: một lượt việc nền đang chạy dở khi leader vừa mất kết nối giữ lock vẫn chạy cho xong. Các thao tác đều có transaction và optimistic lock, nên trường hợp xấu nhất là một event trùng, không hỏng dữ liệu.
- PGlite vẫn chỉ dành cho một process, như trước.
- Đã kiểm chứng:
  - Test trên Postgres thật (container `postgres:16-alpine`):
    - lock chuyển giao khi được nhả;
    - cắt kết nối của leader thì instance khác lên thay;
    - hai `Background` trên cùng DB: merge queue chỉ chạy ở leader, webhook chỉ gửi một lần, cả trước và sau failover;
    - ba instance cùng migrate một DB mới thì mỗi migration chỉ được áp dụng một lần.
  - Chạy thật trên `mar-sandbox`, với hai control plane A và B trên một Postgres:
    - Runner nối vào B (standby) và Claude làm HA-1. Thông báo "Review needed" đến **một lần**, do A (leader) gửi.
    - Giết hẳn process A (giả lập crash): B nhận quyền leader trong chưa tới 8 giây.
    - Duyệt task qua B: B merge PR #42.
    - Khởi động lại A: A về standby, không chạy lại migration. Tổng cộng chỉ có một thông báo.
