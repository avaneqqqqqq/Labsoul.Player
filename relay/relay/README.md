# labsoul relay

Маленький сервер-посредник для SoundCloud. Бесплатно, на вашем аккаунте.

## Зачем

`soundcloud.com` заблокирован у провайдеров. Сами Netlify и Cloudflare в
России открываются напрямую. Значит можно поставить посредника: плеер
ходит к нему, а он — к SoundCloud.

## Развернуть на Netlify

1. Откройте https://app.netlify.com/start
2. Выберите GitHub → репозиторий `labsoul-relay`
3. Build command: `echo build`
4. Publish directory: `public`
5. Deploy

Через минуту получите адрес вида `random-name.netlify.app`.
Скопируйте его в плеере: **Настройки → SoundCloud → Релеи**.

## Развернуть на Cloudflare Workers

1. Откройте https://dash.cloudflare.com → Workers & Pages → Create
2. Вставьте код из `worker-bundle.js`
3. Deploy → получите адрес `*.workers.dev`
4. Добавьте его вторым релеем в плеер

## Как это работает

```
плеер → labsoul-relay.netlify.app/p/<адрес> → soundcloud.com
```

Разрешены только домены SoundCloud. Чужие запросы отклоняются.

## Лимиты

- Netlify: 100 ГБ/мес — около 20 000 треков
- Cloudflare: 100 000 запросов/день — около 9 000 треков

Лимит **у каждого свой**: каждый разворачивает на своём аккаунте.
