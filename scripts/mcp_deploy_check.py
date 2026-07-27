#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MCP 是否需要重新部署 · 每日自动检测
判断逻辑（仅当出现"未被现有路由覆盖的新 SKILL 模块"才判定需要部署）：
  1. 拉最新 skill 库 manifest
  2. 与上次检测基线对比，找出新增 / 变更 / 删除
  3. 对新增的 SKILL.md，检查是否已被路由表（skillPath/relatedSkills）覆盖
     - 已覆盖 → 透传可达，不需部署
     - 未覆盖 → 可能需要补路由，判定"需要部署"
  4. 其余变更（内容改动、新增 demo/callback/资产/日志）一律不需部署

输出：stdout 打印结构化结论。
  - 需要部署 → 打印 "NEED_DEPLOY" 段，cron 据此推企微
  - 不需要   → 打印 "NO_DEPLOY"，cron 静默
基线文件独立维护（不动 .hermes_skill_snapshot.json，那是别的自动task的）。
"""
import urllib.request, json, ssl, os, re, sys
from datetime import datetime

SKILL_SERVER = "https://wdpapi-skill.51aes.com"
ROUTE_MAP    = r"E:\\wdp-mcp-local\\config\\skill-route-mapping.json"
BASELINE     = r"E:\\wdp-mcp-local\\scripts\\.mcp_deploy_check_baseline.json"   # 本检测专用基线（运行时状态，已 gitignore）
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
log = lambda m: print(f"[deploy-check] {m}", flush=True)

def fetch_manifest():
    req = urllib.request.Request(f"{SKILL_SERVER}/manifest")
    data = json.loads(urllib.request.urlopen(req, timeout=25, context=ctx).read())
    files = data["files"] if isinstance(data, dict) and "files" in data else data
    return {f["path"]: (f.get("size"), f.get("sha1") or f.get("sha") or f.get("hash")) for f in files}

def load_route_paths():
    """路由表覆盖情况。返回：
       - exact: 精确列出的 skillPath/relatedSkills 集合
       - prefixes: 路由覆盖的"模块目录前缀"集合（父路由可覆盖其下子场景）"""
    r = json.load(open(ROUTE_MAP, encoding="utf-8-sig"))
    exact = set()
    for x in r.get("routes", []):
        if x.get("skillPath"): exact.add(x["skillPath"])
        for rs in x.get("relatedSkills", []): exact.add(rs)
    for x in r.get("baseSkills", []):     exact.add(x)
    for x in r.get("builtinSkills", []):  exact.add(x)
    # 模块目录前缀：每个被路由的 SKILL.md 所在目录，视为该模块及其子场景的覆盖范围
    prefixes = set()
    for p in exact:
        if p.endswith("/SKILL.md"):
            prefixes.add(p[:-len("SKILL.md")])   # e.g. reference/business-portfolio/
    return exact, prefixes, r.get("version", "?")

# 已知豁免：不视为"需要补路由的新模块"
#  - 根 SKILL.md：库总览，非业务模块
#  - reference/ai/：agentHost 未对外开放，已决定暂不加路由（产研既定结论）
EXEMPT = {"SKILL.md", "reference/ai/SKILL.md"}

def is_covered(skill_path, exact, prefixes):
    """新 SKILL 是否已被路由覆盖：精确命中，或其所在目录被某父路由前缀覆盖。"""
    if skill_path in EXEMPT: return True
    if skill_path in exact:  return True
    # 父目录前缀覆盖：该 SKILL 的目录 == 或位于某个被路由模块目录之下
    d = skill_path[:-len("SKILL.md")] if skill_path.endswith("/SKILL.md") else skill_path
    for pre in prefixes:
        if d == pre or d.startswith(pre):
            return True
    return False

def main():
    log(f"=== 检测开始 {datetime.now():%Y-%m-%d %H:%M} ===")
    try:
        cur = fetch_manifest()
    except Exception as e:
        log(f"✗ 拉取 manifest 失败: {e}")
        print("CHECK_ERROR")  # cron 据此告知"今日未能检测"
        sys.exit(2)

    n_skill = sum(1 for p in cur if p.endswith("SKILL.md"))
    log(f"最新: {len(cur)} 文件 / {n_skill} SKILL")

    route_exact, route_prefixes, route_ver = load_route_paths()

    # 读基线（首次运行则用当前 manifest 建基线、判定无变化）
    first_run = not os.path.exists(BASELINE)
    if first_run:
        log("首次运行，建立基线，本次判定无需部署")
        old = dict(cur)
    else:
        b = json.load(open(BASELINE, encoding="utf-8"))
        old = {k: tuple(v) for k, v in b["files"].items()}

    added   = [p for p in cur if p not in old]
    removed = [p for p in old if p not in cur]
    changed = [p for p in cur if p in old and cur[p] != old[p]]

    # 关键判断：新增的 SKILL.md 里，哪些没被路由覆盖（精确或父目录前缀）
    new_skills = [p for p in added if p.endswith("SKILL.md")]
    uncovered = [p for p in new_skills if not is_covered(p, route_exact, route_prefixes)]

    # 结构性重构信号：skill 库把通用知识拆分/收敛到子文件时，门禁白名单抽取逻辑可能需适配，
    # 否则真实 API 会被误判为幻觉（历史教训：chapters 拆分、_shared 基类/工厂方法收敛）。
    # 这类变化不体现为"新增 SKILL.md"，故单独按文件名模式检测，作为部署/适配提示。
    new_chapters = [p for p in added if "/chapters/" in p and p.endswith(".md")]
    new_shared   = [p for p in added if "/_shared/" in p and p.endswith(".md")]
    struct_signal = bool(new_chapters or new_shared)

    log(f"相对基线: 新增{len(added)} 删除{len(removed)} 变更{len(changed)} | 新SKILL{len(new_skills)} 未覆盖{len(uncovered)} | 新chapters{len(new_chapters)} 新_shared{len(new_shared)}")

    # 更新基线（无论结果，记录当前状态供明日对比）
    json.dump({"checked_at": f"{datetime.now():%Y-%m-%d %H:%M:%S}",
               "total_files": len(cur), "total_skills": n_skill,
               "files": {k: list(v) for k, v in cur.items()}},
              open(BASELINE, "w", encoding="utf-8"), ensure_ascii=False)

    if uncovered or struct_signal:
        # 需要关注：可能需补路由（新模块）或适配白名单抽取（结构性重构）后重新部署
        log("判定: 需要关注（新模块未覆盖 或 出现结构性重构信号）")
        print("NEED_DEPLOY")
        print(f"ROUTE_VERSION::{route_ver}")
        if uncovered:
            print(f"NEW_MODULES::{len(uncovered)}")
            for p in uncovered:
                print(f"  - {p}")
        if struct_signal:
            print(f"STRUCT_REFACTOR::新增chapters分章{len(new_chapters)}个/新增_shared共享文档{len(new_shared)}个")
            for p in (new_chapters + new_shared)[:10]:
                print(f"  ~ {p}")
            print("STRUCT_HINT::知识库结构调整（章节拆分/通用方法收敛）可能导致真实API被门禁误判，需确认白名单抽取是否覆盖新结构，再决定是否部署。")
        # 附带变更概况（仅计数，客观）
        print(f"CONTEXT::新增{len(added)}文件/变更{len(changed)}/删除{len(removed)}")
    else:
        log("判定: 不需要部署（无新模块、无结构性重构；其余为透传消化的内容变更）")
        print("NO_DEPLOY")
        if not first_run and (added or changed):
            print(f"CONTEXT::skill库有变化但均透传消化（新增{len(added)}/变更{len(changed)}/删除{len(removed)}，无未覆盖新模块、无结构性重构）")

    log("=== 完成 ===")

if __name__ == "__main__":
    main()
