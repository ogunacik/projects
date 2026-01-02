# Artifactory Cleanup Script

A flexible and maintainable Python script for cleaning up old artifacts from Artifactory repositories based on configurable retention policies.

## Features

- ✅ **Multi-Repository Support**: Maven, Docker, NPM, NuGet, and Generic repositories
- ✅ **Flexible Configuration**: YAML-based configuration with per-repository retention policies
- ✅ **Safe by Default**: Dry-run mode prevents accidental deletions
- ✅ **Repository-Specific Logic**: Intelligent cleanup strategies for each repository type
- ✅ **Pattern Matching**: Include/exclude patterns for fine-grained control
- ✅ **Version Retention**: Keep minimum number of versions per artifact
- ✅ **Parallel Processing**: Multi-threaded execution for faster cleanup
- ✅ **Comprehensive Logging**: Detailed logs and summary reports
- ✅ **Multiple Authentication**: Support for API keys and username/password

## Installation

1. **Clone or download this repository**

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Create your configuration file**:
   ```bash
   cp config.example.yaml config.yaml
   ```

4. **Edit `config.yaml`** with your Artifactory details and repository configurations

## Configuration

### Artifactory Connection

```yaml
artifactory:
  url: "https://your-artifactory.example.com"
  api_key: "YOUR_API_KEY_HERE"  # OR use username/password
  verify_ssl: true
  timeout: 30
```

### Repository Configuration

Each repository requires:

- `name`: Repository name in Artifactory
- `type`: Repository type (`maven`, `docker`, `npm`, `nuget`, `generic`)
- `retention_days`: Number of days to retain artifacts
- `enabled`: Whether to process this repository (default: `true`)

### Repository Types

#### Maven Repositories

```yaml
- name: "libs-release-local"
  type: "maven"
  retention_days: 180
  keep_minimum_versions: 3  # Keep at least 3 versions
  cleanup_snapshots_only: false  # Clean both releases and snapshots
  exclude_patterns:
    - "*/critical-lib/*"
```

**Maven-specific options**:
- `keep_minimum_versions`: Minimum versions to keep per artifact
- `cleanup_snapshots_only`: Only clean SNAPSHOT versions if `true`

#### Docker Repositories

```yaml
- name: "docker-local"
  type: "docker"
  retention_days: 90
  keep_latest_tags: 5  # Keep 5 latest tags per image
  exclude_patterns:
    - "production/*"
    - "*/latest"
```

**Docker-specific options**:
- `keep_latest_tags`: Number of latest tags to keep per image

#### NPM Repositories

```yaml
- name: "npm-local"
  type: "npm"
  retention_days: 120
  keep_minimum_versions: 5
  exclude_patterns:
    - "@company/core-*"
```

**NPM-specific options**:
- `keep_minimum_versions`: Minimum versions to keep per package

#### NuGet Repositories

```yaml
- name: "nuget-local"
  type: "nuget"
  retention_days: 150
  keep_minimum_versions: 4
  exclude_patterns:
    - "CompanyName.Core.*"
```

**NuGet-specific options**:
- `keep_minimum_versions`: Minimum versions to keep per package

#### Generic Repositories

```yaml
- name: "generic-local"
  type: "generic"
  retention_days: 60
  recursive: true
  exclude_patterns:
    - "*/backup/*"
  include_patterns:
    - "*.zip"
    - "*.tar.gz"
```

**Generic-specific options**:
- `recursive`: Recursively process subdirectories (default: `true`)

### Pattern Matching

Use glob patterns for include/exclude:

- `exclude_patterns`: Artifacts matching these patterns will NOT be deleted
- `include_patterns`: Only artifacts matching these patterns will be considered (if empty, all are included)

**Examples**:
- `"*/production/*"` - Match anything in a 'production' directory
- `"*.config"` - Match all .config files
- `"@company/*"` - Match all packages in @company scope (NPM)

### Property Filtering

You can include or exclude artifacts based on their properties:

- `exclude_properties`: Map of property key-values to EXCLUDE (keep). If an artifact has ANY of these properties, it will be protected.
- `include_properties`: Map of property key-values to INCLUDE (only clean these). If defined, an artifact must match ALL of these to be cleaned.

**Example**:
```yaml
exclude_properties:
  "release": "true"       # Don't clean release artifacts
  "do-not-delete": "yes"  # Dedicated protection flag

include_properties:
  "status": "deprecated"  # ONLY clean artifacts with this property
```

## Usage

### Cleanup Command

The main cleanup functionality is now a subcommand:

```bash
# Dry run
python cleaner.py -c config.yaml cleanup

# Actual cleanup
python cleaner.py -c config.yaml cleanup --no-dry-run

# Process specific repository
python cleaner.py -c config.yaml cleanup --repo libs-snapshot-local

# Skip cluster scanning (even if configured)
python cleaner.py -c config.yaml cleanup --skip-cluster-scan

# Save report
python cleaner.py -c config.yaml cleanup --report cleanup-report.txt
```

