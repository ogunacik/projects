"""
Repository-specific cleanup strategies.
"""
import logging
import re
from abc import ABC, abstractmethod
from typing import List, Dict
from datetime import datetime, timedelta
from collections import defaultdict

from models import RepositoryConfig, ArtifactInfo, CleanupResult
from artifactory_client import ArtifactoryClient
from utils import should_process_artifact


logger = logging.getLogger(__name__)


class CleanupStrategy(ABC):
    """Base class for repository cleanup strategies."""

    def __init__(self, client: ArtifactoryClient, config: RepositoryConfig, cluster_manager=None):
        """
        Initialize cleanup strategy.

        Args:
            client: Artifactory client
            config: Repository configuration
            cluster_manager: Optional ClusterManager for protecting running images
        """
        self.client = client
        self.config = config
        self.cluster_manager = cluster_manager
        self.cutoff_date = datetime.now() - timedelta(days=config.retention_days)

    @abstractmethod
    def get_artifacts_to_delete(self) -> List[ArtifactInfo]:
        """
        Get list of artifacts to delete based on strategy.

        Returns:
            List of artifacts to delete
        """
        pass

    def cleanup(self, dry_run: bool = True) -> CleanupResult:
        """
        Execute cleanup for this repository.

        Args:
            dry_run: If True, don't actually delete artifacts

        Returns:
            CleanupResult with statistics
        """
        result = CleanupResult(repo=self.config.name)

        logger.info(f"Starting cleanup for repository: {self.config.name} (type: {self.config.type})")
        logger.info(f"Retention policy: {self.config.retention_days} days (cutoff: {self.cutoff_date})")

        try:
            artifacts_to_delete = self.get_artifacts_to_delete()
            result.total_artifacts = len(artifacts_to_delete)

            logger.info(f"Found {len(artifacts_to_delete)} artifacts to delete")

            for artifact in artifacts_to_delete:
                if dry_run:
                    logger.info(f"[DRY RUN] Would delete: {artifact.full_path} (size: {artifact.size}, age: {artifact.age_days} days)")
                    result.add_deleted(artifact.size)
                else:
                    if self.client.delete_artifact(artifact.repo, artifact.path):
                        result.add_deleted(artifact.size)
                    else:
                        result.add_error(f"Failed to delete {artifact.full_path}")

        except Exception as e:
            logger.error(f"Error during cleanup of {self.config.name}: {e}")
            result.add_error(str(e))

        return result

    def _should_process(self, path: str) -> bool:
        """Check if artifact should be processed based on include/exclude patterns."""
        return should_process_artifact(path, self.config.include_patterns, self.config.exclude_patterns)

    def _should_keep_by_properties(self, artifact: ArtifactInfo) -> bool:
        """
        Check if artifact should be KEPT based on property filters.

        Returns:
            True if artifact should be kept (NOT deleted)
            False if artifact is safe to delete (matches include/exclude logic)
        """
        # Check exclude properties (if match ANY, keep)
        if self.config.exclude_properties:
            for key, value in self.config.exclude_properties.items():
                if artifact.properties.get(key) == str(value):
                    logger.debug(f"Keeping {artifact.path} due to exclude property {key}={value}")
                    return True

        # Check include properties (if defined, must match ALL, otherwise keep)
        # "include" means "only clean these". So if mismatch, keep.
        if self.config.include_properties:
            for key, value in self.config.include_properties.items():
                if artifact.properties.get(key) != str(value):
                    logger.debug(f"Keeping {artifact.path} due to mismatch include property {key}={value}")
                    return True

        return False


class GenericStrategy(CleanupStrategy):
    """Cleanup strategy for generic repositories."""

    def get_artifacts_to_delete(self) -> List[ArtifactInfo]:
        """Get artifacts older than retention period."""
        artifacts_to_delete = []

        # List all artifacts in repository
        artifact_list = self.client.list_artifacts(
            self.config.name,
            recursive=self.config.recursive
        )

        for artifact_ref in artifact_list:
            if not self._should_process(artifact_ref['path']):
                continue

            artifact = self.client.get_artifact_info(artifact_ref['repo'], artifact_ref['path'])
            if artifact and artifact.modified < self.cutoff_date:
                # Check properties
                if self._should_keep_by_properties(artifact):
                    continue

                artifacts_to_delete.append(artifact)

        return artifacts_to_delete


