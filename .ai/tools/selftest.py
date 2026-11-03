#!/usr/bin/env python3
"""Offline regression tests for the protocol validator. No production writes."""
import copy
import json
from pathlib import Path

from validate import read_task, result_checks, task_checks

AI_ROOT = Path(__file__).resolve().parents[1]
task_path = AI_ROOT / "templates" / "task.yaml"
task = read_task(task_path)
result = json.loads((AI_ROOT / "templates" / "result.json").read_text(encoding="utf-8"))


def expect(condition, label):
    if not condition:
        raise AssertionError(label)
    print(f"PASS {label}")


expect(not task_checks(task), "valid YAML task template")
expect(not result_checks(task, result, task_path), "valid PARTIAL JSON receipt template")

wrong = copy.deepcopy(result)
wrong["task_id"] = "WRONG-TASK-001"
expect(any("task_id" in e for e in result_checks(task, wrong, task_path)), "wrong task ID rejected")

fake = copy.deepcopy(result)
fake["acceptance_results"][0]["status"] = "PASS"
expect(bool(result_checks(task, fake, task_path)), "PASS without evidence rejected")

fake["acceptance_results"][0]["evidence_refs"] = [
    {"kind": "test_log", "location": "mock.log", "summary": "only a mock"}
]
expect(any("证据类别" in e for e in result_checks(task, fake, task_path)), "mock cannot replace real readback")

wrong = copy.deepcopy(result)
wrong["spec_sha256"] = "0" * 64
expect(any("SHA256" in e for e in result_checks(task, wrong, task_path)), "stale specification hash rejected")

wrong = copy.deepcopy(result)
wrong["result_state"] = "COMPLETE"
expect(bool(result_checks(task, wrong, task_path)), "unapproved unfinished task cannot be COMPLETE")

wrong = copy.deepcopy(result)
wrong["ready_for_release"] = True
expect(bool(result_checks(task, wrong, task_path)), "unfinished task cannot be release-ready")

wrong = copy.deepcopy(result)
wrong["deployment"]["production_writes_performed"] = True
expect(any("生产写入" in e for e in result_checks(task, wrong, task_path)), "unapproved production write rejected")

wrong_task = copy.deepcopy(task)
wrong_task["requirements"].append({**wrong_task["requirements"][0], "id": "R002"})
expect(any("R002" in e for e in task_checks(wrong_task)), "uncovered must requirement rejected")

print("Validator selftests: ALL PASS")
