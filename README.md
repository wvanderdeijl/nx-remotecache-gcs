# nx-remotecache-gcs

A task runner for [Nx](https://nx.dev/) that uses a Google Cloud Storage bucket as a remote cache, so all team members and CI servers can share a single cache. The concept and benefits of [computation caching](https://nx.dev/core-features/cache-task-results) are explained in the NX documentation.

## setup

```
npm install --save-dev nx-remotecache-gcs
```

create a Google Cloud Storage bucket. Since this is only a cache, there is no need for a dual- or multi-region bucket, so choose a single [location](https://cloud.google.com/storage/docs/locations) near you.

```
gsutil mb -p [PROJECT_ID] -l [BUCKET_LOCATION] -b on gs://[BUCKET_NAME]/
```

setup a [lifecycle rule](https://cloud.google.com/storage/docs/managing-lifecycles) for your storage bucket to automatically delete old files. If you want to use our suggested auto-delete-after-30-days rule, you can simply use the json that is included:

```
gsutil lifecycle set node_modules/nx-remotecache-gcs/lifecycle.json gs://[BUCKET_NAME]
```

by default all viewers, editors and owners of your Google Cloud project can read and/or write to the bucket. You could also [restrict who can read and write](https://cloud.google.com/storage/docs/access-control/using-iam-permissions) the bucket to only allow certain users or (build server) service accounts.

finally, add `tasksRunnerOptions` in your `nx.json` file

```json
{
    "projects": {
        ...
    },
    "tasksRunnerOptions": {
        "default": {
            "runner": "nx-remotecache-gcs",
            "options": {
                "bucket": "gs://NAME-OF-YOUR-STORAGE-BUCKET",
                "cacheableOperations": [
                    "build",
                    "test",
                    "lint",
                    "e2e"
                ]
            }
        }
    }
}

```

run a build and see if files end up in your cache storage bucket:

```
nx run-many --target=build --all
```

## Options
Using NX_SKIP_REMOTE_CACHE for temporary disabling remote cache. while keeping the local cache in tact
This can be benficial for some CI cases you want to run without using the remote cache.
```
export NX_SKIP_REMOTE_CACHE=true
```