#!/usr/bin/env python3
"""Validate XSH AI Dev Protocol V1.0 task YAML and JSON result.

Usage:
  python3 .ai/tools/validate.py task .ai/templates/task.yaml
  python3 .ai/tools/validate.py result .ai/templates/task.yaml .ai/templates/result.json

Syntax/schema and task↔result checks cannot prove that a cited log or external
readback is authentic. Human/code review and live integration checks remain mandatory.
"""
import hashlib
import json
import sys
from pathlib import Path

try:
    import yaml
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit("缺少验证器依赖：python3 -m pip install -r .ai/tools/requirements.txt")

AI_ROOT = Path(__file__).resolve().parents[1]


class UniqueKeyLoader(yaml.SafeLoader):
    """Reject duplicate YAML mapping keys rather than silently overwriting requirements."""


def unique_mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        if not isinstance(key, (str, int, float, bool)):
            raise ValueError("YAML 映射包含不可用键")
        if key in result:
            raise ValueError(f"YAML 重复键：{key}")
        result[key] = loader.construct_object(value_node, deep=True)
    return result


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping
)


def schema_validate(data, schema_name):
    schema_path = AI_ROOT / "schemas" / schema_name
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    return [
        f"{'/'.join(map(str, err.absolute_path)) or '<root>'}: {err.message}"
        for err in sorted(validator.iter_errors(data), key=lambda e: str(e.absolute_path))
    ]


def read_task(path):
    task = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    if not isinstance(task, dict):
        raise ValueError("任务 YAML 顶层必须是映射对象")
    return task


def task_checks(task):
    problems = schema_validate(task, "task.schema.json")
    requirements = task.get("requirements") or []
    acceptance = task.get("acceptance") or []
    r_ids = [r.get("id") for r in requirements if isinstance(r, dict)]
    a_ids = [a.get("id") for a in acceptance if isinstance(a, dict)]
    if len(r_ids) != len(set(r_ids)):
        problems.append("需求 ID 重复")
    if len(a_ids) != len(set(a_ids)):
        problems.append("验收 ID 重复")
    known = set(r_ids)
    covered = set()
    for a in acceptance:
        for rid in a.get("requirement_ids", []):
            if rid not in known:
                problems.append(f"验收 {a.get('id')} 引用了不存在的需求 {rid}")
            covered.add(rid)
    for r in requirements:
        if r.get("priority") == "must" and r.get("id") not in covered:
            problems.append(f"必选需求 {r.get('id')} 没有验收覆盖")
    return problems


def result_checks(task, result, task_path):
    problems = task_checks(task) + schema_validate(result, "result.schema.json")
    for field in ("protocol", "task_id", "spec_version"):
        if task.get(field) != result.get(field):
            problems.append(f"任务与回执 {field} 不一致")
    actual_digest = hashlib.sha256(task_path.read_bytes()).hexdigest()
    if result.get("spec_sha256") and result["spec_sha256"] != actual_digest:
        problems.append("回执 spec_sha256 与当前任务文件不一致，可能沿用了旧版本")
    checks = task.get("acceptance") or []
    results = result.get("acceptance_results") or []
    expected_ids = {a.get("id") for a in checks}
    observed_ids = [r.get("acceptance_id") for r in results]
    if set(observed_ids) != expected_ids or len(observed_ids) != len(expected_ids):
        problems.append("回执缺少/重复/包含未知验收 ID，必须与任务逐项一一对应")
    indexed = {item.get("acceptance_id"): item for item in results}
    for check in checks:
        item = indexed.get(check.get("id"))
        if not item:
            continue
        if item.get("status") != "PASS":
            continue
        kinds = {ref.get("kind") for ref in (item.get("evidence_refs") or [])}
        missing = set(check.get("evidence_required") or []) - kinds
        if missing:
            problems.append(f"{check.get('id')} PASS 但缺少必要证据类别：{sorted(missing)}")
    blocking_misses = [
        a.get("id") for a in checks
        if a.get("release_blocking") and indexed.get(a.get("id"), {}).get("status") != "PASS"
    ]
    if result.get("result_state") == "COMPLETE":
        if blocking_misses:
            problems.append(f"COMPLETE 不允许必选验收未PASS：{blocking_misses}")
        if (task.get("state") not in {"APPROVED", "EXECUTING", "VERIFIED"}
                or not task.get("approval", {}).get("user_confirmed")):
            problems.append("未获用户批准的任务不能声明 COMPLETE")
        if result.get("spec_sha256") != actual_digest:
            problems.append("COMPLETE 必须绑定当前 task.yaml 的真实 SHA256")
        if result.get("base_sha") != task.get("project", {}).get("base_sha"):
            problems.append("COMPLETE 的 base_sha 与批准的任务基线不同")
    if result.get("ready_for_release"):
        if blocking_misses:
            problems.append(f"ready_for_release=true 但存在必选未通过项：{blocking_misses}")
        if result.get("blockers"):
            problems.append("ready_for_release=true 时不能仍有阻断项")
    deployment = result.get("deployment") or {}
    auth = task.get("authorization") or {}
    if deployment.get("performed") and deployment.get("environment") == "production" and not auth.get("production_deploy_allowed"):
        problems.append("执行了任务未授权的生产部署")
    if deployment.get("production_writes_performed") and not auth.get("production_write_allowed"):
        problems.append("执行了任务未授权的生产写入")
    return problems


def main():
    if len(sys.argv) < 3:
        raise ValueError("用法：validate.py task <task.yaml> 或 validate.py result <task.yaml> <result.json>")
    mode = sys.argv[1]
    if mode not in {"task", "result"}:
        raise ValueError("模式仅支持 task 或 result")
    if mode == "result" and len(sys.argv) != 4:
        raise ValueError("result 模式需要 task.yaml 和 result.json")
    if mode == "task" and len(sys.argv) != 3:
        raise ValueError("task 模式只需要 task.yaml")
    task_path = Path(sys.argv[2])
    task = read_task(task_path)
    if mode == "task":
        problems = task_checks(task)
    else:
        result = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
        problems = result_checks(task, result, task_path)
    if problems:
        print("协议校验：FAIL")
        for problem in problems:
            print(f" - {problem}")
        return 1
    print("协议结构与跨文件一致性：PASS（不等于真实业务验收通过）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, yaml.YAMLError, json.JSONDecodeError) as error:
        sys.exit(f"协议校验：FAIL — {error}")
