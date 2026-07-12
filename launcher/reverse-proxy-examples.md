# Reverse-proxy examples for embedding xgc2-lichtblick-web

The launcher binds to 127.0.0.1:8080 by default and serves the Lichtblick
web bundle. If you want to expose it to other machines or embed it inside
a larger webui at a sub-path, run a reverse proxy in front. Below are
working snippets; copy and adapt to taste.

## nginx: serve at /lichtblick/ on an existing site

```nginx
# /etc/nginx/sites-available/my-site.conf
server {
    listen 443 ssl http2;
    server_name ui.example.com;
    # ... your SSL config ...

    # Static bundle + WebSocket reverse-proxy for xgc2-lichtblick-web.
    # The launcher is started separately on 127.0.0.1:8080.
    location /lichtblick/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Lichtblick opens a long-lived WebSocket for live data.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout  1h;
        proxy_send_timeout  1h;
        proxy_buffering     off;
    }
}
```

Then start the launcher with:

```bash
xgc2-lichtblick-web --public-url-prefix /
```

The launcher serves `/lichtblick/ws` and `/ws`; nginx preserves that
path through `proxy_pass http://127.0.0.1:8080/` (the trailing slash
strips `/lichtblick`).

## Caddy: serve at a sub-path

```caddy
# /etc/caddy/Caddyfile
ui.example.com {
    reverse_proxy /lichtblick/* http://127.0.0.1:8080 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        # WebSocket upgrades are handled automatically.
    }
}
```

## iframe into another webui

If the parent webui is on a different origin, the launcher sets no
CORS headers today — same-origin embedding (parent served from the
same reverse proxy on a sub-path) is the supported path.

```html
<iframe
  src="/lichtblick/"
  style="border:0;width:100%;height:100%"
  title="Lichtblick"
></iframe>
```

## Exposing on the LAN without a reverse proxy

If you don't want a reverse proxy, just bind to a non-loopback address:

```bash
xgc2-lichtblick-web --host 0.0.0.0 --port 8080
```

This is fine for trusted networks but consider putting TLS in front
before exposing to the open internet.