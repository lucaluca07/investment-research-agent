import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[3]
RESET_SCRIPT = ROOT_DIR / "scripts" / "reset-dev-db.sh"


def test_python_test_runtime() -> None:
    assert True


def test_package_exposes_explicit_development_database_reset() -> None:
    package = json.loads((ROOT_DIR / "package.json").read_text())

    assert package["scripts"]["db:reset:dev"] == "bash scripts/reset-dev-db.sh"


def test_reset_script_refuses_database_outside_project_runtime_directory(tmp_path) -> None:
    database_path = tmp_path / "research.duckdb"
    database_path.touch()
    environment = os.environ | {"IRA_RESEARCH_DB_PATH": str(database_path)}

    result = subprocess.run(
        ["bash", str(RESET_SCRIPT)],
        cwd=ROOT_DIR,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert database_path.exists()


def test_reset_script_rejects_an_empty_configured_path() -> None:
    result = subprocess.run(
        ["bash", str(RESET_SCRIPT)],
        cwd=ROOT_DIR,
        env=os.environ | {"IRA_RESEARCH_DB_PATH": "   "},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "must not be empty" in result.stderr


@pytest.mark.parametrize(
    ("path_name", "expected_error"),
    [("directory", "Refusing to reset a directory"), ("other.duckdb", "other than research.duckdb")],
)
def test_reset_script_rejects_unsafe_database_targets(tmp_path, path_name, expected_error) -> None:
    target = tmp_path / path_name
    if path_name == "directory":
        target.mkdir()
    else:
        target.touch()

    result = subprocess.run(
        ["bash", str(RESET_SCRIPT)],
        cwd=ROOT_DIR,
        env=os.environ | {"IRA_RESEARCH_DB_PATH": str(target)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert target.exists()
    assert expected_error in result.stderr


def test_reset_script_only_removes_the_configured_development_database(tmp_path) -> None:
    fake_root = tmp_path / "repository"
    fake_script = fake_root / "scripts" / "reset-dev-db.sh"
    runtime_dir = fake_root / ".ira-runtime"
    resolved_runtime_dir = tmp_path / "resolved-runtime"
    database_path = resolved_runtime_dir / "research.duckdb"
    retained_path = resolved_runtime_dir / "retained.txt"
    fake_script.parent.mkdir(parents=True)
    resolved_runtime_dir.mkdir()
    runtime_dir.symlink_to(resolved_runtime_dir, target_is_directory=True)
    fake_script.write_text(RESET_SCRIPT.read_text())
    fake_script.chmod(0o755)
    database_path.write_text("development database")
    retained_path.write_text("do not remove")

    result = subprocess.run(
        ["bash", str(fake_script)],
        cwd=fake_root,
        env=os.environ | {"IRA_RESEARCH_DB_PATH": str(database_path)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert not database_path.exists()
    assert retained_path.read_text() == "do not remove"
