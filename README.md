# Nx Remote Cache GCS

Modern, secure, and robust remote caching for Nx using Google Cloud Storage.

## Why this plugin?

Remote caching provides significant performance benefits for Nx workspaces by sharing build artifacts across environments. While a paid Nx Cloud subscription is the recommended solution, many organizations prefer to manage their own storage in Google Cloud Storage.

The official `@nx/gcs-cache` package is [deprecated and will stop working in Nx 23+](https://nx.dev/docs/reference/deprecated/self-hosted-cache-packages). This plugin provides a modern replacement that works with Nx 21, 23, and beyond, while maintaining support for legacy task runners (Nx 20 and older).

### Key Features:

- **Future-Proof**: A modern replacement for the deprecated `@nx/gcs-cache`, supporting Nx 16 through 23 and beyond.
- **Secure by Design**: Engineered with [CREEP mitigation](https://nx.dev/blog/creep-vulnerability-build-cache-security) at its core, allowing for strict branch-based security via GCS IAM.
- **Cloud-Native Auth**: Full support for Workload Identity Federation (WIF) and ADC. Leverages the official Google Cloud SDK to transparently handle token refreshing for long-running CI builds.
- **Flexible Integration**: Leverages [Nx's HTTP API-based caching](https://nx.dev/docs/guides/tasks--caching/self-hosted-caching) as a sidecar for Nx 20.8+ (including 23+), or runs as a legacy task runner for Nx 16 through 20.

---

## Modern Setup (Nx 20.8+)

Since Nx 21, the legacy task runners are deprecated. This plugin provides a standalone adapter that proxies Nx cache requests to GCS.

### 1. Installation

```bash
npm install --save-dev nx-remotecache-gcs
```

### 2. Start the Adapter

The adapter should run locally (or as a sidecar in CI). It uses **Application Default Credentials (ADC)** for authentication towards Google Cloud Storage.

```bash
npx nx-remotecache-gcs --bucket your-gcs-bucket-name
```

**Common Options:**

- `--bucket`: (Required) Your GCS bucket name.
- `--token`: (Optional) A secret token for the client (Nx) to talk to the adapter.
- `--read-only`: (Optional) Prevent any uploads to the bucket (and silently ignore attempts to write to the cache).
- `--prefix`: (Optional) Prefix for GCS objects (e.g., for branch isolation).

### 3. Configure Nx

Nx automatically talks to the adapter when these environment variables are set:

```bash
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:4043"
# Only if you used the --token flag:
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="your-secret-token"
```

---

## CI/CD Integration (GitHub Actions)

In CI, we recommend running the adapter as a **sidecar background process**.

### Seamless Authentication

This plugin leverages Google's **Application Default Credentials (ADC)** for both local development and CI environments. By using the official Google Cloud SDK, the adapter transparently handles token refreshing, ensuring long builds remain authenticated even when using GitHub's short-lived OIDC tokens.

### Basic Workflow Example

```yaml
jobs:
    build:
        runs-on: ubuntu-latest
        permissions:
            contents: 'read' # Required to checkout the code
            id-token: 'write' # Required for requesting the OIDC token for Google WIF
        steps:
            - uses: actions/checkout@v7

            # For advanced auth configuration, see:
            # https://github.com/google-github-actions/auth
            - id: 'auth'
              uses: 'google-github-actions/auth@v3'
              with:
                  workload_identity_provider: 'projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider'

            - name: Start GCS Adapter
              run: |
                  # Start the adapter in the background as a sidecar
                  npx nx-remotecache-gcs --bucket my-nx-cache &

                  # Wait until the adapter is ready before proceeding to Nx
                  while ! nc -z localhost 4043; do sleep 0.1; done

            - name: Run Nx
              run: npx nx build
              env:
                  # Point Nx to our local sidecar adapter
                  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'http://localhost:4043'
```

---

## Security & CREEP (CVE-2025-36852)

Remote caching introduces a security risk known as **Cache Poisoning** (specifically [CREEP](https://nx.dev/blog/creep-vulnerability-build-cache-security)). At its core, this involves a malicious contributor or malware uploading "poisoned" build artifacts to the shared cache. When a trusted build (like your production deployment) pulls these artifacts, it unknowingly executes or ships malicious code.

### Option 1: Acceptable Risk (Default)

In many internal or small-team scenarios, you may decide that the risk of a malicious contributor is low and acceptable. In this case, you can use the default setup where local developers and PR builds have write-access to the shared GCS bucket. This is the simplest setup and provides the highest caching efficiency.

### Option 2: Branch-based Mitigation (Recommended for Open Source/Large Teams)

To mitigate poisoning, you can restrict write access so that **only trusted environments** can update the shared cache. In this setup, untrusted PR builds and local developers are granted only `roles/storage.objectViewer` permissions.

1.  **IAM-Enforced Write Access**: Grant `roles/storage.objectCreator` permissions _only_ to your trusted primary branch CI runner (`main` or `master`). By using **Direct WIF and IAM Conditions**, you ensure that only the primary branch can ever be the "first writer" for a cache key. This is critical to prevent untrusted PRs or developers from performing **"cache squatting"** (uploading a poisoned artifact before the trusted build finishes).
2.  **Read-Only Mode**: Use the `--read-only` flag on untrusted PR runners and for local developers. This is a **UX safeguard** to proactively skip write attempts and avoid runtime errors in your logs. While a PR author could modify their workflow to remove this flag, the **IAM Policy** above remains the ultimate security boundary.
3.  **409 Conflict (The Safety Lock)**: As an extra layer of security ("better safe than sorry"), the adapter enforces a `409 Conflict` response if an artifact already exists. This ensures that even if an actor somehow bypasses other restrictions, they can never **overwrite** a trusted artifact that is already in the cache.

**The Trade-off**: While secure, this reduces efficiency. Local developers and PR builds will get cache hits _from_ the primary branch, but they won't share hits _with each other_ (since they can't write their own results to the shared cache).

### Future Development: Smart Gateway

The ideal solution (currently on our roadmap) is to run `nx-remotecache-gcs` on centralized infrastructure like **Google Cloud Run**.

In this design:

- **Identity-based Routing**: The gateway uses the developer's GCP credentials or GitHub's OIDC token to identify the caller.
- **Tiered Caching**:
    - **Primary Builds** (`main`/`master`) can Read and Write to the central cache.
    - **PRs/Developers** can Read from the central cache, but Write to a separate, isolated "branch-specific" or "user-specific" cache.
- **Benefits**: This prevents poisoning of the primary cache while still allowing developers to enjoy cache hits during repeated local builds or PR updates.

**Contributions for this "Smart Gateway" design are welcome!**

---

## GCS Bucket Configuration

### Best Practices

For optimal performance and cost, configure your bucket with these settings:

1. **Lifecycle Rules**: Automatically delete objects older than 30 days to manage costs. See the [lifecycle rule documentation](https://cloud.google.com/storage/docs/managing-lifecycles) for details.
2. **Location**: Choose a single [location](https://cloud.google.com/storage/docs/locations) near you for optimal performance and lower costs.
3. **Uniform Bucket-Level Access**: Use modern IAM-based permissions.
4. **Disable Soft-Delete**: Set retention to 0 days to save costs on ephemeral cache data.

**Quick Create Command:**

```bash
# 1. Create the bucket
gcloud storage buckets create gs://your-bucket \
  --uniform-bucket-level-access \
  --soft-delete-duration=0

# 2. Set lifecycle rule (automatically delete objects after 30 days)
# You can use the lifecycle.json included in this package
gcloud storage buckets update gs://your-bucket --lifecycle-file=node_modules/nx-remotecache-gcs/lifecycle.json
```

### Granting Permissions (Direct WIF)

To use Direct WIF (without a Service Account), follow the [official installation instructions](https://github.com/google-github-actions/auth#direct-wif) to set up your Workload Identity Pool and Provider. For more details on GCS access control, see the [official IAM permissions documentation](https://cloud.google.com/storage/docs/access-control/using-iam-permissions).

Once set up, grant your GitHub identity permissions on the GCS bucket:

```bash
# 1. Grant read-only access to all workflows in your repository
gcloud storage buckets add-iam-policy-binding gs://your-bucket \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository/YOUR_ORG/YOUR_REPO" \
  --role="roles/storage.objectViewer"

# 2. Grant write access to all workflows in your repository (Basic setup)
gcloud storage buckets add-iam-policy-binding gs://your-bucket \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository/YOUR_ORG/YOUR_REPO" \
  --role="roles/storage.objectCreator"

# 3. ALTERNATIVE: Grant write access ONLY to the primary branch (Recommended for CREEP mitigation)
# Use this instead of step 2 to prevent untrusted PRs from poisoning your cache.
gcloud storage buckets add-iam-policy-binding gs://your-bucket \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.ref/refs/heads/main" \
  --role="roles/storage.objectCreator"
```

---

## Legacy Setup (Nx 16 through 20)

For older versions, use the plugin as a custom task runner in `nx.json`:

```json
{
    "useLegacyCache": true,
    "tasksRunnerOptions": {
        "default": {
            "runner": "nx-remotecache-gcs",
            "options": {
                "bucket": "your-gcs-bucket-name",
                "readOnly": false,
                "cacheableOperations": ["build", "test", "lint", "e2e"]
            }
        }
    }
}
```

### Security & CREEP (Legacy)

The same CREEP risks apply to the legacy runner. You can either accept the risk (default) or follow the **Branch-based Mitigation** described above.

To enforce read-only mode in untrusted environments:

- **Option A**: Set `readOnly: true` in your `nx.json`.
- **Option B (Recommended)**: Set the environment variable `NX_READ_ONLY_REMOTE_CACHE=true`.

> [!IMPORTANT]
> **Read-only mode is a UX safeguard.** Its primary purpose is to prevent runtime errors and clean up build logs by skipping write attempts that would otherwise fail. The **ultimate security boundary is always your IAM Policy**; the flag is a convenience to proactively skip write attempts in environments where you know write-access is absent, avoiding unnecessary runtime errors in your logs.

---

## Development & Testing

If you are developing or contributing to this plugin, see the [Development Guide](./DEVELOPMENT.md) for instructions on how to test your changes with a real GCS bucket.

## License

MIT
