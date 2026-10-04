import { initialState, transition, scenario, restore } from './flow.mjs';

const storageKey = 'openstrudel-cloud-design-v1';
let state = initialState();
let storageAvailable = true;
try { state = restore(localStorage.getItem(storageKey)); } catch { storageAvailable = false; }
const screen = document.querySelector('#screen');
const frame = document.querySelector('.app-window');
const scenarioSelect = document.querySelector('#scenario');
const symbol = '<svg class="symbol" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13 35h22a8 8 0 0 0 1-16 12 12 0 0 0-23-3 9.6 9.6 0 0 0 0 19Z"/><path d="m18 26 4 4 8-8"/></svg>';
const button = (label, action, style = 'primary') => `<button class="${style}" data-action="${action}">${label}</button>`;
const technical = `<details><summary>Подробности размещения</summary><div class="details-body"><p>Сотрудники работают в отдельном облачном пространстве. Настройку и обновления берём на себя. Доступ к своей машине вы сможете получить в любой момент.</p><div class="provider"><strong>Облако OpenStrudel</strong><small>Без отдельной регистрации у провайдера. Подключение готовится.</small></div><div class="provider"><strong>EQVPS</strong><small>Проверяем подходящий тариф с публичным IP. Продажа пока недоступна.</small></div><div class="provider"><strong>Свой аккаунт DigitalOcean</strong><small>Уже доступен в текущем приложении. Оплата напрямую провайдеру.</small></div><p class="fine">В этой демонстрации используется условный тариф. Цена и условия настоящего заказа появятся до оплаты.</p></div></details>`;
const trust = '<p class="footnote">OpenAI подключите лично после настройки. На других устройствах повторный вход не нужен.</p>';
const price = '<p class="price">$19 <span>/ месяц</span></p><p class="fine">Пример тарифа. Подписка ChatGPT оплачивается отдельно.</p>';
const heading = (title, text) => `${symbol}<h1 tabindex="-1">${title}</h1><p class="lead">${text}</p>`;
const steps = () => {
  const active = { creating: 1, installing: 2, checking: 3 }[state.phase] ?? 1;
  return `<ol class="steps">${['Оплата подтверждена', 'Готовим место для команды', 'Устанавливаем OpenStrudel', 'Проверяем подключение'].map((text, i) => `<li class="${i < active ? 'done' : i === active ? 'current' : ''}"><span class="step-icon" aria-hidden="true">${i < active ? '✓' : i + 1}</span><span>${text}${i === active ? '<span class="fine"> · сейчас</span>' : ''}</span></li>`).join('')}</ol>`;
};
const views = {
  offer: () => heading('Ваша команда. Всегда на связи.', 'Сотрудники продолжают работать, даже когда ваш Mac выключен. Мы всё настроим и подключим.') +
    price + '<ul class="benefits"><li>Настройку берём на себя</li><li>Своя команда и история разговоров</li><li>Доступ с Mac, iPhone и iPad</li></ul>' +
    button('Продолжить', 'CHECKOUT') + trust + technical,
  checkout: () => heading('Осталось подтвердить.', 'Команда получит своё место в облаке. После оплаты мы подготовим всё для работы.') + price +
    `<label class="check"><input id="auto-renew" type="checkbox" ${state.autoRenew ? 'checked' : ''}>Продлевать каждый месяц. Можно отменить до следующего списания.</label>` +
    `<p class="fine">${state.autoRenew ? 'Следующее списание через месяц. Продление можно отключить в настройках размещения.' : 'Оплата за один месяц. Перед окончанием срока напомним о продлении. Автоматических списаний нет.'}</p><p class="fine">Данные карты вводятся на защищённой странице оплаты.</p>` +
    button('Перейти к оплате', 'PAYMENT_RETURN') + button('Назад', 'BACK', 'text-button'),
  verifying: () => heading('Проверяем оплату.', 'Вы вернулись из окна оплаты. Ждём подтверждения платёжного сервиса.') +
    '<div class="notice"><p>Повторно платить не нужно. Можно закрыть окно — продолжим с этого места.</p></div>' + button('Проверить статус', 'RETRY_STATUS', 'secondary'),
  paymentFailed: () => heading('Оплата не прошла.', 'Способ оплаты был отклонён. Попробуйте другую карту или вернитесь к этому позже.') +
    '<p class="fine">Сервер ещё не создан. Если банк показывает временную блокировку суммы, проверьте её статус в банке.</p>' +
    button('Вернуться к оплате', 'CHECKOUT') + button('Назад', 'BACK', 'text-button'),
  creating: () => setupView(), installing: () => setupView(), checking: () => setupView(),
  setupDelayed: () => heading('Нужно чуть больше времени.', 'Оплата сохранена. Подготовка команды заняла дольше обычного, мы проверяем её состояние.') +
    '<div class="notice"><p>Не нужно начинать заново или оплачивать ещё раз.</p></div>' + button('Проверить готовность', 'RETRY_STATUS') +
    '<p class="footnote">Если настройка не завершится, предложим восстановление или возврат по условиям заказа.</p>',
  uncertain: () => heading('Уточняем, всё ли готово.', 'Во время подготовки связь прервалась. Проверяем уже оплаченный заказ.') +
    '<div class="notice"><p>Повторного заказа и нового списания не будет.</p></div>' + button('Проверить статус', 'RETRY_STATUS'),
  openai: () => heading('Теперь подключите OpenAI.', 'Войдите в свой аккаунт на сайте OpenAI и разрешите доступ. Он будет использоваться вашей командой в облаке.') +
    '<ul class="benefits"><li>Входите и даёте согласие только вы</li><li>Один вход для всей команды</li><li>На остальных устройствах достаточно подключиться к команде</li></ul>' +
    button('Войти в OpenAI', 'OPENAI_LOGIN') + '<p class="footnote">OpenStrudel не запрашивает пароль от OpenAI.</p>',
  authorizing: () => heading('Завершите вход в браузере.', 'Подтвердите доступ на сайте OpenAI. После этого команда подключится автоматически.') +
    '<p class="fine">Если вход не завершился, вернитесь на предыдущий шаг. Уже готовое облачное пространство сохранится.</p>' +
    button('Вернуться', 'AUTH_CANCELLED', 'secondary'),
  ready: () => heading('Ваша команда готова.', 'Можно поручить ей первую задачу. Вы можете закрыть Mac — работа продолжится в облаке.') +
    '<p class="status">Подключение работает · OpenAI подключён</p>' + button('Открыть команду', 'OPEN_TEAM') +
    '<p class="footnote">На другом устройстве откройте приглашение к этой команде. Повторно входить в OpenAI не нужно.</p>' +
    (state.role === 'owner' ? accountDetails() : '<p class="fine">Размещением и аккаунтом OpenAI управляет владелец команды.</p>'),
  offline: () => heading('Пока нет связи с командой.', 'Проверьте интернет и попробуйте подключиться снова. Новый заказ не нужен.') +
    '<div class="notice"><p>Не отправленные сообщения останутся на устройстве. Состояние работы уточним после подключения.</p></div>' +
    button('Подключиться снова', 'RETRY_STATUS') + accountDetails(),
  authExpired: () => heading('Нужно снова войти в OpenAI.', 'Доступ к аккаунту закончился или был отозван. Новые задачи ждут подключения.') +
    '<p class="lead">Команда, история и облачное пространство сохранены. Подтвердите вход один раз для всей команды.</p>' +
    button('Войти в OpenAI', 'OPENAI_LOGIN') + '<p class="footnote">Оплата размещения продолжается по условиям вашего заказа.</p>',
  cancelled: () => heading('Продление отключено.', 'Команда продолжит работать до конца оплаченного периода. Следующего списания не будет.') +
    '<div class="notice"><p>Перед окончанием срока сохраните нужные данные. Срок хранения после отключения будет указан в вашем заказе.</p></div>' +
    button('Открыть команду', 'OPEN_TEAM') + button('Сохранить свои данные', 'EXPORT', 'secondary') + accountDetails(),
  expired: () => heading('Размещение закончилось.', 'Команда сейчас недоступна. Проверьте возможность продления и срок хранения данных в своём заказе.') +
    button('Посмотреть заказ', 'ORDER_DETAILS') + '<p class="footnote">Не создавайте новую команду, если хотите восстановить прежнюю.</p>',
  unavailable: () => heading('Пока нет свободных мест.', 'Сейчас не получается разместить команду на выбранном тарифе. Оплата не начиналась.') +
    button('Вернуться к выбору', 'BACK') + '<p class="footnote">Другой вариант предложим с новой ценой. Переключение произойдёт только после вашего подтверждения.</p>',
  openaiOutage: () => heading('OpenAI пока не отвечает.', 'Связь с вашей командой работает. Попробуем снова, когда OpenAI станет доступен.') +
    '<p class="lead">Повторно входить или покупать новое размещение не нужно.</p>' + button('Проверить ещё раз', 'RETRY_STATUS'),
  ownerRequired: () => heading('Ждём владельца команды.', 'Владелец должен снова подключить OpenAI. После этого работа продолжится на всех устройствах.') +
    '<p class="lead">Вам не нужно подключать свой аккаунт. История разговоров сохранена.</p>' + button('Проверить подключение', 'RETRY_STATUS'),
  pairingRevoked: () => heading('Нужно новое приглашение.', 'Доступ этого устройства к команде был отозван. Попросите владельца прислать новое приглашение.') +
    '<p class="lead">Команда и её аккаунт OpenAI продолжают существовать. Создавать новое размещение не нужно.</p>' + button('Подключиться по приглашению', 'INVITATION'),
  codeExpired: () => heading('Время для входа закончилось.', 'Начните вход ещё раз и используйте новый код. Прежний код уже не действует.') +
    '<p class="lead">Облачное пространство и оплата сохранены.</p>' + button('Начать вход заново', 'OPENAI_LOGIN'),
};

