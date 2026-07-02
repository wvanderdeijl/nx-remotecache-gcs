# Development Guide

This guide explains how to test your changes to `nx-remotecache-gcs` with a real Google Cloud Storage bucket during development.

## Prerequisites

- [Google Cloud SDK (gcloud)](https://cloud.google.com/sdk/docs/install) installed and authenticated.
- A Google Cloud Project.

## Steps

### 1. Create a Temporary GCS Bucket

Create a lifecycle policy file to automatically clean up old cache entries:

```bash
echo '{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": 7}
    }
  ]
}' > lifecycle.json
```

Now, run the following command to create a temporary bucket with the correct settings:

```bash
# Set your project ID
PROJECT_ID=$(gcloud config get-value project)
BUCKET_NAME="nx-test-cache-$(date +%s)"

gcloud storage buckets create gs://$BUCKET_NAME \
  --project=$PROJECT_ID \
  --location=europe-west4 \
  --uniform-bucket-level-access \
  --lifecycle-file=lifecycle.json \
  --soft-delete-duration=0
```

### 2. Prepare the Plugin

Build the plugin locally:

```bash
npm install
npm run prepare # This runs tsc
```

### 3. Start the Adapter

Start the adapter in one terminal:

```bash
node adapter.js --bucket $BUCKET_NAME --token my-secret-token
```

### 4. Test with a Real Nx Workspace

If you have an existing Nx workspace, you can test it by setting the environment variables:

```bash
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:4043"
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="my-secret-token"
```

Clear your local cache and run an operation:

```bash
nx reset
nx build your-app
```

Check the logs in the adapter terminal. You should see:

1. A **GET** request with `404 Not Found` (Cache Miss).
2. A **PUT** request to upload the artifact once the task finishes.

### 5. Verify Cache Hit

Clear your local cache again and run the same command:

```bash
nx reset
nx build your-app

# Check logs in the adapter terminal. You should see:
# 1. A GET request with 200 OK (Cache Hit)
# 2. No PUT request, as the artifact is already in GCS
```

### 6. Inspect GCS Bucket

You can verify that the objects are actually stored in your GCS bucket using the CLI:

```bash
# List all objects in the bucket
gcloud storage ls "gs://$BUCKET_NAME/**"

# If you used a prefix, you can filter by it
gcloud storage ls "gs://$BUCKET_NAME/your-prefix/**"
```

You should see files named after the task hashes (e.g., `gs://your-bucket/v1/cache/8d2b...`).

### 7. Cleanup

Delete the temporary bucket when you're done:

```bash
gcloud storage buckets delete gs://$BUCKET_NAME
```

**Tip:** If you want to repeat the tests with a clean cache without deleting the bucket, you can just clear its contents:

```bash
gcloud storage rm "gs://$BUCKET_NAME/**"
```
