#!/usr/bin/env bash
# 共享验收门：pi 交付前自己跑（不带 --full），主 agent 验收跑 --full。
# 所有结果行以 GATE: 开头；没有 GATE: 行 = 输出崩坏。
#
#   gate.sh <manifest.json> --baseline   # 派发前抓基线用例名单
#   gate.sh <manifest.json>              # pi 自检（跳过回退验红）
#   gate.sh <manifest.json> --full       # 主 agent 验收（含回退验红）
#
# manifest 字段见 docs/agent-optimization/manifests/_template.json

set -uo pipefail

MANIFEST="${1:?用法: gate.sh <manifest.json> [--baseline|--full]}"
MANIFEST="$(cd "$(dirname "$MANIFEST")" && pwd)/$(basename "$MANIFEST")"
MODE="${2:-self}"
GIT=/usr/bin/git

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WT" || exit 90

q() { bun -e "const m=require('$MANIFEST');const v=m['$1'];console.log(Array.isArray(v)?v.join('\n'):(v??''))" 2>/dev/null; }

ID="$(q id)"
ALLOWED="$(q allowed_files)"
SOURCES="$(q source_files)"
TESTS="$(q test_files)"
MAXLINES="$(q max_source_lines)"
BANNED="$(q banned_patterns)"
[ -z "$MAXLINES" ] && MAXLINES=400

BASEDIR="$WT/docs/agent-optimization/baselines"
mkdir -p "$BASEDIR"
CASEFILE="$BASEDIR/$ID.cases"

# 用例名单：从测试文件里抽 describe/test/it 的标题。
collect_cases() {
  for f in $TESTS; do
    [ -f "$f" ] || continue
    grep -hoE '^[[:space:]]*(describe|test|it)(\.[a-zA-Z]+)?[[:space:]]*\([[:space:]]*["'"'"'`][^"'"'"'`]*' "$f" \
      | sed -E 's/^[[:space:]]*//; s/[[:space:]]*\([[:space:]]*["'"'"'`]/|/' \
      | sed "s|^|$f::|"
  done | sort
}

if [ "$MODE" = "--baseline" ]; then
  collect_cases > "$CASEFILE"
  echo "GATE: baseline id=$ID cases=$(wc -l < "$CASEFILE")"
  echo "GATE: baseline-head=$($GIT rev-parse --short HEAD)"
  exit 0
fi

FAIL=0
note() { echo "GATE: $1"; }
bad()  { echo "GATE: $1"; FAIL=1; }

note "id=$ID mode=$MODE head=$($GIT rev-parse --short HEAD)"

