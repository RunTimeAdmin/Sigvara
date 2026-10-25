# Node 24 (LTS), pinned by digest. A tag moves; a digest is the bytes that were reviewed.
# Node 20 reached end of life on 30 April 2026 and the VPS compose files still run it.
# To move to a newer base: pull it, read the release notes, then change this line and the
# comment together.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

ENV NODE_ENV=production

WORKDIR /app

# Both manifests, then a lockfile install.
#
# This was `COPY package.json` and `npm install`, which resolves a fresh dependency graph
# at build time and is free to pick versions nobody tested. The lockfile is committed and
# CI installs from it, so the production image was the one artifact in the pipeline not
# built from the reviewed tree. npm ci also fails loudly when the lockfile and manifest
# have drifted, where install would quietly reconcile them.
#
# --ignore-scripts: no dependency runs code at install time. None of the locked packages
# has an install script today, so this costs nothing and keeps it that way when a future
# upgrade adds one.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy the source wholesale rather than naming each file.
#
# The list used to be enumerated, and it silently stopped matching reality: payments.js,
# merkle.js and metrics.js were all added afterwards and none were copied, so the image
# built cleanly and the container died on MODULE_NOT_FOUND the moment it started. Nobody
# noticed because the oracle was being run with `node index.js` on a desktop rather than
# from this image.
#
# .dockerignore keeps secrets, local state and tests out, so adding a module now works
# without touching this file.
COPY . .

# Fail the build if any local require has no file behind it, which is precisely how the
# enumerated COPY broke. Static check rather than requiring index.js, because requiring
# it starts the HTTP server and the epoch loop.
RUN node -e "\
const fs = require('fs'); \
const missing = []; \
for (const f of fs.readdirSync('.').filter(n => n.endsWith('.js'))) { \
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\('\.\/([\w.-]+)'\)/g)) { \
    const t = m[1].endsWith('.js') ? m[1] : m[1] + '.js'; \
    if (!fs.existsSync(t)) missing.push(f + ' -> ' + m[1]); \
  } \
} \
if (missing.length) { console.error('unresolved local requires:', missing); process.exit(1); } \
console.log('module graph ok'); \
"

# The commit this image was built from, so /health can say which code is running. The
# mainnet compose passes the pinned commit for both the build context and this argument.
# When given, it must be a full 40-character commit: a branch name or an abbreviation
# here means the context was not pinned, and the build stops rather than report a commit
# that says nothing.
ARG SIGVARA_COMMIT=
RUN if [ -n "$SIGVARA_COMMIT" ] && ! printf '%s' "$SIGVARA_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then \
      echo "SIGVARA_COMMIT must be a full 40-character lowercase commit hash, got: $SIGVARA_COMMIT" >&2; exit 1; \
    fi
ENV SIGVARA_COMMIT=$SIGVARA_COMMIT

# State lives on a mounted volume at /data. Created here and owned by the unprivileged
# user so that a fresh named volume inherits that ownership; a volume Docker creates
# from a path that does not exist in the image is root-owned and the oracle could not
# write to it. An existing root-owned volume from an older image needs a one-time chown.
# /app stays root-owned, so the process cannot rewrite its own code.
RUN mkdir -p /data && chown node:node /data

USER node

# /health answers 503 when the state path is not writable and 200 otherwise. The watcher
# runs from this image with no HTTP server, so its service turns this check off.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3030) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "index.js"]
