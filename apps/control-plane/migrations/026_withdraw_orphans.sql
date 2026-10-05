-- Approvals and questions of tasks that were cancelled or finished before anyone
-- answered stayed in the Inbox. Cancelling and retrying now withdraw them; this
-- withdraws the ones left behind earlier.
update approvals set status = 'withdrawn', decided_at = now()
  where status = 'pending' and task_id in (select id from tasks where state in ('COMPLETED', 'CANCELLED'));
update decisions set status = 'withdrawn', answered_at = now()
  where status = 'pending' and task_id in (select id from tasks where state in ('COMPLETED', 'CANCELLED'));
