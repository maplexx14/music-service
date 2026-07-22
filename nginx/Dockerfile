# Multi-stage: собираем nginx с brotli-модулем.
FROM nginx:1.27-alpine AS builder

RUN apk add --no-cache git gcc g++ make pcre-dev zlib-dev openssl-dev linux-headers cmake

# Brotli module + C library
RUN git clone --depth 1 https://github.com/google/ngx_brotli.git /tmp/ngx_brotli \
    && cd /tmp/ngx_brotli && git submodule update --init

# Собираем brotli C library (STATIC — встраивается в .so модули)
RUN cd /tmp/ngx_brotli/deps/brotli \
    && mkdir out && cd out \
    && cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_INSTALL_PREFIX=/usr/local .. \
    && make -j$(nproc) && make install

# Собираем nginx с brotli (тот же образ = та же совместимость)
RUN NGINX_VERSION=$(nginx -v 2>&1 | sed 's/.*\///') \
    && wget -q "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" -O /tmp/nginx.tar.gz \
    && cd /tmp && tar xzf nginx.tar.gz \
    && cd "nginx-${NGINX_VERSION}" \
    && export CFLAGS="-I/usr/local/include" \
    && export LDFLAGS="-L/usr/local/lib -lbrotlienc -lbrotlicommon" \
    && ./configure \
        --prefix=/etc/nginx \
        --sbin-path=/usr/sbin/nginx \
        --modules-path=/usr/lib64/nginx/modules \
        --conf-path=/etc/nginx/nginx.conf \
        --error-log-path=/var/log/nginx/error.log \
        --http-log-path=/var/log/nginx/access.log \
        --pid-path=/var/run/nginx.pid \
        --lock-path=/var/run/nginx.lock \
        --with-compat \
        --with-http_ssl_module \
        --with-http_v2_module \
        --with-http_realip_module \
        --with-http_gzip_static_module \
        --add-dynamic-module=/tmp/ngx_brotli \
    && make modules \
    && cp objs/ngx_http_brotli_filter_module.so /tmp/ \
    && cp objs/ngx_http_brotli_static_module.so /tmp/

# Runtime image — тот же базовый образ
FROM nginx:1.27-alpine

RUN apk add --no-cache pcre zlib openssl

# Копируем собранные модули
COPY --from=builder /tmp/ngx_http_brotli_filter_module.so /usr/lib64/nginx/modules/
COPY --from=builder /tmp/ngx_http_brotli_static_module.so /usr/lib64/nginx/modules/

# Добавляем load_module в main nginx.conf
RUN sed -i '1i load_module /usr/lib64/nginx/modules/ngx_http_brotli_filter_module.so;\nload_module /usr/lib64/nginx/modules/ngx_http_brotli_static_module.so;' /etc/nginx/nginx.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf
