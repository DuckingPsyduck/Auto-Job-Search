"""careerops-kit: a configurable job-search pipeline.

Public surface:
    ``careerkit.config.load_config`` — read and validate ``scan-config.yml`` + ``profile.yml``
    ``careerkit.geo.Geo``           — classify and rank posting locations
"""
from .config import Config, ConfigError, load_config, today  # noqa: F401
from .geo import Geo, workday_url_location  # noqa: F401

__version__ = "0.1.0"
__all__ = ["Config", "ConfigError", "Geo", "load_config", "today", "workday_url_location"]
