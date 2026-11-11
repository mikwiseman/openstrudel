# Sales employee

An employee that remembers the sales pipeline for a small team that sells by itself. It does not sell and does not write to clients: it reads the company's own records and tells the owner of each deal who to write to today and why.

- `soul.md` is the employee's profile: where the records are, when a deal needs an action, how to answer a question about a client, and when it may change the database.
- `morning.md` is the prompt of its working-day schedule: next steps that are due, promises made in meetings, unpaid invoices and deals that went quiet, in one message of at most five points. A day with nothing to act on sends nothing.
- `weekly.md` is the prompt of its weekly schedule: the pipeline in numbers, what changed since the last review, where deals stand still, and what to correct in the database.

The employee keeps no copy of the database. Deals, invoices, payments and meetings are read from the company tools on every run (`school_crm_deals_list`, `crm_agenda`, `company_invoices_list`, `company_payments_search`, `company_notifications_list` and their neighbours), so its conversation must reach them. Its own notes live in `sales/` in its working folder: what it has already reminded about, what the owners told it to stop or postpone, and the pipeline snapshot the weekly review compares against.

It proposes corrections to the database and writes one only when an owner says so in the conversation. A scheduled run never writes.

Apply the profile to one employee in the work domain and create the two schedules disabled. Before enabling them, ask the employee a real question about one client, then send one morning message and one weekly review to the owner's private chat and check every line against the records.
