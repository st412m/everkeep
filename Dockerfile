# Standalone image: Everkeep over Streamable HTTP. Published as
# ghcr.io/st412m/everkeep by .github/workflows/image.yml on a version tag; to
# build it yourself:
#   docker build -t everkeep:1.1.0 .
# The server comes from npm, pinned below. To build from an `npm pack` tarball
# placed next to this file instead (before a release, or a local change):
#   docker build --build-arg EVERKEEP_TARBALL=everkeep-1.1.0.tgz -t everkeep:1.1.0 .
FROM node:22.23.3-alpine3.24

# A tarball in the build context, by file name; empty = everkeep from npm.
ARG EVERKEEP_TARBALL=

# poppler-utils: pdfinfo and pdftoppm (PDF pages as images); sqlite: sqlite3
# (sqlite_schema, sqlite_query). Not npm -g: it ignores --omit=optional, and
# the native @napi-rs/canvas must not be in the image (SIGILL on CPUs without
# AVX). npm may leave an empty node_modules/@napi-rs scope folder: removed if
# empty, then the build fails if it is still there. toolchain-check.sh runs
# through sh: a tarball packed on Windows has no exec bit.
RUN --mount=type=bind,target=/ctx \
    apk add --no-cache poppler-utils sqlite \
    && SRC=everkeep@1.1.0 \
    && if [ -n "$EVERKEEP_TARBALL" ]; then SRC="/ctx/$EVERKEEP_TARBALL"; fi \
    && mkdir -p /opt/everkeep \
    && cd /opt/everkeep \
    && npm install --ignore-scripts --omit=optional --no-package-lock --no-save "$SRC" \
    && ln -s /opt/everkeep/node_modules/.bin/everkeep /usr/local/bin/everkeep \
    && npm cache clean --force \
    && { rmdir /opt/everkeep/node_modules/@napi-rs 2>/dev/null || true; } \
    && ! test -e /opt/everkeep/node_modules/@napi-rs \
    && sh /opt/everkeep/node_modules/everkeep/scripts/toolchain-check.sh build \
    && mkdir -p /data /vault \
    && chown node:node /data

# The vault is mounted at /vault; /data holds the token and the document cache.
# The process runs as "node" (uid 1000): /data and the vault must be writable
# by it (or run the container as their owner with --user / user:).
ENV EVERKEEP_VAULT=/vault EVERKEEP_STATE_DIR=/data
VOLUME /data

USER node
EXPOSE 3100
CMD ["everkeep", "serve", "--host", "0.0.0.0", "--port", "3100"]
