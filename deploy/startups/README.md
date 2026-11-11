# Startups desk

A second desk on the tools News uses (`publish_story`, `publish_edition`, `read_news`): one edition a day about new startups, launches and funding.

- `soul.md` is the employee's profile: what it covers, where it looks, how it writes a story.
- `morning.md` is the prompt of its daily schedule.

The employee publishes each startup as a story that stays in the app (`telegram: null`) and then one edition. The application writes the edition's Telegram message from the stories and sends it once per date, the same way it does for News. A story's id is the company's name, so a company that was already shown comes back only as a development of the same story.

There is no collector behind this desk: it reads the launch pages and searches the web during its run. Its reader appears in the app next to News once it has published its first story.
