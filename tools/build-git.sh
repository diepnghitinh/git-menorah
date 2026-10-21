#!/usr/bin/env bash
#
# Đóng gói trang Git (tools/git.html + git-server.mjs) và canvas agent thành app desktop "GitMenorah" (Electron).
#
#   tools/build-git.sh --platform=macosx              # .app + .dmg + .zip, theo chip máy đang build
#   tools/build-git.sh --platform=macosx --arch=x64   # cho Mac chip Intel (arm64 | x64 | universal)
#   tools/build-git.sh --platform=windows             # thư mục chạy liền + .zip, x64 (hoặc --arch=arm64)
#
# Kết quả nằm ở tools/git-desktop/dist/. Mã app ở tools/git-desktop/ — đọc đầu main.cjs.
#
# App chép git.html + git-server.mjs ĐANG CÓ trên đĩa vào gói ở lúc build: sửa trang Git
# thì build lại. Canvas agent (app/, workspace/) cũng chép nguyên trạng.
#
# PTY, giới hạn CPU / RAM, transcript và cổng menorah-context chạy ở menorah-agentd (Go, mã ở
# git-desktop/agentd/): build cần Go ≥ 1.22, dựng chéo được cho mọi nền tảng, không cần cgo.
#
# Build cho Windows chạy được ngay trên macOS (không cần wine). Build cho macOS cần
# chạy trên macOS (codesign, hdiutil).
#
# Ký số: macOS chỉ ký ad-hoc (đủ để chạy trên chip Apple), Windows không ký. Người nhận
# sẽ gặp cảnh báo lần mở đầu: macOS chuột phải app → Open, Windows bấm More info → Run anyway.
# Muốn hết cảnh báo phải có chứng thư: Apple Developer ID (+ notarize) và chứng thư
# code signing cho Windows.

set -euo pipefail

TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$TOOLS/git-desktop"
STAGE="$APP_DIR/build/app"
DIST="$APP_DIR/dist"
NAME="GitMenorah"
BUNDLE_ID="vn.christian.gitmenorah"

usage() { sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\033[36m▸ %s\033[0m\n' "$*"; }

PLATFORM="" ARCH=""
for a in "$@"; do
  case "$a" in
    --platform=*) PLATFORM="${a#*=}" ;;
    --arch=*) ARCH="${a#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Cờ lạ: $a" ;;
  esac
done

case "$PLATFORM" in
  macosx|macos|mac) PLATFORM=macosx; EP_PLATFORM=darwin; ICON="$APP_DIR/icon/icon.icns" ;;
  windows|win) PLATFORM=windows; EP_PLATFORM=win32; ICON="$APP_DIR/icon/icon.ico" ;;
  "") usage; die "Thiếu --platform=macosx|windows" ;;
  *) die "--platform phải là macosx hoặc windows (nhận: $PLATFORM)" ;;
esac

if [[ -z "$ARCH" ]]; then
  if [[ "$PLATFORM" == macosx ]]; then
    [[ "$(uname -m)" == arm64 ]] && ARCH=arm64 || ARCH=x64
  else
    ARCH=x64
  fi
fi
case "$PLATFORM:$ARCH" in
  macosx:arm64|macosx:x64|macosx:universal|windows:x64|windows:arm64) ;;
  *) die "--arch=$ARCH không dùng được cho $PLATFORM" ;;
esac
[[ "$PLATFORM" == macosx && "$(uname -s)" != Darwin ]] && die "Build cho macOS phải chạy trên macOS (cần codesign, hdiutil)."

command -v node >/dev/null || die "Chưa có node — cài Node ≥ 22.12."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || die "Node $(node -v) quá cũ — @electron/packager cần ≥ 22.12."
for f in git.html git-server.mjs; do [[ -f "$TOOLS/$f" ]] || die "Không thấy tools/$f"; done
command -v go >/dev/null || die "Chưa có Go — cài Go ≥ 1.22 (https://go.dev/dl) để dựng menorah-agentd."

# ─── Phụ thuộc ───────────────────────────────────────────────────────────────
# Chỉ cài khi chưa có hoặc package-lock.json mới hơn lần cài trước.
cd "$APP_DIR"
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  step "Cài Electron + packager (npm ci)"
  npm ci --no-audit --no-fund
fi
ELECTRON_VERSION="$(node -p 'require("electron/package.json").version')"
VERSION="$(node -p 'require("./package.json").version')"
REV="$(git -C "$TOOLS" rev-parse --short HEAD 2>/dev/null || echo nogit)"
[[ -n "$(git -C "$TOOLS" status --porcelain -- git.html git-server.mjs git-desktop 2>/dev/null)" ]] && REV="$REV+dirty"

# ─── Dựng thư mục app ────────────────────────────────────────────────────────
step "Gom mã app → build/app"
rm -rf "$STAGE"
mkdir -p "$STAGE/server/tools"
cp main.cjs "$STAGE/"
cp -R app workspace "$STAGE/"
cp "$TOOLS/git.html" "$TOOLS/git-server.mjs" "$STAGE/server/tools/"
# Gói chạy lúc chạy: xterm (main.cjs phục vụ ở menorah://app/vendor/).
mkdir -p "$STAGE/node_modules/@xterm"
for m in xterm addon-fit addon-unicode11 addon-web-links; do
  cp -R "node_modules/@xterm/$m" "$STAGE/node_modules/@xterm/"
done

