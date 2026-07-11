"""zotkit — headless Zotero library management (Web API + WebDAV)."""
from .core import Conventions, TagConventionError, Zot, lint_tags, load_conventions

__all__ = ["Zot", "lint_tags", "load_conventions", "Conventions", "TagConventionError"]
__version__ = "0.1.0"
