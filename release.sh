#!/usr/bin/env bash
# ==============================================================================
# 千面 Facet - 打包与发布触发脚本
# 功能: 推送代码与 Tag 到 GitHub，触发 Release 打包工作流，监听构建进度并弹窗提醒
# 特性: 所有网络操作（git push、GitHub API 请求）均内置指数退避重试机制
# ==============================================================================

set -eo pipefail

# 终端彩色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 工作目录设置为脚本所在项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ------------------------------------------------------------------------------
# 辅助函数: 使用 Node 执行脚本/提取数据（避免依赖 jq）
# ------------------------------------------------------------------------------
run_node() {
  node -e "$1" "${@:2}"
}

# ------------------------------------------------------------------------------
# 网络错误重试机制 1: Git 网络操作重试 (带指数退避)
# ------------------------------------------------------------------------------
retry_git() {
  local max_retries=5
  local base_delay=3
  local attempt=1
  local cmd=("$@")

  while [ $attempt -le $max_retries ]; do
    echo -e "${BLUE}==> [Git 网络请求] 执行: git ${cmd[*]} (尝试 $attempt/$max_retries)${NC}"
    if git "${cmd[@]}"; then
      return 0
    fi

    local exit_code=$?
    if [ $attempt -lt $max_retries ]; then
      local wait_time=$(( base_delay * (2 ** (attempt - 1)) ))
      echo -e "${YELLOW}警告: git 命令执行异常 (退出码 $exit_code)，${wait_time} 秒后进行重试...${NC}"
      sleep "$wait_time"
    fi
    attempt=$((attempt + 1))
  done

  echo -e "${RED}错误: git 网络请求在重试 $max_retries 次后仍然失败: git ${cmd[*]}${NC}" >&2
  return 1
}

# ------------------------------------------------------------------------------
# 网络错误重试机制 2: GitHub REST API 请求重试 (带指数退避与状态码判断)
# ------------------------------------------------------------------------------
curl_api_with_retry() {
  local url="$1"
  shift
  local max_retries=5
  local base_delay=3
  local attempt=1
  local temp_file
  temp_file=$(mktemp)

  while [ $attempt -le $max_retries ]; do
    local http_code
    # 结合 curl 原生重试参数及外层防护
    http_code=$(curl -sS -w "%{http_code}" -o "$temp_file" \
      --connect-timeout 10 \
      --max-time 45 \
      --retry 2 \
      --retry-delay 1 \
      --retry-all-errors \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
      "$@" "$url" 2>/dev/null || echo "000")
    local curl_exit=$?

    # 成功的 HTTP 状态码: 200 OK, 201 Created, 204 No Content
    if [ "$curl_exit" -eq 0 ] && [[ "$http_code" =~ ^(200|201|204)$ ]]; then
      cat "$temp_file"
      rm -f "$temp_file"
      return 0
    fi

    # 客户端不可恢复错误 (401 认证未通过、404 不存在) 不需要盲目无限重试
    if [ "$curl_exit" -eq 0 ] && [[ "$http_code" =~ ^(401|404)$ ]]; then
      echo -e "${RED}API 请求返回致命错误 (HTTP $http_code): $url${NC}" >&2
      cat "$temp_file" >&2
      rm -f "$temp_file"
      return 1
    fi

    if [ $attempt -lt $max_retries ]; then
      local wait_time=$(( base_delay * (2 ** (attempt - 1)) ))
      echo -e "${YELLOW}API 请求异常 (HTTP $http_code, curl 退出码 $curl_exit)，正在重试 ($attempt/$max_retries)... 等待 ${wait_time}s${NC}" >&2
      sleep "$wait_time"
    fi
    attempt=$((attempt + 1))
  done

  echo -e "${RED}错误: API 请求在 $max_retries 次重试后失败: $url${NC}" >&2
  cat "$temp_file" >&2
  rm -f "$temp_file"
  return 1
}