class MavenStrategy(CleanupStrategy):
    """Cleanup strategy for Maven repositories."""

    SNAPSHOT_PATTERN = re.compile(r'-SNAPSHOT$')

    def get_artifacts_to_delete(self) -> List[ArtifactInfo]:
        """Get Maven artifacts to delete, respecting version retention."""
        artifacts_to_delete = []

        # Use AQL to find Maven artifacts
        aql_query = f"""
        items.find({{
            "repo": "{self.config.name}",
            "type": "file"
        }})
        .include("name", "repo", "path", "modified", "size", "created")
        """

        results = self.client.search_aql(aql_query)

        # Group artifacts by GAV (GroupId:ArtifactId)
        gav_groups = defaultdict(list)

        for item in results:
            path = item.get('path', '')

            if not self._should_process(path):
                continue

            # Get full artifact info
            artifact = self.client.get_artifact_info(item['repo'], f"{path}/{item['name']}")
            if not artifact:
                continue

            # Extract GAV coordinates from path
            gav_key = self._extract_gav_key(path)
            gav_groups[gav_key].append(artifact)

        # Process each GAV group
        for gav_key, artifacts in gav_groups.items():
            artifacts_to_delete.extend(self._process_gav_group(artifacts))

        return artifacts_to_delete

    def _extract_gav_key(self, path: str) -> str:
        """Extract GroupId:ArtifactId from Maven path."""
        # Maven path structure: groupId/artifactId/version/...
        parts = path.split('/')
        if len(parts) >= 2:
            return '/'.join(parts[:-1])  # Everything except version
        return path

    def _process_gav_group(self, artifacts: List[ArtifactInfo]) -> List[ArtifactInfo]:
        """Process a group of artifacts with same GAV coordinates."""
        to_delete = []

        # Separate snapshots and releases
        snapshots = [a for a in artifacts if self.SNAPSHOT_PATTERN.search(a.path)]
        releases = [a for a in artifacts if not self.SNAPSHOT_PATTERN.search(a.path)]

        # If configured to only clean snapshots, skip releases
        if self.config.cleanup_snapshots_only:
            artifacts_to_check = snapshots
        else:
            artifacts_to_check = artifacts

        # Sort by modified date (newest first)
        artifacts_to_check.sort(key=lambda x: x.modified, reverse=True)

        # Keep minimum versions if configured
        if self.config.keep_minimum_versions:
            artifacts_to_check = artifacts_to_check[self.config.keep_minimum_versions:]

        # Delete old artifacts
        for artifact in artifacts_to_check:
            if artifact.modified < self.cutoff_date:
                # Check properties
                if self._should_keep_by_properties(artifact):
                    continue

                to_delete.append(artifact)

        return to_delete


