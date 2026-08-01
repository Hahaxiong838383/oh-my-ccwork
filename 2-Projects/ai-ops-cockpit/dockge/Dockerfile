FROM louislam/dockge:1

COPY patch-subpath.mjs /usr/local/bin/patch-dockge-subpath.mjs

RUN node /usr/local/bin/patch-dockge-subpath.mjs /app/frontend-dist /dockge
