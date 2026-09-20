FROM node:20-alpine

WORKDIR /app

# Both manifests, then a lockfile install.
#
# This was `COPY package.json` and `npm install`, which resolves a fresh dependency graph
# at build time and is free to pick versions nobody tested. The lockfile is committed and
# CI installs from it, so the production image was the one artifact in the pipeline not
# built from the reviewed tree. npm ci also fails loudly when the lockfile and manifest
# have drifted, where install would quietly reconcile them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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

CMD ["node", "index.js"]
