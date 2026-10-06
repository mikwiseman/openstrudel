# Выбор инфраструктуры WAI VDS

Исследование цен и альтернатив: **4 октября 2026 года**, повторно не обновлялось. Решение для первой версии: **Kamatera**. Аккаунт и наработки wai-vpn позволили 5 октября пройти полный пилот одной настоящей VM. Подключение reseller-программы и применимость оптовых условий к нашему аккаунту пока не подтверждены.

## Результат пилота 5 октября

С разрешённым лимитом $10 создана ровно одна VM: Ubuntu 26.04.1 LTS, Amsterdam, 1A/2 GB/20 GB, IPv4. Подтверждены root/SSH, три шаблона последовательно на одном сервере, внешний HTTP, reboot, экспорт с восстановлением и удаление. Шаблон «Чистый Linux» проверен как базовая SSH-настройка на той же VM; удаление ранее установленных Docker/nginx и три независимых fresh VM этим тестом не подтверждены. Сохранены все 17 прежних VM. Клиент OpenStrudel проверил status/access существующего пилотного сервера и отзыв временного API-ключа. [Протокол](../outputs/live-pilot.json).

Для выбранного профиля аккаунт подтвердил базу $6/месяц и известную комиссию 2%. После удаления usage-отчёт содержит около **$0.00181**, но финальный invoice, налог, комиссия и округление ещё не подтверждены. Строки после удаления названы Hourly при ранее показанном monthly; причина не установлена. Это не основание обещать возврат за любую monthly VM. По последующему запросу пользователя checkout открыт в production v6 с лимитом одной активной/зарезервированной VM. Свежая оценка публичного калькулятора проверяется перед checkout и create; это не договорная цена аккаунта. Текущий протокол: `outputs/production-readiness.json`.

## Методика и границы

Сравнивались настоящие Linux VM с административным доступом, публичным IPv4, API жизненного цикла и возможностью обслуживать клиентов из аккаунта оператора. Контейнерные платформы, shared hosting и GPU-площадки без подтверждённой VM не считаются взаимозаменяемыми VDS. Ниже десять практических кандидатов и два новых посредника. Это ограниченный обзор подходящих продуктов, а не обещание охватить все облака.

Основание: официальные цены, API, условия и справочники. Существующая работа wai-vpn является внутренним свидетельством доступа, а не доказательством текущей мощности и договорного права перепродажи. Использован agent-reach: чтение Jina Reader; после ранее установленной недоступности Exa применён web fallback. Социальные отзывы не использованы как доказательство цен, SLA или разрешений.

4 октября бесплатно прочитаны публичные API Vultr, Akamai и AgentMetal. Обзор альтернатив не включал создание VM у этих провайдеров. Отдельный пилот Kamatera 5 октября описан выше; для остальных кандидатов документированный API пока означает техническую реализуемость, а не пройденный живой acceptance. Оплата карты покупателем остаётся в нашем hosted checkout; способ расчёта WAI с облаком может быть другим.

## Сравнение

Цены ниже являются инфраструктурной базой до применимых налогов, нашей поддержки, комиссии эквайринга и маржи. Там, где налоговый статус публичной суммы не установлен, это указано. Конфигурации близки по памяти, но CPU, диски и гарантии различаются. Выделенная публичная IPv4 учтена, кроме явно неполных оценок. Регион в каталоге не гарантирует свободную мощность.

