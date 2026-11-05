const METRICS = [
  { id: "calm", name: "Спокойствие", description: "Насколько спокойно прошёл день", low: "1 · суета", high: "10 · спокойно" },
  { id: "focus", name: "Фокус", description: "Удалось ли сделать запланированное", low: "1 · рассеянно", high: "10 · в фокусе" },
  { id: "energy", name: "Энергия", description: "Насколько бодро ты себя чувствуешь", low: "1 · без сил", high: "10 · бодро" },
  { id: "mood", name: "Настроение", description: "Насколько радостно и кайфово", low: "1 · тяжело", high: "10 · кайф" },
];
const $ = (id) => document.getElementById(id);
const telegram = window.Telegram?.WebApp;
const state = { data: null, person: null, metric: "calm", period: 7, draft: {}, saving: false };
const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const hasScore = (value) => typeof value === "number" && Number.isFinite(value);
const scoreText = (value) => hasScore(value) ? numberFormat.format(value) : "—";
const dateValue = (date) => new Date(`${date}T12:00:00Z`);
const dateText = (date, options = { day: "numeric", month: "long" }) => new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...options }).format(dateValue(date));
const shiftDate = (date, days) => new Date(dateValue(date).getTime() + days * 86400000).toISOString().slice(0, 10);
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
  $("gate-eyebrow").textContent = kind === "forbidden" ? "ТОЛЬКО ДЛЯ СВОИХ" : "МИНУТА ДЛЯ СЕБЯ";
  $("gate-title").replaceChildren();
  const title = kind === "network" ? ["Не удалось", "загрузить день."] : kind === "expired" ? ["Давай", "откроем заново."] : ["Меньше суеты.", "Больше жизни."];
  $("gate-title").append(document.createTextNode(title[0]), document.createElement("br"), document.createTextNode(title[1]));
  $("gate-copy").textContent = {
    loading: "Открываем твой день…",
    outside: "Спокойствие, фокус, энергия и настроение — в одном месте. Открой Выдох через меню Волка в Telegram.",
    expired: "Вход устарел. Закрой приложение и открой Выдох снова через меню Волка в Telegram.",
    forbidden: "Это пространство участников WAI HQ. Для доступа нужен твой Telegram-аккаунт в этой группе.",
    network: "Оценки на месте. Проверь соединение и попробуй ещё раз.",
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
  const name = person?.name ?? "Участник";
  return name === "Mik Wiseman" ? "Мик" : name === "Grisha Ottens" || name === "Grigoriy Ottens" ? "Гриша" : name;
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
  range?.setAttribute("aria-valuetext", hasScore(value) ? `${value} из 10` : "Не выбрано");
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
  $("today-state").textContent = todayCount === 4 ? "День отмечен" : todayCount ? `${todayCount} из 4` : "Сегодня";
  $("today-title").replaceChildren();
  if (isOwn) $("today-title").append(document.createTextNode("Как ты"), document.createElement("br"), document.createTextNode("сегодня?"));
  else $("today-title").textContent = `${personName(person)} сегодня`;
  $("today-intro").textContent = isOwn ? "От 1 до 10. Больше — лучше." : "Четыре стороны одного дня.";
  $("save-area").hidden = !isOwn;
  $("other-note").hidden = isOwn;
  if (!isOwn) {
    const latest = [...state.data.days].reverse().find((day) => METRICS.some((metric) => hasScore(day.values?.[state.person]?.[metric.id])));
    $("other-note").textContent = todayCount ? "Каждый отмечает свой день сам." : latest ? `Сегодня оценок пока нет. Последняя запись — ${dateText(latest.date)}.` : "Оценок пока нет. Каждый отмечает свой день сам.";
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
  $("save-label").textContent = state.saving ? "Сохраняем…" : complete && unchanged ? "День сохранён" : !complete ? "Отметь все четыре" : METRICS.some((metric) => hasScore(existing[metric.id])) ? "Сохранить изменения" : "Сохранить мой день";
  $("save-status").classList.remove("error");
  $("save-status").textContent = message ?? "Оценки можно изменить в течение дня.";
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
    updateSave("Сохранено. Можно выдохнуть.");
    haptic("success");
  } catch (error) {
    state.saving = false;
    if (error.status === 401 || error.status === 403) { showGate(error.status === 401 ? "expired" : "forbidden"); return; }
    updateSave();
    for (const input of document.querySelectorAll(".metric input")) input.disabled = false;
    $("save-status").classList.add("error");
    $("save-status").textContent = error.status === 400 || error.status === 422 ? "Нужны четыре оценки от 1 до 10. Проверь значения." : error.status === 409 ? "День уже сменился. Закрой и снова открой приложение." : "Не сохранилось. Твои оценки здесь — попробуй ещё раз.";
  }
}