# menorah-agentd → build/app/bin/ (agentd.cjs tìm ở <app>/bin/). Không cgo nên dựng chéo được.
# universal: dựng hai bản rồi gộp bằng lipo.
step "Dựng menorah-agentd (Go) cho $PLATFORM-$ARCH"
mkdir -p "$STAGE/bin"
go_arch() { [[ "$1" == x64 ]] && echo amd64 || echo "$1"; }
build_agentd() { # $1 GOOS, $2 GOARCH, $3 tệp ra
  (cd "$APP_DIR/agentd" && GOTOOLCHAIN=local CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build -trimpath -ldflags=-s -o "$3" .) \
    || die "Dựng menorah-agentd cho $1/$2 hỏng"
}
if [[ "$PLATFORM" == windows ]]; then
  build_agentd windows "$(go_arch "$ARCH")" "$STAGE/bin/menorah-agentd.exe"
elif [[ "$ARCH" == universal ]]; then
  build_agentd darwin arm64 "$STAGE/bin/menorah-agentd-arm64"
  build_agentd darwin amd64 "$STAGE/bin/menorah-agentd-x64"
  lipo -create -output "$STAGE/bin/menorah-agentd" "$STAGE/bin/menorah-agentd-arm64" "$STAGE/bin/menorah-agentd-x64"
  rm "$STAGE/bin/menorah-agentd-arm64" "$STAGE/bin/menorah-agentd-x64"
else
  build_agentd darwin "$(go_arch "$ARCH")" "$STAGE/bin/menorah-agentd"
fi
# Tệp chạy nằm trong Resources nên codesign --deep của cả gói không ký tới: ký riêng trước.
[[ "$PLATFORM" == macosx ]] && codesign --force --sign - "$STAGE/bin/menorah-agentd"

# package.json của gói: giữ dependencies (packager cần để không cắt node_modules), bỏ
# devDependencies, ghi commit đã build vào gitRevision — CFBundleVersion của macOS chỉ nhận
# số nên không nhét commit vào đó.
node -e '
  const p = require("./package.json");
  const out = { name: p.name, productName: p.productName, version: p.version, description: p.description, main: p.main, private: true, dependencies: p.dependencies, gitRevision: process.argv[2] };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$STAGE/package.json" "$REV"

# ─── Đóng gói ────────────────────────────────────────────────────────────────
step "Đóng gói $NAME $VERSION ($REV) cho $PLATFORM-$ARCH, Electron $ELECTRON_VERSION"
mkdir -p "$DIST"
# --no-asar: server là tệp .mjs chạy bằng tiến trình Node con, menorah-agentd phải chạy được
# từ đĩa — để ngoài asar cho đơn giản.
# --prune=false: node_modules đã gom tay ở trên, không để packager chạy npm prune.
npx --no-install electron-packager "$STAGE" "$NAME" \
  --platform="$EP_PLATFORM" --arch="$ARCH" \
  --electron-version="$ELECTRON_VERSION" \
  --out="$DIST" --overwrite --no-asar --prune=false \
  --icon="$ICON" \
  --app-version="$VERSION" --build-version="$VERSION" \
  --app-copyright="InChurch.app" \
  --app-bundle-id="$BUNDLE_ID" \
  --executable-name="GitMenorah" \
  --win32metadata.CompanyName="InChurch.app" \
  --win32metadata.ProductName="$NAME" \
  --win32metadata.FileDescription="$NAME" \
  --quiet

OUT_DIR="$DIST/$NAME-$EP_PLATFORM-$ARCH"
[[ -d "$OUT_DIR" ]] || die "Không thấy $OUT_DIR sau khi đóng gói."
BASE="GitMenorah-$VERSION-$PLATFORM-$ARCH"

if [[ "$PLATFORM" == macosx ]]; then
  APP="$OUT_DIR/$NAME.app"
  # Packager sửa Info.plist nên chữ ký gốc của Electron hỏng — chip Apple từ chối chạy
  # app không chữ ký ("bị hỏng"). Ký ad-hoc lại cả gói.
  step "Ký ad-hoc"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"

  step "Nén .zip và .dmg"
  rm -f "$DIST/$BASE.zip" "$DIST/$BASE.dmg"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/$BASE.zip"
  DMG_SRC="$(mktemp -d)"
  ditto "$APP" "$DMG_SRC/$NAME.app"
  ln -s /Applications "$DMG_SRC/Applications"
  hdiutil create -quiet -volname "$NAME" -srcfolder "$DMG_SRC" -ov -format ULFO "$DIST/$BASE.dmg"
  rm -rf "$DMG_SRC"
  ARTIFACTS=("$DIST/$BASE.dmg" "$DIST/$BASE.zip" "$APP")
else
  step "Nén .zip"
  rm -f "$DIST/$BASE.zip"
  if command -v ditto >/dev/null; then
    ditto -c -k --keepParent "$OUT_DIR" "$DIST/$BASE.zip"
  elif command -v zip >/dev/null; then
    (cd "$DIST" && zip -qry "$BASE.zip" "$(basename "$OUT_DIR")")
  else
    powershell.exe -NoProfile -Command "Compress-Archive -Path '$OUT_DIR' -DestinationPath '$DIST/$BASE.zip' -Force"
  fi
  ARTIFACTS=("$DIST/$BASE.zip" "$OUT_DIR/$NAME.exe")
fi

printf '\n\033[32m✓ Xong\033[0m\n'
for f in "${ARTIFACTS[@]}"; do
  printf '  %-8s %s\n' "$(du -sh "$f" | cut -f1)" "${f#$TOOLS/}"
done
