FROM node:20-alpine AS builder

WORKDIR /workspace

COPY . .
RUN npm ci

ARG MEDISUITE_ENV_FILE=deploy/env/medisuite.env
ARG MEDISCRIBE_ENV_FILE=deploy/env/mediscribe.env
ARG MEDIPAL_ENV_FILE=deploy/env/medipal.env
ARG GLUCOVITAL_ENV_FILE=deploy/env/gluco-vital.env

RUN test -f "$MEDISUITE_ENV_FILE"
RUN test -f "$MEDISCRIBE_ENV_FILE"
RUN test -f "$MEDIPAL_ENV_FILE"
RUN test -f "$GLUCOVITAL_ENV_FILE"

RUN set -a && . "$MEDISUITE_ENV_FILE" && set +a && npm run build -w @med-platform/medisuite
RUN set -a && . "$MEDISCRIBE_ENV_FILE" && set +a && npm run build -w @med-platform/mediscribe
RUN set -a && . "$MEDIPAL_ENV_FILE" && set +a && npm run build -w @med-platform/medipal
RUN set -a && . "$GLUCOVITAL_ENV_FILE" && set +a && npm run build -w @med-platform/gluco-vital

FROM nginx:1.27-alpine AS runtime

COPY deploy/nginx/frontend-gateway.conf /etc/nginx/nginx.conf
COPY --from=builder /workspace/apps/medisuite/dist /usr/share/nginx/html/medisuite
COPY --from=builder /workspace/apps/mediscribe/dist /usr/share/nginx/html/mediscribe
COPY --from=builder /workspace/apps/medipal/dist /usr/share/nginx/html/medipal
COPY --from=builder /workspace/apps/gluco-vital/dist /usr/share/nginx/html/gluco-vital

EXPOSE 4101 4102 4103 4104

CMD ["nginx", "-g", "daemon off;"]