### Trash Management

Empty the Artifactory trash can:

```bash
python cleaner.py -c config.yaml empty-trash
```

### Garbage Collection

Trigger Artifactory storage garbage collection (requires admin permissions):

```bash
python cleaner.py -c config.yaml run-gc
```

For a **Full Garbage Collection** (which runs 20 times to force deep cleanup):

```bash
python cleaner.py -c config.yaml run-gc --full
```

*Note: Artifactory normally runs "Small GC" frequently and "Full GC" only every 20th cycle. The `--full` flag forces this by triggering 20 iterations.*

### Global Options

Options available for all commands:

- `-c CONFIG`, `--config CONFIG`: Path to configuration file
- `--log-level {DEBUG,INFO,WARNING,ERROR}`: Set logging level

### Command-Line Help

```
usage: cleaner.py [-h] -c CONFIG [--log-level {DEBUG,INFO,WARNING,ERROR}]
                  {cleanup,empty-trash,run-gc} ...
```

## How It Works

### Cleanup Strategies

Each repository type has a specialized cleanup strategy:

1. **Generic**: Deletes files older than retention period
2. **Maven**: Groups by GAV coordinates, respects version retention, handles snapshots separately
3. **Docker**: Groups by image name, keeps latest N tags per image
4. **NPM**: Groups by package name, keeps minimum versions
5. **NuGet**: Groups by package ID, keeps minimum versions

### Retention Logic

For each artifact, the script:

1. Checks if repository is enabled
2. Applies include/exclude patterns
3. Groups artifacts by type-specific logic (e.g., package name, image name)
4. Sorts by modification date (newest first)
5. Keeps minimum versions if configured
6. Deletes artifacts older than retention period

### Safety Features

- **Dry-run by default**: Must explicitly use `--no-dry-run` to delete
- **Pattern exclusions**: Protect critical artifacts
- **Version retention**: Never delete all versions
- **Comprehensive logging**: Track all operations
- **Error handling**: Continue processing even if individual deletions fail

## Examples

### Example 1: Clean Old Snapshots

```yaml
- name: "libs-snapshot-local"
  type: "maven"
  retention_days: 30
  keep_minimum_versions: 2
  cleanup_snapshots_only: true
```

This keeps snapshots for 30 days, always keeping at least 2 versions.

### Example 2: Clean Docker Images

```yaml
- name: "docker-local"
  type: "docker"
  retention_days: 90
  keep_latest_tags: 5
  exclude_patterns:
    - "*/latest"
    - "*/stable"
```

Keeps images for 90 days, always keeping 5 latest tags, never deleting 'latest' or 'stable' tags.

### Example 3: Clean Generic Files

```yaml
- name: "temp-files"
  type: "generic"
  retention_days: 7
  include_patterns:
    - "*.tmp"
    - "*.log"
```

Deletes only .tmp and .log files older than 7 days.

## Scheduling

### Linux/macOS (cron)

Add to crontab:

```bash
# Run every day at 2 AM
# Run every day at 2 AM
0 2 * * * cd /path/to/artifactory-cleanup && python cleaner.py -c config.yaml cleanup --no-dry-run >> cleanup.log 2>&1
# Empty trash every Sunday at 3 AM
0 3 * * 0 cd /path/to/artifactory-cleanup && python cleaner.py -c config.yaml empty-trash >> trash.log 2>&1
```

### Windows (Task Scheduler)

Create a scheduled task to run:

```batch
python C:\path\to\artifactory-cleanup\cleaner.py -c C:\path\to\config.yaml cleanup --no-dry-run
```

## Troubleshooting

### Authentication Errors

- Verify your API key or username/password
- Check that the user has delete permissions on repositories
- Ensure the Artifactory URL is correct

### SSL Certificate Errors

Set `verify_ssl: false` in config (not recommended for production):

```yaml
artifactory:
  verify_ssl: false
```

### Performance Issues

- Reduce `parallel_workers` if experiencing timeouts
- Increase `timeout` value for slow connections
- Process repositories individually with `--repo` flag

### No Artifacts Deleted

- Check that `dry_run: false` or use `--no-dry-run`
- Verify retention_days is appropriate
- Check include/exclude patterns aren't too restrictive
- Review logs with `--log-level DEBUG`

## Best Practices

1. **Start with dry-run**: Always test with dry-run mode first
2. **Test on non-critical repos**: Start with test repositories
3. **Use version retention**: Always set `keep_minimum_versions` to prevent deleting all versions
4. **Exclude critical artifacts**: Use `exclude_patterns` for important artifacts
5. **Monitor first runs**: Check logs and reports carefully
6. **Schedule during off-hours**: Run cleanup during low-usage periods
7. **Keep backups**: Ensure you have backups before running cleanup

## License

MIT License - feel free to use and modify as needed.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.