# ------------------------------------------------------------------------------
# 弹窗通知函数 (支持 Windows 原生 MessageBox, Linux notify-send, macOS osascript)
# ------------------------------------------------------------------------------
notify_user() {
  local title="$1"
  local message="$2"
  local status="$3" # "success" 或 "error"

  # 控制台蜂鸣提醒
  printf '\a' 2>/dev/null || true

  local icon_code=64 # 64: Information, 16: Error
  if [ "$status" = "error" ]; then
    icon_code=16
  fi

  # 1. Windows 环境 (Git Bash / MSYS2 / WSL 支持调用 powershell.exe)
  if command -v powershell.exe >/dev/null 2>&1; then
    # 通过后台子进程弹窗，避免终端被阻塞
    (
      powershell.exe -NoProfile -Command "
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
        [System.Windows.Forms.MessageBox]::Show(\"$message\", \"$title\", 0, $icon_code)
      " >/dev/null 2>&1
    ) &
    return 0
  fi

  # 2. Linux 桌面环境 (notify-send)
  if command -v notify-send >/dev/null 2>&1; then
    local urgency="normal"
    [ "$status" = "error" ] && urgency="critical"
    notify-send -u "$urgency" "$title" "$message" 2>/dev/null &
    return 0
  fi

  # 3. macOS 环境 (osascript)
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$message\" with title \"$title\"" 2>/dev/null &
    return 0
  fi

  echo -e "${BOLD}[系统提醒] $title - $message${NC}"
}

# ------------------------------------------------------------------------------
# 帮助信息
# ------------------------------------------------------------------------------
show_help() {
  cat << EOF
用法: ./release.sh [选项] [TAG]

参数:
  TAG                    发布标签 (例如: v0.2.14)。未提供时默认从 package.json 读取

选项:
  -f, --force            如果本地或远程 Tag 已存在，强制覆盖并推送
  -b, --branch BRANCH    指定推送的 Git 分支 (默认: 当前分支)
  -d, --dispatch         仅触发 GitHub Actions workflow_dispatch，不推送 Tag
  --no-push-code         跳过分支代码推送，仅推送 Tag 并触发打包
  --no-wait              触发工作流后立即退出，不阻塞等待打包结果
  -y, --yes              跳过确认提示，直接执行
  -h, --help             显示此帮助信息

示例:
  ./release.sh                  # 自动从 package.json 获取版本并发布
  ./release.sh v0.2.15          # 指定发布 v0.2.15
  ./release.sh -f               # 强制重新打当前版本的 Tag 并重新构建
  ./release.sh -d               # 仅触发工作流打包发布
EOF
}

# ------------------------------------------------------------------------------
# 解析命令行参数
# ------------------------------------------------------------------------------
CUSTOM_TAG=""
FORCE=false
BRANCH=""
DISPATCH_ONLY=false
NO_PUSH_CODE=false
NO_WAIT=false
AUTO_YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force)
      FORCE=true
      shift
      ;;
    -b|--branch)
      BRANCH="$2"
      shift 2
      ;;
    -d|--dispatch)
      DISPATCH_ONLY=true
      shift
      ;;
    --no-push-code)
      NO_PUSH_CODE=true
      shift
      ;;
    --no-wait)
      NO_WAIT=true
      shift
      ;;
    -y|--yes)
      AUTO_YES=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    v[0-9]*|[0-9]*)
      CUSTOM_TAG="$1"
      shift
      ;;
    *)
      echo -e "${RED}未知选项: $1${NC}"
      show_help
      exit 1
      ;;
  esac
done

# ------------------------------------------------------------------------------
# 环境与前置检查
# ------------------------------------------------------------------------------
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo -e "${RED}错误: 当前目录不是有效的 Git 仓库！${NC}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}错误: 未检测到 Node.js，请先安装 Node.js 环境！${NC}" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo -e "${RED}错误: 未检测到 curl 工具，请先安装 curl！${NC}" >&2
  exit 1
fi

# 自动获取 GitHub Token
if [ -z "$GITHUB_TOKEN" ] && [ -n "$GH_TOKEN" ]; then
  GITHUB_TOKEN="$GH_TOKEN"
fi
if [ -z "$GITHUB_TOKEN" ] && command -v gh >/dev/null 2>&1; then
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
fi

# 获取远程仓库信息 (解析 owner 与 repo)
REMOTE_URL=$(git config --get remote.origin.url || true)
if [ -z "$REMOTE_URL" ]; then
  echo -e "${RED}错误: 未找到 remote.origin.url，请确认已关联远程仓库！${NC}" >&2
  exit 1
