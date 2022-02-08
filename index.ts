import defaultTaskRunner from '@nrwl/workspace/tasks-runners/default';
import { Storage } from '@google-cloud/storage';
import { join, dirname, relative } from 'path';
import { promises } from 'fs';
import mkdirp from 'mkdirp';

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
        try {
            const commitFile = bucket.file(`${hash}.commit`);
            if (!(await commitFile.exists())[0]) {
                return false;
            }
            const [files] = await bucket.getFiles({ prefix: `${hash}/` });
            await Promise.all(files.map(download));
            await download(commitFile); // commit file after we're sure all content is downloaded
            console.log(`retrieved ${files.length + 1} files from cache gs://${bucket.name}/${hash}`);
            return true;
        } catch (e) {
            console.log(e);
            console.log(`WARNING: failed to download cache from ${bucket.name}: ${e instanceof Error ? e.message : 'unknown error'}`);
            return false;
        }

        async function download(file: import('@google-cloud/storage').File) {
            const destination = join(cacheDirectory, file.name);
            await mkdirp(dirname(destination));
            await file.download({ destination });
        }
    }

    async function store(hash: string, cacheDirectory: string): Promise<boolean> {
        const tasks: Promise<any>[] = [];
        try {
            await uploadDirectory(join(cacheDirectory, hash));
            await Promise.all(tasks);
            await bucket.upload(join(cacheDirectory, `${hash}.commit`)); // commit file once we're sure all content is uploaded
            console.log(`stored ${tasks.length + 1} files in cache gs://${bucket.name}/${hash}`);
            return true;
        } catch (e) {
            console.log(`WARNING: failed to upload cache to ${bucket.name}: ${e instanceof Error ? e.message : 'unknown error'}`);
            return false;
        }

        async function uploadDirectory(dir: string) {
            for (const entry of await promises.readdir(dir)) {
                const full = join(dir, entry);
                const stats = await promises.stat(full);
                if (stats.isDirectory()) {
                    await uploadDirectory(full);
                } else if (stats.isFile()) {
                    const destination = relative(cacheDirectory, full);
                    tasks.push(bucket.upload(full, { destination }));
                }
            }
        }
    }
}