| Провайдер | Пример и базовая цена | Автоматизация и доступ | Перепродажа | Регион / главный ограничитель |
|---|---|---|---|---|
| **Kamatera** | Type A 2 vCPU / 4 GB / 40 GB: ориентир **$19/мес**; 1A / 2 GB / 20 GB: **$6**. Итог IPv4/traffic/tax сверить с quote аккаунта. | Create, inventory, task status, terminate; SSH key и root. Native user_data не подтверждён публичным create schema. | Есть Buy & Sell и White Label API; условия нашего аккаунта не подтверждены. | Глобальная сеть; выбрать регион из authenticated catalog. Аккаунт уже есть. |
| **Hetzner** | CX23, 2 vCPU / 4 GB / 40 GB: **€5.49 + €0.50 IPv4 = €5.99/мес** в ЕС, без VAT. | POST/DELETE servers, SSH keys, cloud-init `user_data`, labels, async actions. | Разрешено предоставлять услуги третьим лицам по §7; оператор отвечает за клиентов. | Германия/Финляндия для этого ориентира. Дефицит CX и лимиты аккаунта. |
| **UpCloud** | Starter 2 CPU / 4 GB / 30 GB: **€12/мес**, IPv4 включён, местные налоги сверху. | Create/delete, SSH keys, `user_data`, cloud-init images, labels. | Явная reseller/white-label программа; скидки по договору. | 15 DC / 12 стран на странице программы. Предоплаченный баланс; проверить квоты. |
| **Vultr** | `vc2-2c-4gb`: 2 CPU / 4 GB / 80 GB, **$20/мес**, обычная IPv4; São Paulo **$30**. Налог сверху по профилю. | API v2 create/delete, SSH keys, Base64 `user_data`, tags. | Partner Program включает resellers; применимые условия WAI ещё не подтверждены. | FRA и другие регионы в public plans. Квоты, баланс, живая доступность. |
| **DigitalOcean** | Basic Regular 2 CPU / 4 GiB / 80 GiB: **$24/мес**, bundled plan с IPv4; налоги сверху. | API v2 Droplets create/delete, SSH keys, `user_data`, tags. | Partner Terms разрешают resale по одобренному Channel/ISV track. | Несколько регионов Америки/Европы/Азии; тариф по `sizes`/`regions`. Нужен одобренный track. |
| **Akamai / Linode** | `g6-standard-2`, 2 CPU / 4 GB / 80 GB: **$24/мес**; Jakarta **$28.80**, São Paulo **$33.60**, плюс налоги. | API v4 create/delete, root/SSH keys, StackScripts; cloud-init по совместимости image/region. | Официальный guide прямо поощряет resale, в том числе через собственный UI. | Глобальная сеть; уточнить DC, квоту и включённый IP выбранного плана. |
| **OVHcloud** | d2-4, 2 CPU / 4 GB / 50 GB: monthly **$13.50 + IPv4 ≈ $2.33 = $15.83** при 730 часах IP. PAYG: **≈$20.14/730 ч**. Без VAT. | Public Cloud API/OpenStack create/delete, SSH key, cloud-init. | Partner-модель есть; применимые resale-условия для WAI не подтверждены. | ЕС/Америка/APAC; доступность Discovery зависит от DC. С 01.10.2026 IPv4 платный отдельно. |
| **Scaleway** | DEV1-M 3 CPU / 4 GB: compute **€14.75/730 ч** + IPv4 **€2.92** + отдельно диск и VAT. **€17.67 ещё не полный сервер.** | Instances API create/delete, SSH, cloud-init. | Официальная API-страница прямо описывает собственную white-label перепродажу. | Париж/Амстердам/Варшава и поддерживаемые зоны API. Нужна полная смета диска и квот. |
| **Fluence** | Динамические CPU VM; полная сумма через price API: VM + boot disk + IP. Проверенного фиксированного тарифа 4 GB нет. | API v2 VM, SSH key; cloud-init описан в API reference. IP/диск удалять отдельно. | Разрешение коммерческой перепродажи не установлено. Доступ к аккаунту третьим лицам ограничен Terms. | Наличие по cluster resources. Docs ещё содержат пометку Alpha для Console; проверить доступность production API. |
| **EQVPS** | Ориентир публичной розницы: **$15/мес за 4 GB с IPv4**. Оптовая сумма и налоги не подтверждены. | Reseller order/status/cancel; root. SSH key/user_data/idempotency в публичном order schema не подтверждены. | Явная white-label reseller-модель через собственный баланс оператора. | Германия/Финляндия. Только dedicated-IP для HTTPS; криптобаланс, договор и реальная выдача требуют проверки. |

### Официальные источники для таблицы

