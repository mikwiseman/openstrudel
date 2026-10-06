# WAI VDS API v1

Base: `http://127.0.0.1:4781/api/v1` локально. Production: `https://server.waiwai.is/api/v1`. Публичная спецификация: `https://server.waiwai.is/openapi.json`.

JSON UTF-8. Ошибки: `{error,code,request_id}`. HTTP 400 validation, 401 missing/expired session, 403 CSRF/fresh password required, 404 чужой или отсутствующий объект, 409 conflict, 429 rate limit, 503 transient. Resource IDs — UUID. Amounts — integer cents. Times — Unix milliseconds. Все финансовые цены выбирает backend; клиентская цена игнорируется.

## Авторизация

Браузер: cookie `wai_session`, HttpOnly, SameSite=Strict, Secure при TLS. Сессия 24 часа, абсолютное истечение. Все POST из браузера содержат правильный `Origin` и `X-CSRF-Token` из `/me`. Login/register также проверяют Origin.

API: пользователь входит в кабинет, выбирает «Подключить по API», подтверждает пароль, получает одноразово отображаемый API key со сроком до30 дней. Ключ можно отозвать в кабинете, он привязан к одному пользователю и одному окружению. Токен даёт права этого пользователя на все его серверы, включая root-key; сохраняйте только на доверенном backend. Нет административного доступа или межпользовательских вызовов. Это не OAuth приложение и не клиентский общий ключ.

| Method | Path | Body / результат |
|---|---|---|
| POST | `/auth/register` | `{email,password}` → `{user,csrf,recovery_code}` + cookie; код нужно сразу сохранить |
| POST | `/auth/login` | `{email,password}` → `{user,csrf}` + cookie |
| POST | `/auth/recover` | `{email,recovery_code,password}` → `{ok,recovery_code,requires_login:true}`; новый пароль и новый одноразовый код, старые сессии/API-ключи отзываются |
| POST | `/auth/recovery-code` | `{password}` → `{recovery_code}`; только сессия пользователя с CSRF, прежний код отзывается |
| POST | `/auth/logout` | `{}` → удаление текущей сессии |
| POST | `/auth/reauth` | `{password}` → окно доступа к ключам/удалению 5 минут |
| POST | `/auth/api-token` | `{password}` → `{token,expires_in:3600,scope,warning}` |
| GET | `/api-keys` | Метаданные своих ключей без секретов |
| POST | `/api-keys` | `{name,password,expires_days:30}` → `{token,key}`, секрет только один раз |
| DELETE | `/api-keys/{id}` | Отзыв своего ключа; только пользовательская сессия |
| POST | `/agent/servers` | Только специально выданный sandbox key: `{purpose,idempotency_key,consent:true}` →202 `{order,server,poll_url,mode:emulator,billable:false}` |
| GET | `/me` | `{user,csrf,mode,orders,servers}` |
| GET | `/catalog` | Актуальные фиксированные цены, доступные способы оплаты, specs, режимы и ограничения |
| GET | `/account/export` | Attachment JSON заказов и сведений о VM, без private keys |

## Заказ и оплата

`POST /orders`:

```json
{"purpose":"agent","idempotency_key":"client-generated-uuid","consent":true,"payment_method":"card"}
```

`purpose`: `agent` (Ubuntu + Docker), `site` (Ubuntu + Nginx), `clean` (Ubuntu + SSH). Произвольные shell/cloud-init payload запрещены. Агент, приложение и его AI credentials настраиваются самим покупателем на VM. Версия bootstrap фиксирована в исходниках и передаётся с Ed25519 подписью по pinned SSH.

Идемпотентность: `(user,idempotency_key)` immutable. Повтор с другими назначением/типом → 409. Пока initial order того же назначения не завершён, другой ключ также возвращает имеющийся заказ; сохранённый alias остаётся привязан к нему после готовности и удаления. Создавать следующий сервер можно после окончания текущей выдачи. Production: `card` — 1200 minor units USD, `crypto` — 1200 minor units USDT за 30 дней; доступность берётся из `/catalog`. `test` разрешён только на эмуляторе. VM account=оператор, full OS root=покупатель. Метод, сумма и валюта фиксируются в заказе.

`POST /orders/{id}/checkout {}` → `{url,order_id}`. Приложение открывает URL покупателю. Карта только на Stripe hosted checkout; у эмулятора вместо карты кнопки исходов. Клиент НЕ может подтвердить реальную оплату вызовом success URL.

