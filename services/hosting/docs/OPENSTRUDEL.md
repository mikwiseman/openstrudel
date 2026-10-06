# OpenStrudel: точный контракт backend v2

С 5 октября 2026, v11: экран владельца по умолчанию предлагает Magic Link через Resend. Нативный PKCE-контракт не меняется; подробности и ограничения браузера — [MAGIC-LINK.md](MAGIC-LINK.md). Home checkout остаётся закрытым.

5 октября 2026. Основной адрес: `https://server.waiwai.is`. Старый `/vds` не поддерживается по решению пользователя. WAI VDS работает как backend OpenStrudel. Файлы `/Users/mikwiseman/Code/openmagic` не изменялись.

**Статус: production preview, покупка Home закрыта.** Бесплатная реализация и эмуляция готовы; новая VM 4/30, настоящее списание и пользовательский вход OpenAI не выполнялись. Старый пилот 2/20 не является приёмкой Home. Нативному приложению ещё нужно подключить этот контракт в своём репозитории.

## Файлы для интеграции

- `docs/openstrudel-openapi.json`: OpenAPI 3.1, версия 2.0.0. Тот же документ обслуживается на `/api/v2/openstrudel/openapi.json`; генератор — `src/openstrudel-openapi.mjs`.
- `docs/fixtures/openstrudel.json`: реальные ответы локального эмулятора и mock gateway, включая pending/expired/unknown/ready. Идентификаторы фиктивные, секретов нет.
- `src/vendor/openstrudel-cloud-init.sh`: неизменённый рецепт из `openmagic/scripts/cloud-init.sh`, SHA256 `6215040abb4acf01ce26f04f8786a97245c6532ee3e380015c9e99cbbd0f9f2a`. Сверен с checkout `53a7a1d782ee98a337bbe229fb08ff9751717470`.
- Home: `https://waiwai.is/openstrudel/downloads/OpenStrudel-Home-1.0.tar.gz`, SHA256 `2d2276516882aee51f79c003320ac226101f3291c1d365f25b03b520ef516a69`. Скачанные 99 286 байт проверены; cloud-bootstrap в опубликованном архиве совпал с исходником.

## Один вход владельца

Public client `openstrudel`, scope `home:manage`, authorization code + PKCE **S256**. Открыть `/oauth/authorize` в системном браузере. Параметры и ошибки приведены в OpenAPI. Default callback — ровно **`openstrudel://oauth/wai-vds`**. При возврате проверить `state` и `iss=https://server.waiwai.is`, обменять одноразовый code с исходным verifier через `/oauth/token`.

Экран называется OpenStrudel; внутренний владелец сохраняется в WAI VDS. Email здесь идентификатор входа: подтверждение почтового ящика по email не реализовано. Нужны один пароль и сохранённый одноразовый код восстановления; кабинета VDS и аккаунта Kamatera в сценарии нет. Приложение не принимает пароль и не содержит общего API-ключа. Public client ID сам по себе прав не даёт. `external_user_id` не принимается.

Код живёт 120 секунд; вся попытка входа — 10 минут. Access token — 15 минут, refresh family — максимум 30 дней, refresh вращается. Повтор правильного code/refresh отзывает семейство. Приложение должно сериализовать refresh, хранить credentials в Keychain и при неизвестном результате refresh заново войти. Повторный вход владельца восстанавливает прежний список заказов.

Root, экспорт, немедленное удаление и восстановление owner token требуют `auth_time` не старше 5 минут: новый flow с `prompt=login`. Refresh не освежает `auth_time`. Восстановление пароля отзывает прежние sessions/API keys/native grants, сохраняя заказы и VM. OAuth code допустим только в зарегистрированном callback и защищён PKCE; Home tokens, SSH keys и claims в URL не передаются.

Базовые правила: [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252). Все API v2 принимают native bearer, обычные WAI API keys и cookie для них не подходят. Browser auth отдельно требует origin, nonce cookie и CSRF. Разрешённый HTTPS callback для web регистрирует оператор; CORS ограничен его origin, без cookie credentials. Произвольный return URL не поддерживается.

## Цена → заказ → платёж