function datesForPeriod() {
  return Array.from({ length: state.period }, (_, index) => shiftDate(state.data.today, index - state.period + 1));
}
function calendarStreak() {
  const answered = new Set(state.data.days.filter((day) => METRICS.some((metric) => hasScore(day.values?.[state.person]?.[metric.id]))).map((day) => day.date));
  let date = answered.has(state.data.today) ? state.data.today : shiftDate(state.data.today, -1);
  let count = 0;
  while (answered.has(date)) { count += 1; date = shiftDate(date, -1); }
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
  chart.replaceChildren(svgElement("title", { id: "chart-title" }, `${metric.name}: последние ${state.period} дней`), svgElement("desc", { id: "chart-description" }, dates.map((date, index) => `${dateText(date)}: ${hasScore(values[index]) ? values[index] + " из 10" : "нет оценки"}`).join(". ")));
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
    point.append(svgElement("title", {}, `${dateText(dates[index])}: ${hasScore(value) ? value + "/10" : "нет оценки"}`));
    chart.append(point);
    if (state.period === 7 || index === 0 || index === dates.length - 1 || index % 7 === 0 && index < dates.length - 3) chart.append(svgElement("text", { x: x(index), y: 219, "text-anchor": "middle" }, state.period === 7 ? dateText(dates[index], { day: "numeric" }) : dateText(dates[index], { day: "numeric", month: "numeric" })));
  });
  $("chart-empty").hidden = Boolean(allValues.length);
  $("average").textContent = allValues.length ? numberFormat.format(allValues.reduce((sum, value) => sum + value, 0) / allValues.length) : "—";
  $("average").style.color = `var(--${metric.id})`;
  $("average-caption").textContent = allValues.length ? `Среднее · ${allValues.length} ${plural(allValues.length, ["ответ", "ответа", "ответов"])}` : state.period === 7 ? "За последние 7 дней" : "За последние 30 дней";
  $("chart-empty").textContent = own() ? "Здесь появится твой ритм.\nНачни с одной оценки." : "За эти дни оценок пока нет.";
  $("chart-empty").style.whiteSpace = "pre-line";
  const latest = [...state.data.days].reverse().find((day) => hasScore(day.values?.[state.person]?.[metric.id]));
  const latestText = latest ? `Последняя оценка: ${dateText(latest.date)} · ${scoreText(latest.values[state.person][metric.id])}/10. ` : "";
  $("chart-footnote").textContent = latestText + (metric.id === "calm" ? "Старые оценки: 10 − суета. Ноль сохранён. Пробел — нет ответа." : "Пробел на графике — день без оценки.");
}
function plural(number, words) {
  const last = number % 10, two = number % 100;
  return two >= 11 && two <= 14 ? words[2] : last === 1 ? words[0] : last >= 2 && last <= 4 ? words[1] : words[2];
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
  $("streak-caption").textContent = `${plural(streak, ["день", "дня", "дней"])} с ответом подряд`;
  $("history-rows").replaceChildren(...[...dates].reverse().map((date) => {
    const row = element("tr");
    const label = element("td", "", dateText(date, { day: "numeric", month: "short" }));
    row.append(label);
    for (const metric of METRICS) {
      const value = valuesOn(date)[metric.id];
      const cell = element("td", hasScore(value) ? metric.id : "missing", scoreText(value));
      if (!hasScore(value)) cell.setAttribute("aria-label", "Нет оценки");
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
