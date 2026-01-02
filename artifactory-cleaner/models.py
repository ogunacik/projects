"""
Data models for Artifactory cleanup script.
"""
from dataclasses import dataclass, field
from typing import Optional, List, Dict
from datetime import datetime
from enum import Enum


class ClusterType(Enum):
    """Supported cluster types."""
    KUBERNETES = "kubernetes"
    OPENSHIFT = "openshift"


@dataclass
class ArtifactoryConfig:
    """Artifactory server configuration."""
    url: str
    username: Optional[str] = None
    password: Optional[str] = None
    api_key: Optional[str] = None
    verify_ssl: bool = True
    timeout: int = 30


@dataclass
class ClusterConfig:
    """Configuration for a Kubernetes/OpenShift cluster."""
    name: str
    type: ClusterType
    kubeconfig_path: Optional[str] = None  # Path to kubeconfig file (None for in-cluster or default)
    context: Optional[str] = None  # Kubernetes context to use (None for current)
    enabled: bool = True


@dataclass
class RepositoryConfig:
    """Configuration for a single repository."""
    name: str
    type: str  # maven, docker, npm, nuget, generic
    retention_days: int
    enabled: bool = True
    # Repository-specific options
    keep_minimum_versions: Optional[int] = None  # Keep at least N versions
    exclude_patterns: List[str] = field(default_factory=list)  # Patterns to exclude from cleanup
    include_patterns: List[str] = field(default_factory=list)  # Patterns to include (if empty, include all)

    # Property-based filtering
    include_properties: Dict[str, str] = field(default_factory=dict)  # Must match ALL properties
    exclude_properties: Dict[str, str] = field(default_factory=dict)  # Must NOT match ANY property
    # Maven-specific
    cleanup_snapshots_only: bool = False  # Only clean snapshot versions
    # Docker-specific
    keep_latest_tags: Optional[int] = None  # Keep N latest tags per image
    # Generic-specific
    recursive: bool = True  # Recursively clean subdirectories


@dataclass
class CleanupConfig:
    """Main cleanup configuration."""
    artifactory: ArtifactoryConfig
    repositories: List[RepositoryConfig]
    clusters: List[ClusterConfig] = field(default_factory=list)  # K8s/OpenShift clusters
    protect_running_images: bool = True  # Protect images running in clusters
    dry_run: bool = True
    log_level: str = "INFO"
    parallel_workers: int = 4
    report_file: Optional[str] = None


@dataclass
class ArtifactInfo:
    """Information about an artifact."""
    repo: str
    path: str
    name: str
    size: int
    created: datetime
    modified: datetime
    last_downloaded: Optional[datetime] = None
    download_count: int = 0
    properties: Dict[str, str] = field(default_factory=dict)

    @property
    def full_path(self) -> str:
        """Get full path in repository."""
        return f"{self.repo}/{self.path}"

    @property
    def age_days(self) -> int:
        """Get age in days based on last modified date."""
        return (datetime.now() - self.modified).days


@dataclass
class CleanupResult:
    """Result of cleanup operation."""
    repo: str
    total_artifacts: int = 0
    deleted_artifacts: int = 0
    deleted_size: int = 0
    errors: List[str] = field(default_factory=list)
    skipped: int = 0

    def add_deleted(self, size: int):
        """Record a deleted artifact."""
        self.deleted_artifacts += 1
        self.deleted_size += size

    def add_error(self, error: str):
        """Record an error."""
        self.errors.append(error)
