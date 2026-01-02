"""
Kubernetes and OpenShift cluster integration for detecting images in use.
"""
import logging
from typing import Set, List, Optional
from kubernetes import client, config
from kubernetes.client.rest import ApiException


logger = logging.getLogger(__name__)


class ClusterClient:
    """Base class for cluster clients."""

    def __init__(self, name: str):
        """
        Initialize cluster client.

        Args:
            name: Cluster name for logging
        """
        self.name = name

    def get_images_in_use(self) -> Set[str]:
        """
        Get set of Docker images currently in use in the cluster.

        Returns:
            Set of image references (e.g., "registry/image:tag")
        """
        raise NotImplementedError


class KubernetesClusterClient(ClusterClient):
    """Client for Kubernetes clusters."""

    def __init__(self, name: str, kubeconfig_path: Optional[str] = None, context: Optional[str] = None):
        """
        Initialize Kubernetes cluster client.

        Args:
            name: Cluster name for logging
            kubeconfig_path: Path to kubeconfig file (None for in-cluster config)
            context: Kubernetes context to use (None for current context)
        """
        super().__init__(name)
        self.kubeconfig_path = kubeconfig_path
        self.context = context
        self._load_config()

    def _load_config(self):
        """Load Kubernetes configuration."""
        try:
            if self.kubeconfig_path:
                config.load_kube_config(config_file=self.kubeconfig_path, context=self.context)
            else:
                # Try in-cluster config first, fall back to default kubeconfig
                try:
                    config.load_incluster_config()
                except config.ConfigException:
                    config.load_kube_config(context=self.context)

            logger.info(f"Successfully connected to Kubernetes cluster: {self.name}")
        except Exception as e:
            logger.error(f"Error loading Kubernetes config for {self.name}: {e}")
            raise

    def get_images_in_use(self) -> Set[str]:
        """
        Get all Docker images currently in use across all namespaces.

        Returns:
            Set of image references
        """
        images = set()

        try:
            v1 = client.CoreV1Api()

            # Get all pods across all namespaces
            pods = v1.list_pod_for_all_namespaces(watch=False)

            for pod in pods.items:
                # Check all containers in the pod
                if pod.spec.containers:
                    for container in pod.spec.containers:
                        if container.image:
                            images.add(self._normalize_image(container.image))

                # Check init containers
                if pod.spec.init_containers:
                    for container in pod.spec.init_containers:
                        if container.image:
                            images.add(self._normalize_image(container.image))

                # Check ephemeral containers
                if pod.spec.ephemeral_containers:
                    for container in pod.spec.ephemeral_containers:
                        if container.image:
                            images.add(self._normalize_image(container.image))

            logger.info(f"Found {len(images)} unique images in use in cluster {self.name}")

        except ApiException as e:
            logger.error(f"Error fetching pods from {self.name}: {e}")
        except Exception as e:
            logger.error(f"Unexpected error getting images from {self.name}: {e}")

        return images

    def _normalize_image(self, image: str) -> str:
        """
        Normalize image reference for comparison.

        Args:
            image: Image reference (e.g., "registry/image:tag" or "image:tag")

        Returns:
            Normalized image reference
        """
        # Remove docker.io prefix if present (default registry)
        if image.startswith('docker.io/'):
            image = image[10:]

        # Add 'latest' tag if no tag specified
        if ':' not in image and '@' not in image:
            image = f"{image}:latest"

        return image


class OpenShiftClusterClient(KubernetesClusterClient):
    """
    Client for OpenShift clusters.

    OpenShift is built on Kubernetes, so we inherit from KubernetesClusterClient
    and can use the same image detection logic.
    """

    def __init__(self, name: str, kubeconfig_path: Optional[str] = None, context: Optional[str] = None):
        """
        Initialize OpenShift cluster client.

        Args:
            name: Cluster name for logging
            kubeconfig_path: Path to kubeconfig file (None for in-cluster config)
            context: OpenShift context to use (None for current context)
        """
        super().__init__(name, kubeconfig_path, context)
        logger.info(f"Initialized OpenShift cluster client: {name}")


class ClusterManager:
    """Manages multiple cluster clients and aggregates images in use."""

    def __init__(self):
        """Initialize cluster manager."""
        self.clusters: List[ClusterClient] = []

    def add_cluster(self, cluster: ClusterClient):
        """
        Add a cluster to monitor.

        Args:
            cluster: Cluster client instance
        """
        self.clusters.append(cluster)
        logger.info(f"Added cluster to manager: {cluster.name}")

    def get_all_images_in_use(self) -> Set[str]:
        """
        Get all images in use across all configured clusters.

        Returns:
            Set of all image references in use
        """
        all_images = set()

        for cluster in self.clusters:
            try:
                images = cluster.get_images_in_use()
                all_images.update(images)
                logger.info(f"Cluster {cluster.name} contributed {len(images)} images")
            except Exception as e:
                logger.error(f"Error getting images from cluster {cluster.name}: {e}")
                # Continue with other clusters even if one fails

        logger.info(f"Total unique images in use across all clusters: {len(all_images)}")
        return all_images

    def is_image_in_use(self, image_ref: str) -> bool:
        """
        Check if a specific image is in use in any cluster.

        Args:
            image_ref: Image reference to check

        Returns:
            True if image is in use, False otherwise
        """
        all_images = self.get_all_images_in_use()

        # Normalize the image reference for comparison
        normalized_ref = self._normalize_for_comparison(image_ref)

        # Check if any cluster image matches
        for cluster_image in all_images:
            if self._images_match(normalized_ref, cluster_image):
                return True

        return False

    def _normalize_for_comparison(self, image_ref: str) -> str:
        """Normalize image reference for comparison."""
        # Remove protocol if present
        if '://' in image_ref:
            image_ref = image_ref.split('://', 1)[1]

        # Remove docker.io prefix
        if image_ref.startswith('docker.io/'):
            image_ref = image_ref[10:]

        return image_ref

    def _images_match(self, ref1: str, ref2: str) -> bool:
        """
        Check if two image references match.

        Args:
            ref1: First image reference
            ref2: Second image reference

        Returns:
            True if images match
        """
        # Simple exact match for now
        # Could be enhanced to handle registry aliases, SHA digests, etc.
        return ref1 == ref2 or ref1 in ref2 or ref2 in ref1
