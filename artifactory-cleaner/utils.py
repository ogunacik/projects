"""
Utility functions for Artifactory cleanup script.
"""
import logging
import sys
from datetime import datetime
from typing import Optional
from dateutil import parser as date_parser


def setup_logging(level: str = "INFO", log_file: Optional[str] = None):
    """
    Setup logging configuration.

    Args:
        level: Logging level (DEBUG, INFO, WARNING, ERROR)
        log_file: Optional file to write logs to
    """
    log_format = '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    handlers = [logging.StreamHandler(sys.stdout)]

    if log_file:
        handlers.append(logging.FileHandler(log_file))

    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format=log_format,
        handlers=handlers
    )


def parse_date(date_string: str) -> datetime:
    """
    Parse date string to datetime object.

    Args:
        date_string: Date string in various formats

    Returns:
        Parsed datetime object
    """
    return date_parser.parse(date_string)


def format_size(size_bytes: int) -> str:
    """
    Format size in bytes to human-readable string.

    Args:
        size_bytes: Size in bytes

    Returns:
        Formatted size string (e.g., "1.5 GB")
    """
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.2f} PB"


def matches_pattern(path: str, patterns: list) -> bool:
    """
    Check if path matches any of the given patterns.

    Args:
        path: Path to check
        patterns: List of glob patterns

    Returns:
        True if path matches any pattern
    """
    import fnmatch

    if not patterns:
        return False

    for pattern in patterns:
        if fnmatch.fnmatch(path, pattern):
            return True
    return False


def should_process_artifact(path: str, include_patterns: list, exclude_patterns: list) -> bool:
    """
    Determine if artifact should be processed based on include/exclude patterns.

    Args:
        path: Artifact path
        include_patterns: Patterns to include (empty means include all)
        exclude_patterns: Patterns to exclude

    Returns:
        True if artifact should be processed
    """
    # Check exclusions first
    if matches_pattern(path, exclude_patterns):
        return False

    # If no include patterns, include everything (that's not excluded)
    if not include_patterns:
        return True

    # Check if matches any include pattern
    return matches_pattern(path, include_patterns)