`GET /orders/{id}` → `{id,user_id,kind,purpose,server_id,amount,currency,status,mode,created,paid_at,idem}`. States: `draft`, `checkout`, `fulfilling`, `fulfilled`, `needs_refund`, `refunded`. Поле `paid_at` ставится лишь после проверенного события.

`POST /webhooks/payment`: только server-to-server raw Stripe event JSON + `Stripe-Signature`. Tolerance 300 секунд. Checkout lookup сверяется с подписанным event. Поддержаны completed/async succeeded/async failed/expired. Применение платежа и event receipt атомарны. Event ID нельзя использовать с другим payload. Дубли не создают второй сервер. Failed/expired после paid не отменяют выдачу.

Тестовый Stripe adapter использует `/v1/checkout/sessions` и стабильный `Idempotency-Key: wai-vds-checkout-<order UUID>`. Подтверждённое истечение неоплаченной сессии разрешает следующую generation с суффиксом `_g1`, `_g2` и так далее на том же заказе. Неизвестная попытка после 23 часов требует операторской сверки: новый POST после истечения Stripe idempotency retention автоматически не отправляется.

## Статус, доступ и управление

| Method | Path | Body / результат |
|---|---|---|
| GET | `/servers/{id}` | Стадия, IP, public key, pinned host key, ssh command, срок, operation error |
| POST | `/servers/{id}/access` | `{}` → attachment OpenSSH private key; свежая авторизация ≤5 минут, no-store |
| POST | `/servers/{id}/renewals` | `{consent:true,payment_method:"card"}` → renewal order; затем его checkout |
| POST | `/servers/{id}/cancellation` | `{cancel_at_end:true}` или false, удаление в конце срока |
| POST | `/servers/{id}/retry` | `{}` → 202; known rejected creation можно повторить, unknown только сверяется |
| POST | `/servers/{id}/delete` | `{confirm:"полный server UUID"}` + свежий пароль → 202 |

Если удаление не подтверждено, `server.state=deleting`, а `operation.state=delete_attention`. Автоматически выполняется только чтение инвентаря. `/retry` запускает свежую проверку принадлежности и питания, затем продолжает удаление.

Server states: `paid`, `creating`, `configuring`, `checking`, `ready`, `unknown`, `attention`, `rejected`, `overdue`, `deleting`, `deleted`. `ready` в Kamatera требует успешного SSH root, готового bootstrap marker и проверки Docker/HTTP по назначению. В эмуляторе поле `mode:emulator` и документальный IP `192.0.2.x`; оно не доказывает существование VM.

30 дней начинаются после готовности. Продление продлевает имеющуюся VM, никогда не создаёт новую. Повтор события не меняет срок дважды. Поздний платёж после начала удаления получает `needs_refund`, не воскрешает удалённую VM.

Для polling рекомендуется 2–5 секунд локально и 10–15 секунд на реальном провайдере; остановить на terminal ready/deleted. Не печатать bearer tokens, downloaded keys, webhook raw data или provider response в логах клиента.


WAI Pay callback находится на `/webhooks/wai-pay`; его HMAC и форматы описаны в `docs/PAYMENTS.md`. Метод оплаты фиксируется при создании заказа в `payment_method`; доступные значения, суммы и валюты выдаёт `/catalog`. Для реальных карт/крипты пользователь уходит в hosted checkout. `/llms.txt` и `/openapi.json` публичны и учитывают базовый путь размещения.

## Production reservations and recovery

До выдачи платёжной ссылки резервируется место. Если лимит активных ресурсов и резервов исчерпан, checkout возвращает 409 без нового provider invoice. Состояние upstream `processing`, неизвестный ответ или прошедшее локальное время не освобождают резерв. Только подтверждённое неоплаченное завершение освобождает место. Поздняя успешная оплата без места получает `needs_refund`; новый сервер не создаётся.

Код восстановления содержит 256 случайных бит, хранится на backend только в виде хеша и используется один раз. Полученный при регистрации или восстановлении код нужно сохранить до последующих запросов. Код и пароль нельзя передавать в URL/логах. После восстановления необходим новый вход; отозванные API-ключи надо выпустить заново. Если код утрачен и вход невозможен, автоматического обхода проверки владельца нет.

Установленный OpenStrudel `production.mjs` использует отдельный ключ своего аккаунта; локальный `client.mjs` сохраняет sandbox. Production-ключ не может выпускать ключи или вызывать бесплатную `/agent/servers`. Для создания нужен обычный оплаченный заказ. Срок этого ключа — до 4 ноября 2026 года; значение хранится только в закрытом `.env.production`.
