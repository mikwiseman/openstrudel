const METRICS = [
  { id: "calm", name: "Спокойствие", low: "1 · суета", high: "10 · спокойно" },
  { id: "focus", name: "Фокус", low: "1 · не сделано", high: "10 · всё готово" },
  { id: "energy", name: "Энергия", low: "1 · без сил", high: "10 · бодро" },
  { id: "mood", name: "Настроение", low: "1 · тяжело", high: "10 · кайф" },
];
const $ = (id) => document.getElementById(id);
const telegram = window.Telegram?.WebApp;
const state = { data: null, person: null, metric: "calm", week: null, draft: {}, saving: false, refreshing: false };
const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const hasScore = (value) => typeof value === "number" && Number.isFinite(value);
const scoreText = (value) => hasScore(value) ? numberFormat.format(value) : "—";
const dateValue = (date) => new Date(`${date}T12:00:00Z`);
const dateText = (date, options = { day: "numeric", month: "short" }) => new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...options }).format(dateValue(date));
const shiftDate = (date, days) => new Date(dateValue(date).getTime() + days * 86400000).toISOString().slice(0, 10);
const isMetricsDay = (date) => dateValue(date).getUTCDay() !== 6;
const weekStart = (date) => shiftDate(date, -((dateValue(date).getUTCDay() + 6) % 7));
const weekDates = (monday) => Array.from({ length: 7 }, (_, index) => shiftDate(monday, index)).filter(isMetricsDay);
function previousMetricsDate(date) { do { date = shiftDate(date, -1); } while (!isMetricsDay(date)); return date; }
const valuesOn = (date, person = state.person) => state.data?.days.find((day) => day.date === date)?.values?.[person] ?? {};
// The oldest week is retained for comparison only. A partial first week is never used as a baseline.
function firstVisibleWeek() {
  const first = state.data.days[0]?.date ?? state.data.today;
  const firstComplete = first === weekStart(first) ? first : shiftDate(weekStart(first), 7);
  return [shiftDate(firstComplete, 7), weekStart(state.data.today)].sort()[0];
}
function metricSummary(metric, monday = state.week) {
  const values = weekDates(monday).filter((date) => date <= state.data.today).map((date) => valuesOn(date)[metric]).filter(hasScore);
  return { n: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}
function calendarStreak() {
  const answered = new Set(state.data.days.filter((day) => isMetricsDay(day.date) && hasScore(day.values?.[state.person]?.calm)).map((day) => day.date));
  let date = isMetricsDay(state.data.today) && answered.has(state.data.today) ? state.data.today : previousMetricsDate(state.data.today);
  let count = 0;
  while (answered.has(date)) { count += 1; date = previousMetricsDate(date); }
  // The API window is bounded: make a still-running series explicitly a lower bound.
  return { count, truncated: count > 0 && date < state.data.days[0]?.date };
}
function plural(number, words) {
  const last = number % 10, two = number % 100;
  return two >= 11 && two <= 14 ? words[2] : last === 1 ? words[0] : last >= 2 && last <= 4 ? words[1] : words[2];
}
const answersText = (n) => `${n} ${plural(n, ["ответ", "ответа", "ответов"])}`;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function applyTheme() {
  const dark = telegram?.initData ? telegram.colorScheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const color = dark ? "#151c24" : "#f5f6f8";
  document.querySelector('meta[name="theme-color"]').content = color;
  if (telegram?.isVersionAtLeast?.("6.1")) { try { telegram.setHeaderColor(color); telegram.setBackgroundColor(color); } catch {} }
  if (telegram?.isVersionAtLeast?.("7.10")) { try { telegram.setBottomBarColor(color); } catch {} }
}
function safeArea() {
  for (const edge of ["top", "bottom", "left", "right"]) {
    const inset = Math.max(telegram?.safeAreaInset?.[edge] ?? 0, telegram?.contentSafeAreaInset?.[edge] ?? 0);
    document.documentElement.style.setProperty(`--safe-${edge}`, `max(env(safe-area-inset-${edge}, 0px), ${inset}px)`);
  }
}
function haptic(kind = "selection") {
  try { if (kind === "success") telegram?.HapticFeedback?.notificationOccurred("success"); else telegram?.HapticFeedback?.selectionChanged(); } catch {}
}
function showGate(kind) {
  $("dashboard").hidden = true;
  $("gate").hidden = false;
  $("retry").hidden = kind !== "network";
  $("open-telegram").hidden = kind === "network" || kind === "loading";
  const copy = {
    loading: ["Загружаем оценки", "Это займёт несколько секунд."],
    outside: ["Открой Выдох в Telegram", "Там доступны оценки и история команды."],
    expired: ["Войди заново", "Закрой приложение и открой его снова в Telegram."],
    forbidden: ["Доступ не настроен", "Оценки доступны только настроенным участникам."],
    network: ["Не удалось загрузить", "Проверь соединение и повтори попытку."],
  }[kind];
  $("gate-title").textContent = copy[0];
  $("gate-copy").textContent = copy[1];
}
async function request(method = "GET", body) {
  const response = await fetch("./api", {
    method, headers: { Authorization: `tma ${telegram?.initData ?? ""}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) { const error = new Error("request_failed"); error.status = response.status; throw error; }
  return response.json();
}
function acceptData(data, resetDraft = false) {
  if (!Array.isArray(data?.days) || !Array.isArray(data?.participants) || typeof data.today !== "string" || !data.viewerId || !data.participants.some((person) => String(person.id) === String(data.viewerId))) throw new Error("invalid_response");
  const oldDate = state.data?.today;
  const dirty = METRICS.some((metric) => state.draft[metric.id] !== valuesOn(oldDate, String(state.data?.viewerId))[metric.id]);
  const wasCurrent = !state.week || state.week === (oldDate && weekStart(oldDate));
  state.data = { ...data, days: data.days.filter((day) => isMetricsDay(day.date) && day.date <= data.today).sort((a, b) => a.date.localeCompare(b.date)), participants: data.participants.map((person) => ({ ...person, id: String(person.id) })) };
  if (!state.person || !state.data.participants.some((person) => person.id === state.person)) state.person = String(data.viewerId);
  if (wasCurrent) state.week = weekStart(data.today);
  if (state.week < firstVisibleWeek()) state.week = firstVisibleWeek();
  if (resetDraft || !dirty || oldDate !== data.today) state.draft = { ...valuesOn(data.today, String(data.viewerId)) };
  render();
}
async function load() {
  if (!telegram?.initData) { showGate("outside"); return; }
  showGate("loading");
  try { acceptData(await request(), true); } catch (error) { showGate(error.status === 401 ? "expired" : error.status === 403 ? "forbidden" : "network"); }
}
async function refresh() {
  if (state.refreshing || state.saving) return;
  state.refreshing = true;
  updateSave();
  $("refresh").disabled = true;
  $("refresh").textContent = "Обновляем…";
  $("refresh-status").hidden = true;
  try { acceptData(await request()); }
  catch (error) {
    if (error.status === 401 || error.status === 403) { showGate(error.status === 401 ? "expired" : "forbidden"); }
    else { $("refresh-status").textContent = "Не удалось обновить. Показаны ранее загруженные оценки. Попробуй ещё раз."; $("refresh-status").hidden = false; }
  } finally { state.refreshing = false; $("refresh").disabled = false; $("refresh").textContent = "Обновить"; updateSave(); }
}
function renderPeople() {
  $("people").replaceChildren(...state.data.participants.map((person) => {
    const button = element("button", "", person.name);
    button.type = "button";
    button.setAttribute("aria-pressed", String(person.id === state.person));
    button.addEventListener("click", (event) => {
      if (state.person === person.id || state.saving) return;
      state.person = person.id; haptic(); render();
      if (event.detail === 0) $("people").querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    });
    return button;
  }));
}
function setOutput(metric, value) {
  $(`output-${metric.id}`).replaceChildren(document.createTextNode(scoreText(value)), element("span", "", "/10"));
  const range = $(`range-${metric.id}`);
  range?.setAttribute("aria-valuetext", hasScore(value) ? `${value} из 10` : "Не выбрано");
  if (range) range.style.setProperty("--value", hasScore(value) ? `${(Math.max(1, value) - 1) / 9 * 100}%` : "0%");
  $(`metric-${metric.id}`).classList.toggle("unanswered", !hasScore(value));
}
function selectScore(metric, input) {
  const value = Number(input.value);
  if (state.draft[metric.id] !== value) haptic();
  state.draft[metric.id] = value; setOutput(metric, value); updateSave();
}
function renderToday() {
  const restDay = !isMetricsDay(state.data.today), editable = !restDay;
  const viewer = state.data.participants.find((person) => person.id === String(state.data.viewerId));
  const scores = valuesOn(state.data.today, viewer.id), count = METRICS.filter((metric) => hasScore(scores[metric.id])).length;
  $("entry-label").textContent = restDay ? "Сегодня суббота · без оценок" : count === 4 ? "Мой день · изменить" : "Мой день · отметить";
  $("today-date").textContent = `${viewer.name} · ${dateText(state.data.today, { day: "numeric", month: "long" })}`;
  $("today-date").dateTime = state.data.today;
  $("today-state").textContent = restDay ? "Пауза" : count === 4 ? "День отмечен" : `${count} из 4`;
  $("today-intro").textContent = "1–10 · больше — лучше";
  $("today-intro").hidden = restDay;
  $("check-in-form").hidden = restDay;
  $("save-area").hidden = !editable;
  $("other-note").hidden = editable;
  $("other-note").textContent = "Суббота не прерывает серию.";
  $("metrics").replaceChildren(...METRICS.map((metric) => {
    const row = element("div", `metric ${metric.id}`); row.id = `metric-${metric.id}`;
    const head = element("div", "metric-head"), label = element(editable ? "label" : "span", "metric-label", metric.name);
    if (editable) label.htmlFor = `range-${metric.id}`;
    const output = element("output", "metric-output"); output.id = `output-${metric.id}`;
    if (editable) output.setAttribute("for", `range-${metric.id}`);
    head.append(label, output); row.append(head);
    if (editable) {
      const input = element("input"); input.type = "range"; input.id = `range-${metric.id}`;
      input.min = "1"; input.max = "10"; input.step = "1";
      input.value = String(hasScore(state.draft[metric.id]) ? Math.max(1, state.draft[metric.id]) : 5);
      input.addEventListener("input", () => selectScore(metric, input));
      input.addEventListener("click", () => selectScore(metric, input));
      const limits = element("div", "scale-labels"); limits.id = `limits-${metric.id}`;
      limits.append(element("span", "", metric.low), element("span", "", metric.high));
      input.setAttribute("aria-describedby", limits.id); row.append(input, limits);
    }
    return row;
  }));
  for (const metric of METRICS) setOutput(metric, editable ? state.draft[metric.id] : scores[metric.id]);
  updateSave();
}
function updateSave(message) {
  const complete = METRICS.every((metric) => Number.isInteger(state.draft[metric.id]) && state.draft[metric.id] >= 1 && state.draft[metric.id] <= 10);
  const existing = valuesOn(state.data.today, String(state.data.viewerId));
  const unchanged = METRICS.every((metric) => existing[metric.id] === state.draft[metric.id]);
  $("save").disabled = !complete || unchanged || state.saving || state.refreshing;
  $("save").setAttribute("aria-busy", String(state.saving));
  $("save-label").textContent = state.saving ? "Сохраняем…" : complete && unchanged ? "День сохранён" : !complete ? "Отметь все четыре" : "Сохранить";
  $("save-status").classList.remove("error");
  $("save-status").textContent = message ?? "Можно изменить до конца дня.";
}
async function save(event) {
  event.preventDefault();
  if (!isMetricsDay(state.data.today) || $("save").disabled) return;
  state.saving = true; updateSave(); $("refresh").disabled = true;
  for (const input of document.querySelectorAll(".metric input")) input.disabled = true;
  try {
    const data = await request("POST", { date: state.data.today, scores: { ...state.draft } });
    state.saving = false; acceptData(data, true); updateSave("Сохранено"); haptic("success");
  } catch (error) {
    state.saving = false;
    if (error.status === 401 || error.status === 403) { showGate(error.status === 401 ? "expired" : "forbidden"); return; }
    updateSave();
    for (const input of document.querySelectorAll(".metric input")) input.disabled = false;
    $("save-status").classList.add("error");
    $("save-status").textContent = error.status === 400 || error.status === 409 || error.status === 422 ? "Не удалось сохранить. Обнови день и проверь оценки от 1 до 10." : "Не удалось подтвердить сохранение. Твои значения остались в форме — повтори попытку.";
  } finally { $("refresh").disabled = false; }
}
function renderCards() {
  $("metric-cards").replaceChildren(...METRICS.map((metric) => {
    const current = metricSummary(metric.id), previous = metricSummary(metric.id, shiftDate(state.week, -7));
    const button = element("button", `metric-card ${metric.id}`); button.type = "button"; button.dataset.metric = metric.id;
    button.setAttribute("aria-pressed", String(state.metric === metric.id)); button.setAttribute("aria-controls", "chart");
    const delta = hasScore(current.mean) && hasScore(previous.mean) ? Math.round((current.mean - previous.mean) * 10) / 10 : null;
    const deltaText = delta === null ? "Нет сравнения" : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${scoreText(Math.abs(delta))} к прошлой · ${answersText(previous.n)}`;
    const change = element("span", "card-delta", deltaText);
    if (delta !== null) change.dataset.direction = delta > 0 ? "up" : delta < 0 ? "down" : "same";
    button.append(element("span", "card-label", metric.name), element("span", "card-value", scoreText(current.mean)), element("span", "card-count", answersText(current.n)), change);
    button.addEventListener("click", (event) => {
      state.metric = metric.id; haptic(); renderHistory();
      if (event.detail === 0) $("metric-cards").querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    });
    return button;
  }));
}
function svgElement(tag, attributes, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderChart(dates, metric) {
  const chart = $("chart"), values = dates.map((date) => valuesOn(date)[metric.id]);
  chart.replaceChildren(svgElement("title", { id: "chart-title" }, `${metric.name}: ${dateText(state.week)} — ${dateText(shiftDate(state.week, 6))}`), svgElement("desc", { id: "chart-description" }, dates.map((date, index) => `${dateText(date)}: ${date > state.data.today ? "день ещё не наступил" : hasScore(values[index]) ? values[index] + " из 10" : "нет оценки"}`).join(". ")));
  chart.style.setProperty("--chart-color", `var(--${metric.id})`);
  const left = 24, right = 327, top = 27, bottom = 139;
  const x = (index) => left + index / (dates.length - 1) * (right - left), y = (value) => bottom - value / 10 * (bottom - top);
  for (const value of [0, 5, 10]) chart.append(svgElement("line", { x1: left, y1: y(value), x2: right, y2: y(value), class: "chart-grid" }), svgElement("text", { x: 352, y: y(value) + 4, "text-anchor": "end" }, String(value)));
  let segment = [];
  const flush = () => { if (segment.length > 1) chart.append(svgElement("polyline", { points: segment.join(" "), class: "chart-line" })); segment = []; };
  values.forEach((value, index) => { if (hasScore(value)) segment.push(`${x(index)},${y(value)}`); else flush(); }); flush();
  values.forEach((value, index) => {
    if (hasScore(value)) {
      const dot = svgElement("circle", { cx: x(index), cy: y(value), r: 4.5, class: "chart-dot" });
      dot.append(svgElement("title", {}, `${dateText(dates[index])}: ${value}/10`)); chart.append(dot);
      chart.append(svgElement("text", { x: x(index), y: y(value) - 10, "text-anchor": "middle", class: "chart-value" }, scoreText(value)));
    } else if (dates[index] <= state.data.today) chart.append(svgElement("text", { x: x(index), y: bottom - 9, "text-anchor": "middle" }, "—"));
    chart.append(svgElement("text", { x: x(index), y: 163, "text-anchor": "middle" }, dateText(dates[index], { day: "numeric", month: "numeric" })), svgElement("text", { x: x(index), y: 180, "text-anchor": "middle" }, dateText(dates[index], { weekday: "short" })));
  });
  $("trend-title").textContent = metric.name; $("chart-count").textContent = answersText(values.filter(hasScore).length);
  $("chart-empty").hidden = values.some(hasScore);
}
function renderHistory() {
  const current = state.week === weekStart(state.data.today);
  $("week-title").textContent = `${dateText(state.week)} — ${dateText(shiftDate(state.week, 6))}`;
  $("week-state").textContent = current ? "Текущая · ещё идёт" : `${dateText(state.week, { year: "numeric" })} · завершена`;
  $("previous-week").disabled = state.week <= firstVisibleWeek(); $("next-week").disabled = current;
  $("current-week").hidden = current;
  renderCards();
  const dates = weekDates(state.week); renderChart(dates, METRICS.find((metric) => metric.id === state.metric));
  const { count, truncated } = calendarStreak();
  $("streak").textContent = `${count}${truncated ? "+" : ""} ${plural(count, ["день", "дня", "дней"])} с оценкой спокойствия подряд`;
  $("history-rows").replaceChildren(...dates.filter((date) => date <= state.data.today).reverse().map((date) => {
    const row = element("tr"); row.append(element("th", "", dateText(date))); row.firstChild.scope = "row";
    for (const metric of METRICS) {
      const value = valuesOn(date)[metric.id], cell = element("td", metric.id, scoreText(value));
      if (!hasScore(value)) cell.setAttribute("aria-label", "Нет оценки"); row.append(cell);
    }
    return row;
  }));
}
function render() {
  $("gate").hidden = true; $("dashboard").hidden = false;
  renderPeople(); renderHistory(); renderToday();
  $("timezone-note").textContent = `Даты по часовому поясу ${state.data.timezone}.`;
}

$("check-in-form").addEventListener("submit", save);
$("retry").addEventListener("click", load);
$("refresh").addEventListener("click", refresh);
for (const [id, step] of [["previous-week", -7], ["next-week", 7], ["current-week", 0]]) $(id).addEventListener("click", () => {
  state.week = step ? shiftDate(state.week, step) : weekStart(state.data.today); haptic(); renderHistory();
});
applyTheme(); safeArea();
telegram?.onEvent?.("themeChanged", applyTheme);
telegram?.onEvent?.("safeAreaChanged", safeArea);
telegram?.onEvent?.("contentSafeAreaChanged", safeArea);
if (!telegram?.initData) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
try { telegram?.ready(); telegram?.expand(); } catch {}
load();
