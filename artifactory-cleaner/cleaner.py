#!/usr/bin/env python3
"""
Artifactory Cleanup Script

A flexible and maintainable script for cleaning up old artifacts from Artifactory
repositories based on configurable retention policies.

Supports: Maven, Docker, NPM, NuGet, and Generic repositories.
"""
import argparse
import logging
import sys
import yaml
from typing import List
from concurrent.futures import ThreadPoolExecutor, as_completed

from models import (
    ArtifactoryConfig,
    RepositoryConfig,
    CleanupConfig,
    CleanupResult,
    ClusterConfig,
    ClusterType
)
from artifactory_client import ArtifactoryClient
from cleanup_strategies import get_strategy
from utils import setup_logging, format_size


logger = logging.getLogger(__name__)


def load_config(config_file: str) -> CleanupConfig:
    """
    Load configuration from YAML file.

    Args:
        config_file: Path to configuration file

    Returns:
        CleanupConfig object
    """
    try:
        with open(config_file, 'r') as f:
            config_data = yaml.safe_load(f)

        # Parse Artifactory configuration
        artifactory_config = ArtifactoryConfig(
            url=config_data['artifactory']['url'],
            username=config_data['artifactory'].get('username'),
            password=config_data['artifactory'].get('password'),
            api_key=config_data['artifactory'].get('api_key'),
            verify_ssl=config_data['artifactory'].get('verify_ssl', True),
            timeout=config_data['artifactory'].get('timeout', 30)
        )

        # Parse repository configurations
        repositories = []
        for repo_data in config_data.get('repositories', []):
            repo_config = RepositoryConfig(
                name=repo_data['name'],
                type=repo_data['type'],
                retention_days=repo_data['retention_days'],
                enabled=repo_data.get('enabled', True),
                keep_minimum_versions=repo_data.get('keep_minimum_versions'),
                exclude_patterns=repo_data.get('exclude_patterns', []),
                include_patterns=repo_data.get('include_patterns', []),
                cleanup_snapshots_only=repo_data.get('cleanup_snapshots_only', False),
                keep_latest_tags=repo_data.get('keep_latest_tags'),
                cleanup_snapshots_only=repo_data.get('cleanup_snapshots_only', False),
                keep_latest_tags=repo_data.get('keep_latest_tags'),
                recursive=repo_data.get('recursive', True),
                include_properties=repo_data.get('include_properties', {}),
                exclude_properties=repo_data.get('exclude_properties', {})
            )
            repositories.append(repo_config)

        # Parse cluster configurations
        clusters = []
        for cluster_data in config_data.get('clusters', []):
            cluster_config = ClusterConfig(
                name=cluster_data['name'],
                type=ClusterType(cluster_data['type']),
                kubeconfig_path=cluster_data.get('kubeconfig_path'),
                context=cluster_data.get('context'),
                enabled=cluster_data.get('enabled', True)
            )
            clusters.append(cluster_config)

        # Create main config
        cleanup_config = CleanupConfig(
            artifactory=artifactory_config,
            repositories=repositories,
            clusters=clusters,
            protect_running_images=config_data.get('protect_running_images', True),
            dry_run=config_data.get('dry_run', True),
            log_level=config_data.get('log_level', 'INFO'),
            parallel_workers=config_data.get('parallel_workers', 4),
            report_file=config_data.get('report_file')
        )

        return cleanup_config

    except Exception as e:
        logger.error(f"Error loading configuration: {e}")
        sys.exit(1)


def cleanup_repository(
    client: ArtifactoryClient,
    repo_config: RepositoryConfig,
    dry_run: bool,
    cluster_manager=None
) -> CleanupResult:
    """
    Clean up a single repository.

    Args:
        client: Artifactory client
        repo_config: Repository configuration
        dry_run: Whether to run in dry-run mode
        cluster_manager: Optional ClusterManager for protecting running images

    Returns:
        CleanupResult
    """
    if not repo_config.enabled:
        logger.info(f"Skipping disabled repository: {repo_config.name}")
        return CleanupResult(repo=repo_config.name)

    strategy = get_strategy(client, repo_config, cluster_manager)
    return strategy.cleanup(dry_run=dry_run)