1. `GET /api/v2/openstrudel/catalog`: показывать кнопку покупки только при `purchase_enabled=true`. Сейчас false; цена Home не опубликована.
2. `POST /quotes`: `profile_id=openstrudel-home-v1`, `platform=mac|web`, выбранный способ. Цена, валюта/точность, все характеристики, налоги/итог, срок, правила продления и возврата зафиксированы в котировке с SHA256. Котировка действует 15 минут до создания заказа; оплата того же заказа — до указанного `checkout_deadline` (24 часа). Данные старого заказа не меняются при смене розничной цены.
3. До заказа приложение сохраняет в Keychain installation ID, P-256 private key и **сырой owner token**. В `bootstrap` передаёт только существующий трёхпольный протокол: `installationId`, `privateKeyPEM`, `ownerTokenHash`. Backend шифрует bootstrap до установки; не генерирует вместо пользователя OpenAI credentials или owner token.
4. `POST /orders`: конкретные quote ID+digest, `consent=true`, долговечный idempotency key, bootstrap, `return_uri=openstrudel://checkout/wai-vds` и случайный `return_state`. Сохранять payload до отправки. Повтор идентичного запроса возвращает прежний заказ; изменённые данные дают 409. Новый ключ при существующем незавершённом заказе не создаёт второй заказ.
5. `POST /orders/{id}/checkout`: **type=hosted**. Текущий WAI Pay выдаёт hosted Stripe/USDT URL, не embedded client_secret. Native открывает URL в защищённом браузерном контексте; отдельный кабинет VDS не нужен. Карты/кошельки принимаются в пределах возможностей выбранного процессора, не обещается «любая карта».
6. Платёж возвращает на нейтральный HTTPS экран OpenStrudel → точный зарегистрированный callback с **order ID и state**, без ключей и утверждения об оплате. Приложение проверяет state и читает заказ. Закрытие формы, deep link и надпись success не подтверждают деньги. Подтверждение — только подписанное событие + authenticated gateway lookup.

