"""
Artifactory REST API client.
"""
import logging
import requests
from typing import List, Dict, Optional
from datetime import datetime
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from models import ArtifactoryConfig, ArtifactInfo
from utils import parse_date


logger = logging.getLogger(__name__)


class ArtifactoryClient:
    """Client for interacting with Artifactory REST API."""

    def __init__(self, config: ArtifactoryConfig):
        """
        Initialize Artifactory client.

        Args:
            config: Artifactory configuration
        """
        self.config = config
        self.base_url = config.url.rstrip('/')
        self.session = self._create_session()

    def _create_session(self) -> requests.Session:
        """Create requests session with retry logic and authentication."""
        session = requests.Session()

        # Setup authentication
        if self.config.api_key:
            session.headers['X-JFrog-Art-Api'] = self.config.api_key
        elif self.config.username and self.config.password:
            session.auth = (self.config.username, self.config.password)
        else:
            raise ValueError("Either api_key or username/password must be provided")

        # Setup retry strategy
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

        return session

    def list_artifacts(self, repo: str, path: str = "", recursive: bool = True) -> List[Dict]:
        """
        List artifacts in a repository.

        Args:
            repo: Repository name
            path: Path within repository (empty for root)
            recursive: Whether to list recursively

        Returns:
            List of artifact information dictionaries
        """
        url = f"{self.base_url}/api/storage/{repo}/{path}"

        try:
            response = self.session.get(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            data = response.json()

            artifacts = []

            # Process files in current directory
            for child in data.get('children', []):
                if child.get('folder', False):
                    if recursive:
                        # Recursively get artifacts from subdirectories
                        child_path = f"{path}/{child['uri'].lstrip('/')}" if path else child['uri'].lstrip('/')
                        artifacts.extend(self.list_artifacts(repo, child_path, recursive))
                else:
                    # It's a file
                    file_path = f"{path}/{child['uri'].lstrip('/')}" if path else child['uri'].lstrip('/')
                    artifacts.append({
                        'repo': repo,
                        'path': file_path,
                        'uri': child['uri']
                    })

            return artifacts

        except requests.exceptions.RequestException as e:
            logger.error(f"Error listing artifacts in {repo}/{path}: {e}")
            return []

    def get_artifact_info(self, repo: str, path: str) -> Optional[ArtifactInfo]:
        """
        Get detailed information about an artifact.

        Args:
            repo: Repository name
            path: Artifact path

        Returns:
            ArtifactInfo object or None if error
        """
        url = f"{self.base_url}/api/storage/{repo}/{path}"

        try:
            response = self.session.get(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            data = response.json()

            # Get statistics for download info
            stats = self._get_artifact_stats(repo, path)

            return ArtifactInfo(
                repo=repo,
                path=path,
                name=data.get('path', '').split('/')[-1],
                size=data.get('size', 0),
                created=parse_date(data.get('created')),
                modified=parse_date(data.get('lastModified')),
                last_downloaded=parse_date(stats.get('lastDownloaded')) if stats.get('lastDownloaded') else None,
                download_count=stats.get('downloadCount', 0),
                download_count=stats.get('downloadCount', 0),
                properties=self._get_artifact_properties(repo, path)
            )

        except requests.exceptions.RequestException as e:
            logger.error(f"Error getting info for {repo}/{path}: {e}")
            return None

    def _get_artifact_stats(self, repo: str, path: str) -> Dict:
        """
        Get artifact statistics (download count, last downloaded, etc.).

        Args:
            repo: Repository name
            path: Artifact path

        Returns:
            Statistics dictionary
        """
        url = f"{self.base_url}/api/storage/{repo}/{path}?stats"

        try:
            response = self.session.get(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException:
            return {}

    def _get_artifact_properties(self, repo: str, path: str) -> Dict[str, str]:
        """
        Get artifact properties.

        Args:
            repo: Repository name
            path: Artifact path

        Returns:
            Dictionary of properties
        """
        url = f"{self.base_url}/api/storage/{repo}/{path}?properties"

        try:
            response = self.session.get(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            # 404 means no properties
            if response.status_code == 404:
                return {}

            response.raise_for_status()
            data = response.json()

            # Convert properties to simple dict (key: value)
            # Artifactory returns properties as lists of strings
            # We take the first value for simplification
            props = {}
            for key, values in data.get('properties', {}).items():
                if values and isinstance(values, list):
                    props[key] = values[0]
                elif values:
                    props[key] = str(values)
            return props

        except requests.exceptions.RequestException:
            return {}

    def delete_artifact(self, repo: str, path: str) -> bool:
        """
        Delete an artifact.

        Args:
            repo: Repository name
            path: Artifact path

        Returns:
            True if successful, False otherwise
        """
        url = f"{self.base_url}/{repo}/{path}"

        try:
            response = self.session.delete(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            logger.info(f"Deleted {repo}/{path}")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Error deleting {repo}/{path}: {e}")
            return False

    def search_aql(self, query: str) -> List[Dict]:
        """
        Execute AQL (Artifactory Query Language) search.

        Args:
            query: AQL query string

        Returns:
            List of results
        """
        url = f"{self.base_url}/api/search/aql"

        try:
            response = self.session.post(
                url,
                data=query,
                headers={'Content-Type': 'text/plain'},
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            return response.json().get('results', [])

        except requests.exceptions.RequestException as e:
            logger.error(f"Error executing AQL query: {e}")
            return []

    def empty_trash_can(self) -> bool:
        """
        Empty the Artifactory trash can.

        This permanently deletes all items in the trash can.

        Returns:
            True if successful, False otherwise
        """
        url = f"{self.base_url}/api/trash/empty"

        try:
            logger.info("Emptying Artifactory trash can...")
            response = self.session.post(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            logger.info("Trash can emptied successfully")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Error emptying trash can: {e}")
            return False

    def run_garbage_collection(self) -> bool:
        """
        Trigger garbage collection on Artifactory.

        This runs the storage garbage collector to reclaim disk space.
        Requires admin privileges.

        Returns:
            True if successful, False otherwise
        """
        url = f"{self.base_url}/api/system/storage/gc"

        try:
            logger.info("Triggering garbage collection...")
            response = self.session.post(
                url,
                verify=self.config.verify_ssl,
                timeout=self.config.timeout
            )
            response.raise_for_status()
            logger.info("Garbage collection triggered successfully")
            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Error triggering garbage collection: {e}")
            return False
