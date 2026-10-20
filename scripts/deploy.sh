#!/usr/bin/env bash
# Automatically deploy dist/ to the ra2vm project on Vercel.
#
# Usage:
#   scripts/deploy.sh             # Build and deploy to production
#   scripts/deploy.sh --no-build  # Deploy existing dist/ without building
#   scripts/deploy.sh --preview   # Preview deployment without a production alias
#
# VERCEL_SCOPE must be explicit; never guess an account or team scope.
# Prerequisite: run vercel login locally or configure VERCEL_TOKEN.
set -euo pipefail

PROJECT=ra2vm
if [[ -z "${VERCEL_SCOPE:-}" ]]; then
  echo "[deploy] 请显式设置 VERCEL_SCOPE，再执行部署。" >&2
  exit 1
fi
SCOPE="$VERCEL_SCOPE"
SCOPE_ARGS=(--scope "$SCOPE")

NO_BUILD=0
PREVIEW=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --preview) PREVIEW=1 ;;
    *) echo "[deploy] 未知参数：$arg" >&2; exit 1 ;;
  esac
done

# 1. Check login.
if ! vercel whoami >/dev/null 2>&1; then
  echo "[deploy] 尚未登录 Vercel，请先执行 vercel login。" >&2
  exit 1
fi

# 2. Build unless --no-build is set.
if [[ $NO_BUILD -eq 0 ]]; then
  echo "[deploy] 构建 dist/ ..."
  pnpm run build
fi
[[ -f dist/index.html ]] || { echo "[deploy] dist/index.html 不存在，请先构建。" >&2; exit 1; }
# Existing output must retain its distribution materials too.
if [[ $NO_BUILD -eq 1 ]]; then
  pnpm run check:distribution
fi

# 3. Link the project on first use (creates Git-ignored .vercel/project.json).
if [[ ! -f .vercel/project.json ]]; then
  echo "[deploy] link 项目 $PROJECT ..."
  vercel link --yes --project "$PROJECT" "${SCOPE_ARGS[@]}"
fi

# 4. vercel deploy resolves the link from the deployment directory dist/ itself.
#    Copy project.json from the root into dist/ first; each build clears dist/.
mkdir -p dist/.vercel
cp .vercel/project.json dist/.vercel/

# 5. Deploy. --prod assigns the production alias; --preview creates only a preview URL.
PROD_ARGS=()
[[ $PREVIEW -eq 0 ]] && PROD_ARGS=(--prod)
vercel deploy dist --yes "${PROD_ARGS[@]}" "${SCOPE_ARGS[@]}"

echo "[deploy] 完成。"
