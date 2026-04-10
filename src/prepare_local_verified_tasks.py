import argparse
import json
from pathlib import Path
from typing import Any

from datasets import load_dataset


CURATED_TASKS = {
    "local3": {
        "sqlfluff__sqlfluff-1625": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/cli/commands_test.py::test__cli__command_directed",
            ],
            "use_test_patch": True,
        },
        "marshmallow-code__marshmallow-1359": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\marshmallow-code__marshmallow",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -c \"import datetime as dt; from marshmallow import Schema, fields; ns={}; exec('class S(Schema):\\n    times = fields.List(fields.DateTime())\\n    pair = fields.Tuple((fields.DateTime(),))\\n    class Meta:\\n        datetimeformat = \\\"iso8601\\\"', globals(), ns); S = ns['S']; s = S(); assert s.fields['times'].inner.format == 'iso8601'; assert s.fields['pair'].tuple_fields[0].format == 'iso8601'; out = s.dump({'times': [dt.datetime(2020, 5, 4, 3, 2, 1)], 'pair': (dt.datetime(2020, 5, 4, 3, 2, 1),)}); assert out['times'] == ['2020-05-04T03:02:01']; assert out['pair'][0] == '2020-05-04T03:02:01'\"",
            ],
        },
        "pydicom__pydicom-1694": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -c \"from pydicom import Dataset; from pydicom.dataelem import RawDataElement; from pydicom.tag import Tag; ds = Dataset(); ds[0x00082128] = RawDataElement(Tag(0x00082128), 'IS', 4, b'5.25', 0, True, True); assert ds.to_json_dict(suppress_invalid_tags=True) == {}\"",
            ],
        },
    },
    "local6": {
        "sqlfluff__sqlfluff-1625": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -c \"from sqlfluff.core import Linter; sql='SELECT a.[hello]\\nFROM\\n    mytable AS a'; violations=Linter(dialect='tsql', rules='L031').lint_string(sql).check_tuples(); assert violations == []\"",
            ],
        },
        "sqlfluff__sqlfluff-2419": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/rules/std_L060_test.py::test__rules__std_L060_raised",
            ],
            "use_test_patch": True,
        },
        "marshmallow-code__marshmallow-1359": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\marshmallow-code__marshmallow",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -c \"import datetime as dt; from marshmallow import Schema, fields; ns={}; exec('class S(Schema):\\n    times = fields.List(fields.DateTime())\\n    pair = fields.Tuple((fields.DateTime(),))\\n    class Meta:\\n        datetimeformat = \\\"iso8601\\\"', globals(), ns); S = ns['S']; s = S(); assert s.fields['times'].inner.format == 'iso8601'; assert s.fields['pair'].tuple_fields[0].format == 'iso8601'; out = s.dump({'times': [dt.datetime(2020, 5, 4, 3, 2, 1)], 'pair': (dt.datetime(2020, 5, 4, 3, 2, 1),)}); assert out['times'] == ['2020-05-04T03:02:01']; assert out['pair'][0] == '2020-05-04T03:02:01'\"",
            ],
        },
        "marshmallow-code__marshmallow-1343": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\marshmallow-code__marshmallow",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -m pip install -q simplejson pytest",
                "python -c \"import collections, collections.abc, sys, pytest; collections.Mapping = collections.abc.Mapping; collections.MutableMapping = collections.abc.MutableMapping; collections.Sequence = collections.abc.Sequence; sys.exit(pytest.main(['-q','tests/test_marshalling.py::TestUnmarshaller::test_deserialize_wrong_nested_type_with_validates_method']))\"",
            ],
            "use_test_patch": True,
        },
        "pydicom__pydicom-1694": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -c \"from pydicom import Dataset; from pydicom.dataelem import RawDataElement; from pydicom.tag import Tag; ds = Dataset(); ds[0x00082128] = RawDataElement(Tag(0x00082128), 'IS', 4, b'5.25', 0, True, True); assert ds.to_json_dict(suppress_invalid_tags=True) == {}\"",
            ],
        },
        "pydicom__pydicom-1256": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -m pytest -q pydicom/tests/test_json.py::TestBinary::test_bulk_data_reader_is_called_within_SQ",
            ],
            "use_test_patch": True,
        },
    }
    ,
    "local10": {
        "sqlfluff__sqlfluff-1625": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/cli/commands_test.py::test__cli__command_directed",
            ],
            "use_test_patch": True,
        },
        "sqlfluff__sqlfluff-2419": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/rules/std_L060_test.py::test__rules__std_L060_raised",
            ],
            "use_test_patch": True,
        },
        "sqlfluff__sqlfluff-1733": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/rules/std_L003_L036_L039_combo_test.py::test__rules__std_L003_L036_L039",
            ],
            "use_test_patch": True,
        },
        "sqlfluff__sqlfluff-1517": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/dialects/ansi_test.py -k multiple_semicolons",
            ],
            "use_test_patch": True,
        },
        "sqlfluff__sqlfluff-1763": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\sqlfluff__sqlfluff",
            "verifyCommands": [
                "python -m pip install -q -r requirements.txt",
                "python -m pip install -q -e .",
                "python -m pytest -q test/core/linter_test.py::test_safe_create_replace_file[utf8_create] test/core/linter_test.py::test_safe_create_replace_file[utf8_update] test/core/linter_test.py::test_safe_create_replace_file[utf8_special_char]",
            ],
            "use_test_patch": True,
        },
        "marshmallow-code__marshmallow-1359": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\marshmallow-code__marshmallow",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -c \"import datetime as dt; from marshmallow import Schema, fields; ns={}; exec('class S(Schema):\\n    times = fields.List(fields.DateTime())\\n    pair = fields.Tuple((fields.DateTime(),))\\n    class Meta:\\n        datetimeformat = \\\"iso8601\\\"', globals(), ns); S = ns['S']; s = S(); assert s.fields['times'].inner.format == 'iso8601'; assert s.fields['pair'].tuple_fields[0].format == 'iso8601'; out = s.dump({'times': [dt.datetime(2020, 5, 4, 3, 2, 1)], 'pair': (dt.datetime(2020, 5, 4, 3, 2, 1),)}); assert out['times'] == ['2020-05-04T03:02:01']; assert out['pair'][0] == '2020-05-04T03:02:01'\"",
            ],
            "use_test_patch": True,
        },
        "marshmallow-code__marshmallow-1343": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\marshmallow-code__marshmallow",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -m pip install -q simplejson pytest",
                "python -c \"import collections, collections.abc, sys, pytest; collections.Mapping = collections.abc.Mapping; collections.MutableMapping = collections.abc.MutableMapping; collections.Sequence = collections.abc.Sequence; sys.exit(pytest.main(['-q','tests/test_marshalling.py::TestUnmarshaller::test_deserialize_wrong_nested_type_with_validates_method']))\"",
            ],
            "use_test_patch": True,
        },
        "pydicom__pydicom-1694": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -c \"from pydicom import Dataset; from pydicom.dataelem import RawDataElement; from pydicom.tag import Tag; ds = Dataset(); ds[0x00082128] = RawDataElement(Tag(0x00082128), 'IS', 4, b'5.25', 0, True, True); assert ds.to_json_dict(suppress_invalid_tags=True) == {}\"",
            ],
            "use_test_patch": True,
        },
        "pydicom__pydicom-1256": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -m pytest -q pydicom/tests/test_json.py::TestBinary::test_bulk_data_reader_is_called_within_SQ",
            ],
            "use_test_patch": True,
        },
        "pydicom__pydicom-1139": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "verifyCommands": [
                "python -m pip install -q -e .",
                "python -m pytest -q pydicom/tests/test_valuerep.py::TestPersonName::test_next pydicom/tests/test_valuerep.py::TestPersonName::test_iterator pydicom/tests/test_valuerep.py::TestPersonName::test_contains",
            ],
            "use_test_patch": True,
        },
    },
    "long3": {
        "marshmallow-code__marshmallow-1359": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\marshmallow-code__marshmallow",
            "installCommands": [
                "python -m pip install -q -e .",
                "python -m pip install -q pytest",
            ],
            "verifyFromDatasetFailToPass": True,
            "use_test_patch": True,
        },
        "pydicom__pydicom-1413": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pydicom__pydicom",
            "installCommands": [
                "python -m pip install -q -e .",
                "python -m pip install -q pytest",
            ],
            "verifyFromDatasetFailToPass": True,
            "use_test_patch": True,
        },
        "pylint-dev__astroid-1978": {
            "workspacePath": "workspaces\\swebench-lite-dev4\\pylint-dev__astroid",
            "installCommands": [
                "python -m pip install -q -r requirements_test_min.txt",
                "python -m pip install -q .",
            ],
            "verifyFromDatasetFailToPass": True,
            "use_test_patch": True,
        },
    },
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="local6", choices=sorted(CURATED_TASKS.keys()))
    parser.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="dev")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    rows = load_dataset(args.dataset, split=args.split)
    by_id = {row["instance_id"]: row for row in rows}
    curated = CURATED_TASKS[args.profile]

    output_rows = []
    for instance_id, config in curated.items():
        row = by_id.get(instance_id)
        if not row:
            raise SystemExit(f"Missing dataset row for {instance_id}")

        output_row = {
            "instanceId": row["instance_id"],
            "repo": row["repo"],
            "problemStatement": row["problem_statement"],
            "baseCommit": row["base_commit"],
            "hints": [row["hints_text"]] if row.get("hints_text") else [],
            "workspacePath": config["workspacePath"],
            "verifyCommands": build_verify_commands(config, row),
            "metadata": {
                "dataset": args.dataset,
                "split": args.split,
                "environment_setup_commit": row.get("environment_setup_commit"),
                "version": row.get("version"),
            },
        }
        if config.get("use_test_patch"):
            output_row["testPatch"] = row["test_patch"]
        output_rows.append(output_row)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in output_rows:
            handle.write(json.dumps(row) + "\n")

    print(f"Wrote {len(output_rows)} curated tasks to {output_path}")


def build_verify_commands(config: dict[str, Any], row: dict[str, Any]) -> list[str]:
    if "verifyCommands" in config:
        return config["verifyCommands"]

    commands = list(config.get("installCommands") or [])
    if config.get("verifyFromDatasetFailToPass"):
        tests = parse_json_list(row.get("FAIL_TO_PASS"))
        if not tests:
            raise SystemExit(f"Missing FAIL_TO_PASS tests for {row['instance_id']}")
        commands.append("python -m pytest -q " + " ".join(tests))
        return commands

    raise SystemExit(f"No verify command strategy configured for {row['instance_id']}")


def parse_json_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    parsed = json.loads(value)
    return [str(item) for item in parsed]


if __name__ == "__main__":
    main()