class DockerStrategy(CleanupStrategy):
    """Cleanup strategy for Docker repositories with cluster integration."""

    def get_artifacts_to_delete(self) -> List[ArtifactInfo]:
        """Get Docker images/layers to delete, respecting tag retention and cluster usage."""
        artifacts_to_delete = []

        # Get images in use from clusters if cluster manager is available
        images_in_use = set()
        if self.cluster_manager:
            try:
                images_in_use = self.cluster_manager.get_all_images_in_use()
                logger.info(f"Protecting {len(images_in_use)} images currently running in clusters")
            except Exception as e:
                logger.error(f"Error getting images from clusters: {e}")
                # Continue without cluster protection if there's an error
        """Get Docker images/layers to delete, respecting tag retention."""
        artifacts_to_delete = []

        # Use AQL to find Docker manifests
        aql_query = f"""
        items.find({{
            "repo": "{self.config.name}",
            "type": "file",
            "name": "manifest.json"
        }})
        .include("name", "repo", "path", "modified", "size", "created")
        """

        results = self.client.search_aql(aql_query)

        # Group by image name
        image_groups = defaultdict(list)

        for item in results:
            path = item.get('path', '')

            if not self._should_process(path):
                continue

            artifact = self.client.get_artifact_info(item['repo'], f"{path}/{item['name']}")
            if not artifact:
                continue

            # Extract image name from path (format: image-name/tag/)
            image_name = self._extract_image_name(path)
            image_groups[image_name].append(artifact)

        # Process each image group
        for image_name, manifests in image_groups.items():
            artifacts_to_delete.extend(self._process_image_group(manifests, image_name, images_in_use))

        return artifacts_to_delete

    def _extract_image_name(self, path: str) -> str:
        """Extract image name from Docker path."""
        # Docker path structure: image-name/tag/...
        parts = path.split('/')
        if len(parts) >= 1:
            return parts[0]
        return path

    def _process_image_group(self, manifests: List[ArtifactInfo], image_name: str, images_in_use: Set[str]) -> List[ArtifactInfo]:
        """Process a group of manifests for the same image."""
        to_delete = []

        # Sort by modified date (newest first)
        manifests.sort(key=lambda x: x.modified, reverse=True)

        # Keep latest N tags if configured
        if self.config.keep_latest_tags:
            manifests = manifests[self.config.keep_latest_tags:]

        # Delete old manifests
        for manifest in manifests:
            if manifest.modified < self.cutoff_date:
                # Check properties
                if self._should_keep_by_properties(manifest):
                    continue

                # Check if image is in use in any cluster
                if self._is_image_in_use(manifest, image_name, images_in_use):
                    logger.info(f"Skipping {manifest.full_path} - image is running in a cluster")
                    continue

                to_delete.append(manifest)

        return to_delete

    def _is_image_in_use(self, manifest: ArtifactInfo, image_name: str, images_in_use: Set[str]) -> bool:
        """
        Check if a Docker image is currently in use in any cluster.

        Args:
            manifest: Manifest artifact info
            image_name: Image name extracted from path
            images_in_use: Set of images currently running in clusters

        Returns:
            True if image is in use
        """
        if not images_in_use:
            return False

        # Extract tag from manifest path (format: image-name/tag/...)
        path_parts = manifest.path.split('/')
        if len(path_parts) >= 2:
            tag = path_parts[1]

            # Construct possible image references
            # Format: registry/repo/image:tag
            possible_refs = [
                f"{image_name}:{tag}",
                f"{manifest.repo}/{image_name}:{tag}",
                f"{self.client.base_url.split('//')[-1]}/{manifest.repo}/{image_name}:{tag}"
            ]

            # Check if any possible reference matches cluster images
            for ref in possible_refs:
                for cluster_image in images_in_use:
                    if ref in cluster_image or cluster_image in ref:
                        return True

        return False


class NpmStrategy(CleanupStrategy):
    """Cleanup strategy for NPM repositories."""

    def get_artifacts_to_delete(self) -> List[ArtifactInfo]:
        """Get NPM packages to delete, respecting version retention."""
        artifacts_to_delete = []

        # Use AQL to find package.json files or tarballs
        aql_query = f"""
        items.find({{
            "repo": "{self.config.name}",
            "type": "file",
            "$or": [
                {{"name": {{"$match": "*.tgz"}}}},
                {{"name": "package.json"}}
            ]
        }})
        .include("name", "repo", "path", "modified", "size", "created")
        """

        results = self.client.search_aql(aql_query)

        # Group by package name
        package_groups = defaultdict(list)

        for item in results:
            path = item.get('path', '')

            if not self._should_process(path):
                continue

            artifact = self.client.get_artifact_info(item['repo'], f"{path}/{item['name']}")
            if not artifact:
                continue

            # Extract package name from path
            package_name = self._extract_package_name(path)
            package_groups[package_name].append(artifact)

        # Process each package group
        for package_name, artifacts in package_groups.items():
            artifacts_to_delete.extend(self._process_package_group(artifacts))

        return artifacts_to_delete

    def _extract_package_name(self, path: str) -> str:
        """Extract package name from NPM path."""
        # NPM path structure: @scope/package-name or package-name
        parts = path.split('/')
        if parts and parts[0].startswith('@'):
            return '/'.join(parts[:2]) if len(parts) >= 2 else parts[0]
        return parts[0] if parts else path

    def _process_package_group(self, artifacts: List[ArtifactInfo]) -> List[ArtifactInfo]:
        """Process a group of artifacts for the same package."""
        to_delete = []

        # Sort by modified date (newest first)
        artifacts.sort(key=lambda x: x.modified, reverse=True)

        # Keep minimum versions if configured
        if self.config.keep_minimum_versions:
            artifacts = artifacts[self.config.keep_minimum_versions:]

        # Delete old artifacts
        for artifact in artifacts:
            if artifact.modified < self.cutoff_date:
                # Check properties
                if self._should_keep_by_properties(artifact):
                    continue

                to_delete.append(artifact)

        return to_delete


