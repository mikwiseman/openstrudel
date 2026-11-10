const METRICS = [
  { id: "calm", name: "Calm", description: "How calm your day felt", low: "1 · hectic", high: "10 · calm" },
  { id: "focus", name: "Focus", description: "How much of your plan you finished", low: "1 · little finished", high: "10 · plan finished" },
  { id: "energy", name: "Energy", description: "How energetic you feel", low: "1 · drained", high: "10 · energized" },
  { id: "mood", name: "Mood", description: "How good you feel", low: "1 · low", high: "10 · great" },
];
const $ = (id) => document.getElementById(id);
const telegram = window.Telegram?.WebApp;
const state = { data: null, person: null, metric: "calm", period: 7, draft: {}, saving: false };
const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const hasScore = (value) => typeof value === "number" && Number.isFinite(value);
const scoreText = (value) => hasScore(value) ? numberFormat.format(value) : "—";
const dateValue = (date) => new Date(`${date}T12:00:00Z`);
const dateText = (date, options = { day: "numeric", month: "long" }) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(dateValue(date));
const shiftDate = (date, days) => new Date(dateValue(date).getTime() + days * 86400000).toISOString().slice(0, 10);
const isReportingDay = (date) => dateValue(date).getUTCDay() !== 6;
const previousReportingDay = (date) => { let day = shiftDate(date, -1); while (!isReportingDay(day)) day = shiftDate(day, -1); return day; };
const own = () => state.person === String(state.data?.viewerId);
const valuesOn = (date, person = state.person) => state.data?.days.find((day) => day.date === date)?.values?.[person] ?? {};
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function applyTheme() {
  const dark = telegram?.initData ? telegram.colorScheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const color = dark ? "#171d1a" : "#f5f3ed";
  document.querySelector('meta[name="theme-color"]').content = color;
  if (telegram?.isVersionAtLeast?.("6.1")) { try { telegram.setHeaderColor(color); telegram.setBackgroundColor(color); } catch {} }
  if (telegram?.isVersionAtLeast?.("7.10")) { try { telegram.setBottomBarColor(color); } catch {} }
}
function safeArea() {
  const top = Math.max(telegram?.safeAreaInset?.top ?? 0, telegram?.contentSafeAreaInset?.top ?? 0);
  const bottom = Math.max(telegram?.safeAreaInset?.bottom ?? 0, telegram?.contentSafeAreaInset?.bottom ?? 0);
  document.documentElement.style.setProperty("--safe-top", `max(env(safe-area-inset-top, 0px), ${top}px)`);
  document.documentElement.style.setProperty("--safe-bottom", `max(env(safe-area-inset-bottom, 0px), ${bottom}px)`);
}
function haptic(kind = "selection") {
  try {
    if (kind === "success") telegram?.HapticFeedback?.notificationOccurred("success");
    else telegram?.HapticFeedback?.selectionChanged();
  } catch {}
}
function showGate(kind) {
  $("dashboard").hidden = true;
  $("gate").hidden = false;
  $("retry").hidden = kind !== "network";
  $("open-telegram").hidden = kind === "network" || kind === "loading";
  $("gate-note").hidden = kind === "loading";
  $("gate-eyebrow").textContent = kind === "forbidden" ? "WAI HQ MEMBERS ONLY" : "A MOMENT FOR YOURSELF";
  $("gate-title").replaceChildren();
  const title = kind === "network" ? ["Could not", "load your day."] : kind === "expired" ? ["Let’s", "open it again."] : ["Less bustle.", "More life."];
  $("gate-title").append(document.createTextNode(title[0]), document.createElement("br"), document.createTextNode(title[1]));
  $("gate-copy").textContent = {
    loading: "Opening your day…",
    outside: "Calm, focus, energy and mood in one place. Open Exhale from Wolf’s menu in Telegram.",
    expired: "Your session expired. Close the app and reopen Exhale from Wolf’s menu in Telegram.",
    forbidden: "This space is for WAI HQ members. Use your Telegram account to open it.",
    network: "Could not load your ratings. Check your connection and try again.",
  }[kind];
}