def print_summary(results: List[CleanupResult], dry_run: bool):
    """
    Print cleanup summary.

    Args:
        results: List of cleanup results
        dry_run: Whether this was a dry run
    """
    print("\n" + "="*80)
    print("CLEANUP SUMMARY")
    print("="*80)

    if dry_run:
        print("\n⚠️  DRY RUN MODE - No artifacts were actually deleted\n")

    total_deleted = 0
    total_size = 0
    total_errors = 0

    for result in results:
        print(f"\nRepository: {result.repo}")
        print(f"  Total artifacts checked: {result.total_artifacts}")
        print(f"  Artifacts to delete: {result.deleted_artifacts}")
        print(f"  Size to reclaim: {format_size(result.deleted_size)}")

        if result.errors:
            print(f"  Errors: {len(result.errors)}")
            for error in result.errors[:5]:  # Show first 5 errors
                print(f"    - {error}")
            if len(result.errors) > 5:
                print(f"    ... and {len(result.errors) - 5} more errors")

        total_deleted += result.deleted_artifacts
        total_size += result.deleted_size
        total_errors += len(result.errors)

    print("\n" + "-"*80)
    print(f"TOTAL:")
    print(f"  Artifacts: {total_deleted}")
    print(f"  Size: {format_size(total_size)}")
    print(f"  Errors: {total_errors}")
    print("="*80 + "\n")


def save_report(results: List[CleanupResult], report_file: str, dry_run: bool):
    """
    Save cleanup report to file.

    Args:
        results: List of cleanup results
        report_file: Path to report file
        dry_run: Whether this was a dry run
    """
    try:
        with open(report_file, 'w') as f:
            f.write("Artifactory Cleanup Report\n")
            f.write("="*80 + "\n\n")

            if dry_run:
                f.write("DRY RUN MODE - No artifacts were actually deleted\n\n")

            for result in results:
                f.write(f"\nRepository: {result.repo}\n")
                f.write(f"  Total artifacts: {result.total_artifacts}\n")
                f.write(f"  Deleted artifacts: {result.deleted_artifacts}\n")
                f.write(f"  Deleted size: {format_size(result.deleted_size)}\n")

                if result.errors:
                    f.write(f"  Errors:\n")
                    for error in result.errors:
                        f.write(f"    - {error}\n")

        logger.info(f"Report saved to: {report_file}")

    except Exception as e:
        logger.error(f"Error saving report: {e}")


def cmd_cleanup(args, config: CleanupConfig):
    """Handler for cleanup subcommand."""
    # Override config with command-line arguments
    if args.no_dry_run:
        config.dry_run = False

    if args.report:
        config.report_file = args.report

    # Override cluster protection setting if specified
    if args.skip_cluster_scan:
        config.protect_running_images = False
        logger.info("Cluster scanning disabled via command line")

    logger.info("Starting Artifactory cleanup")
    logger.info(f"Artifactory URL: {config.artifactory.url}")
    logger.info(f"Dry run mode: {config.dry_run}")
    logger.info(f"Repositories to process: {len(config.repositories)}")

    # Create Artifactory client
    client = ArtifactoryClient(config.artifactory)

    # Create cluster manager if clusters are configured and protection is enabled
    cluster_manager = None
    if config.clusters and config.protect_running_images:
        try:
            from cluster_integration import ClusterManager, KubernetesClusterClient, OpenShiftClusterClient

            cluster_manager = ClusterManager()

            for cluster_config in config.clusters:
                if not cluster_config.enabled:
                    continue

                try:
                    if cluster_config.type == ClusterType.KUBERNETES:
                        cluster = KubernetesClusterClient(
                            name=cluster_config.name,
                            kubeconfig_path=cluster_config.kubeconfig_path,
                            context=cluster_config.context
                        )
                    elif cluster_config.type == ClusterType.OPENSHIFT:
                        cluster = OpenShiftClusterClient(
                            name=cluster_config.name,
                            kubeconfig_path=cluster_config.kubeconfig_path,
                            context=cluster_config.context
                        )
                    else:
                        logger.warning(f"Unknown cluster type: {cluster_config.type}")
                        continue

                    cluster_manager.add_cluster(cluster)
                    logger.info(f"Added cluster: {cluster_config.name}")

                except Exception as e:
                    logger.error(f"Error connecting to cluster {cluster_config.name}: {e}")
                    logger.warning(f"Continuing without cluster {cluster_config.name}")

            if cluster_manager.clusters:
                logger.info(f"Cluster protection enabled for {len(cluster_manager.clusters)} cluster(s)")
            else:
                logger.warning("No clusters successfully connected - cluster protection disabled")
                cluster_manager = None

        except ImportError:
            logger.error("kubernetes package not installed - cluster protection disabled")
            logger.info("Install with: pip install kubernetes")
            cluster_manager = None
    elif config.clusters and not config.protect_running_images:
        logger.info("Cluster protection explicitly disabled")

    # Filter repositories if specific repo requested
    repositories = config.repositories
    if args.repo:
        repositories = [r for r in repositories if r.name == args.repo]
        if not repositories:
            logger.error(f"Repository '{args.repo}' not found in configuration")
            sys.exit(1)

    # Process repositories
    results = []

    if config.parallel_workers > 1:
        # Parallel processing
        with ThreadPoolExecutor(max_workers=config.parallel_workers) as executor:
            futures = {
                executor.submit(cleanup_repository, client, repo, config.dry_run, cluster_manager): repo
                for repo in repositories
            }

            for future in as_completed(futures):
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    repo = futures[future]
                    logger.error(f"Error processing repository {repo.name}: {e}")
                    results.append(CleanupResult(repo=repo.name, errors=[str(e)]))
    else:
        # Sequential processing
        for repo in repositories:
            try:
                result = cleanup_repository(client, repo, config.dry_run, cluster_manager)
                results.append(result)
            except Exception as e:
                logger.error(f"Error processing repository {repo.name}: {e}")
                results.append(CleanupResult(repo=repo.name, errors=[str(e)]))

    # Print summary
    print_summary(results, config.dry_run)

    # Save report if requested
    if config.report_file:
        save_report(results, config.report_file, config.dry_run)

    logger.info("Cleanup completed")