fi

REPO_FULL=$(run_node '
  const u = process.argv[1];
  const m = u.match(/github\.com[:\/]([^\/]+\/[^\/\.]+?)(?:\.git)?$/);
  if (m) console.log(m[1]);
' "$REMOTE_URL")

if [ -z "$REPO_FULL" ]; then
  echo -e "${RED}错误: 无法从远程 URL ($REMOTE_URL) 解析出 GitHub 仓库名称！${NC}" >&2
  exit 1
fi

# 当前分支
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
TARGET_BRANCH="${BRANCH:-$CURRENT_BRANCH}"

# 读取 package.json 版本
PKG_NAME=$(run_node 'console.log(require("./package.json").name || "facet")')
PKG_VERSION=$(run_node 'console.log(require("./package.json").version)')

if [ -z "$CUSTOM_TAG" ]; then
  TARGET_TAG="v$PKG_VERSION"
else
  if [[ "$CUSTOM_TAG" =~ ^v ]]; then
    TARGET_TAG="$CUSTOM_TAG"
  else
    TARGET_TAG="v$CUSTOM_TAG"
  fi
fi

CURRENT_HEAD_SHA=$(git rev-parse HEAD)
SHORT_HEAD_SHA=$(git rev-parse --short HEAD)

echo -e "${BOLD}${CYAN}====================================================${NC}"
echo -e "${BOLD}${CYAN}          千面 Facet - 打包与发布脚本               ${NC}"
echo -e "${BOLD}${CYAN}====================================================${NC}"
echo -e "项目名称:    ${GREEN}$PKG_NAME${NC}"
echo -e "当前版本:    ${GREEN}$PKG_VERSION${NC}"
echo -e "发布标签:    ${BOLD}${YELLOW}$TARGET_TAG${NC}"
echo -e "远程仓库:    ${CYAN}$REPO_FULL${NC}"
echo -e "推送分支:    ${CYAN}$TARGET_BRANCH${NC}"
echo -e "当前 Commit: ${CYAN}$SHORT_HEAD_SHA${NC}"
if [ -n "$GITHUB_TOKEN" ]; then
  echo -e "GitHub 凭证: ${GREEN}已检测并加载${NC}"
else
  echo -e "GitHub 凭证: ${YELLOW}未配置 (公开接口有限流限制，如需更多额度请配置 GITHUB_TOKEN)${NC}"
fi
echo -e "${CYAN}----------------------------------------------------${NC}"

# 检查是否有未提交更改
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${YELLOW}提示: 检测到本地工作区存在未提交的更改。${NC}"
  git status --short
  echo -e "${YELLOW}建议先完成提交再进行发布，避免发布代码与本地不一致。${NC}"
fi

if [ "$AUTO_YES" != true ]; then
  read -r -p "确认开始执行推送并触发打包发布流程？(y/N) " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}操作已取消。${NC}"
    exit 0
  fi
fi

# 记录当前执行触发的时间戳 (用于后续精准定位生成的 Actions Run)
START_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ------------------------------------------------------------------------------
# 步骤 1: 推送分支代码 (若启用)
# ------------------------------------------------------------------------------
if [ "$NO_PUSH_CODE" = false ]; then
  echo -e "\n${BOLD}${BLUE}==> [步骤 1/4] 推送当前分支代码到远程 (${TARGET_BRANCH})...${NC}"
  retry_git push origin "$TARGET_BRANCH"
else
  echo -e "\n${YELLOW}==> [步骤 1/4] 已跳过分支代码推送${NC}"
fi

# ------------------------------------------------------------------------------
# 步骤 2: 处理版本 Tag 并推送 (或调用 dispatch)
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}==> [步骤 2/4] 处理版本 Tag: ${TARGET_TAG}...${NC}"

