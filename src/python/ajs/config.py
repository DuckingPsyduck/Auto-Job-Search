"""Configuration loader (Python twin of src/node/config.mjs).

Reads ``scan-config.yml`` plus the candidate ``profile.yml`` it points at, resolves paths
against the repo root and validates the fields the pipeline cannot run without. Workbook
builders and the scorer import from here rather than reading config files themselves.
"""
from __future__ import annotations

import datetime as _dt
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]

#: Fields without which a run cannot produce meaningful output.
REQUIRED = (
    "version",
    "paths.work_dir",
    "paths.output_dir",
    "http.user_agent",
    "windows.tracked_scan_days",
    "location.ranks",
    "scoring.min_jd_chars",
)

_PLACEHOLDER = re.compile(r"\{\{.+?\}\}")


class ConfigError(RuntimeError):
    """Raised for a missing, unreadable or unfinished configuration."""


def _get(obj: Any, dotted: str) -> Any:
    for key in dotted.split("."):
        if not isinstance(obj, dict) or key not in obj:
            return None
        obj = obj[key]
    return obj


def _read_yaml(path: Path) -> dict:
    try:
        return yaml.safe_load(open(path, encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001 - surfaced with the file name attached
        raise ConfigError(f"cannot read YAML at {path}: {exc}") from exc


@dataclass(frozen=True)
class Config:
    """Loaded configuration. ``raw`` is the parsed YAML; the rest is resolved for convenience."""

    raw: dict
    paths: dict
    profile: dict | None
    config_file: Path
    root: Path
    _outputs: dict = field(default_factory=dict)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, dotted: str, default: Any = None) -> Any:
        value = _get(self.raw, dotted)
        return default if value is None else value

    def output_path(self, kind: str, date: str | None = None) -> Path:
        name = self._outputs.get(kind)
        if not name:
            raise ConfigError(f'no output configured for "{kind}"')
        return Path(self.paths["output_dir"]) / name.replace("{date}", date or today())

    def work_path(self, *parts: str) -> Path:
        return Path(self.paths["work_dir"]).joinpath(*parts)


def today() -> str:
    """Today's date from the system clock, as YYYY-MM-DD in local time."""
    return _dt.date.today().isoformat()


def _assert_profile_filled(profile: dict, path: Path) -> None:
    leftovers: list[str] = []

    def walk(node: Any, trail: str) -> None:
        if isinstance(node, str):
            if _PLACEHOLDER.search(node):
                leftovers.append(f"{trail}: {node}")
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{trail}[{i}]")
        elif isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{trail}.{key}" if trail else key)

    walk(profile, "")
    if leftovers:
        shown = "\n  ".join(leftovers[:8])
        more = f"\n  ...and {len(leftovers) - 8} more" if len(leftovers) > 8 else ""
        raise ConfigError(f"profile still has placeholders ({path}):\n  {shown}{more}")


def load_config(config_path: str | os.PathLike[str] | None = None) -> Config:
    """Load and validate the pipeline configuration.

    Root resolution: ``AJS_ROOT``, then ``paths.root``, then the config file's parent.
    """
    file = Path(
        config_path or os.environ.get("AJS_CONFIG") or REPO_ROOT / "config" / "scan-config.yml"
    ).resolve()
    if not file.exists():
        raise ConfigError(f"config not found: {file}\nCopy config/scan-config.example.yml and edit it.")

    raw = _read_yaml(file)
    # A relative ``paths.root`` (the default, ".") is relative to the config file's own location,
    # not to the current working directory — otherwise a config outside the repo would resolve
    # its profile and CV paths against wherever the command happened to be run.
    configured_root = os.environ.get("AJS_ROOT") or raw.get("paths", {}).get("root") or "."
    root = (
        Path(configured_root).resolve()
        if Path(configured_root).is_absolute()
        else (file.parent.parent / configured_root).resolve()
    )

    for key in REQUIRED:
        if _get(raw, key) is None:
            raise ConfigError(f"config {file} is missing required key: {key}")

    paths = dict(raw.get("paths", {}))
    paths["root"] = root
    path_keys = (
        "work_dir", "output_dir", "profile", "portals", "geo_terms", "ats_vocab", "cv_dir", "tracker",
    )
    for key in path_keys:
        if paths.get(key):
            p = Path(paths[key])
            paths[key] = str(p if p.is_absolute() else (root / p).resolve())

    profile = None
    profile_path = paths.get("profile")
    if profile_path and Path(profile_path).exists():
        profile = _read_yaml(Path(profile_path))
        _assert_profile_filled(profile, Path(profile_path))

    Path(paths["work_dir"]).mkdir(parents=True, exist_ok=True)
    Path(paths["output_dir"]).mkdir(parents=True, exist_ok=True)

    return Config(
        raw=raw,
        paths=paths,
        profile=profile,
        config_file=file,
        root=root,
        _outputs=dict(raw.get("paths", {}).get("outputs", {})),
    )