async function request(method = "GET", body) {
  const response = await fetch("./api", {
    method,
    headers: { Authorization: `tma ${telegram?.initData ?? ""}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = new Error("request_failed");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function acceptData(data, resetDraft = false) {
  if (!Array.isArray(data?.days) || !Array.isArray(data?.participants) || typeof data.today !== "string" || !data.viewerId) throw new Error("invalid_response");
  const oldDate = state.data?.today;
  state.data = data;
  data.days = [...data.days].sort((a, b) => a.date.localeCompare(b.date));
  data.participants = data.participants.map((person) => ({ ...person, id: String(person.id) }));
  if (!state.person || !data.participants.some((person) => person.id === state.person)) state.person = String(data.viewerId);
  if (resetDraft || oldDate !== data.today) state.draft = { ...valuesOn(data.today, String(data.viewerId)) };
  render();
}

async function load() {
  if (!telegram?.initData) { showGate("outside"); return; }
  showGate("loading");
  try { acceptData(await request(), true); }
  catch (error) { showGate(error.status === 401 ? "expired" : error.status === 403 ? "forbidden" : "network"); }
}

function personName(person) {
  const name = person?.name ?? "Participant";
  return (name === "Mik Wiseman" || name === "Мик") ? "Mik" : ["Grisha Ottens", "Grigoriy Ottens", "Гриша"].includes(name) ? "Grisha" : name;
}
function renderPeople() {
  $("people").replaceChildren(...state.data.participants.map((person) => {
    const button = element("button", "", personName(person));
    button.type = "button";
    button.setAttribute("aria-pressed", String(person.id === state.person));
    button.addEventListener("click", (event) => {
      if (state.person === person.id || state.saving) return;
      state.person = person.id;
      haptic();
      render();
      if (event.detail === 0) $("people").querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    });
    return button;
  }));
}

function setOutput(metric, value) {
  const output = $(`output-${metric.id}`);
  output.replaceChildren(document.createTextNode(scoreText(value)), element("span", "", "/10"));
  const range = $(`range-${metric.id}`);
  range?.setAttribute("aria-valuetext", hasScore(value) ? `${value} out of 10` : "Not selected");
  if (range) range.style.setProperty("--value", hasScore(value) ? `${(Math.max(1, value) - 1) / 9 * 100}%` : "0%");
  $(`metric-${metric.id}`).classList.toggle("unanswered", !hasScore(value));
}
function selectScore(metric, input) {
  const value = Number(input.value);
  if (state.draft[metric.id] !== value) haptic();
  state.draft[metric.id] = value;
  setOutput(metric, value);
  updateSave();
}

function renderToday() {
  const isOwn = own();
  const todayScores = valuesOn(state.data.today);
  const todayCount = METRICS.filter((metric) => hasScore(todayScores[metric.id])).length;
  const person = state.data.participants.find((entry) => entry.id === state.person);
  $("today-date").textContent = `${dateText(state.data.today)} · ${dateText(state.data.today, { weekday: "short" })}`;
  $("today-date").dateTime = state.data.today;
  $("today-state").textContent = todayCount === 4 ? "Day recorded" : todayCount ? `${todayCount} of 4` : "Today";
  $("today-title").replaceChildren();
  if (isOwn) $("today-title").append(document.createTextNode("How are you"), document.createElement("br"), document.createTextNode("today?"));
  else $("today-title").textContent = `${personName(person)} today`;
  $("today-intro").textContent = isOwn ? "From 1 to 10. Higher is better." : "Four sides of one day.";
  $("save-area").hidden = !isOwn;
  $("other-note").hidden = isOwn;
  if (!isOwn) {
    const latest = [...state.data.days].reverse().find((day) => isReportingDay(day.date) && METRICS.some((metric) => hasScore(day.values?.[state.person]?.[metric.id])));
    $("other-note").textContent = todayCount ? "Everyone records their own day." : latest ? `No ratings today yet. Latest entry: ${dateText(latest.date)}.` : "No ratings yet. Everyone records their own day.";
  }
  $("metrics").replaceChildren(...METRICS.map((metric) => {
    const row = element("div", `metric ${metric.id}${isOwn ? "" : " metric-readonly"}`);
    row.id = `metric-${metric.id}`;
    const header = element("div", "metric-head");
    const title = element("div");
    const label = element(isOwn ? "label" : "span", "metric-label", metric.name);
    if (isOwn) label.htmlFor = `range-${metric.id}`;
    const description = element("span", "metric-description", metric.description);
    description.id = `description-${metric.id}`;
    title.append(label, description);
    const output = element("output", "metric-output");
    output.id = `output-${metric.id}`;
    if (isOwn) output.setAttribute("for", `range-${metric.id}`);
    header.append(title, output);
    row.append(header);
    if (isOwn) {
      const wrap = element("div", "range-wrap");
      const input = element("input");
      input.type = "range";
      input.id = `range-${metric.id}`;
      input.min = "1";
      input.max = "10";
      input.step = "1";
      input.value = String(hasScore(state.draft[metric.id]) ? Math.max(1, state.draft[metric.id]) : 5);
      input.setAttribute("aria-describedby", description.id);
      input.addEventListener("input", () => selectScore(metric, input));
      // A tap on the untouched thumb is an explicit choice too.
      input.addEventListener("click", () => selectScore(metric, input));
      const limits = element("div", "scale-labels");
      limits.setAttribute("aria-hidden", "true");
      limits.append(element("span", "", metric.low), element("span", "", metric.high));
      wrap.append(input, limits);
      row.append(wrap);
    }
    return row;
  }));
  for (const metric of METRICS) setOutput(metric, isOwn ? state.draft[metric.id] : todayScores[metric.id]);
  updateSave();
}

function updateSave(message) {
  const complete = METRICS.every((metric) => Number.isInteger(state.draft[metric.id]) && state.draft[metric.id] >= 1 && state.draft[metric.id] <= 10);
  const existing = valuesOn(state.data.today, String(state.data.viewerId));
  const unchanged = METRICS.every((metric) => existing[metric.id] === state.draft[metric.id]);
  $("save").disabled = !complete || unchanged || state.saving;
  $("save").setAttribute("aria-busy", String(state.saving));
  $("save-label").textContent = state.saving ? "Saving…" : complete && unchanged ? "Day saved" : !complete ? "Rate all four" : METRICS.some((metric) => hasScore(existing[metric.id])) ? "Save changes" : "Save my day";
  $("save-status").classList.remove("error");
  $("save-status").textContent = message ?? "You can edit your ratings throughout the day.";
}

async function save(event) {
  event.preventDefault();
  if (!own() || $("save").disabled) return;
  state.saving = true;
  updateSave();
  for (const input of document.querySelectorAll(".metric input")) input.disabled = true;
  try {
    const data = await request("POST", { date: state.data.today, scores: { ...state.draft } });
    state.saving = false;
    acceptData(data, true);
    updateSave("Saved. Take a breath.");
    haptic("success");
  } catch (error) {
    state.saving = false;
    if (error.status === 401 || error.status === 403) { showGate(error.status === 401 ? "expired" : "forbidden"); return; }
    updateSave();
    for (const input of document.querySelectorAll(".metric input")) input.disabled = false;
    $("save-status").classList.add("error");
    $("save-status").textContent = error.status === 400 || error.status === 422 ? "Choose four ratings from 1 to 10. Check your values." : error.status === 409 ? "The day has changed. Close and reopen the app." : "Not saved. Your choices are still here; try again.";
  }
}

function datesForPeriod() {
  return Array.from({ length: state.period }, (_, index) => shiftDate(state.data.today, index - state.period + 1)).filter(isReportingDay);
}
function calendarStreak() {
  const answered = new Set(state.data.days.filter((day) => isReportingDay(day.date) && hasScore(day.values?.[state.person]?.calm)).map((day) => day.date));
  let date = answered.has(state.data.today) ? state.data.today : previousReportingDay(state.data.today);
  let count = 0;
  while (answered.has(date)) { count += 1; date = previousReportingDay(date); }
  return count;
}
function svgElement(tag, attributes, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderChart(dates, metric) {
  const chart = $("chart");
  const values = dates.map((date) => valuesOn(date)[metric.id]);
  const allValues = values.filter(hasScore);
  chart.replaceChildren(svgElement("title", { id: "chart-title" }, `${metric.name}: last ${state.period} days`), svgElement("desc", { id: "chart-description" }, dates.map((date, index) => `${dateText(date)}: ${hasScore(values[index]) ? values[index] + " out of 10" : "no rating"}`).join(". ")));
  chart.style.setProperty("--chart-color", `var(--${metric.id})`);
  const left = 24, right = 569, top = 20, bottom = 186;
  const x = (index) => left + index / (dates.length - 1) * (right - left);
  const y = (value) => bottom - value / 10 * (bottom - top);
  for (const value of [0, 5, 10]) {
    chart.append(svgElement("line", { x1: left, y1: y(value), x2: right, y2: y(value), class: "chart-grid" }), svgElement("text", { x: 591, y: y(value) + 5, "text-anchor": "end" }, String(value)));
  }
  let segment = [];
  const flush = () => { if (segment.length > 1) chart.append(svgElement("polyline", { points: segment.join(" "), class: "chart-line" })); segment = []; };
  values.forEach((value, index) => {
    if (hasScore(value)) segment.push(`${x(index)},${y(value)}`);
    else flush();
  });
  flush();
  values.forEach((value, index) => {
    const point = hasScore(value) ? svgElement("circle", { cx: x(index), cy: y(value), r: state.period === 7 ? 6.5 : 4.5, class: "chart-dot" }) : svgElement("circle", { cx: x(index), cy: bottom, r: 2.5, class: "chart-gap" });
    point.append(svgElement("title", {}, `${dateText(dates[index])}: ${hasScore(value) ? value + "/10" : "no rating"}`));
    chart.append(point);
    if (state.period === 7 || index === 0 || index === dates.length - 1 || index % 7 === 0 && index < dates.length - 3) {
      chart.append(svgElement("text", { x: x(index), y: 207, "text-anchor": "middle" }, dateText(dates[index], { weekday: "short" })),
        svgElement("text", { x: x(index), y: 225, "text-anchor": "middle" }, dateText(dates[index], { day: "2-digit", month: "2-digit" })));
    }
  });
  $("chart-empty").hidden = Boolean(allValues.length);
  $("average").textContent = allValues.length ? numberFormat.format(allValues.reduce((sum, value) => sum + value, 0) / allValues.length) : "—";
  $("average").style.color = `var(--${metric.id})`;
  $("average-caption").textContent = allValues.length ? `Average · ${allValues.length} ${plural(allValues.length, ["rating", "ratings"])}` : state.period === 7 ? "Over the last 7 days" : "Over the last 30 days";
  $("chart-empty").textContent = own() ? "Your rhythm will appear here.\nStart with one rating." : "No ratings for these days yet.";
  $("chart-empty").style.whiteSpace = "pre-line";
  const latest = [...state.data.days].reverse().find((day) => isReportingDay(day.date) && hasScore(day.values?.[state.person]?.[metric.id]));
  const latestText = latest ? `Latest rating: ${dateText(latest.date)} · ${scoreText(latest.values[state.person][metric.id])}/10. ` : "";
  $("chart-footnote").textContent = latestText + (metric.id === "calm" ? "Historical calm: 10 − bustle. Zero is preserved. Gaps mean no rating. Saturdays are excluded." : "A gap means no rating. Saturdays are excluded.");
}
function plural(number, words) {
  return number === 1 ? words[0] : words[1];
}
function renderHistory() {
  $("metric-tabs").replaceChildren(...METRICS.map((metric) => {
    const button = element("button", metric.id, metric.name);
    button.type = "button";
    button.setAttribute("aria-pressed", String(metric.id === state.metric));
    button.addEventListener("click", (event) => {
      if (state.metric === metric.id) return;
      state.metric = metric.id;
      haptic();
      renderHistory();
      if (event.detail === 0) $("metric-tabs").querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    });
    return button;
  }));
  for (const button of document.querySelectorAll("[data-period]")) button.setAttribute("aria-pressed", String(Number(button.dataset.period) === state.period));
  const dates = datesForPeriod();
  renderChart(dates, METRICS.find((metric) => metric.id === state.metric));
  const streak = calendarStreak();
  $("streak").textContent = String(streak);
  $("streak-caption").textContent = `${streak === 1 ? "workday" : "workdays"} of calm in a row`;
  $("history-rows").replaceChildren(...[...dates].reverse().map((date) => {
    const row = element("tr");
    const label = element("td");
    label.append(element("div", "history-weekday", dateText(date, { weekday: "short" })), element("div", "", dateText(date, { day: "numeric", month: "short" })));
    row.append(label);
    for (const metric of METRICS) {
      const value = valuesOn(date)[metric.id];
      const cell = element("td", hasScore(value) ? metric.id : "missing", scoreText(value));
      if (!hasScore(value)) cell.setAttribute("aria-label", "No rating");
      row.append(cell);
    }
    return row;
  }));
}
function render() {
  $("gate").hidden = true;
  $("dashboard").hidden = false;
  renderPeople();
  renderToday();
  renderHistory();
  $("version").textContent = state.data.version ? `v${state.data.version}` : "";
}

$("check-in-form").addEventListener("submit", save);
$("retry").addEventListener("click", load);
for (const button of document.querySelectorAll("[data-period]")) button.addEventListener("click", () => {
  const period = Number(button.dataset.period);
  if (state.period === period) return;
  state.period = period;
  haptic();
  renderHistory();
});
applyTheme();
safeArea();
telegram?.onEvent?.("themeChanged", applyTheme);
telegram?.onEvent?.("safeAreaChanged", safeArea);
telegram?.onEvent?.("contentSafeAreaChanged", safeArea);
if (!telegram?.initData) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
try { telegram?.ready(); telegram?.expand(); } catch {}
load();