Stripe как платформа имеет оба режима, но текущий WAI Pay использует hosted: [Stripe Checkout](https://docs.stripe.com/payments/checkout). Изучены `wai-pay/backend/src/providers/stripe/index.ts` и `routes/v2-payments.ts`; gateway не изменялся.

`payment_state`, `session_state`, `provisioning_state`, `home_state` независимы. **Не выводить кнопку повторной оплаты только по `order_status=checkout`.** `wait_for_confirmation` означает дождаться `/sync`; таймер, истёкший в приложении, не доказывает неоплату. Лишь проверенный `expired|canceled` с нулевой суммой даёт `retry_payment`. Частичная/двойная оплата или refund требуют сверки. При неизвестном create используется прежний externalPaymentId; новая платёжная попытка не создаётся. `/abandon` закрывает только точно неоплаченный заказ; затем можно подтвердить новую котировку.

При отсутствии URL (`url=null`) следовать `action_required`, не открывать старую форму. GET статуса читает сохранённое состояние; POST `/sync` бесплатно сверяет gateway. `payment_verified_at` — время последнего проверенного ответа, не время последней попытки запроса. Продление: новая `/quotes` с `installation_id`, затем заказ **без bootstrap**. Профиль и VM сохраняются; продление вручную на 30 дней.

## Установка и подключение

Home профиль: Ubuntu Server 24.04 x64, 1A, 4 ГБ, 30 ГБ, публичный IPv4, 5000 ГБ трафика. Бесплатный LIVE API подтвердил профиль `EU:6000c29549da189eaef6ea8a31001a34`. Публичная оценка — **$14,28/мес** с опубликованным 2% сбором, account price и налоги не проверены. Это себестоимость по публичному калькулятору, **не розничная котировка**. $24 в fixtures — произвольная тестовая цена. Старые $12 за 2/20 к Home не относятся.

Backend устанавливает только закреплённый рецепт и архив. Временный bootstrap передаётся по SSH stdin, хранится root-only и удаляется ExecStartPost после успешной установки. Рецепт повторно использует только тот же installation ID и release; одна Compose project `openstrudel`, один Home и одна подписанная принадлежность volume. До готовности encrypted bootstrap остаётся в БД для восстановления; после проверки стирается из рабочей строки. Старые шифрованные backups живут по общей политике retention.

Готовность требует одновременно: provider-bound IP, закреплённый SSH host key, законченный install, правильные installation/release/volume, owner hash в Home, authenticated local `/health` и доступный публичный HTTPS с P-256 SPKI и certificate SHA256. Внешняя проверка без owner token должна вернуть 401 JSON. Только тогда стартуют оплаченные 30 дней. Первое SSH-соединение использует существующий механизм API-bound TOFU; это не независимая аппаратная аттестация VM.

`POST /installations/{id}/claims` → секретный claim на 5 минут. `/claims/consume` принимает его **в JSON body**, проверяет владельца + grant + installation, погашает ровно один раз и возвращает адрес/сертификат/выпуск. Открытый owner token уже в Keychain; native обязан проверить pin перед отправкой своего токена и выполнить authenticated `/health` по существующему Home протоколу. Получение connection не завершает вход OpenAI: владелец лично подтверждает OpenAI на своём Home. Runtime, расписания и чужие токены не копируются.

Если Keychain сохранился после переустановки, новый вход владельца и claim возвращают ту же VM. Если owner token потерян: новый `prompt=login`, claim с `recover_owner=true`, consume. Backend повторно проверяет Home и через его существующий локальный owner API создаёт 5-минутное приглашение. Ответ — структурированные host/port/pin/invitation_key, без secret URL. Приложение обращается напрямую к pinned Home `POST /pair` с Bearer invitation_key и сохраняет выданный Home owner token. Неопределённый результат consume не воспроизводится: новый claim и новое приглашение. Старые владельцы не отзываются автоматически; отзыв устройств — функция самого Home.

## Управление и платформы

- `/cancellation`: остановить обслуживание в конце срока или возобновить. Это не немедленное удаление и не подписка с автосписанием.
- `/delete`: отдельное подтверждение installation ID + свежий вход; backend ждёт подтверждённого выключения и удаления точной VM.
- `/access`: свежий вход; IP, SSH host key, команда и private key возвращаются в закрытом JSON, без redirect.
- `/export`: свежий вход; **инструкция ручного SSH экспорта**, а не готовая backup-ссылка. Команды останавливают ровно Home, архивируют volume и запускают Home через trap. Запрос endpoint сам команды не исполняет. Архив содержит credentials, его нужно хранить зашифрованным. Пользователь заранее видит краткую остановку. Автоматические копии backend VDS не являются backup данных Home.
- Mac/web: hosted checkout. Web origin/callback необходимо зарегистрировать; текущий Home remote API для native не получает браузерный Origin. Здесь не реализован новый browser-to-Home transport.
- iOS: `purchase_enabled=false`, только приглашение в готовую команду. Никаких IAP, StoreKit, external purchase entitlements или Apple reporting в этом релизе. `platform` в public client — правило backend контракта, не криптографическая аттестация устройства.

## Эксплуатация и оставшаяся приёмка

Схема 8 добавляет os_* таблицы и nullable verified/expiry + refund amount в журнал платежей. Старые колонки не переписываются. Миграция проверяется `scripts/check-migration.mjs` на отдельном согласованном snapshot, с fingerprint всех старых колонок и строк. `deployment/home-upgrade.py` требует ровно v9, backup, Linux suite в Docker build, migration rehearsal, атомарный env, exact-service restart, health; на сбое восстанавливает v9 с **текущей БД**, не откатывает платёжные данные. Caddy и WAI Pay не перезапускаются.

Preview env: `WAI_HOME_IMAGE` подтверждённый выше, `WAI_HOME_AMOUNT_MINOR=0`, `WAI_HOME_LIVE_APPROVAL=`. Чтобы когда-либо открыть продажи, нужны утверждённая итоговая розничная цена, существующий Kamatera spend gate с достаточным лимитом и отдельный `WAI_HOME_LIVE_APPROVAL=I_APPROVE_OPENSTRUDEL_HOME_SPEND`. Прежний лимит $10 меньше публичной оценки Home. Эти значения нельзя включать только ради прохождения теста.

Перед открытием остаются: согласованный бюджет; реальная VM данного профиля; bootstrap/перезагрузка/pinned native connect; личный OpenAI login; второе устройство и восстановление; ручной export/restore; согласованный настоящий платёж/refund; подтверждённое удаление VM. Финансовый результат, готовность Home и доступ проверяются раздельно. Денежных операций этим выпуском не выполнялось.
