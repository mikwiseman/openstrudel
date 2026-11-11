# Sales employee

An employee that keeps a small team's sales from going quiet. It does not sell and does not write to clients. It reads the company's own records and tells the owner of each promise or deal what to do and why, on the day it is due.

- `soul.md` is the employee's profile: where the records are, how it keeps the list of promises made on calls, when it reminds, how it answers a question about a client, and when it may change the database.
- `morning.md` is the prompt of its working-day schedule: at most four lines, each naming the person, the client, one action and the dated fact behind it. A day with nothing due sends nothing.
- `weekly.md` is the prompt of its weekly schedule: money received, owed and expected next week; open, overdue and finished promises; the pipeline by stage and what changed; and numbered corrections to the database.

**Promises.** Every call ends with next steps, and before this nobody carried them. The employee reads each meeting card from the company's meeting feed and keeps one list of open promises per client in `sales/promises.json`. It keeps only steps that cross the boundary with the client, such as a message, a call, an offer, an invoice, or an answer, signature or payment from the client. Each has a real person as owner, a calendar date, and the price and terms named on that call. It reminds only about promises and deal steps that have a date. It reminds once on the date and once more two working days later. After five working days with no later mention, the promise is closed as stale. An owner closes or moves a promise by replying to the reminder: «1 сделано», «2 на 20.11».

**Money.** Received money comes from the payments journal and from money that reached the company's bank accounts but is not recorded yet, so the weekly review shows both. Owed money is counted only from invoices, signed acts and contract terms.

The employee keeps no copy of the database. Deals, invoices, payments and meetings are read from the company tools on every run. Its own notes in `sales/` are the promise list, a log of other reminders, a pipeline snapshot, and `feedback.md` with who is who behind meeting accounts, the main clients of the month and the owners' standing rules. Client facts live only there, never in this folder.

It proposes corrections to the database and writes one only when an owner says so. A scheduled run never writes to the database.

Apply the profile to one employee in the work domain and create the two schedules disabled. Before enabling them, build the promise list from recent meetings and check a sample against the meeting cards. Then ask a real question about one client, send one morning message and one weekly review to the owner's private chat, and check every line against the records.
