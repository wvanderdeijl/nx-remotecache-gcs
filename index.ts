import defaultTaskRunner from '@nx/workspace/tasks-runners/default';
import { Storage, File } from '@google-cloud/storage';
import { join } from 'path';
import { mkdirp } from 'mkdirp';
import tar from 'tar-fs';
import { pipeline } from 'stream/promises';

export default function runner(
    tasks: Parameters<typeof defaultTaskRunner>[0],
    options: Parameters<typeof defaultTaskRunner>[1] & { bucket?: string },
    context: Parameters<typeof defaultTaskRunner>[2],
) {
    if (!options.bucket) {
        throw new Error('missing bucket property in runner options. Please update nx.json');
    }
    const bucket = new Storage().bucket(options.bucket);
    return defaultTaskRunner(tasks, { ...options, remoteCache: { retrieve, store } }, context);

    async function retrieve(hash: string, cacheDirectory: string): Promise<boolean> {
        if (process.env.NX_SKIP_REMOTE_CACHE) return false;
        try {
            const commitFile = bucket.file(`${hash}.commit`);
            const tarFile = bucket.file(`${hash}.tar`);
            if ((await Promise.all([fileExists(commitFile), fileExists(tarFile)])).includes(false)) {
                return false;
            }
            // ensure target directory exists
            await mkdirp(cacheDirectory);

            // first try to download entire tar file
            const ignoreFile = join(cacheDirectory, hash, 'source');
            await pipeline(
                tarFile.createReadStream(),
                tar.extract(join(cacheDirectory, hash), {
                    // do not extract the `source` file that nx uses to detect that the cache originates from another machine
                    // see https://github.com/nrwl/nx/pull/18057
                    ignore: name => name === ignoreFile,
                }),
            );
            // commit file after we're sure all content is downloaded
            await commitFile.download({
                destination: join(cacheDirectory, `${hash}.commit`),
            });
            console.log(`retrieved cache from gs://${bucket.name}/${hash}.commit and gs://${bucket.name}/${hash}.tar`);
            return true;
        } catch (e) {
            console.log(e);
            console.log(`WARNING: failed to download cache from ${bucket.name}: ${getErrorMessage(e)}`);
            return false;
        }
    }

    async function store(hash: string, cacheDirectory: string): Promise<boolean> {
        if (process.env.NX_SKIP_REMOTE_CACHE) return false;
        try {
            await Promise.all([
                pipeline(tar.pack(join(cacheDirectory, hash)), bucket.file(`${hash}.tar`).createWriteStream()),
                bucket.upload(join(cacheDirectory, `${hash}.commit`)),
            ]);
            console.log(`stored cache at gs://${bucket.name}/${hash}.commit and gs://${bucket.name}/${hash}.tar`);
            return true;
        } catch (e) {
            console.log(`WARNING: failed to upload cache to ${bucket.name}: ${getErrorMessage(e)}`);
            return false;
        }
    }

    function getErrorMessage(e: unknown) {
        return typeof e === 'object' && !!e && 'message' in e && typeof e.message === 'string' ? e.message : '';
    }

    async function fileExists(f: File) {
        const [exists] = await f.exists();
        return exists;
    }
}