def cmd_empty_trash(args, config: CleanupConfig):
    """Handler for empty-trash subcommand."""
    client = ArtifactoryClient(config.artifactory)
    if client.empty_trash_can():
        logger.info("Trash empty operation completed successfully")
    else:
        logger.error("Trash empty operation failed")
        sys.exit(1)


def cmd_run_gc(args, config: CleanupConfig):
    """Handler for run-gc subcommand."""
    client = ArtifactoryClient(config.artifactory)

    # Standard GC runs once
    iterations = 1

    # Full GC requires triggering 20 times to skip the counter
    if args.full:
        logger.info("Full Garbage Collection requested. This requires triggering the GC 20 times.")
        iterations = 20

    import time

    success_count = 0
    for i in range(1, iterations + 1):
        if iterations > 1:
            logger.info(f"Triggering GC iteration {i}/{iterations}...")

        if client.run_garbage_collection():
            success_count += 1
            if iterations > 1 and i < iterations:
                time.sleep(1)  # Small delay between requests
        else:
            logger.error(f"GC trigger failed at iteration {i}")
            if iterations == 1:
                sys.exit(1)

    if iterations > 1:
        logger.info(f"Successfully triggered GC {success_count}/{iterations} times")
        logger.info("Full Garbage Collection should now be running in the background")
    else:
        logger.info("Garbage collection triggered successfully")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Artifactory Cleanup Tool',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        '-c', '--config',
        required=True,
        help='Path to configuration file (YAML)'
    )

    parser.add_argument(
        '--log-level',
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        help='Logging level (overrides config file)'
    )

    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    subparsers.required = True

    # Cleanup subcommand
    parser_cleanup = subparsers.add_parser('cleanup', help='Run artifact cleanup')
    parser_cleanup.add_argument(
        '--no-dry-run',
        action='store_true',
        help='Actually delete artifacts (default is dry-run mode)'
    )
    parser_cleanup.add_argument(
        '--report',
        help='Save cleanup report to file'
    )
    parser_cleanup.add_argument(
        '--repo',
        help='Only process specific repository (by name)'
    )
    parser_cleanup.add_argument(
        '--skip-cluster-scan',
        action='store_true',
        help='Skip cluster scan even if clusters are configured'
    )
    parser_cleanup.set_defaults(func=cmd_cleanup)

    # Empty trash subcommand
    parser_trash = subparsers.add_parser('empty-trash', help='Empty Artifactory trash can')
    parser_trash.set_defaults(func=cmd_empty_trash)

    # Run GC subcommand
    parser_gc = subparsers.add_parser('run-gc', help='Trigger Artifactory garbage collection')
    parser_gc.add_argument(
        '--full',
        action='store_true',
        help='Trigger Full Garbage Collection (runs 20 times to force full GC)'
    )
    parser_gc.set_defaults(func=cmd_run_gc)

    args = parser.parse_args()

    # Load configuration
    config = load_config(args.config)

    # Override log level if specified
    if args.log_level:
        config.log_level = args.log_level

    # Setup logging
    setup_logging(config.log_level)

    # Execute subcommand
    args.func(args, config)


if __name__ == '__main__':
    main()
