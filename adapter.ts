#!/usr/bin/env node

import express from 'express';
import { Storage } from '@google-cloud/storage';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { pipeline } from 'node:stream/promises';

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
const storage = new Storage();

// The Ultimate Chain: Initialize -> Middleware -> Routes -> Error Handler -> Listen
express()
    .use(authHandler)
    .get(CACHE_PATH, getOrHeadHandler)
    .head(CACHE_PATH, getOrHeadHandler)
    .put(CACHE_PATH, putHandler)
    .use(errorHandler)
    .listen(argv.port, argv.host, onListen);

function authHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (argv.token) {
        if (!req.headers.authorization) {
            console.warn(`[${new Date().toISOString()}] 401 Unauthorized - Missing token from ${req.ip}`);
            res.sendStatus(401);
            return;
        }
        if (req.headers.authorization !== `Bearer ${argv.token}`) {
            console.warn(`[${new Date().toISOString()}] 403 Forbidden - Invalid token from ${req.ip}`);
            res.sendStatus(403);
            return;
        }
    }
    next();
}

async function getOrHeadHandler(req: express.Request<{ hash: string }>, res: express.Response) {
    const { hash } = req.params;
    const file = storage.bucket(argv.bucket).file(argv.prefix ? `${argv.prefix}${hash}` : hash);

    const [exists] = await file.exists();
    if (!exists) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - 404 Not Found`);
        res.sendStatus(404);
        return;
    }

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - 200 OK`);

    if (req.method === 'HEAD') {
        res.sendStatus(200);
        return;
    }

    await pipeline(file.createReadStream(), res);
}

async function putHandler(req: express.Request<{ hash: string }>, res: express.Response) {
    const { hash } = req.params;
    const file = storage.bucket(argv.bucket).file(argv.prefix ? `${argv.prefix}${hash}` : hash);

    if (argv.readOnly) {
        console.log(`[${new Date().toISOString()}] PUT ${req.path} - 204 No Content (Read-Only Mode)`);
        res.sendStatus(204);
        return;
    }

    console.log(`[${new Date().toISOString()}] PUT ${req.path} - Uploading as application/gzip...`);

    try {
        await pipeline(
            req,
            file.createWriteStream({
                metadata: { contentType: 'application/gzip' },
                preconditionOpts: { ifGenerationMatch: 0 },
            }),
        );
        console.log(`[${new Date().toISOString()}] PUT ${req.path} - 204 No Content`);
        res.sendStatus(204);
    } catch (e) {
        if (hasNumericCode(e)) {
            /**
             * Handle 409 Conflict (File already exists in GCS).
             * GCS returns 412 (Precondition Failed) when ifGenerationMatch: 0 fails.
             * This must be mapped to 409 per the Nx Self-Hosted Caching OpenAPI spec.
             */
            if (e.code === 412) {
                console.log(`[${new Date().toISOString()}] PUT ${req.path} - 409 Conflict (Already exists)`);
                res.sendStatus(409);
                return;
            }
        }
        throw e;
    }
}

async function errorHandler(err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) {
    const message = isObject(err) && 'message' in err && typeof err.message === 'string' ? err.message : String(err);

    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} - Error (500): ${message}`);

    if (!res.headersSent) {
        res.sendStatus(500);
    }
}

function onListen() {
    console.log(`Nx GCS Adapter listening on http://${argv.host}:${argv.port}`);
    console.log(`Using bucket: ${argv.bucket}`);
    if (argv.prefix) console.log(`Using prefix: ${argv.prefix}`);
    if (argv.readOnly) console.log('Mode: READ-ONLY');
    console.log(`Authentication: ${argv.token ? 'Enabled' : 'Disabled (running on local interface recommended)'}`);
}

function hasNumericCode(e: unknown): e is { code: number } {
    return isObject(e) && 'code' in e && typeof e.code === 'number';
}

function isObject(e: unknown): e is object {
    return typeof e === 'object' && e !== null;
}