function setupView() {
  return heading('Готовим вашу команду.', 'Обычно это занимает несколько минут. Можно закрыть окно: прогресс сохранится.') + steps() +
    '<p class="fine">Следом вы подключите свой OpenAI — и можно начинать.</p>';
}
function accountDetails() {
  if (state.role !== 'owner') return '<p class="fine">Размещением и доступом управляет владелец команды.</p>';
  return `<details><summary>Размещение и полный доступ</summary><div class="details-body"><dl class="data-list"><div><dt>Размещение</dt><dd>Облако OpenStrudel</dd></div><div><dt>Заказ</dt><dd>Демонстрационный</dd></div><div><dt>Автопродление</dt><dd>${state.autoRenew ? 'Включено' : 'Выключено'}</dd></div></dl><p class="fine">Данные для полного доступа появятся после реальной выдачи сервера. Ключи доступны только владельцу и не отправляются в чат.</p>${button('Получить данные доступа', 'ACCESS', 'secondary')}${state.autoRenew ? button('Отключить продление', 'CANCEL_RENEWAL', 'text-button') : ''}</div></details>`;
}
function render(focus = false) {
  try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { storageAvailable = false; }
  screen.innerHTML = views[state.phase]();
  scenarioSelect.value = state.phase;
  document.querySelector('#step').textContent = state.phase === 'ready' ? 'Команда в облаке' : state.paid ? 'Настройка команды' : 'В облаке';
  document.querySelector('#evidence').textContent = `${state.orderId ? 'Один тестовый заказ. ' : 'Заказа нет. '}${state.paid ? 'Оплата имитирована. ' : ''}${storageAvailable ? 'Прогресс сохранён в этом браузере.' : 'Хранилище браузера недоступно; сохранение между открытиями не проверяется.'}`;
  if (focus) screen.querySelector('h1').focus({ preventScroll: true });
}
function send(type, extra = {}) { state = transition(state, { type, ...extra }); render(true); }
function previewNotice(text) {
  const existing = screen.querySelector('#preview-notice');
  if (existing) existing.remove();
  const note = document.createElement('p'); note.id = 'preview-notice'; note.className = 'success-note'; note.role = 'status'; note.textContent = text;
  screen.append(note);
}
screen.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'OPEN_TEAM') return previewNotice('В приложении здесь откроется чат команды. В прототипе настоящая команда не создаётся.');
  if (action === 'ACCESS' || action === 'EXPORT' || action === 'ORDER_DETAILS') return previewNotice('Для этого действия нужен выданный сервер. В прототипе реальных данных и ключей нет.');
  if (action === 'INVITATION') return previewNotice('В приложении здесь откроется подключение по приглашению. Демонстрация не отзывает доступ настоящего устройства.');
  if (action === 'RETRY_STATUS') return previewNotice('Проверяем существующий заказ. Имитируйте ответ кнопкой «Следующее событие» слева.');
  send(action);
});
screen.addEventListener('change', event => { if (event.target.id === 'auto-renew') {
  state = transition(state, { type: 'SET_AUTORENEW', enabled: event.target.checked }); render();
  screen.querySelector('#auto-renew').focus({ preventScroll: true });
} });
scenarioSelect.addEventListener('change', () => { state = scenario(scenarioSelect.value); render(true); });
document.querySelector('#device').addEventListener('change', event => { frame.dataset.device = event.target.value; });
document.querySelector('#theme').addEventListener('change', event => { frame.dataset.theme = event.target.value; });
document.querySelector('#large-text').addEventListener('change', event => { frame.classList.toggle('large-text', event.target.checked); });
document.querySelector('#reduced-motion').addEventListener('change', event => { frame.dataset.reducedMotion = String(event.target.checked); });
document.querySelector('#reset').addEventListener('click', () => { state = initialState(); render(true); });
document.querySelector('#reload').addEventListener('click', () => location.reload());
document.querySelector('#advance').addEventListener('click', () => {
  const next = { verifying: 'PAYMENT_CONFIRMED', checkout: 'PAYMENT_RETURN', creating: 'CREATED', installing: 'INSTALLED', checking: 'HEALTHY',
    uncertain: 'HEALTHY', setupDelayed: 'HEALTHY', offline: 'HEALTHY', authorizing: 'AUTH_GRANTED', openaiOutage: 'OPENAI_AVAILABLE', ownerRequired: 'OWNER_RECONNECTED' }[state.phase];
  if (next) send(next);
  else previewNotice('Для этого состояния сначала выполните действие в экране приложения.');
});
render();