- Kamatera: [цены и калькулятор](https://www.kamatera.com/pricing/), [страница с конфигурациями Type A](https://www.kamatera.com/faq/answer/will-i-ever-be-charged-extra-for-internet-traffic-on-a-monthly-server-plan/?p=1698), [API](https://www.kamatera.com/knowledgebase/api-documentation/), [reseller](https://www.kamatera.com/products/reseller-hosting/), [дата-центры](https://www.kamatera.com/data-centers/).
- Hetzner: [цены с 15.06.2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [IPv4](https://docs.hetzner.com/cloud/servers/primary-ips/overview/), [API](https://docs.hetzner.cloud/), [§7 условий](https://www.hetzner.com/legal/terms-and-conditions/), [регионы](https://docs.hetzner.com/cloud/general/locations/).
- UpCloud: [Starter и цены](https://upcloud.com/pricing/), [Servers API](https://developers.upcloud.com/1.3/8-servers/), [white-label](https://upcloud.com/global/white-label-hub/), [partner terms overview](https://upcloud.com/global/partner-program/).
- Vultr: [публичный каталог](https://api.vultr.com/v2/plans), [API](https://www.vultr.com/api/), [cloud-init](https://docs.vultr.com/how-to-deploy-a-vultr-server-with-cloudinit-userdata), [Partner Program](https://discover.vultr.com/partner), [billing](https://docs.vultr.com/support/platform/billing/how-am-i-billed-for-my-servers).
- DigitalOcean: [тариф Basic Regular](https://www.digitalocean.com/pricing/droplets), [billing](https://docs.digitalocean.com/products/droplets/details/pricing/), [API](https://docs.digitalocean.com/reference/api/api-reference/), [Partner Terms](https://www.digitalocean.com/legal/partner-terms-and-conditions).
- Akamai: [публичный тариф API](https://api.linode.com/v4/linode/types/g6-standard-2), [resale](https://techdocs.akamai.com/cloud-computing/docs/resell-services), [billing](https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works), [API](https://techdocs.akamai.com/linode-api/reference/api).
- OVHcloud: [текущие цены](https://www.ovhcloud.com/en/public-cloud/prices/), [изменение от 01.10.2026](https://blog.ovhcloud.com/en/posts/public-cloud-pricing-update-october-2026/), [API](https://api.ovh.com/), [партнёры](https://partner.ovhcloud.com/).
- Scaleway: [цены VM](https://www.scaleway.com/en/pricing/virtual-instances/), [цена IPv4 и billing FAQ](https://www.scaleway.com/en/docs/instances/faq/), [API и resale](https://www.scaleway.com/en/developer-api/), [cloud-init](https://www.scaleway.com/en/docs/instances/how-to/use-cloud-init/).
- Fluence: [API flow и billing](https://fluence.dev/docs/build/api/x402), [overview с Alpha caveat](https://fluence.dev/docs/build/overview), [API reference со ссылкой на production base URL](https://api.stage.fluence.dev/scalar), [Terms PDF](https://console.fluence.network/files/FLUENCE_TERMS_OF_SERVICE.pdf).
- EQVPS: [reseller](https://eqvps.com/en/docs/reseller), [программа](https://eqvps.com/en/partners), [сеть](https://eqvps.com/en/docs/network), [цены](https://eqvps.com/en), [Terms](https://eqvps.com/en/terms), [оплата](https://eqvps.com/en/docs/paying).

## Что принципиально для Kamatera

1. **Договор.** Buy & Sell под своим брендом подходит нашей модели. Однако FAQ полноценной reseller-программы описывает договор через account manager и разовый сбор $200 после 30 дней. Сбор снимается, если за этот период привлечённые клиенты дали не менее $200 выручки. Не считать, что это уже действует для существующего обычного аккаунта или обязательно требуется для любого использования API. Сначала установить конкретный договорный режим WAI. [Сбор](https://www.kamatera.com/faq/answer/is-there-a-fee-to-become-a-kamatera-reseller/), [подключение](https://www.kamatera.com/faq/answer/how-do-i-get-started-with-my-kamatera-reseller-account/).
2. **Техническая выдача.** Публичный create schema принимает публичный SSH key и возвращает task ID. Выдача через API и подписанную настройку по SSH проверена на настоящей VM. Поле `user_data` там не документировано. Установка собственного подготовленного образа является отдельным вариантом. Обязательный пароль create-запроса не выводится в логи; клиент использует зашифрованный при хранении SSH-ключ, парольный вход после настройки отключён и проверен через `sshd -T`. [API](https://www.kamatera.com/knowledgebase/api-documentation/), [custom images](https://www.kamatera.com/knowledgebase/how-to-upload-custom-images/).
3. **Цена.** Type A делит CPU без гарантированных ресурсов. Это разумный дешёвый старт для лёгких нагрузок, но не эквивалент Type B. Публичный Pro $39 имеет выделенные CPU threads и другой размер диска. Текущая pricing-страница описывает поминутный учёт hourly VM, старые вложенные страницы упоминают секунды. В расчётах использовать quote и фактический billing аккаунта. Выключение VM может менять ставку, но не останавливает весь счёт; удаление прекращает начисления на hourly server. [Pricing](https://www.kamatera.com/pricing/), [Terms, §5 и §19](https://www.kamatera.com/tos/).
4. **Операции.** Есть 24/7 техническая поддержка. Наши текущие квоты, лимиты API и подтверждённое время эскалации здесь не установлены. AUP распространяет ответственность на клиентов оператора и допускает ограничения при нарушениях. WAI нужен реестр «клиент → VM», контакт для abuse и выборочная блокировка конкретной VM с журналом причин. [Support](https://www.kamatera.com/support/), [AUP](https://www.kamatera.com/acceptable-usage-policy/).

## Почему не переключаться сразу на Hetzner или Vultr

**Hetzner дешевле на выбранном публичном EU-тарифе**, но низкая цена не гарантирует возможность немедленной выдачи. Официальные FAQ допускают недостаток ресурсов даже после появления server ID: итоговая Action может закончиться ошибкой. Документированный лимит новых аккаунтов составляет 5 обычных серверов; фактические лимиты надо читать в Console. Увеличение рассматривается вручную; server FAQ говорит о месяце пользования и первом оплаченном счёте. Порты SMTP 25/465 закрыты по умолчанию. Не выбирать почтовый сервер первым шаблоном. [Limits](https://docs.hetzner.com/cloud/servers/overview/), [FAQ](https://docs.hetzner.com/cloud/servers/faq/), [общий FAQ](https://docs.hetzner.com/cloud/general/faq/).

**Vultr технически подходит**, имеет широкий каталог и стандартный cloud-init. Публичный API вернул `vc2-2c-4gb` в FRA, но это каталог, а не резервирование мощности. Base monthly $20 и отдельная цена São Paulo $30 прочитаны непосредственно из API. Разрешение нашей resale-схемы, квоты и применимые налоги требуют проверки аккаунта/договора. Официальный billing считает остановленные VM платными до destroy и минимальную единицу в один час. Наш каталог не должен обещать, что кнопка «Стоп» отменяет списания. [Каталог](https://api.vultr.com/v2/plans), [billing](https://docs.vultr.com/support/platform/billing/how-am-i-billed-for-my-servers), [налоги и квоты](https://docs.vultr.com/support/platform/billing), [программа](https://discover.vultr.com/partner).

Живой пилот подтвердил выбор Kamatera для текущей версии. Следующий технический кандидат — Hetzner после проверки квот и доступности; UpCloud подходит для договорного white-label резерва. Заранее реализовывать все адаптеры не требуется.

## Новые сервисы, которые пока оставить в исследовании

**x402Compute.** Это дополнительный слой над Vultr/DigitalOcean, не доказанная собственная физическая инфраструктура. Документированы provision/list/delete/extend, SSH key и предоплаченный срок; root fallback описан для Vultr. В docs есть CPU-планы, несмотря на название GPU marketplace. Публичный `GET /compute/plans` из текущей среды вернул **403**; актуальный прайс, право перепродажи, cloud-init и SLA не подтверждены. Удобство x402 не устраняет риск посредника и согласования white-label. [Официальные docs](https://studio.x402layer.cc/docs/agentic-access/x402-compute).

**AgentMetal (agentmetal.dev).** Публичный каталог реально ответил: nano 2 CPU/2 GB/40 GB $1.20/день или $30/мес; small 3 CPU/4 GB/80 GB $2.20/день или $55/мес. Регионы `ash` и `hil`. Docs описывают VM с root, API покупки и hosted card checkout. Для перепродажи WAI это более дорогой посредник; договор, налоги, пользовательский bootstrap и гарантии пока не подтверждены. Одноимённый **agentmetal.ai** описывает управление собственным bare metal и отдельную platform fee; это другой продукт, его цены нельзя подставлять сюда. [Каталог](https://api.agentmetal.dev/v1/catalog), [продукт](https://agentmetal.dev/), [одноимённый сервис](https://agentmetal.ai/pricing).

**Fluence.** Есть интересная модель CPU VM и отдельный cloud-init, однако API reference размещён на stage-домене, хотя приводит production base URL. Это требует проверки production schema, не предположения о полном совпадении. Баланс должен покрывать минимум 6 часов всех ресурсов. При terminate нужно отдельно очистить public IP и boot disk. Terms запрещают передачу самого аккаунта без письменного разрешения; это не равно автоматическому запрету или разрешению продажи root-доступа к VM. Последнее надо подтвердить отдельно. [Flow/billing](https://fluence.dev/docs/build/api/x402), [schema](https://api.stage.fluence.dev/scalar), [Terms](https://console.fluence.network/files/FLUENCE_TERMS_OF_SERVICE.pdf).

**EQVPS.** Reseller-модель хорошо совпадает с нашим продуктом. Но NAT не допускает произвольный входящий HTTPS; использовать dedicated IPv4. `test:true` выдаёт mock и не проверяет инфраструктуру. Автопродление включено по умолчанию; согласие нашего клиента и provider autorenew необходимо синхронизировать. Подтверждённой схемы SSH key, cloud-init и idempotency для reseller order нет. Розничные $15 не являются оптовой себестоимостью. Партнёрская страница называет цель uptime, но ранее прочитанные Terms не давали контрактной гарантии и явного названия юрлица; это остаётся открытой договорной проверкой. [Reseller API](https://eqvps.com/en/docs/reseller), [network](https://eqvps.com/en/docs/network), [Terms](https://eqvps.com/en/terms).

## Полная цена и контракт продукта

Нельзя честно назвать единую цену «со всеми налогами», не зная юрлица оператора, его страны, tax ID, выбранного региона, периода и вида клиента. Для WAI фиксировать полученную сервером смету до checkout: VM + IPv4 + диск + backup + включённый трафик + применимые налоги + комиссия/маржа. Сверхлимитный трафик либо ограничивать, либо показывать его правило заранее. Сумма и валюта в заказе неизменяемы после checkout; их сверяет webhook.

Пример, **не налоговая ставка WAI**: Hetzner €5.99 × 1.19 = €7.13 при условном VAT 19%, до backup, поддержки и эквайринга. Если WAI имеет иной налоговый режим, результат другой. Месячная цена одной VM не равна почасовой ставке × 730 у всех провайдеров. OVH monthly и hourly режимы различаются; DigitalOcean bundled имеет cap, v5 не имеет; не смешивать их в калькуляторе.

Для регионов и тарифов сохранять последнюю проверенную цену и timestamp, а перед оплатой проверять доступный каталог/квоты. Начинать с одного региона и одного разумного тарифа. Рост квот, депозиты, reseller fee и новые платные VM требуют отдельного согласованного бюджета.

## Проверка перед открытием настоящих продаж

- Подтвердить наш договорный режим Kamatera, полную цену выбранной конфигурации, налоговый профиль, лимиты и процедуру abuse. Не отправлять сообщения от имени пользователя без прямого поручения.
- Пилот создания → SSH/root → bootstrap → внешний HTTP → reboot → экспорт → удаление уже выполнен 5 октября на одной VM. Осталось завершить сверку финального invoice и возможных остаточных начислений; подтверждённое отсутствие VM не подменяет финансовый отчёт.
- Сравнивать успешный provider task с фактической готовностью приложения. Timeout создания переводить в сверку по сохранённому operation ID/имени; не повторять POST вслепую.
- Продление, закрытие периода и grace period WAI должны соответствовать выбранному billing-режиму. Выключение, приостановка услуги и подтверждённое удаление являются разными действиями.
- Резервные копии и экспорт проверять восстановлением, а не наличием галочки backup. Ответственность за ОС/root и за инфраструктурный аккаунт объяснить клиенту до оплаты.

## Evidence бесплатных API-проверок

Выполнены GET без credentials 04.10.2026; ниже только существенные публичные поля.

| Запрос | Результат |
|---|---|
| `https://api.vultr.com/v2/plans` | HTTP 200; `vc2-2c-4gb`, 4096 MB, 2 vCPU, 80 GB, `monthly_cost:20`, `hourly_cost:0.027`, `fra` среди locations; `sao.monthly_cost:30`. |
| `https://api.linode.com/v4/linode/types/g6-standard-2` | HTTP 200; 4096 MB, 2 vCPU, 81920 MB disk; $24/month, $0.036/hour; Jakarta $28.80, São Paulo $33.60. |
| `https://api.agentmetal.dev/v1/catalog` | HTTP 200; nano/small/medium и ash/hil; цены указаны выше. |
| `https://compute.x402layer.cc/compute/plans` | HTTP 403 из этой среды. Каталог не проверен; причина отказа не установлена. |

Публичные страницы и API не доказывают account approval, свободную мощность, доступность оплаты из конкретной страны или фактическую выдачу VM. Актуальные результаты реализации и живой проверки WAI записываются отдельно в ACCEPTANCE.md.

## Проверка HTML-обзора

4 октября `outputs/provider-options.html` был визуально проверен в браузере Codex: desktop и 390 × 844, без горизонтального переполнения, фильтры 10 / 4 / 2 строки. 5 октября обновлён текст результата пилота; дата исследования цен сохранена. Внешних JS/CSS/font-зависимостей нет.

## OpenStrudel Home: уточнение 5 октября

Бесплатный authenticated Kamatera API подтвердил Ubuntu Server 24.04, 1A, 4096 MB, 30 GB, IPv4, EU и t5000. Публичный калькулятор дал $14 базово + 2% = $14,28/месяц. Account-specific price и налоги не проверены; это не розничная котировка. Proof: `outputs/openstrudel-profile-proof.json`. Backend Home опубликован на server.waiwai.is с закрытой покупкой до нового бюджета и полной живой приёмки. Старый $12 профиль 2/20 — другой продукт. В коротком HTML отражено это разделение; остальные сравнительные цены сохраняют дату исследования 04.10.2026.