if [ "$DISPATCH_ONLY" = true ]; then
  echo -e "${CYAN}使用 workflow_dispatch 触发工作流...${NC}"
  DISPATCH_PAYLOAD=$(run_node '
    const tag = process.argv[1];
    console.log(JSON.stringify({
      ref: process.argv[2],
      inputs: { tag_name: tag }
    }));
  ' "$TARGET_TAG" "$TARGET_BRANCH")

  curl_api_with_retry \
    "https://api.github.com/repos/$REPO_FULL/actions/workflows/release.yml/dispatches" \
    -X POST \
    -d "$DISPATCH_PAYLOAD"
  echo -e "${GREEN}workflow_dispatch 触发请求已成功发送！${NC}"
else
  # 检查本地 Tag
  LOCAL_TAG_EXISTS=false
  if git rev-parse "$TARGET_TAG" >/dev/null 2>&1; then
    LOCAL_TAG_EXISTS=true
  fi

  if [ "$LOCAL_TAG_EXISTS" = true ]; then
    TAG_COMMIT=$(git rev-list -n 1 "$TARGET_TAG")
    if [ "$TAG_COMMIT" != "$CURRENT_HEAD_SHA" ]; then
      if [ "$FORCE" = true ]; then
        echo -e "${YELLOW}Tag $TARGET_TAG 指向旧提交，强制更新到当前 HEAD...${NC}"
        git tag -fa "$TARGET_TAG" -m "Release $TARGET_TAG"
      else
        echo -e "${RED}错误: Tag $TARGET_TAG 已存在但未指向当前提交！${NC}"
        echo -e "Tag 提交: $TAG_COMMIT"
        echo -e "当前 HEAD: $CURRENT_HEAD_SHA"
        echo -e "若需强制覆盖该 Tag，请重新运行脚本并携带参数: ${YELLOW}-f${NC} 或 ${YELLOW}--force${NC}"
        exit 1
      fi
    else
      echo -e "${GREEN}Tag $TARGET_TAG 已存在并精确指向当前提交。${NC}"
    fi
  else
    echo -e "创建本地 Tag: ${GREEN}$TARGET_TAG${NC} ..."
    git tag -a "$TARGET_TAG" -m "Release $TARGET_TAG"
  fi

  # 推送 Tag 到远程 (带重试机制)
  echo -e "正在推送 Tag 到 GitHub..."
  if [ "$FORCE" = true ]; then
    retry_git push origin "$TARGET_TAG" --force
  else
    retry_git push origin "$TARGET_TAG"
  fi
  echo -e "${GREEN}Tag $TARGET_TAG 已成功推送到远程仓库，GitHub Actions 已自动触发！${NC}"
fi

# 若用户指定不等待，则直接退出
if [ "$NO_WAIT" = true ]; then
  echo -e "\n${GREEN}发布触发已完成！已指定 --no-wait，脚本结束。${NC}"
  exit 0
fi

# ------------------------------------------------------------------------------
# 步骤 3: 定位本次触发的 GitHub Actions Workflow Run
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}==> [步骤 3/4] 正在检测并连接 GitHub Actions 工作流...${NC}"

RUN_ID=""
RUN_HTML_URL=""
MAX_DISCOVERY_ATTEMPTS=15
DISCOVERY_INTERVAL=4

for ((i=1; i<=MAX_DISCOVERY_ATTEMPTS; i++)); do
  echo -e "查询 Actions 运行队列 (第 $i/$MAX_DISCOVERY_ATTEMPTS 次尝试)..."
  RUNS_JSON=$(curl_api_with_retry "https://api.github.com/repos/$REPO_FULL/actions/runs?per_page=10")

  MATCHED_RUN=$(run_node '
    const data = JSON.parse(process.argv[1]);
    const targetTag = process.argv[2];
    const targetBranch = process.argv[3];
    const runs = data.workflow_runs || [];
    
    // 优先匹配 tag push 的 run
    let found = runs.find(r => 
      (r.head_branch === targetTag || r.name === "Release Package") &&
      ["queued", "in_progress", "completed"].includes(r.status)
    );
    
    // 次选：最近一小时内的 Release Package 工作流
    if (!found) {
      found = runs.find(r => r.name === "Release Package");
    }

    if (found) {
      console.log(JSON.stringify({ id: found.id, url: found.html_url, status: found.status }));
    }
  ' "$RUNS_JSON" "$TARGET_TAG" "$TARGET_BRANCH")

  if [ -n "$MATCHED_RUN" ]; then
    RUN_ID=$(run_node 'console.log(JSON.parse(process.argv[1]).id)' "$MATCHED_RUN")
    RUN_HTML_URL=$(run_node 'console.log(JSON.parse(process.argv[1]).url)' "$MATCHED_RUN")
    break
  fi

  sleep "$DISCOVERY_INTERVAL"
done

if [ -z "$RUN_ID" ]; then
  echo -e "${YELLOW}未能立即获取到自动关联的 Run ID。您可直接在浏览器中查看进展:${NC}"
  echo -e "工作流页面: ${CYAN}https://github.com/$REPO_FULL/actions${NC}"
  notify_user "千面 Facet 打包已触发" "工作流已推送到 GitHub，请在浏览器查看: https://github.com/$REPO_FULL/actions" "success"
  exit 0
fi

echo -e "${GREEN}成功连接到构建任务！${NC}"
echo -e "任务 ID:    ${BOLD}$RUN_ID${NC}"
echo -e "实时日志:  ${BOLD}${CYAN}$RUN_HTML_URL${NC}"

# ------------------------------------------------------------------------------
# 步骤 4: 循环轮询工作流状态直到完成
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}==> [步骤 4/4] 监控打包进度中 (每 10 秒刷新一次)...${NC}"

