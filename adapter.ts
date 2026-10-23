#!/usr/bin/env node

import express from 'express';
import { Storage } from '@google-cloud/storage';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { finished, pipeline } from 'node:stream/promises';

const argv = yargs(hideBin(process.argv))
    .options({
        'bucket': { type: 'string', demandOption: true, alias: 'b', describe: 'GCS bucket name' },
        'port': { type: 'number', default: 4043, alias: 'p', describe: 'Port to listen on' },
        'host': { type: 'string', default: '127.0.0.1', alias: 'h', describe: 'Host to listen on' },
        'token': {
            type: 'string',
            alias: 't',
            default: process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN,
            describe: 'Bearer token for authentication',
        },
        'prefix': { type: 'string', default: '', describe: 'GCS object prefix' },
        'read-only': {
            type: 'boolean',
            default: process.env.NX_READ_ONLY_REMOTE_CACHE === 'true',
            alias: 'r',
            describe: 'Run in read-only mode',
        },
    })
    .help()
    .parseSync();

// See official Nx Self-Hosted Caching Specification:
// https://nx.dev/docs/guides/tasks--caching/self-hosted-caching
const CACHE_PATH = '/v1/cache/:hash';
const getStorage = (() => {
    let storage = new Storage();
    return async () => {
        try {
            await storage.authClient.getAccessToken();
        } catch {
            // Re-initialize Storage in case Application Default Credentials on disk were refreshed
            // (e.g., after `gcloud auth application-default login` when a RAPT session expired).
            storage = new Storage();
        }
        return storage;
    };
})();

// The Ultimate Chain: Initialize -> Middleware -> Routes -> Error Handler -> Listen
express()
    .use(authHandler)
    .get(CACHE_PATH, getHandler)
    .head(CACHE_PATH, headHandler)
    .put(CACHE_PATH, putHandler)
    .use(errorHandler)
    .listen(argv.port, argv.host, onListen);

function authHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (argv.token) {
        if (!req.headers.authorization) {
            res.sendStatus(401);
            console.warn(`[${new Date().toISOString()}] 401 Unauthorized - Missing token from ${req.ip}`);
            return;
        }
        if (req.headers.authorization !== `Bearer ${argv.token}`) {
            res.sendStatus(403);
            console.warn(`[${new Date().toISOString()}] 403 Forbidden - Invalid token from ${req.ip}`);
            return;
        }
    }
    next();
}

async function getHandler(req: express.Request<{ hash: string }>, res: express.Response) {
    const file = await getFile(req.params.hash);

    // Use .pipe(res) + finished(stream) instead of pipeline(stream, res) because pipeline()
    // immediately calls res.destroy() when the source stream errors (such as a GCS 404),
    // closing the socket before we can send a 404 HTTP response.
    const stream = file.createReadStream();
    res.on('close', () => stream.destroy());
    stream.pipe(res);

    try {
        await finished(stream);
        console.log(`[${new Date().toISOString()}] GET ${req.path} - 200 OK`);
    } catch (e) {
        // Ensure the upstream GCS stream is cleaned up if an error occurs before the stream closed.
        stream.destroy();
        if (!res.headersSent && hasNumericCode(e) && e.code === 404) {
            res.sendStatus(404);
            console.log(`[${new Date().toISOString()}] GET ${req.path} - 404 Not Found`);
            return;
        }
        throw e;
    }
}

async function headHandler(req: express.Request<{ hash: string }>, res: express.Response) {
    const file = await getFile(req.params.hash);

    const [exists] = await file.exists();
    if (!exists) {
        res.sendStatus(404);
        console.log(`[${new Date().toISOString()}] HEAD ${req.path} - 404 Not Found`);
        return;
    }

    res.sendStatus(200);
    console.log(`[${new Date().toISOString()}] HEAD ${req.path} - 200 OK`);
}

async function putHandler(req: express.Request<{ hash: string }>, res: express.Response) {
    if (argv.readOnly) {
        res.sendStatus(200);
        console.log(`[${new Date().toISOString()}] PUT ${req.path} - 200 OK (Read-Only Mode)`);
        return;
    }

    const file = await getFile(req.params.hash);

    console.log(`[${new Date().toISOString()}] PUT ${req.path} - Uploading as application/gzip...`);

    try {
        await pipeline(
            req,
            file.createWriteStream({
                metadata: { contentType: 'application/gzip' },
                preconditionOpts: { ifGenerationMatch: 0 },
            }),
        );
        res.sendStatus(200);
        console.log(`[${new Date().toISOString()}] PUT ${req.path} - 200 OK`);
    } catch (e) {
        if (hasNumericCode(e)) {
            /**
             * Handle 409 Conflict (File already exists in GCS).
             * GCS returns 412 (Precondition Failed) when ifGenerationMatch: 0 fails.
             * This must be mapped to 409 per the Nx Self-Hosted Caching OpenAPI spec.
             */
            if (e.code === 412) {
                res.sendStatus(409);
                console.log(`[${new Date().toISOString()}] PUT ${req.path} - 409 Conflict (Already exists)`);
                return;
            }
        }
        throw e;
    }
}

async function errorHandler(err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) {
    const message = isObject(err) && 'message' in err && typeof err.message === 'string' ? err.message : String(err);

    if (!res.headersSent && !res.destroyed) {
        res.sendStatus(500);
        console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} - Error (500): ${message}`);
    } else {
        // Unlike pipeline(stream, res), stream.pipe(res) does not automatically destroy res when
        // the source stream errors after headers have already been sent. Explicitly destroy res
        // so the client does not hang waiting for the rest of an aborted response stream.
        res.destroy();
        console.warn(`[${new Date().toISOString()}] ${req.method} ${req.path} - Request aborted: ${message}`);
    }
}

function onListen(err?: Error) {
    if (err) {
        console.error(`[${new Date().toISOString()}] Failed to start server: ${err.message}`);
        process.exit(1);
    }

    console.log(`Nx GCS Adapter listening on http://${argv.host}:${argv.port}`);
    console.log(`Using bucket: ${argv.bucket}`);
    if (argv.prefix) console.log(`Using prefix: ${argv.prefix}`);
    if (argv.readOnly) console.log('Mode: READ-ONLY');
    console.log(`Authentication: ${argv.token ? 'Enabled' : 'Disabled (running on local interface recommended)'}`);
}

async function getFile(hash: string) {
    const storage = await getStorage();
    return storage.bucket(argv.bucket).file(argv.prefix ? `${argv.prefix}${hash}` : hash);
}

function hasNumericCode(e: unknown): e is { code: number } {
    return isObject(e) && 'code' in e && typeof e.code === 'number';
}

function isObject(e: unknown): e is object {
    return typeof e === 'object' && e !== null;
}