# 1. 越界：改动文件必须全在白名单内
CHANGED="$($GIT status --porcelain | sed -E 's/^.{3}//' | sed 's/.* -> //')"
OOB=0
for f in $CHANGED; do
  case "$f" in
    docs/agent-optimization/*) continue ;;
  esac
  if ! echo "$ALLOWED" | grep -qxF "$f"; then
    bad "out-of-bounds $f"
    OOB=1
  fi
done
[ "$OOB" = 0 ] && note "out-of-bounds none"

# 2. 改动规模
TOTAL=0
for f in $SOURCES; do
  # 新建的源码文件还没进索引，`git diff` 看不见它（实测漏过一整个新 hook 文件）：
  # 未跟踪就按整份行数计，否则规模上限对新增文件等于不设防。
  if $GIT ls-files --error-unmatch "$f" > /dev/null 2>&1; then
    n="$($GIT diff --numstat HEAD -- "$f" | awk '{s+=$1+$2} END{print s+0}')"
  else
    n="$(wc -l < "$f" 2>/dev/null || echo 0)"
  fi
  TOTAL=$((TOTAL + n))
done
if [ "$TOTAL" -gt "$MAXLINES" ]; then
  bad "size source-lines=$TOTAL limit=$MAXLINES EXCEEDED"
else
  note "size source-lines=$TOTAL limit=$MAXLINES"
fi

# 3. 禁用写法
if [ -n "$BANNED" ]; then
  # 只看**新增**行：整份 diff 里搜的话，删掉一行禁用写法反而会被判成「引入了它」
  # （移除行带 `-` 前缀，grep 分不出来）。实测在第 05 条上误报过一次。
  # 未跟踪的新文件 `git diff` 看不见，整份补一遍。
  DIFF="$($GIT diff HEAD -- $ALLOWED | grep '^+' | grep -v '^+++')"
  for f in $ALLOWED; do
    if [ -f "$f" ] && ! $GIT ls-files --error-unmatch "$f" > /dev/null 2>&1; then
      DIFF="$DIFF
$(cat "$f")"
    fi
  done
  BHIT=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if echo "$DIFF" | grep -qE "$p"; then bad "banned-pattern $p"; BHIT=1; fi
  done <<< "$BANNED"
  [ "$BHIT" = 0 ] && note "banned-pattern none"
fi

# 4. 现有用例不丢
if [ -f "$CASEFILE" ]; then
  NOW="$(collect_cases)"
  MISSING="$(comm -23 "$CASEFILE" <(echo "$NOW"))"
  if [ -n "$MISSING" ]; then
    bad "cases-missing $(echo "$MISSING" | wc -l)"
    echo "$MISSING" | sed 's/^/GATE:   lost /'
  else
    note "cases-missing none (baseline=$(wc -l < "$CASEFILE") now=$(echo "$NOW" | wc -l))"
  fi
else
  bad "cases-baseline MISSING (先跑 --baseline)"
fi

# 5. typecheck
if bun run typecheck > /tmp/gate-tc.$$ 2>&1; then
  note "typecheck PASS"
else
  bad "typecheck FAIL"; tail -25 /tmp/gate-tc.$$ | sed 's/^/GATE:   /'
fi
rm -f /tmp/gate-tc.$$

# 6. lint
if bun run lint > /tmp/gate-lint.$$ 2>&1; then
  note "lint PASS"
else
  bad "lint FAIL"; tail -25 /tmp/gate-lint.$$ | sed 's/^/GATE:   /'
fi
rm -f /tmp/gate-lint.$$

# 7. 相关测试必须全绿
if [ -n "$TESTS" ]; then
  T0=$(date +%s)
  if bun test --parallel $TESTS > /tmp/gate-test.$$ 2>&1; then
    T1=$(date +%s); DUR=$((T1 - T0))
    note "tests PASS ($(grep -oE '^ *[0-9]+ pass' /tmp/gate-test.$$ | tail -1 | tr -s ' ' | sed 's/^ //'), ${DUR}s)"
    # 慢用例守卫：整个套件基线约 11 秒，单个文件集合跑过 60 秒必然是有人写了
    # 真等超时的用例（实测出现过一条等 600 秒的）。门只看结果不看耗时的话拦不住。
    LIMIT="${GATE_TEST_MAX_SECONDS:-60}"
    if [ "$DUR" -gt "$LIMIT" ]; then
      bad "tests-duration ${DUR}s 超过 ${LIMIT}s —— 检查是不是写了真的等超时的用例"
    fi
  else
    bad "tests FAIL"; tail -35 /tmp/gate-test.$$ | sed 's/^/GATE:   /'
  fi
  rm -f /tmp/gate-test.$$
fi

# 8. 回退验红（只在 --full）：源码换回 HEAD，测试必须变红。
#    专抓「用例空转却报已覆盖」。
REVERT_RED="$(bun -e "const m=require('$MANIFEST');console.log(m.revert_red===false?'off':'on')" 2>/dev/null)"
if [ "$MODE" = "--full" ] && [ "$REVERT_RED" = "off" ]; then
  # 纯搬家型任务（抽函数、换模块位置）没有新用例，退回后原用例照样绿是正常的。
  # 这类任务的验收锚点写在 manifest 的 revert_red_reason 里，由主 agent 逐条判断。
  note "revert-red SKIPPED（manifest 显式关闭：$(bun -e "console.log(require('$MANIFEST').revert_red_reason||'未填理由')" 2>/dev/null)）"
fi
if [ "$MODE" = "--full" ] && [ "$REVERT_RED" != "off" ] && [ -n "$TESTS" ] && [ -n "$SOURCES" ]; then
  TMP="$(mktemp -d)"
  SUMBEFORE="$(sha256sum $SOURCES 2>/dev/null)"
  for f in $SOURCES; do
    mkdir -p "$TMP/$(dirname "$f")"
    cp "$f" "$TMP/$f" 2>/dev/null
    if $GIT cat-file -e "HEAD:$f" 2>/dev/null; then
      $GIT show "HEAD:$f" > "$f"
    else
      rm -f "$f"   # pi 新建的源码文件：回退 = 删除
    fi
  done
  if bun test --parallel $TESTS > /tmp/gate-revert.$$ 2>&1; then
    bad "revert-red FAIL 源码退回 HEAD 后测试仍然全绿 = 用例没有真正覆盖改动"
  else
    note "revert-red PASS (退回 HEAD 后测试变红，符合预期)"
  fi
  rm -f /tmp/gate-revert.$$
  for f in $SOURCES; do
    if [ -f "$TMP/$f" ]; then cp "$TMP/$f" "$f"; fi
  done
  if [ "$(sha256sum $SOURCES 2>/dev/null)" = "$SUMBEFORE" ]; then
    note "restore PASS (源码已还原，校验和一致)"
  else
    bad "restore FAIL 源码未能还原，手工检查 $TMP"
  fi
  rm -rf "$TMP"
fi

# 8.5 端到端冒烟（只在 --full）：单测全绿也可能改变端到端行为。
#     agent-resilience-smoke 用内置桩推理服务、1.4 秒跑完、不依赖任何真实服务，
#     把重试 / 截断转存 / 子智能体 / 压缩串在同一条任务里。第 18b 条（工具输出
#     上限按窗口缩放）就是被它抓出来改变了压缩触发时机 —— 2340 条单测全绿。
#     `test:smoke` 里其它脚本要连真实服务，仍然不进门。
if [ "$MODE" = "--full" ] && [ -f apps/studio/scripts/agent-resilience-smoke.ts ]; then
  if (cd apps/studio && timeout 300 bun run scripts/agent-resilience-smoke.ts) > /tmp/gate-smoke.$$ 2>&1; then
    note "smoke-resilience PASS"
  else
    bad "smoke-resilience FAIL"
    grep -E '^✗' /tmp/gate-smoke.$$ | sed 's/^/GATE:   /'
  fi
  rm -f /tmp/gate-smoke.$$
fi

# 9. 定点变异（只在 --full）：把修复处换成一个**看似也对、实则不对**的写法，
#    测试必须变红。整体回退验红只能证明「测试咬住了这次改动」，抓不住
#    「测试分不清正确写法和近似写法」。manifest 里没写 mutations 就跳过。
if [ "$MODE" = "--full" ]; then
  MUTN="$(bun -e "const m=require('$MANIFEST');console.log((m.mutations||[]).length)" 2>/dev/null)"
  if [ -n "$MUTN" ] && [ "$MUTN" != "0" ]; then
    for k in $(seq 0 $((MUTN - 1))); do
      MNAME="$(bun -e "console.log(require('$MANIFEST').mutations[$k].name)" 2>/dev/null)"
      MFILE="$(bun -e "console.log(require('$MANIFEST').mutations[$k].file)" 2>/dev/null)"
      cp "$MFILE" "/tmp/gate-mut.$$"
      if ! bun -e "
        const fs=require('fs');const m=require('$MANIFEST').mutations[$k];
        const p='$MFILE';const s=fs.readFileSync(p,'utf8');
        if(!s.includes(m.find)){console.error('find-not-present');process.exit(9);}
        fs.writeFileSync(p,s.replace(m.find,m.replace));
      " 2>/dev/null; then
        bad "mutation[$k] '$MNAME' SKIPPED 待替换文本在源码里找不到（manifest 过期）"
        cp "/tmp/gate-mut.$$" "$MFILE"; rm -f "/tmp/gate-mut.$$"; continue
      fi
      if bun test --parallel $TESTS > /dev/null 2>&1; then
        bad "mutation[$k] '$MNAME' FAIL 换成近似写法后测试仍然全绿 = 用例没有钉住这处语义"
      else
        note "mutation[$k] '$MNAME' PASS (变异后测试变红)"
      fi
      cp "/tmp/gate-mut.$$" "$MFILE"; rm -f "/tmp/gate-mut.$$"
    done
  else
    note "mutation none (manifest 未配置)"
  fi
fi

if [ "$FAIL" = 0 ]; then
  note "RESULT PASS id=$ID"
else
  note "RESULT FAIL id=$ID"
fi
exit "$FAIL"