SECONDS_ELAPSED=0
POLL_INTERVAL=10
RUN_STATUS="queued"
RUN_CONCLUSION=""

while true; do
  RUN_DATA=$(curl_api_with_retry "https://api.github.com/repos/$REPO_FULL/actions/runs/$RUN_ID")

  RUN_STATUS=$(run_node 'console.log(JSON.parse(process.argv[1]).status || "")' "$RUN_DATA")
  RUN_CONCLUSION=$(run_node 'console.log(JSON.parse(process.argv[1]).conclusion || "")' "$RUN_DATA")

  MINUTES=$((SECONDS_ELAPSED / 60))
  SECS=$((SECONDS_ELAPSED % 60))
  TIME_STR="${MINUTES}分${SECS}秒"

  case "$RUN_STATUS" in
    queued)
      echo -e "[${TIME_STR}] 状态: ${YELLOW}排队中 (queued)${NC} ..."
      ;;
    in_progress)
      echo -e "[${TIME_STR}] 状态: ${CYAN}正在打包中 (in_progress)${NC} ..."
      ;;
    completed)
      echo -e "[${TIME_STR}] 状态: ${BOLD}已结束 (completed)${NC}，结论: ${BOLD}$RUN_CONCLUSION${NC}"
      break
      ;;
    *)
      echo -e "[${TIME_STR}] 状态: $RUN_STATUS"
      ;;
  esac

  sleep "$POLL_INTERVAL"
  SECONDS_ELAPSED=$((SECONDS_ELAPSED + POLL_INTERVAL))
done

# ------------------------------------------------------------------------------
# 结果判定与弹出桌面提醒
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${CYAN}====================================================${NC}"
RELEASE_URL="https://github.com/$REPO_FULL/releases/tag/$TARGET_TAG"

if [ "$RUN_CONCLUSION" = "success" ]; then
  echo -e "${BOLD}${GREEN}🎉 打包构建与 Release 发布成功！${NC}"
  echo -e "版本标签: ${GREEN}$TARGET_TAG${NC}"
  echo -e "Release 页面: ${CYAN}$RELEASE_URL${NC}"
  echo -e "工作流日志:  ${CYAN}$RUN_HTML_URL${NC}"
  echo -e "${BOLD}${CYAN}====================================================${NC}"

  # 弹出系统成功提醒
  notify_user "千面 Facet - 打包完成！" "版本 $TARGET_TAG 安装包已成功打包并上传至 GitHub Release！`nRelease 地址: $RELEASE_URL" "success"

  exit 0
else
  echo -e "${BOLD}${RED}❌ 打包工作流未成功完成！${NC}"
  echo -e "最终结论: ${RED}$RUN_CONCLUSION${NC}"
  echo -e "详细日志请查看: ${CYAN}$RUN_HTML_URL${NC}"
  echo -e "${BOLD}${CYAN}====================================================${NC}"

  # 弹出系统失败提醒
  notify_user "千面 Facet - 打包失败" "工作流运行失败 (结论: $RUN_CONCLUSION)！`n请查看日志: $RUN_HTML_URL" "error"

  exit 1
fi
