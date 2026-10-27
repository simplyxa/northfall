# Подключение Xsolla: продажа золота

Код уже в игре: раздел «Золото Севера» в меню «Магазин» и две серверные функции Netlify:
- `/.netlify/functions/xsolla-token` создаёт заказ и открывает окно оплаты;
- `/.netlify/functions/xsolla-webhook` получает от Xsolla сигнал об оплате и зачисляет золото.

Сколько золота даёт пакет, решает только сервер (`netlify/lib/packs.js`), поэтому подделать покупку из браузера нельзя.

## 1. Xsolla Publisher Account
1. Зарегистрируйтесь на https://publisher.xsolla.com и создайте проект (Project) «Northfall».
2. Запомните **Merchant ID** (в адресе и в Company settings) и **Project ID** (рядом с названием проекта).
3. Company settings → **API keys** → создайте ключ. Он показывается один раз: сразу вставьте его в Netlify (шаг 3).

## 2. Товары (пакеты золота)
Проект → **Store → Virtual items** (или Virtual currency → пакеты). Создайте 4 товара с **точно такими SKU** и ценами:

| SKU | Золото | Цена |
|---|---|---|
| gold_20 | 20 | 0,99 $ |
| gold_110 | 110 | 4,99 $ |
| gold_240 | 240 | 9,99 $ |
| gold_600 | 600 | 19,99 $ |

Золото — редкая валюта игры: 1 золото = 100 серебра (серебро — основная монета, её дают бои).

Товары должны быть включены (Available). Цены в игре — только подписи; если меняете цену в Xsolla, скажите мне, я поправлю подпись.

## 3. Вебхуки
Проект → **Project settings → Webhooks**:
- включите вебхуки;
- URL: `https://playnorthfall.online/.netlify/functions/xsolla-webhook`;
- скопируйте **Secret key**.

## 4. Ключ Firebase для сервера
Firebase → шестерёнка → **Project settings → Service accounts** → **Generate new private key**. Скачается JSON-файл: откройте его и скопируйте весь текст.

## 5. Переменные в Netlify
Netlify → сайт → **Site configuration → Environment variables → Add a variable**:

| Имя | Значение |
|---|---|
| XSOLLA_PROJECT_ID | Project ID |
| XSOLLA_MERCHANT_ID | Merchant ID |
| XSOLLA_API_KEY | API-ключ из шага 1 |
| XSOLLA_WEBHOOK_SECRET | Secret key из шага 3 |
| FIREBASE_SERVICE_ACCOUNT | весь текст JSON-файла из шага 4 |
| XSOLLA_SANDBOX | `1` (тестовый режим). Для настоящих денег — `0` |

После добавления: **Deploys → Trigger deploy → Deploy site**, чтобы функции увидели переменные.

## 6. Правила Firestore
Firebase → Firestore → **Rules**: вставьте новый `firestore.rules` из репозитория → **Publish**.

## 7. Тест
В тестовом режиме Xsolla принимает тестовую карту `4111 1111 1111 1111`, срок любой в будущем, CVV `123`. Золото должно прийти в течение минуты, а покупка появится в «Журнале покупок» у админа.

## 8. Настоящие платежи
Для приёма реальных денег в Publisher Account нужно подписать лицензионное соглашение (Agreements & Taxes) и пройти проверку. Затем поставьте `XSOLLA_SANDBOX` = `0` и сделайте Trigger deploy.