class NuGetStrategy(CleanupStrategy):
    """Cleanup strategy for NuGet repositories."""

    def get_artifacts_to_delete(self) -> List[ArtifactInfo]:
        """Get NuGet packages to delete, respecting version retention."""
        artifacts_to_delete = []

        # Use AQL to find .nupkg files
        aql_query = f"""
        items.find({{
            "repo": "{self.config.name}",
            "type": "file",
            "name": {{"$match": "*.nupkg"}}
        }})
        .include("name", "repo", "path", "modified", "size", "created")
        """

        results = self.client.search_aql(aql_query)

        # Group by package ID
        package_groups = defaultdict(list)

        for item in results:
            path = item.get('path', '')

            if not self._should_process(path):
                continue

            artifact = self.client.get_artifact_info(item['repo'], f"{path}/{item['name']}")
            if not artifact:
                continue

            # Extract package ID from filename (format: PackageId.Version.nupkg)
            package_id = self._extract_package_id(item['name'])
            package_groups[package_id].append(artifact)

        # Process each package group
        for package_id, artifacts in package_groups.items():
            artifacts_to_delete.extend(self._process_package_group(artifacts))

        return artifacts_to_delete

    def _extract_package_id(self, filename: str) -> str:
        """Extract package ID from NuGet filename."""
        # Format: PackageId.Version.nupkg
        # Remove .nupkg extension and version
        name_without_ext = filename.replace('.nupkg', '')
        parts = name_without_ext.split('.')

        # Try to find where version starts (usually numeric)
        for i, part in enumerate(parts):
            if part and part[0].isdigit():
                return '.'.join(parts[:i])

        return name_without_ext

    def _process_package_group(self, artifacts: List[ArtifactInfo]) -> List[ArtifactInfo]:
        """Process a group of artifacts for the same package."""
        to_delete = []

        # Sort by modified date (newest first)
        artifacts.sort(key=lambda x: x.modified, reverse=True)

        # Keep minimum versions if configured
        if self.config.keep_minimum_versions:
            artifacts = artifacts[self.config.keep_minimum_versions:]

        # Delete old artifacts
        for artifact in artifacts:
            if artifact.modified < self.cutoff_date:
                # Check properties
                if self._should_keep_by_properties(artifact):
                    continue

                to_delete.append(artifact)

        return to_delete


def get_strategy(client: ArtifactoryClient, config: RepositoryConfig, cluster_manager=None) -> CleanupStrategy:
    """
    Get appropriate cleanup strategy for repository type.

    Args:
        client: Artifactory client
        config: Repository configuration
        cluster_manager: Optional ClusterManager for protecting running images

    Returns:
        Cleanup strategy instance
    """
    strategies = {
        'maven': MavenStrategy,
        'docker': DockerStrategy,
        'npm': NpmStrategy,
        'nuget': NuGetStrategy,
        'generic': GenericStrategy,
    }

    strategy_class = strategies.get(config.type.lower(), GenericStrategy)
    return strategy_class(client, config, cluster_manager)
